import * as os from 'os'

import { ApiClient } from './api-client'
import { AppSyncSubscriber } from './appsync-subscriber'
import { type ConfigSyncDeps, type ConfigSyncState, performConfigSync, performSetup, refreshChatMode } from './agent-config-sync'
import { type TransportDeps, type TransportState, startPollingMode, startSubscriptionMode, startHeartbeat, startTerminalWebSocket, stopTransport } from './agent-transport'
import { INITIAL_CONFIG_SYNC_MAX_RETRIES, INITIAL_CONFIG_SYNC_RETRY_DELAY_MS } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import { initProjectDir } from './project-dir'
import { getLocalIpAddress } from './system-info'
import type { AgentChatMode, ProjectRegistration, RegisterResponse } from './types'
import { getErrorMessage } from './utils'

export interface ProjectAgentOptions {
  pollInterval: number
  heartbeatInterval: number
}

export class ProjectAgent {
  private readonly client: ApiClient
  private readonly prefix: string
  private readonly tenantCode: string
  private readonly projectDir: string | undefined
  private readonly apiUrl: string
  private readonly token: string
  private readonly projectCode: string

  private readonly configSyncState: ConfigSyncState = {
    currentConfigHash: undefined,
    projectConfig: undefined,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    mcpConfigPath: undefined,
  }

  private readonly configSyncDeps: ConfigSyncDeps

  private readonly transportState: TransportState = {
    heartbeatTimer: null,
    pollTimer: null,
    subscriber: null,
    terminalWs: null,
    processing: false,
    configSyncDebounceTimer: null,
  }

  private readonly transportDeps: TransportDeps

  constructor(
    project: ProjectRegistration,
    private readonly agentId: string,
    private readonly options: ProjectAgentOptions,
    tenantCode?: string,
    localAgentChatMode?: AgentChatMode,
    defaultProjectDir?: string,
  ) {
    this.client = new ApiClient(project.apiUrl, project.token)
    this.prefix = `[${project.projectCode}]`
    this.tenantCode = tenantCode ?? project.projectCode
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

  getClient(): ApiClient {
    return this.client
  }

  async performConfigSync(): Promise<void> {
    await performConfigSync(this.configSyncDeps, this.configSyncState)
  }

  async performSetup(): Promise<void> {
    await performSetup(this.configSyncDeps, this.configSyncState)
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
        capabilities: ['shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal'],
        availableChatModes: this.configSyncState.availableChatModes,
        activeChatMode: this.configSyncState.activeChatMode,
      })
      logger.success(t('runner.registered', { prefix: this.prefix, agentId: result.agentId }))
      logger.debug(`${this.prefix} Register response: transportMode=${result.transportMode ?? 'none'}, appsyncUrl=${result.appsyncUrl ? 'present' : 'absent'}`)
    } catch (error) {
      logger.error(t('runner.registerFailed', { prefix: this.prefix, message: getErrorMessage(error) }))
      return
    }

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
    }

    if (result.transportMode === 'realtime' && result.appsyncUrl && result.appsyncApiKey) {
      logger.info(`${this.prefix} Starting subscription mode (realtime)`)
      await startSubscriptionMode(
        this.transportDeps,
        this.transportState,
        commandContext,
        AppSyncSubscriber,
        result.appsyncUrl,
        result.appsyncApiKey,
      )
    } else {
      logger.info(`${this.prefix} Starting polling mode (interval: ${this.options.pollInterval}ms)`)
      startPollingMode(this.transportDeps, this.transportState, commandContext)
    }

    startHeartbeat(this.transportDeps, this.transportState, this.configSyncState, this.configSyncDeps)

    // Start terminal WebSocket connection (only if server has WS gateway enabled)
    if (result.wsEnabled) {
      startTerminalWebSocket(this.transportDeps, this.transportState)
    } else {
      logger.debug(`${this.prefix} Terminal WebSocket skipped (wsEnabled=false)`)
    }
  }
}
