/**
 * Tests for src/terminal/terminal-session-manager.ts
 *
 * Focused unit tests for TerminalSessionManager in isolation, verifying
 * session lifecycle, concurrent session limits, and edge cases.
 * Complements the integration-style tests in terminal-session.spec.ts.
 */

import * as constants from '../../src/terminal/constants'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'
import type { TerminalSession } from '../../src/terminal/terminal-session'

const { MAX_CONCURRENT_SESSIONS } = constants

// Mock node-pty to avoid spawning real pty processes
type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty {
  pid = 99999
  cols = 80
  rows = 24
  private _dataHandler: DataHandler | null = null
  private _exitHandler: ExitHandler | null = null

  onData(handler: DataHandler) { this._dataHandler = handler }
  onExit(handler: ExitHandler) { this._exitHandler = handler }
  write(_data: string) { /* no-op */ }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  kill() {
    setImmediate(() => this._exitHandler?.({ exitCode: 0 }))
  }
  triggerExit(code: number) {
    this._exitHandler?.({ exitCode: code })
  }
}

let lastMockPty: MockPty

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    lastMockPty = new MockPty()
    return lastMockPty
  }),
}))

describe('TerminalSessionManager', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    manager.closeAll()
  })

  describe('createSession', () => {
    it('creates a session and returns it', () => {
      const session = manager.createSession()
      expect(session).not.toBeNull()
      expect(session!.sessionId).toMatch(/^term-\d+-\d+$/)
    })

    it('increments session counter for unique IDs', () => {
      const s1 = manager.createSession()
      const s2 = manager.createSession()
      expect(s1).not.toBeNull()
      expect(s2).not.toBeNull()
      expect(s1!.sessionId).not.toBe(s2!.sessionId)
    })

    it('passes options to the created session', () => {
      const session = manager.createSession({ cols: 120, rows: 40, cwd: '/tmp' })
      expect(session).not.toBeNull()
      expect(session!.cols).toBe(120)
      expect(session!.rows).toBe(40)
      expect(session!.cwd).toBe('/tmp')
    })

    it('uses default options when none provided', () => {
      const session = manager.createSession()
      expect(session).not.toBeNull()
      expect(session!.cols).toBe(80)
      expect(session!.rows).toBe(24)
    })

    it('returns null when MAX_CONCURRENT_SESSIONS is reached', () => {
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
        const s = manager.createSession()
        expect(s).not.toBeNull()
      }
      const extra = manager.createSession()
      expect(extra).toBeNull()
    })

    it('allows creating a new session after one is closed', () => {
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
        manager.createSession()
      }
      // Close one session
      const sessions = manager.listSessions()
      manager.closeSession(sessions[0].sessionId)

      // Now one slot is free
      const newSession = manager.createSession()
      expect(newSession).not.toBeNull()
    })
  })

  describe('createSessionWithId', () => {
    it('creates a session with a specific ID', () => {
      const session = manager.createSessionWithId('my-session-id')
      expect(session).not.toBeNull()
      expect(session!.sessionId).toBe('my-session-id')
    })

    it('returns null when at max capacity', () => {
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
        manager.createSessionWithId(`session-${i}`)
      }
      const extra = manager.createSessionWithId('overflow-session')
      expect(extra).toBeNull()
    })

    it('sets up onExit callback to auto-remove session', (done) => {
      const session = manager.createSessionWithId('auto-remove-test')
      expect(session).not.toBeNull()
      expect(manager.getSession('auto-remove-test')).toBe(session)

      // Use kill() to simulate session exit — the manager's internal onExit
      // callback deletes the session from the map
      session!.kill()

      // Allow the setImmediate in MockPty.kill to fire
      setImmediate(() => {
        setImmediate(() => {
          expect(manager.getSession('auto-remove-test')).toBeUndefined()
          done()
        })
      })
    })

    it('sets up idle timeout to auto-remove session', (done) => {
      const origTimeout = constants.SESSION_IDLE_TIMEOUT_MS
      Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: 30, writable: true })

      const session = manager.createSessionWithId('idle-test')
      expect(session).not.toBeNull()

      const check = setInterval(() => {
        if (!manager.getSession('idle-test')) {
          clearInterval(check)
          Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: origTimeout, writable: true })
          done()
        }
      }, 10)
    })
  })

  describe('getSession', () => {
    it('returns the session when it exists', () => {
      const session = manager.createSession()
      expect(session).not.toBeNull()
      const found = manager.getSession(session!.sessionId)
      expect(found).toBe(session)
    })

    it('returns undefined for unknown session ID', () => {
      expect(manager.getSession('nonexistent-id')).toBeUndefined()
    })

    it('returns undefined after the session has been closed', () => {
      const session = manager.createSession()!
      const id = session.sessionId
      manager.closeSession(id)
      expect(manager.getSession(id)).toBeUndefined()
    })
  })

  describe('closeSession', () => {
    it('returns true and removes the session when it exists', () => {
      const session = manager.createSession()!
      const id = session.sessionId
      expect(manager.size).toBe(1)

      const result = manager.closeSession(id)
      expect(result).toBe(true)
      expect(manager.size).toBe(0)
    })

    it('returns false when the session does not exist', () => {
      expect(manager.closeSession('unknown-id')).toBe(false)
    })

    it('removes the session from the map immediately', () => {
      const session = manager.createSession()!
      const id = session.sessionId
      manager.closeSession(id)
      expect(manager.getSession(id)).toBeUndefined()
    })

    it('does not affect other sessions when one is closed', () => {
      const s1 = manager.createSession()!
      const s2 = manager.createSession()!
      manager.closeSession(s1.sessionId)
      expect(manager.getSession(s2.sessionId)).toBe(s2)
      expect(manager.size).toBe(1)
    })
  })

  describe('listSessions', () => {
    it('returns empty array when no sessions exist', () => {
      expect(manager.listSessions()).toEqual([])
    })

    it('returns session info for each active session', () => {
      manager.createSession()
      manager.createSession()
      const list = manager.listSessions()
      expect(list).toHaveLength(2)
      expect(list[0]).toMatchObject({
        sessionId: expect.any(String) as string,
        pid: expect.any(Number) as number,
        cols: expect.any(Number) as number,
        rows: expect.any(Number) as number,
        cwd: expect.any(String) as string,
        createdAt: expect.any(Number) as number,
        lastActivity: expect.any(Number) as number,
      })
    })

    it('does not include closed sessions', () => {
      const s1 = manager.createSession()!
      manager.createSession()
      manager.closeSession(s1.sessionId)
      const list = manager.listSessions()
      expect(list).toHaveLength(1)
      expect(list[0].sessionId).not.toBe(s1.sessionId)
    })
  })

  describe('closeAll', () => {
    it('removes all sessions', () => {
      manager.createSession()
      manager.createSession()
      manager.createSession()
      expect(manager.size).toBe(3)
      manager.closeAll()
      expect(manager.size).toBe(0)
    })

    it('is safe to call when no sessions exist', () => {
      expect(manager.size).toBe(0)
      expect(() => manager.closeAll()).not.toThrow()
    })

    it('allows creating new sessions after closeAll', () => {
      manager.createSession()
      manager.createSession()
      manager.closeAll()
      const session = manager.createSession()
      expect(session).not.toBeNull()
      expect(manager.size).toBe(1)
    })
  })

  describe('size', () => {
    it('returns 0 initially', () => {
      expect(manager.size).toBe(0)
    })

    it('increments when sessions are created', () => {
      manager.createSession()
      expect(manager.size).toBe(1)
      manager.createSession()
      expect(manager.size).toBe(2)
    })

    it('decrements when sessions are closed', () => {
      const s = manager.createSession()!
      expect(manager.size).toBe(1)
      manager.closeSession(s.sessionId)
      expect(manager.size).toBe(0)
    })

    it('stays at MAX_CONCURRENT_SESSIONS when limit is reached', () => {
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
        manager.createSession()
      }
      manager.createSession() // returns null, size unchanged
      expect(manager.size).toBe(MAX_CONCURRENT_SESSIONS)
    })
  })

  describe('session auto-removal on exit', () => {
    it('removes session from map when session is killed', (done) => {
      const session = manager.createSession() as TerminalSession | null
      expect(session).not.toBeNull()
      const id = session!.sessionId
      expect(manager.getSession(id)).toBe(session)

      // Kill the session — the manager's onExit hook removes it from the map
      session!.kill()

      // Wait for the MockPty kill's setImmediate to propagate through session's onExit
      setImmediate(() => {
        setImmediate(() => {
          expect(manager.getSession(id)).toBeUndefined()
          expect(manager.size).toBe(0)
          done()
        })
      })
    })
  })
})
