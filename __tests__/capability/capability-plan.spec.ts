import {
  detectAgentRuntime,
  isCapabilityAlreadyWired,
  resolveCapabilityApplyClass,
} from '../../src/capability/capability-plan'

/**
 * Which runtime this process is in, and therefore *when* a freshly declared
 * capability can take effect.
 *
 * The three classes are not a preference order — they are facts about what the
 * runtime allows. Getting the runtime wrong is what would make the agent try to
 * apply something it cannot (or promise a restart that nothing will perform).
 */

describe('detectAgentRuntime', () => {
  it('Kubernetes: KUBERNETES_SERVICE_HOST があれば k8s', () => {
    expect(detectAgentRuntime({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(
      'k8s',
    )
  })

  it('ECS: ECS_CONTAINER_METADATA_URI_V4 があれば ecs', () => {
    expect(
      detectAgentRuntime({
        ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/task-1',
      }),
    ).toBe('ecs')
  })

  it('Docker: AI_SUPPORT_AGENT_IN_DOCKER=1 なら docker', () => {
    expect(detectAgentRuntime({ AI_SUPPORT_AGENT_IN_DOCKER: '1' })).toBe(
      'docker',
    )
  })

  it('いずれも無ければ host', () => {
    expect(detectAgentRuntime({})).toBe('host')
  })

  it('★ Kubernetes の判定は IN_DOCKER より先（Pod にホスト側の supervisor はいない）', () => {
    // 自己更新の可否判定（self-update-capability.ts）と同じ順序。マニフェストが
    // 何らかの理由で IN_DOCKER を立てても、再起動を引き受ける相手は居ない。
    expect(
      detectAgentRuntime({
        KUBERNETES_SERVICE_HOST: '10.43.0.1',
        AI_SUPPORT_AGENT_IN_DOCKER: '1',
      }),
    ).toBe('k8s')
  })

  it('★ ECS の判定も IN_DOCKER より先', () => {
    expect(
      detectAgentRuntime({
        ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/task-1',
        AI_SUPPORT_AGENT_IN_DOCKER: '1',
      }),
    ).toBe('ecs')
  })
})

describe('resolveCapabilityApplyClass（rdp の適用クラス）', () => {
  it.each([
    ['host', 'immediate'],
    ['docker', 'restart'],
    ['k8s', 'redeploy'],
    ['ecs', 'redeploy'],
  ] as const)('%s → %s', (runtime, expected) => {
    expect(resolveCapabilityApplyClass('rdp', runtime)).toBe(expected)
  })
})

describe('isCapabilityAlreadyWired', () => {
  it('★ GUACD_HOST が既にあれば rdp は配線済み（適用作業は残っていない）', () => {
    // guacd サイドカー付きの Pod / TaskDefinition、あるいはホスト側 CLI が
    // 用意した guacd に繋がったコンテナ。再デプロイも再起動も要らない。
    expect(isCapabilityAlreadyWired('rdp', { GUACD_HOST: '127.0.0.1' })).toBe(
      true,
    )
  })

  it('GUACD_HOST が無ければ未配線', () => {
    expect(isCapabilityAlreadyWired('rdp', {})).toBe(false)
  })
})

describe('既定値（引数を省略したら現在のプロセスの環境変数を見る）', () => {
  const KEYS = [
    'AI_SUPPORT_AGENT_IN_DOCKER',
    'KUBERNETES_SERVICE_HOST',
    'ECS_CONTAINER_METADATA_URI_V4',
    'GUACD_HOST',
  ]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('detectAgentRuntime は process.env を既定にする', () => {
    expect(detectAgentRuntime()).toBe('host')
    process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
    expect(detectAgentRuntime()).toBe('docker')
  })

  it('isCapabilityAlreadyWired は process.env を既定にする', () => {
    expect(isCapabilityAlreadyWired('rdp')).toBe(false)
    process.env.GUACD_HOST = '127.0.0.1'
    expect(isCapabilityAlreadyWired('rdp')).toBe(true)
  })
})
