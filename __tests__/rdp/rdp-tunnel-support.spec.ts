import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  detectRdpTunnelKinds,
  hasExecutableOnPath,
  resolveRdpTunnelListenMode,
} from '../../src/rdp/rdp-tunnel-support'

/**
 * どの形態でトンネル経路を受けられるか（実装契約 2）。
 *
 * 待ち受けの形態は**明示設定で決める**。自動判定すると、guacd から
 * 届かないアドレスで待ち受けて「繋がらない」だけの状態になるか、
 * 逆に届いてはいけない相手へ中継を開くことになる。
 */

const LISTEN = 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN'
const K8S = { KUBERNETES_SERVICE_HOST: '10.43.0.1' }
const ECS = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' }
const DOCKER = { AI_SUPPORT_AGENT_IN_DOCKER: '1' }

describe('resolveRdpTunnelListenMode', () => {
  it.each([
    ['K8s + loopback', { ...K8S, [LISTEN]: 'loopback' }, 'loopback'],
    ['ECS + loopback', { ...ECS, [LISTEN]: 'loopback' }, 'loopback'],
    ['Docker + docker-network', { ...DOCKER, [LISTEN]: 'docker-network' }, 'docker-network'],
  ])('%s', (_name, env, expected) => {
    expect(resolveRdpTunnelListenMode(env)).toBe(expected)
  })

  it('★ 明示設定なし → 不可（K8s でも自動では決めない）', () => {
    expect(resolveRdpTunnelListenMode({ ...K8S })).toBeUndefined()
  })

  it('★ CLI 直起動は明示設定があっても不可（段階1）', () => {
    expect(resolveRdpTunnelListenMode({ [LISTEN]: 'loopback' })).toBeUndefined()
  })

  it('未知の値は不可', () => {
    expect(resolveRdpTunnelListenMode({ ...K8S, [LISTEN]: '0.0.0.0' })).toBeUndefined()
  })
})

describe('hasExecutableOnPath（実 tmpdir）', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-tunnel-path-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const touch = (name: string, mode: number): void => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '#!/bin/sh\n')
    fs.chmodSync(file, mode)
  }

  it('実行可能なファイルを見つける', () => {
    touch('tailscaled', 0o755)
    expect(hasExecutableOnPath('tailscaled', { PATH: `/nonexistent${path.delimiter}${dir}` })).toBe(true)
  })

  it('実行権の無いファイルは数えない', () => {
    touch('tailscaled', 0o644)
    expect(hasExecutableOnPath('tailscaled', { PATH: dir })).toBe(false)
  })

  it('ディレクトリは数えない', () => {
    fs.mkdirSync(path.join(dir, 'tailscaled'))
    expect(hasExecutableOnPath('tailscaled', { PATH: dir })).toBe(false)
  })

  it('PATH が空なら無い', () => {
    expect(hasExecutableOnPath('tailscaled', {})).toBe(false)
  })

  it('PATH の空要素を無視する', () => {
    touch('aws', 0o755)
    expect(hasExecutableOnPath('aws', { PATH: `${path.delimiter}${dir}` })).toBe(true)
  })
})

describe('detectRdpTunnelKinds', () => {
  const present = (names: string[]) => (name: string) => names.includes(name)
  const ALL = ['aws', 'session-manager-plugin', 'tailscaled', 'tailscale']

  it('★ 待ち受け設定なし → 申告しない（undefined）', () => {
    expect(detectRdpTunnelKinds({ env: { ...K8S }, hasCommand: present(ALL) })).toBeUndefined()
  })

  it('★ 依存物がすべて揃えば 3 値', () => {
    expect(
      detectRdpTunnelKinds({ env: { ...K8S, [LISTEN]: 'loopback' }, hasCommand: present(ALL) }),
    ).toEqual(['ssh', 'ssm', 'tailscale'])
  })

  it('★ ssh は常に（ssh2 同梱）', () => {
    expect(
      detectRdpTunnelKinds({ env: { ...DOCKER, [LISTEN]: 'docker-network' }, hasCommand: present([]) }),
    ).toEqual(['ssh'])
  })

  it('ssm は aws と session-manager-plugin の両方が要る', () => {
    const env = { ...ECS, [LISTEN]: 'loopback' }
    expect(detectRdpTunnelKinds({ env, hasCommand: present(['aws']) })).toEqual(['ssh'])
    expect(
      detectRdpTunnelKinds({ env, hasCommand: present(['aws', 'session-manager-plugin']) }),
    ).toEqual(['ssh', 'ssm'])
  })

  it('tailscale は tailscaled と tailscale の両方が要る', () => {
    const env = { ...ECS, [LISTEN]: 'loopback' }
    expect(detectRdpTunnelKinds({ env, hasCommand: present(['tailscaled']) })).toEqual(['ssh'])
    expect(
      detectRdpTunnelKinds({ env, hasCommand: present(['tailscaled', 'tailscale']) }),
    ).toEqual(['ssh', 'tailscale'])
  })

  it('既定では env の PATH を探す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-tunnel-kinds-'))
    try {
      for (const name of ['tailscaled', 'tailscale']) {
        fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 })
      }
      expect(
        detectRdpTunnelKinds({ env: { ...K8S, [LISTEN]: 'loopback', PATH: dir } }),
      ).toEqual(['ssh', 'tailscale'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('既定引数（process.env）', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('待ち受け設定の無いテスト環境ではトンネルを受けない', () => {
    delete process.env[LISTEN]
    expect(resolveRdpTunnelListenMode()).toBeUndefined()
    expect(detectRdpTunnelKinds()).toBeUndefined()
  })

  it('hasExecutableOnPath は process.env の PATH を見る', () => {
    process.env.PATH = ''
    expect(hasExecutableOnPath('sh')).toBe(false)
    delete process.env.PATH
    expect(hasExecutableOnPath('sh')).toBe(false)
  })
})
