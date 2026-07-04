import type { ApiClient } from './api-client'
import { AlertProcessor } from './alert-processor'
import { type AppSyncSubscriber, type AppSyncNotification } from './appsync-subscriber'
import { LOG_PAYLOAD_LIMIT, LOG_RESULT_LIMIT, NOTIFICATION_ACTION } from './constants'
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
import { savePendingResult, removePendingResult } from './pending-result-store'

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
  projectCode: string
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
  onReboot: () => Promise<void>
  onUpdate: () => Promise<void>
  onSyncRepository: (repositoryCode: string, branch?: string) => Promise<import('./repo-sync').RepoSyncResult>
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
    // Alert のフォールバック: 再接続時に pending アラームを一括処理
    const alertProcessor = new AlertProcessor(deps.client, deps.tenantCode, deps.projectCode)
    void alertProcessor.checkPendingAlerts()
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
 * @param configSyncState - PTY セッション起動時に最新の envVars を取り出すための参照
 */
export function startTerminalWebSocket(
  deps: TransportDeps,
  state: TransportState,
  wsUrl?: string,
  configSyncState?: ConfigSyncState,
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
    configSyncState ? () => configSyncState.projectConfig?.envVars : undefined,
  )

  state.terminalWs.connect().catch((error) => {
    logger.warn(`${deps.prefix} Terminal WebSocket connection failed: ${getErrorMessage(error)}`)
  })
}

/**
 * Start VS Code tunnel WebSocket connection.
 * @param wsUrl - サーバーから返されたWebSocket URL（指定時はapiUrlの代わりに使用）
 * @param configSyncState - code-server プロセス起動時に最新の envVars を取り出すための参照
 */
export function startVsCodeTunnel(
  deps: TransportDeps,
  state: TransportState,
  wsUrl?: string,
  configSyncState?: ConfigSyncState,
): void {
  const baseUrl = wsUrl ?? deps.apiUrl
  // reposDir = VS Code の起動ディレクトリ（リポジトリ群のある場所）。
  // workspaceDir = ブラウザのファイルチューザーがファイル相対パスを解決する基点。
  // 両者は異なるディレクトリのため、別々に渡す（混同すると相対パスが不存在パスに
  // 解決され、選択しても「何も起こらない」不具合になる）。
  const reposDir = deps.projectDir ? getReposDir(deps.projectDir) : undefined
  const workspaceDir = deps.projectDir ? getWorkspaceDir(deps.projectDir) : undefined
  state.vsCodeWs = new VsCodeTunnelWebSocket(
    baseUrl,
    deps.token,
    deps.agentId,
    reposDir,
    workspaceDir,
    configSyncState ? () => configSyncState.projectConfig?.envVars : undefined,
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

  // agent-log通知はログ出力せずに早期return（無限ループ防止）
  if (notification.action === NOTIFICATION_ACTION.AGENT_LOG) {
    return
  }

  logger.debug(`${deps.prefix} Notification received: action=${notification.action}, content=${JSON.stringify(content).substring(0, LOG_RESULT_LIMIT)}`)

  switch (notification.action) {
    case NOTIFICATION_ACTION.AGENT_COMMAND: {
      const commandId = content.commandId as string
      const targetAgentId = content.agentId as string

      // 別agentId宛のコマンドはスキップ
      if (targetAgentId && targetAgentId !== deps.agentId) {
        logger.debug(`${deps.prefix} Ignoring command for agent ${targetAgentId} (expected ${deps.agentId})`)
        return
      }

      // tenantCode/projectCodeが含まれていない通知、または自分宛でない通知をスキップ
      const contentTenantCode = content.tenantCode as string | undefined
      const contentProjectCode = content.projectCode as string | undefined
      if (!contentTenantCode || contentTenantCode !== deps.tenantCode) {
        logger.debug(`${deps.prefix} Ignoring command for tenant ${contentTenantCode ?? '(none)'} (expected ${deps.tenantCode})`)
        return
      }
      if (!contentProjectCode || contentProjectCode !== deps.projectCode) {
        logger.debug(`${deps.prefix} Ignoring command for project ${contentProjectCode ?? '(none)'} (expected ${deps.projectCode})`)
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
    case NOTIFICATION_ACTION.CONFIG_UPDATE: {
      // APIがconfig-update通知を送るタイミングはRDS同期前の可能性があるため、
      // hashの比較は行わず常に再同期をスケジュールする。
      // hash比較による変更なしスキップはsyncProjectConfig側で行う。
      logger.info(`${deps.prefix} Config update notification received, scheduling sync`)
      ctx.configSyncState.currentConfigHash = undefined
      state.configSyncDebounceTimer = scheduleConfigSync(ctx.configSyncDeps, ctx.configSyncState, state.configSyncDebounceTimer)
      break
    }
    case NOTIFICATION_ACTION.ALERT_CREATED: {
      const alertProjectCode = content.projectCode as string | undefined
      const alertNumber = content.alertNumber as string | undefined
      if (alertProjectCode === deps.projectCode && alertNumber) {
        logger.info(`${deps.prefix} Alert received: ${alertNumber} (alarm: ${content.alarmName ?? 'unknown'})`)
        const processor = new AlertProcessor(deps.client, deps.tenantCode, deps.projectCode)
        await processor.processAlert(alertNumber)
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
  ctx.transportState.processing = true
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
      browserLocalPort: ctx.transportState.vsCodeWs?.getBrowserLocalPort(),
      onSetup: ctx.onSetup,
      onConfigSync: ctx.onConfigSync,
      onReboot: ctx.onReboot,
      onUpdate: ctx.onUpdate,
      onSyncRepository: ctx.onSyncRepository,
      // E2E テスト実行専用のブラウザーセッションをメインプロセスの
      // BrowserSessionManager 上で明示的にライフサイクル管理する。
      // vsCodeWs 未接続時（VS Code トンネル未確立）はコールバック自体を渡さず、
      // e2e-test-executor 側で事前登録・クローズをスキップさせる。
      // openLiveViewSession はセッション確保に加え、対話的な browser_open と同じ
      // ライブビュー配信開始（session.startLiveView）と browser_ready 送信まで行う。
      // browserSessionManager.getOrCreate を直接呼ぶだけでは、Web側のライブ
      // プレビューが browser_frame を一切受信できず「起動中」のまま止まる。
      getOrCreateBrowserSession: ctx.transportState.vsCodeWs
        ? async (sessionId: string) => {
            await ctx.transportState.vsCodeWs?.openLiveViewSession(sessionId)
          }
        : undefined,
      // BrowserSessionManager.close() は内部で session.close() → stopLiveView()
      // を呼ぶため、ライブビュー配信の停止・ブラウザリソースの解放は直接呼び出しで
      // 完結している（openLiveViewSession 側と対称的な専用クローズAPIは不要）。
      closeBrowserSession: ctx.transportState.vsCodeWs
        ? async (sessionId: string) => {
            await ctx.transportState.vsCodeWs?.browserSessionManager.close(sessionId)
          }
        : undefined,
    })
    logger.debug(`${deps.prefix} Command result [${commandId}]: success=${result.success}, data=${JSON.stringify(result.success ? result.data : result.error).substring(0, LOG_RESULT_LIMIT)}`)
    savePendingResult(commandId, deps.agentId, result, deps.apiUrl, deps.token, deps.tenantCode)
    await deps.client.submitResult(commandId, result, deps.agentId)
    removePendingResult(commandId)
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
  } finally {
    ctx.transportState.processing = false
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
