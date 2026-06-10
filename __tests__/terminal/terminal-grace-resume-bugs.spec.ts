/**
 * Regression tests (dev-flow B-6) for two confirmed bugs in the terminal
 * keepalive grace/resume implementation that directly defeat connection
 * keepalive.
 *
 * Bug #1 — orphaned grace timer on re-create:
 *   closeAllGracefully() schedules a 300s grace timer per session. If the PTY
 *   then dies but stays in the map (see bug #2), and the client reconnects with
 *   the same sessionId, createSessionWithId() takes the fallthrough branch and
 *   spawns a brand-new live PTY — WITHOUT cancelling the pending grace timer.
 *   ~300s later the orphaned timer fires, resolves sessions.get(sessionId), and
 *   kills the freshly created live session. The terminal dies ~5 minutes after a
 *   reconnect-with-new-PTY.
 *
 * Bug #2 — single-callback onExit overwrite kills manager cleanup:
 *   TerminalSession.onExit/onData are single-callback assignments. The manager
 *   registers an onExit (clear grace timer + delete from map) in
 *   createSessionWithId(); the websocket handler then calls session.onExit()
 *   again to send the 'exit' frame, OVERWRITING the manager's callback. On a
 *   natural PTY exit the manager never cleans up: the dead session and its grace
 *   timer leak (and count against MAX_CONCURRENT_SESSIONS). This also creates the
 *   precondition for bug #1.
 */

import { TerminalSession } from '../../src/terminal/terminal-session'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

/**
 * node-pty mock that gives the test explicit control over data/exit events.
 * Unlike the simpler mocks, kill() here does NOT auto-fire exit, so a test can
 * reproduce a "dead PTY still present in the map" state deterministically.
 */
class MockPty {
  static instances: MockPty[] = []
  pid: number
  cols = 80
  rows = 24
  killCount = 0
  private _dataHandler: DataHandler | null = null
  private _exitHandler: ExitHandler | null = null

  constructor() {
    this.pid = 20000 + MockPty.instances.length
    MockPty.instances.push(this)
  }

  onData(handler: DataHandler) {
    this._dataHandler = handler
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
  }

  /** Drive a stdout chunk through the session's pty data handler. */
  emitData(data: string) {
    this._dataHandler?.(data)
  }

  /** Fire the PTY exit event explicitly (natural shell exit / kill follow-up). */
  emitExit(code = 0) {
    this._exitHandler?.({ exitCode: code })
  }

  get killed(): boolean {
    return this.killCount > 0
  }
}

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => new MockPty()),
}))

describe('Terminal grace/resume bug fixes (B-6)', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    jest.useFakeTimers()
    MockPty.instances = []
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    manager.closeAll()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  // ─── Bug #2: manager cleanup must survive a websocket onExit registration ──
  it('keeps the manager onExit cleanup when a second onExit listener is added (bug #2)', () => {
    const session = manager.createSessionWithId('exit-cleanup')!
    expect(session).not.toBeNull()
    const pty = MockPty.instances[0]

    // The websocket handler registers its own onExit AFTER the manager did.
    // With a single-callback model this overwrites the manager's cleanup.
    let wsExitCalls = 0
    session.onExit(() => {
      wsExitCalls++
    })

    // PTY exits naturally (e.g. user typed `exit`).
    pty.emitExit(0)

    // Both listeners must run: the websocket frame AND the manager cleanup.
    expect(wsExitCalls).toBe(1)
    // RED before fix: manager's onExit was overwritten so the session leaks.
    expect(manager.getSession('exit-cleanup')).toBeUndefined()
    expect(manager.size).toBe(0)
  })

  it('clears the grace timer when the PTY exits after a websocket onExit was added (bug #2)', () => {
    const session = manager.createSessionWithId('exit-grace-clear')!
    const pty = MockPty.instances[0]
    // Websocket-style overwrite of onExit.
    session.onExit(() => {
      /* send exit frame */
    })

    // Disconnect schedules a grace timer for this session.
    manager.closeAllGracefully()

    // The PTY then exits naturally during the grace window. The manager cleanup
    // must run, removing the session AND cancelling the grace timer so the timer
    // cannot later fire against a re-used sessionId.
    pty.emitExit(0)
    expect(manager.getSession('exit-grace-clear')).toBeUndefined()

    // If the grace timer were still pending it would fire here; assert nothing
    // throws and no second kill is scheduled on a now-absent session.
    expect(() => jest.advanceTimersByTime(301 * 1000)).not.toThrow()
    expect(manager.size).toBe(0)
  })

  // ─── Bug #1: re-create after a dead-but-present session must not be killed ──
  it('does not kill a freshly re-created session via an orphaned grace timer (bug #1)', () => {
    // Step 1: open a session.
    const first = manager.createSessionWithId('orphan-timer')!

    // Step 2: a transient disconnect schedules a grace timer for this session.
    manager.closeAllGracefully()

    // Step 3: force the first session into a dead state while it REMAINS in the
    // map (the leaked-dead-session precondition). We mark isAlive()=false
    // directly so the test isolates createSessionWithId's fallthrough logic,
    // independent of how the dead-but-mapped state arose.
    jest.spyOn(first, 'isAlive').mockReturnValue(false)
    expect(first.isAlive()).toBe(false)
    expect(manager.getSession('orphan-timer')).toBe(first)

    // Step 4: the client reconnects with the SAME sessionId. Since the existing
    // session is dead, createSessionWithId falls through and spawns a new live
    // PTY. This must cancel the pending grace timer.
    const second = manager.createSessionWithId('orphan-timer')!
    expect(second).not.toBe(first)
    expect(second.isAlive()).toBe(true)
    const secondPty = MockPty.instances[1]

    // Step 5: advance past the original grace window. RED before fix: the
    // orphaned timer fires, resolves sessions.get('orphan-timer') to the NEW
    // session, and kills the brand-new live session.
    jest.advanceTimersByTime(301 * 1000)
    expect(secondPty.killed).toBe(false)
    expect(second.isAlive()).toBe(true)
    expect(manager.getSession('orphan-timer')).toBe(second)
  })

  // ─── onData/onExit must not accumulate duplicate delivery on resume ────────
  it('delivers stdout/exit exactly once even when handlers are re-registered on resume', () => {
    const session = new TerminalSession('resume-listeners')
    const pty = MockPty.instances[0]

    let dataCalls = 0
    let exitCalls = 0
    // First registration (initial open).
    session.onData(() => {
      dataCalls++
    })
    session.onExit(() => {
      exitCalls++
    })
    // Second registration (resume re-runs handleOpen on the same session). The
    // latest handler should win; a single event must not fan out to stale
    // dead-ws closures from the previous connection.
    session.onData(() => {
      dataCalls++
    })
    session.onExit(() => {
      exitCalls++
    })

    pty.emitData('hello')
    pty.emitExit(0)

    // Exactly one delivery each — not one per past registration.
    expect(dataCalls).toBe(1)
    expect(exitCalls).toBe(1)
  })
})
