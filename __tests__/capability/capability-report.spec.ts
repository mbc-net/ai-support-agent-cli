import {
  buildCapabilityReport,
  describeCapability,
  isCapabilityActive,
  planCapability,
} from '../../src/capability/capability-report'
import {
  clearCapabilityApplyFailure,
  recordCapabilityApplyFailure,
  resetCapabilityApplyFailures,
} from '../../src/capability/capability-apply-failures'
import {
  AGENT_CAPABILITY_DETAIL_MAX_LENGTH,
  type AgentCapabilityDeclaration,
} from '../../src/types'

/**
 * What the agent tells the API about each capability on every heartbeat.
 *
 * The admin UI decides whether to offer a connection from this report, so the
 * distinction the report has to carry is not "on/off" but *why* something is
 * not usable: nothing to do, waiting on a restart, waiting on a redeploy, or
 * tried and failed. Collapsing those leaves the UI able to say only "enable
 * it", to a user who already did.
 */

const DECLARED = { rdp: true }

describe('describeCapability', () => {
  it('★ 宣言 true・ホスト直起動 → active', () => {
    // ホスト形態は初回接続時に guacd を遅延起動できる（プロセス再起動は不要）。
    const entry = describeCapability('rdp', { declaration: DECLARED, env: {} })
    expect(entry).toEqual(
      expect.objectContaining({ key: 'rdp', state: 'active' }),
    )
    expect(entry?.reason).toBeUndefined()
  })

  it('★ 宣言 true・Docker → not_applied(action_required_restart)', () => {
    expect(
      describeCapability('rdp', {
        declaration: DECLARED,
        env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
      }),
    ).toEqual(
      expect.objectContaining({
        key: 'rdp',
        state: 'not_applied',
        reason: 'action_required_restart',
      }),
    )
  })

  it.each([
    ['k8s', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
    ['ecs', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' }],
  ])(
    '★ 宣言 true・%s → not_applied(action_required_redeploy)',
    (_name, env) => {
      expect(
        describeCapability('rdp', { declaration: DECLARED, env }),
      ).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'action_required_redeploy',
        }),
      )
    },
  )

  it('★ 実効でなければ項目自体を出さない（= api 側の inactive）', () => {
    expect(describeCapability('rdp', { declaration: {}, env: {} })).toBeUndefined()
  })

  it('★ サイドカー等で配線済みなら、ランタイムによらず active', () => {
    // guacd が既に到達可能なら、適用のためにやることは残っていない。
    // ここで「再デプロイが必要」と報告すると、現に動いている Pod から
    // 画面の接続導線が消える。
    expect(
      describeCapability('rdp', {
        declaration: DECLARED,
        env: { KUBERNETES_SERVICE_HOST: '10.43.0.1', GUACD_HOST: '127.0.0.1' },
      }),
    ).toEqual(expect.objectContaining({ state: 'active' }))
  })

  it('宣言ハッシュを添える（宣言だけから計算したもの）', () => {
    const entry = describeCapability('rdp', { declaration: DECLARED, env: {} })
    expect(entry?.declarationHash).toEqual(expect.any(String))
    expect(entry?.declarationHash?.length).toBeGreaterThan(0)
  })

  describe('適用に失敗した記録がある場合', () => {
    beforeEach(() => {
      resetCapabilityApplyFailures()
    })
    afterEach(() => {
      resetCapabilityApplyFailures()
    })

    it('★ not_applied(apply_failed) として理由を伴って報告する', () => {
      recordCapabilityApplyFailure('rdp', 'docker daemon is not running')
      expect(describeCapability('rdp', { declaration: DECLARED, env: {} })).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'apply_failed',
          detail: expect.stringContaining('docker daemon is not running'),
        }),
      )
    })

    it('★ detail は api の上限に収まるよう切り詰める', () => {
      recordCapabilityApplyFailure('rdp', 'x'.repeat(2000))
      const entry = describeCapability('rdp', { declaration: DECLARED, env: {} })
      expect(entry?.detail?.length).toBeLessThanOrEqual(
        AGENT_CAPABILITY_DETAIL_MAX_LENGTH,
      )
    })

    it('復旧したら記録は消え、報告も戻る', () => {
      recordCapabilityApplyFailure('rdp', 'boom')
      clearCapabilityApplyFailure('rdp')
      expect(describeCapability('rdp', { declaration: DECLARED, env: {} })).toEqual(
        expect.objectContaining({ state: 'active' }),
      )
    })
  })
})

