import * as path from 'path'
import { execFile, type ExecFileException } from 'child_process'

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../base-websocket'
import { WS_CLOSE_CODE_AUTH_REJECTED, WS_RECONNECT_MAX_DELAY_MS } from '../constants'
import { logger } from '../logger'
import { buildWsUrl, getErrorMessage, isErrnoException } from '../utils'

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
 * Turn a tmux `execFile` error into a user-facing message, collapsing the
 * common "tmux binary is not installed" case (ENOENT) into a stable string
 * instead of the raw (platform-dependent) Node error message. Uses the
 * shared `isErrnoException` type guard (see src/utils.ts) rather than an
 * unchecked `as NodeJS.ErrnoException` cast.
 */
function describeTmuxExecError(err: ExecFileException): string {
  return isErrnoException(err, 'ENOENT') ? 'tmux not found' : err.message
}

/**
 * Information about a single tmux session.
 */
export interface TmuxSessionInfo {
  /** Session name (e.g. "ais-abc123") */
  name: string
  /** Number of windows in the session */
  windows: number
  /** Whether the session is currently attached */
  attached: boolean
  /** Session creation time as Unix timestamp (seconds since epoch) */
  created: number
  /** Last activity time as Unix timestamp (seconds since epoch) */
  activity: number
}

/**
 * Messages sent from API server to agent
 */
export interface TerminalServerMessage {
  type: 'open' | 'stdin' | 'resize' | 'close' | 'auth_success' | 'error' | 'tmux_list_sessions' | 'tmux_kill_session' | 'split_pane'
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
  /** Request ID for tmux management messages */
  requestId?: string
  /** Session name for tmux_kill_session */
  name?: string
  /**
   * Owner (user) hash injected by the API for tmux management messages.
   * Computed API-side as sha256(auth.userId).hex.slice(0, 12) — never sent by
   * the web client. Used to filter tmux_list_sessions to the requester's own
   * `ais-{userHash}-*` sessions. When absent the agent returns no sessions
   * (fail-safe; no fallback to listing everything).
   */
  userHash?: string
  /**
   * Attach target tmux session name (forwarded from web via API).
   * When set, the agent attaches to this existing tmux session instead of
   * creating a new one named ais-{sessionId}.
   */
  tmuxSessionName?: string
  /**
   * Pane split direction for split_pane messages.
   * 'horizontal' (default) splits left/right; 'vertical' splits top/bottom.
   */
  direction?: 'horizontal' | 'vertical'
  /**
   * Target tmux session name for split_pane messages.
   */
  sessionName?: string
}

/**
 * Messages sent from agent to API server
 */
