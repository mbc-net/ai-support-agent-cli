/**
 * Wiring tests (dev-flow B-6, review round 4) for how TerminalWebSocket routes
 * the base-class lifecycle hooks to the session manager.
 *
 * The bug: the grace mechanism (closeAllGracefully) was wired to onDisconnect(),
 * which the base class only invokes from the explicit disconnect() method. A
 * real transient drop (ALB idle drop / heartbeat false-positive terminate /
 * network blip) instead fires the ws 'close' event -> onWebSocketClose(), which
 * was the no-op default. So grace never ran on a real transient disconnect, and
 * the disconnect() override even nullified it with an immediate closeAll().
 *
 * Correct routing:
 *   - onWebSocketClose() (transient 'close' event) -> manager.closeAllGracefully()
 *   - explicit disconnect()                         -> manager.closeAll()
 *   - onDisconnect() (default, no-op for this class) must NOT keep PTYs in grace
 *     on its own; it must not interfere with the explicit closeAll().
 *
 * These tests construct a real TerminalWebSocket (no socket connected) and drive
 * the protected hooks directly, asserting the manager-level effect with fake
 * timers and a mocked node-pty.
 */

import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

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
    this.pid = 30000 + MockPty.instances.length
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
    this._exitHandler?.({ exitCode: 0 })
  }

  get killed(): boolean {
    return this.killCount > 0
  }
}

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => new MockPty()),
}))

// Expose the protected hook for direct invocation in tests.
interface HookAccess {
  onWebSocketClose: () => void
}

function makeTerminalWs(): { ws: TerminalWebSocket; manager: TerminalSessionManager } {
  const ws = new TerminalWebSocket('http://localhost:0', 'token', 'agent-1', '/tmp')
  return { ws, manager: ws.getSessionManager() }
}

describe('TerminalWebSocket hook wiring (B-6 round 4)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    MockPty.instances = []
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('routes a transient close event (onWebSocketClose) to grace (armed, not no-op)', () => {
    const { ws, manager } = makeTerminalWs()
    const session = manager.createSessionWithId('wire-close')!
    expect(session.isAlive()).toBe(true)
    const pty = MockPty.instances[0]

    // Real transient drops fire the ws 'close' event -> onWebSocketClose().
    ;(ws as unknown as HookAccess).onWebSocketClose()

    // PTY must survive immediately (grace), not be killed.
    expect(pty.killed).toBe(false)
    expect(manager.size).toBe(1)
    expect(manager.getSession('wire-close')?.isAlive()).toBe(true)

    // Crucially, grace must be ARMED (a real timer), not merely a no-op that
    // leaves the PTY alive forever. RED before the fix: onWebSocketClose() was
    // the no-op default, so the PTY survives 300s and this assertion fails.
    jest.advanceTimersByTime(301 * 1000)
    expect(pty.killed).toBe(true)
    expect(manager.getSession('wire-close')).toBeUndefined()
  })

  it('kills a grace-held PTY 300s after a transient close with no reconnect', () => {
    const { ws, manager } = makeTerminalWs()
    manager.createSessionWithId('wire-close-expire')
    const pty = MockPty.instances[0]

    ;(ws as unknown as HookAccess).onWebSocketClose()

    // Just before the grace deadline: still alive.
    jest.advanceTimersByTime(299 * 1000)
    expect(pty.killed).toBe(false)
    expect(manager.getSession('wire-close-expire')).toBeDefined()

    // Past 300s with no reconnect: killed and removed.
    jest.advanceTimersByTime(2 * 1000)
    expect(pty.killed).toBe(true)
    expect(manager.getSession('wire-close-expire')).toBeUndefined()
  })

  it('resumes the same PTY when a reconnect opens the same sessionId within grace', () => {
    const { ws, manager } = makeTerminalWs()
    const original = manager.createSessionWithId('wire-resume')!

    ;(ws as unknown as HookAccess).onWebSocketClose()
    jest.advanceTimersByTime(100 * 1000) // within grace

    // Reconnect re-opens the same sessionId: must reuse the live PTY.
    const resumed = manager.createSessionWithId('wire-resume')
    expect(resumed).toBe(original)
    expect(MockPty.instances).toHaveLength(1)

    // The orphan grace timer must have been cancelled: advancing past 300s must
    // NOT kill the resumed live session.
    jest.advanceTimersByTime(301 * 1000)
    expect(MockPty.instances[0].killed).toBe(false)
    expect(manager.getSession('wire-resume')).toBe(original)
  })

  it('kills all PTYs immediately on explicit disconnect (no lingering grace)', () => {
    const { ws, manager } = makeTerminalWs()
    manager.createSessionWithId('wire-disconnect-a')
    manager.createSessionWithId('wire-disconnect-b')
    const ptys = [...MockPty.instances]

    // Explicit teardown.
    ws.disconnect()

    // Every PTY killed and dropped immediately.
    expect(ptys.every((p) => p.killed)).toBe(true)
    expect(manager.size).toBe(0)

    // No grace timer should remain that could fire later.
    expect(() => jest.advanceTimersByTime(301 * 1000)).not.toThrow()
    expect(manager.size).toBe(0)
  })

  it('does not leave a PTY in grace after explicit disconnect', () => {
    const { ws, manager } = makeTerminalWs()
    manager.createSessionWithId('wire-disconnect-grace')
    const pty = MockPty.instances[0]

    ws.disconnect()

    // Killed right away — not held for 300s.
    expect(pty.killed).toBe(true)
    expect(manager.getSession('wire-disconnect-grace')).toBeUndefined()
  })
})
