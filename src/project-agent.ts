import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ApiClient } from './api-client'
import { AlertProcessor } from './alert-processor'
import { AppSyncSubscriber } from './appsync-subscriber'
import { type ConfigSyncDeps, type ConfigSyncState, performConfigSync, performSetup, performSyncRepository, refreshChatMode } from './agent-config-sync'
import type { RepoSyncResult } from './repo-sync'
import { type TransportDeps, type TransportState, startSubscriptionMode, startHeartbeat, startTerminalWebSocket, startVsCodeTunnel, stopTransport } from './agent-transport'
import {
  AGENT_VERSION,
  ALERT_STALE_PROCESSING_MINUTES,
  ALERT_STALE_RECOVERY_INTERVAL_MS,
  DELAYED_RESTART_MS,
  DOCKER_MARKER_BUILT_HASH,
  DOCKER_MARKER_CUSTOMIZATION_HASH,
  DOCKER_MARKER_REBUILD_NEEDED,
  DOCKER_MARKER_REGISTERED_AGENT_ID,
  DOCKER_RESTART_EXIT_CODE,
  DOCKER_UPDATE_EXIT_CODE,
  INITIAL_CONFIG_SYNC_MAX_RETRIES,
  INITIAL_CONFIG_SYNC_RETRY_DELAY_MS,
  REGISTER_AUTH_ERROR_DELAY_MS,
  REGISTER_RETRY_BASE_DELAY_MS,
  REGISTER_RETRY_MAX_DELAY_MS,
} from './constants'
import { calculateBackoff } from './retry-strategy'
import { getConfigDir } from './config-manager'
import { t } from './i18n'
import { logger } from './logger'
import { initProjectDir } from './project-dir'
import { getLocalIpAddress } from './system-info'
import { submitPendingResults } from './pending-result-store'
import type { AgentChatMode, ProjectRegistration, RegisterResponse } from './types'
import { generateProjectDockerfile } from './docker/docker-runner'
import { detectChannelFromVersion, detectInstallMethod, isNewerVersion, performUpdate, reExecProcess } from './update-checker'
import { atomicWriteFile, getErrorMessage, isAuthenticationError, resolveUrlForDocker } from './utils'

export interface ProjectAgentOptions {
  pollInterval: number
  heartbeatInterval: number
}

export class ProjectAgent {
  private readonly client: ApiClient
  private prefix: string
  private tenantCode: string
  private projectDir: string | undefined
  private readonly apiUrl: string
  private token: string
  private projectCode: string

  private readonly configSyncState: ConfigSyncState = {
    currentConfigHash: undefined,
    projectConfig: undefined,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    mcpConfigPath: undefined,
    dockerCustomizationHash: undefined, // will be initialized in constructor from docker-built-hash
  }

  private configSyncDeps: ConfigSyncDeps

  private readonly transportState: TransportState = {
    heartbeatTimer: null,
    subscriber: null,
    terminalWs: null,
    vsCodeWs: null,
    processing: false,
    configSyncDebounceTimer: null,
  }

  private transportDeps: TransportDeps

