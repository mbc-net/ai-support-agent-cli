import * as os from 'os'

import {
  startAgent,
  getSystemInfo,
  getLocalIpAddress,
  startProjectAgent,
  setupShutdownHandlers,
} from '../src/agent-runner'
import { ApiClient } from '../src/api-client'
import { executeCommand } from '../src/command-executor'
import { loadConfig, getProjectList, saveConfig } from '../src/config-manager'
import { logger } from '../src/logger'

jest.mock('../src/api-client')
jest.mock('../src/command-executor')
jest.mock('../src/config-manager')
jest.mock('../src/logger')
jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os')
  return {
    ...actual,
    cpus: jest.fn(actual.cpus),
    networkInterfaces: jest.fn(actual.networkInterfaces),
  }
})

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>
const mockedLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockedGetProjectList = getProjectList as jest.MockedFunction<typeof getProjectList>
const mockedSaveConfig = saveConfig as jest.MockedFunction<typeof saveConfig>
const mockedExecuteCommand = executeCommand as jest.MockedFunction<typeof executeCommand>
const mockedCpus = os.cpus as jest.MockedFunction<typeof os.cpus>
const mockedNetworkInterfaces = os.networkInterfaces as jest.MockedFunction<typeof os.networkInterfaces>

const ENV_KEYS = ['AI_SUPPORT_AGENT_TOKEN', 'AI_SUPPORT_AGENT_API_URL'] as const

function withEnvVars(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {}
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
    }
    for (const key of ENV_KEYS) {
      if (key in vars) {
        process.env[key] = vars[key]
      } else {
        delete process.env[key]
      }
    }
    try {
      await fn()
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }
}

describe('agent-runner', () => {
  let exitSpy: jest.Spied<typeof process.exit>

  beforeEach(() => {
    jest.clearAllMocks()

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    jest.spyOn(process, 'on').mockImplementation(() => process)

    // Default: ApiClient mock setup
    const mockInstance = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
    }
    MockApiClient.mockImplementation(() => mockInstance as unknown as ApiClient)

    // Prevent real timers from firing
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('should use CLI token/apiUrl and call runSingleProject', async () => {
    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
    })

    // Let async registerAndStart run
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(MockApiClient).toHaveBeenCalledWith('http://cli-api', 'cli-token')
    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ lastConnected: expect.any(String) }),
    )
  })

  it('should fall back to env vars when no config and no CLI args', withEnvVars(
    { AI_SUPPORT_AGENT_TOKEN: 'env-token', AI_SUPPORT_AGENT_API_URL: 'http://env-api' },
    async () => {
      mockedLoadConfig.mockReturnValue(null)

      const promise = startAgent({})
      await jest.advanceTimersByTimeAsync(100)
      await promise

      expect(MockApiClient).toHaveBeenCalledWith('http://env-api', 'env-token')
    },
  ))

  it('should call process.exit(1) when no config and no env vars', withEnvVars(
    {},
    async () => {
      mockedLoadConfig.mockReturnValue(null)

      await expect(startAgent({})).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    },
  ))

  it('should start all projects from multi-project config', async () => {
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(MockApiClient).toHaveBeenCalledTimes(2)
    expect(MockApiClient).toHaveBeenCalledWith('http://api-a', 'token-a')
    expect(MockApiClient).toHaveBeenCalledWith('http://api-b', 'token-b')
    expect(mockedSaveConfig).toHaveBeenCalled()
  })

  it('should call logger.setVerbose(true) when verbose option is true', withEnvVars(
    { AI_SUPPORT_AGENT_TOKEN: 'test-token', AI_SUPPORT_AGENT_API_URL: 'http://test-api' },
    async () => {
      mockedLoadConfig.mockReturnValue(null)

      const promise = startAgent({ verbose: true })
      await jest.advanceTimersByTimeAsync(100)
      await promise

      expect(logger.setVerbose).toHaveBeenCalledWith(true)
    },
  ))

  it('should call process.exit(1) when config exists but has no projects', async () => {
    const mockConfig = {
      agentId: 'empty-agent',
      createdAt: '2024-01-01',
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue([])

    await expect(startAgent({})).rejects.toThrow('process.exit called')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

describe('getSystemInfo', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should return system info with valid fields', () => {
    const info = getSystemInfo()
    expect(info.platform).toBe(os.platform())
    expect(info.arch).toBe(os.arch())
    expect(typeof info.cpuUsage).toBe('number')
    expect(info.cpuUsage).toBeGreaterThanOrEqual(0)
    expect(typeof info.memoryUsage).toBe('number')
    expect(info.memoryUsage).toBeGreaterThan(0)
    expect(info.memoryUsage).toBeLessThanOrEqual(100)
    expect(typeof info.uptime).toBe('number')
    expect(info.uptime).toBeGreaterThan(0)
  })

  it('should handle zero CPUs gracefully', () => {
    mockedCpus.mockReturnValue([])
    const info = getSystemInfo()
    expect(info.cpuUsage).toBe(0)
  })
})

