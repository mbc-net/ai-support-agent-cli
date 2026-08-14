import {
  resolveSelfUpdateCapability,
  describeSelfUpdateBlockReason,
} from '../src/self-update-capability'

/**
 * 自己更新（npm でこのプロセス自身を差し替える方式）が成立する実行環境かを判定する。
 *
 * 成立しない環境で自動アップデートを走らせると、`reExecProcess()` が detached な子を
 * spawn して自身を `process.exit(0)` するため、PID 1 で動いているコンテナでは
 * コンテナごと終了し、再作成でイメージの版へ巻き戻る（＝更新できないまま再起動を繰り返す）。
 */
describe('resolveSelfUpdateCapability', () => {
  it('Kubernetes 上（KUBERNETES_SERVICE_HOST あり）では成立しないと判定する', () => {
    const result = resolveSelfUpdateCapability(
      { KUBERNETES_SERVICE_HOST: '10.43.0.1' },
      1234,
    )

    expect(result).toEqual({ capable: false, reason: 'kubernetes' })
  })

  it('Kubernetes 判定は PID に依存しない（PID 1 でなくても成立しない）', () => {
    const result = resolveSelfUpdateCapability(
      { KUBERNETES_SERVICE_HOST: '10.43.0.1' },
      42,
    )

    expect(result.capable).toBe(false)
    expect(result.reason).toBe('kubernetes')
  })

  it('KUBERNETES_SERVICE_HOST が空文字なら Kubernetes とみなさない', () => {
    const result = resolveSelfUpdateCapability({ KUBERNETES_SERVICE_HOST: '' }, 42)

    expect(result).toEqual({ capable: true })
  })

  it('Kubernetes は AI_SUPPORT_AGENT_IN_DOCKER=1 より優先される（Pod にホスト側の監督プロセスは無い）', () => {
    const result = resolveSelfUpdateCapability(
      { KUBERNETES_SERVICE_HOST: '10.43.0.1', AI_SUPPORT_AGENT_IN_DOCKER: '1' },
      1,
    )

    expect(result).toEqual({ capable: false, reason: 'kubernetes' })
  })

  it('ホスト側 DockerSupervisor 配下（AI_SUPPORT_AGENT_IN_DOCKER=1）は PID 1 でも成立する', () => {
    // この経路はコンテナが終了コード 42 で抜けたあと、ホスト側が npm 導入と
    // イメージ再ビルドを引き受けるため、自己更新の流れが完結する。
    const result = resolveSelfUpdateCapability({ AI_SUPPORT_AGENT_IN_DOCKER: '1' }, 1)

    expect(result).toEqual({ capable: true })
  })

  it('AI_SUPPORT_AGENT_IN_DOCKER が "1" 以外なら監督プロセス扱いしない', () => {
    const result = resolveSelfUpdateCapability({ AI_SUPPORT_AGENT_IN_DOCKER: 'true' }, 1)

    expect(result).toEqual({ capable: false, reason: 'pid1-no-supervisor' })
  })

  it('PID 1 で監督プロセスが無ければ成立しないと判定する（ECS・素の docker run 等）', () => {
    const result = resolveSelfUpdateCapability({}, 1)

    expect(result).toEqual({ capable: false, reason: 'pid1-no-supervisor' })
  })

  it('systemd 等の監督下（PID 1 以外）では成立する', () => {
    const result = resolveSelfUpdateCapability({}, 4321)

    expect(result).toEqual({ capable: true })
  })

  it('引数を省略すると現在のプロセスの env / pid で判定する', () => {
    const original = process.env.KUBERNETES_SERVICE_HOST
    process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'
    try {
      expect(resolveSelfUpdateCapability()).toEqual({
        capable: false,
        reason: 'kubernetes',
      })
    } finally {
      if (original === undefined) {
        delete process.env.KUBERNETES_SERVICE_HOST
      } else {
        process.env.KUBERNETES_SERVICE_HOST = original
      }
    }
  })
})

describe('describeSelfUpdateBlockReason', () => {
  it('理由ごとに、次に取るべき操作まで含めた説明を返す', () => {
    expect(describeSelfUpdateBlockReason('kubernetes')).toMatch(/Kubernetes/)
    expect(describeSelfUpdateBlockReason('kubernetes')).toMatch(/image tag/i)
    expect(describeSelfUpdateBlockReason('pid1-no-supervisor')).toMatch(/PID 1/)
    expect(describeSelfUpdateBlockReason('pid1-no-supervisor')).toMatch(/image tag/i)
  })

  it('説明は理由ごとに異なる', () => {
    expect(describeSelfUpdateBlockReason('kubernetes')).not.toBe(
      describeSelfUpdateBlockReason('pid1-no-supervisor'),
    )
  })
})
