import {
  checkDirectRdpTarget,
  RdpDirectTargetForbiddenError,
  type DirectTargetDeps,
} from '../../src/rdp/rdp-direct-target'
import { RdpOpenRefusedError } from '../../src/rdp/rdp-session-registry'

/**
 * 直接接続（tunnel なし）の宛先検査。
 *
 * Docker 形態では guacd（ais-guacd）を複数プロジェクトで共有している。
 * 直接接続の hostname に「このエージェントの中継」やループバック・共有
 * ネットワーク・メタデータサービスを指定されると、他プロジェクトの
 * トンネルに入り込める。解決結果のどれか 1 つでも当たれば拒否する。
 */

type Addr = { address: string; family: number }
const v4 = (address: string): Addr => ({ address, family: 4 })
const v6 = (address: string): Addr => ({ address, family: 6 })

const DOCKER_IFACES = {
  lo: [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' },
  ],
  eth0: [
    { address: '172.18.0.3', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '172.18.0.3/16' },
  ],
  eth1: [
    { address: '10.20.0.5', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: '10.20.0.5/24' },
  ],
}

const deps = (records: Record<string, Addr[]>, extra: Partial<DirectTargetDeps> = {}): DirectTargetDeps => ({
  lookupAll: async (host) => {
    const found = records[host]
    if (!found) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
    return found
  },
  listenMode: undefined,
  relayAddresses: () => [],
  networkInterfaces: () => DOCKER_IFACES as never,
  ...extra,
})

async function expectForbidden(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RdpDirectTargetForbiddenError)
  expect(error).toBeInstanceOf(RdpOpenRefusedError)
  expect((error as Error).message).toMatch(/^direct_target_forbidden: /)
  expect((error as Error).message).toMatch(pattern)
}

