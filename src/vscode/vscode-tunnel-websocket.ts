import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { logger } from '../logger'
import { getErrorMessage, buildWsUrl } from '../utils'

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
    | 'http_request'
    | 'ws_frame'
    | 'auth_success'
    | 'error'
  sessionId?: string
  requestId?: string
  subSocketId?: string
  projectDir?: string
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  data?: string
  isOpen?: boolean
  isClosed?: boolean
  message?: string
}

/**
 * Agent → API Server メッセージ
 */
export interface VsCodeAgentMessage {
  type:
    | 'vscode_ready'
    | 'vscode_stopped'
    | 'http_response'
    | 'ws_frame'
    | 'error'
  sessionId?: string
  requestId?: string
  subSocketId?: string
  port?: number
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  bodyChunkIndex?: number
  bodyChunkTotal?: number
  data?: string
  isOpen?: boolean
  isClosed?: boolean
  message?: string
}

/**
 * VS Code トンネル WebSocket
 *
 * TerminalWebSocket と同じパターンで BaseWebSocketConnection を継承し、
 * API Server とのトンネル WebSocket 経由で code-server へのアクセスを提供する。
 */
export class VsCodeTunnelWebSocket extends BaseWebSocketConnection<VsCodeServerMessage> {
  private readonly wsUrl: string
  private vsCodeServer: VsCodeServer | null = null
  private wsProxy: VsCodeWsProxy | null = null

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

  protected createWebSocket(): WebSocket {
    return new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Agent-Id': this.agentId,
      },
    })
  }

  protected onOpen(_ws: WebSocket, resolve: (value: void) => void): void {
    logger.info('[vscode-ws] Connected to VS Code tunnel WebSocket')
    this.reconnectAttemptsRef.current = 0
    resolve()
  }

  protected onParsedMessage(msg: VsCodeServerMessage): void {
    switch (msg.type) {
      case 'vscode_open':
        this.handleVsCodeOpen(msg)
        break
      case 'vscode_close':
        this.handleVsCodeClose(msg)
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
      default:
        logger.debug(`[vscode-ws] Unknown message type: ${(msg as { type: string }).type}`)
    }
  }

  protected onDisconnect(): void {
    this.cleanup()
  }

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
    if (!this.vsCodeServer?.isRunning) {
      this.send({
        type: 'error',
        requestId: msg.requestId,
        message: 'code-server is not running',
      })
      return
    }

    this.vsCodeServer.touch()

    try {
      const response = await proxyHttpRequest(this.vsCodeServer.getPort(), {
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
    if (!this.vsCodeServer?.isRunning || !this.wsProxy) {
      return
    }

    this.vsCodeServer.touch()
    const subSocketId = msg.subSocketId
    if (!subSocketId) return

    if (msg.isOpen && msg.path) {
      // 新しい WebSocket 接続を開く
      this.wsProxy.openConnection(
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
      this.wsProxy.closeConnection(subSocketId)
    } else if (msg.data) {
      this.wsProxy.sendFrame(subSocketId, msg.data)
    }
  }

  private cleanup(): void {
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
