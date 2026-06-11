import { TerminalSession, TerminalSessionOptions } from './terminal-session'
import { MAX_CONCURRENT_SESSIONS, SESSION_GRACE_TIMEOUT_MS } from './constants'
import { logger } from '../logger'
import type { TerminalSessionInfo } from './terminal-session'

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>()
  /**
   * Per-session grace timers scheduled by closeAllGracefully(). A timer kills
   * and removes its session when the grace window elapses without a reconnect.
   */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessionCounter = 0

  createSession(options: TerminalSessionOptions = {}): TerminalSession | null {
    this.sessionCounter++
    const sessionId = `term-${Date.now()}-${this.sessionCounter}`
    return this.createSessionWithId(sessionId, options)
  }

  createSessionWithId(sessionId: string, options: TerminalSessionOptions = {}): TerminalSession | null {
    // Any reconnect with this sessionId invalidates a pending grace timer: we
    // either resume the existing PTY or replace it with a new one. Clearing
    // unconditionally prevents an orphaned timer from later killing the
    // freshly-created live session (see bug #1).
    this.clearGraceTimer(sessionId)

    // Resume path: a reconnect with the same sessionId within the grace window
    // reuses the still-alive PTY and returns it instead of spawning a new one.
    const existing = this.sessions.get(sessionId)
    if (existing && existing.isAlive()) {
      logger.debug(`[terminal] Resuming session within grace window: ${sessionId}`)
      return existing
    }

    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return null
    }

    const session = new TerminalSession(sessionId, options)

    // Use the internal exit slot so the manager cleanup survives the websocket
    // handler re-registering the public onExit (see bug #2).
    session.setOnExitInternal(() => {
      this.clearGraceTimer(sessionId)
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, session)
    return session
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.clearGraceTimer(sessionId)
    session.kill()
    this.sessions.delete(sessionId)
    return true
  }

  listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo())
  }

  /**
   * Genuine shutdown: kill every PTY immediately and drop all sessions.
   * Use this on process exit, not on a transient WebSocket disconnect.
   */
  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.clearGraceTimer(sessionId)
    }
    for (const session of this.sessions.values()) {
      session.kill()
    }
    this.sessions.clear()
  }

  /**
   * Transient-disconnect handling: keep every PTY alive and schedule a grace
   * timer per session. If no reconnect arrives within SESSION_GRACE_TIMEOUT_MS,
   * the session is killed and removed. A reconnect with the same sessionId via
   * createSessionWithId() cancels the timer and resumes the PTY.
   */
  closeAllGracefully(): void {
    for (const sessionId of this.sessions.keys()) {
      this.scheduleGraceTimer(sessionId)
    }
  }

  private scheduleGraceTimer(sessionId: string): void {
    // Replace any existing grace timer so the window restarts on each disconnect.
    this.clearGraceTimer(sessionId)
    const timer = setTimeout(() => {
      this.graceTimers.delete(sessionId)
      const session = this.sessions.get(sessionId)
      /* istanbul ignore else -- defensive: the timer is always cleared when the
         session is removed (onExit/closeSession/closeAll/resume), so by the time
         it fires the session is normally still present. */
      if (session) {
        logger.debug(`[terminal] Grace window expired; killing session: ${sessionId}`)
        session.kill()
        this.sessions.delete(sessionId)
      }
    }, SESSION_GRACE_TIMEOUT_MS)
    // Do not keep the process alive solely for a pending grace timer.
    /* istanbul ignore next -- unref is present on Node timers; guarded for envs that lack it */
    timer.unref?.()
    this.graceTimers.set(sessionId, timer)
  }

  private clearGraceTimer(sessionId: string): void {
    const timer = this.graceTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.graceTimers.delete(sessionId)
    }
  }

  get size(): number {
    return this.sessions.size
  }
}
