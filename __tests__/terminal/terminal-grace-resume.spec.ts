/**
 * Failing tests (dev-flow B-1) for the terminal keepalive grace/resume fix.
 *
 * Background: terminals drop after ~10 minutes. The agent-side defect is that a
 * transient WebSocket disconnect (e.g. an API heartbeat false-positive that
 * terminates the socket) currently calls `manager.closeAll()` in
 * `TerminalWebSocket.onDisconnect()`, which immediately kills every PTY. The
 * user's live shell is therefore destroyed and cannot be recovered on reconnect.
 *
 * Confirmed fix (NOT implemented yet — these tests must be RED):
 *   - grace = 300s: on WS disconnect, PTYs are NOT killed immediately. Within
 *     the grace window a reconnect with the same sessionId resumes (reuses) the
 *     still-alive PTY. Only after the grace window expires is the PTY killed.
 *
 * These tests assert the real, observable behaviour:
 *   1. onDisconnect does not kill PTYs immediately (session survives).
 *   2. A reconnect within grace (<300s) reuses the same PTY (resume), not a new one.
 *   3. After the grace window (>300s) the PTY is killed and removed.
 *
 * They reference APIs the fix is expected to introduce
 * (SESSION_GRACE_TIMEOUT_MS, TerminalSessionManager.closeAllGracefully) which do
 * not exist yet, so the suite fails today by design.
 */

import * as constants from '../../src/terminal/constants'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

// Mock node-pty so no real shell is spawned. The mock tracks kill() calls so we
// can assert precisely whether a PTY survives a disconnect or is killed.
type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty {
  static instances: MockPty[] = []
  pid: number
  cols = 80
  rows = 24
  killCount = 0
  private _exitHandler: ExitHandler | null = null

  constructor() {
    this.pid = 10000 + MockPty.instances.length
    MockPty.instances.push(this)
  }

  onData(_handler: DataHandler) {
    /* no-op */
  }
  onExit(handler: ExitHandler) {
    this._exitHandler = handler
  }
  write(_data: string) {
    /* no-op */
  }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }
  kill() {
    this.killCount++
    // Emit exit synchronously so the manager's onExit cleanup is observable.
    this._exitHandler?.({ exitCode: 0 })
  }

  get killed(): boolean {
    return this.killCount > 0
  }
}

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => new MockPty()),
}))

describe('Terminal grace / resume on WebSocket disconnect (B-1 failing tests)', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    jest.useFakeTimers()
    MockPty.instances = []
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    // Best-effort teardown; closeAll exists today.
    manager.closeAll()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('defines a 300s grace timeout constant', () => {
    // RED: SESSION_GRACE_TIMEOUT_MS does not exist on constants yet.
    expect(
      (constants as unknown as Record<string, number>).SESSION_GRACE_TIMEOUT_MS,
    ).toBe(300 * 1000)
  })

  it('does NOT kill the PTY immediately on disconnect (grace, not closeAll)', () => {
    const session = manager.createSessionWithId('grace-session')
    expect(session).not.toBeNull()
    const pty = MockPty.instances[0]
    expect(pty.killed).toBe(false)

    // Simulate a transient WS disconnect. The fix should NOT kill PTYs here.
    // RED today: closeAllGracefully does not exist; the only available path is
    // closeAll() which kills everything.
    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()

    // PTY must still be alive immediately after disconnect.
    expect(pty.killed).toBe(false)
    expect(manager.getSession('grace-session')?.isAlive()).toBe(true)
  })

  it('resumes the same PTY when reconnecting within the grace window (<300s)', () => {
    const original = manager.createSessionWithId('resume-session')
    expect(original).not.toBeNull()
    const originalPty = MockPty.instances[0]

    // Disconnect — schedule grace, do not kill.
    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()

    // Reconnect 100s later, well within the 300s grace window.
    jest.advanceTimersByTime(100 * 1000)

    // Re-open with the same sessionId. The fix must return the existing,
    // still-alive session (resume) instead of spawning a new PTY.
    const resumed = manager.createSessionWithId('resume-session')
    expect(resumed).toBe(original)
    // No new PTY should have been spawned.
    expect(MockPty.instances).toHaveLength(1)
    expect(originalPty.killed).toBe(false)
  })

  it('kills the PTY once the grace window (>300s) has elapsed without reconnect', () => {
    const session = manager.createSessionWithId('expire-session')
    expect(session).not.toBeNull()
    const pty = MockPty.instances[0]

    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()

    // Still alive just before the grace deadline.
    jest.advanceTimersByTime(299 * 1000)
    expect(pty.killed).toBe(false)
    expect(manager.getSession('expire-session')).toBeDefined()

    // Cross the 300s grace boundary — the PTY must now be killed and removed.
    jest.advanceTimersByTime(2 * 1000)
    expect(pty.killed).toBe(true)
    expect(manager.getSession('expire-session')).toBeUndefined()
  })

  it('is a no-op when the grace timer fires after the session has already gone', () => {
    const session = manager.createSessionWithId('exited-during-grace')
    expect(session).not.toBeNull()

    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()

    // The PTY exits on its own (e.g. the user typed `exit`) during the grace
    // window, so the manager's onExit hook removes it before the timer fires.
    session!.kill()
    expect(manager.getSession('exited-during-grace')).toBeUndefined()

    // When the grace timer eventually fires it must find no session and do
    // nothing — no double kill, no throw.
    expect(() => jest.advanceTimersByTime(301 * 1000)).not.toThrow()
    expect(manager.getSession('exited-during-grace')).toBeUndefined()
  })

  it('restarts the grace window on a repeated disconnect', () => {
    const session = manager.createSessionWithId('repeat-disconnect')
    expect(session).not.toBeNull()
    const pty = MockPty.instances[0]

    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()
    jest.advanceTimersByTime(200 * 1000)

    // A second disconnect (e.g. reconnect then immediate re-drop) restarts the
    // 300s window, so the session survives past the original deadline.
    ;(manager as unknown as { closeAllGracefully: () => void }).closeAllGracefully()
    jest.advanceTimersByTime(200 * 1000)
    expect(pty.killed).toBe(false)
    expect(manager.getSession('repeat-disconnect')).toBeDefined()

    // It is finally killed 300s after the most recent disconnect.
    jest.advanceTimersByTime(101 * 1000)
    expect(pty.killed).toBe(true)
    expect(manager.getSession('repeat-disconnect')).toBeUndefined()
  })
})
