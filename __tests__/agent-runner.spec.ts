import * as os from 'os'

import {
  startAgent,
  startProjectAgent,
  setupShutdownHandlers,
  resolveAutoUpdateConfig,
  extractTokenId,
} from '../src/agent-runner'
import { AppSyncSubscriber } from '../src/appsync-subscriber'
import { AGENT_VERSION } from '../src/constants'
import { getSystemInfo, getLocalIpAddress } from '../src/system-info'
import { ApiClient } from '../src/api-client'
import { executeCommand } from '../src/commands'
import { loadConfig, getProjectList, saveConfig } from '../src/config-manager'
import { logger } from '../src/logger'
import { detectChannelFromVersion } from '../src/update-checker'

jest.mock('../src/api-client')
jest.mock('../src/commands')
jest.mock('../src/config-manager')
jest.mock('../src/logger')

const mockForkProject = jest.fn()
const mockStopAll = jest.fn().mockResolvedValue(undefined)
const mockSendUpdateToAll = jest.fn()
const mockSendTokenUpdate = jest.fn()
const mockGetRunningCount = jest.fn().mockReturnValue(0)
const mockIsAnyBusy = jest.fn().mockResolvedValue(false)
jest.mock('../src/child-process-manager', () => ({
  ChildProcessManager: jest.fn().mockImplementation(() => ({
    forkProject: mockForkProject,
    stopAll: mockStopAll,
    sendUpdateToAll: mockSendUpdateToAll,
    sendTokenUpdate: mockSendTokenUpdate,
    getRunningCount: mockGetRunningCount,
    isAnyBusy: mockIsAnyBusy,
  })),
}))
jest.mock('../src/sentry', () => ({
  initSentry: jest.fn().mockResolvedValue(undefined),
  captureException: jest.fn(),
  flushSentry: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../src/auto-updater', () => ({
  startAutoUpdater: jest.fn().mockReturnValue({ stop: jest.fn() }),
}))
jest.mock('../src/chat-mode-detector', () => ({
  detectAvailableChatModes: jest.fn().mockResolvedValue([]),
  resolveActiveChatMode: jest.fn().mockReturnValue(undefined),
}))
jest.mock('../src/appsync-subscriber', () => ({
  AppSyncSubscriber: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
    onReconnect: jest.fn(),
    disconnect: jest.fn(),
  })),
}))
jest.mock('../src/project-dir', () => ({
  initProjectDir: jest.fn().mockReturnValue('/tmp/test-project'),
}))
jest.mock('../src/project-config-sync', () => ({
  syncProjectConfig: jest.fn().mockResolvedValue({
    configHash: 'default-hash',
    project: { projectCode: 'test-proj', projectName: 'Test' },
    agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
  }),
}))
jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))
jest.mock('../src/pending-result-store', () => ({
  savePendingResult: jest.fn(),
  removePendingResult: jest.fn(),
  submitPendingResults: jest.fn().mockResolvedValue(undefined),
}))