describe('buildCapabilityReport', () => {
  it('★ 宣言が無くても必ず配列を送る（空配列＝報告済みで無効）', () => {
    // フィールドごと送らないと、api は「報告しない旧エージェント」(unknown) と
    // 区別できず、fail-closed で接続導線を消してしまう。
    expect(buildCapabilityReport({ declaration: undefined, env: {} })).toEqual([])
  })

  it('有効な capability を並べる', () => {
    expect(buildCapabilityReport({ declaration: DECLARED, env: {} })).toEqual([
      expect.objectContaining({ key: 'rdp', state: 'active' }),
    ])
  })

  it('CLI フラグだけでも報告する', () => {
    expect(
      buildCapabilityReport({
        declaration: undefined,
        env: { AI_SUPPORT_AGENT_RDP: '1' },
      }),
    ).toEqual([expect.objectContaining({ key: 'rdp', state: 'active' })])
  })
})

describe('isCapabilityActive', () => {
  it('active のときだけ true', () => {
    expect(isCapabilityActive('rdp', { declaration: DECLARED, env: {} })).toBe(true)
  })

  it('not_applied は false（宣言しただけでは使えない）', () => {
    expect(
      isCapabilityActive('rdp', {
        declaration: DECLARED,
        env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
      }),
    ).toBe(false)
  })

  it('未宣言は false', () => {
    expect(isCapabilityActive('rdp', { declaration: {}, env: {} })).toBe(false)
  })
})

