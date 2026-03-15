import type { ApiClient } from './api-client'
import { type AppSyncSubscriber, type AppSyncNotification } from './appsync-subscriber'
import { LOG_PAYLOAD_LIMIT, LOG_RESULT_LIMIT } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import { getWorkspaceDir, getReposDir } from './project-dir'
import { getSystemInfo, getLocalIpAddress } from './system-info'
import { TerminalWebSocket, isNodePtyAvailable } from './terminal'
import { getErrorMessage, isAuthenticationError } from './utils'
import { VsCodeTunnelWebSocket } from './vscode'
import { executeCommand } from './commands'
import type { ConfigSyncState, ConfigSyncDeps } from './agent-config-sync'
import { refreshChatMode, scheduleConfigSync } from './agent-config-sync'

export interface TransportState {
  heartbeatTimer: ReturnType<typeof setInterval> | null
  subscriber: AppSyncSubscriber | null
  terminalWs: TerminalWebSocket | null
  vsCodeWs: VsCodeTunnelWebSocket | null
  processing: boolean
  configSyncDebounceTimer: ReturnType<typeof setTimeout> | null
}

export interface TransportDeps {
  client: ApiClient
  agentId: string
  prefix: string
  apiUrl: string
  token: string
  projectDir: string | undefined
  tenantCode: string
  /** @deprecated pollInterval is no longer used. Kept for backward compatibility with CLI options. */
  pollInterval: number
  heartbeatInterval: number
}

export interface CommandContext {
  configSyncState: ConfigSyncState
  configSyncDeps: ConfigSyncDeps
  transportState: TransportState
  onSetup: () => Promise<void>
  onConfigSync: () => Promise<void>
}

/**
 * Start subscription mode via AppSync WebSocket.
 */
export async function startSubscriptionMode(
  deps: TransportDeps,
  state: TransportState,
  ctx: CommandContext,
  AppSyncSubscriberClass: new (url: string, apiKey: string) => AppSyncSubscriber,
  appsyncUrl: string,
  appsyncApiKey: string,
): Promise<void> {
  state.subscriber = new AppSyncSubscriberClass(appsyncUrl, appsyncApiKey)

  try {
    await state.subscriber.connect()
    logger.success(`${deps.prefix} Connected via AppSync WebSocket`)
  } catch (error) {
    logger.error(`${deps.prefix} WebSocket connection failed: ${getErrorMessage(error)}`)
    throw error
  }

  logger.debug(`${deps.prefix} Subscribing with tenantCode: ${deps.tenantCode}`)
  state.subscriber.subscribe(
    deps.tenantCode,
    (notification) => { void handleNotification(deps, state, ctx, notification) },
  )

  state.subscriber.onReconnect(() => {
    logger.info(`${deps.prefix} Reconnected, checking for pending commands...`)
    void checkPendingCommands(deps, ctx)
  })
}

/**
 * Start heartbeat interval.
 */
export function startHeartbeat(
  deps: TransportDeps,
  state: TransportState,
  configSyncState: ConfigSyncState,
  configSyncDeps: ConfigSyncDeps,
): void {
  const sendHeartbeat = async (): Promise<void> => {
    try {
      await refreshChatMode(configSyncDeps, configSyncState, false)

      const response = await deps.client.heartbeat(
        deps.agentId,
        getSystemInfo(),
        undefined,
        configSyncState.availableChatModes,
        configSyncState.activeChatMode,
        getLocalIpAddress(),
        configSyncState.currentConfigHash,
      )

      // Check configHash from heartbeat response (polling fallback)
      if (response && typeof response === 'object' && 'configHash' in response) {
        const heartbeatResponse = response as { configHash?: string }
        if (heartbeatResponse.configHash && heartbeatResponse.configHash !== configSyncState.currentConfigHash) {
          logger.info(`${deps.prefix} Config hash changed in heartbeat response, syncing...`)
          state.configSyncDebounceTimer = scheduleConfigSync(configSyncDeps, configSyncState, state.configSyncDebounceTimer)
        }
      }

      logger.debug(`${deps.prefix} Heartbeat sent (activeChatMode=${configSyncState.activeChatMode ?? 'none'})`)
    } catch (error) {
      if (isAuthenticationError(error)) {
        logger.error(t('runner.authError', { prefix: deps.prefix, detail: getErrorMessage(error) }))
      } else {
        logger.warn(t('runner.heartbeatFailed', { prefix: deps.prefix, message: getErrorMessage(error) }))
      }
    }
  }

  state.heartbeatTimer = setInterval(() => {
    void sendHeartbeat()
  }, deps.heartbeatInterval)

  void sendHeartbeat()
}

/**
 * Start terminal WebSocket connection.
 * @param wsUrl - サーバーから返されたWebSocket URL（指定時はapiUrlの代わりに使用）
 */
export function startTerminalWebSocket(
  deps: TransportDeps,
  state: TransportState,
  wsUrl?: string,
): void {
  if (!isNodePtyAvailable()) {
    logger.warn(`${deps.prefix} Terminal WebSocket skipped: node-pty is not available (native build may have failed)`)
    return
  }

  // wsUrl が指定された場合はそれを使う（Next.jsプロキシ経由ではWSが通らないため）
  const baseUrl = wsUrl ?? deps.apiUrl
  const terminalDir = deps.projectDir ? getWorkspaceDir(deps.projectDir) : undefined
  state.terminalWs = new TerminalWebSocket(
    baseUrl,
    deps.token,
    deps.agentId,
    terminalDir,
  )

  state.terminalWs.connect().catch((error) => {
    logger.warn(`${deps.prefix} Terminal WebSocket connection failed: ${getErrorMessage(error)}`)
  })
}

