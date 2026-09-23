import { startHeartbeat, type TransportDeps, type TransportState } from '../../src/agent-transport'
import type { ConfigSyncDeps, ConfigSyncState } from '../../src/agent-config-sync'
import type { AgentCapabilityDeclaration } from '../../src/types'

jest.mock('../../src/logger')
jest.mock('../../src/agent-config-sync', () => ({
  ...jest.requireActual('../../src/agent-config-sync'),
  refreshChatMode: jest.fn().mockResolvedValue(undefined),
  scheduleConfigSync: jest.fn(),
}))
jest.mock('../../src/system-info', () => ({
  getSystemInfo: jest.fn(() => ({
    platform: 'linux',
    arch: 'x64',
    cpuUsage: 0,
    memoryUsage: 0,
    uptime: 0,
  })),
  getLocalIpAddress: jest.fn(() => '10.0.0.1'),
}))

/**
 * Reporting the effective capabilities on the heartbeat.
 *
 * :::danger 送らないことにも意味がある
 * フィールドごと省略すると、api はそれを「報告できない旧エージェント」
 * （`unknown`、fail-closed）と解釈する。capability を理解しているこのバージョンは、
 * **有効なものが 1 つも無くても空配列を送る**必要がある。
 * :::
 */

/** Runtime-detection env vars, cleared per test so the host's own env cannot leak in. */
const RUNTIME_ENV_KEYS = [
  'AI_SUPPORT_AGENT_IN_DOCKER',
  'AI_SUPPORT_AGENT_RDP',
  'KUBERNETES_SERVICE_HOST',
  'ECS_CONTAINER_METADATA_URI_V4',
  'GUACD_HOST',
  'GUACD_PORT',
]

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const key of RUNTIME_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function makeState(): TransportState {
  return {
    heartbeatTimer: null,
    authRejectedTransports: new Set(),
  } as unknown as TransportState
}

function makeConfigSyncState(
  capabilities: AgentCapabilityDeclaration | undefined,
): ConfigSyncState {
  const serverConfig = { agentEnabled: true } as NonNullable<
    ConfigSyncState['serverConfig']
  >
  if (capabilities !== undefined) serverConfig.capabilities = capabilities
  return {
    currentConfigHash: 'hash-1',
    projectConfig: undefined,
    serverConfig,
    availableChatModes: [],
    activeChatMode: undefined,
    activeChatModeExplicit: false,
    mcpConfigPath: undefined,
    dockerCustomizationHash: undefined,
  }
}

/** Run exactly one heartbeat and return what was sent as `extras`. */
async function runHeartbeat(options: {
  capabilities: AgentCapabilityDeclaration | undefined
  env?: Record<string, string>
}): Promise<Record<string, unknown>> {
  Object.assign(process.env, options.env ?? {})

  const heartbeat = jest.fn().mockResolvedValue({ success: true })
  const deps = {
    client: { heartbeat, getInstanceId: () => 'i-1' },
    agentId: 'agent-1',
    prefix: '[test]',
    projectDir: undefined,
    heartbeatInterval: 60_000,
  } as unknown as TransportDeps
  const state = makeState()

  startHeartbeat(deps, state, makeConfigSyncState(options.capabilities), {} as ConfigSyncDeps)
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  // startHeartbeat fires once immediately; let that promise chain settle.
  for (let i = 0; i < 10; i++) await Promise.resolve()

  expect(heartbeat).toHaveBeenCalled()
  const call = heartbeat.mock.calls[0] as unknown[]
  return call[call.length - 1] as Record<string, unknown>
}

describe('heartbeat の capability 報告', () => {
  it('★ 宣言 true・ホスト直起動 → active', async () => {
    const extras = await runHeartbeat({ capabilities: { rdp: true } })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({ key: 'rdp', state: 'active' }),
    ])
  })

  it('★ 宣言 true・Docker → not_applied(action_required_restart)', async () => {
    const extras = await runHeartbeat({
      capabilities: { rdp: true },
      env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
    })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({
        state: 'not_applied',
        reason: 'action_required_restart',
      }),
    ])
  })

  it.each([
    ['k8s', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
    ['ecs', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' }],
  ])('★ 宣言 true・%s → not_applied(action_required_redeploy)', async (_n, env) => {
    const extras = await runHeartbeat({ capabilities: { rdp: true }, env })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({
        state: 'not_applied',
        reason: 'action_required_redeploy',
      }),
    ])
  })

  it('★ 宣言が無くても空配列を送る（未報告と区別させる）', async () => {
    const extras = await runHeartbeat({ capabilities: undefined })
    expect(extras.capabilities).toEqual([])
  })

  it('★ 旧サーバー（serverConfig に capabilities が無い）でもフィールド自体は送る', async () => {
    const extras = await runHeartbeat({ capabilities: undefined })
    expect(extras).toHaveProperty('capabilities')
  })
})

/**
 * The heartbeat carries the *reason* the capability is on, not just that it is.
 *
 * Without it the API — and therefore the admin UI — cannot explain why turning
 * the declaration off leaves an agent started with `--rdp` still relaying.
 */
describe('heartbeat が運ぶ source', () => {
  it('★ 宣言のみ → declared', async () => {
    const extras = await runHeartbeat({ capabilities: { rdp: true } })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({ key: 'rdp', source: 'declared' }),
    ])
  })

  it('★ CLI フラグのみ → flag（宣言が届いていなくても報告できる）', async () => {
    const extras = await runHeartbeat({
      capabilities: undefined,
      env: { AI_SUPPORT_AGENT_RDP: '1' },
    })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({ key: 'rdp', state: 'active', source: 'flag' }),
    ])
  })

  it('★ 両方 → both', async () => {
    const extras = await runHeartbeat({
      capabilities: { rdp: true },
      env: { AI_SUPPORT_AGENT_RDP: '1' },
    })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({ key: 'rdp', source: 'both' }),
    ])
  })

  it('★ not_applied（Docker の要再起動）でも source を運ぶ', async () => {
    const extras = await runHeartbeat({
      capabilities: { rdp: true },
      env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
    })
    expect(extras.capabilities).toEqual([
      expect.objectContaining({
        state: 'not_applied',
        reason: 'action_required_restart',
        source: 'declared',
      }),
    ])
  })
})
