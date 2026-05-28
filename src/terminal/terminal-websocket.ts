import * as path from 'path'

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { WS_RECONNECT_MAX_DELAY_MS } from '../constants'
import { logger } from '../logger'
import { buildWsUrl } from '../utils'

import {
  TERMINAL_WS_MAX_RECONNECT_RETRIES,
  TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
} from './constants'

const MIN_TERMINAL_SIZE = 1
const MAX_TERMINAL_SIZE = 1000

function clampTerminalSize(value: number): number {
  return Math.min(Math.max(Math.floor(value), MIN_TERMINAL_SIZE), MAX_TERMINAL_SIZE)
}
import { TerminalSessionManager } from './terminal-session-manager'

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
  /**
   * Additional environment variables to inject into the PTY session.
   * Merged on top of the provider-based envVarsOverride.
   * GIT_SSH_KEY_CONTENT_BASE64: base64-encoded PEM private key to set up
   * GIT_SSH_COMMAND for the session (processed by TerminalSession).
   */
  envVarsOverride?: Record<string, string>
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

import type { EnvVarsProvider } from '../env-vars-filter'

// 既存の re-export（後方互換）
export type { EnvVarsProvider } from '../env-vars-filter'

export class TerminalWebSocket extends BaseWebSocketConnection<TerminalServerMessage> {
  private readonly manager: TerminalSessionManager
  private readonly wsUrl: string

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly projectDir?: string,
    private readonly envVarsProvider?: EnvVarsProvider,
  ) {
    super({
      maxReconnectRetries: TERMINAL_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: WS_RECONNECT_MAX_DELAY_MS,
      logPrefix: '[terminal-ws]',
    })
    this.manager = new TerminalSessionManager()
    this.wsUrl = buildWsUrl(apiUrl, '/ws/agent-terminal')
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

    // envVars を provider から取得。configSync が未完了 or キャッシュ
    // フォールバックで envVars が無い場合は undefined になる。その場合は
    // Web 設定 (CLAUDE_CODE#API_KEY 等) が PTY に反映されないため warn を出す。
    const providerEnvVars = this.envVarsProvider?.()
    if (this.envVarsProvider && !providerEnvVars) {
      logger.warn(
        `[terminal] Opening session ${serverSessionId} before envVars are available; ` +
          `Web-configured env overrides will not apply until the next successful config sync`,
      )
    }

    // サーバー送信の envVarsOverride (SSH鍵等) と provider の env をマージ。
    // provider が undefined でも、サーバー送信分だけ適用できるようにする。
    // マージ優先度: provider (configSync 由来) > server (session-specific 由来)
    const envVarsOverride: Record<string, string> | undefined =
      msg.envVarsOverride || providerEnvVars
        ? { ...(msg.envVarsOverride ?? {}), ...(providerEnvVars ?? {}) }
        : undefined

    const session = this.manager.createSessionWithId(serverSessionId, {
      cols: msg.cols,
      rows: msg.rows,
      cwd,
      envVarsOverride,
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
    try {
      const decoded = Buffer.from(msg.data, 'base64').toString('utf-8')
      session.write(decoded)
    } catch (err) {
      logger.warn(`[terminal-ws] Invalid base64 data in stdin (session=${msg.sessionId}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private handleResize(msg: TerminalServerMessage): void {
    if (!msg.sessionId) return
    const session = this.manager.getSession(msg.sessionId)
    if (!session) return
    if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      session.resize(clampTerminalSize(msg.cols), clampTerminalSize(msg.rows))
    }
  }

  private handleClose(msg: TerminalServerMessage): void {
    if (!msg.sessionId) return
    this.manager.closeSession(msg.sessionId)
    logger.debug(`[terminal-ws] Session closed: ${msg.sessionId}`)
  }

  private send(msg: TerminalAgentMessage): void {
    this.sendMessage(msg)
  }
}
