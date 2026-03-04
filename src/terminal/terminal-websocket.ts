import WebSocket from 'ws'

import { logger } from '../logger'
import { calculateBackoff } from '../retry-strategy'
import { getErrorMessage } from '../utils'

import {
  TERMINAL_WS_MAX_RECONNECT_RETRIES,
  TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
} from './constants'
import { TerminalSessionManager } from './terminal-session'

/**
 * Messages sent from API server to agent
 */
export interface TerminalServerMessage {
  type: 'open' | 'stdin' | 'resize' | 'close'
  sessionId?: string
  data?: string // Base64 encoded for stdin
  cols?: number
  rows?: number
  cwd?: string
}

/**
 * Messages sent from agent to API server
 */
export interface TerminalAgentMessage {
  type: 'ready' | 'stdout' | 'exit' | 'error'
  sessionId: string
  data?: string // Base64 encoded for stdout
  code?: number | null
  error?: string
  pid?: number
  cols?: number
  rows?: number
}

export class TerminalWebSocket {
  private ws: WebSocket | null = null
  private readonly manager: TerminalSessionManager
  private reconnectAttempts = 0
  private closed = false
  private readonly wsUrl: string

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly projectDir?: string,
  ) {
    this.manager = new TerminalSessionManager()
    // Convert http(s) URL to ws(s) URL
    this.wsUrl = apiUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/ws/agent-terminal'
  }

  connect(): Promise<void> {
    this.closed = false
    this.reconnectAttempts = 0
    return this.doConnect()
  }

  disconnect(): void {
    this.closed = true
    this.manager.closeAll()
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CLOSING) {
        this.ws.close()
      } else {
        this.ws.terminate()
      }
      this.ws = null
    }
  }

  getSessionManager(): TerminalSessionManager {
    return this.manager
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Agent-Id': this.agentId,
        },
      })

      ws.on('open', () => {
        logger.info('[terminal-ws] Connected to terminal WebSocket')
        this.reconnectAttempts = 0
        resolve()
      })

      ws.on('message', (data: WebSocket.Data) => {
        let msg: TerminalServerMessage
        try {
          msg = JSON.parse(data.toString()) as TerminalServerMessage
        } catch {
          logger.debug('[terminal-ws] Failed to parse message')
          return
        }
        this.handleMessage(msg)
      })

      ws.on('error', (error: Error) => {
        logger.debug(`[terminal-ws] WebSocket error: ${getErrorMessage(error)}`)
        if (this.reconnectAttempts === 0 && !this.ws) {
          reject(error)
        }
      })

      ws.on('close', () => {
        if (!this.closed) {
          logger.info('[terminal-ws] Connection closed, attempting reconnect...')
          void this.attemptReconnect()
        }
      })

      this.ws = ws
    })
  }

  private handleMessage(msg: TerminalServerMessage): void {
    switch (msg.type) {
      case 'open':
        this.handleOpen(msg)
        break
      case 'stdin':
        this.handleStdin(msg)
        break
      case 'resize':
        this.handleResize(msg)
        break
      case 'close':
        this.handleClose(msg)
        break
      default:
        logger.debug(`[terminal-ws] Unknown message type: ${(msg as { type: string }).type}`)
    }
  }

  private handleOpen(msg: TerminalServerMessage): void {
    const session = this.manager.createSession({
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd ?? this.projectDir,
    })

    if (!session) {
      this.send({
        type: 'error',
        sessionId: msg.sessionId ?? 'unknown',
        error: `Maximum concurrent sessions (${this.manager.size}) reached`,
      })
      return
    }

    session.onData((data) => {
      this.send({
        type: 'stdout',
        sessionId: session.sessionId,
        data: Buffer.from(data).toString('base64'),
      })
    })

    session.onExit((code) => {
      this.send({
        type: 'exit',
        sessionId: session.sessionId,
        code,
      })
    })

    this.send({
      type: 'ready',
      sessionId: session.sessionId,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
    })

    logger.debug(`[terminal-ws] Session opened: ${session.sessionId} (pid=${session.pid})`)
  }

  private handleStdin(msg: TerminalServerMessage): void {
    if (!msg.sessionId || !msg.data) return
    const session = this.manager.getSession(msg.sessionId)
    if (!session) {
      this.send({
        type: 'error',
        sessionId: msg.sessionId,
        error: 'Session not found',
      })
      return
    }
    const decoded = Buffer.from(msg.data, 'base64').toString('utf-8')
    session.write(decoded)
  }

  private handleResize(msg: TerminalServerMessage): void {
    if (!msg.sessionId) return
    const session = this.manager.getSession(msg.sessionId)
    if (!session) return
    if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      session.resize(msg.cols, msg.rows)
    }
  }

  private handleClose(msg: TerminalServerMessage): void {
    if (!msg.sessionId) return
    this.manager.closeSession(msg.sessionId)
    logger.debug(`[terminal-ws] Session closed: ${msg.sessionId}`)
  }

  private send(msg: TerminalAgentMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (error) {
      logger.debug(`[terminal-ws] Send error: ${getErrorMessage(error)}`)
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.reconnectAttempts >= TERMINAL_WS_MAX_RECONNECT_RETRIES) {
      if (this.reconnectAttempts >= TERMINAL_WS_MAX_RECONNECT_RETRIES) {
        logger.error('[terminal-ws] Max reconnect attempts reached')
      }
      return
    }

    this.reconnectAttempts++
    const delay = calculateBackoff({
      baseDelayMs: TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
      attempt: this.reconnectAttempts - 1,
      jitter: false,
    })
    logger.info(`[terminal-ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${TERMINAL_WS_MAX_RECONNECT_RETRIES})`)

    await new Promise<void>((resolve) => setTimeout(resolve, delay))

    if (this.closed) return

    try {
      await this.doConnect()
      logger.info('[terminal-ws] Reconnected successfully')
    } catch (error) {
      logger.warn(`[terminal-ws] Reconnect failed: ${getErrorMessage(error)}`)
      void this.attemptReconnect()
    }
  }
}
