/**
 * Tests for src/oneshot-runner.ts
 *
 * The oneshot runner is the ECS-container entry flow:
 *   getCommand -> executeCommand -> submitResult -> exit code
 * with no register/heartbeat/AppSync involvement.
 */

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockGetCommand = jest.fn()
const mockSubmitResult = jest.fn()
const mockSetTenantCode = jest.fn()
const mockSetProjectCode = jest.fn()
const mockApiClientCtor = jest.fn()

jest.mock('../src/api-client', () => ({
  ApiClient: class {
    getCommand = mockGetCommand
    submitResult = mockSubmitResult
    setTenantCode = mockSetTenantCode
    setProjectCode = mockSetProjectCode
    constructor(...args: unknown[]) {
      mockApiClientCtor(...args)
    }
  },
}))

const mockExecuteCommand = jest.fn()
jest.mock('../src/commands', () => ({
  executeCommand: (...args: unknown[]) => mockExecuteCommand(...args),
}))

import { readOneshotEnv, runOneshot, runOneshotFromEnv } from '../src/oneshot-runner'
import { logger } from '../src/logger'

const SECRET_TOKEN = 'oneshot-token-secret'

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    COMMAND_ID: 'cmd-123',
    AGENT_ID: 'ecs-agent-1',
    TENANT_CODE: 'mbc',
    PROJECT_CODE: 'MBC_01',
    API_BASE_URL: 'https://api.example.com',
    AGENT_ONESHOT_TOKEN: SECRET_TOKEN,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetCommand.mockResolvedValue({
    commandId: 'cmd-123',
    type: 'execute_command',
    payload: { command: 'echo hello' },
    status: 'PENDING',
    createdAt: 1,
  })
  mockExecuteCommand.mockResolvedValue({ success: true, data: { stdout: 'hello' } })
  mockSubmitResult.mockResolvedValue(undefined)
})

describe('readOneshotEnv', () => {
  it('returns the parsed environment', () => {
    expect(readOneshotEnv(validEnv())).toEqual({
      commandId: 'cmd-123',
      agentId: 'ecs-agent-1',
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
      apiBaseUrl: 'https://api.example.com',
      token: SECRET_TOKEN,
    })
  })

  it('throws listing every missing variable', () => {
    expect(() => readOneshotEnv(validEnv({ COMMAND_ID: undefined, AGENT_ONESHOT_TOKEN: '' })))
      .toThrow('Oneshot mode requires environment variables: COMMAND_ID, AGENT_ONESHOT_TOKEN')
  })
})