describe('checkDirectRdpTarget', () => {
  it('★ 通常の宛先は解決した IP を返す（guacd にはこの IP を渡す）', async () => {
    await expect(
      checkDirectRdpTarget('win.example.com', deps({ 'win.example.com': [v4('203.0.113.10')] })),
    ).resolves.toBe('203.0.113.10')
  })

  it('IP リテラルはそのまま検査する', async () => {
    await expect(checkDirectRdpTarget('198.51.100.7', deps({ '198.51.100.7': [v4('198.51.100.7')] }))).resolves.toBe(
      '198.51.100.7',
    )
  })

  it.each([
    ['127.0.0.1', v4('127.0.0.1')],
    ['127.8.9.10', v4('127.8.9.10')],
    ['::1', v6('::1')],
    ['::ffff:127.0.0.1', v6('::ffff:127.0.0.1')],
    ['::ffff:7f00:1', v6('::ffff:7f00:1')],
    ['0:0:0:0:0:ffff:7f00:1', v6('0:0:0:0:0:ffff:7f00:1')],
    ['0.0.0.0', v4('0.0.0.0')],
    ['::', v6('::')],
  ])('★ ループバック・未指定アドレスは拒否（%s）', async (host, addr) => {
    await expectForbidden(checkDirectRdpTarget(host, deps({ [host]: [addr] })), /loopback|unspecified/)
  })

  it.each([
    ['169.254.169.254', v4('169.254.169.254')],
    ['fe80::1', v6('fe80::1')],
    ['::ffff:169.254.169.254', v6('::ffff:169.254.169.254')],
    ['::ffff:a9fe:a9fe', v6('::ffff:a9fe:a9fe')],
  ])('★ リンクローカル（メタデータサービス）は拒否（%s）', async (host, addr) => {
    await expectForbidden(checkDirectRdpTarget(host, deps({ [host]: [addr] })), /link-local/)
  })

  it('★ 解決結果が複数なら、1 つでも当たれば拒否', async () => {
    await expectForbidden(
      checkDirectRdpTarget(
        'mixed.example.com',
        deps({ 'mixed.example.com': [v4('203.0.113.10'), v4('127.0.0.1')] }),
      ),
      /mixed\.example\.com/,
    )
  })

  it('★ 中継のアドレスを 16 進の IPv4 射影で書いても拒否', async () => {
    await expectForbidden(
      checkDirectRdpTarget(
        'relay-hex.example.com',
        deps({ 'relay-hex.example.com': [v6('::ffff:a14:5')] }, { relayAddresses: () => ['10.20.0.5'] }),
      ),
      /RDP tunnel relay/,
    )
  })

  it('★ このエージェントの中継が待ち受けているアドレスは拒否', async () => {
    await expectForbidden(
      checkDirectRdpTarget(
        'relay.example.com',
        deps({ 'relay.example.com': [v4('10.20.0.5')] }, { relayAddresses: () => ['10.20.0.5'] }),
      ),
      /RDP tunnel relay/,
    )
  })

  describe('Docker 形態（docker-network）', () => {
    const docker = (records: Record<string, Addr[]>) =>
      deps(
        { 'ais-guacd': [v4('172.18.0.2')], ...records },
        { listenMode: 'docker-network', guacdHost: 'ais-guacd' },
      )

    it('★ guacd と共有しているネットワークのサブネットは拒否（他プロジェクトの中継を含む）', async () => {
      await expectForbidden(
        checkDirectRdpTarget('peer', docker({ peer: [v4('172.18.200.9')] })),
        /guacd network 172\.18\.0\.0\/16/,
      )
    })

    it('★ guacd ネットワークのアドレスを 16 進の IPv4 射影で書いても拒否', async () => {
      await expectForbidden(
        checkDirectRdpTarget('peer-hex', docker({ 'peer-hex': [v6('::ffff:ac12:c809')] })),
        /guacd network 172\.18\.0\.0\/16/,
      )
    })

    it('guacd 自身が 16 進の IPv4 射影で解決されてもネットワークを特定できる', async () => {
      await expectForbidden(
        checkDirectRdpTarget(
          'peer',
          deps(
            { 'ais-guacd': [v6('::ffff:ac12:2')], peer: [v4('172.18.5.5')] },
            { listenMode: 'docker-network', guacdHost: 'ais-guacd' },
          ),
        ),
        /guacd network 172\.18\.0\.0\/16/,
      )
    })

    it('共有ネットワーク以外の自インタフェースのサブネットは拒否しない（顧客網の RDP ホスト）', async () => {
      await expect(checkDirectRdpTarget('lan', docker({ lan: [v4('10.20.0.50')] }))).resolves.toBe(
        '10.20.0.50',
      )
    })

    it('★ guacd を解決できなければ拒否（検査できないまま通さない）', async () => {
      await expectForbidden(
        checkDirectRdpTarget(
          'win',
          deps({ win: [v4('203.0.113.1')] }, { listenMode: 'docker-network', guacdHost: 'ais-guacd' }),
        ),
        /could not determine the guacd network/,
      )
    })

    it('★ guacd の属するインタフェースが見つからなければ拒否', async () => {
      await expectForbidden(
        checkDirectRdpTarget(
          'win',
          deps(
            { win: [v4('203.0.113.1')], 'ais-guacd': [v4('192.0.2.2')] },
            { listenMode: 'docker-network', guacdHost: 'ais-guacd' },
          ),
        ),
        /could not determine the guacd network/,
      )
    })
  })

  it('★ 名前解決に失敗したら拒否（理由は hostname だけ）', async () => {
    await expectForbidden(checkDirectRdpTarget('nowhere', deps({})), /could not resolve nowhere/)
  })

  it('hostname が空なら拒否', async () => {
    await expectForbidden(checkDirectRdpTarget('', deps({})), /hostname is required/)
  })

  it('解決結果が空なら拒否', async () => {
    await expectForbidden(checkDirectRdpTarget('empty', deps({ empty: [] })), /could not resolve empty/)
  })

  it('既定の依存（実 DNS）でも動く: localhost は拒否', async () => {
    await expectForbidden(checkDirectRdpTarget('localhost'), /loopback/)
  })

  it('既定の依存（実 DNS）でも動く: 公開 IP リテラルは通す', async () => {
    await expect(checkDirectRdpTarget('203.0.113.10')).resolves.toBe('203.0.113.10')
  })
})
