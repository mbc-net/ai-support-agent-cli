import { execFile } from 'child_process'
import { EventEmitter } from 'events'

import { detectAvailableChatModes, resolveActiveChatMode } from '../src/chat-mode-detector'

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}))

const mockExecFile = execFile as unknown as jest.Mock

describe('detectAvailableChatModes', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetAllMocks()
    process.env = { ...originalEnv }
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should detect claude_code when CLI is available', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        callback(null)
        return { on: jest.fn() }
      },
    )

    const modes = await detectAvailableChatModes()

    expect(modes).toContain('claude_code')
  })

  it('should not detect claude_code when CLI is unavailable', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        callback(new Error('ENOENT'))
        return { on: jest.fn() }
      },
    )

    const modes = await detectAvailableChatModes()

    expect(modes).not.toContain('claude_code')
  })

  it('should detect api when ANTHROPIC_API_KEY is set', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        callback(new Error('ENOENT'))
        return { on: jest.fn() }
      },
    )
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    const modes = await detectAvailableChatModes()

    expect(modes).toContain('api')
  })

  it('should not detect api when ANTHROPIC_API_KEY is not set', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        callback(null)
        return { on: jest.fn() }
      },
    )

    const modes = await detectAvailableChatModes()

    expect(modes).not.toContain('api')
  })

  it('should handle child process error event', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _callback: (err: Error | null) => void) => {
        const child = new EventEmitter()
        // Emit error after a tick (before callback is called)
        process.nextTick(() => child.emit('error', new Error('spawn ENOENT')))
        return child
      },
    )

    const modes = await detectAvailableChatModes()

    expect(modes).not.toContain('claude_code')
  })

  it('should detect both modes when both are available', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
        callback(null)
        return { on: jest.fn() }
      },
    )
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    const modes = await detectAvailableChatModes()

    expect(modes).toEqual(['claude_code', 'api'])
  })
})

describe('resolveActiveChatMode', () => {
  it('should prefer local override when available', () => {
    const result = resolveActiveChatMode(['claude_code', 'api'], 'api')

    expect(result).toBe('api')
  })

  it('should prefer server default when local not set', () => {
    const result = resolveActiveChatMode(['claude_code', 'api'], undefined, 'api')

    expect(result).toBe('api')
  })

  it('should auto-detect claude_code first', () => {
    const result = resolveActiveChatMode(['claude_code', 'api'])

    expect(result).toBe('claude_code')
  })

  it('should fallback when local override is unavailable', () => {
    const result = resolveActiveChatMode(['api'], 'claude_code')

    expect(result).toBe('api')
  })

  it('should fallback when server default is unavailable', () => {
    const result = resolveActiveChatMode(['claude_code'], undefined, 'api')

    expect(result).toBe('claude_code')
  })

  it('should return undefined for empty available list', () => {
    const result = resolveActiveChatMode([])

    expect(result).toBeUndefined()
  })

  it('should return api when only api is available', () => {
    const result = resolveActiveChatMode(['api'])

    expect(result).toBe('api')
  })

  it('should use local override over server default', () => {
    const result = resolveActiveChatMode(['claude_code', 'api'], 'claude_code', 'api')

    expect(result).toBe('claude_code')
  })

  it('should skip local and use server when local is unavailable', () => {
    const result = resolveActiveChatMode(['api'], 'claude_code', 'api')

    expect(result).toBe('api')
  })
})
