import type { ApiClient } from './api-client'
import { AlertProcessor } from './alert-processor'
import { type AppSyncSubscriber, type AppSyncNotification } from './appsync-subscriber'
import {
  LOG_PAYLOAD_LIMIT,
  LOG_RESULT_LIMIT,
  NOTIFICATION_ACTION,
} from './constants'
import { t } from './i18n'
import type { TransportKind } from './ipc-types'
import { logger } from './logger'
import { getWorkspaceDir, getReposDir, getAwsDir } from './project-dir'
import { getSystemInfo, getLocalIpAddress } from './system-info'
import { TerminalWebSocket, isNodePtyAvailable } from './terminal'
import { getErrorMessage, isAuthenticationError } from './utils'
import { VsCodeTunnelWebSocket } from './vscode'
import { executeCommand } from './commands'
import type { ConfigSyncState, ConfigSyncDeps } from './agent-config-sync'
import { refreshChatMode, scheduleConfigSync } from './agent-config-sync'
import { savePendingResult, removePendingResult } from './pending-result-store'
import type { CommandResult } from './types/command'
import { cleanupStaleAwsCredentials } from './aws-profile'

export interface TransportState {
  heartbeatTimer: ReturnType<typeof setInterval> | null
  subscriber: AppSyncSubscriber | null
  terminalWs: TerminalWebSocket | null
  vsCodeWs: VsCodeTunnelWebSocket | null
  configSyncDebounceTimer: ReturnType<typeof setTimeout> | null
  /**
   * サーバーによる恒久的な認証拒否で停止したトランスポート（'terminal'/'vscode'）。
   * heartbeat でバックエンドに報告し、管理画面でプロジェクト単位の機能停止を可視化する。
   * agentId はプロセス起動時に確定するため、設定修正後は必ず再起動が必要で、
   * 再起動でこの集合は空に戻る（→ サーバー側で属性が削除される）。
   */
  authRejectedTransports: Set<TransportKind>
  /**
   * Command IDs this process is currently executing.
   *
   * The server keeps a claimed command in `PENDING` until its result arrives,
   * so `getPendingCommands` keeps returning commands we are still running, and
   * `claimCommand` answers 200 (not 409) to the instance that already owns the
   * claim. Without this guard the periodic sweep would start a second local
   * execution of any command that takes longer than the sweep interval —
   * duplicating its side effects (SSH/Ansible runs, ECS task launches).
   */
  inFlightCommands: Set<string>
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
  /**
   * サーバーによる恒久的な認証拒否（Agent ID トークンバインディング不一致等）で
   * terminal-ws / vscode-ws の接続が停止した際に呼ばれる。子プロセスから親プロセスへ
   * 通知するために使う（ログに埋もれさせないため）。transport は拒否された接続の種別。
   */
  onAuthRejected?: (transport: TransportKind) => void
  /**
   * Called when a heartbeat reports that this replica lost its slot (it was
   * evicted so a newer replica could run under the plan's replica limit).
   * The agent must stop serving work and go back to standby.
   */
  onEvicted?: () => void
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
  AppSyncSubscriberClass: new (url: string, authToken: string) => AppSyncSubscriber,
  appsyncUrl: string,
  authToken: string,
): Promise<void> {
  state.subscriber = new AppSyncSubscriberClass(appsyncUrl, authToken)

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

  // Pick up commands assigned before this subscription existed.
  //
  // The server assigns pending commands to a replica the moment it registers and
  // notifies them, but registration completes before this connection is up, so
  // that notification is lost for this replica. Without an initial scan the
  // commands wait for the server-side sweep (or a reconnect that may never come).
  void checkPendingCommands(deps, ctx)

  state.subscriber.onReconnect(() => {
    logger.info(`${deps.prefix} Reconnected, checking for pending commands...`)
    void checkPendingCommands(deps, ctx)
    // Alert のフォールバック: 再接続時に pending アラームを一括処理
    const alertProcessor = new AlertProcessor(deps.client, deps.tenantCode, deps.projectCode)
    void alertProcessor.checkPendingAlerts()
  })

  // AppSync が連続して接続確立（connection_ack）に失敗し続けた場合に発火する。
  // subscriber 側で既に ERROR ログ出力済みだが、ここでも project 単位で可視化する
  // （無限サイレント再接続に埋もれさせない）。再接続は継続しているため一過性障害・
  // rollout 遅延は自己回復する。完全な再登録（runRegisterLoop 再突入）やサーバー側
  // への可視化（TransportKind への 'appsync' 追加）は follow-up。
  state.subscriber.onPersistentFailure(() => {
    logger.error(
      `${deps.prefix} AppSync realtime delivery degraded: persistently failing to connect. ` +
        `Verify the agent token and that the AppSync Lambda authorizer is enabled for this environment. Still retrying.`,
    )
  })
}

/**
 * Start heartbeat interval.
 */
