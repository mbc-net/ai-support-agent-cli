import { ApiClient } from './api-client'
import { AGENT_VERSION, UPDATE_CHECK_INITIAL_DELAY, UPDATE_CHECK_INTERVAL } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import type { AutoUpdateConfig } from './types'
import { getErrorMessage } from './utils'
import { isNewerVersion, isValidVersion, performUpdate, reExecProcess } from './update-checker'

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
 */
export function startAutoUpdater(
  clients: ApiClient[],
  config: AutoUpdateConfig,
  stopAllAgents: () => void,
  sendUpdateError?: (error: string) => void,
): AutoUpdaterHandle {
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let lastFailedVersion: string | null = null
  let checking = false

  const check = async (): Promise<void> => {
    if (checking) return
    checking = true

    try {
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
      const result = await performUpdate(targetVersion)

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

      // Graceful restart
      logger.info(t('update.stoppingAgents'))
      stopAllAgents()
      stop()

      logger.info(t('update.restarting'))
      reExecProcess()
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
