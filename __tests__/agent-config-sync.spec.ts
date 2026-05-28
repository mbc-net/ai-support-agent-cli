/**
 * Tests for src/agent-config-sync.ts
 *
 * Covers: performConfigSync, performSetup, scheduleConfigSync, refreshChatMode,
 * resolveMcpServerPath (functions not covered by existing split spec files).
 */

import * as fs from 'fs'
import * as path from 'path'

import type { ApiClient } from '../src/api-client'
import type { ConfigSyncDeps, ConfigSyncState } from '../src/agent-config-sync'
import type { AgentServerConfig, ProjectConfigResponse } from '../src/types'

// Mocks must be declared before imports that use them
jest.mock('../src/logger')
jest.mock('fs')

const mockSyncProjectConfig = jest.fn()
jest.mock('../src/project-config-sync', () => ({
  syncProjectConfig: mockSyncProjectConfig,
}))

const mockApplyProjectConfig = jest.fn()
const mockSyncRepositories = jest.fn()
jest.mock('../src/repo-sync', () => ({
  syncRepositories: mockSyncRepositories,
  syncRepositoryByCode: jest.fn(),
}))

jest.mock('../src/project-dir', () => ({
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
  getSshDir: jest.fn((dir: string) => `${dir}/.ssh`),
}))

const mockDetectAvailableChatModes = jest.fn()
const mockResolveActiveChatMode = jest.fn()
jest.mock('../src/chat-mode-detector', () => ({
  detectAvailableChatModes: mockDetectAvailableChatModes,
  resolveActiveChatMode: mockResolveActiveChatMode,
}))

jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))
jest.mock('../src/mcp/config-writer', () => ({
  writeMcpConfig: jest.fn().mockReturnValue('/tmp/mcp.json'),
}))
jest.mock('../src/ssh-config-setup', () => ({
  setupSshConfig: jest.fn(),
}))

const mockedFs = fs as jest.Mocked<typeof fs>

import {
  performConfigSync,
  performSetup,
  scheduleConfigSync,
  refreshChatMode,
  resolveMcpServerPath,
} from '../src/agent-config-sync'
import { CONFIG_SYNC_DEBOUNCE_MS } from '../src/constants'

function makeDeps(overrides?: Partial<ConfigSyncDeps>): ConfigSyncDeps {
  return {
    client: {} as ApiClient,
    prefix: '[test]',
    projectDir: '/tmp/project',
    apiUrl: 'https://api.example.com',
    token: 'test-token',
    projectCode: 'TEST_01',
    localAgentChatMode: undefined,
    ...overrides,
  }
}

function makeState(overrides?: Partial<ConfigSyncState>): ConfigSyncState {
  return {
    currentConfigHash: undefined,
    projectConfig: undefined,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    mcpConfigPath: undefined,
    dockerCustomizationHash: undefined,
    ...overrides,
  }
}

function makeBaseConfig(overrides?: Partial<ProjectConfigResponse>): ProjectConfigResponse {
  return {
    configHash: 'hash-new',
    project: { projectCode: 'TEST_01', projectName: 'Test' },
    agent: {
      agentEnabled: true,
      builtinAgentEnabled: true,
      builtinFallbackEnabled: true,
      externalAgentEnabled: true,
      allowedTools: [],
    },
    ...overrides,
  }
}

