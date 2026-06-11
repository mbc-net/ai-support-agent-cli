/**
 * Tests for the TerminalSession scrollback ring buffer and resume meta
 * (reconnect-resilience design 2: scrollback replay).
 *
 * The buffer mirrors every PTY output chunk alongside the live relay and is
 * capped at SCROLLBACK_BUFFER_MAX_BYTES by dropping the OLDEST bytes.
 */

import { SCROLLBACK_BUFFER_MAX_BYTES } from '../../src/terminal/constants'
import { TerminalSession } from '../../src/terminal/terminal-session'
import type { TerminalSessionMeta } from '../../src/terminal/terminal-session'

type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty {
  pid = 4242
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

  /** Synchronously emit PTY output into the session. */
  emitData(data: string) {
    this._dataHandler?.(data)
  }
}

let mockPtyInstance: MockPty

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    mockPtyInstance = new MockPty()
    return mockPtyInstance
  }),
}))

describe('TerminalSession scrollback ring buffer', () => {
  let session: TerminalSession

  afterEach(() => {
    if (session?.isAlive()) {
      session.kill()
    }
  })

  it('returns an empty buffer when no output has been produced', () => {
    session = new TerminalSession('sb-empty')
    expect(session.getScrollbackBuffer().byteLength).toBe(0)
  })

  it('appends output chunks in order (oldest → newest)', () => {
    session = new TerminalSession('sb-append')
    mockPtyInstance.emitData('hello ')
    mockPtyInstance.emitData('world')
    expect(session.getScrollbackBuffer().toString('utf-8')).toBe('hello world')
  })

  it('buffers output in parallel with the live onData relay', () => {
    session = new TerminalSession('sb-parallel')
    const received: string[] = []
    session.onData((d) => received.push(d))
    mockPtyInstance.emitData('live+buffered')
    expect(received).toEqual(['live+buffered'])
    expect(session.getScrollbackBuffer().toString('utf-8')).toBe('live+buffered')
  })

  it('keeps exactly SCROLLBACK_BUFFER_MAX_BYTES at the boundary (no eviction)', () => {
    session = new TerminalSession('sb-boundary')
    const half = SCROLLBACK_BUFFER_MAX_BYTES / 2
    mockPtyInstance.emitData('a'.repeat(half))
    mockPtyInstance.emitData('b'.repeat(half))
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBe(SCROLLBACK_BUFFER_MAX_BYTES)
    // Nothing was dropped: the first byte is still from the first chunk.
    expect(buf.toString('utf-8', 0, 1)).toBe('a')
    expect(buf.toString('utf-8', buf.byteLength - 1)).toBe('b')
  })

  it('evicts the oldest bytes mid-chunk when the cap is exceeded by one byte', () => {
    session = new TerminalSession('sb-evict-one')
    mockPtyInstance.emitData('X' + 'a'.repeat(SCROLLBACK_BUFFER_MAX_BYTES - 1))
    mockPtyInstance.emitData('z') // pushes total to cap + 1 → drop the oldest 'X'
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBe(SCROLLBACK_BUFFER_MAX_BYTES)
    expect(buf.toString('utf-8', 0, 1)).toBe('a') // 'X' was evicted
    expect(buf.toString('utf-8', buf.byteLength - 1)).toBe('z')
  })

  it('drops a whole oldest chunk when the overflow covers it entirely', () => {
    session = new TerminalSession('sb-evict-chunk')
    mockPtyInstance.emitData('old-chunk-to-drop') // 17 bytes, will be fully evicted
    mockPtyInstance.emitData('n'.repeat(SCROLLBACK_BUFFER_MAX_BYTES))
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBe(SCROLLBACK_BUFFER_MAX_BYTES)
    expect(buf.toString('utf-8')).toBe('n'.repeat(SCROLLBACK_BUFFER_MAX_BYTES))
  })

  it('keeps only the newest tail of a single chunk larger than the cap', () => {
    session = new TerminalSession('sb-oversized-chunk')
    const oversized = 'h'.repeat(1000) + 't'.repeat(SCROLLBACK_BUFFER_MAX_BYTES)
    mockPtyInstance.emitData(oversized)
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBe(SCROLLBACK_BUFFER_MAX_BYTES)
    expect(buf.toString('utf-8')).toBe('t'.repeat(SCROLLBACK_BUFFER_MAX_BYTES))
  })

  it('counts multi-byte characters by BYTE length, not string length', () => {
    session = new TerminalSession('sb-multibyte')
    // 'あ' is 3 bytes in UTF-8.
    mockPtyInstance.emitData('あ')
    expect(session.getScrollbackBuffer().byteLength).toBe(3)
    expect(session.getScrollbackBuffer().toString('utf-8')).toBe('あ')
  })

  it('aligns a mid-chunk eviction cut to the next UTF-8 boundary (no mojibake on replay)', () => {
    session = new TerminalSession('sb-utf8-align')
    // Fill to one byte under the cap with 3-byte chars, then overflow by 2
    // ASCII bytes: the byte-exact cut (excess=1) would land inside the first
    // 'あ' sequence and must be advanced to the next character boundary.
    mockPtyInstance.emitData('あ'.repeat(Math.floor(SCROLLBACK_BUFFER_MAX_BYTES / 3)))
    mockPtyInstance.emitData('zz')
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBeLessThanOrEqual(SCROLLBACK_BUFFER_MAX_BYTES)
    const text = buf.toString('utf-8')
    expect(text.includes('�')).toBe(false)
    expect(text.startsWith('あ')).toBe(true)
    expect(text.endsWith('zz')).toBe(true)
  })

  it('aligns the tail cut of an oversized single chunk to a UTF-8 boundary', () => {
    session = new TerminalSession('sb-utf8-oversize')
    // byteLength = 3 * ceil((cap+3)/3) > cap, and cap % 3 !== 0, so the
    // byte-exact tail cut lands mid-sequence and must be advanced.
    mockPtyInstance.emitData('あ'.repeat(Math.ceil((SCROLLBACK_BUFFER_MAX_BYTES + 3) / 3)))
    const buf = session.getScrollbackBuffer()
    expect(buf.byteLength).toBeLessThanOrEqual(SCROLLBACK_BUFFER_MAX_BYTES)
    const text = buf.toString('utf-8')
    expect(text.includes('�')).toBe(false)
    expect(text.startsWith('あ')).toBe(true)
  })
})

describe('TerminalSession resume meta', () => {
  let session: TerminalSession

  afterEach(() => {
    if (session?.isAlive()) {
      session.kill()
    }
  })

  const meta: TerminalSessionMeta = {
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    userId: 'user-1',
  }

  it('records the meta given at creation', () => {
    session = new TerminalSession('meta-recorded', { meta })
    expect(session.getMeta()).toEqual(meta)
  })

  it('returns null when created without meta (legacy open)', () => {
    session = new TerminalSession('meta-absent')
    expect(session.getMeta()).toBeNull()
  })
})
