/**
 * Tests for TerminalSessionManager.resumeSession() — the resume-only lookup
 * used by `open { resume: true }` (reconnect-resilience design 1).
 *
 * A resume-only open must NEVER spawn a new PTY (no-fallback rule): it either
 * reattaches to an existing live PTY whose recorded meta exactly matches, or
 * fails with 'not_found' | 'dead' | 'meta_mismatch'.
 */

import * as pty from 'node-pty'

import { SESSION_GRACE_TIMEOUT_MS } from '../../src/terminal/constants'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'
import type { TerminalSessionMeta } from '../../src/terminal/terminal-session'

type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty {
  pid = 7777
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
    /* no-op */
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

const spawnMock = pty.spawn as unknown as jest.Mock

const meta: TerminalSessionMeta = {
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  userId: 'user-1',
}

describe('TerminalSessionManager.resumeSession', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    spawnMock.mockClear()
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    manager.closeAll()
  })

  it('fails with not_found for an unknown sessionId and does NOT spawn', () => {
    const result = manager.resumeSession('no-such-session', meta)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(manager.size).toBe(0)
  })

  it('resumes the existing session when meta matches exactly (no new spawn)', () => {
    const created = manager.createSessionWithId('resume-ok', { meta })
    expect(created).not.toBeNull()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const result = manager.resumeSession('resume-ok', { ...meta })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.session).toBe(created)
    }
    // Resume must reattach, never spawn.
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['tenantCode', { ...meta, tenantCode: 'other' }],
    ['projectCode', { ...meta, projectCode: 'OTHER_01' }],
    ['userId', { ...meta, userId: 'user-2' }],
  ])('fails with meta_mismatch when %s differs and does NOT spawn', (_field, presented) => {
    manager.createSessionWithId('resume-mismatch', { meta })
    spawnMock.mockClear()

    const result = manager.resumeSession('resume-mismatch', presented as TerminalSessionMeta)
    expect(result).toEqual({ ok: false, reason: 'meta_mismatch' })
    expect(spawnMock).not.toHaveBeenCalled()
    // The existing PTY is left untouched.
    expect(manager.getSession('resume-mismatch')?.isAlive()).toBe(true)
  })

  it('fails with meta_mismatch when the session has meta but the resume presents none', () => {
    manager.createSessionWithId('resume-no-presented-meta', { meta })
    const result = manager.resumeSession('resume-no-presented-meta')
    expect(result).toEqual({ ok: false, reason: 'meta_mismatch' })
  })

  it('fails with meta_mismatch when the session has no meta but the resume presents one', () => {
    manager.createSessionWithId('resume-no-recorded-meta')
    const result = manager.resumeSession('resume-no-recorded-meta', meta)
    expect(result).toEqual({ ok: false, reason: 'meta_mismatch' })
  })

  it('fails with meta_mismatch when neither side has meta (meta-less resume is never legitimate)', () => {
    // A resume-capable API always attaches meta to resume opens, and a legacy
    // API never sends resume:true (it reconnects via createSessionWithId), so
    // a meta-less resume must be refused to prevent sessionId-only takeover.
    const created = manager.createSessionWithId('resume-legacy')
    expect(created).not.toBeNull()
    const result = manager.resumeSession('resume-legacy')
    expect(result).toEqual({ ok: false, reason: 'meta_mismatch' })
  })

  it('fails with dead when the session exists but its PTY already exited (no spawn)', () => {
    const created = manager.createSessionWithId('resume-dead', { meta })
    expect(created).not.toBeNull()
    spawnMock.mockClear()
    // Force the still-mapped session into the exited state (defensive branch:
    // normally the internal exit callback removes it from the map first).
    jest.spyOn(created!, 'isAlive').mockReturnValue(false)

    const result = manager.resumeSession('resume-dead', meta)
    expect(result).toEqual({ ok: false, reason: 'dead' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  describe('grace timer interaction', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      manager.closeAll()
      jest.useRealTimers()
    })

    it('cancels the pending grace timer on a successful resume', () => {
      const created = manager.createSessionWithId('resume-grace-ok', { meta })
      manager.closeAllGracefully()

      const result = manager.resumeSession('resume-grace-ok', meta)
      expect(result.ok).toBe(true)

      jest.advanceTimersByTime(SESSION_GRACE_TIMEOUT_MS + 1000)
      // The resume cancelled the timer: the PTY survives past the grace window.
      expect(manager.getSession('resume-grace-ok')).toBe(created)
      expect(created!.isAlive()).toBe(true)
    })

    it('leaves the grace timer armed when the resume fails (session is reaped later)', () => {
      manager.createSessionWithId('resume-grace-fail', { meta })
      manager.closeAllGracefully()

      const result = manager.resumeSession('resume-grace-fail', {
        ...meta,
        userId: 'intruder',
      })
      expect(result).toEqual({ ok: false, reason: 'meta_mismatch' })

      jest.advanceTimersByTime(SESSION_GRACE_TIMEOUT_MS + 1000)
      // The failed resume did not cancel grace: the session was reaped.
      expect(manager.getSession('resume-grace-fail')).toBeUndefined()
    })
  })
})
