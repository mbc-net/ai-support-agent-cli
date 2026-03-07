import { existsSync } from 'fs'
import * as os from 'os'

import { join, resolve } from 'path'

import { ApiClient } from './api-client'
import { AppSyncSubscriber, type AppSyncNotification } from './appsync-subscriber'
import { detectAvailableChatModes, resolveActiveChatMode } from './chat-mode-detector'
import { executeCommand } from './commands'
import { CONFIG_SYNC_DEBOUNCE_MS, INITIAL_CONFIG_SYNC_MAX_RETRIES, INITIAL_CONFIG_SYNC_RETRY_DELAY_MS, LOG_PAYLOAD_LIMIT, LOG_RESULT_LIMIT } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import { writeAwsConfig } from './aws-profile'
import { writeMcpConfig } from './mcp/config-writer'
import { syncProjectConfig } from './project-config-sync'
import { initProjectDir } from './project-dir'
import { syncRepositories } from './repo-sync'
import { getSystemInfo, getLocalIpAddress } from './system-info'
import { TerminalWebSocket } from './terminal'
import type { AgentChatMode, AgentServerConfig, ProjectConfigResponse, ProjectRegistration, RegisterResponse } from './types'
import { getErrorMessage } from './utils'

export interface ProjectAgentOptions {
  pollInterval: number
  heartbeatInterval: number
}

