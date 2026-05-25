jest.mock('../../src/logger')
jest.mock('../../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{{${k}}}`, String(v))
      }
      return result
    }
    return key
  },
}))

import { Command } from 'commander'

import { parseSize, registerLogRotateCommand, resolveRotateOptions } from '../../src/cli/log-rotate-command'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from '../../src/log-rotator'

describe('parseSize', () => {
  it('parses bare bytes', () => {
    expect(parseSize('1024')).toBe(1024)
    expect(parseSize('0')).toBe(0)
  })

  it('parses KB/MB/GB suffixes (case-insensitive)', () => {
    expect(parseSize('1KB')).toBe(1024)
    expect(parseSize('5mb')).toBe(5 * 1024 * 1024)
    expect(parseSize('2 GB')).toBe(2 * 1024 * 1024 * 1024)
    expect(parseSize('  10MB  ')).toBe(10 * 1024 * 1024)
  })

  it('parses fractional values', () => {
    expect(parseSize('0.5MB')).toBe(Math.floor(0.5 * 1024 * 1024))
    expect(parseSize('1.5KB')).toBe(1536)
  })

  it('returns null for malformed input', () => {
    expect(parseSize('')).toBeNull()
    expect(parseSize('abc')).toBeNull()
    expect(parseSize('5XB')).toBeNull()       // unknown unit
    expect(parseSize('-5MB')).toBeNull()      // negative
    expect(parseSize('5MB extra')).toBeNull() // trailing garbage
  })

  it('explicit B suffix is treated as bytes', () => {
    expect(parseSize('512B')).toBe(512)
  })
})

describe('registerLogRotateCommand', () => {
  it('registers a log-rotate command on the program', () => {
    const program = new Command()
    registerLogRotateCommand(program)

    const cmd = program.commands.find((c) => c.name() === 'log-rotate')
    expect(cmd).toBeDefined()
    expect(cmd!.description()).toBe('cmd.logRotate')
  })

  it('exposes --max-size, --max-files, and --no-tee flags', () => {
    const program = new Command()
    registerLogRotateCommand(program)

    const cmd = program.commands.find((c) => c.name() === 'log-rotate')!
    const optionFlags = cmd.options.map((o) => o.flags)
    expect(optionFlags.some((f) => f.includes('--max-size'))).toBe(true)
    expect(optionFlags.some((f) => f.includes('--max-files'))).toBe(true)
    // commander encodes `--no-tee` as a positive boolean `--tee` with default true
    expect(optionFlags.some((f) => f.includes('--no-tee'))).toBe(true)
  })

  it('argument <path> is registered as required', () => {
    const program = new Command()
    registerLogRotateCommand(program)

    const cmd = program.commands.find((c) => c.name() === 'log-rotate')!
    const args = cmd.registeredArguments
    expect(args.length).toBe(1)
    expect(args[0].name()).toBe('path')
    expect(args[0].required).toBe(true)
  })
})

describe('resolveRotateOptions', () => {
  it('defaults to 5MB × 5 generations × tee=true when nothing is specified', () => {
    const r = resolveRotateOptions({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.maxBytes).toBe(DEFAULT_MAX_BYTES)
      expect(r.value.maxFiles).toBe(DEFAULT_MAX_FILES)
      expect(r.value.teeEnabled).toBe(true)
    }
  })

  it('parses --max-size=10MB and --max-files=3', () => {
    const r = resolveRotateOptions({ maxSize: '10MB', maxFiles: '3' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.maxBytes).toBe(10 * 1024 * 1024)
      expect(r.value.maxFiles).toBe(3)
    }
  })

  it('honours --no-tee (commander sets tee: false)', () => {
    const r = resolveRotateOptions({ tee: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.teeEnabled).toBe(false)
  })

  it('rejects invalid --max-size with a localized error', () => {
    const r = resolveRotateOptions({ maxSize: 'abc' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('logRotate.invalidMaxSize')
  })

  it('rejects 0 / negative --max-size', () => {
    const r1 = resolveRotateOptions({ maxSize: '0' })
    expect(r1.ok).toBe(false)
    const r2 = resolveRotateOptions({ maxSize: '-1MB' })
    expect(r2.ok).toBe(false)
  })

  it('rejects invalid --max-files with a localized error', () => {
    const r = resolveRotateOptions({ maxFiles: 'not-a-number' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('logRotate.invalidMaxFiles')
  })

  it('rejects negative --max-files', () => {
    const r = resolveRotateOptions({ maxFiles: '-1' })
    expect(r.ok).toBe(false)
  })

  it('accepts --max-files=0 (no history kept)', () => {
    const r = resolveRotateOptions({ maxFiles: '0' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.maxFiles).toBe(0)
  })

  // --max-files must be a strict integer. parseInt() would silently truncate
  // these inputs (`5.9` → 5, `3abc` → 3), giving the operator a surprising
  // value instead of the localized error parseSize gives for the same shape.
  it.each(['5.9', '3.5', '3abc', '7 garbage', '5x', '1e3'])(
    'rejects non-integer --max-files=%s',
    (value) => {
      const r = resolveRotateOptions({ maxFiles: value })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('logRotate.invalidMaxFiles')
    },
  )
})