describe('performConfigSync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return true when syncProjectConfig returns a result', async () => {
    const config = makeBaseConfig()
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })

    const deps = makeDeps()
    const state = makeState()

    // We need to use the real applyProjectConfig but mock syncProjectConfig
    // Since performConfigSync calls applyProjectConfig internally, we need the other mocks set up
    const result = await performConfigSync(deps, state)

    expect(result).toBe(true)
    expect(mockSyncProjectConfig).toHaveBeenCalledWith(
      deps.client,
      undefined, // state.currentConfigHash is undefined initially
      deps.projectDir,
      deps.prefix,
    )
  })

  it('should return false when syncProjectConfig returns null (hash unchanged)', async () => {
    mockSyncProjectConfig.mockResolvedValue(null)

    const deps = makeDeps()
    const state = makeState({ currentConfigHash: 'same-hash' })

    const result = await performConfigSync(deps, state)

    expect(result).toBe(false)
  })

  it('should call applyProjectConfig with fromCache flag when config restored from cache', async () => {
    const config = makeBaseConfig()
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: true })

    const deps = makeDeps()
    const state = makeState()

    const result = await performConfigSync(deps, state)

    expect(result).toBe(true)
    // State should be updated with the config
    expect(state.projectConfig).toBeDefined()
  })

  it('should update state.currentConfigHash after successful sync', async () => {
    const config = makeBaseConfig({ configHash: 'new-hash-xyz' })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })

    const deps = makeDeps()
    const state = makeState()

    await performConfigSync(deps, state)

    expect(state.currentConfigHash).toBe('new-hash-xyz')
  })
})

describe('performSetup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSyncProjectConfig.mockResolvedValue(null) // Default: no config change
  })

  it('should call performConfigSync and log completion', async () => {
    const deps = makeDeps()
    const state = makeState()

    await expect(performSetup(deps, state)).resolves.not.toThrow()
    expect(mockSyncProjectConfig).toHaveBeenCalledTimes(1)
  })

  it('should sync repositories when projectConfig has repositories', async () => {
    const config = makeBaseConfig({
      repositories: [
        {
          repositoryId: 'id-01',
          repositoryCode: 'repo-01',
          repositoryName: 'my-repo',
          repositoryUrl: 'https://github.com/org/repo.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
      ],
    })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })
    mockSyncRepositories.mockResolvedValue([{ repositoryCode: 'repo-01', repositoryName: 'my-repo', status: 'cloned' }])

    const deps = makeDeps()
    const state = makeState()

    await performSetup(deps, state)

    expect(mockSyncRepositories).toHaveBeenCalledTimes(1)
    expect(mockSyncRepositories).toHaveBeenCalledWith(
      deps.client,
      config.repositories,
      `${deps.projectDir}/workspace/repos`,
      deps.prefix,
    )
  })

  it('should not sync repositories when projectDir is undefined', async () => {
    const config = makeBaseConfig({
      repositories: [
        {
          repositoryId: 'id-01',
          repositoryCode: 'repo-01',
          repositoryName: 'my-repo',
          repositoryUrl: 'https://github.com/org/repo.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
      ],
    })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })

    const deps = makeDeps({ projectDir: undefined })
    const state = makeState()

    await performSetup(deps, state)

    expect(mockSyncRepositories).not.toHaveBeenCalled()
  })

  it('should not sync repositories when no repositories in config', async () => {
    const config = makeBaseConfig({ repositories: [] })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })

    const deps = makeDeps()
    const state = makeState()

    await performSetup(deps, state)

    expect(mockSyncRepositories).not.toHaveBeenCalled()
  })

  it('should handle repository sync failure gracefully', async () => {
    const config = makeBaseConfig({
      repositories: [
        {
          repositoryId: 'id-01',
          repositoryCode: 'repo-01',
          repositoryName: 'my-repo',
          repositoryUrl: 'https://github.com/org/repo.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
      ],
    })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })
    mockSyncRepositories.mockRejectedValue(new Error('Network failure'))

    const deps = makeDeps()
    const state = makeState()

    // Should not throw even if repository sync fails
    await expect(performSetup(deps, state)).resolves.not.toThrow()
  })

  it('should log when documentation sources are found', async () => {
    const config = makeBaseConfig({
      documentation: {
        sources: [
          { type: 'url', url: 'https://docs.example.com' },
          { type: 'url', url: 'https://api.example.com/docs' },
        ],
      },
    })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })

    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')

    const deps = makeDeps()
    const state = makeState()

    await performSetup(deps, state)

    // Logger.info should have been called with documentation sources count
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Documentation sources found: 2'))
    infoSpy.mockRestore()
  })

  it('should log repository sync result counts', async () => {
    const config = makeBaseConfig({
      repositories: [
        {
          repositoryId: 'id-01',
          repositoryCode: 'repo-01',
          repositoryName: 'my-repo',
          repositoryUrl: 'https://github.com/org/repo.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
        {
          repositoryId: 'id-02',
          repositoryCode: 'repo-02',
          repositoryName: 'other-repo',
          repositoryUrl: 'https://github.com/org/other.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
      ],
    })
    mockSyncProjectConfig.mockResolvedValue({ config, fromCache: false })
    mockSyncRepositories.mockResolvedValue([
      { repositoryCode: 'repo-01', repositoryName: 'my-repo', status: 'cloned' },
      { repositoryCode: 'repo-02', repositoryName: 'other-repo', status: 'skipped' },
    ])

    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')

    const deps = makeDeps()
    const state = makeState()

    await performSetup(deps, state)

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Repository sync'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('cloned'))
    infoSpy.mockRestore()
  })
})