describe('runOneshot', () => {
  it('fetches, executes, submits, and returns 0 on success', async () => {
    const code = await runOneshot(validEnv())

    expect(code).toBe(0)
    expect(mockApiClientCtor).toHaveBeenCalledWith('https://api.example.com', SECRET_TOKEN)
    expect(mockSetTenantCode).toHaveBeenCalledWith('mbc')
    expect(mockSetProjectCode).toHaveBeenCalledWith('MBC_01')
    expect(mockGetCommand).toHaveBeenCalledWith('cmd-123', 'ecs-agent-1')
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'execute_command',
      // cwd is pinned to the container working dir when the payload omits it
      { command: 'echo hello', cwd: '/workspace' },
      expect.objectContaining({
        commandId: 'cmd-123',
        agentId: 'ecs-agent-1',
        tenantCode: 'mbc',
      }),
    )
    expect(mockSubmitResult).toHaveBeenCalledWith(
      'cmd-123',
      { success: true, data: { stdout: 'hello' } },
      'ecs-agent-1',
    )
  })

  it('returns 1 with a clear fatal error when env vars are missing', async () => {
    const code = await runOneshot(validEnv({ API_BASE_URL: undefined }))

    expect(code).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('API_BASE_URL'))
    expect(mockApiClientCtor).not.toHaveBeenCalled()
    expect(mockGetCommand).not.toHaveBeenCalled()
  })

  it('preserves an explicit cwd from the command payload', async () => {
    mockGetCommand.mockResolvedValue({
      commandId: 'cmd-123',
      type: 'execute_command',
      payload: { command: 'ls', cwd: '/srv/app' },
      status: 'PENDING',
      createdAt: 1,
    })

    await runOneshot(validEnv())

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'execute_command',
      { command: 'ls', cwd: '/srv/app' },
      expect.anything(),
    )
  })

  it.each(['chat', 'e2e_test', 'file_read', 'ecs_launch'])(
    'rejects the unsupported command type "%s" up front and returns 1',
    async (type) => {
      mockGetCommand.mockResolvedValue({
        commandId: 'cmd-123',
        type,
        payload: {},
        status: 'PENDING',
        createdAt: 1,
      })

      const code = await runOneshot(validEnv())

      expect(code).toBe(1)
      expect(mockExecuteCommand).not.toHaveBeenCalled()
      expect(mockSubmitResult).toHaveBeenCalledWith(
        'cmd-123',
        expect.objectContaining({
          success: false,
          error: expect.stringContaining(`Command type "${type}" is not supported in ECS oneshot mode`),
        }),
        'ecs-agent-1',
      )
    },
  )

  it('submits a failed result and returns 1 when execution fails', async () => {
    mockExecuteCommand.mockResolvedValue({ success: false, error: 'command failed' })

    const code = await runOneshot(validEnv())

    expect(code).toBe(1)
    expect(mockSubmitResult).toHaveBeenCalledWith(
      'cmd-123',
      { success: false, error: 'command failed' },
      'ecs-agent-1',
    )
  })

  it('submits a best-effort failed result and returns 1 when getCommand fails', async () => {
    mockGetCommand.mockRejectedValue(new Error('403 forbidden'))

    const code = await runOneshot(validEnv())

    expect(code).toBe(1)
    expect(mockExecuteCommand).not.toHaveBeenCalled()
    expect(mockSubmitResult).toHaveBeenCalledWith(
      'cmd-123',
      expect.objectContaining({ success: false, error: expect.stringContaining('403 forbidden') }),
      'ecs-agent-1',
    )
  })

  it('returns 1 even when the best-effort submit after getCommand failure also fails', async () => {
    mockGetCommand.mockRejectedValue(new Error('network down'))
    mockSubmitResult.mockRejectedValue(new Error('network down'))

    const code = await runOneshot(validEnv())

    expect(code).toBe(1)
  })

  it('returns 1 when submitResult fails after a successful execution', async () => {
    mockSubmitResult.mockRejectedValue(new Error('500'))

    const code = await runOneshot(validEnv())

    expect(code).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to submit result'))
  })

  it('returns 1 when the API client constructor throws (e.g. invalid URL)', async () => {
    mockApiClientCtor.mockImplementationOnce(() => {
      throw new Error('API URL uses HTTP')
    })

    const code = await runOneshot(validEnv())

    expect(code).toBe(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize API client'))
    expect(mockGetCommand).not.toHaveBeenCalled()
  })

  it('never logs the oneshot token value', async () => {
    await runOneshot(validEnv())

    const mocked = logger as unknown as Record<string, jest.Mock>
    const allText = ['info', 'success', 'error', 'warn', 'debug']
      .flatMap((m) => mocked[m].mock.calls)
      .map((args) => args.map(String).join(' '))
      .join('\n')
    expect(allText).not.toContain(SECRET_TOKEN)
  })
})

describe('runOneshotFromEnv', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it('exits the process with the oneshot exit code', async () => {
    process.env = { ...originalEnv, ...validEnv() } as NodeJS.ProcessEnv
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await runOneshotFromEnv()

    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('logs and exits 1 when the runner rejects unexpectedly', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    await runOneshotFromEnv(() => Promise.reject(new Error('unexpected crash')))

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('unexpected crash'))
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
