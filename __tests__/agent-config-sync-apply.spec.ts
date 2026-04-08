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
jest.mock('../src/mcp/config-writer', () => ({
  writeMcpConfig: mockWriteMcpConfig,
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
})