export class ProjectAgent {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private subscriber: AppSyncSubscriber | null = null
  private terminalWs: TerminalWebSocket | null = null
  private processing = false
  private readonly client: ApiClient
  private readonly prefix: string
  private readonly tenantCode: string
  private serverConfig: AgentServerConfig | null = null
  private availableChatModes: AgentChatMode[] = []
  private activeChatMode: AgentChatMode | undefined = undefined
  private readonly localAgentChatMode: AgentChatMode | undefined
  private readonly projectDir: string | undefined
  private currentConfigHash: string | undefined = undefined
  private configSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private projectConfig: ProjectConfigResponse | undefined = undefined
  private mcpConfigPath: string | undefined = undefined
  private readonly apiUrl: string
  private readonly token: string
  private readonly projectCode: string

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
    this.localAgentChatMode = localAgentChatMode
    this.apiUrl = project.apiUrl
    this.token = project.token
    this.projectCode = project.projectCode
    // Always resolve project directory (uses default template if neither is set)
    this.projectDir = initProjectDir(project, defaultProjectDir)
  }

  start(): void {
    this.registerAndStart().catch((error) => {
      logger.error(t('runner.unexpectedError', { message: getErrorMessage(error) }))
    })
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.configSyncDebounceTimer) clearTimeout(this.configSyncDebounceTimer)
    if (this.subscriber) this.subscriber.disconnect()
    if (this.terminalWs) this.terminalWs.disconnect()
  }

  getClient(): ApiClient {
    return this.client
  }

  private async registerAndStart(): Promise<void> {
    await this.refreshChatMode(true)

    let result: RegisterResponse
    try {
      result = await this.client.register({
        agentId: this.agentId,
        hostname: os.hostname(),
        os: os.platform(),
        arch: os.arch(),
        ipAddress: getLocalIpAddress(),
        capabilities: ['shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal'],
        availableChatModes: this.availableChatModes,
        activeChatMode: this.activeChatMode,
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
      if (this.currentConfigHash) break
      if (attempt < INITIAL_CONFIG_SYNC_MAX_RETRIES) {
        logger.warn(`${this.prefix} Initial config sync attempt ${attempt} failed, retrying...`)
        await new Promise(resolve => setTimeout(resolve, INITIAL_CONFIG_SYNC_RETRY_DELAY_MS * attempt))
      }
    }
    if (!this.currentConfigHash) {
      logger.warn(`${this.prefix} Initial config sync failed after all retries`)
    }

    if (result.transportMode === 'realtime' && result.appsyncUrl && result.appsyncApiKey) {
      logger.info(`${this.prefix} Starting subscription mode (realtime)`)
      await this.startSubscriptionMode(result)
    } else {
      logger.info(`${this.prefix} Starting polling mode (interval: ${this.options.pollInterval}ms)`)
      this.startPollingMode()
    }

    this.startHeartbeat()

    // Start terminal WebSocket connection (only if server has WS gateway enabled)
    if (result.wsEnabled) {
      this.startTerminalWebSocket()
    } else {
      logger.debug(`${this.prefix} Terminal WebSocket skipped (wsEnabled=false)`)
    }
  }

  private startTerminalWebSocket(): void {
    this.terminalWs = new TerminalWebSocket(
      this.apiUrl,
      this.token,
      this.agentId,
      this.projectDir,
    )

    this.terminalWs.connect().catch((error) => {
      logger.warn(`${this.prefix} Terminal WebSocket connection failed: ${getErrorMessage(error)}`)
    })
  }

  private async startSubscriptionMode(registerResult: RegisterResponse): Promise<void> {
    this.subscriber = new AppSyncSubscriber(registerResult.appsyncUrl, registerResult.appsyncApiKey)

    try {
      await this.subscriber.connect()
      logger.success(`${this.prefix} Connected via AppSync WebSocket`)
    } catch (error) {
      logger.warn(`${this.prefix} WebSocket connection failed, falling back to polling: ${getErrorMessage(error)}`)
      this.startPollingMode()
      return
    }

    this.subscriber.subscribe(
      this.tenantCode,
      (notification) => { void this.handleNotification(notification) },
    )

    this.subscriber.onReconnect(() => {
      logger.info(`${this.prefix} Reconnected, checking for pending commands...`)
      void this.checkPendingCommands()
    })
  }

  private startPollingMode(): void {
    const pollCommands = async (): Promise<void> => {
      if (this.processing) return
      this.processing = true

      try {
        const pending = await this.client.getPendingCommands(this.agentId)
        if (pending.length > 0) {
          logger.debug(`${this.prefix} Polling found ${pending.length} pending command(s)`)
        }

        for (const cmd of pending) {
          logger.info(t('runner.commandReceived', { prefix: this.prefix, type: cmd.type, commandId: cmd.commandId }))
          await this.processCommand(cmd.commandId)
        }
      } catch (error) {
        logger.debug(`${this.prefix} Polling error: ${getErrorMessage(error)}`)
      } finally {
        this.processing = false
      }
    }

    this.pollTimer = setInterval(() => {
      void pollCommands()
    }, this.options.pollInterval)
  }

  private startHeartbeat(): void {
    const sendHeartbeat = async (): Promise<void> => {
      try {
        await this.refreshChatMode(false)

        const response = await this.client.heartbeat(
          this.agentId,
          getSystemInfo(),
          undefined,
          this.availableChatModes,
          this.activeChatMode,
          getLocalIpAddress(),
        )

        // Check configHash from heartbeat response (polling fallback)
        if (response && typeof response === 'object' && 'configHash' in response) {
          const heartbeatResponse = response as { configHash?: string }
          if (heartbeatResponse.configHash && heartbeatResponse.configHash !== this.currentConfigHash) {
            logger.info(`${this.prefix} Config hash changed in heartbeat response, syncing...`)
            this.scheduleConfigSync()
          }
        }

        logger.debug(`${this.prefix} Heartbeat sent (activeChatMode=${this.activeChatMode ?? 'none'})`)
      } catch (error) {
        logger.warn(t('runner.heartbeatFailed', { prefix: this.prefix, message: getErrorMessage(error) }))
      }
    }

    this.heartbeatTimer = setInterval(() => {
      void sendHeartbeat()
    }, this.options.heartbeatInterval)

    void sendHeartbeat()
  }

  private async handleNotification(notification: AppSyncNotification): Promise<void> {
    logger.debug(`${this.prefix} Notification received: action=${notification.action}, content=${JSON.stringify(notification.content ?? {}).substring(0, LOG_RESULT_LIMIT)}`)

    switch (notification.action) {
      case 'agent-command': {
        const commandId = notification.content?.commandId as string
        if (!commandId) {
          logger.warn(`${this.prefix} Notification missing commandId: ${JSON.stringify(notification.content ?? {})}`)
          return
        }
        logger.info(t('runner.commandReceived', {
          prefix: this.prefix,
          type: (notification.content?.type as string) ?? 'unknown',
          commandId,
        }))
        await this.processCommand(commandId)
        break
      }
      case 'config-update': {
        await this.handleConfigUpdate(notification)
        break
      }
      default:
        logger.debug(`${this.prefix} Ignoring notification with action: ${notification.action}`)
    }
  }

  private async handleConfigUpdate(notification: AppSyncNotification): Promise<void> {
    const newHash = notification.content?.configHash as string
    if (newHash && newHash !== this.currentConfigHash) {
      logger.info(`${this.prefix} Config update detected (hash: ${newHash})`)
      this.scheduleConfigSync()
    }
  }

  private scheduleConfigSync(): void {
    if (this.configSyncDebounceTimer) {
      clearTimeout(this.configSyncDebounceTimer)
    }
    this.configSyncDebounceTimer = setTimeout(() => {
      void this.performConfigSync()
    }, CONFIG_SYNC_DEBOUNCE_MS)
  }

  async performConfigSync(): Promise<void> {
    const config = await syncProjectConfig(
      this.client,
      this.currentConfigHash,
      this.projectDir,
      this.prefix,
    )
    if (config) {
      this.applyProjectConfig(config)
    }
  }

  async performSetup(): Promise<void> {
    logger.info(`${this.prefix} Starting setup...`)

    // 1. Config sync
    await this.performConfigSync()

    // 2. Clone/update repositories
    if (this.projectDir && this.projectConfig?.repositories?.length) {
      try {
        const reposDir = join(this.projectDir, 'repos')
        const results = await syncRepositories(
          this.client,
          this.projectConfig.repositories,
          reposDir,
          this.prefix,
        )
        const cloned = results.filter(r => r.status === 'cloned').length
        const updated = results.filter(r => r.status === 'updated').length
        const skipped = results.filter(r => r.status === 'skipped').length
        logger.info(`${this.prefix} Repository sync: ${cloned} cloned, ${updated} updated, ${skipped} skipped`)
      } catch (error) {
        logger.warn(`${this.prefix} Repository sync failed: ${getErrorMessage(error)}`)
      }
    }

    // 3. Download documentation
    if (this.projectConfig?.documentation?.sources) {
      logger.info(`${this.prefix} Documentation sources found: ${this.projectConfig.documentation.sources.length}`)
      // Documentation download will be implemented in a future phase
    }

    logger.info(`${this.prefix} Setup completed`)
  }

  private applyProjectConfig(config: ProjectConfigResponse): void {
    this.currentConfigHash = config.configHash
    this.projectConfig = config

    // Update serverConfig from project config
    this.serverConfig = {
      agentEnabled: config.agent.agentEnabled,
      builtinAgentEnabled: config.agent.builtinAgentEnabled,
      builtinFallbackEnabled: config.agent.builtinFallbackEnabled,
      externalAgentEnabled: config.agent.externalAgentEnabled,
      chatMode: 'agent',
      claudeCodeConfig: {
        allowedTools: config.agent.allowedTools,
        addDirs: config.agent.claudeCodeConfig?.additionalDirs,
        systemPrompt: config.agent.claudeCodeConfig?.appendSystemPrompt,
      },
    }

    // Write AWS config file if project directory and AWS accounts are configured
    if (this.projectDir && config.aws?.accounts?.length) {
      try {
        writeAwsConfig(this.projectDir, config.project.projectCode, config.aws.accounts)
      } catch (error) {
        logger.warn(`${this.prefix} Failed to write AWS config: ${getErrorMessage(error)}`)
      }
    }

    // Log database configuration
    if (config.databases?.length) {
      logger.info(`${this.prefix} Databases configured: ${config.databases.map(db => `${db.name}(${db.engine})`).join(', ')}`)
    }

    // Log repository configuration
    if (config.repositories?.length) {
      logger.info(`${this.prefix} Repositories configured: ${config.repositories.map(r => `${r.repositoryName}(${r.provider})`).join(', ')}`)
    }

    // Write MCP config file if project directory is available
    // MCP tools include file_upload, project_info etc. that are useful regardless of database config
    if (this.projectDir) {
      try {
        const mcpServerPath = resolveMcpServerPath()
        const backlogConfigs = config.backlog?.items?.map((item) => ({
          domain: item.domain,
          apiKey: item.apiKey,
        }))
        this.mcpConfigPath = writeMcpConfig(
          this.projectDir,
          this.apiUrl,
          this.token,
          this.projectCode,
          mcpServerPath,
          backlogConfigs,
        )
        logger.info(`${this.prefix} MCP config written: ${this.mcpConfigPath}`)
      } catch (error) {
        logger.warn(`${this.prefix} Failed to write MCP config: ${getErrorMessage(error)}`)
      }
    }

    logger.info(`${this.prefix} Config applied (hash: ${config.configHash})`)
  }

  private async processCommand(commandId: string): Promise<void> {
    try {
      const detail = await this.client.getCommand(commandId, this.agentId)
      logger.debug(`${this.prefix} Command detail [${commandId}]: type=${detail.type}, payload=${JSON.stringify(detail.payload).substring(0, LOG_PAYLOAD_LIMIT)}`)
      const result = await executeCommand(detail.type, detail.payload, {
        commandId,
        client: this.client,
        serverConfig: this.serverConfig ?? undefined,
        activeChatMode: this.activeChatMode,
        agentId: this.agentId,
        projectDir: this.projectDir,
        projectConfig: this.projectConfig,
        mcpConfigPath: this.mcpConfigPath,
        onSetup: () => this.performSetup(),
        onConfigSync: () => this.performConfigSync(),
      })
      logger.debug(`${this.prefix} Command result [${commandId}]: success=${result.success}, data=${JSON.stringify(result.success ? result.data : result.error).substring(0, LOG_RESULT_LIMIT)}`)
      await this.client.submitResult(commandId, result, this.agentId)
      logger.info(t('runner.commandDone', {
        prefix: this.prefix,
        commandId,
        result: result.success ? 'success' : 'failed',
      }))
    } catch (error) {
      const message = getErrorMessage(error)
      logger.error(
        t('runner.commandError', { prefix: this.prefix, commandId, message }),
      )

      try {
        await this.client.submitResult(commandId, {
          success: false,
          error: message,
        }, this.agentId)
      } catch {
        logger.error(t('runner.resultSendFailed', { prefix: this.prefix }))
      }
    }
  }

  private async refreshChatMode(verbose: boolean): Promise<void> {
    this.availableChatModes = await detectAvailableChatModes()
    if (verbose) {
      logger.info(`${this.prefix} Available chat modes: ${JSON.stringify(this.availableChatModes)}`)
    }

    try {
      this.serverConfig = await this.client.getConfig()
      if (verbose) {
        logger.info(`${this.prefix} Server config loaded: chatMode=${this.serverConfig.chatMode}`)
        if (this.serverConfig.claudeCodeConfig) {
          logger.debug(`${this.prefix} claudeCodeConfig: allowedTools=[${this.serverConfig.claudeCodeConfig.allowedTools?.join(', ') ?? ''}], addDirs=[${this.serverConfig.claudeCodeConfig.addDirs?.join(', ') ?? ''}]`)
        }
      }
    } catch (error) {
      if (verbose) {
        logger.warn(`${this.prefix} Failed to load server config, using defaults: ${getErrorMessage(error)}`)
      }
    }

    this.activeChatMode = resolveActiveChatMode(
      this.availableChatModes,
      this.localAgentChatMode,
      this.serverConfig?.defaultAgentChatMode,
    )
    if (verbose) {
      logger.info(`${this.prefix} Active chat mode: ${this.activeChatMode ?? 'none'}`)
    }
  }

  private async checkPendingCommands(): Promise<void> {
    try {
      const pending = await this.client.getPendingCommands(this.agentId)
      for (const cmd of pending) {
        await this.handleNotification({
          id: cmd.commandId,
          table: '',
          pk: '',
          sk: '',
          tenantCode: '',
          action: 'agent-command',
          content: { commandId: cmd.commandId, type: cmd.type },
        })
      }
    } catch (error) {
      logger.warn(`${this.prefix} Failed to check pending commands: ${getErrorMessage(error)}`)
    }
  }
}

/**
 * MCP サーバースクリプトのパスを解決する
 *
 * ts-node/tsx で実行時は __dirname が src/ を指すため server.js が存在しない。
 * その場合は dist/mcp/server.js にフォールバックする。
 */
function resolveMcpServerPath(): string {
  const candidate = join(__dirname, 'mcp', 'server.js')
  if (existsSync(candidate)) return candidate

  // ts-node 実行時: src/ → dist/ に置換
  const distCandidate = resolve(__dirname, '..', 'dist', 'mcp', 'server.js')
  if (existsSync(distCandidate)) return distCandidate

  // どちらも見つからない場合は元のパスを返す（エラーは呼び出し元でハンドリング）
  logger.warn(`[mcp] MCP server script not found at ${candidate} or ${distCandidate}`)
  return candidate
}
