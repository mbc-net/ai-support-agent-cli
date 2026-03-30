import * as os from 'os'

import { ApiClient } from './api-client'
import { AppSyncSubscriber } from './appsync-subscriber'
import { type ConfigSyncDeps, type ConfigSyncState, performConfigSync, performSetup, refreshChatMode } from './agent-config-sync'
import { type TransportDeps, type TransportState, startSubscriptionMode, startHeartbeat, startTerminalWebSocket, startVsCodeTunnel, stopTransport } from './agent-transport'
import { AGENT_VERSION, INITIAL_CONFIG_SYNC_MAX_RETRIES, INITIAL_CONFIG_SYNC_RETRY_DELAY_MS } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import { initProjectDir } from './project-dir'
import { getLocalIpAddress } from './system-info'
import { submitPendingResults } from './pending-result-store'
import type { AgentChatMode, ProjectRegistration, RegisterResponse } from './types'
import { detectChannelFromVersion, detectInstallMethod, performUpdate, reExecProcess } from './update-checker'
import { getErrorMessage, isAuthenticationError } from './utils'

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
  }

  start(): void {
    this.registerAndStart().catch((error) => {
      logger.error(t('runner.unexpectedError', { message: getErrorMessage(error) }))
    })
  }

  stop(): void {
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
    stopTransport(this.transportState)
    this.start()
  }

  async performConfigSync(): Promise<void> {
    // ブラウザローカルポートを動的に更新（VSCode tunnel接続後に判明）
    this.configSyncDeps.browserLocalPort = this.transportState.vsCodeWs?.getBrowserLocalPort()
    await performConfigSync(this.configSyncDeps, this.configSyncState)
  }

  async performSetup(): Promise<void> {
    await performSetup(this.configSyncDeps, this.configSyncState)
  }

  async performReboot(): Promise<void> {
    logger.info(`${this.prefix} Reboot requested, scheduling restart...`)
    this.stop()
    setTimeout(() => {
      reExecProcess()
    }, 1000)
  }

  async performUpdate(): Promise<void> {
    const channel = detectChannelFromVersion(AGENT_VERSION)
    logger.info(`${this.prefix} Update requested, checking for latest version (channel: ${channel})...`)
    const versionInfo = await this.client.getVersionInfo(channel)
    const targetVersion = versionInfo.latestVersion
    logger.info(`${this.prefix} Updating to version ${targetVersion}...`)
    const installMethod = detectInstallMethod()
    const result = await performUpdate(targetVersion, installMethod)
    if (!result.success) {
      throw new Error(`Update failed: ${result.error ?? 'Unknown error'}`)
    }
    logger.success(`${this.prefix} Update to ${targetVersion} successful, restarting...`)
    this.stop()
    setTimeout(() => {
      // When running as a child process (forked by ChildProcessManager),
      // notify the parent runner and exit cleanly.
      // In Docker mode the runner exits with DOCKER_UPDATE_EXIT_CODE so the
      // host-side runInDocker() rebuilds the image for the new version.
      // reExecProcess() from a worker would spawn a new runner process
      // in addition to the existing parent, causing duplicate auto-update.
      if (process.send) {
        process.send({ type: 'update_complete', projectCode: this.projectCode })
        process.exit(0)
      } else {
        reExecProcess(installMethod)
      }
    }, 1000)
  }

  private async registerAndStart(): Promise<void> {
    await refreshChatMode(this.configSyncDeps, this.configSyncState, true)

    let result: RegisterResponse
    try {
      result = await this.client.register({
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
        this.projectDir = initProjectDir({ projectCode: this.projectCode, token: this.token, apiUrl: this.apiUrl })
        this.configSyncDeps = { ...this.configSyncDeps, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
      }
      this.prefix = `[${this.tenantCode}#${this.projectCode}]`
      this.configSyncDeps = { ...this.configSyncDeps, prefix: this.prefix }
      this.client.setTenantCode(this.tenantCode)
      this.client.setProjectCode(this.projectCode)
      this.transportDeps = { ...this.transportDeps, tenantCode: this.tenantCode, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
      logger.success(t('runner.registered', { prefix: this.prefix, agentId: result.agentId }))
      logger.debug(`${this.prefix} Register response: transportMode=${result.transportMode ?? 'none'}, appsyncUrl=${result.appsyncUrl ? 'present' : 'absent'}, wsEnabled=${result.wsEnabled}`)
      logger.debug(`${this.prefix} Full register response keys: ${JSON.stringify(Object.keys(result))}`)
    } catch (error) {
      if (isAuthenticationError(error)) {
        logger.error(t('runner.authError', { prefix: this.prefix, detail: getErrorMessage(error) }))
      } else {
        logger.error(t('runner.registerFailed', { prefix: this.prefix, message: getErrorMessage(error) }))
      }
      return
    }

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

    const commandContext = {
      configSyncState: this.configSyncState,
      configSyncDeps: this.configSyncDeps,
      transportState: this.transportState,
      onSetup: () => this.performSetup(),
      onConfigSync: () => this.performConfigSync(),
      onReboot: () => this.performReboot(),
      onUpdate: () => this.performUpdate(),
    }

    if (!result.appsyncUrl || !result.appsyncApiKey) {
      logger.error(`${this.prefix} AppSync credentials missing. Cannot start agent.`)
      return
    }
    logger.info(`${this.prefix} Starting subscription mode (realtime)`)
    await startSubscriptionMode(
      this.transportDeps,
      this.transportState,
      commandContext,
      AppSyncSubscriber,
      result.appsyncUrl,
      result.appsyncApiKey,
    )

    startHeartbeat(this.transportDeps, this.transportState, this.configSyncState, this.configSyncDeps)

    // Start terminal WebSocket connection (only if server has WS gateway enabled)
    if (result.wsEnabled) {
      startTerminalWebSocket(this.transportDeps, this.transportState, result.wsUrl)
      startVsCodeTunnel(this.transportDeps, this.transportState, result.wsUrl)
    } else {
      logger.debug(`${this.prefix} Terminal/VS Code WebSocket skipped (wsEnabled=false)`)
    }
  }
}
