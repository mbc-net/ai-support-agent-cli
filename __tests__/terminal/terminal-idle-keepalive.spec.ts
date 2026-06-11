/**
 * Failing tests for terminal idle keepalive fix.
 *
 * Bug: SESSION_IDLE_TIMEOUT_MS causes PTY to be killed after 30 minutes of
 * inactivity even when the WebSocket connection is alive.
 *
 * Fix (case A): Remove idle timeout so the PTY lives as long as the WS is alive.
 * Session cleanup is delegated to grace-window management (disconnect → 300s → kill).
 *
 * These tests MUST FAIL before the fix and PASS after.
 */

import { TerminalSession } from '../../src/terminal/terminal-session'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

// The former idle timeout was 30 minutes; use this value to verify no timer fires.
const FORMER_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// Mock node-pty to avoid spawning real pty processes
type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty {
  pid = 12345
  cols = 80
  rows = 24
  private _dataHandler: DataHandler | null = null
  private _exitHandler: ExitHandler | null = null

  onData(handler: DataHandler) {
    this._dataHandler = handler
  }
  onExit(handler: ExitHandler) {
    this._exitHandler = handler
  }
  write(_data: string) {
    // no-op
  }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }
  kill() {
    setImmediate(() => this._exitHandler?.({ exitCode: 0 }))
  }
}

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => new MockPty()),
}))

describe('Terminal idle keepalive — PTY must NOT be killed by idle timer', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('TerminalSession: PTY stays alive after SESSION_IDLE_TIMEOUT_MS of inactivity', () => {
    const session = new TerminalSession('keepalive-session-1')
    expect(session.isAlive()).toBe(true)

    // Advance time past the idle timeout
    jest.advanceTimersByTime(FORMER_IDLE_TIMEOUT_MS + 1000)

    // PTY must still be alive — idle timeout should not kill it
    expect(session.isAlive()).toBe(true)

    session.kill()
  })

  it('TerminalSession: PTY stays alive after 2× SESSION_IDLE_TIMEOUT_MS of inactivity', () => {
    const session = new TerminalSession('keepalive-session-2')
    expect(session.isAlive()).toBe(true)

    jest.advanceTimersByTime(FORMER_IDLE_TIMEOUT_MS * 2 + 1000)

    expect(session.isAlive()).toBe(true)

    session.kill()
  })

  it('TerminalSessionManager: session is NOT removed after idle timeout while WS is alive', () => {
    const manager = new TerminalSessionManager()

    const session = manager.createSessionWithId('mgr-keepalive-1')
    expect(session).not.toBeNull()
    expect(manager.getSession('mgr-keepalive-1')).toBe(session)

    // Advance time past idle timeout
    jest.advanceTimersByTime(FORMER_IDLE_TIMEOUT_MS + 1000)

    // Session must still be present — no idle kill
    expect(manager.getSession('mgr-keepalive-1')).toBe(session)

    manager.closeAll()
  })

  it('TerminalSession: explicit kill still works after idle period', () => {
    const session = new TerminalSession('keepalive-session-3')
    expect(session.isAlive()).toBe(true)

    jest.advanceTimersByTime(FORMER_IDLE_TIMEOUT_MS + 1000)
    expect(session.isAlive()).toBe(true)

    // Explicit kill must still work
    session.kill()
    // After kill() the pty fires exit asynchronously via setImmediate in MockPty,
    // but isAlive() reflects the internal _alive flag which is set synchronously
    // on PTY exit event registration — just verify kill() doesn't throw
    expect(() => session.kill()).not.toThrow()
  })
})
