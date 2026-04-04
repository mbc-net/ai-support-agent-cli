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
jest.mock('../src/mcp/config-writer', () => ({
  writeMcpConfig: jest.fn().mockReturnValue('/tmp/mcp.json'),
}))
jest.mock('../src/ssh-config-setup', () => ({
  setupSshConfig: jest.fn(),
}))
jest.mock('../src/agent-config-sync', () => {
  const actual = jest.requireActual('../src/agent-config-sync')
  return {
    ...actual,
    resolveMcpServerPath: jest.fn().mockReturnValue('/mock/mcp-server'),
  }
})

import { applyProjectConfig } from '../src/agent-config-sync'

function makeDeps(overrides?: Partial<ConfigSyncDeps>): ConfigSyncDeps {
  return {
    client: {} as ApiClient,
    prefix: '[test]',
    projectDir: undefined,
    apiUrl: 'https://api.example.com',
    token: 'test-token',
    projectCode: 'TEST_01',
    localAgentChatMode: undefined,
    ...overrides,
  }
}

function makeConfig(dockerCustomization?: { aptPackages?: string[]; npmPackages?: string[] }): ProjectConfigResponse {
  return {
    configHash: 'hash-new',
    project: { projectCode: 'TEST_01', projectName: 'Test' },
    agent: {
      agentEnabled: true,
      builtinAgentEnabled: true,
      builtinFallbackEnabled: true,
      externalAgentEnabled: true,
      allowedTools: [],
      dockerCustomization,
    },
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

describe('applyProjectConfig - Docker customization detection', () => {
  it('should not call onDockerRebuild when onDockerRebuild is not set', async () => {
    const onDockerRebuild = jest.fn()
    const state = makeState({ dockerCustomizationHash: 'prev-hash' })
    const deps = makeDeps() // no onDockerRebuild

    await applyProjectConfig(deps, state, makeConfig({ aptPackages: ['curl'] }))

    expect(onDockerRebuild).not.toHaveBeenCalled()
  })

  it('should set dockerCustomizationHash on first call but not trigger rebuild', async () => {
    const onDockerRebuild = jest.fn()
    const state = makeState({ dockerCustomizationHash: undefined })
    const deps = makeDeps({ onDockerRebuild })

    await applyProjectConfig(deps, state, makeConfig({ aptPackages: ['curl'] }))

    // On first call, prevDockerHash is undefined so rebuild is NOT triggered
    expect(onDockerRebuild).not.toHaveBeenCalled()
    expect(state.dockerCustomizationHash).toBeDefined()
  })

  it('should call onDockerRebuild when dockerCustomization changes', async () => {
    const onDockerRebuild = jest.fn()
    const state = makeState({ dockerCustomizationHash: 'some-previous-hash' })
    const deps = makeDeps({ onDockerRebuild })

    await applyProjectConfig(deps, state, makeConfig({ aptPackages: ['curl'] }))

    expect(onDockerRebuild).toHaveBeenCalledTimes(1)
  })

  it('should NOT call onDockerRebuild when dockerCustomization is unchanged', async () => {
    const onDockerRebuild = jest.fn()
    // First call to compute the initial hash
    const state = makeState()
    const deps = makeDeps({ onDockerRebuild })
    const config = makeConfig({ aptPackages: ['curl'] })

    await applyProjectConfig(deps, state, config)
    const initialHash = state.dockerCustomizationHash
    expect(onDockerRebuild).not.toHaveBeenCalled()

    // Second call with same config — should not trigger rebuild
    await applyProjectConfig(deps, state, config)
    expect(state.dockerCustomizationHash).toBe(initialHash)
    expect(onDockerRebuild).not.toHaveBeenCalled()
  })

  it('should call onDockerRebuild when dockerCustomization goes from defined to undefined', async () => {
    const onDockerRebuild = jest.fn()
    const state = makeState({ dockerCustomizationHash: 'some-previous-hash' })
    const deps = makeDeps({ onDockerRebuild })

    // Config with no dockerCustomization
    await applyProjectConfig(deps, state, makeConfig(undefined))

    expect(onDockerRebuild).toHaveBeenCalledTimes(1)
  })
})
