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

const mockWriterWrite = jest.fn().mockReturnValue(0)
const mockWriterClose = jest.fn()

jest.mock('../../src/log-rotator', () => ({
  DEFAULT_MAX_BYTES: 5 * 1024 * 1024,
  DEFAULT_MAX_FILES: 5,
  RotatingFileWriter: jest.fn().mockImplementation(() => ({
    write: mockWriterWrite,
    close: mockWriterClose,
  })),
}))

import { EventEmitter } from 'events'
import { Command } from 'commander'

import { parseSize, registerLogRotateCommand, resolveRotateOptions } from '../../src/cli/log-rotate-command'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from '../../src/log-rotator'
import { logger } from '../../src/logger'

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

describe('runLogRotate (via registerLogRotateCommand action)', () => {
  let exitSpy: jest.SpyInstance
  let stdoutWriteSpy: jest.SpyInstance
  let stdinEmitter: EventEmitter
  let processOnSpy: jest.SpyInstance
  const signalHandlers = new Map<string, () => void>()

  function getActionHandler(): (filePath: string, opts: Record<string, unknown>) => void {
    const program = new Command()
    program.exitOverride() // prevent process.exit from commander
    registerLogRotateCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'log-rotate')!
    // Extract the action handler from commander internals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (cmd as any)._actionHandler
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockWriterWrite.mockReturnValue(0)
    mockWriterClose.mockReturnValue(undefined)

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

    stdinEmitter = new EventEmitter()
    jest.spyOn(process.stdin, 'on').mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      stdinEmitter.on(event, handler)
      return process.stdin
    })

    signalHandlers.clear()
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      signalHandlers.set(event, handler)
      return process
    }) as typeof process.on)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stdoutWriteSpy.mockRestore()
    processOnSpy.mockRestore()
    jest.restoreAllMocks()
  })

  it('invokes runLogRotate when commander action fires: data event writes to writer and stdout (tee enabled)', () => {
    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log'])

    const chunk = Buffer.from('hello world')
    stdinEmitter.emit('data', chunk)

    expect(mockWriterWrite).toHaveBeenCalledWith(chunk)
    expect(stdoutWriteSpy).toHaveBeenCalledWith(chunk)
  })

  it('data event does NOT tee to stdout when --no-tee is passed', () => {
    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log', '--no-tee'])

    const chunk = Buffer.from('no tee data')
    stdinEmitter.emit('data', chunk)

    expect(mockWriterWrite).toHaveBeenCalledWith(chunk)
    expect(stdoutWriteSpy).not.toHaveBeenCalled()
  })

  it('on stdin end, closes writer and exits with code 0', () => {
    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log'])

    stdinEmitter.emit('end')

    expect(mockWriterClose).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('on stdin error, closes writer and exits with code 0', () => {
    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log'])

    stdinEmitter.emit('error', new Error('read error'))

    expect(mockWriterClose).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('on write error, logs error, sets exitCode=1, still tees to stdout', () => {
    mockWriterWrite.mockImplementation(() => { throw new Error('disk full') })

    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log'])

    const chunk = Buffer.from('data')
    stdinEmitter.emit('data', chunk)

    expect(logger.error).toHaveBeenCalled()
    // stdout should still receive the chunk (passthrough fallback)
    expect(stdoutWriteSpy).toHaveBeenCalledWith(chunk)

    // on end, exits with exitCode 1
    stdinEmitter.emit('end')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('on write error with no-tee, does NOT tee to stdout', () => {
    mockWriterWrite.mockImplementation(() => { throw new Error('disk full') })

    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log', '--no-tee'])

    const chunk = Buffer.from('data')
    stdinEmitter.emit('data', chunk)

    // No tee on error either
    expect(stdoutWriteSpy).not.toHaveBeenCalled()
  })

  it('registers SIGTERM, SIGINT, SIGHUP handlers that close writer and exit', () => {
    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log'])

    expect(signalHandlers.has('SIGTERM')).toBe(true)
    expect(signalHandlers.has('SIGINT')).toBe(true)
    expect(signalHandlers.has('SIGHUP')).toBe(true)

    signalHandlers.get('SIGTERM')!()
    expect(mockWriterClose).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('calls process.exit(2) when resolveRotateOptions returns error (invalid options)', () => {
    // Make process.exit throw to prevent further execution after exit(2)
    exitSpy.mockImplementation(() => { throw new Error('process.exit called') })

    const program = new Command()
    program.exitOverride()
    registerLogRotateCommand(program)

    // --max-size=0 is invalid (must be > 0)
    expect(() => {
      program.parse(['node', 'test', 'log-rotate', '/var/log/agent.log', '--max-size', '0'])
    }).toThrow('process.exit called')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(logger.error).toHaveBeenCalled()
  })
})
