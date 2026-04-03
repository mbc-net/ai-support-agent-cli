import type { ApiClient } from '../src/api-client'
import type { ConfigSyncDeps, ConfigSyncState } from '../src/agent-config-sync'
import type { ProjectConfigResponse } from '../src/types'

jest.mock('../src/logger')
jest.mock('../src/project-dir', () => ({
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
  getSshDir: jest.fn((dir: string) => `${dir}/.ssh`),
}))
jest.mock('../src/repo-sync', () => ({
  syncRepositoryByCode: jest.fn(),
  syncRepositories: jest.fn(),
}))

import { performSyncRepository } from '../src/agent-config-sync'
import { syncRepositoryByCode } from '../src/repo-sync'

const mockedSyncRepositoryByCode = syncRepositoryByCode as jest.MockedFunction<typeof syncRepositoryByCode>

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

const baseRepositories: NonNullable<ProjectConfigResponse['repositories']> = [
  {
    repositoryId: 'id-01',
    repositoryCode: 'repo-01',
    repositoryName: 'my-repo',
    repositoryUrl: 'https://github.com/org/my-repo.git',
    provider: 'github',
    branch: 'main',
    authMethod: 'api_key',
  },
]

function makeState(overrides?: Partial<ConfigSyncState>): ConfigSyncState {
  return {
    currentConfigHash: 'hash-abc',
    projectConfig: {
      configHash: 'hash-abc',
      project: { projectCode: 'TEST_01', projectName: 'Test' },
      agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
      repositories: baseRepositories,
    } as ProjectConfigResponse,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    mcpConfigPath: undefined,
    ...overrides,
  }
}

describe('performSyncRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedSyncRepositoryByCode.mockResolvedValue({
      repositoryId: 'id-01',
      repositoryCode: 'repo-01',
      repositoryName: 'my-repo',
      status: 'updated',
    })
  })

  it('should call syncRepositoryByCode with correct args', async () => {
    const deps = makeDeps()
    const state = makeState()

    await performSyncRepository(deps, state, { repositoryCode: 'repo-01' })

    expect(mockedSyncRepositoryByCode).toHaveBeenCalledWith(
      deps.client,
      baseRepositories,
      'repo-01',
      undefined,
      '/tmp/project/workspace/repos',
      '[test]',
    )
  })

  it('should pass overrideBranch when branch is specified', async () => {
    const deps = makeDeps()
    const state = makeState()

    await performSyncRepository(deps, state, { repositoryCode: 'repo-01', branch: 'feature/x' })

    expect(mockedSyncRepositoryByCode).toHaveBeenCalledWith(
      deps.client,
      baseRepositories,
      'repo-01',
      'feature/x',
      '/tmp/project/workspace/repos',
      '[test]',
    )
  })

  it('should return the RepoSyncResult from syncRepositoryByCode', async () => {
    const deps = makeDeps()
    const state = makeState()

    const result = await performSyncRepository(deps, state, { repositoryCode: 'repo-01' })

    expect(result).toEqual({ repositoryId: 'id-01', repositoryCode: 'repo-01', repositoryName: 'my-repo', status: 'updated' })
  })

  it('should throw when projectDir is undefined', async () => {
    const deps = makeDeps({ projectDir: undefined })
    const state = makeState()

    await expect(performSyncRepository(deps, state, { repositoryCode: 'repo-01' }))
      .rejects.toThrow('Project directory is required for sync_repository')
  })

  it('should throw when projectConfig is undefined', async () => {
    const deps = makeDeps()
    const state = makeState({ projectConfig: undefined })

    await expect(performSyncRepository(deps, state, { repositoryCode: 'repo-01' }))
      .rejects.toThrow('Project config not loaded')
  })

  it('should throw when repositories is empty', async () => {
    const deps = makeDeps()
    const state = makeState({
      projectConfig: {
        configHash: 'hash-abc',
        project: { projectCode: 'TEST_01', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        repositories: [],
      } as ProjectConfigResponse,
    })

    await expect(performSyncRepository(deps, state, { repositoryCode: 'repo-01' }))
      .rejects.toThrow('No repositories configured')
  })
})