/**
 * terminal-ws / vscode-ws がサーバーによる恒久的な認証拒否で停止した際に呼ばれる。
 * ローカルで再起動が必要な状態を記録し、次回 heartbeat でバックエンドに報告する
 * （管理画面での可視化）とともに、既存の外部通知（子→親 IPC 等）にも中継する。
 */
export function onTransportAuthRejected(
  deps: TransportDeps,
  state: TransportState,
  transport: TransportKind,
): void {
  state.authRejectedTransports.add(transport)
  deps.onAuthRejected?.(transport)
}

export function startHeartbeat(
  deps: TransportDeps,
  state: TransportState,
  configSyncState: ConfigSyncState,
  configSyncDeps: ConfigSyncDeps,
): void {
  const sendHeartbeat = async (): Promise<void> => {
    try {
      await refreshChatMode(configSyncDeps, configSyncState, false)

      // 孤立した AWS credentials-* ファイルの掃除は agent-config-sync.ts の
      // applyProjectConfig でも行われるが、それは configHash 変化時にしか呼ばれない
      // （syncProjectConfig が hash 一致時は同期をスキップするため）。設定が長期間
      // 変化しないまま稼働し続けると掃除の機会が失われるため、heartbeat 側にも
      // 安全網としてフックする（sweepStaleEntries は冪等なので二重実行しても無害）。
      if (deps.projectDir) {
        try {
          const removedCount = cleanupStaleAwsCredentials(getAwsDir(deps.projectDir))
          if (removedCount > 0) {
            logger.info(`${deps.prefix} Cleaned up ${removedCount} stale AWS credentials file(s)`)
          }
        } catch (error) {
          logger.warn(`${deps.prefix} Failed to clean up stale AWS credentials files: ${getErrorMessage(error)}`)
        }
      }

      const response = await deps.client.heartbeat(
        deps.agentId,
        getSystemInfo(),
        undefined,
        configSyncState.availableChatModes,
        configSyncState.activeChatMode,
        getLocalIpAddress(),
        configSyncState.currentConfigHash,
        undefined,
        Array.from(state.authRejectedTransports),
        // 共有ファイルの配置失敗を毎回報告する。復旧したら undefined になり、
        // api 側で記録が消える（古い警告が残り続けない）。
        // 常に配列で送る。undefined だと api へ項目自体が送られず、解消しても
        // 保存済みの警告が消えない（api は空配列を「解消」と解釈する）。
        { sharedFileMountErrors: configSyncState.sharedFileMountErrors ?? [] },
      )

      // This replica was evicted to make room for a newer one (plan replica
      // limit). Hand control back to the agent so it stops serving work and
      // waits for a free slot instead of keeping a half-live connection.
      if (response && typeof response === 'object' && 'evicted' in response && response.evicted) {
        logger.warn(
          `${deps.prefix} ${t('runner.replicaEvicted', { instanceId: deps.client.getInstanceId() })}`,
        )
        deps.onEvicted?.()
        return
      }

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
    () => onTransportAuthRejected(deps, state, 'terminal'),
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
    () => onTransportAuthRejected(deps, state, 'vscode'),
    deps.tenantCode,
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
 * Whether an error means another replica already claimed this command.
 *
 * The API answers `GET /commands/:id` with 409 when a different replica of the
 * same logical agent won the exclusive claim.
 */
function isCommandClaimedByAnotherReplica(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status
  return status === 409
}

/**
 * Process a single command: fetch, execute, and submit result.
 */
async function processCommand(
  deps: TransportDeps,
  ctx: CommandContext,
  commandId: string,
): Promise<void> {
  // Never run the same command twice in this process. Reached from three
  // places — the AppSync notification, the re-claim timer, and the periodic
  // pending sweep — and the last two can fire while the command is still
  // running (the server keeps it PENDING until the result arrives).
  if (ctx.transportState.inFlightCommands.has(commandId)) {
    logger.debug(
      `${deps.prefix} Command ${commandId} is already running in this process; skipping`,
    )
    return
  }
  ctx.transportState.inFlightCommands.add(commandId)
  try {
    let detail: Awaited<ReturnType<typeof deps.client.getCommand>>
    try {
      detail = await deps.client.getCommand(commandId, deps.agentId)
    } catch (error) {
      if (isCommandClaimedByAnotherReplica(error)) {
        // Multi-replica deployments broadcast every command notification to all
        // replicas of the same logical agent; exactly one wins the server-side
        // claim. Losing is the normal outcome for the others, not an error — do
        // not log at error level and do not submit a failure result (that would
        // overwrite the winner's result with a spurious failure).
        logger.debug(
          `${deps.prefix} Command ${commandId} is being handled by another replica; skipping`,
        )
        return
      }
      throw error
    }
    const trustedPayload = detail.type === 'chat' &&
      typeof detail.userId === 'string' &&
      detail.userId.startsWith('slack:')
      ? {
          ...detail.payload,
          interactionOrigin: 'slack',
          toolPolicy: 'marketplace_read_only',
        }
      : detail.payload
    logger.debug(`${deps.prefix} Command detail [${commandId}]: type=${detail.type}, payload=${JSON.stringify(trustedPayload).substring(0, LOG_PAYLOAD_LIMIT)}`)
    const result = await executeCommand(detail.type, trustedPayload, {
      commandId,
      client: deps.client,
      serverConfig: ctx.configSyncState.serverConfig ?? undefined,
      activeChatMode: ctx.configSyncState.activeChatMode,
      activeChatModeExplicit: ctx.configSyncState.activeChatModeExplicit,
      availableChatModes: ctx.configSyncState.availableChatModes,
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
    savePendingResult(
      commandId,
      deps.agentId,
      result,
      deps.apiUrl,
      deps.token,
      deps.tenantCode,
      // 再起動後の再送でフェンシングを通すため、実行時の指名世代も保存する。
      deps.client.getAssignmentGeneration(commandId),
    )
    try {
      await deps.client.submitResult(commandId, result, deps.agentId)
    } catch (error) {
      if (isCommandClaimedByAnotherReplica(error)) {
        // Long-running commands can outlive our claim: if this replica is
        // evicted and the lease expires, another replica takes the command
        // over and re-runs it. The server fences our late result (409) to
        // protect the new owner's result. That is the designed hand-off, not
        // an execution error — do not log it at error level and do not retry
        // (the retry would be fenced too), but do drop the pending file so it
        // is not resubmitted on the next start.
        removePendingResult(commandId)
        logger.warn(
          `${deps.prefix} Result for ${commandId} was rejected: the command was re-claimed by another replica`,
        )
        return
      }
      // Do NOT rethrow. The outer catch treats anything it receives as an
      // *execution* failure and overwrites the pending file with
      // `{success:false, error:<transport error>}` — which would destroy the
      // real result we just persisted, making it unrecoverable even after a
      // restart. The result is already on disk; log it and let the pending
      // store resend it.
      logger.error(
        `${deps.prefix} Failed to submit the result for ${commandId}; it stays queued for resend: ${getErrorMessage(error)}`,
      )
      return
    }
    removePendingResult(commandId)
    logger.info(t('runner.commandDone', {
      prefix: deps.prefix,
      commandId,
      result: result.success ? 'success' : 'failed',
    }))
  } catch (error) {
    if (isCommandClaimedByAnotherReplica(error)) {
      removePendingResult(commandId)
      logger.warn(
        `${deps.prefix} Command ${commandId} was re-claimed by another replica; discarding our result`,
      )
      return
    }
    const message = getErrorMessage(error)
    logger.error(
      t('runner.commandError', { prefix: deps.prefix, commandId, message }),
    )

    // 成功パスと同じく、送信前に永続化する。ここで保存しないと、送信が
    // 一時障害で失敗した場合に実行時例外の内容がサーバーへ一切届かず、
    // コマンドは回収 cron のタイムアウトまで宙に浮く（対称性）。
    const failureResult: CommandResult = { success: false, error: message }
    savePendingResult(
      commandId,
      deps.agentId,
      failureResult,
      deps.apiUrl,
      deps.token,
      deps.tenantCode,
      deps.client.getAssignmentGeneration(commandId),
    )
    try {
      await deps.client.submitResult(commandId, failureResult, deps.agentId)
      removePendingResult(commandId)
    } catch (submitError) {
      if (isCommandClaimedByAnotherReplica(submitError)) {
        removePendingResult(commandId)
        logger.warn(
          `${deps.prefix} Failure result for ${commandId} was rejected: the command was re-claimed by another replica`,
        )
        return
      }
      logger.error(t('runner.resultSendFailed', { prefix: deps.prefix }))
    }
  } finally {
    ctx.transportState.inFlightCommands.delete(commandId)
    // 実行が終わったコマンドの世代は保持し続けない（プロセス寿命の間、
    // 完了済みコマンドの分だけ Map が増え続ける）。
    deps.client.clearAssignment(commandId)
  }
}

/**
 * Stop all transport resources.
 */
/**
 * Stop the transport (heartbeat, subscriptions, WebSockets).
 *
 * `inFlightCommands` is deliberately NOT cleared: a transport restart
 * (token update, eviction → standby) does not abort commands that are already
 * running, and clearing the set would let the same process pick the same
 * command up again while the first execution is still going.
 * Each `processCommand` removes its own entry in `finally`.
 */
export function stopTransport(state: TransportState): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  if (state.configSyncDebounceTimer) clearTimeout(state.configSyncDebounceTimer)
  if (state.subscriber) state.subscriber.disconnect()
  if (state.terminalWs) state.terminalWs.disconnect()
  if (state.vsCodeWs) state.vsCodeWs.disconnect()
}