const mockConfigWatcherStop = jest.fn()
let capturedConfigCallbacks: {
  onTokenUpdate?: (projectCode: string, newToken: string) => void
  onProjectAdded?: (project: unknown) => void
  onProjectRemoved?: (projectCode: string) => void
} = {}
jest.mock('../src/config-watcher', () => ({
  startConfigWatcher: jest.fn().mockImplementation(
    (_projects: unknown, callbacks: typeof capturedConfigCallbacks) => {
      capturedConfigCallbacks = callbacks
      return { stop: mockConfigWatcherStop }
    },
  ),
  startTokenWatcher: jest.fn().mockImplementation(
    (_projects: unknown, callback: (projectCode: string, newToken: string) => void) => {
      capturedConfigCallbacks = { onTokenUpdate: callback }
      return { stop: mockConfigWatcherStop }
    },
  ),
}))
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
  const processHandlers = new Map<string, Function[]>()

  beforeEach(() => {
    jest.clearAllMocks()
    capturedConfigCallbacks = {}
    processHandlers.clear()

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    jest.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      const handlers = processHandlers.get(event) ?? []
      handlers.push(handler)
      processHandlers.set(event, handlers)
      return process
    }) as typeof process.on)

    // Default: ApiClient mock setup
    const mockInstance = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      updateToken: jest.fn(),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
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

  it('should use tenantCode/projectCode from --project flag when falling back to env vars', withEnvVars(
    { AI_SUPPORT_AGENT_TOKEN: 'env-token', AI_SUPPORT_AGENT_API_URL: 'http://env-api' },
    async () => {
      mockedLoadConfig.mockReturnValue(null)

      const promise = startAgent({ project: 'mytenant/MYPROJECT' })
      await jest.advanceTimersByTimeAsync(100)
      await promise

      // ApiClient is called with the env API URL and token
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

  it('should use ChildProcessManager for multi-project config (2+ projects)', async () => {
    const { ChildProcessManager } = require('../src/child-process-manager')
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(ChildProcessManager).toHaveBeenCalled()
    expect(mockForkProject).toHaveBeenCalledTimes(2)
    expect(mockForkProject).toHaveBeenCalledWith(
      mockConfig.projects[0],
      'multi-agent',
      expect.objectContaining({ pollInterval: expect.any(Number), heartbeatInterval: expect.any(Number) }),
    )
    expect(mockForkProject).toHaveBeenCalledWith(
      mockConfig.projects[1],
      'multi-agent',
      expect.objectContaining({ pollInterval: expect.any(Number), heartbeatInterval: expect.any(Number) }),
    )
    // ApiClient is created for auto-updater with first project's credentials
    expect(MockApiClient).toHaveBeenCalledWith('http://api-a', 'token-a')
    expect(mockedSaveConfig).toHaveBeenCalled()
  })

  it('should use ChildProcessManager even for single project from config (hot-add support)', async () => {
    const { ChildProcessManager } = require('../src/child-process-manager')
    const mockConfig = {
      agentId: 'single-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(ChildProcessManager).toHaveBeenCalled()
    expect(mockForkProject).toHaveBeenCalledTimes(1)
    expect(MockApiClient).toHaveBeenCalledWith('http://api-a', 'token-a')
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

  it('should call process.exit(1) when CLI apiUrl is invalid', async () => {
    mockedLoadConfig.mockReturnValue(null)

    await expect(startAgent({
      token: 'cli-token',
      apiUrl: 'not-a-url',
    })).rejects.toThrow('process.exit called')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should call process.exit(1) when env apiUrl is invalid', withEnvVars(
    { AI_SUPPORT_AGENT_TOKEN: 'env-token', AI_SUPPORT_AGENT_API_URL: 'not-a-url' },
    async () => {
      mockedLoadConfig.mockReturnValue(null)

      await expect(startAgent({})).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    },
  ))

  it('should not start auto-updater when --no-auto-update is passed', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
      autoUpdate: false,
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).not.toHaveBeenCalled()
  })

  it('should start auto-updater with custom channel for single project from config', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({ updateChannel: 'beta' })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ channel: 'beta' }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('should start auto-updater with ChildProcessManager for multi-project config', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({ updateChannel: 'beta' })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ channel: 'beta' }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('should invoke auto-updater stopAllAgents and sendUpdateError callbacks (single project)', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    // Make heartbeat reject to cover .catch(() => {}) branch
    const mockInstance = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockRejectedValue(new Error('heartbeat failed')),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
    }
    MockApiClient.mockImplementation(() => mockInstance as unknown as ApiClient)

    // Make startAutoUpdater call the callbacks to verify they work
    startAutoUpdater.mockImplementation(
      (_clients: unknown[], _config: unknown, stopAll: () => void, sendError?: (err: string) => void) => {
        stopAll()
        sendError?.('test error')
        return { stop: jest.fn() }
      },
    )

    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).toHaveBeenCalled()

    // Reset mock to default behavior
    startAutoUpdater.mockReturnValue({ stop: jest.fn() })
  })

  it('should invoke auto-updater stopAllAgents and sendUpdateError callbacks (single project from config)', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    // Make heartbeat reject to cover .catch(() => {}) branch
    const mockInstance = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockRejectedValue(new Error('heartbeat failed')),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
    }
    MockApiClient.mockImplementation(() => mockInstance as unknown as ApiClient)

    startAutoUpdater.mockImplementation(
      (_clients: unknown[], _config: unknown, stopAll: () => void, sendError?: (err: string) => void) => {
        stopAll()
        sendError?.('test error')
        return { stop: jest.fn() }
      },
    )

    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).toHaveBeenCalled()

    // Reset mock to default behavior
    startAutoUpdater.mockReturnValue({ stop: jest.fn() })
  })

  it('should invoke auto-updater callbacks with ChildProcessManager (multi project)', async () => {
    const { startAutoUpdater } = require('../src/auto-updater')
    // Make heartbeat reject to cover .catch(() => {}) branch
    const mockInstance = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockRejectedValue(new Error('heartbeat failed')),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
    }
    MockApiClient.mockImplementation(() => mockInstance as unknown as ApiClient)

    startAutoUpdater.mockImplementation(
      (_clients: unknown[], _config: unknown, stopAll: () => void, sendError?: (err: string) => void) => {
        stopAll()
        sendError?.('test error')
        return { stop: jest.fn() }
      },
    )

    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startAutoUpdater).toHaveBeenCalled()
    // stopAll callback should call processManager.stopAll()
    expect(mockStopAll).toHaveBeenCalled()

    // Reset mock to default behavior
    startAutoUpdater.mockReturnValue({ stop: jest.fn() })
  })

  it('should set onUpdateComplete on processManager and exit with DOCKER_UPDATE_EXIT_CODE in Docker mode', async () => {
    const originalEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
    process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }

    // Capture the processManager instance to access onUpdateComplete
    let capturedManager: any = null
    const { ChildProcessManager } = require('../src/child-process-manager')
    ChildProcessManager.mockImplementationOnce(() => {
      capturedManager = {
        forkProject: mockForkProject,
        stopAll: mockStopAll,
        sendUpdateToAll: mockSendUpdateToAll,
        sendTokenUpdate: mockSendTokenUpdate,
        getRunningCount: mockGetRunningCount,
        isAnyBusy: mockIsAnyBusy,
        stopProject: jest.fn(),
        onUpdateComplete: undefined as (() => void) | undefined,
      }
      return capturedManager
    })

    try {
      mockedLoadConfig.mockReturnValue(mockConfig)
      mockedGetProjectList.mockReturnValue(mockConfig.projects)

      const promise = startAgent({})
      await jest.advanceTimersByTimeAsync(100)
      await promise

      expect(capturedManager).not.toBeNull()
      expect(typeof capturedManager.onUpdateComplete).toBe('function')

      // Trigger onUpdateComplete
      capturedManager.onUpdateComplete()
      await jest.advanceTimersByTimeAsync(100)
      await Promise.resolve()

      expect(mockStopAll).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(42)
    } finally {
      mockExit.mockRestore()
      if (originalEnv === undefined) {
        delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
      } else {
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalEnv
      }
    }
  })

  it('should start config watcher and handle token update callback', async () => {
    const { startConfigWatcher } = require('../src/config-watcher')
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startConfigWatcher).toHaveBeenCalledWith(
      mockConfig.projects,
      expect.objectContaining({
        onTokenUpdate: expect.any(Function),
        onProjectAdded: expect.any(Function),
        onProjectRemoved: expect.any(Function),
      }),
    )

    // Invoke the token update callback
    expect(capturedConfigCallbacks.onTokenUpdate).toBeDefined()
    capturedConfigCallbacks.onTokenUpdate!('proj-a', 'new-token')
    expect(mockSendTokenUpdate).toHaveBeenCalledWith('proj-a', 'new-token')
  })

  it('should hot-add project when config watcher detects new project', async () => {
    const mockConfig = {
      agentId: 'multi-agent',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    // Simulate new project added via config watcher
    const newProject = { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' }
    capturedConfigCallbacks.onProjectAdded!(newProject)

    expect(mockForkProject).toHaveBeenCalledWith(
      newProject,
      'multi-agent',
      expect.objectContaining({ pollInterval: expect.any(Number), heartbeatInterval: expect.any(Number) }),
    )
  })

  it('should not start config watcher for CLI direct token', async () => {
    const { startConfigWatcher } = require('../src/config-watcher')
    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(startConfigWatcher).not.toHaveBeenCalled()
  })

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

  it('should register uncaughtException handler that calls captureException and exits', async () => {
    const { captureException } = require('../src/sentry')
    mockedLoadConfig.mockReturnValue(null)

    // Use a non-throwing exit mock for this test
    exitSpy.mockRestore()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    const handlers = processHandlers.get('uncaughtException') ?? []
    expect(handlers.length).toBeGreaterThan(0)

    const error = new Error('test uncaught')
    handlers[0](error)
    await jest.advanceTimersByTimeAsync(100)

    expect(captureException).toHaveBeenCalledWith(error, { handler: 'uncaughtException' })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('test uncaught'))
  })

  it('should register unhandledRejection handler that calls captureException', async () => {
    const { captureException } = require('../src/sentry')
    mockedLoadConfig.mockReturnValue(null)

    // Use a non-throwing exit mock for this test
    exitSpy.mockRestore()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const promise = startAgent({
      token: 'cli-token',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    const handlers = processHandlers.get('unhandledRejection') ?? []
    expect(handlers.length).toBeGreaterThan(0)

    handlers[0]('rejected reason')

    expect(captureException).toHaveBeenCalledWith('rejected reason', { handler: 'unhandledRejection' })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('rejected reason'))
  })

  describe('--project flag filtering', () => {
    it('should filter to matching tenantCode/projectCode when --project is set', async () => {
      const mockConfig = {
        agentId: 'multi-agent',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      }
      mockedLoadConfig.mockReturnValue(mockConfig)
      mockedGetProjectList.mockReturnValue(mockConfig.projects)

      const promise = startAgent({ project: 'mbc/PROJ_A' })
      await jest.advanceTimersByTimeAsync(100)
      await promise

      // Only PROJ_A should be forked
      expect(mockForkProject).toHaveBeenCalledTimes(1)
      expect(mockForkProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectCode: 'PROJ_A', tenantCode: 'mbc' }),
        expect.any(String),
        expect.any(Object),
      )
    })

    it('should call process.exit(1) when --project has no slash (tenantCode is required)', async () => {
      const mockConfig = {
        agentId: 'multi-agent',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      }
      mockedLoadConfig.mockReturnValue(mockConfig)
      mockedGetProjectList.mockReturnValue(mockConfig.projects)

      await expect(startAgent({ project: 'PROJ_A' })).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('should call process.exit(1) when --project has no matching project', async () => {
      const mockConfig = {
        agentId: 'multi-agent',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      }
      mockedLoadConfig.mockReturnValue(mockConfig)
      mockedGetProjectList.mockReturnValue(mockConfig.projects)

      await expect(startAgent({ project: 'mbc/NONEXISTENT' })).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
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
    getVersionInfo: jest.Mock
    getConfig: jest.Mock
    updateToken: jest.Mock
    setTenantCode: jest.Mock
    setProjectCode: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn().mockResolvedValue(undefined),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      updateToken: jest.fn(),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
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

  const project = { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' }
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

  it('should execute commands via subscription and submit results', async () => {
    mockClient.getCommand.mockResolvedValue({
      commandId: 'cmd-1',
      type: 'execute_command',
      payload: { command: 'echo hi' },
    })
    mockedExecuteCommand.mockResolvedValue({ success: true, data: 'hi' })

    const agent = startProjectAgent(project, 'agent-1', intervals)

    // Let registerAndStart run
    await jest.advanceTimersByTimeAsync(100)

    // Get the subscriber mock instance and trigger a notification
    const MockAppSyncSubscriber = AppSyncSubscriber as jest.MockedClass<typeof AppSyncSubscriber>
    const subscriberInstance = MockAppSyncSubscriber.mock.results[0]?.value
    const onMessage = subscriberInstance.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
    onMessage({
      id: 'notif-1',
      table: 'commands',
      pk: 'CMD#123',
      sk: 'CMD#123',
      tenantCode: 'test-tenant',
      action: 'agent-command',
      content: { commandId: 'cmd-1', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
    })

    await jest.advanceTimersByTimeAsync(100)

    expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-1', 'test-id')
    expect(mockedExecuteCommand).toHaveBeenCalledWith('execute_command', { command: 'echo hi' }, expect.objectContaining({ commandId: 'cmd-1', client: mockClient, serverConfig: expect.any(Object), agentId: 'test-id' }))
    expect(mockClient.submitResult).toHaveBeenCalledWith('cmd-1', { success: true, data: 'hi' }, 'test-id')

    agent.stop()
  })

  it('should handle command execution error and log resultSendFailed', async () => {
    mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
    mockClient.submitResult.mockRejectedValue(new Error('Submit failed'))

    const agent = startProjectAgent(project, 'agent-1', intervals)

    await jest.advanceTimersByTimeAsync(100)

    // Get the subscriber mock instance and trigger a notification
    const MockAppSyncSubscriber = AppSyncSubscriber as jest.MockedClass<typeof AppSyncSubscriber>
    const subscriberInstance = MockAppSyncSubscriber.mock.results[0]?.value
    const onMessage = subscriberInstance.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
    onMessage({
      id: 'notif-err',
      table: 'commands',
      pk: 'CMD#123',
      sk: 'CMD#123',
      tenantCode: 'test-tenant',
      action: 'agent-command',
      content: { commandId: 'cmd-2', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
    })

    await jest.advanceTimersByTimeAsync(100)

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
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should register SIGINT and SIGTERM handlers', () => {
    const processOnSpy = jest.spyOn(process, 'on')
    const agents = [{ stop: jest.fn() }]

    setupShutdownHandlers({ kind: 'agents', agents })

    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

    processOnSpy.mockRestore()
  })

  it('should only execute shutdown once when both SIGINT and SIGTERM fire', async () => {
    let sigintHandler: (() => void) | undefined
    let sigtermHandler: (() => void) | undefined
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') {
        sigintHandler = handler as () => void
      } else if (event === 'SIGTERM') {
        sigtermHandler = handler as () => void
      }
      return process
    })
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const agents = [{ stop: jest.fn() }]
    setupShutdownHandlers({ kind: 'agents', agents })

    // Fire both signals simultaneously
    sigintHandler!()
    sigtermHandler!()

    // Wait for async shutdown
    await new Promise((resolve) => setTimeout(resolve, 10))

    // stop should be called only once
    expect(agents[0].stop).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)

    processOnSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('should call stop on all agents and exit(0) when signal fires', async () => {
    let sigintHandler: (() => void) | undefined
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') {
        sigintHandler = handler as () => void
      }
      return process
    })
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const agents = [{ stop: jest.fn() }, { stop: jest.fn() }]
    setupShutdownHandlers({ kind: 'agents', agents })

    // Invoke the SIGINT handler (now wraps an async function)
    expect(sigintHandler).toBeDefined()
    sigintHandler!()

    // Wait for the async shutdown to complete
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(agents[0].stop).toHaveBeenCalled()
    expect(agents[1].stop).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)

    processOnSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('should call processManager.stopAll when processManager is provided', async () => {
    const { ChildProcessManager } = require('../src/child-process-manager')
    const pm = new ChildProcessManager()

    let sigintHandler: (() => void) | undefined
    const processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'SIGINT') {
        sigintHandler = handler as () => void
      }
      return process
    })
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    setupShutdownHandlers({ kind: 'processManager', processManager: pm })

    sigintHandler!()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockStopAll).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)

    processOnSpy.mockRestore()
    exitSpy.mockRestore()
  })
})