export interface TerminalAgentMessage {
  type: 'ready' | 'stdout' | 'exit' | 'error' | 'replay' | 'resume_failed' | 'tmux_sessions' | 'tmux_session_killed' | 'tmux_pane_split'
  sessionId?: string
  data?: string // Base64 encoded for stdout / replay
  code?: number | null
  error?: string
  pid?: number
  cols?: number
  rows?: number
  /** resume_failed reason: 'not_found' | 'meta_mismatch' | 'dead' */
  reason?: string
  /** Request ID for tmux management responses */
  requestId?: string
  /** List of tmux sessions (for tmux_sessions response) */
  sessions?: TmuxSessionInfo[]
  /** Session name (for tmux_session_killed response) */
  name?: string
  /** Whether the kill operation succeeded (for tmux_session_killed response) */
  success?: boolean
  /** Session name (for tmux_pane_split response) */
  sessionName?: string
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
    private readonly onAuthRejected?: () => void,
  ) {
    super({
      maxReconnectRetries: TERMINAL_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: TERMINAL_WS_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: WS_RECONNECT_MAX_DELAY_MS,
      logPrefix: '[terminal-ws]',
      authRejectedCloseCode: WS_CLOSE_CODE_AUTH_REJECTED,
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
        // `error` は TerminalServerMessage の公式フィールドではないが、サーバー実装が
        // message の代わりに送ってくる可能性があるため防御的に読む
        const errMsg = msg.message ?? (msg as unknown as Record<string, unknown>).error ?? 'unknown'
        logger.warn(`[terminal-ws] Server error (session=${msg.sessionId ?? 'none'}): ${errMsg}`)
        break
      }
      case 'tmux_list_sessions':
        this.handleTmuxListSessions(msg)
        break
      case 'tmux_kill_session':
        this.handleTmuxKillSession(msg)
        break
      case 'split_pane':
        this.handleSplitPane(msg).catch((err: Error) => {
          logger.error(`[terminal-ws] handleSplitPane error: ${err.message}`)
        })
        break
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
   * Server-side permanent authentication rejection (invalid token, or Agent ID
   * token-binding mismatch). The base class calls this instead of
   * onWebSocketClose() in that case, since reconnecting to resume is not
   * possible — the connection will never be re-established with the same
   * credentials. Kill every PTY immediately rather than arming the grace
   * window, matching the explicit-shutdown behavior in disconnect().
   */
  protected onPermanentClose(): void {
    this.manager.closeAll()
    this.onAuthRejected?.()
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
      tmuxSessionName: msg.tmuxSessionName,
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

  private handleTmuxListSessions(msg: TerminalServerMessage): void {
    const requestId = msg.requestId ?? ''
    const userHash = msg.userHash

    // Owner filter (defense-in-depth alongside the API server-side filter).
    // No-fallback rule: without a userHash we must NOT leak any sessions, so
    // return an empty list without even invoking tmux.
    if (!userHash) {
      logger.warn('[terminal-ws] tmux_list_sessions: missing userHash; returning no sessions')
      this.send({ type: 'tmux_sessions', requestId, sessions: [] })
      return
    }
    const ownerPrefix = `ais-${userHash}-`

    execFile(
      'tmux',
      ['list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}'],
      (err, stdout, stderr) => {
        if (err) {
          const isEnoent = isErrnoException(err, 'ENOENT')
          const isNoServer = stderr.includes('no server running') || stderr.includes('no sessions')
          if (!isEnoent && !isNoServer) {
            logger.warn(`[terminal-ws] tmux list-sessions unexpected error: ${err.code ?? 'unknown'} - ${err.message}`)
          }
          this.send({ type: 'tmux_sessions', requestId, sessions: [] })
          return
        }

        const sessions: TmuxSessionInfo[] = stdout
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => {
            const [name, windows, attached, created, activity] = line.split('\t')
            return {
              name,
              windows: parseInt(windows, 10),
              attached: attached === '1',
              created: parseInt(created, 10),
              activity: parseInt(activity, 10),
            }
          })
          // Keep only the requester's own owner-partitioned sessions. Legacy
          // unpartitioned names (ais-{sessionId}) lack the userHash segment and
          // are naturally excluded (no-fallback rule).
          .filter((s) => s.name.startsWith(ownerPrefix))

        this.send({ type: 'tmux_sessions', requestId, sessions })
      },
    )
  }

  private handleTmuxKillSession(msg: TerminalServerMessage): void {
    const requestId = msg.requestId ?? ''
    const name = msg.name ?? ''
    if (!name) {
      logger.warn('[terminal-ws] tmux_kill_session: missing session name')
      this.send({ type: 'tmux_session_killed', requestId, name: '', success: false, error: 'missing session name' })
      return
    }

    // Second-layer owner defense (defense-in-depth alongside the API server-side
    // authorization). When the API forwards a userHash (USER role, self-kill),
    // the target name MUST start with ais-{userHash}-; otherwise refuse without
    // touching tmux. When userHash is absent the API has already authorized
    // (admin/system_admin bypass), so we proceed as before.
    if (msg.userHash && !name.startsWith(`ais-${msg.userHash}-`)) {
      logger.warn(
        `[terminal-ws] tmux_kill_session: owner mismatch (name=${name}); refusing`,
      )
      this.send({
        type: 'tmux_session_killed',
        requestId,
        name,
        success: false,
        error: 'access denied',
      })
      return
    }

    execFile('tmux', ['kill-session', '-t', name], (err) => {
      if (err) {
        this.send({
          type: 'tmux_session_killed',
          requestId,
          name,
          success: false,
          error: describeTmuxExecError(err),
        })
        return
      }
      this.send({ type: 'tmux_session_killed', requestId, name, success: true })
    })
  }

  /**
   * Split a pane in an existing tmux session.
   *
   * Security: validates sessionName against an allowlist of safe characters
   * (alphanumeric, hyphen, underscore, colon, period) to prevent command
   * injection, as a second layer of defense alongside API-side validation.
   */
  private async handleSplitPane(msg: TerminalServerMessage): Promise<void> {
    const { requestId, sessionName, direction } = msg

    // Input validation (security: command injection prevention)
    if (!sessionName || !/^[a-zA-Z0-9_\-:.]+$/.test(sessionName)) {
      this.send({
        type: 'tmux_pane_split',
        requestId,
        sessionName: sessionName ?? '',
        success: false,
        error: 'Invalid session name',
      })
      return
    }

    // -h splits left/right (horizontal, default); -v splits top/bottom (vertical)
    const flag = direction === 'vertical' ? '-v' : '-h'

    await new Promise<void>((resolve) => {
      execFile('tmux', ['split-window', flag, '-t', sessionName], (err) => {
        if (err) {
          this.send({
            type: 'tmux_pane_split',
            requestId,
            sessionName,
            success: false,
            error: describeTmuxExecError(err),
          })
          resolve()
          return
        }
        this.send({ type: 'tmux_pane_split', requestId, sessionName, success: true })
        resolve()
      })
    })
  }

  private send(msg: TerminalAgentMessage): void {
    this.sendMessage(msg)
  }
}
