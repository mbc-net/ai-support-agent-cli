import { TerminalSession, TerminalSessionOptions } from './terminal-session'
import { MAX_CONCURRENT_SESSIONS } from './constants'
import type { TerminalSessionInfo } from './terminal-session'

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private sessionCounter = 0

  createSession(options: TerminalSessionOptions = {}): TerminalSession | null {
    this.sessionCounter++
    const sessionId = `term-${Date.now()}-${this.sessionCounter}`
    return this.createSessionWithId(sessionId, options)
  }

  createSessionWithId(sessionId: string, options: TerminalSessionOptions = {}): TerminalSession | null {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return null
    }

    const session = new TerminalSession(sessionId, options)

    session.onExit(() => {
      this.sessions.delete(sessionId)
    })

    session.setOnIdleTimeout(() => {
      session.kill()
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
    session.kill()
    this.sessions.delete(sessionId)
    return true
  }

  listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo())
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.kill()
    }
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}