/**
 * Start VS Code tunnel WebSocket connection.
 * @param wsUrl - サーバーから返されたWebSocket URL（指定時はapiUrlの代わりに使用）
 */
export function startVsCodeTunnel(
  deps: TransportDeps,
  state: TransportState,
  wsUrl?: string,
): void {
  const baseUrl = wsUrl ?? deps.apiUrl
  const reposDir = deps.projectDir ? getReposDir(deps.projectDir) : undefined
  state.vsCodeWs = new VsCodeTunnelWebSocket(
    baseUrl,
    deps.token,
    deps.agentId,
    reposDir,
  )

  state.vsCodeWs.connect().catch((error) => {
    logger.warn(`${deps.prefix} VS Code tunnel WebSocket connection failed: ${getErrorMessage(error)}`)
  })
}

/**
 * Handle an incoming AppSync notification.
 */
export async function handleNotification(
  deps: TransportDeps,
  state: TransportState,
  ctx: CommandContext,
  notification: AppSyncNotification,
): Promise<void> {
  // AppSync AWSJSON fields arrive as strings; parse if needed
  const content: Record<string, unknown> =
    typeof notification.content === 'string'
      ? JSON.parse(notification.content)
      : (notification.content ?? {})

  logger.debug(`${deps.prefix} Notification received: action=${notification.action}, content=${JSON.stringify(content).substring(0, LOG_RESULT_LIMIT)}`)

  switch (notification.action) {
    case 'agent-command': {
      const commandId = content.commandId as string
      const targetAgentId = content.agentId as string

      // 別agentId宛のコマンドはスキップ
      if (targetAgentId && targetAgentId !== deps.agentId) {
        logger.debug(`${deps.prefix} Ignoring command for agent ${targetAgentId} (expected ${deps.agentId})`)
        return
      }

      if (!commandId) {
        logger.warn(`${deps.prefix} Notification missing commandId: ${JSON.stringify(content)}`)
        return
      }
      const commandType = (content.type as string) ?? 'unknown'
      logger.info(t('runner.commandReceived', {
        prefix: deps.prefix,
        type: commandType,
        commandId,
      }))
      // chat_cancel is processed immediately regardless of processing flag
      await processCommand(deps, ctx, commandId)
      break
    }
    case 'config-update': {
      const newHash = content.configHash as string
      if (newHash && newHash !== ctx.configSyncState.currentConfigHash) {
        logger.info(`${deps.prefix} Config update detected (hash: ${newHash})`)
        state.configSyncDebounceTimer = scheduleConfigSync(ctx.configSyncDeps, ctx.configSyncState, state.configSyncDebounceTimer)
      }
      break
    }
    default:
      logger.debug(`${deps.prefix} Ignoring notification with action: ${notification.action}`)
  }
}

/**
 * Check for pending commands (used after reconnection).
 */
export async function checkPendingCommands(
  deps: TransportDeps,
  ctx: CommandContext,
): Promise<void> {
  try {
    const pending = await deps.client.getPendingCommands(deps.agentId)
    for (const cmd of pending) {
      logger.info(t('runner.commandReceived', {
        prefix: deps.prefix,
        type: cmd.type ?? 'unknown',
        commandId: cmd.commandId,
      }))
      await processCommand(deps, ctx, cmd.commandId)
    }
  } catch (error) {
    logger.warn(`${deps.prefix} Failed to check pending commands: ${getErrorMessage(error)}`)
  }
}

/**
 * Process a single command: fetch, execute, and submit result.
 */
async function processCommand(
  deps: TransportDeps,
  ctx: CommandContext,
  commandId: string,
): Promise<void> {
  try {
    const detail = await deps.client.getCommand(commandId, deps.agentId)
    logger.debug(`${deps.prefix} Command detail [${commandId}]: type=${detail.type}, payload=${JSON.stringify(detail.payload).substring(0, LOG_PAYLOAD_LIMIT)}`)
    const result = await executeCommand(detail.type, detail.payload, {
      commandId,
      client: deps.client,
      serverConfig: ctx.configSyncState.serverConfig ?? undefined,
      activeChatMode: ctx.configSyncState.activeChatMode,
      agentId: deps.agentId,
      projectDir: deps.projectDir,
      projectConfig: ctx.configSyncState.projectConfig,
      mcpConfigPath: ctx.configSyncState.mcpConfigPath,
      tenantCode: deps.tenantCode,
      onSetup: ctx.onSetup,
      onConfigSync: ctx.onConfigSync,
    })
    logger.debug(`${deps.prefix} Command result [${commandId}]: success=${result.success}, data=${JSON.stringify(result.success ? result.data : result.error).substring(0, LOG_RESULT_LIMIT)}`)
    await deps.client.submitResult(commandId, result, deps.agentId)
    logger.info(t('runner.commandDone', {
      prefix: deps.prefix,
      commandId,
      result: result.success ? 'success' : 'failed',
    }))
  } catch (error) {
    const message = getErrorMessage(error)
    logger.error(
      t('runner.commandError', { prefix: deps.prefix, commandId, message }),
    )

    try {
      await deps.client.submitResult(commandId, {
        success: false,
        error: message,
      }, deps.agentId)
    } catch {
      logger.error(t('runner.resultSendFailed', { prefix: deps.prefix }))
    }
  }
}

/**
 * Stop all transport resources.
 */
export function stopTransport(state: TransportState): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  if (state.configSyncDebounceTimer) clearTimeout(state.configSyncDebounceTimer)
  if (state.subscriber) state.subscriber.disconnect()
  if (state.terminalWs) state.terminalWs.disconnect()
  if (state.vsCodeWs) state.vsCodeWs.disconnect()
}
