import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  RotatingFileWriter,
} from '../src/log-rotator'

/**
 * RotatingFileWriter is small enough to test against the real filesystem;
 * jest's `tmpdir` gives us isolation without mocking `fs`. Each test
 * builds its own scratch directory and tears it down afterward.
 */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotator-spec-'))
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

function sizeOf(filePath: string): number {
  try { return fs.statSync(filePath).size } catch { return -1 }
}

describe('RotatingFileWriter', () => {
  let dir: string
  let active: string

  beforeEach(() => {
    dir = makeTempDir()
    active = path.join(dir, 'agent.out.log')
  })

  afterEach(() => {
    rmrf(dir)
  })

  it('defaults match the values advertised in the service install hint (5MB × 5 generations)', () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(DEFAULT_MAX_FILES).toBe(5)
  })

  it('writes chunks to the active file without rotating when under maxBytes', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 1024, maxFiles: 3 })
    w.write('hello\n')
    w.write('world\n')
    w.close()

    expect(fs.readFileSync(active, 'utf-8')).toBe('hello\nworld\n')
    expect(fs.existsSync(`${active}.1`)).toBe(false)
  })

  it('rotates BEFORE a write that would push the file past maxBytes', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 10, maxFiles: 2 })
    w.write('1234567890') // exactly 10 bytes — still under
    expect(sizeOf(active)).toBe(10)
    expect(fs.existsSync(`${active}.1`)).toBe(false)
    w.write('A')          // would push to 11 → rotate first
    w.close()

    expect(fs.readFileSync(`${active}.1`, 'utf-8')).toBe('1234567890')
    expect(fs.readFileSync(active, 'utf-8')).toBe('A')
  })

  it('does NOT split a single chunk that is itself larger than maxBytes', () => {
    // Multi-byte line / log entry integrity matters more than strict cap.
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 5, maxFiles: 1 })
    w.write('short') // 5 bytes
    w.write('this-is-longer-than-five') // 24 bytes, will rotate first, then write whole chunk
    w.close()

    expect(fs.readFileSync(`${active}.1`, 'utf-8')).toBe('short')
    expect(fs.readFileSync(active, 'utf-8')).toBe('this-is-longer-than-five')
  })

  it('shifts existing generations and drops the oldest beyond maxFiles', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 3, maxFiles: 3 })
    w.write('AAA') // 3 bytes
    w.write('BBB') // rotate: .1 = AAA, active = BBB
    w.write('CCC') // rotate: .2 = AAA, .1 = BBB, active = CCC
    w.write('DDD') // rotate: .3 = AAA, .2 = BBB, .1 = CCC, active = DDD
    w.write('EEE') // rotate: .3 = BBB (AAA dropped), .2 = CCC, .1 = DDD, active = EEE
    w.close()

    expect(fs.readFileSync(active, 'utf-8')).toBe('EEE')
    expect(fs.readFileSync(`${active}.1`, 'utf-8')).toBe('DDD')
    expect(fs.readFileSync(`${active}.2`, 'utf-8')).toBe('CCC')
    expect(fs.readFileSync(`${active}.3`, 'utf-8')).toBe('BBB')
    expect(fs.existsSync(`${active}.4`)).toBe(false)
  })

  it('creates the parent directory on first write if it does not exist yet', () => {
    const nested = path.join(dir, 'a', 'b', 'c', 'agent.out.log')
    const w = new RotatingFileWriter({ filePath: nested, maxBytes: 100 })
    w.write('hi')
    w.close()

    expect(fs.readFileSync(nested, 'utf-8')).toBe('hi')
  })

  it('appends to an existing file (carries over its size for the rotation calculation)', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(active, 'preexisting-')  // 12 bytes
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 15, maxFiles: 1 })
    // 12 + 4 = 16 > 15 → rotate before write
    w.write('NEW!')
    w.close()

    expect(fs.readFileSync(`${active}.1`, 'utf-8')).toBe('preexisting-')
    expect(fs.readFileSync(active, 'utf-8')).toBe('NEW!')
  })

  it('with maxFiles=0, removes the active file on rotate instead of keeping a .1 generation', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 3, maxFiles: 0 })
    w.write('AAA')
    w.write('BBB') // would push to 6 → rotate, but maxFiles=0 → unlink active
    w.close()

    // After the unlink the second write recreated the file with just 'BBB'
    expect(fs.readFileSync(active, 'utf-8')).toBe('BBB')
    expect(fs.existsSync(`${active}.1`)).toBe(false)
  })

  it('tolerates missing intermediate generations during rotation (fresh install)', () => {
    // Fresh install: only the active file exists, .1 .. .N do not.
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 3, maxFiles: 5 })
    w.write('AAA')
    expect(() => w.write('BBB')).not.toThrow()
    w.close()

    expect(fs.readFileSync(`${active}.1`, 'utf-8')).toBe('AAA')
    expect(fs.readFileSync(active, 'utf-8')).toBe('BBB')
  })

  it('rejects maxBytes <= 0 at construction', () => {
    expect(() => new RotatingFileWriter({ filePath: active, maxBytes: 0 })).toThrow(/maxBytes/)
    expect(() => new RotatingFileWriter({ filePath: active, maxBytes: -1 })).toThrow(/maxBytes/)
  })

  it('write(empty) is a no-op (does not even open the file)', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 10 })
    expect(w.write('')).toBe(0)
    expect(w.write(Buffer.alloc(0))).toBe(0)
    w.close()

    expect(fs.existsSync(active)).toBe(false)
  })

  it('close() is idempotent', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 100 })
    w.write('x')
    expect(() => { w.close(); w.close() }).not.toThrow()
  })

  it('returns the byte count of the written chunk', () => {
    const w = new RotatingFileWriter({ filePath: active, maxBytes: 100 })
    expect(w.write('hello')).toBe(5)
    // multi-byte UTF-8 string: utf8 byte count, not character count
    expect(w.write('あ')).toBe(3) // 0xE3 0x81 0x82
    w.close()
  })
})