describe('getLocalIpAddress', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should return undefined when only internal interfaces exist', () => {
    mockedNetworkInterfaces.mockReturnValue({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    })
    expect(getLocalIpAddress()).toBeUndefined()
  })

  it('should skip IPv6 interfaces', () => {
    mockedNetworkInterfaces.mockReturnValue({
      eth0: [
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          mac: '00:00:00:00:00:01',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 0,
        },
      ],
    })
    expect(getLocalIpAddress()).toBeUndefined()
  })
})

describe('startProjectAgent', () => {
  let mockClient: {
    register: jest.Mock
    heartbeat: jest.Mock
    getPendingCommands: jest.Mock
    getCommand: jest.Mock
    submitResult: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn().mockResolvedValue(undefined),
    }
    ;(ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(
      () => mockClient as unknown as ApiClient,
    )
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  const project = { projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' }
  const intervals = { pollInterval: 5000, heartbeatInterval: 30000 }

  it('should log error and not start timers when registration fails', async () => {
    mockClient.register.mockRejectedValue(new Error('Network error'))

    const agent = startProjectAgent(project, 'agent-1', intervals)

    // Let registerAndStart run
    await jest.advanceTimersByTimeAsync(100)

    // t() returns the key when translations are not loaded (logger is mocked)
    expect(logger.error).toHaveBeenCalledWith('runner.registerFailed')

    // Advance well past heartbeat/poll intervals — they should NOT fire
    mockClient.heartbeat.mockClear()
    mockClient.getPendingCommands.mockClear()
    await jest.advanceTimersByTimeAsync(60000)

    expect(mockClient.heartbeat).not.toHaveBeenCalled()
    expect(mockClient.getPendingCommands).not.toHaveBeenCalled()

    agent.stop()
  })

  it('should log warning when heartbeat fails', async () => {
    mockClient.heartbeat.mockRejectedValue(new Error('Heartbeat timeout'))

    const agent = startProjectAgent(project, 'agent-1', intervals)

    // Let registerAndStart run (includes initial heartbeat)
    await jest.advanceTimersByTimeAsync(100)

    expect(logger.warn).toHaveBeenCalledWith('runner.heartbeatFailed')

    agent.stop()
  })

  it('should poll, execute commands, and submit results', async () => {
    mockClient.getPendingCommands.mockResolvedValue([
      { commandId: 'cmd-1', type: 'execute_command' },
    ])
    mockClient.getCommand.mockResolvedValue({
      commandId: 'cmd-1',
      type: 'execute_command',
      payload: { command: 'echo hi' },
    })
    mockedExecuteCommand.mockResolvedValue({ success: true, data: 'hi' })

    const agent = startProjectAgent(project, 'agent-1', intervals)

    // Let registerAndStart run
    await jest.advanceTimersByTimeAsync(100)

    // Trigger poll interval
    await jest.advanceTimersByTimeAsync(intervals.pollInterval)

    expect(mockClient.getPendingCommands).toHaveBeenCalled()
    expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-1')
    expect(mockedExecuteCommand).toHaveBeenCalledWith('execute_command', { command: 'echo hi' })
    expect(mockClient.submitResult).toHaveBeenCalledWith('cmd-1', { success: true, data: 'hi' })

    agent.stop()
  })

  it('should handle command execution error and log resultSendFailed', async () => {
    mockClient.getPendingCommands.mockResolvedValue([
      { commandId: 'cmd-2', type: 'execute_command' },
    ])
    mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
    mockClient.submitResult.mockRejectedValue(new Error('Submit failed'))

    const agent = startProjectAgent(project, 'agent-1', intervals)

    await jest.advanceTimersByTimeAsync(100)

    // Trigger poll
    await jest.advanceTimersByTimeAsync(intervals.pollInterval)

    expect(logger.error).toHaveBeenCalledWith('runner.commandError')
    expect(logger.error).toHaveBeenCalledWith('runner.resultSendFailed')

    agent.stop()
  })

  it('should clear timers on stop()', async () => {
    const agent = startProjectAgent(project, 'agent-1', intervals)

    await jest.advanceTimersByTimeAsync(100)

    agent.stop()

    // Reset mocks after stop
    mockClient.heartbeat.mockClear()
    mockClient.getPendingCommands.mockClear()

    // Advance past intervals — should NOT fire
    await jest.advanceTimersByTimeAsync(60000)

    expect(mockClient.heartbeat).not.toHaveBeenCalled()
    expect(mockClient.getPendingCommands).not.toHaveBeenCalled()
  })
})

describe('setupShutdownHandlers', () => {
  it('should register SIGINT and SIGTERM handlers', () => {
    const processOnSpy = jest.spyOn(process, 'on')
    const agents = [{ stop: jest.fn() }]

    setupShutdownHandlers(agents)

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

    processOnSpy.mockRestore()
  })

  it('should call stop on all agents and exit(0) when signal fires', () => {
    let sigintHandler: (() => void) | undefined
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') {
        sigintHandler = handler as () => void
      }
      return process
    })
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const agents = [{ stop: jest.fn() }, { stop: jest.fn() }]
    setupShutdownHandlers(agents)

    // Invoke the SIGINT handler
    expect(sigintHandler).toBeDefined()
    sigintHandler!()

    expect(agents[0].stop).toHaveBeenCalled()
    expect(agents[1].stop).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)

    processOnSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
