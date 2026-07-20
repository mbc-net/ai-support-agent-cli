import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { BrowserLocalServer } from '../browser/browser-local-server'
import { WS_CLOSE_CODE_AUTH_REJECTED, WS_RECONNECT_MAX_DELAY_MS } from '../constants'
import type { EnvVarsProvider } from '../env-vars-filter'
import { logger } from '../logger'
import { getErrorMessage, buildWsUrl } from '../utils'
import {
  BrowserSessionManager,
} from '../mcp/tools/browser/browser-session-manager'
import { validateUrl } from '../mcp/tools/browser/browser-security'
import { SELECTOR_TIMEOUT_NAVIGATION_MS } from '../mcp/tools/browser/browser-types'
import type { BrowserSession, FileChooserPayload } from '../mcp/tools/browser/browser-session'
import { executePlaywrightScript } from '../browser/browser-script-executor'

import {
  VSCODE_WS_MAX_RECONNECT_RETRIES,
  VSCODE_WS_RECONNECT_BASE_DELAY_MS,
  HTTP_RESPONSE_CHUNK_SIZE,
} from './constants'
import { VsCodeServer } from './vscode-server'
import { proxyHttpRequest } from './vscode-http-proxy'
import { VsCodeWsProxy } from './vscode-ws-proxy'

/**
 * API Server → Agent メッセージ
 */
export interface VsCodeServerMessage {
  type:
    | 'vscode_open'
    | 'vscode_close'
    | 'port_forward_open'
    | 'port_forward_close'
    | 'http_request'
    | 'ws_frame'
    | 'auth_success'
    | 'error'
    // Browser messages
    | 'browser_open'
    | 'browser_close'
    | 'browser_navigate'
    | 'browser_go_back'
    | 'browser_go_forward'
    | 'browser_reload'
    | 'browser_mouse_click'
    | 'browser_mouse_move'
    | 'browser_mouse_down'
    | 'browser_mouse_up'
    | 'browser_mouse_wheel'
    | 'browser_keyboard_type'
    | 'browser_keyboard_press'
    | 'browser_screenshot'
    | 'browser_viewport'
    | 'browser_execute_script'
    | 'browser_set_file'
    | 'browser_get_selection'
    | 'browser_set_input_value'
  filePaths?: string[]
  files?: Array<{ name: string; mimeType: string; dataBase64: string }>
  sessionId?: string
  /**
   * Tenant code the API server attaches to `vscode_open`/`port_forward_open`/
   * `browser_open` messages. When present, it is checked against this
   * connection's own (trusted, constructor-supplied) tenant code as a
   * defense-in-depth measure — see `validateTenantCode`. Optional and not
   * enforced when absent, for backward compatibility with callers that do
   * not yet send it.
   */
  tenantCode?: string
  requestId?: string
  subSocketId?: string
  projectDir?: string
  targetPort?: number
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  data?: string
  isOpen?: boolean
  isClosed?: boolean
  message?: string
  // Browser-specific fields
  conversationId?: string
  url?: string
  /**
   * Browser resume request. When `true` on a `browser_open`, the agent reuses an
   * existing live browser session for this `sessionId` and immediately re-sends
   * the current frame/URL/ready state instead of creating a fresh session. If no
   * live session exists, the agent replies `resume_failed` so the Web client can
   * fall back to a normal (non-resume) open. Absent/false → current new-session
   * behavior (backward compatible).
   */
  resume?: boolean
  x?: number
  y?: number
  button?: string
  clickCount?: number
  deltaX?: number
  deltaY?: number
  text?: string
  key?: string
  modifiers?: string[]
  width?: number
  height?: number
  deviceId?: string
  script?: string
  // browser_set_input_value fields (overlay-edited value → focused element)
  value?: string
  selectionStart?: number
  selectionEnd?: number
}

/**
 * `resume_failed` メッセージの `reason` が取り得る値。
 * - `'not_found'`: 対象 sessionId のセッションが Map に存在しない
 * - `'dead'`: セッションは存在するが live ではない（事前チェック時、または
 *   getOrCreate 後の TOCTOU 再確認でアイドルクローズ完了を検知した場合）
 */
export type ResumeFailureReason = 'not_found' | 'dead'

/**
 * Agent → API Server メッセージ
 */
export interface VsCodeAgentMessage {
  type:
    | 'vscode_ready'
    | 'vscode_stopped'
    | 'port_forward_ready'
    | 'port_forward_stopped'
    | 'http_response'
    | 'ws_frame'
    | 'error'
    // Browser messages
    | 'browser_ready'
    | 'browser_frame'
    | 'browser_screenshot_result'
    | 'browser_selection_result'
    | 'browser_action_log'
    | 'browser_stopped'
    | 'browser_script_result'
    | 'browser_script_progress'
    | 'browser_file_chooser_opened'
    | 'browser_cursor_update'
    | 'browser_focus_changed'
    | 'resume_failed'
  sessionId?: string
  targetPort?: number
  requestId?: string
  subSocketId?: string
  port?: number
  projectDir?: string
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  bodyChunkIndex?: number
  bodyChunkTotal?: number
  data?: string
  isOpen?: boolean
  isClosed?: boolean
  message?: string
  // Browser-specific fields
  conversationId?: string
  currentUrl?: string
  pageTitle?: string
  text?: string
  timestamp?: number
  /**
   * 失敗・停止理由。`resume_failed` の場合は {@link ResumeFailureReason}
   * （`'not_found' | 'dead'`）に限定される。`browser_stopped` 等では
   * 任意のエラーメッセージ文字列が入るため型は `string` のまま。
   */
  reason?: string
  entries?: Array<{ timestamp: number; source: string; action: string; details: string }>
  // Script execution fields
  success?: boolean
  completedSteps?: number
  totalSteps?: number
  results?: Array<{ line: string; success: boolean; error?: string }>
  failedLine?: string
  fallbackToChat?: boolean
  step?: number
  line?: string
  script?: string
  /** CSS cursor value at the last mouse-move point (browser_cursor_update) */
  cursor?: string
  // browser_focus_changed fields (focused input/textarea state → Web overlay)
  focused?: boolean
  rect?: { x: number; y: number; width: number; height: number }
  value?: string
  selectionStart?: number
  selectionEnd?: number
  multiline?: boolean
  inputType?: string
  maxLength?: number
  fontSize?: number
  lineHeight?: number
  textAlign?: string
  paddingTop?: number
  paddingLeft?: number
  caretColor?: string
}

/** Live view frame interval in milliseconds (5 FPS) */
const LIVE_VIEW_INTERVAL_MS = 200

/**
 * Authoritative maximum total size (decoded bytes) for a browser file upload.
 * Guards against unbounded base64 payloads consuming agent memory.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB

/**
 * Sanitize a client-supplied upload file name into a safe basename so it can be
 * joined to a temp directory without escaping it (path-traversal defense).
 *
 * Strips any directory components (`path.basename`), then rejects path-relative
 * tokens (`.`/`..`) and any remaining separator characters by replacing unsafe
 * characters with `_`. Always returns a non-empty basename, falling back to
 * `upload` when nothing safe remains.
 */
function sanitizeUploadFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : ''
  // Drop any directory portion the client may have included.
  let base = path.basename(raw)
  // Replace path separators and traversal-relevant characters; collapse control
  // chars and leading dots that could hide the file or break paths.
  base = base.replace(/[/\\]/g, '_').replace(/\0/g, '')
  if (base === '' || base === '.' || base === '..') {
    return 'upload'
  }
  return base
}

/**
 * VS Code トンネル WebSocket
 *
 * TerminalWebSocket と同じパターンで BaseWebSocketConnection を継承し、
 * API Server とのトンネル WebSocket 経由で code-server へのアクセスを提供する。
 * ブラウザライブビューメッセージも同じ WebSocket 接続で処理する。
 */
export class VsCodeTunnelWebSocket extends BaseWebSocketConnection<VsCodeServerMessage> {
  private readonly wsUrl: string
  private vsCodeServer: VsCodeServer | null = null
  /**
   * 起動中の vsCodeServer に注入した envVars の signature。
   * 後続セッション要求時に envVars に変化があれば code-server を再起動する。
   * sorted key=value を join したもの。空オブジェクトは ''。
   */
  private vsCodeServerEnvSignature: string = ''
  private wsProxy: VsCodeWsProxy | null = null
  private readonly portForwardSessions = new Map<string, { targetPort: number; wsProxy: VsCodeWsProxy }>()
  readonly browserSessionManager = new BrowserSessionManager()
  private browserLocalServer: BrowserLocalServer | null = null
  private browserLocalPort = 0
  private readonly pendingFileChoosers = new Map<string, (files: FileChooserPayload) => Promise<void>>()
  /**
   * Last CSS cursor value sent per browser session. Used to suppress redundant
   * browser_cursor_update messages: only send when the cursor shape changes.
   */
  private readonly lastSentCursor = new Map<string, string>()

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    /**
     * code-server の起動ディレクトリ（= reposDir = `<projectDir>/workspace/repos`）。
     * VS Code はリポジトリ群のあるディレクトリで開く。
     */
    private readonly projectDir?: string,
    /**
     * ブラウザのファイルチューザーで選択されたワークスペース相対パスを解決する
     * ルート（= `<projectDir>/workspace`）。`projectDir`（reposDir）とは異なる
     * ディレクトリで、ファイルピッカーが一覧する基点と一致させる必要がある。
     */
    private readonly workspaceDir?: string,
    /**
     * code-server セッション起動時に最新の envVars を取り出す関数。
     * Web 設定が agent プロセス起動後に到着するため関数渡しで遅延評価する。
     */
    private readonly envVarsProvider?: EnvVarsProvider,
    private readonly onAuthRejected?: () => void,
    /**
     * This connection's own, trusted tenant code (established out-of-band at
     * connection setup — e.g. from the agent's provisioning config), used as
     * the comparison baseline for `validateTenantCode`. Optional and placed
     * last so existing positional call sites are unaffected; when absent,
     * tenantCode validation is skipped entirely (no baseline to compare
     * against).
     */
    private readonly tenantCode?: string,
  ) {
    super({
      maxReconnectRetries: VSCODE_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: VSCODE_WS_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: WS_RECONNECT_MAX_DELAY_MS,
      logPrefix: '[vscode-ws]',
      authRejectedCloseCode: WS_CLOSE_CODE_AUTH_REJECTED,
    })
    this.wsUrl = buildWsUrl(apiUrl, '/ws/agent-vscode')
  }

  /**
   * Get the port of the browser local HTTP server (0 if not started).
   */
  getBrowserLocalPort(): number {
    return this.browserLocalPort
  }

  protected createWebSocket(): WebSocket {
    // Re-send ALB sticky cookies captured on the previous handshake so a
    // reconnect lands on the same API task (scale-out safe).
    const cookie = this.getStickyCookieHeader()
    return new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Agent-Id': this.agentId,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
  }

  /** Promise that resolves when the browser local server has started */
  private browserLocalServerStartPromise: Promise<void> | null = null

  protected onOpen(_ws: WebSocket, resolve: (value: void) => void): void {
    logger.info('[vscode-ws] Connected to VS Code tunnel WebSocket')
    this.reconnectAttemptsRef.current = 0

    // Start browser local server for inter-process communication
    if (!this.browserLocalServer) {
      const localServer = new BrowserLocalServer(this.browserSessionManager)
      this.browserLocalServer = localServer
      // Forward action log entries from chat-initiated operations to the Web UI
      localServer.onActionLog = (notification) => {
        this.send({
          type: 'browser_action_log',
          sessionId: notification.sessionId,
          entries: [notification.entry],
        })
      }
      this.browserLocalServerStartPromise = (async () => {
        try {
          const port = await localServer.start()
          this.browserLocalPort = port
          logger.info(`[vscode-ws] Browser local server started on port ${port}`)
        } catch (err) {
          logger.error(`[vscode-ws] Failed to start browser local server: ${getErrorMessage(err)}`)
        }
      })()
    }

    resolve()
  }

  /**
   * Wait for the browser local server to be ready and return its port.
   * Returns 0 if the server failed to start or is not initialized.
   */
  async waitForBrowserLocalPort(): Promise<number> {
    if (this.browserLocalServerStartPromise) {
      await this.browserLocalServerStartPromise
    }
    return this.browserLocalPort
  }

  protected onParsedMessage(msg: VsCodeServerMessage): void {
    switch (msg.type) {
      case 'vscode_open':
        this.handleVsCodeOpen(msg)
        break
      case 'vscode_close':
        this.handleVsCodeClose(msg)
        break
      case 'port_forward_open':
        this.handlePortForwardOpen(msg)
        break
      case 'port_forward_close':
        this.handlePortForwardClose(msg)
        break
      case 'http_request':
        this.handleHttpRequest(msg)
        break
      case 'ws_frame':
        this.handleWsFrame(msg)
        break
      case 'auth_success':
        break
      case 'error': {
        const errMsg = msg.message ?? 'unknown'
        logger.warn(`[vscode-ws] Server error (session=${msg.sessionId ?? 'none'}): ${errMsg}`)
        break
      }
      // Browser messages
      case 'browser_open':
        this.handleBrowserOpen(msg)
        break
      case 'browser_close':
        this.handleBrowserClose(msg)
        break
      case 'browser_navigate':
        this.handleBrowserNavigate(msg)
        break
      case 'browser_go_back':
        this.handleBrowserGoBack(msg)
        break
      case 'browser_go_forward':
        this.handleBrowserGoForward(msg)
        break
      case 'browser_reload':
        this.handleBrowserReload(msg)
        break
      case 'browser_mouse_click':
        this.handleBrowserMouseClick(msg)
        break
      case 'browser_mouse_move':
        void this.handleBrowserMouseMove(msg)
        break
      case 'browser_mouse_down':
        void this.handleBrowserMouseDown(msg)
        break
      case 'browser_mouse_up':
        void this.handleBrowserMouseUp(msg)
        break
      case 'browser_mouse_wheel':
        this.handleBrowserMouseWheel(msg)
        break
      case 'browser_keyboard_type':
        this.handleBrowserKeyboardType(msg)
        break
      case 'browser_keyboard_press':
        this.handleBrowserKeyboardPress(msg)
        break
      case 'browser_screenshot':
        this.handleBrowserScreenshot(msg)
        break
      case 'browser_viewport':
        this.handleBrowserViewport(msg)
        break
      case 'browser_execute_script':
        this.handleBrowserExecuteScript(msg)
        break
      case 'browser_set_file':
        void this.handleBrowserSetFile(msg)
        break
      case 'browser_get_selection':
        void this.handleBrowserGetSelection(msg)
        break
      case 'browser_set_input_value':
        void this.handleBrowserSetInputValue(msg)
        break
      default:
        logger.debug(`[vscode-ws] Unknown message type: ${(msg as { type: string }).type}`)
    }
  }

  protected onDisconnect(): void {
    this.cleanup()
  }

  /**
   * Server-side permanent authentication rejection (invalid token, or Agent ID
   * token-binding mismatch). Reconnecting to resume is not possible — the
   * connection will never be re-established with the same credentials — so
   * this is a genuine teardown just like an explicit disconnect: release
   * code-server, port-forward proxies, and browser sessions rather than
   * leaving them running indefinitely.
   */
  protected onPermanentClose(): void {
    this.cleanup()
    this.onAuthRejected?.()
  }

  // --- VS Code handlers ---

  private async handleVsCodeOpen(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) {
      this.sendMissingSessionIdError()
      return
    }

    if (!this.validateTenantCode(sessionId, msg.tenantCode)) return

    let projectDir: string | undefined
    if (msg.projectDir) {
      // Client/API-supplied projectDir MUST be contained within the trusted
      // workspace root (`this.projectDir`). Without this check, an absolute
      // path (e.g. `/` or `~/.ssh`) or a `../` traversal would let code-server
      // be launched (with `--auth none`) rooted outside the workspace,
      // exposing arbitrary host files with no authentication.
      const trustedRoot = this.projectDir
      if (!trustedRoot) {
        this.send({ type: 'error', sessionId, message: 'No project directory' })
        return
      }
      const resolved = path.resolve(trustedRoot, msg.projectDir)
      const isInsideRoot = resolved === trustedRoot || resolved.startsWith(trustedRoot + path.sep)
      if (!isInsideRoot) {
        this.send({ type: 'error', sessionId, message: 'projectDir outside workspace' })
        return
      }

      // HIGH defense-in-depth: the lexical (string) containment check above
      // only guards against traversal at the string level. A symlink planted
      // inside the trusted root (e.g. by a prior local compromise) that
      // points OUTSIDE it would pass that check — `resolved` is lexically
      // inside the root, but its real (canonical) location is not.
      //
      // Re-checking via `fs.realpath(resolved)` directly is NOT sufficient:
      // when the leaf path itself does not exist yet (a common case — the
      // caller is often about to create a new directory), `realpath` rejects
      // with ENOENT on the whole call, which would silently skip the check
      // entirely even if an INTERMEDIATE path component is the malicious
      // symlink. `fs.mkdirSync(..., { recursive: true })` (called downstream
      // in vscode-server.ts to set up the workspace) follows symlinks at
      // every intermediate component when creating the missing tail, so a
      // symlink two levels up combined with a not-yet-existing leaf would
      // bypass this guard completely with no error.
      //
      // Instead, walk up from `resolved` to find the deepest path segment
      // that actually exists, and canonicalize THAT — this always includes
      // any symlink placed anywhere along the path, whether or not the final
      // leaf exists.
      //
      // This check only applies when `trustedRoot` itself resolves on disk.
      // In production `this.projectDir` is always a real, already-existing
      // workspace directory, so this is not a loophole for real deployments —
      // it only skips the check for callers that pass a purely virtual root
      // that was never meant to exist on the filesystem at all (there is no
      // real symlink threat to canonicalize against in that case).
      const realTrustedRoot = await fs.realpath(trustedRoot).catch(() => null)
      if (realTrustedRoot !== null) {
        const existingAncestor = await this.findDeepestExistingAncestor(resolved)
        const realAncestor = await fs.realpath(existingAncestor).catch(() => existingAncestor)
        const isReallyInsideRoot =
          realAncestor === realTrustedRoot || realAncestor.startsWith(realTrustedRoot + path.sep)
        if (!isReallyInsideRoot) {
          this.send({ type: 'error', sessionId, message: 'projectDir outside workspace' })
          return
        }
      }

      projectDir = resolved
    } else {
      projectDir = this.projectDir
    }

    if (!projectDir) {
      this.send({ type: 'error', sessionId, message: 'No project directory' })
      return
    }

    // 最新の envVars を取得して signature を計算
    const envVarsOverride = this.envVarsProvider?.()
    if (this.envVarsProvider && !envVarsOverride) {
      logger.warn(
        `[vscode-server] Opening session ${sessionId} before envVars are available; ` +
          `Web-configured env overrides will not apply until the next successful config sync`,
      )
    }
    const newEnvSignature = computeEnvSignature(envVarsOverride)

    // 既存のサーバーがあり、かつ envVars に変化が無ければ再利用
    if (this.vsCodeServer?.isRunning && this.vsCodeServerEnvSignature === newEnvSignature) {
      this.vsCodeServer.touch()
      this.send({
        type: 'vscode_ready',
        sessionId,
        port: this.vsCodeServer.getPort(),
        projectDir,
      })
      return
    }

    // envVars が変化した場合は古い code-server を停止して新しい env で起動し直す
    // (例: ANTHROPIC_API_KEY ローテーション後の最初のセッションで反映される)
    if (this.vsCodeServer?.isRunning) {
      logger.info(
        `[vscode-server] envVars changed since last code-server start; restarting`,
      )
      await this.vsCodeServer.stop()
      this.vsCodeServer = null
      this.wsProxy = null
    }

    try {
      this.vsCodeServer = new VsCodeServer({
        projectDir,
        envVarsOverride,
      })
      this.vsCodeServerEnvSignature = newEnvSignature
      await this.vsCodeServer.start()
      this.wsProxy = new VsCodeWsProxy(this.vsCodeServer.getPort())

      this.send({
        type: 'vscode_ready',
        sessionId,
        port: this.vsCodeServer.getPort(),
        projectDir,
      })
    } catch (error) {
      this.send({
        type: 'error',
        sessionId,
        message: `Failed to start code-server: ${getErrorMessage(error)}`,
      })
    }
  }

  private handleVsCodeClose(msg: VsCodeServerMessage): void {
    logger.info(`[vscode-ws] VS Code close requested (session=${msg.sessionId})`)
    this.cleanup()
    if (msg.sessionId) {
      this.send({ type: 'vscode_stopped', sessionId: msg.sessionId })
    }
  }

  private async handleHttpRequest(msg: VsCodeServerMessage): Promise<void> {
    // ポートフォワードセッションの場合はそちらのポートを使用
    const pfSession = this.getPortForwardSessionForMsg(msg)
    const targetPort = pfSession?.targetPort

    if (!targetPort && !this.vsCodeServer?.isRunning) {
      this.send({
        type: 'error',
        requestId: msg.requestId,
        message: 'code-server is not running',
      })
      return
    }

    if (!targetPort) {
      // vsCodeServer is guaranteed non-null here: the early-return guard above
      // (line: `if (!targetPort && !this.vsCodeServer?.isRunning)`) ensures we only
      // reach this point when vsCodeServer is running.
      this.vsCodeServer!.touch()
    }

    // vsCodeServer is guaranteed non-null when targetPort is absent:
    // the early-return guard above ensures vsCodeServer.isRunning when !targetPort.
    const port = targetPort ?? this.vsCodeServer!.getPort()

    try {
      const response = await proxyHttpRequest(port, {
        method: msg.method ?? 'GET',
        path: msg.path ?? '/',
        headers: msg.headers ?? {},
        body: msg.body,
      })

      this.sendHttpResponse(msg, response)
    } catch (error) {
      this.send({
        type: 'error',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        message: `HTTP proxy error: ${getErrorMessage(error)}`,
      })
    }
  }

  /**
   * レスポンスをチャンク分割して送信する。
   * ボディが HTTP_RESPONSE_CHUNK_SIZE 以下の場合は単一メッセージで送信する。
   */
  private sendHttpResponse(
    msg: VsCodeServerMessage,
    response: { statusCode: number; headers: Record<string, string>; body: string },
  ): void {
    // レスポンスボディが大きい場合はチャンク分割
    const bodyLength = response.body.length
    if (bodyLength > HTTP_RESPONSE_CHUNK_SIZE) {
      this.sendChunkedHttpResponse(msg, response)
    } else {
      this.send({
        type: 'http_response',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
      })
    }
  }

  /**
   * レスポンスボディを HTTP_RESPONSE_CHUNK_SIZE ごとに分割して複数メッセージで送信する。
   */
  private sendChunkedHttpResponse(
    msg: VsCodeServerMessage,
    response: { statusCode: number; headers: Record<string, string>; body: string },
  ): void {
    const bodyLength = response.body.length
    const totalChunks = Math.ceil(bodyLength / HTTP_RESPONSE_CHUNK_SIZE)
    for (let i = 0; i < totalChunks; i++) {
      const chunk = response.body.substring(
        i * HTTP_RESPONSE_CHUNK_SIZE,
        (i + 1) * HTTP_RESPONSE_CHUNK_SIZE,
      )
      this.send({
        type: 'http_response',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        statusCode: response.statusCode,
        headers: i === 0 ? response.headers : undefined,
        body: chunk,
        bodyChunkIndex: i,
        bodyChunkTotal: totalChunks,
      })
    }
  }

  private handleWsFrame(msg: VsCodeServerMessage): void {
    // ポートフォワードセッションの場合は専用wsProxyを使用
    const pfSession = this.getPortForwardSessionForMsg(msg)
    const proxy = pfSession?.wsProxy ?? this.wsProxy

    if (!pfSession && (!this.vsCodeServer?.isRunning || !this.wsProxy)) {
      return
    }
    if (!proxy) return

    if (!pfSession) {
      // vsCodeServer is guaranteed non-null here: the early-return guard above
      // (`if (!pfSession && (!this.vsCodeServer?.isRunning || !this.wsProxy))`)
      // ensures we only reach this point when vsCodeServer.isRunning is true.
      this.vsCodeServer!.touch()
    }
    const subSocketId = msg.subSocketId
    if (!subSocketId) return

    if (msg.isOpen && msg.path) {
      // 新しい WebSocket 接続を開く
      proxy.openConnection(
        subSocketId,
        msg.path,
        () => {
          this.send({
            type: 'ws_frame',
            sessionId: msg.sessionId,
            subSocketId,
            isOpen: true,
          })
        },
        (data) => {
          this.send({
            type: 'ws_frame',
            sessionId: msg.sessionId,
            subSocketId,
            data,
          })
        },
        () => {
          this.send({
            type: 'ws_frame',
            sessionId: msg.sessionId,
            subSocketId,
            isClosed: true,
          })
        },
      )
    } else if (msg.isClosed) {
      proxy.closeConnection(subSocketId)
    } else if (msg.data) {
      proxy.sendFrame(subSocketId, msg.data)
    }
  }

  private handlePortForwardOpen(msg: VsCodeServerMessage): void {
    const sessionId = msg.sessionId
    if (!sessionId) {
      this.sendMissingSessionIdError()
      return
    }

    if (!this.validateTenantCode(sessionId, msg.tenantCode)) return

    // MEDIUM: targetPort must be validated as an integer within the valid TCP
    // port range before being forwarded to `new VsCodeWsProxy(targetPort)`.
    // The previous truthy-only check (`!targetPort`) let any non-zero,
    // non-numeric, or out-of-range value (including negative numbers or
    // strings) through unchecked.
    const targetPort = Number(msg.targetPort)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      this.send({ type: 'error', sessionId, message: 'invalid targetPort' })
      return
    }

    const wsProxy = new VsCodeWsProxy(targetPort)
    this.portForwardSessions.set(sessionId, { targetPort, wsProxy })

    logger.info(`[vscode-ws] Port forward session opened: ${sessionId} → port ${targetPort}`)

    this.send({
      type: 'port_forward_ready',
      sessionId,
      targetPort,
    })
  }

  private handlePortForwardClose(msg: VsCodeServerMessage): void {
    const sessionId = msg.sessionId
    logger.info(`[vscode-ws] Port forward close requested (session=${sessionId})`)

    if (sessionId) {
      const pfSession = this.portForwardSessions.get(sessionId)
      if (pfSession) {
        pfSession.wsProxy.closeAll()
        this.portForwardSessions.delete(sessionId)
      }
      this.send({ type: 'port_forward_stopped', sessionId })
    }
  }

  // --- Browser handlers ---

  /**
   * Wire up browser session event listeners (action log, file chooser, focus
   * change) that relay in-process browser operations to the Web UI. Shared by
   * handleBrowserOpen (interactive browser_open) and openLiveViewSession
   * (E2E-dedicated session).
   */
  private wireBrowserSessionListeners(sessionId: string, session: BrowserSession): void {
    // Wire up action log notifications so in-process operations are relayed to Web UI
    session.actionLog.onChange = (entry) => {
      this.send({
        type: 'browser_action_log',
        sessionId,
        entries: [entry],
      })
    }

    // Wire up file chooser notifications to relay to Web UI
    session.onFileChooser = (accept) => {
      this.pendingFileChoosers.set(sessionId, accept)
      this.send({ type: 'browser_file_chooser_opened', sessionId })
    }

    // Wire up focus-change notifications so the Web client can overlay a real
    // input/textarea on the focused element (native caret + IME).
    session.onFocusChange = (payload) => {
      this.send({ type: 'browser_focus_changed', sessionId, ...payload })
    }
  }

  /**
   * Start live-view frame streaming for a session and notify the API that it
   * is ready to receive browser_frame messages. Shared by handleBrowserOpen
   * (interactive browser_open) and openLiveViewSession (E2E-dedicated
   * session). This is what makes the Web live-view preview start receiving
   * frames — without it, the preview stays stuck on "starting" forever even
   * though a browser session exists.
   */
  private async startLiveViewAndNotifyReady(
    sessionId: string,
    session: BrowserSession,
    conversationId?: string,
  ): Promise<void> {
    session.startLiveView(LIVE_VIEW_INTERVAL_MS, (base64) => {
      this.send({
        type: 'browser_frame',
        sessionId,
        body: base64,
        timestamp: Date.now(),
        currentUrl: session.getCurrentUrl(),
      })
    })

    const currentUrl = session.getCurrentUrl()
    const pageTitle = await session.getPageTitle()

    this.send({
      type: 'browser_ready',
      sessionId,
      conversationId,
      currentUrl,
      pageTitle,
    })
  }

  private async handleBrowserOpen(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) {
      this.sendMissingSessionIdError()
      return
    }

    if (!this.validateTenantCode(sessionId, msg.tenantCode)) return

    // Reset any stale cursor state for this sessionId on (re)open. The idle-timeout
    // auto-close path closes a session via BrowserSessionManager WITHOUT routing
    // through handleBrowserClose/cleanup, so lastSentCursor can survive a closed
    // session. If the same sessionId is later re-opened, a stale entry would make
    // the first mouse-move's cursor look "unchanged" and suppress the initial
    // browser_cursor_update, freezing the client cursor at the previous session's
    // last shape. Deleting here guarantees the first move after (re)open is sent.
    this.lastSentCursor.delete(sessionId)

    // Resume request: reuse an existing LIVE session for this sessionId and
    // immediately re-stream its current state. If no live session exists, reply
    // resume_failed so the Web client can fall back to a normal open. A failed
    // resume NEVER creates a new session (mirrors the Terminal resume contract).
    if (msg.resume === true) {
      const existing = this.browserSessionManager.get(sessionId)
      if (!existing || !existing.isAlive) {
        const reason: ResumeFailureReason = existing ? 'dead' : 'not_found'
        logger.warn(`[vscode-ws] Browser resume failed (session=${sessionId}): ${reason}`)
        this.send({ type: 'resume_failed', sessionId, reason })
        return
      }
    }

    try {
      const session = await this.browserSessionManager.getOrCreate(sessionId)

      // TOCTOU guard for resume: the live pre-check above (get + isAlive) and the
      // getOrCreate below straddle an await microtask boundary. An idle-timeout
      // close() that completes within that window leaves the now-closed session
      // lingering in the manager's Map, so getOrCreate can resolve a dead session.
      // Without this re-check, getPage() would launch a fresh browser and we'd
      // falsely report browser_ready (resume becoming a silent new-session open).
      // Re-confirm liveness and fail the resume instead of resurrecting it.
      if (msg.resume === true && !session.isAlive) {
        const reason: ResumeFailureReason = 'dead'
        logger.warn(`[vscode-ws] Browser resume failed (session=${sessionId}): ${reason}`)
        this.send({ type: 'resume_failed', sessionId, reason })
        return
      }

      this.wireBrowserSessionListeners(sessionId, session)

      if (msg.conversationId) {
        this.browserSessionManager.linkConversation(msg.conversationId, sessionId)
      }

      if (msg.resume === true) {
        // Resume: the existing page already holds the user's state. Never
        // navigate (that would discard it) — just ensure the page is live and
        // re-surface any focused field, then fall through to re-stream + ready.
        await session.getPage()
        await session.reportFocusNow()
      } else if (msg.url) {
        // Navigate to URL if provided
        const validation = validateUrl(msg.url)
        if (validation.valid) {
          const page = await session.getPage()
          await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: SELECTOR_TIMEOUT_NAVIGATION_MS })
          // Re-report focus on the freshly loaded document so an autofocused
          // field (e.g. a login form) surfaces its overlay caret without a
          // subsequent focus change. focusin only fires on focus CHANGES.
          await session.reportFocusNow()
        }
      } else {
        // Ensure page is initialized
        await session.getPage()
      }

      await this.startLiveViewAndNotifyReady(sessionId, session, msg.conversationId)

      logger.info(`[vscode-ws] Browser session opened: ${sessionId}`)
    } catch (error) {
      logger.error(`[vscode-ws] Failed to open browser session ${sessionId}: ${getErrorMessage(error)}`)
      this.send({
        type: 'browser_stopped',
        sessionId,
        reason: `Failed to open browser: ${getErrorMessage(error)}`,
        message: `Failed to open browser: ${getErrorMessage(error)}`,
      })
    }
  }

  /**
   * Start live-view streaming for a browser session without navigating
   * anywhere, wiring the same listeners and sending the same `browser_ready`
   * notification as an interactive `browser_open` (see handleBrowserOpen).
   *
   * Used by E2E test execution to make its dedicated browser session (created
   * via `browserSessionManager.getOrCreate` — see agent-transport.ts) start
   * relaying `browser_frame`/`browser_ready` to the Web live-view preview.
   * Without this, the E2E-dedicated session is only ever inserted into
   * BrowserSessionManager's Map and the Web preview stays stuck on "starting"
   * forever, since nothing ever calls session.startLiveView(...) or sends
   * browser_ready for it.
   *
   * Resume and conversationId linking are intentionally not handled here:
   * E2E execution always uses a fresh, dedicated session
   * (`e2e-${executionId}`) that is never resumed, and is not tied to a chat
   * conversation.
   *
   * On failure, a `browser_stopped` message is still sent (useful signal for
   * the Web UI), but the error is always re-thrown so callers (ultimately
   * agent-transport.ts's getOrCreateBrowserSession, then
   * e2e-test-executor.ts) see the rejection and can report it as a failed
   * execution instead of silently proceeding as if live view had started.
   */
  async openLiveViewSession(sessionId: string): Promise<void> {
    try {
      const session = await this.browserSessionManager.getOrCreate(sessionId)

      this.wireBrowserSessionListeners(sessionId, session)

      // Ensure page is initialized (no navigation — E2E steps navigate
      // explicitly via browser_navigate/script execution once frames start
      // streaming).
      await session.getPage()

      await this.startLiveViewAndNotifyReady(sessionId, session)

      logger.info(`[vscode-ws] Live view session started: ${sessionId}`)
    } catch (error) {
      logger.error(`[vscode-ws] Failed to start live view session ${sessionId}: ${getErrorMessage(error)}`)
      this.send({
        type: 'browser_stopped',
        sessionId,
        reason: `Failed to start live view: ${getErrorMessage(error)}`,
        message: `Failed to start live view: ${getErrorMessage(error)}`,
      })
      throw error
    }
  }

  private async handleBrowserClose(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const session = this.browserSessionManager.get(sessionId)
    if (session) {
      session.stopLiveView()
      await this.browserSessionManager.close(sessionId)
    }

    this.pendingFileChoosers.delete(sessionId)
    this.lastSentCursor.delete(sessionId)
    this.send({ type: 'browser_stopped', sessionId, reason: 'closed' })
    logger.info(`[vscode-ws] Browser session closed: ${sessionId}`)
  }

  private async handleBrowserNavigate(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId || !msg.url) return

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.sendBrowserSessionNotFoundError(sessionId)
      return
    }

    const validation = validateUrl(msg.url)
    if (!validation.valid) {
      this.send({ type: 'error', sessionId, message: validation.reason ?? 'Invalid URL' })
      return
    }

    try {
      const page = await session.getPage()
      await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: SELECTOR_TIMEOUT_NAVIGATION_MS })
      // Record the navigation BEFORE the focus re-report so the action-log entry
      // never depends on reportFocusNow succeeding (it already swallows its own
      // errors, but keeping the log independent guards against future changes).
      session.actionLog.add('direct', 'navigate', msg.url)
      // Re-report focus on the freshly loaded document so an autofocused field
      // surfaces its overlay caret (focusin only fires on focus CHANGES).
      await session.reportFocusNow()
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `Navigation failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserGoBack(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session) return
    try {
      await session.goBack()
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'goBack', error)
    }
  }

  private async handleBrowserGoForward(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session) return
    try {
      await session.goForward()
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'goForward', error)
    }
  }

  private async handleBrowserReload(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session) return
    try {
      await session.reload()
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'reload', error)
    }
  }

  private async handleBrowserMouseClick(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || msg.x === undefined || msg.y === undefined) return
    try {
      await session.executeMouseClick(msg.x, msg.y, msg.button, msg.clickCount)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'mouseClick', error)
    }
  }

  private async handleBrowserMouseMove(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    const session = this.getSessionForMsg(msg)
    if (!session || !sessionId || msg.x === undefined || msg.y === undefined) return
    try {
      await session.executeMouseMove(msg.x, msg.y)
    } catch (error) {
      // mouse_move is high-frequency and best-effort: a failed move (e.g. mid-drag
      // navigation) is intentionally logged but NOT surfaced as an `error` message
      // to the web client, to avoid error spam during drag-selection. Unlike
      // mouse_down / mouse_up, a dropped move does not leave the page in a broken state.
      logger.warn(`[vscode-ws] mouseMove failed (session=${sessionId}): ${getErrorMessage(error)}`)
      return
    }

    // Best-effort cursor-shape mirroring: read the CSS cursor at the point and,
    // only when it differs from the last value sent for this session, forward a
    // browser_cursor_update. A failed read is logged (not silently swallowed)
    // and skips the update for this frame rather than spamming an error message.
    let cursor: string
    try {
      cursor = await session.getCursorAt(msg.x, msg.y)
    } catch (error) {
      logger.warn(`[vscode-ws] getCursorAt failed (session=${sessionId}): ${getErrorMessage(error)}`)
      return
    }
    if (this.lastSentCursor.get(sessionId) !== cursor) {
      this.lastSentCursor.set(sessionId, cursor)
      this.send({ type: 'browser_cursor_update', sessionId, cursor })
    }
  }

  private async handleBrowserMouseDown(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || msg.x === undefined || msg.y === undefined) return
    try {
      await session.executeMouseDown(msg.x, msg.y, msg.button)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'mouseDown', error)
    }
  }

  private async handleBrowserMouseUp(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || msg.x === undefined || msg.y === undefined) return
    try {
      await session.executeMouseUp(msg.x, msg.y, msg.button)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'mouseUp', error)
    }
  }

  private async handleBrowserMouseWheel(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || msg.deltaX === undefined || msg.deltaY === undefined) return
    try {
      await session.executeMouseWheel(msg.deltaX, msg.deltaY)
    } catch (error) {
      logger.warn(`[vscode-ws] mouseWheel failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
    }
  }

  private async handleBrowserKeyboardType(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || !msg.text) return
    try {
      await session.executeKeyboardType(msg.text)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'keyboardType', error)
    }
  }

  private async handleBrowserKeyboardPress(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || !msg.key) return
    try {
      await session.executeKeyboardPress(msg.key, msg.modifiers)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'keyboardPress', error)
    }
  }

  private async handleBrowserScreenshot(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.sendBrowserSessionNotFoundError(sessionId)
      return
    }

    try {
      const buffer = await session.screenshot(true)
      const base64 = buffer.toString('base64')
      const currentUrl = session.getCurrentUrl()
      const pageTitle = await session.getPageTitle()

      this.send({
        type: 'browser_screenshot_result',
        sessionId,
        body: base64,
        currentUrl,
        pageTitle,
      })
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `Screenshot failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserGetSelection(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.sendBrowserSessionNotFoundError(sessionId)
      return
    }

    try {
      const text = await session.getSelectedText()
      this.send({ type: 'browser_selection_result', sessionId, text })
    } catch (error) {
      this.reportActionFailure(sessionId, 'getSelection', error)
    }
  }

  private async handleBrowserSetInputValue(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session) return
    // The contract requires `value` to be a string; ignore malformed payloads.
    if (typeof msg.value !== 'string') return
    try {
      await session.setFocusedInputValue(msg.value, msg.selectionStart, msg.selectionEnd)
    } catch (error) {
      this.reportActionFailure(msg.sessionId, 'setInputValue', error)
    }
  }

  private async handleBrowserExecuteScript(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId || !msg.script) {
      this.send({ type: 'error', sessionId, message: 'Missing sessionId or script' })
      return
    }

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.sendBrowserSessionNotFoundError(sessionId)
      return
    }

    try {
      const result = await executePlaywrightScript(session, msg.script, (step, total, line) => {
        this.send({
          type: 'browser_script_progress',
          sessionId,
          step,
          totalSteps: total,
          line,
        })
      })

      this.send({
        type: 'browser_script_result',
        sessionId,
        success: result.success,
        completedSteps: result.completedSteps,
        totalSteps: result.totalSteps,
        results: result.results,
        failedLine: result.failedLine,
        fallbackToChat: result.fallbackToChat,
      })
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `Script execution failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserViewport(msg: VsCodeServerMessage): Promise<void> {
    const session = this.getSessionForMsg(msg)
    if (!session || !msg.width || !msg.height) return
    try {
      await session.setViewport(msg.width, msg.height, msg.deviceId)
    } catch (error) {
      logger.warn(`[vscode-ws] setViewport failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
    }
  }

  private async handleBrowserSetFile(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const accept = this.pendingFileChoosers.get(sessionId)
    if (!accept) {
      this.send({ type: 'error', sessionId, message: 'No pending file chooser for this session' })
      return
    }
    // Consume the pending chooser up-front so it is not left dangling on any path.
    this.pendingFileChoosers.delete(sessionId)

    // Outermost guard: any unexpected error (malformed payload, FS failure, a
    // throwing `accept`) MUST surface as an `error` notification AND cancel the
    // chooser, never escape as an unhandled rejection that leaves the remote
    // `<input type=file>` stuck waiting. Each branch below already cancels on
    // its own validation failures; this catch is the final backstop so a
    // non-string filePath element, a non-array `files`, etc. cannot wedge the
    // chooser.
    try {
      if (msg.files === undefined && msg.filePaths !== undefined) {
        await this.handleBrowserSetFileByPaths(sessionId, accept, msg.filePaths)
        return
      }
      await this.handleBrowserSetFileByContent(sessionId, accept, msg.files)
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `File upload failed: ${getErrorMessage(error)}` })
      await this.cancelFileChooser(accept, sessionId)
    }
  }

  /**
   * Branch 1: Agent FS paths chosen directly by the user via the workspace file
   * explorer. These arrive as workspace-relative paths (e.g. `repos/app.ts`) —
   * Playwright's setFiles requires absolute paths, so each is resolved against
   * the workspace root before being forwarded. Already absolute paths are
   * accepted as-is for backward compatibility, but every resolved path must
   * stay inside the workspace root (traversal + symlink-escape guard).
   */
  private async handleBrowserSetFileByPaths(
    sessionId: string,
    accept: (files: FileChooserPayload) => Promise<void>,
    filePaths: unknown,
  ): Promise<void> {
    // Explicit input validation (do not rely on a thrown TypeError): the payload
    // must be an array of strings. Anything else is rejected + chooser cancelled.
    if (!Array.isArray(filePaths) || filePaths.some((p) => typeof p !== 'string')) {
      this.send({
        type: 'error',
        sessionId,
        message: 'Invalid file payload: filePaths must be an array of strings',
      })
      await this.cancelFileChooser(accept, sessionId)
      return
    }

    const resolved = await this.resolveWorkspaceFilePaths(filePaths as string[])
    if (typeof resolved === 'string') {
      // Resolution rejected the upload (escape attempt / missing workspace /
      // symlink pointing outside). Surface the reason and cancel the chooser so
      // the remote input is not left pending.
      this.send({ type: 'error', sessionId, message: resolved })
      await this.cancelFileChooser(accept, sessionId)
      return
    }
    try {
      await accept(resolved)
    } catch (error) {
      // Symmetry with the base64 branch: when setFiles rejects, surface the
      // error AND cancel the chooser so the remote input is not left pending.
      this.send({ type: 'error', sessionId, message: `File upload failed: ${getErrorMessage(error)}` })
      await this.cancelFileChooser(accept, sessionId)
    }
  }

  /**
   * Branch 2: base64 file contents uploaded from the web client.
   *
   * Decodes each file into an in-memory Buffer and passes the buffer objects
   * directly to Playwright's FileChooser.setFiles(). Playwright supports the
   * {name, mimeType, buffer} payload form and sends file content to the browser
   * via CDP without writing anything to the agent file system.
   *
   * This avoids the race condition that exists when temp files are used:
   * setFiles() resolves as soon as the CDP command is acknowledged, but the
   * browser reads the file from disk *after* that point. Deleting temp files in
   * a finally block immediately after accept() resolves therefore causes the
   * browser to see a "file not found" error when it tries to read the file.
   */
  private async handleBrowserSetFileByContent(
    sessionId: string,
    accept: (files: FileChooserPayload) => Promise<void>,
    rawFiles: unknown,
  ): Promise<void> {
    // Explicit input validation (do not rely on a thrown TypeError): `files`
    // must be an array, and every entry must carry a string `dataBase64`.
    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      this.send({ type: 'error', sessionId, message: 'Invalid file payload: files must be an array' })
      await this.cancelFileChooser(accept, sessionId)
      return
    }
    const files = (rawFiles ?? []) as Array<{ name?: unknown; mimeType?: unknown; dataBase64?: unknown }>

    // Validate every entry has a string dataBase64 before decoding so we never
    // pass undefined / non-string into Buffer.from.
    if (files.some((f) => typeof f?.dataBase64 !== 'string')) {
      this.send({ type: 'error', sessionId, message: 'Invalid file payload: dataBase64 must be a string' })
      // Cancel the remote input so it is not left pending/half-filled.
      await this.cancelFileChooser(accept, sessionId)
      return
    }
    const safeFiles = files as Array<{ name?: unknown; mimeType?: unknown; dataBase64: string }>

    // Estimate decoded size from base64 length and enforce the authoritative limit
    // before allocating buffers.
    const totalBytes = safeFiles.reduce((sum, f) => sum + Math.floor((f.dataBase64.length * 3) / 4), 0)
    if (totalBytes > MAX_UPLOAD_BYTES) {
      this.send({ type: 'error', sessionId, message: 'File too large (max 10MB)' })
      await this.cancelFileChooser(accept, sessionId)
      return
    }

    try {
      const payload: Array<{ name: string; mimeType: string; buffer: Buffer }> = safeFiles.map((file) => ({
        name: sanitizeUploadFileName(file.name),
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
        buffer: Buffer.from(file.dataBase64, 'base64'),
      }))
      await accept(payload)
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `File upload failed: ${getErrorMessage(error)}` })
      await this.cancelFileChooser(accept, sessionId)
    }
  }

  /**
   * Resolve user-chosen file-explorer paths into absolute paths suitable for
   * Playwright's `setFiles`, enforcing that every resolved path stays inside
   * the agent workspace root.
   *
   * Resolution rules per path:
   *  - Absolute paths are kept as-is (backward compatibility for callers that
   *    already send absolute agent-FS paths).
   *  - Relative paths (e.g. `repos/app.ts`) are resolved against the workspace
   *    directory (`this.workspaceDir` = `<projectDir>/workspace`).
   *
   * Traversal guard (lexical): after resolution, the absolute path must be the
   * workspace root itself or a descendant of it. `path.relative(workspaceDir,
   * resolved)` starting with `..` (or being absolute) means the path escaped the
   * workspace and is rejected. This rejects both relative escapes
   * (`../../etc/passwd`) and absolute paths pointing outside the workspace.
   *
   * Symlink-escape guard (physical): a path that is lexically inside the
   * workspace may still resolve, through a symlink, to a target OUTSIDE it
   * (e.g. a `link` inside the workspace pointing at `../../.ssh/id_rsa`). After
   * the lexical check, each existing path's real (canonical) location is
   * resolved via `fs.realpath` and re-checked against the workspace root. Paths
   * whose real location escapes the workspace are rejected. Non-existent paths
   * cannot be canonicalized; they are left as-is (Playwright's setFiles will
   * fail on them) rather than rejected here, preserving the lexical guarantee.
   *
   * Returns the resolved absolute paths on success, or an error message string
   * describing why the upload was rejected (never silently dropped).
   */
  private async resolveWorkspaceFilePaths(filePaths: string[]): Promise<string[] | string> {
    // A workspace root is required to both resolve relative paths and to bound
    // absolute ones. Without it we cannot safely accept any file-explorer path.
    // NOTE: use `this.workspaceDir` (= <projectDir>/workspace) directly — it is
    // the same root the file picker lists against. Deriving it from
    // `this.projectDir` (which holds reposDir = <projectDir>/workspace/repos) via
    // getWorkspaceDir() would yield <projectDir>/workspace/repos/workspace, a
    // non-existent path, so every selection would resolve to a missing file and
    // setFiles would silently reject it ("nothing happens").
    if (!this.workspaceDir) {
      return 'Cannot resolve file paths: no workspace directory configured for this agent'
    }
    const workspaceDir = path.resolve(this.workspaceDir)
    // Canonicalize the workspace root too, so a symlinked workspace dir does not
    // produce false positives when comparing against realpath'd children.
    const realWorkspaceDir = await fs.realpath(workspaceDir).catch(() => workspaceDir)

    const isInside = (root: string, target: string): boolean => {
      const rel = path.relative(root, target)
      // Inside when the relative path stays under root: not climbing out (`..`)
      // and not forced absolute (different root/drive). An empty `rel` means the
      // path IS the root, which is allowed.
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    }

    const resolved: string[] = []
    for (const filePath of filePaths) {
      const absolute = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(workspaceDir, filePath)
      // Lexical guard first (cheap, also covers non-existent paths).
      if (!isInside(workspaceDir, absolute)) {
        return `Access denied: file path is outside the workspace: ${filePath}`
      }
      // Physical guard: resolve symlinks and re-check. Missing paths cannot be
      // canonicalized — keep the lexically-validated absolute path (setFiles
      // will surface the non-existence downstream).
      const real = await fs.realpath(absolute).catch(() => null)
      if (real !== null && !isInside(realWorkspaceDir, real)) {
        return `Access denied: file path is outside the workspace: ${filePath}`
      }
      resolved.push(absolute)
    }
    return resolved
  }

  /**
   * Cancel a pending file chooser by applying an empty file list so the remote
   * `<input type=file>` is cleared rather than left pending. Failures are
   * swallowed (best-effort) since the user has already been told why the upload
   * was rejected.
   */
  private async cancelFileChooser(
    accept: (files: FileChooserPayload) => Promise<void>,
    sessionId: string,
  ): Promise<void> {
    try {
      await accept([])
    } catch (error) {
      logger.warn(`[vscode-ws] cancel file chooser failed (session=${sessionId}): ${getErrorMessage(error)}`)
    }
  }

  private cleanup(): void {
    // ブラウザセッションのクリーンアップ
    void this.browserSessionManager.closeAll()
    this.pendingFileChoosers.clear()
    this.lastSentCursor.clear()

    // ブラウザローカルサーバーのクリーンアップ
    if (this.browserLocalServer) {
      void this.browserLocalServer.stop()
      this.browserLocalServer = null
      this.browserLocalPort = 0
    }

    // ポートフォワードセッションのクリーンアップ
    for (const [, pfSession] of this.portForwardSessions) {
      pfSession.wsProxy.closeAll()
    }
    this.portForwardSessions.clear()

    if (this.wsProxy) {
      this.wsProxy.closeAll()
      this.wsProxy = null
    }
    if (this.vsCodeServer) {
      this.vsCodeServer.stop()
      this.vsCodeServer = null
    }
  }

  /**
   * Resolve a value from a sessionId-keyed lookup using a message's
   * sessionId, or undefined when sessionId is absent or unregistered.
   * Shared by `getSessionForMsg` (browserSessionManager) and the
   * port-forward session lookups (portForwardSessions) below.
   */
  private resolveForMsg<T>(
    msg: { sessionId?: string },
    resolve: (sessionId: string) => T | undefined,
  ): T | undefined {
    return msg.sessionId ? resolve(msg.sessionId) : undefined
  }

  /**
   * Resolve the BrowserSession for a message's sessionId, or undefined when
   * sessionId is absent or no session is registered for it. Shared by the
   * best-effort browser action handlers (goBack/mouseClick/keyboard/etc.)
   * that silently no-op rather than replying with a "session not found" error.
   */
  private getSessionForMsg(msg: { sessionId?: string }): BrowserSession | undefined {
    return this.resolveForMsg(msg, (sessionId) => this.browserSessionManager.get(sessionId))
  }

  /**
   * Resolve the port-forward session for a message's sessionId, or undefined
   * when sessionId is absent or no port-forward session is registered for it.
   */
  private getPortForwardSessionForMsg(
    msg: { sessionId?: string },
  ): { targetPort: number; wsProxy: VsCodeWsProxy } | undefined {
    return this.resolveForMsg(msg, (sessionId) => this.portForwardSessions.get(sessionId))
  }

  private sendMissingSessionIdError(): void {
    this.send({ type: 'error', message: 'Missing sessionId' })
  }

  /**
   * MEDIUM defense-in-depth: verify a message's `tenantCode` (when present)
   * against this connection's own trusted tenant code (`this.tenantCode`,
   * fixed at construction time). Per CLAUDE.md's WebSocket tenant-isolation
   * rule, `vscode_open`/`port_forward_open`/`browser_open` messages should
   * carry `tenantCode` so a mismatch (server bug, misrouted relay, or a
   * compromised path upstream) can be caught here rather than silently
   * acting for the wrong tenant.
   *
   * Intentionally NOT enforced (returns true) when either side is absent:
   *  - `msgTenantCode` absent: backward compatible with callers/API versions
   *    that do not yet send it.
   *  - `this.tenantCode` absent: this connection has no established baseline
   *    to compare against (nothing to validate).
   * Sends a `tenant mismatch` error and returns false on a genuine mismatch.
   */
  private validateTenantCode(sessionId: string | undefined, msgTenantCode: string | undefined): boolean {
    if (!msgTenantCode || !this.tenantCode) return true
    if (msgTenantCode !== this.tenantCode) {
      logger.warn(
        `[vscode-ws] tenantCode mismatch (session=${sessionId ?? 'none'}): expected=${this.tenantCode} received=${msgTenantCode}`,
      )
      this.send({ type: 'error', sessionId, message: 'tenant mismatch' })
      return false
    }
    return true
  }

  private sendBrowserSessionNotFoundError(sessionId: string): void {
    this.send({ type: 'error', sessionId, message: 'Browser session not found' })
  }

  /**
   * Walk up from `candidate` toward the filesystem root and return the
   * deepest path segment that actually exists on disk.
   *
   * Used for symlink-aware containment checks: `fs.realpath` on a path whose
   * leaf does not exist yet rejects outright, which would skip validation of
   * any intermediate symlink. Finding the deepest *existing* ancestor first
   * lets the caller canonicalize that instead — any symlink placed anywhere
   * along the path is necessarily part of an existing ancestor, so this
   * always surfaces it regardless of whether the final leaf exists.
   */
  private async findDeepestExistingAncestor(candidate: string): Promise<string> {
    let current = candidate
    for (;;) {
      try {
        await fs.access(current)
        return current
      } catch {
        const parent = path.dirname(current)
        if (parent === current) return current
        current = parent
      }
    }
  }

  /**
   * Shared failure path for the best-effort browser action handlers
   * (goBack/mouseClick/keyboard/etc.): log a warning and forward an `error`
   * message to the web client using a consistent `"<action> failed: <detail>"`
   * shape. Not used by handlers that intentionally suppress the client-facing
   * error (e.g. mouseMove, mouseWheel) — those log directly.
   */
  private reportActionFailure(sessionId: string | undefined, action: string, error: unknown): void {
    const detail = getErrorMessage(error)
    logger.warn(`[vscode-ws] ${action} failed (session=${sessionId}): ${detail}`)
    this.send({ type: 'error', sessionId, message: `${action} failed: ${detail}` })
  }

  private send(msg: VsCodeAgentMessage): void {
    this.sendMessage(msg)
  }
}

/**
 * envVars マップを安定文字列に変換する。
 * code-server の env に変化があったかの差分判定に使う。
 */
function computeEnvSignature(envVars: Record<string, string> | undefined): string {
  if (!envVars) return ''
  const keys = Object.keys(envVars).sort()
  return keys.map((k) => `${k}=${envVars[k]}`).join('\n')
}
