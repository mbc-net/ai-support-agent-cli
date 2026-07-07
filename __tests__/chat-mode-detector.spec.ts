import { execFile } from 'child_process'
import { EventEmitter } from 'events'

import { detectAvailableChatModes, resolveActiveChatMode } from '../src/chat-mode-detector'
import { resolveCodexInvocation } from '../src/commands/codex-command'

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}))
jest.mock('../src/commands/codex-command', () => ({
  resolveCodexInvocation: jest.fn(() => ({
    command: 'codex',
    argsPrefix: [],
    displayCommand: 'codex',
  })),
}))

const mockExecFile = execFile as unknown as jest.Mock
const mockResolveCodexInvocation = resolveCodexInvocation as unknown as jest.Mock

function mockCommandAvailability(availability: Record<string, boolean>): void {
  mockExecFile.mockImplementation(
    (cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
      callback(availability[cmd] ? null : new Error('ENOENT'))
      return { on: jest.fn() }
    },
  )
}

describe('detectAvailableChatModes', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetAllMocks()
    mockResolveCodexInvocation.mockReturnValue({
      command: 'codex',
      argsPrefix: [],
      displayCommand: 'codex',
    })
    process.env = { ...originalEnv }
    delete process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should detect claude_code when CLI is available', async () => {
    mockCommandAvailability({ claude: true, codex: false })

    const modes = await detectAvailableChatModes()

    expect(modes).toContain('claude_code')
    expect(modes).not.toContain('codex')
  })

  it('should not detect claude_code when CLI is unavailable', async () => {
    mockCommandAvailability({ claude: false, codex: false })

    const modes = await detectAvailableChatModes()

    expect(modes).not.toContain('claude_code')
  })

  it('should detect codex when CLI is available', async () => {
    mockCommandAvailability({ claude: false, codex: true })

    const modes = await detectAvailableChatModes()

    expect(modes).toEqual(['codex'])
  })

  it('should detect api when ANTHROPIC_API_KEY is set', async () => {
    mockCommandAvailability({ claude: false, codex: false })
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    const modes = await detectAvailableChatModes()

    expect(modes).toContain('api')
  })

  it('should not detect api when ANTHROPIC_API_KEY is not set', async () => {
    mockCommandAvailability({ claude: true, codex: true })

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

  it('should detect all modes when all are available', async () => {
    mockCommandAvailability({ claude: true, codex: true })
    process.env.ANTHROPIC_API_KEY = 'sk-test'

    const modes = await detectAvailableChatModes()

    expect(modes).toEqual(['claude_code', 'codex', 'api'])
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
    const result = resolveActiveChatMode(['claude_code', 'codex', 'api'])

    expect(result).toBe('claude_code')
  })

  it('should auto-detect codex before api when claude_code is unavailable', () => {
    const result = resolveActiveChatMode(['codex', 'api'])

    expect(result).toBe('codex')
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
