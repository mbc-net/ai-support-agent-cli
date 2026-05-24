/**
 * BrowserSessionManager — manages multiple browser sessions for live view.
 */

import { logger } from '../../../logger'
import { BrowserSession } from './browser-session'

/**
 * Default upper bound on concurrent browser sessions per agent.
 * The web UI exposes up to 5 instances in the Browser tab; this default
 * matches that to avoid surprises. Can be overridden via the
 * BROWSER_MAX_SESSIONS environment variable.
 */
export const DEFAULT_MAX_BROWSER_SESSIONS = 5

/**
 * Read BROWSER_MAX_SESSIONS from the environment and return a sane value.
 * Falls back to DEFAULT_MAX_BROWSER_SESSIONS on missing / invalid / non-positive
 * values so misconfiguration cannot disable the feature entirely.
 */
export function getMaxBrowserSessionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BROWSER_MAX_SESSIONS
  if (raw === undefined || raw === '') return DEFAULT_MAX_BROWSER_SESSIONS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BROWSER_SESSIONS
  }
  return parsed
}

export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>()
  private conversationMap = new Map<string, string>() // conversationId → sessionId
  private readonly maxSessions: number

  constructor(maxSessions: number = DEFAULT_MAX_BROWSER_SESSIONS) {
    this.maxSessions = maxSessions
  }

  /**
   * Get an existing session or create a new one.
   */
  async getOrCreate(sessionId: string): Promise<BrowserSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Max browser sessions reached (${this.maxSessions})`)
    }

    const session = new BrowserSession()
    this.sessions.set(sessionId, session)
    logger.debug(`[browser-manager] Session created: ${sessionId}`)
    return session
  }

  /**
   * Get an existing session by session ID.
   */
  get(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Get a session by conversation ID.
   */
  getByConversationId(conversationId: string): BrowserSession | undefined {
    const sessionId = this.conversationMap.get(conversationId)
    if (!sessionId) return undefined
    return this.sessions.get(sessionId)
  }

  /**
   * Get the session ID for a given conversation ID.
   */
  getSessionIdByConversationId(conversationId: string): string | undefined {
    return this.conversationMap.get(conversationId)
  }

  /**
   * Link a conversation to a session.
   */
  linkConversation(conversationId: string, sessionId: string): void {
    this.conversationMap.set(conversationId, sessionId)
    logger.debug(`[browser-manager] Linked conversation ${conversationId} → session ${sessionId}`)
  }

  /**
   * Close and remove a session.
   */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    await session.close()
    this.sessions.delete(sessionId)

    // Remove conversation mappings pointing to this session
    for (const [convId, sid] of this.conversationMap) {
      if (sid === sessionId) {
        this.conversationMap.delete(convId)
      }
    }

    logger.debug(`[browser-manager] Session closed: ${sessionId}`)
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys())
    for (const sessionId of sessionIds) {
      await this.close(sessionId)
    }
  }

  /**
   * List all active sessions.
   */
  listSessions(): Array<{ sessionId: string; conversationId?: string }> {
    const result: Array<{ sessionId: string; conversationId?: string }> = []

    // Build reverse map of sessionId → conversationId
    const reverseMap = new Map<string, string>()
    for (const [convId, sessId] of this.conversationMap) {
      reverseMap.set(sessId, convId)
    }

    for (const sessionId of this.sessions.keys()) {
      result.push({
        sessionId,
        conversationId: reverseMap.get(sessionId),
      })
    }
    return result
  }

  /**
   * Get the number of active sessions.
   */
  get size(): number {
    return this.sessions.size
  }
}