describe('scheduleConfigSync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should return a timer handle', () => {
    const deps = makeDeps()
    const state = makeState()

    const timer = scheduleConfigSync(deps, state, null)

    expect(timer).toBeDefined()
    clearTimeout(timer)
  })

  it('should clear existing timer before scheduling new one', () => {
    const deps = makeDeps()
    const state = makeState()
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout')

    const existingTimer = setTimeout(() => {}, 10000)
    const newTimer = scheduleConfigSync(deps, state, existingTimer)

    expect(clearTimeoutSpy).toHaveBeenCalledWith(existingTimer)
    clearTimeout(newTimer)
    clearTimeoutSpy.mockRestore()
  })

  it('should not clear timer when existingTimer is null', () => {
    const deps = makeDeps()
    const state = makeState()
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout')

    const timer = scheduleConfigSync(deps, state, null)

    expect(clearTimeoutSpy).not.toHaveBeenCalled()
    clearTimeout(timer)
    clearTimeoutSpy.mockRestore()
  })

  it('should schedule performConfigSync after CONFIG_SYNC_DEBOUNCE_MS delay', () => {
    mockSyncProjectConfig.mockResolvedValue(null)

    const deps = makeDeps()
    const state = makeState()

    scheduleConfigSync(deps, state, null)

    expect(mockSyncProjectConfig).not.toHaveBeenCalled()

    jest.advanceTimersByTime(CONFIG_SYNC_DEBOUNCE_MS)

    // performConfigSync calls syncProjectConfig internally
    expect(mockSyncProjectConfig).toHaveBeenCalledTimes(1)
  })

  it('should not fire before debounce time elapses', () => {
    mockSyncProjectConfig.mockResolvedValue(null)

    const deps = makeDeps()
    const state = makeState()

    scheduleConfigSync(deps, state, null)

    jest.advanceTimersByTime(CONFIG_SYNC_DEBOUNCE_MS - 1)

    expect(mockSyncProjectConfig).not.toHaveBeenCalled()
  })
})

