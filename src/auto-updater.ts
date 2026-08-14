import os from 'os'

import { ApiClient } from './api-client'
import { AGENT_VERSION, UPDATE_CHECK_INITIAL_DELAY, UPDATE_CHECK_INTERVAL, UPDATE_BUSY_WAIT_TIMEOUT_MS, UPDATE_BUSY_POLL_INTERVAL_MS, UPDATE_FORCED_BUSY_WAIT_TIMEOUT_MS, DOCKER_UPDATE_EXIT_CODE } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import type { AutoUpdateConfig } from './types'
import { getUpdateVersionFilePath } from './utils/path-utils'
import { atomicWriteFile, getErrorMessage, isInDocker, sleep } from './utils'
import { detectInstallMethod, isNewerVersion, isValidVersion, performUpdate, reExecProcess } from './update-checker'

export interface AutoUpdaterHandle {
  stop: () => void
}

/**
 * Start the auto-updater that periodically checks for new versions.
 *
 * @param clients - ApiClient instances (any one is used for version check)
 * @param config - Auto-update configuration
 * @param stopAllAgents - Function to gracefully stop all running agents
 * @param sendUpdateError - Function to report update errors via heartbeat
 * @param isAnyAgentBusy - Optional callback to check if any agent is processing a command
 * @param isUpdateAllowed - Optional gate evaluated on every check. Returning false skips the
 *   check entirely. Used to honour the server-side (admin UI) auto-update setting without
 *   requiring an agent restart. Omitted = always allowed (previous behaviour).
 *
 * NOTE: `config.enabled` is deliberately NOT consulted here. Whether an update may run is
 * decided per check by `isUpdateAllowed` (the server-side setting can flip between checks),
 * and `config.enabled` only records the startup baseline from CLI flags / local config.
 * Adding an early return on `!config.enabled` would pin the decision to startup and make the
 * admin UI toggle require an agent restart. Callers that must never update — a CLI
 * `--no-auto-update`, or a runtime where self-update cannot work — simply never call this.
 */
