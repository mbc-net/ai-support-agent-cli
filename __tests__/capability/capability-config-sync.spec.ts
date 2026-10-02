import type { ApiClient } from '../../src/api-client'
import type { ConfigSyncDeps, ConfigSyncState } from '../../src/agent-config-sync'
import type { ProjectConfigResponse } from '../../src/types'

jest.mock('../../src/logger')
jest.mock('../../src/project-dir', () => ({
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
  getSshDir: jest.fn((dir: string) => `${dir}/.ssh`),
  getAwsDir: jest.fn((dir: string) => `${dir}/.aws`),
}))
jest.mock('../../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
  cleanupStaleAwsCredentials: jest.fn().mockReturnValue(0),
}))
jest.mock('../../src/mcp/config-writer', () => ({
  writeMcpConfig: jest.fn().mockReturnValue('/tmp/mcp.json'),
  cleanupStaleCommandMcpConfigs: jest.fn().mockReturnValue(0),
}))
jest.mock('../../src/shared-file-mounts', () => ({
  applySharedFileMounts: jest.fn().mockResolvedValue([]),
}))
jest.mock('../../src/ssh-config-setup', () => ({
  setupSshConfig: jest.fn(),
}))

import { applyProjectConfig } from '../../src/agent-config-sync'

/**
 * Carrying the declared capabilities from the delivered config into the state
 * the rest of the agent reads.
 *
 * :::danger これは「足したのに写し忘れる」ことが型では捕まらない箇所である
 * `applyProjectConfig` は `effectiveConfig.agent` からフィールドを**明示的に
 * 1 つずつ写して** `state.serverConfig` を組み立てる。写す先の
 * `AgentServerConfig.capabilities` は optional なので、写しの 1 行を書き忘れても
 * `tsc` は何も言わない。症状は「画面で ON にしたのにエージェントが反応しない」
 * であり、設定同期そのものは成功しているように見える。
 *
 * 同型の事故は過去に起きている（`ProjectSettingsDto` の未定義フィールドが
 * `ValidationPipe` に黙って除去された件）。ここは型ではなくテストで固定する。
 * :::
 */

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

function makeState(): ConfigSyncState {
  return {
    currentConfigHash: undefined,
    projectConfig: undefined,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    activeChatModeExplicit: false,
    mcpConfigPath: undefined,
    dockerCustomizationHash: undefined,
  }
}

function makeConfig(
  agent: Partial<ProjectConfigResponse['agent']> = {},
): ProjectConfigResponse {
  return {
    configHash: 'hash-1',
    project: { projectCode: 'TEST_01', projectName: 'Test' },
    agent: {
      agentEnabled: true,
      builtinAgentEnabled: true,
      builtinFallbackEnabled: true,
      externalAgentEnabled: true,
      allowedTools: [],
      ...agent,
    },
  }
}

describe('applyProjectConfig — capabilities の写し', () => {
  it('★ 配信された capabilities が state.serverConfig へ到達する', async () => {
    const state = makeState()

    await applyProjectConfig(makeDeps(), state, makeConfig({ capabilities: { rdp: true } }))

    expect(state.serverConfig?.capabilities).toEqual({ rdp: true })
  })

  it('★ 明示的な false も未宣言に畳まず、そのまま写す', async () => {
    // 未宣言（undefined）と明示 false の区別は capability の流儀そのもの。
    // ここで畳むと、api 側の「宣言を保存したのに届いていない」の切り分けが
    // できなくなる。
    const state = makeState()

    await applyProjectConfig(makeDeps(), state, makeConfig({ capabilities: { rdp: false } }))

    expect(state.serverConfig?.capabilities).toEqual({ rdp: false })
  })

  it('★ 旧サーバー（capabilities 無し）では undefined のまま', async () => {
    const state = makeState()

    await applyProjectConfig(makeDeps(), state, makeConfig())

    expect(state.serverConfig).not.toBeNull()
    expect(state.serverConfig?.capabilities).toBeUndefined()
  })
})