describe('resolveAutoUpdateConfig', () => {
  it('should use detected channel from AGENT_VERSION when no explicit channel', () => {
    const expectedChannel = detectChannelFromVersion(AGENT_VERSION)
    const result = resolveAutoUpdateConfig({})
    expect(result.channel).toBe(expectedChannel)
    expect(result.enabled).toBe(true)
    expect(result.autoRestart).toBe(true)
  })

  it('should prefer CLI updateChannel over detected channel', () => {
    const result = resolveAutoUpdateConfig({ updateChannel: 'beta' })
    expect(result.channel).toBe('beta')
  })

  it('should prefer config channel over detected channel', () => {
    const result = resolveAutoUpdateConfig({}, { autoUpdate: { enabled: true, autoRestart: true, channel: 'alpha' } })
    expect(result.channel).toBe('alpha')
  })

  it('should prefer CLI updateChannel over config channel', () => {
    const result = resolveAutoUpdateConfig(
      { updateChannel: 'beta' },
      { autoUpdate: { enabled: true, autoRestart: true, channel: 'alpha' } },
    )
    expect(result.channel).toBe('beta')
  })

  it('should disable auto-update when autoUpdate is false', () => {
    const result = resolveAutoUpdateConfig({ autoUpdate: false })
    expect(result.enabled).toBe(false)
  })
})

