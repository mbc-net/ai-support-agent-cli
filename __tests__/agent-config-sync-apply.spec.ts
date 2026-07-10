import type { ApiClient } from '../src/api-client'
import type { ConfigSyncDeps, ConfigSyncState } from '../src/agent-config-sync'
import type { ProjectConfigResponse } from '../src/types'

jest.mock('../src/logger')
jest.mock('../src/project-dir', () => ({
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
  getSshDir: jest.fn((dir: string) => `${dir}/.ssh`),
}))
jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))
const mockWriteMcpConfig = jest.fn().mockReturnValue('/tmp/mcp.json')
const mockCleanupStaleCommandMcpConfigs = jest.fn().mockReturnValue(0)
jest.mock('../src/mcp/config-writer', () => ({
  writeMcpConfig: mockWriteMcpConfig,
  cleanupStaleCommandMcpConfigs: mockCleanupStaleCommandMcpConfigs,
}))
const mockSetupSshConfig = jest.fn()
jest.mock('../src/ssh-config-setup', () => ({
  setupSshConfig: mockSetupSshConfig,
}))
jest.mock('../src/agent-config-sync', () => {
  const actual = jest.requireActual('../src/agent-config-sync')
  return {
    ...actual,
    resolveMcpServerPath: jest.fn().mockReturnValue('/mock/mcp-server'),
  }
})

import { applyProjectConfig } from '../src/agent-config-sync'
import { writeAwsConfig } from '../src/aws-profile'

const mockWriteAwsConfig = writeAwsConfig as jest.MockedFunction<typeof writeAwsConfig>

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
    activeChatModeExplicit: false,
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