describe('既定値', () => {
  const KEYS = [
    'AI_SUPPORT_AGENT_IN_DOCKER',
    'AI_SUPPORT_AGENT_RDP',
    'KUBERNETES_SERVICE_HOST',
    'ECS_CONTAINER_METADATA_URI_V4',
    'GUACD_HOST',
    'GUACD_PORT',
  ]
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    resetCapabilityApplyFailures()
    saved = {}
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    resetCapabilityApplyFailures()
    for (const key of KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('引数を省略したら現在のプロセスの環境変数と宣言なしで判定する', () => {
    expect(buildCapabilityReport()).toEqual([])
    expect(describeCapability('rdp')).toBeUndefined()
    expect(planCapability('rdp')).toBeUndefined()
    expect(isCapabilityActive('rdp')).toBe(false)
  })

  it('★ --rdp だけで起動したエージェントは、宣言が無くても報告する', () => {
    // 宣言が届いていないことを理由に既存の稼働を無効扱いにしない。
    process.env.AI_SUPPORT_AGENT_RDP = '1'
    expect(buildCapabilityReport()).toEqual([
      expect.objectContaining({ key: 'rdp', state: 'active' }),
    ])
  })

  it('cliFlags を明示できる（合成そのものを検証するため）', () => {
    expect(
      describeCapability('rdp', {
        declaration: undefined,
        cliFlags: { rdp: true },
        env: {},
      }),
    ).toEqual(expect.objectContaining({ state: 'active' }))
  })

  it('applyFailures を明示できる', () => {
    expect(
      describeCapability('rdp', {
        declaration: DECLARED,
        env: {},
        applyFailures: { rdp: 'injected failure' },
      }),
    ).toEqual(
      expect.objectContaining({ reason: 'apply_failed', detail: 'injected failure' }),
    )
  })
})

/**
 * Why the capability is on, carried alongside the effective state.
 *
 * :::danger 「画面を OFF にしたのに止まらない」を説明できるのはこれだけ
 * 実効状態は宣言と `--rdp` の OR である。宣言を OFF にしてもフラグ付きで起動した
 * エージェントでは止まらない（既存の稼働を無言で壊さないための設計）。報告が
 * 「有効である」ことしか運べないと、画面はこの必然を説明できず、利用者には
 * 「トグルが壊れている」としか見えない。
 * :::
 */
describe('報告に載る source（何がその capability を有効にしたか）', () => {
  it('★ 宣言のみで有効 → declared', () => {
    expect(
      describeCapability('rdp', { declaration: DECLARED, cliFlags: {}, env: {} }),
    ).toEqual(expect.objectContaining({ state: 'active', source: 'declared' }))
  })

  it('★ CLI フラグのみで有効 → flag', () => {
    expect(
      describeCapability('rdp', {
        declaration: undefined,
        env: { AI_SUPPORT_AGENT_RDP: '1' },
      }),
    ).toEqual(expect.objectContaining({ state: 'active', source: 'flag' }))
  })

  it('★ 宣言とフラグの両方 → both', () => {
    expect(
      describeCapability('rdp', {
        declaration: DECLARED,
        env: { AI_SUPPORT_AGENT_RDP: '1' },
      }),
    ).toEqual(expect.objectContaining({ state: 'active', source: 'both' }))
  })

  it('★ 宣言が明示 false でもフラグで有効なら flag（OR 合成の根拠を示す）', () => {
    // 画面のトグルを OFF にしても止まらない、まさにその状態。
    expect(
      describeCapability('rdp', {
        declaration: { rdp: false },
        env: { AI_SUPPORT_AGENT_RDP: '1' },
      }),
    ).toEqual(expect.objectContaining({ state: 'active', source: 'flag' }))
  })

  describe('not_applied でも source を載せる', () => {
    // 「宣言したが適用できていない」のか「フラグで指定されたが適用できていない」の
    // かで、利用者の次の一手（画面を戻す / 起動オプションを外す）が変わる。
    it('★ Docker の要再起動（宣言のみ）→ declared', () => {
      expect(
        describeCapability('rdp', {
          declaration: DECLARED,
          cliFlags: {},
          env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
        }),
      ).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'action_required_restart',
          source: 'declared',
        }),
      )
    })

    it('★ Docker の要再起動（フラグのみ）→ flag', () => {
      expect(
        describeCapability('rdp', {
          declaration: undefined,
          env: { AI_SUPPORT_AGENT_IN_DOCKER: '1', AI_SUPPORT_AGENT_RDP: '1' },
        }),
      ).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'action_required_restart',
          source: 'flag',
        }),
      )
    })

    it.each([
      ['k8s', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
      ['ecs', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' }],
    ])('★ %s の要再デプロイ → declared', (_name, env) => {
      expect(
        describeCapability('rdp', {
          declaration: DECLARED,
          cliFlags: {},
          env,
        }),
      ).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'action_required_redeploy',
          source: 'declared',
        }),
      )
    })

    it('★ apply_failed でも source は残る', () => {
      expect(
        describeCapability('rdp', {
          declaration: DECLARED,
          env: { AI_SUPPORT_AGENT_RDP: '1' },
          applyFailures: { rdp: 'docker daemon is not running' },
        }),
      ).toEqual(
        expect.objectContaining({
          state: 'not_applied',
          reason: 'apply_failed',
          source: 'both',
        }),
      )
    })
  })

  it('planCapability も同じ source を返す（describeCapability の土台）', () => {
    expect(
      planCapability('rdp', { declaration: DECLARED, cliFlags: {}, env: {} }),
    ).toEqual(expect.objectContaining({ source: 'declared' }))
  })

  it('★ どの入力でも有効にならない capability は項目ごと出ない（none は報告され得ない）', () => {
    // `source: 'none'` を送らないのは「省く」のではなく、そもそも報告対象に
    // ならないため。ここが崩れると報告の組み立て自体が誤っている。
    const inputs: Array<{
      declaration: AgentCapabilityDeclaration | undefined
      cliFlags: AgentCapabilityDeclaration | undefined
    }> = [
      { declaration: undefined, cliFlags: undefined },
      { declaration: {}, cliFlags: {} },
      { declaration: { rdp: false }, cliFlags: { rdp: false } },
      { declaration: { rdp: false }, cliFlags: undefined },
      { declaration: undefined, cliFlags: { rdp: false } },
      { declaration: { rdp: true }, cliFlags: { rdp: false } },
      { declaration: { rdp: false }, cliFlags: { rdp: true } },
      { declaration: { rdp: true }, cliFlags: { rdp: true } },
    ]
    const envs = [
      {},
      { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
      { KUBERNETES_SERVICE_HOST: '10.43.0.1' },
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' },
    ]
    for (const input of inputs) {
      for (const env of envs) {
        for (const applyFailures of [{}, { rdp: 'boom' }]) {
          const report = buildCapabilityReport({ ...input, env, applyFailures })
          for (const entry of report) {
            expect(entry.source).toBeDefined()
            expect(entry.source).not.toBe('none')
          }
        }
      }
    }
  })
})