describe('extractTokenId', () => {
  it('should extract tokenId from valid token format', () => {
    expect(extractTokenId('mbc:abc-123-uuid:raw-secret-token')).toBe('abc-123-uuid')
  })

  it('should return undefined when token has more than 3 parts (invalid format)', () => {
    expect(extractTokenId('tenant:token-id:raw:token:with:colons')).toBeUndefined()
  })

  it('should return undefined when token has fewer than 3 parts', () => {
    expect(extractTokenId('tenant:tokenId')).toBeUndefined()
  })

  it('should return undefined when token has no colons', () => {
    expect(extractTokenId('invalidtoken')).toBeUndefined()
  })

  it('should return empty string when tokenId part is empty', () => {
    expect(extractTokenId('tenant::rawtoken')).toBe('')
  })
})

describe('startAgent tokenId-based agentId', () => {
  let mockRegister: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
    jest.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on)
    jest.useFakeTimers()

    mockRegister = jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' })
    const mockInstance = {
      register: mockRegister,
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      updateToken: jest.fn(),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
    }
    ;(ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => mockInstance as unknown as ApiClient)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('should use tokenId from CLI token as agentId in register call', async () => {
    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'mbc:cli-token-id:raw-secret',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    // register is called with tokenId as agentId
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'cli-token-id' }),
    )
  })

  it('should use tokenId from env token as agentId in register call', async () => {
    const saved = process.env.AI_SUPPORT_AGENT_TOKEN
    const savedUrl = process.env.AI_SUPPORT_AGENT_API_URL
    process.env.AI_SUPPORT_AGENT_TOKEN = 'tenant:env-token-id:raw-secret'
    process.env.AI_SUPPORT_AGENT_API_URL = 'http://env-api'
    try {
      mockedLoadConfig.mockReturnValue(null)

      const promise = startAgent({})
      await jest.advanceTimersByTimeAsync(100)
      await promise

      expect(mockRegister).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'env-token-id' }),
      )
    } finally {
      if (saved === undefined) delete process.env.AI_SUPPORT_AGENT_TOKEN
      else process.env.AI_SUPPORT_AGENT_TOKEN = saved
      if (savedUrl === undefined) delete process.env.AI_SUPPORT_AGENT_API_URL
      else process.env.AI_SUPPORT_AGENT_API_URL = savedUrl
    }
  })

  it('should use tokenId from config project token as agentId in forkProject', async () => {
    const mockConfig = {
      agentId: 'ignored-agent-id',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'mbc:config-token-id:raw-secret', apiUrl: 'http://api-a' },
      ],
    }
    mockedLoadConfig.mockReturnValue(mockConfig)
    mockedGetProjectList.mockReturnValue(mockConfig.projects)

    const promise = startAgent({})
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(mockForkProject).toHaveBeenCalledWith(
      expect.any(Object),
      'config-token-id',
      expect.any(Object),
    )
  })

  it('should fall back to hostname when CLI token has no colons', async () => {
    mockedLoadConfig.mockReturnValue(null)

    const promise = startAgent({
      token: 'legacy-token-without-colons',
      apiUrl: 'http://cli-api',
    })
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: os.hostname() }),
    )
  })
})
