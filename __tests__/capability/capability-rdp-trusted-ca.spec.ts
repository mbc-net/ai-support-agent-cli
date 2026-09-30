import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  buildCapabilityReport,
  describeCapability,
} from '../../src/capability/capability-report'

/**
 * ハートビートの effectiveCapabilities（key='rdp'）に載せる `rdpTrustedCa`。
 *
 * - rdp が active で、guacd と共有する信頼ストアがあるときだけ `true` を載せる
 * - それ以外は**フィールドごと載せない**（旧エージェントと同じ扱い＝api は
 *   登録 CA がある接続を `rdp_trusted_ca_unsupported` で断る）
 */

const CA_DIR = 'AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR'
const K8S_WIRED = { KUBERNETES_SERVICE_HOST: '10.43.0.1', GUACD_HOST: '127.0.0.1' }

describe('rdpTrustedCa の申告', () => {
  it('★ rdp active + 信頼ストアあり → true を載せる', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED },
      applyFailures: {},
      detectRdpTunnels: () => undefined,
      detectRdpTrustedCa: () => true,
    })
    expect(entry).toEqual(expect.objectContaining({ key: 'rdp', state: 'active', rdpTrustedCa: true }))
  })

  it('★ 信頼ストアなし → フィールドを載せない', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED },
      applyFailures: {},
      detectRdpTrustedCa: () => false,
    })
    expect(entry?.state).toBe('active')
    expect(entry).not.toHaveProperty('rdpTrustedCa')
  })

  it('rdpTunnels と並んで載る', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED },
      applyFailures: {},
      detectRdpTunnels: () => ['ssh'],
      detectRdpTrustedCa: () => true,
    })
    expect(entry).toEqual(expect.objectContaining({ rdpTunnels: ['ssh'], rdpTrustedCa: true }))
  })

  it('★ rdp が not_applied（適用失敗）なら載せない', () => {
    const entry = describeCapability('rdp', {
      declaration: { rdp: true },
      env: { ...K8S_WIRED },
      applyFailures: { rdp: 'guacd failed' },
      detectRdpTrustedCa: () => true,
    })
    expect(entry?.state).toBe('not_applied')
    expect(entry).not.toHaveProperty('rdpTrustedCa')
  })

  it('rdp が無効なら報告自体に載らない', () => {
    expect(
      buildCapabilityReport({ env: {}, applyFailures: {}, detectRdpTrustedCa: () => true }),
    ).toEqual([])
  })

  describe('既定の検出は env の信頼ストアを見る', () => {
    let dir: string
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rdp-ca-cap-'))
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('★ system-ca.pem があれば true', () => {
      fs.writeFileSync(path.join(dir, 'system-ca.pem'), 'x')
      const entry = describeCapability('rdp', {
        declaration: { rdp: true },
        env: { ...K8S_WIRED, [CA_DIR]: dir },
        applyFailures: {},
      })
      expect(entry?.rdpTrustedCa).toBe(true)
    })

    it('system-ca.pem がまだ無ければ載せない', () => {
      const entry = describeCapability('rdp', {
        declaration: { rdp: true },
        env: { ...K8S_WIRED, [CA_DIR]: dir },
        applyFailures: {},
      })
      expect(entry).not.toHaveProperty('rdpTrustedCa')
    })
  })
})