describe('refreshChatMode', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDetectAvailableChatModes.mockResolvedValue(['agent', 'api'])
    mockResolveActiveChatMode.mockReturnValue('agent')
  })

  it('should detect available chat modes and set state', async () => {
    const mockClient = {
      getConfig: jest.fn().mockResolvedValue({
        agentEnabled: true,
        builtinAgentEnabled: false,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
      } as AgentServerConfig),
    } as unknown as ApiClient

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await refreshChatMode(deps, state, false)

    expect(state.availableChatModes).toEqual(['agent', 'api'])
    expect(state.serverConfig).toBeDefined()
    expect(state.activeChatMode).toBe('agent')
  })

  it('should log chat mode info when verbose is true', async () => {
    const mockClient = {
      getConfig: jest.fn().mockResolvedValue({
        agentEnabled: true,
        builtinAgentEnabled: false,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
      } as AgentServerConfig),
    } as unknown as ApiClient

    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await refreshChatMode(deps, state, true)

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Available chat modes'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Server config loaded'))
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Active chat mode'))
    infoSpy.mockRestore()
  })

  it('should log claudeCodeConfig debug info when verbose and claudeCodeConfig is set', async () => {
    const mockClient = {
      getConfig: jest.fn().mockResolvedValue({
        agentEnabled: true,
        builtinAgentEnabled: false,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          allowedTools: ['WebFetch', 'WebSearch'],
          addDirs: ['/tmp/project'],
        },
      } as AgentServerConfig),
    } as unknown as ApiClient

    const { logger } = require('../src/logger')
    const debugSpy = jest.spyOn(logger, 'debug')

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await refreshChatMode(deps, state, true)

    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('claudeCodeConfig'))
    debugSpy.mockRestore()
  })

  it('should handle getConfig failure gracefully when not verbose', async () => {
    const mockClient = {
      getConfig: jest.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as ApiClient

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await expect(refreshChatMode(deps, state, false)).resolves.not.toThrow()
    expect(state.activeChatMode).toBe('agent') // resolveActiveChatMode still called
  })

  it('should log warning on getConfig failure when verbose', async () => {
    const mockClient = {
      getConfig: jest.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as ApiClient

    const { logger } = require('../src/logger')
    const warnSpy = jest.spyOn(logger, 'warn')

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await refreshChatMode(deps, state, true)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load server config'))
    warnSpy.mockRestore()
  })

  it('should call resolveActiveChatMode with localAgentChatMode from deps', async () => {
    const serverConfig: AgentServerConfig = {
      agentEnabled: true,
      builtinAgentEnabled: false,
      builtinFallbackEnabled: false,
      externalAgentEnabled: true,
      chatMode: 'agent',
    }
    const mockClient = {
      getConfig: jest.fn().mockResolvedValue(serverConfig),
    } as unknown as ApiClient

    const deps = makeDeps({ localAgentChatMode: 'claude_code' })
    const state = makeState()

    await refreshChatMode(deps, state, false)

    // resolveActiveChatMode should be called with the availableChatModes, localAgentChatMode,
    // and state.serverConfig.defaultAgentChatMode (undefined in this case)
    expect(mockResolveActiveChatMode).toHaveBeenCalledWith(
      ['agent', 'api'],
      'claude_code',
      undefined,
    )
  })

  it('should not log when verbose is false', async () => {
    const mockClient = {
      getConfig: jest.fn().mockResolvedValue({
        agentEnabled: true,
        builtinAgentEnabled: false,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
      } as AgentServerConfig),
    } as unknown as ApiClient

    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')
    infoSpy.mockClear()

    const deps = makeDeps({ client: mockClient })
    const state = makeState()

    await refreshChatMode(deps, state, false)

    // No info logs about chat modes when verbose is false
    const chatModeCalls = infoSpy.mock.calls.filter((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('Available chat modes'),
    )
    expect(chatModeCalls).toHaveLength(0)
    infoSpy.mockRestore()
  })
})

describe('resolveMcpServerPath', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return candidate path when it exists', () => {
    mockedFs.existsSync.mockReturnValue(true)

    const result = resolveMcpServerPath()

    expect(result).toContain(path.join('mcp', 'server.js'))
    expect(mockedFs.existsSync).toHaveBeenCalledTimes(1)
  })

  it('should fall back to dist path when candidate does not exist but dist does', () => {
    mockedFs.existsSync
      .mockReturnValueOnce(false)  // candidate not found
      .mockReturnValueOnce(true)   // dist candidate found

    const result = resolveMcpServerPath()

    expect(result).toContain(path.join('dist', 'mcp', 'server.js'))
    expect(mockedFs.existsSync).toHaveBeenCalledTimes(2)
  })

  it('should return candidate path when neither candidate nor dist exists (with warning)', () => {
    mockedFs.existsSync.mockReturnValue(false)

    const { logger } = require('../src/logger')
    const warnSpy = jest.spyOn(logger, 'warn')

    const result = resolveMcpServerPath()

    // Returns candidate even when not found (caller responsibility)
    expect(result).toContain(path.join('mcp', 'server.js'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server script not found'))
    warnSpy.mockRestore()
  })
})
