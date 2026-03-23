import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { BrowserLocalServer } from '../browser/browser-local-server'
import { logger } from '../logger'
import { getErrorMessage, buildWsUrl } from '../utils'
import { BrowserSessionManager } from '../mcp/tools/browser/browser-session-manager'
import { validateUrl } from '../mcp/tools/browser/browser-security'

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
    | 'browser_mouse_wheel'
    | 'browser_keyboard_type'
    | 'browser_keyboard_press'
    | 'browser_screenshot'
    | 'browser_viewport'
  sessionId?: string
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
}

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
    | 'browser_action_log'
    | 'browser_stopped'
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
  timestamp?: number
  reason?: string
  entries?: Array<{ timestamp: number; source: string; action: string; details: string }>
}

/** Live view frame interval in milliseconds (5 FPS) */
const LIVE_VIEW_INTERVAL_MS = 200

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
  private wsProxy: VsCodeWsProxy | null = null
  private readonly portForwardSessions = new Map<string, { targetPort: number; wsProxy: VsCodeWsProxy }>()
  readonly browserSessionManager = new BrowserSessionManager()
  private browserLocalServer: BrowserLocalServer | null = null
  private browserLocalPort = 0

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly projectDir?: string,
  ) {
    super({
      maxReconnectRetries: VSCODE_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: VSCODE_WS_RECONNECT_BASE_DELAY_MS,
      logPrefix: '[vscode-ws]',
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
    return new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Agent-Id': this.agentId,
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
      this.browserLocalServer = new BrowserLocalServer(this.browserSessionManager)
      // Forward action log entries from chat-initiated operations to the Web UI
      this.browserLocalServer.onActionLog = (notification) => {
        this.send({
          type: 'browser_action_log',
          sessionId: notification.sessionId,
          entries: [notification.entry],
        })
      }
      this.browserLocalServerStartPromise = this.browserLocalServer.start()
        .then((port) => {
          this.browserLocalPort = port
          logger.info(`[vscode-ws] Browser local server started on port ${port}`)
        })
        .catch((err) => {
          logger.error(`[vscode-ws] Failed to start browser local server: ${getErrorMessage(err)}`)
        })
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
      default:
        logger.debug(`[vscode-ws] Unknown message type: ${(msg as { type: string }).type}`)
    }
  }

  protected onDisconnect(): void {
    this.cleanup()
  }

  // --- VS Code handlers ---

  private async handleVsCodeOpen(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) {
      this.send({ type: 'error', message: 'Missing sessionId' })
      return
    }

    const projectDir = msg.projectDir ?? this.projectDir
    if (!projectDir) {
      this.send({ type: 'error', sessionId, message: 'No project directory' })
      return
    }

    // 既存のサーバーがあれば再利用
    if (this.vsCodeServer?.isRunning) {
      this.vsCodeServer.touch()
      this.send({
        type: 'vscode_ready',
        sessionId,
        port: this.vsCodeServer.getPort(),
        projectDir,
      })
      return
    }

    try {
      this.vsCodeServer = new VsCodeServer({ projectDir })
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
    const pfSession = msg.sessionId ? this.portForwardSessions.get(msg.sessionId) : undefined
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
      this.vsCodeServer!.touch()
    }

    const port = targetPort ?? this.vsCodeServer!.getPort()

    try {
      const response = await proxyHttpRequest(port, {
        method: msg.method ?? 'GET',
        path: msg.path ?? '/',
        headers: msg.headers ?? {},
        body: msg.body,
      })

      // レスポンスボディが大きい場合はチャンク分割
      const bodyLength = response.body.length
      if (bodyLength > HTTP_RESPONSE_CHUNK_SIZE) {
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
    } catch (error) {
      this.send({
        type: 'error',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        message: `HTTP proxy error: ${getErrorMessage(error)}`,
      })
    }
  }

  private handleWsFrame(msg: VsCodeServerMessage): void {
    // ポートフォワードセッションの場合は専用wsProxyを使用
    const pfSession = msg.sessionId ? this.portForwardSessions.get(msg.sessionId) : undefined
    const proxy = pfSession?.wsProxy ?? this.wsProxy

    if (!pfSession && (!this.vsCodeServer?.isRunning || !this.wsProxy)) {
      return
    }
    if (!proxy) return

    if (!pfSession) {
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
      this.send({ type: 'error', message: 'Missing sessionId' })
      return
    }

    const targetPort = msg.targetPort
    if (!targetPort) {
      this.send({ type: 'error', sessionId, message: 'Missing targetPort' })
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

  private async handleBrowserOpen(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) {
      this.send({ type: 'error', message: 'Missing sessionId' })
      return
    }

    try {
      const session = await this.browserSessionManager.getOrCreate(sessionId)

      if (msg.conversationId) {
        this.browserSessionManager.linkConversation(msg.conversationId, sessionId)
      }

      // Navigate to URL if provided
      if (msg.url) {
        const validation = validateUrl(msg.url)
        if (validation.valid) {
          const page = await session.getPage()
          await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        }
      } else {
        // Ensure page is initialized
        await session.getPage()
      }

      // Start live view streaming
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
        conversationId: msg.conversationId,
        currentUrl,
        pageTitle,
      })

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

  private async handleBrowserClose(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const session = this.browserSessionManager.get(sessionId)
    if (session) {
      session.stopLiveView()
      await this.browserSessionManager.close(sessionId)
    }

    this.send({ type: 'browser_stopped', sessionId, reason: 'closed' })
    logger.info(`[vscode-ws] Browser session closed: ${sessionId}`)
  }

  private async handleBrowserNavigate(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId || !msg.url) return

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.send({ type: 'error', sessionId, message: 'Browser session not found' })
      return
    }

    const validation = validateUrl(msg.url)
    if (!validation.valid) {
      this.send({ type: 'error', sessionId, message: validation.reason ?? 'Invalid URL' })
      return
    }

    try {
      const page = await session.getPage()
      await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      session.actionLog.add('direct', 'navigate', msg.url)
    } catch (error) {
      this.send({ type: 'error', sessionId, message: `Navigation failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserGoBack(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session) return
    try {
      await session.goBack()
    } catch (error) {
      logger.warn(`[vscode-ws] goBack failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `goBack failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserGoForward(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session) return
    try {
      await session.goForward()
    } catch (error) {
      logger.warn(`[vscode-ws] goForward failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `goForward failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserReload(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session) return
    try {
      await session.reload()
    } catch (error) {
      logger.warn(`[vscode-ws] reload failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `reload failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserMouseClick(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session || msg.x === undefined || msg.y === undefined) return
    try {
      await session.executeMouseClick(msg.x, msg.y, msg.button, msg.clickCount)
    } catch (error) {
      logger.warn(`[vscode-ws] mouseClick failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `mouseClick failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserMouseWheel(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session || msg.deltaX === undefined || msg.deltaY === undefined) return
    try {
      await session.executeMouseWheel(msg.deltaX, msg.deltaY)
    } catch (error) {
      logger.warn(`[vscode-ws] mouseWheel failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
    }
  }

  private async handleBrowserKeyboardType(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session || !msg.text) return
    try {
      await session.executeKeyboardType(msg.text)
    } catch (error) {
      logger.warn(`[vscode-ws] keyboardType failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `keyboardType failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserKeyboardPress(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session || !msg.key) return
    try {
      await session.executeKeyboardPress(msg.key, msg.modifiers)
    } catch (error) {
      logger.warn(`[vscode-ws] keyboardPress failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
      this.send({ type: 'error', sessionId: msg.sessionId, message: `keyboardPress failed: ${getErrorMessage(error)}` })
    }
  }

  private async handleBrowserScreenshot(msg: VsCodeServerMessage): Promise<void> {
    const sessionId = msg.sessionId
    if (!sessionId) return

    const session = this.browserSessionManager.get(sessionId)
    if (!session) {
      this.send({ type: 'error', sessionId, message: 'Browser session not found' })
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

  private async handleBrowserViewport(msg: VsCodeServerMessage): Promise<void> {
    const session = msg.sessionId ? this.browserSessionManager.get(msg.sessionId) : undefined
    if (!session || !msg.width || !msg.height) return
    try {
      await session.setViewport(msg.width, msg.height)
    } catch (error) {
      logger.warn(`[vscode-ws] setViewport failed (session=${msg.sessionId}): ${getErrorMessage(error)}`)
    }
  }

  private cleanup(): void {
    // ブラウザセッションのクリーンアップ
    void this.browserSessionManager.closeAll()

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

  private send(msg: VsCodeAgentMessage): void {
    this.sendMessage(msg)
  }
}
