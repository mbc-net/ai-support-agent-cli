import * as path from 'path'

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { logger } from '../logger'
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
  type: 'open' | 'stdin' | 'resize' | 'close' | 'auth_success' | 'error'
  sessionId?: string
  data?: string // Base64 encoded for stdin
  cols?: number
  rows?: number
  cwd?: string
  message?: string
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

export class TerminalWebSocket extends BaseWebSocketConnection<TerminalServerMessage> {
  private readonly manager: TerminalSessionManager
  private readonly wsUrl: string

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly projectDir?: string,
  ) {
    super({
      maxReconnectRetries: TERMINAL_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
      logPrefix: '[terminal-ws]',
    })
    this.manager = new TerminalSessionManager()
    // Convert http(s) URL to ws(s) URL
    this.wsUrl = apiUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/ws/agent-terminal'
  }

  getSessionManager(): TerminalSessionManager {
    return this.manager
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
    logger.info('[terminal-ws] Connected to terminal WebSocket')
    this.reconnectAttemptsRef.current = 0
    resolve()
  }

  protected onParsedMessage(msg: TerminalServerMessage): void {
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
      case 'auth_success':
        // Authentication success acknowledgement from server — no action needed
        break
      case 'error': {
        const errMsg = (msg as unknown as Record<string, unknown>).message ?? (msg as unknown as Record<string, unknown>).error ?? 'unknown'
        logger.warn(`[terminal-ws] Server error (session=${msg.sessionId ?? 'none'}): ${errMsg}`)
        break
      }
      default:
        logger.debug(`[terminal-ws] Unknown message type: ${(msg as { type: string }).type}`)
    }
  }

  protected onDisconnect(): void {
    this.manager.closeAll()
  }

  protected closeWebSocket(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      ws.close()
    } else {
      ws.terminate()
    }
  }

  private handleOpen(msg: TerminalServerMessage): void {
    // API から受け取った sessionId を使用する
    const serverSessionId = msg.sessionId
    if (!serverSessionId) {
      this.send({
        type: 'error',
        sessionId: 'unknown',
        error: 'Missing sessionId in open message',
      })
      return
    }

    // Resolve cwd: if relative, resolve against projectDir
    let cwd = this.projectDir
    if (msg.cwd && this.projectDir) {
      const resolved = path.resolve(this.projectDir, msg.cwd)
      const resolvedProjectDir = path.resolve(this.projectDir)
      if (resolved !== resolvedProjectDir && !resolved.startsWith(resolvedProjectDir + '/')) {
        this.send({
          type: 'error',
          sessionId: serverSessionId,
          error: 'Invalid cwd: outside project directory',
        })
        return
      }
      cwd = resolved
    } else if (msg.cwd) {
      cwd = msg.cwd
    }

    const session = this.manager.createSessionWithId(serverSessionId, {
      cols: msg.cols,
      rows: msg.rows,
      cwd,
    })

    if (!session) {
      this.send({
        type: 'error',
        sessionId: serverSessionId,
        error: `Maximum concurrent sessions (${this.manager.size}) reached`,
      })
      return
    }

    session.onData((data) => {
      this.send({
        type: 'stdout',
        sessionId: serverSessionId,
        data: Buffer.from(data).toString('base64'),
      })
    })

    session.onExit((code) => {
      this.send({
        type: 'exit',
        sessionId: serverSessionId,
        code,
      })
    })

    this.send({
      type: 'ready',
      sessionId: serverSessionId,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
    })

    logger.debug(`[terminal-ws] Session opened: ${serverSessionId} (pid=${session.pid})`)
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
}
