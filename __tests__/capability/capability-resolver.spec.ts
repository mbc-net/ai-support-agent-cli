import {
  computeCapabilityDeclarationHash,
  resolveCliCapabilityFlags,
  resolveEffectiveCapability,
} from '../../src/capability/capability-resolver'
import { AGENT_CAPABILITY_DECLARATION_HASH_MAX_LENGTH } from '../../src/types'

/**
 * Composing the two declarations of intent that can turn a capability on.
 *
 * The rule is an OR of two *present-tense instructions* — the project's
 * declaration and the operator's start-up flag — not a fallback from a legacy
 * source to a new one. Getting this backwards in either direction has a
 * concrete failure mode, so each is pinned below.
 */

describe('resolveEffectiveCapability（宣言 OR フラグ）', () => {
  it('★ 宣言なし × CLI フラグあり → 有効', () => {
    // すでに `--rdp` で運用しているホストが、api 側の設定を触っていないという
    // だけで無言で RDP を失ってはならない。
    expect(resolveEffectiveCapability('rdp', undefined, { rdp: true })).toEqual({
      effective: true,
      source: 'flag',
    })
  })

  it('★ 宣言 true × CLI フラグなし → 有効', () => {
    expect(resolveEffectiveCapability('rdp', { rdp: true }, undefined)).toEqual({
      effective: true,
      source: 'declared',
    })
  })

  it('★ 両方なし → 無効', () => {
    expect(resolveEffectiveCapability('rdp', undefined, undefined)).toEqual({
      effective: false,
      source: 'none',
    })
  })

  it('★ 宣言 false × CLI フラグあり → 有効（フラグを打ち消さない）', () => {
    // 明示的な false は「宣言側は off」であって「フラグを無効化せよ」ではない。
    // 打ち消すと、設定画面を一度も触っていない稼働中のホストが RDP を失う。
    expect(
      resolveEffectiveCapability('rdp', { rdp: false }, { rdp: true }),
    ).toEqual({ effective: true, source: 'flag' })
  })

  it('宣言 true × CLI フラグあり → 有効（根拠は both）', () => {
    // 「宣言が届いていないのにフラグだけで動いている」を調査時に見分けるため、
    // 有効になった根拠を区別して残す。
    expect(
      resolveEffectiveCapability('rdp', { rdp: true }, { rdp: true }),
    ).toEqual({ effective: true, source: 'both' })
  })

  it('宣言 false × フラグなし → 無効', () => {
    expect(
      resolveEffectiveCapability('rdp', { rdp: false }, { rdp: false }),
    ).toEqual({ effective: false, source: 'none' })
  })
})

describe('resolveCliCapabilityFlags（運用者の指示がこのプロセスにどう届くか）', () => {
  it('ホスト直起動: AI_SUPPORT_AGENT_RDP=1 を --rdp として読む', () => {
    expect(resolveCliCapabilityFlags({ AI_SUPPORT_AGENT_RDP: '1' })).toEqual({
      rdp: true,
    })
  })

  it('★ Docker / K8s / ECS: 注入された GUACD_HOST を同じ指示として読む', () => {
    // コンテナの中には `--rdp` が届かない。ホスト側 CLI（buildGuacdDockerArgs）と
    // 生成マニフェスト（guacdAgentEnvYaml）は、まさに `--rdp` が指定されたから
    // GUACD_HOST を注入している。これを無視すると、現に RDP が使えている
    // コンテナ運用が「宣言していない」という理由だけで報告上 inactive になる。
    expect(resolveCliCapabilityFlags({ GUACD_HOST: '127.0.0.1' })).toEqual({
      rdp: true,
    })
  })

  it('どちらも無ければ空', () => {
    expect(resolveCliCapabilityFlags({})).toEqual({})
  })

  it('AI_SUPPORT_AGENT_RDP が 1 以外なら指定なし扱い', () => {
    expect(resolveCliCapabilityFlags({ AI_SUPPORT_AGENT_RDP: '0' })).toEqual({})
  })

  it('空文字の GUACD_HOST は未設定として扱う', () => {
    expect(resolveCliCapabilityFlags({ GUACD_HOST: '' })).toEqual({})
  })
})

describe('computeCapabilityDeclarationHash（宣言だけから作る）', () => {
  it('★ 未宣言と明示 false は同じハッシュに畳む', () => {
    // 区別すると、画面で ON → OFF した直後にハッシュが振動し、Docker 形態の
    // 「適用済みマーカー」が毎回外れて再起動のきっかけになる。
    expect(computeCapabilityDeclarationHash({ rdp: false })).toBe(
      computeCapabilityDeclarationHash(undefined),
    )
    expect(computeCapabilityDeclarationHash({})).toBe(
      computeCapabilityDeclarationHash(undefined),
    )
  })

  it('宣言が変われば変わる', () => {
    expect(computeCapabilityDeclarationHash({ rdp: true })).not.toBe(
      computeCapabilityDeclarationHash({ rdp: false }),
    )
  })

  it('同じ宣言なら安定する', () => {
    expect(computeCapabilityDeclarationHash({ rdp: true })).toBe(
      computeCapabilityDeclarationHash({ rdp: true }),
    )
  })

  it('★ 許可リスト外のキーはハッシュに影響しない', () => {
    // 別経路で書き込まれた未知のキーでハッシュが動くと、capability と無関係な
    // 変更が適用判定を揺らす。
    const withNoise = { rdp: true, nonsense: true } as Record<string, boolean>
    expect(computeCapabilityDeclarationHash(withNoise)).toBe(
      computeCapabilityDeclarationHash({ rdp: true }),
    )
  })

  it('api が受け付ける長さに収まる', () => {
    expect(
      computeCapabilityDeclarationHash({ rdp: true }).length,
    ).toBeLessThanOrEqual(AGENT_CAPABILITY_DECLARATION_HASH_MAX_LENGTH)
  })
})

describe('resolveCliCapabilityFlags の既定値', () => {
  const KEYS = ['AI_SUPPORT_AGENT_RDP', 'GUACD_HOST']
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

  it('引数を省略したら現在のプロセスの環境変数を見る', () => {
    expect(resolveCliCapabilityFlags()).toEqual({})
    process.env.AI_SUPPORT_AGENT_RDP = '1'
    expect(resolveCliCapabilityFlags()).toEqual({ rdp: true })
  })
})