export function startAutoUpdater(
  clients: ApiClient[],
  config: AutoUpdateConfig,
  stopAllAgents: () => void | Promise<void>,
  sendUpdateError?: (error: string) => void,
  isAnyAgentBusy?: () => Promise<boolean>,
  isUpdateAllowed?: () => Promise<boolean>,
): AutoUpdaterHandle {
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let lastFailedVersion: string | null = null
  let checking = false

  const check = async (): Promise<void> => {
    if (checking) return
    checking = true

    try {
      // Inside a Docker container the image pins @ai-support-agent/cli, so
      // npm-installing a new version into the container is throw-away work
      // (it disappears on the next start) and races against the host-side
      // DockerSupervisor that owns the real upgrade flow. Only UI-initiated
      // `update` commands should run inside the container.
      if (isInDocker()) {
        logger.debug('Auto-update skipped (running inside Docker container)')
        return
      }

      // 実行可否は毎回評価する。管理画面で自動アップデートを切り替えたとき、
      // エージェントを再起動しなくても次のチェックから反映させるため。
      // 評価に失敗した場合は実行しない（fail-closed）。判断できないまま
      // プロセスを差し替える方が危険なので、素通りさせない。
      if (isUpdateAllowed) {
        let allowed = false
        try {
          allowed = await isUpdateAllowed()
        } catch (error) {
          logger.debug(`Auto-update skipped (gate evaluation failed): ${getErrorMessage(error)}`)
          return
        }
        if (!allowed) {
          logger.debug('Auto-update skipped (disabled by configuration)')
          return
        }
      }

      const installMethod = detectInstallMethod()
      if (installMethod === 'dev' || installMethod === 'local') {
        logger.debug(`Auto-update skipped (install method: ${installMethod})`)
        return
      }

      // Use the first available client
      const client = clients[0]
      if (!client) return

      const versionInfo = await client.getVersionInfo(config.channel)

      if (!isValidVersion(versionInfo.latestVersion)) {
        logger.debug(`Invalid version from server: ${versionInfo.latestVersion}`)
        return
      }

      // Check if forced update is needed (below minimumVersion)
      const forcedUpdate = isValidVersion(versionInfo.minimumVersion) &&
        isNewerVersion(AGENT_VERSION, versionInfo.minimumVersion)

      if (!isNewerVersion(AGENT_VERSION, versionInfo.latestVersion) && !forcedUpdate) {
        logger.debug(t('update.upToDate', { version: AGENT_VERSION }))
        return
      }

      const targetVersion = versionInfo.latestVersion

      // Skip if we already failed to update to this version
      if (lastFailedVersion === targetVersion && !forcedUpdate) {
        logger.debug(`Skipping update to ${targetVersion} (previously failed)`)
        return
      }

      if (forcedUpdate) {
        logger.warn(t('update.forced', { version: targetVersion, minimumVersion: versionInfo.minimumVersion }))
      } else {
        logger.info(t('update.available', { current: AGENT_VERSION, latest: targetVersion }))
      }

      // If autoRestart is disabled and it's not a forced update, just notify
      if (!config.autoRestart && !forcedUpdate) {
        logger.info(t('update.manualHint', { version: targetVersion }))
        return
      }

      // Perform the update
      logger.info(t('update.installing', { version: targetVersion }))
      // Scope the npm cache by host so sibling containers on the same host
      // don't trip cacache's exclusive lock when their auto-updaters fire
      // together. The agent-driven path uses tenant/project; here we don't
      // know either, so fall back to the hostname.
      const result = await performUpdate(targetVersion, installMethod, os.hostname())

      if (!result.success) {
        lastFailedVersion = targetVersion
        const errorMsg = result.error ?? 'Unknown error'
        logger.error(t('update.installFailed', { message: errorMsg }))

        if (errorMsg.includes('Permission denied')) {
          logger.info(t('update.permissionHint', { version: targetVersion }))
        }

        // Report error to server
        sendUpdateError?.(errorMsg)
        return
      }

      logger.success(t('update.installSuccess', { version: targetVersion }))

      // Wait for busy agents to finish before restarting
      if (isAnyAgentBusy) {
        const busyTimeout = forcedUpdate ? UPDATE_FORCED_BUSY_WAIT_TIMEOUT_MS : UPDATE_BUSY_WAIT_TIMEOUT_MS
        const deadline = Date.now() + busyTimeout
        while (Date.now() < deadline) {
          const busy = await isAnyAgentBusy()
          if (!busy) break
          logger.info(t('update.waitingForBusy'))
          await sleep(UPDATE_BUSY_POLL_INTERVAL_MS)
        }
      }

      // Graceful restart
      logger.info(t('update.stoppingAgents'))
      await stopAllAgents()
      stop()

      logger.info(t('update.restarting'))
      // Inside a Docker container, exit with a dedicated code so the host-side
      // runInDocker() can distinguish an update restart from a clean stop (SIGINT)
      // and calls reExecProcess() to rebuild the Docker image for the new version.
      if (isInDocker()) {
        // Write the new version to a file so the host-side installUpdateAndRestart()
        // can read it and run npm install before rebuilding the Docker image.
        // The config directory is volume-mounted and accessible from both sides.
        try {
          atomicWriteFile(getUpdateVersionFilePath(), JSON.stringify({ version: targetVersion }))
        } catch (err: unknown) {
          logger.warn(`[update] Failed to write update-version.json: ${getErrorMessage(err)}`)
        }
        process.exit(DOCKER_UPDATE_EXIT_CODE)
        return
      }
      reExecProcess(installMethod)
    } catch (error) {
      logger.debug(`Update check failed: ${getErrorMessage(error)}`)
    } finally {
      checking = false
    }
  }

  const stop = (): void => {
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (intervalTimer) {
      clearInterval(intervalTimer)
      intervalTimer = null
    }
  }

  // Schedule: initial delay, then periodic checks
  initialTimer = setTimeout(() => {
    initialTimer = null
    void check()
    intervalTimer = setInterval(() => {
      void check()
    }, UPDATE_CHECK_INTERVAL)
  }, UPDATE_CHECK_INITIAL_DELAY)

  logger.debug(`Auto-updater started (channel: ${config.channel}, interval: ${UPDATE_CHECK_INTERVAL / 1000}s)`)

  return { stop }
}
