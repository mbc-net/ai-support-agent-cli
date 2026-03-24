import * as os from 'os'

import * as constants from '../../src/terminal/constants'
import { TerminalSession, isNodePtyAvailable } from '../../src/terminal/terminal-session'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

const { MAX_CONCURRENT_SESSIONS } = constants

describe('isNodePtyAvailable', () => {
  it('should return true when node-pty is installed', () => {
    expect(isNodePtyAvailable()).toBe(true)
  })
})

describe('TerminalSession', () => {
  let session: TerminalSession

  afterEach(() => {
    if (session?.isAlive()) {
      session.kill()
    }
  })

  it('should create a session with default options', () => {
    session = new TerminalSession('test-1')
    expect(session.sessionId).toBe('test-1')
    expect(session.cols).toBe(80)
    expect(session.rows).toBe(24)
    expect(session.pid).toBeGreaterThan(0)
    expect(session.isAlive()).toBe(true)
  })

  it('should create a session with custom options', () => {
    const cwd = os.tmpdir()
    session = new TerminalSession('test-2', { cols: 120, rows: 40, cwd })
    expect(session.cols).toBe(120)
    expect(session.rows).toBe(40)
    expect(session.cwd).toBe(cwd)
  })

  it('should receive stdout data', (done) => {
    session = new TerminalSession('test-3', { cwd: os.tmpdir() })
    session.onData((data) => {
      expect(typeof data).toBe('string')
      done()
    })
    session.write('echo hello\n')
  })

  it('should handle exit', (done) => {
    session = new TerminalSession('test-4', { cwd: os.tmpdir() })
    session.onExit((code) => {
      expect(typeof code).toBe('number')
      expect(session.isAlive()).toBe(false)
      done()
    })
    session.write('exit\n')
  })

  it('should update dimensions on resize', () => {
    session = new TerminalSession('test-5')
    session.resize(200, 50)
    expect(session.cols).toBe(200)
    expect(session.rows).toBe(50)
  })

  it('should return session info', () => {
    session = new TerminalSession('test-6')
    const info = session.getInfo()
    expect(info.sessionId).toBe('test-6')
    expect(info.pid).toBeGreaterThan(0)
    expect(info.createdAt).toBeLessThanOrEqual(Date.now())
    expect(info.lastActivity).toBeLessThanOrEqual(Date.now())
  })

  it('should kill session', () => {
    session = new TerminalSession('test-7')
    expect(session.isAlive()).toBe(true)
    session.kill()
    // Process may not exit immediately, but kill should not throw
  })

  it('should not write after kill', (done) => {
    session = new TerminalSession('test-8')
    session.onExit(() => {
      // After exit, write should be a no-op (no errors)
      session.write('should not error\n')
      done()
    })
    session.kill()
  })

  it('should not kill twice', () => {
    session = new TerminalSession('test-9')
    session.kill()
    // Second kill should be a no-op
    session.kill()
  })

  it('should receive stderr data via onData', (done) => {
    session = new TerminalSession('test-stderr', { cwd: os.tmpdir() })
    session.onData((data) => {
      // stderr output goes through the same onData callback
      if (data.includes('no_such_command_xyz')) {
        done()
      }
    })
    session.write('no_such_command_xyz 2>&1\n')
  })

  it('should trigger idle timeout and kill session', (done) => {
    // Override the timeout constant to a very short value
    const origTimeout = constants.SESSION_IDLE_TIMEOUT_MS
    Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: 100, writable: true })

    session = new TerminalSession('test-idle')
    session.onExit(() => {
      // Restore original value
      Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: origTimeout, writable: true })
      done()
    })
    // Don't write anything — session should idle-timeout and kill itself
  })
})

describe('TerminalSessionManager', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    manager.closeAll()
  })

  it('should create a session', () => {
    const session = manager.createSession({ cwd: os.tmpdir() })
    expect(session).not.toBeNull()
    expect(manager.size).toBe(1)
  })

  it('should create a session with default options (no args)', () => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    expect(manager.size).toBe(1)
  })

  it('should create a session with explicit id and default options', () => {
    const session = manager.createSessionWithId('custom-id')
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe('custom-id')
    expect(manager.size).toBe(1)
  })

  it('should list sessions', () => {
    manager.createSession({ cwd: os.tmpdir() })
    manager.createSession({ cwd: os.tmpdir() })
    const list = manager.listSessions()
    expect(list).toHaveLength(2)
    expect(list[0].sessionId).toBeTruthy()
  })

  it('should get session by id', () => {
    const session = manager.createSession({ cwd: os.tmpdir() })
    expect(session).not.toBeNull()
    const found = manager.getSession(session!.sessionId)
    expect(found).toBe(session)
  })

  it('should return undefined for unknown session', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined()
  })

  it('should close a session', () => {
    const session = manager.createSession({ cwd: os.tmpdir() })
    expect(session).not.toBeNull()
    const result = manager.closeSession(session!.sessionId)
    expect(result).toBe(true)
    expect(manager.size).toBe(0)
  })

  it('should return false when closing unknown session', () => {
    expect(manager.closeSession('nonexistent')).toBe(false)
  })

  it('should enforce max concurrent sessions', () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      const s = manager.createSession({ cwd: os.tmpdir() })
      expect(s).not.toBeNull()
    }
    const extra = manager.createSession({ cwd: os.tmpdir() })
    expect(extra).toBeNull()
    expect(manager.size).toBe(MAX_CONCURRENT_SESSIONS)
  })

  it('should close all sessions', () => {
    manager.createSession({ cwd: os.tmpdir() })
    manager.createSession({ cwd: os.tmpdir() })
    expect(manager.size).toBe(2)
    manager.closeAll()
    expect(manager.size).toBe(0)
  })

  it('should remove session on idle timeout', (done) => {
    const origTimeout = constants.SESSION_IDLE_TIMEOUT_MS
    Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: 100, writable: true })

    const session = manager.createSession({ cwd: os.tmpdir() })
    expect(session).not.toBeNull()
    const sessionId = session!.sessionId

    // Wait for idle timeout to trigger manager cleanup
    const check = setInterval(() => {
      if (!manager.getSession(sessionId)) {
        clearInterval(check)
        Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: origTimeout, writable: true })
        done()
      }
    }, 50)
  })

  it('should remove session from map on exit', (done) => {
    const session = manager.createSession({ cwd: os.tmpdir() })
    expect(session).not.toBeNull()
    const sessionId = session!.sessionId

    session!.write('exit\n')

    // Poll until the session is removed from manager
    const check = setInterval(() => {
      if (!manager.getSession(sessionId)) {
        clearInterval(check)
        done()
      }
    }, 50)
  })
})