  // Persistent registration loop state. start() spawns a loop that retries
  // register() forever with exponential backoff so a transient network outage
  // does not leave the agent in a silent zombie state.
  private isRegistering = false
  private registerLoopCancelled = false
  private registerAttempt = 0
  private registerAbortController: AbortController | null = null
  // Edge-triggered logging: warn only when the failure mode changes or recovers,
  // and emit debug for the noisy intermediate retries. Patterned on Zabbix's
  // "started to fail" / "is working again" log pair.
  private lastRegisterError: { isAuth: boolean; message: string } | null = null
  private alertPollingTimer: ReturnType<typeof setInterval> | null = null
  private alertStaleRecoveryTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    project: ProjectRegistration,
    private readonly agentId: string,
    private readonly options: ProjectAgentOptions,
    localAgentChatMode?: AgentChatMode,
    defaultProjectDir?: string,
  ) {
    this.client = new ApiClient(project.apiUrl, project.token)
    this.prefix = `[${project.projectCode}]`
    this.tenantCode = ''
    this.apiUrl = project.apiUrl
    this.token = project.token
    this.projectCode = project.projectCode
    this.projectDir = initProjectDir(project, defaultProjectDir)

    this.configSyncDeps = {
      client: this.client,
      prefix: this.prefix,
      projectDir: this.projectDir,
      apiUrl: this.apiUrl,
      token: this.token,
      projectCode: this.projectCode,
      localAgentChatMode,
      onDockerRebuild: process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1'
        ? () => { void this.performDockerRebuild() }
        : undefined,
    }

    this.transportDeps = {
      client: this.client,
      agentId: this.agentId,
      prefix: this.prefix,
      apiUrl: this.apiUrl,
      token: this.token,
      projectDir: this.projectDir,
      tenantCode: this.tenantCode,
      projectCode: this.projectCode,
      pollInterval: this.options.pollInterval,
      heartbeatInterval: this.options.heartbeatInterval,
    }

    // When running inside Docker, initialize dockerCustomizationHash from the
    // docker-built-hash file so we don't trigger a rebuild for already-built customizations.
    // AI_SUPPORT_AGENT_CONFIG_DIR is mounted to the per-project config dir directly,
    // so docker-built-hash lives at the root of getConfigDir().
    if (process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1') {
      const builtHashPath = path.join(getConfigDir(), DOCKER_MARKER_BUILT_HASH)
      try {
        const builtHash = fs.readFileSync(builtHashPath, 'utf-8').trim()
        if (builtHash) {
          this.configSyncState.dockerCustomizationHash = builtHash
        }
      } catch {
        // File does not exist yet — first startup, leave dockerCustomizationHash as undefined
      }
    }
  }

  start(): void {
    if (this.isRegistering) {
      logger.debug(`${this.prefix} Register loop already running, skip start()`)
      return
    }
    this.isRegistering = true
    this.registerLoopCancelled = false
    this.registerAttempt = 0
    void this.runRegisterLoop().finally(() => {
      this.isRegistering = false
    })
  }

  stop(): void {
    this.registerLoopCancelled = true
    this.registerAbortController?.abort()
    if (this.alertPollingTimer) {
      clearInterval(this.alertPollingTimer)
      this.alertPollingTimer = null
    }
    if (this.alertStaleRecoveryTimer) {
      clearInterval(this.alertStaleRecoveryTimer)
      this.alertStaleRecoveryTimer = null
    }
    stopTransport(this.transportState)
  }

  isBusy(): boolean {
    return this.transportState.processing
  }

  getClient(): ApiClient {
    return this.client
  }

  updateToken(newToken: string): void {
    this.token = newToken
    this.client.updateToken(newToken)
    this.configSyncDeps = { ...this.configSyncDeps, token: newToken }
    this.transportDeps = { ...this.transportDeps, token: newToken }
    logger.info(t('runner.tokenUpdated', { prefix: this.prefix }))

    // Token change may alter tenantCode/projectCode (embedded in token format).
    // Re-register to ensure the agent record matches the new token's identity.
    logger.info(`${this.prefix} Re-registering after token update...`)
    this.stop()
    // Defer start() so the in-flight register loop unwinds (isRegistering -> false)
    // before the next start() flips it back on.
    setImmediate(() => this.start())
  }

  async performConfigSync(): Promise<void> {
    // ブラウザローカルポートを動的に更新（VSCode tunnel接続後に判明）
    this.configSyncDeps.browserLocalPort = this.transportState.vsCodeWs?.getBrowserLocalPort()
    // API通知の configHash はRDS同期前の古い値の可能性があるため、
    // config_update を受け取ったときは currentConfigHash をリセットして強制再同期する
    this.configSyncState.currentConfigHash = undefined
    await performConfigSync(this.configSyncDeps, this.configSyncState)
  }

  async performSetup(): Promise<void> {
    await performSetup(this.configSyncDeps, this.configSyncState)
  }

  async performSyncRepository(repositoryCode: string, branch?: string): Promise<RepoSyncResult> {
    return performSyncRepository(this.configSyncDeps, this.configSyncState, { repositoryCode, branch })
  }

  async performReboot(): Promise<void> {
    logger.info(`${this.prefix} Reboot requested, scheduling restart...`)
    this.stop()
    setTimeout(() => {
      // In Docker mode, exit with DOCKER_RESTART_EXIT_CODE so DockerSupervisor
      // restarts only this project's container.
      if (process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1') {
        process.exit(DOCKER_RESTART_EXIT_CODE)
      } else if (process.send) {
        // Running as a child process (forked by ChildProcessManager) — exit cleanly.
        // The parent runner will restart the process automatically.
        process.exit(0)
      } else {
        reExecProcess()
      }
    }, DELAYED_RESTART_MS)
  }

  async performDockerRebuild(): Promise<void> {
    logger.info(`${this.prefix} Docker rebuild requested, scheduling restart...`)
    this.stop()
    setTimeout(() => {
      // Inside Docker, AI_SUPPORT_AGENT_CONFIG_DIR is mounted to the per-project config dir directly.
      // All docker-related files live at the root of getConfigDir() (not in a projects sub-path).
      const configDir = getConfigDir()
      const markerPath = path.join(configDir, DOCKER_MARKER_REBUILD_NEEDED)
      try {
        fs.mkdirSync(configDir, { recursive: true })

        // Generate and write project-specific Dockerfile from dockerCustomization.
        // Place it at configDir/Dockerfile so DockerSupervisor can find it via getProjectDockerfilePath()
        // on the host (which maps to the same mounted directory).
        const dockerCustomization = this.configSyncState.projectConfig?.agent?.dockerCustomization
        const aptPackages = dockerCustomization?.aptPackages ?? []
        const npmPackages = dockerCustomization?.npmPackages ?? []
        const commands = dockerCustomization?.commands ?? []
        const timezone = dockerCustomization?.timezone
        const dockerfileContent = generateProjectDockerfile(AGENT_VERSION, aptPackages, npmPackages, commands, timezone)
        const dockerfilePath = path.join(configDir, 'Dockerfile')
        atomicWriteFile(dockerfilePath, dockerfileContent)
        logger.info(`${this.prefix} Project Dockerfile written: ${dockerfilePath}`)

        // Save the dockerCustomization hash so DockerSupervisor can copy it to docker-built-hash after build
        atomicWriteFile(
          path.join(configDir, DOCKER_MARKER_CUSTOMIZATION_HASH),
          this.configSyncState.dockerCustomizationHash ?? '',
        )

        atomicWriteFile(markerPath, '')
      } catch (err: unknown) {
        logger.warn(`${this.prefix} Failed to write ${DOCKER_MARKER_REBUILD_NEEDED} marker: ${getErrorMessage(err)}`)
      }
      process.exit(DOCKER_RESTART_EXIT_CODE)
    }, DELAYED_RESTART_MS)
  }

  async performUpdate(): Promise<void> {
    const channel = detectChannelFromVersion(AGENT_VERSION)
    logger.info(`${this.prefix} Update requested, checking for latest version (channel: ${channel})...`)
    const versionInfo = await this.client.getVersionInfo(channel)
    const targetVersion = versionInfo.latestVersion
    if (!isNewerVersion(AGENT_VERSION, targetVersion)) {
      logger.info(`${this.prefix} Already up to date (${AGENT_VERSION})`)
      return
    }
    logger.info(`${this.prefix} Updating to version ${targetVersion}...`)
    const installMethod = detectInstallMethod()
    const cacheScope = `${this.tenantCode}-${this.projectCode}`
    const result = await performUpdate(targetVersion, installMethod, cacheScope)
    if (!result.success) {
      throw new Error(`Update failed: ${result.error ?? 'Unknown error'}`)
    }
    logger.success(`${this.prefix} Update to ${targetVersion} successful, restarting...`)
    this.stop()
    setTimeout(() => {
      // Inside a Docker container (spawned via `docker run`), process.send is
      // not available. Exit with DOCKER_UPDATE_EXIT_CODE so the host-side
      // DockerSupervisor detects the update and calls installUpdateAndRestart().
      if (process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1') {
        try {
          const versionFile = path.join(getConfigDir(), 'update-version.json')
          atomicWriteFile(versionFile, JSON.stringify({ version: targetVersion }))
        } catch (err: unknown) {
          logger.warn(`[update] Failed to write update-version.json: ${getErrorMessage(err)}`)
        }
        process.exit(DOCKER_UPDATE_EXIT_CODE)
        return
      }
      // When running as a child process (forked by ChildProcessManager),
      // notify the parent runner and exit cleanly.
      if (process.send) {
        process.send({ type: 'update_complete', tenantCode: this.tenantCode, projectCode: this.projectCode })
        process.exit(0)
      } else {
        reExecProcess(installMethod)
      }
    }, DELAYED_RESTART_MS)
  }

  private async registerAndStart(): Promise<void> {
    await refreshChatMode(this.configSyncDeps, this.configSyncState, true)

    const result = await this.performRegistration()

    // Submit any pending results from previous sessions
    await submitPendingResults()

    // Perform initial config sync with retries
    for (let attempt = 1; attempt <= INITIAL_CONFIG_SYNC_MAX_RETRIES; attempt++) {
      await this.performConfigSync()
      if (this.configSyncState.currentConfigHash) break
      if (attempt < INITIAL_CONFIG_SYNC_MAX_RETRIES) {
        logger.warn(`${this.prefix} Initial config sync attempt ${attempt} failed, retrying...`)
        await new Promise(resolve => setTimeout(resolve, INITIAL_CONFIG_SYNC_RETRY_DELAY_MS * attempt))
      }
    }
    if (!this.configSyncState.currentConfigHash) {
      logger.warn(`${this.prefix} Initial config sync failed after all retries`)
    }

    await this.startServices(result)
  }

  /**
   * Calls the register API, updates local state from the response, and
   * performs any Docker-specific post-registration tasks (writing the
   * registered-agent-id marker and reporting a docker-build-error if present).
   *
   * Throws on failure so the caller's retry loop can apply exponential backoff.
   */
  private async performRegistration(): Promise<RegisterResponse> {
    const result = await this.client.register({
      agentId: this.agentId,
      hostname: os.hostname(),
      os: os.platform(),
      arch: os.arch(),
      ipAddress: getLocalIpAddress(),
      capabilities: ['shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal', 'vscode'],
      availableChatModes: this.configSyncState.availableChatModes,
      activeChatMode: this.configSyncState.activeChatMode,
    })

    this.tenantCode = result.tenantCode
    if (result.projectCode && result.projectCode !== this.projectCode) {
      logger.info(`${this.prefix} Server assigned projectCode: ${result.projectCode} (was: ${this.projectCode})`)
      this.projectCode = result.projectCode
      // Re-initialize projectDir with the server-assigned projectCode
      this.projectDir = initProjectDir({ tenantCode: this.tenantCode || 'unknown', projectCode: this.projectCode, token: this.token, apiUrl: this.apiUrl })
      this.configSyncDeps = { ...this.configSyncDeps, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
    }
    this.prefix = `[${this.tenantCode}#${this.projectCode}]`
    this.configSyncDeps = { ...this.configSyncDeps, prefix: this.prefix }
    this.client.setTenantCode(this.tenantCode)
    this.client.setProjectCode(this.projectCode)
    this.transportDeps = { ...this.transportDeps, agentId: result.agentId, tenantCode: this.tenantCode, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
    logger.success(t('runner.registered', { prefix: this.prefix, agentId: result.agentId }))
    logger.debug(`${this.prefix} Register response: transportMode=${result.transportMode ?? 'none'}, appsyncUrl=${result.appsyncUrl ? 'present' : 'absent'}, wsEnabled=${result.wsEnabled}`)
    logger.debug(`${this.prefix} Full register response keys: ${JSON.stringify(Object.keys(result))}`)

    // Report docker build error (if any) via heartbeat
    if (process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1') {
      // Write the server-assigned agentId so the host DockerSupervisor can use it for log storage
      try {
        atomicWriteFile(path.join(getConfigDir(), DOCKER_MARKER_REGISTERED_AGENT_ID), result.agentId)
      } catch (err: unknown) {
        logger.warn(`${this.prefix} Failed to write ${DOCKER_MARKER_REGISTERED_AGENT_ID}: ${getErrorMessage(err)}`)
      }

      const buildErrorPath = path.join(getConfigDir(), 'docker-build-error')
      let dockerBuildError: string | undefined
      try {
        dockerBuildError = fs.readFileSync(buildErrorPath, 'utf-8').trim() || undefined
      } catch {
        // File does not exist — no build error
      }
      if (dockerBuildError !== undefined) {
        try {
          await this.client.heartbeat(
            result.agentId,
            { platform: os.platform(), arch: os.arch(), cpuUsage: 0, memoryUsage: 0, uptime: os.uptime() },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            dockerBuildError,
          )
          // Delete the error file after successful report to avoid re-reporting on next startup
          try {
            fs.unlinkSync(buildErrorPath)
          } catch {
            // Ignore deletion failure — will be re-reported next time
          }
        } catch (err: unknown) {
          logger.warn(`${this.prefix} Failed to report docker build error: ${getErrorMessage(err)}`)
          // Keep the file so it can be reported on next startup
        }
      }
    }

    return result
  }

  /**
   * Starts all transport-layer services using the completed register response:
   * AppSync subscription, heartbeat, CloudWatch alert polling, and terminal/VS Code WebSocket.
   *
   * Throws if AppSync credentials are absent so the caller's retry loop retries the
   * whole registration flow (credentials may appear once a server-side rollout completes).
   */
  private async startServices(result: RegisterResponse): Promise<void> {
    const commandContext = {
      configSyncState: this.configSyncState,
      configSyncDeps: this.configSyncDeps,
      transportState: this.transportState,
      onSetup: () => this.performSetup(),
      onConfigSync: () => this.performConfigSync(),
      onReboot: () => this.performReboot(),
      onUpdate: () => this.performUpdate(),
      onSyncRepository: (repositoryCode: string, branch?: string) => this.performSyncRepository(repositoryCode, branch),
    }

    if (!result.appsyncUrl || !result.appsyncApiKey) {
      // Propagate to runRegisterLoop so we retry — credentials may appear once
      // a server-side rollout completes.
      throw new Error('AppSync credentials missing in register response')
    }
    logger.info(`${this.prefix} Starting subscription mode (realtime)`)
    // When running inside a Docker container, localhost refers to the container itself.
    // Convert localhost/127.0.0.1 to host.docker.internal so the container can reach the host.
    const resolvedAppsyncUrl = resolveUrlForDocker(result.appsyncUrl)
    await startSubscriptionMode(
      this.transportDeps,
      this.transportState,
      commandContext,
      AppSyncSubscriber,
      resolvedAppsyncUrl,
      result.appsyncApiKey,
    )

    startHeartbeat(this.transportDeps, this.transportState, this.configSyncState, this.configSyncDeps)

    // Start CloudWatch Alert polling if enabled in project config
    const projectConfig = this.configSyncState.projectConfig
    if (projectConfig?.cloudwatch?.enabled) {
      const alertProcessor = new AlertProcessor(
        this.client,
        this.transportDeps.tenantCode,
        this.transportDeps.projectCode,
      )
      // 起動時フォールバック: 蓄積された pending アラームを処理
      void alertProcessor.checkPendingAlerts()

      // 前のポーリングタイマーをクリア（再起動などで二重登録を防止）
      if (this.alertPollingTimer) {
        clearInterval(this.alertPollingTimer)
      }
      if (this.alertStaleRecoveryTimer) {
        clearInterval(this.alertStaleRecoveryTimer)
      }

      // 定期ポーリング（Web 画面で設定した間隔）pending のみ取得。
      // クラスフィールドで管理して stop() でクリア
      const pollingIntervalMs = projectConfig.cloudwatch.pollingIntervalMs
      this.alertPollingTimer = setInterval(
        () => void alertProcessor.checkPendingAlerts(),
        pollingIntervalMs,
      )
      logger.info(`${this.prefix} CloudWatch Alert polling started (interval: ${pollingIntervalMs}ms)`)

      // スタック救済タイマー（低頻度）。processing で止まったアラートを
      // 通常ポーリングとは分離して低頻度で救済する（無限ループ防止）。
      this.alertStaleRecoveryTimer = setInterval(
        () => void alertProcessor.recoverStaleProcessingAlerts(ALERT_STALE_PROCESSING_MINUTES),
        ALERT_STALE_RECOVERY_INTERVAL_MS,
      )
      logger.info(`${this.prefix} CloudWatch Alert stale-recovery started (interval: ${ALERT_STALE_RECOVERY_INTERVAL_MS}ms, threshold: ${ALERT_STALE_PROCESSING_MINUTES}min)`)
    }

    // Start terminal WebSocket connection (only if server has WS gateway enabled)
    if (result.wsEnabled) {
      const resolvedWsUrl = result.wsUrl ? resolveUrlForDocker(result.wsUrl) : result.wsUrl
      startTerminalWebSocket(this.transportDeps, this.transportState, resolvedWsUrl, this.configSyncState)
      startVsCodeTunnel(this.transportDeps, this.transportState, resolvedWsUrl, this.configSyncState)
    } else {
      logger.debug(`${this.prefix} Terminal/VS Code WebSocket skipped (wsEnabled=false)`)
    }
  }

  private async runRegisterLoop(): Promise<void> {
    while (!this.registerLoopCancelled) {
      try {
        await this.registerAndStart()
        // Edge-triggered recovery log: only emit when we were previously failing.
        if (this.lastRegisterError !== null) {
          logger.info(
            t('runner.registerWorkingAgain', {
              prefix: this.prefix,
              attempts: this.registerAttempt,
            }),
          )
          this.lastRegisterError = null
        }
        this.registerAttempt = 0
        return
      } catch (error) {
        if (this.registerLoopCancelled) return

        const isAuth = isAuthenticationError(error)
        const message = getErrorMessage(error)
        const baseDelayMs = isAuth ? REGISTER_AUTH_ERROR_DELAY_MS : REGISTER_RETRY_BASE_DELAY_MS
        let delay = calculateBackoff({ baseDelayMs, attempt: this.registerAttempt, jitter: true })
        delay = Math.min(delay, REGISTER_RETRY_MAX_DELAY_MS)
        if (isAuth) {
          // Floor at REGISTER_AUTH_ERROR_DELAY_MS so we never hammer the auth path.
          delay = Math.max(delay, REGISTER_AUTH_ERROR_DELAY_MS)
        }
        this.registerAttempt++

        // Edge-triggered failure log: only warn on a new failure or a change in
        // error mode (network -> auth, different error message). Subsequent
        // identical failures stay at debug level to avoid log flooding during
        // long outages.
        const isFirstFailure = this.lastRegisterError === null
        const isModeChange =
          this.lastRegisterError !== null &&
          (this.lastRegisterError.isAuth !== isAuth ||
            this.lastRegisterError.message !== message)
        const shouldWarn = isFirstFailure || isModeChange

        if (shouldWarn) {
          if (isAuth) {
            logger.warn(
              t('runner.authErrorStartedFailing', {
                prefix: this.prefix,
                delayMs: delay,
                detail: message,
              }),
            )
          } else {
            logger.warn(
              t('runner.registerStartedFailing', {
                prefix: this.prefix,
                delayMs: delay,
                message,
              }),
            )
          }
        } else {
          logger.debug(
            `${this.prefix} Registration still failing (attempt ${this.registerAttempt}, next retry in ${delay}ms): ${message}`,
          )
        }

        this.lastRegisterError = { isAuth, message }
        await this.cancellableSleep(delay)
      }
    }
  }

  private cancellableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const controller = new AbortController()
      this.registerAbortController = controller
      const timer = setTimeout(() => {
        this.registerAbortController = null
        resolve()
      }, ms)
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        this.registerAbortController = null
        resolve()
      })
    })
  }
}
