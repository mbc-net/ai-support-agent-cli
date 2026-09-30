import {
  buildCapabilityReport,
  describeCapability,
} from '../../src/capability/capability-report'

/**
 * ハートビートの effectiveCapabilities（key='rdp'）に載せる `rdpTunnels`
 * （実装契約 2）。
 *
 * - rdp が active のときだけ載せる（not_applied で載せると、api が
 *   「使えない経路」を使えると誤読する余地が残る）
 * - 待ち受け設定の無い形態では**フィールドごと載せない**（旧エージェントと
 *   同じ扱い＝api はトンネル経路を拒否する）
 */

const LISTEN = 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN'
const K8S_WIRED = { KUBERNETES_SERVICE_HOST: '10.43.0.1', GUACD_HOST: '127.0.0.1' }

describe('rdpTunnels の申告', () => {
  it('★ rdp active + 待ち受け設定あり → 検出した経路を載せる', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED, [LISTEN]: 'loopback' },
      applyFailures: {},
      detectRdpTunnels: () => ['ssh', 'ssm', 'tailscale'],
    })
    expect(entry).toEqual(
      expect.objectContaining({ key: 'rdp', state: 'active', rdpTunnels: ['ssh', 'ssm', 'tailscale'] }),
    )
  })

  it('★ 待ち受け設定なし → フィールドを載せない', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED },
      applyFailures: {},
    })
    expect(entry?.state).toBe('active')
    expect(entry).not.toHaveProperty('rdpTunnels')
  })

  it('★ 既定の検出は env を見る（ssh は常に・PATH に何も無ければ ssh のみ）', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED, [LISTEN]: 'loopback', PATH: '' },
      applyFailures: {},
    })
    expect(entry?.rdpTunnels).toEqual(['ssh'])
  })

  it('★ rdp が not_applied（適用失敗）なら載せない', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED, [LISTEN]: 'loopback' },
      applyFailures: { rdp: 'guacd failed' },
      detectRdpTunnels: () => ['ssh'],
    })
    expect(entry?.state).toBe('not_applied')
    expect(entry).not.toHaveProperty('rdpTunnels')
  })

  it('★ rdp が not_applied（再デプロイ待ち）なら載せない', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { KUBERNETES_SERVICE_HOST: '10.43.0.1', [LISTEN]: 'loopback' },
      applyFailures: {},
      detectRdpTunnels: () => ['ssh'],
    })
    expect(entry?.state).toBe('not_applied')
    expect(entry).not.toHaveProperty('rdpTunnels')
  })

  it('ハートビート本文（buildCapabilityReport）にも載る', () => {
    expect(
      buildCapabilityReport({
        declaration: { rdp: true },
        env: { ...K8S_WIRED, [LISTEN]: 'loopback' },
        applyFailures: {},
        detectRdpTunnels: () => ['ssh'],
      }),
    ).toEqual([expect.objectContaining({ key: 'rdp', rdpTunnels: ['ssh'] })])
  })
})
