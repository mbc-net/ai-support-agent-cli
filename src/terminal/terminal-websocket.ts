import * as path from 'path'

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { WS_RECONNECT_MAX_DELAY_MS } from '../constants'
import { logger } from '../logger'
import { buildWsUrl, getErrorMessage } from '../utils'

import type { EnvVarsProvider } from '../env-vars-filter'
import {
  TERMINAL_WS_MAX_RECONNECT_RETRIES,
  TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
} from './constants'
import type { TerminalSession } from './terminal-session'
import { TerminalSessionManager } from './terminal-session-manager'

const MIN_TERMINAL_SIZE = 1
const MAX_TERMINAL_SIZE = 1000

function clampTerminalSize(value: number): number {
  return Math.min(Math.max(Math.floor(value), MIN_TERMINAL_SIZE), MAX_TERMINAL_SIZE)
}

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
  /**
   * Resume-only open (3-repo protocol contract). When true the agent must
   * NEVER spawn a new PTY: it either reattaches to the existing live PTY
   * (meta exactly matching) or replies with `resume_failed`.
   */
  resume?: boolean
  /**
   * Resume-validation meta recorded at PTY creation and verified on resume.
   */
  meta?: { tenantCode: string; projectCode: string; userId: string }
}

/**
 * Messages sent from agent to API server
 */
export interface TerminalAgentMessage {
  type: 'ready' | 'stdout' | 'exit' | 'error' | 'replay' | 'resume_failed'
  sessionId: string
  data?: string // Base64 encoded for stdout / replay
  code?: number | null
  error?: string
  pid?: number
  cols?: number
  rows?: number
  /** resume_failed reason: 'not_found' | 'meta_mismatch' | 'dead' */
  reason?: string
}

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

  /**
   * Transient WebSocket drop (ALB idle drop / heartbeat false-positive
   * terminate / network blip). The base class fires this from the ws 'close'
   * event, so this is where real transient disconnects land — NOT onDisconnect()
   * (which is only invoked from the explicit disconnect() method).
   *
   * Keep every PTY alive within the grace window so a reconnect with the same
   * sessionId can resume the user's live shell. If no reconnect arrives within
   * SESSION_GRACE_TIMEOUT_MS the PTY is killed by the grace timer. A heartbeat
   * false-positive terminate also fires 'close', so misdetected drops likewise
   * preserve the PTY for resume.
   */
  protected onWebSocketClose(): void {
    this.manager.closeAllGracefully()
  }

  /**
   * Explicit, user/agent-initiated shutdown. Unlike a transient drop, this is a
   * genuine teardown so every PTY is killed immediately rather than being kept
   * alive for the grace window.
   *
   * The base disconnect() calls onDisconnect() (left as the no-op default here,
   * so it does NOT arm grace), then closes the socket. We follow up with
   * closeAll() to kill every PTY. Because onDisconnect() does not schedule grace
   * timers, there is nothing for closeAll() to undo — the two paths no longer
   * fight (transient = grace via onWebSocketClose; explicit = closeAll here).
   */
  disconnect(): void {
    super.disconnect()
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

    // Resume-only open: reattach to the existing PTY or fail explicitly.
    // Never falls back to spawning a new PTY (no-fallback rule).
    if (msg.resume === true) {
      this.handleResumeOpen(serverSessionId, msg)
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
      meta: msg.meta,
    })

    if (!session) {
      this.send({
        type: 'error',
        sessionId: serverSessionId,
        error: `Maximum concurrent sessions (${this.manager.size}) reached`,
      })
      return
    }

    this.attachSessionRelay(session, serverSessionId)

    this.send({
      type: 'ready',
      sessionId: serverSessionId,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
    })

    logger.debug(`[terminal-ws] Session opened: ${serverSessionId} (pid=${session.pid})`)
  }

  /**
   * Resume-only open (`resume: true`). Reattaches to the existing live PTY
   * when the presented meta exactly matches; otherwise replies `resume_failed`
   * with the validation reason. A failed resume NEVER spawns a new PTY.
   *
   * Message order on success is fixed by spec (and tests):
   *   ready → replay (skipped when the scrollback buffer is empty) → stdout…
   * This whole method is synchronous, so no PTY data event can interleave
   * between the relay re-registration and the ready/replay sends; any new
   * output is delivered as `stdout` strictly after `replay`.
   */
  private handleResumeOpen(sessionId: string, msg: TerminalServerMessage): void {
    const result = this.manager.resumeSession(sessionId, msg.meta)
    if (!result.ok) {
      logger.warn(`[terminal-ws] Resume failed (session=${sessionId}): ${result.reason}`)
      this.send({
        type: 'resume_failed',
        sessionId,
        reason: result.reason,
      })
      return
    }

    const session = result.session
    if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      session.resize(clampTerminalSize(msg.cols), clampTerminalSize(msg.rows))
    }

    // Re-registering REPLACES the previous callbacks (single-slot setters in
    // TerminalSession), so a resumed session cannot double-send stdout/exit.
    this.attachSessionRelay(session, sessionId)

    this.send({
      type: 'ready',
      sessionId,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
    })

    const scrollback = session.getScrollbackBuffer()
    if (scrollback.byteLength > 0) {
      this.send({
        type: 'replay',
        sessionId,
        data: scrollback.toString('base64'),
      })
    }

    logger.debug(`[terminal-ws] Session resumed: ${sessionId} (pid=${session.pid})`)
  }

  /**
   * Wire the session's PTY output/exit to the WebSocket. TerminalSession holds
   * a SINGLE callback per event (setter semantics), so calling this again on
   * resume replaces — never stacks — the relay (no duplicate stdout frames).
   */
  private attachSessionRelay(session: TerminalSession, sessionId: string): void {
    session.onData((data) => {
      this.send({
        type: 'stdout',
        sessionId,
        data: Buffer.from(data).toString('base64'),
      })
    })

    session.onExit((code) => {
      this.send({
        type: 'exit',
        sessionId,
        code,
      })
    })
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
    } catch (err: unknown) {
      logger.warn(`[terminal-ws] Invalid base64 data in stdin (session=${msg.sessionId}): ${getErrorMessage(err)}`)
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