describe('applyProjectConfig - error handling branches', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockWriteMcpConfig.mockReturnValue('/tmp/mcp.json')
    mockCleanupStaleCommandMcpConfigs.mockReturnValue(0)
    mockSetupSshConfig.mockResolvedValue(undefined)
  })

  it('should log warn when writeAwsConfig throws', async () => {
    mockWriteAwsConfig.mockImplementation(() => { throw new Error('aws config error') })
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      aws: {
        accounts: [{
          id: 'acc-1',
          name: 'test',
          region: 'ap-northeast-1',
          accountId: '123456789012',
          auth: { method: 'access_key' },
          isDefault: true,
        }],
      },
    })

    await expect(applyProjectConfig(deps, state, config)).resolves.not.toThrow()
  })

  it('should log databases when databases are configured', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      databases: [{ name: 'mydb', engine: 'postgresql', host: 'localhost', port: 5432, database: 'mydb' }],
    })

    await expect(applyProjectConfig(deps, state, config)).resolves.not.toThrow()
  })

  it('should log warn when writeMcpConfig throws', async () => {
    mockWriteMcpConfig.mockImplementation(() => { throw new Error('mcp config error') })
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await expect(applyProjectConfig(deps, state, config)).resolves.not.toThrow()
  })

  it('should sweep stale per-command MCP config files after writing the MCP config', async () => {
    // Orphaned config-*.json files (plaintext token + conversationId) can accumulate if
    // the agent process is SIGKILLed/OOM-killed before chat-executor.ts's own cleanup
    // runs. Config sync is the natural recurring hook to self-heal this (mirrors
    // TerminalSession.cleanupStaleSandboxes being swept at agent startup).
    mockWriteMcpConfig.mockReturnValue('/tmp/project/.ai-support-agent/mcp/config.json')
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await applyProjectConfig(deps, state, config)

    expect(mockCleanupStaleCommandMcpConfigs).toHaveBeenCalledWith('/tmp/project/.ai-support-agent/mcp/config.json')
  })

  it('should not sweep stale per-command MCP configs when writeMcpConfig throws', async () => {
    mockWriteMcpConfig.mockImplementation(() => { throw new Error('mcp config error') })
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await applyProjectConfig(deps, state, config)

    expect(mockCleanupStaleCommandMcpConfigs).not.toHaveBeenCalled()
  })

  it('should log warn (but not throw) when cleanupStaleCommandMcpConfigs throws', async () => {
    mockCleanupStaleCommandMcpConfigs.mockImplementation(() => { throw new Error('cleanup error') })
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await expect(applyProjectConfig(deps, state, config)).resolves.not.toThrow()
  })

  it('should set up SSH config when ssh is enabled and hosts are configured', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      ssh: {
        enabled: true,
        hosts: [{ hostId: 'host-1', name: 'server', hostname: 'example.com', username: 'ubuntu', authType: 'key' }],
      },
    })

    await applyProjectConfig(deps, state, config)

    expect(mockSetupSshConfig).toHaveBeenCalledTimes(1)
  })

  it('should log warn when setupSshConfig throws', async () => {
    mockSetupSshConfig.mockRejectedValue(new Error('ssh setup error'))
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      ssh: {
        enabled: true,
        hosts: [{ hostId: 'host-1', name: 'server', hostname: 'example.com', username: 'ubuntu', authType: 'key' }],
      },
    })

    await expect(applyProjectConfig(deps, state, config)).resolves.not.toThrow()
  })

  it('should store envVars on state.projectConfig', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      envVars: {
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      },
    })

    await applyProjectConfig(deps, state, config)

    expect(state.projectConfig?.envVars).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    })
  })

  it('should not throw when envVars is undefined', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await applyProjectConfig(deps, state, config)

    expect(state.projectConfig?.envVars).toBeUndefined()
  })

  it('should propagate claudeCodeConfig.model to serverConfig', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig({
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
        claudeCodeConfig: {
          model: 'claude-opus-4-8',
        },
      },
    })

    await applyProjectConfig(deps, state, config)

    expect(state.serverConfig?.claudeCodeConfig?.model).toBe('claude-opus-4-8')
  })

  it('should leave serverConfig model undefined when claudeCodeConfig.model is not set', async () => {
    const deps = makeDeps()
    const state = makeState()
    const config = makeBaseConfig()

    await applyProjectConfig(deps, state, config)

    expect(state.serverConfig?.claudeCodeConfig?.model).toBeUndefined()
  })

  it('preserves previous envVars when applying cache fallback config', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-from-server' },
      },
    })
    // キャッシュ復元時は envVars が undefined になっている
    const cachedConfig = makeBaseConfig({ envVars: undefined })

    await applyProjectConfig(deps, state, cachedConfig, { fromCache: true })

    // 前回の envVars が保持されている
    expect(state.projectConfig?.envVars).toEqual({
      ANTHROPIC_API_KEY: 'sk-from-server',
    })
  })

  it('does not preserve envVars when fromCache is false and new config omits envVars', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-old' },
      },
    })
    // サーバから envVars 無しが明示的に来た場合は前回値を捨てる
    const newConfig = makeBaseConfig({ envVars: undefined })

    await applyProjectConfig(deps, state, newConfig, { fromCache: false })

    expect(state.projectConfig?.envVars).toBeUndefined()
  })

  it('uses cache-supplied envVars when present (does not over-preserve)', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-old' },
      },
    })
    // 万一キャッシュに envVars が入っていた場合はそれを優先する
    const cachedConfig = makeBaseConfig({
      envVars: { ANTHROPIC_API_KEY: 'sk-from-cache' },
    })

    await applyProjectConfig(deps, state, cachedConfig, { fromCache: true })

    expect(state.projectConfig?.envVars).toEqual({
      ANTHROPIC_API_KEY: 'sk-from-cache',
    })
  })

  it('treats envVars: null in cache as missing (preserves previous envVars)', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-from-server' },
      },
    })
    // 想定外パスとして envVars が null 化したケース
    const cachedConfig = makeBaseConfig({ envVars: null as unknown as undefined })

    await applyProjectConfig(deps, state, cachedConfig, { fromCache: true })

    expect(state.projectConfig?.envVars).toEqual({
      ANTHROPIC_API_KEY: 'sk-from-server',
    })
  })

  it('warns when cache fallback runs with no previous envVars (cold start)', async () => {
    const { logger } = require('../src/logger')
    const warnSpy = jest.spyOn(logger, 'warn')

    const deps = makeDeps()
    const state = makeState() // state.projectConfig undefined
    const cachedConfig = makeBaseConfig({ envVars: undefined })

    await applyProjectConfig(deps, state, cachedConfig, { fromCache: true })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Web-configured env overrides'),
    )
    warnSpy.mockRestore()
  })

  it('does not mutate the original config parameter passed in by the caller', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-prev' },
      },
    })
    const cachedConfig = makeBaseConfig({ envVars: undefined })
    const snapshot = JSON.parse(JSON.stringify(cachedConfig))

    await applyProjectConfig(deps, state, cachedConfig, { fromCache: true })

    // 呼び出し元の cachedConfig オブジェクトは変更されない（envVars は undefined のまま）
    expect(cachedConfig).toEqual(snapshot)
  })

  it('logs envVars value rotation even when key set is unchanged', async () => {
    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')

    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-old' },
      },
    })
    const rotatedConfig = makeBaseConfig({
      envVars: { ANTHROPIC_API_KEY: 'sk-new' }, // same key, new value
    })

    await applyProjectConfig(deps, state, rotatedConfig)

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('envVars override updated'),
    )
    infoSpy.mockRestore()
  })

  it('logs envVars clearing when previous had keys and new has none', async () => {
    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')

    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-old' },
      },
    })
    const clearedConfig = makeBaseConfig({ envVars: undefined })

    await applyProjectConfig(deps, state, clearedConfig)

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('envVars override cleared'),
    )
    infoSpy.mockRestore()
  })

  it('does not log envVars info when the value set is unchanged', async () => {
    const { logger } = require('../src/logger')
    const infoSpy = jest.spyOn(logger, 'info')
    infoSpy.mockClear()

    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'prev',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-same' },
      },
    })
    const unchangedConfig = makeBaseConfig({
      envVars: { ANTHROPIC_API_KEY: 'sk-same' },
    })

    await applyProjectConfig(deps, state, unchangedConfig)

    const envVarsCalls = infoSpy.mock.calls.filter((call: unknown[]) =>
      typeof call[0] === 'string' && (call[0] as string).includes('envVars override'),
    )
    expect(envVarsCalls).toHaveLength(0)
    infoSpy.mockRestore()
  })
})
