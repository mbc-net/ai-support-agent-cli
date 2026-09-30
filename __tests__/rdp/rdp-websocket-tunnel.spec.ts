import { RdpWebSocket, type RdpServerMessage } from '../../src/rdp/rdp-websocket'
import type { RdpTunnelSupport } from '../../src/rdp/rdp-tunnel'
import type { RdpTrustedCaStore } from '../../src/rdp/rdp-trusted-ca'

jest.mock('../../src/logger')

/**
 * rdp_open に tunnel がある場合の入口（実装契約 1・2）。
 *
 * 検証（kind と via の形・必須値）と、このエージェントがその経路を
 * 受けられるか（申告と同じ判定）を、セッションを登録する**前**に行う。
 * 断る理由は `error`（fatal）でブラウザまで届ける。
 */

const SSH_KEY = 'SECRET-SSH-KEY'

const sshTunnel = {
  kind: 'ssh',
  target: { host: 'localhost', port: 3389 },
  via: {
    hostId: 'win-1',
    hostname: 'win.example.com',
    port: 22,
    username: 'admin',
    authType: 'privateKey',
    credential: SSH_KEY,
  },
}

function harness(kinds: RdpTunnelSupport['supportedKinds'] = () => ['ssh', 'ssm']) {
  const tunnels: RdpTunnelSupport = {
    supportedKinds: jest.fn(kinds),
    open: jest.fn(async () => ({
      host: '127.0.0.1',
      port: 1,
      close: async () => undefined,
      onClosed: () => undefined,
    })),
    checkDirectTarget: jest.fn(async () => '203.0.113.10'),
  }
  const resolveGuacd = jest.fn(() => ({ host: 'ais-guacd', port: 4822 }))
  const trustedCa = { apply: jest.fn() } as unknown as RdpTrustedCaStore & { apply: jest.Mock }
  const ws = new RdpWebSocket(
    'https://api.example.com',
    'tok',
    'agent-1',
    resolveGuacd,
    tunnels,
    trustedCa,
  )
  const sent: Record<string, unknown>[] = []
  ;(ws as unknown as { sendMessage: (m: Record<string, unknown>) => void }).sendMessage = (m) => {
    sent.push(m)
  }
  const opened: unknown[] = []
  const registry = (ws as unknown as { registry: { open: (r: unknown) => Promise<void> } }).registry
  const realRegistry = registry
  ;(ws as unknown as { registry: unknown }).registry = {
    ...realRegistry,
    open: jest.fn((req: unknown) => {
      opened.push(req)
      return Promise.resolve()
    }),
  }
  const dispatch = (
    tunnel: unknown,
    // トンネル経路は証明書検証なし（ignore-cert=true）が前提（api が保証し、agent も確かめる）。
    parameters: Record<string, string> = { username: 'u', 'ignore-cert': 'true' },
    extra: Record<string, unknown> = {},
  ): void => {
    const msg = {
      type: 'rdp_open',
      sessionId: 'sess-1',
      parameters,
      width: 1280,
      height: 800,
      dpi: 96,
      tunnel,
      ...extra,
    } as RdpServerMessage
    ;(ws as unknown as { onParsedMessage: (m: RdpServerMessage) => void }).onParsedMessage(msg)
  }
  return { ws, tunnels, resolveGuacd, trustedCa, sent, opened, dispatch, realRegistry }
}

describe('RdpWebSocket — rdp_open.tunnel', () => {
  it('★ 検証済みの tunnel を登録簿へ渡す', () => {
    const h = harness()
    h.dispatch(sshTunnel)
    expect(h.sent).toEqual([])
    expect(h.opened).toEqual([
      expect.objectContaining({
        sessionId: 'sess-1',
        tunnel: expect.objectContaining({ kind: 'ssh', target: { host: 'localhost', port: 3389 } }),
      }),
    ])
  })

  it('★ 形の崩れた tunnel は致命エラーで断り、登録しない（秘匿値を載せない）', () => {
    const h = harness()
    h.dispatch({ ...sshTunnel, via: { ...sshTunnel.via, authType: 'nope' } })
    expect(h.opened).toEqual([])
    expect(h.sent).toEqual([
      {
        type: 'error',
        sessionId: 'sess-1',
        message: expect.stringMatching(/^rdp_tunnel_invalid: .*via\.authType/),
        fatal: true,
      },
    ])
    expect(JSON.stringify(h.sent)).not.toContain(SSH_KEY)
  })

  it('★ 申告していない経路は断る（rdp_tunnel_unsupported）', () => {
    const h = harness(() => ['ssh'])
    h.dispatch({
      kind: 'tailscale',
      target: { host: 'win.ts.net', port: 3389 },
      via: { hostId: 'w', authKey: 'tskey-secret' },
    })
    expect(h.opened).toEqual([])
    expect(h.sent).toEqual([
      {
        type: 'error',
        sessionId: 'sess-1',
        message: expect.stringMatching(/^rdp_tunnel_unsupported: .*tailscale/),
        fatal: true,
      },
    ])
    expect(JSON.stringify(h.sent)).not.toContain('tskey-secret')
  })

  it('★ 待ち受け設定の無い形態（CLI 直起動など）はトンネルを一切受けない', () => {
    const h = harness(() => undefined)
    h.dispatch(sshTunnel)
    expect(h.opened).toEqual([])
    expect(h.sent[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringMatching(/^rdp_tunnel_unsupported: /),
        fatal: true,
      }),
    )
  })

  it('tunnel: null も形の崩れとして断る', () => {
    const h = harness()
    h.dispatch(null)
    expect(h.opened).toEqual([])
    expect(h.sent[0]).toEqual(expect.objectContaining({ type: 'error', fatal: true }))
  })

  it('tunnel が無ければ従来どおり（申告の確認もしない）', () => {
    const h = harness()
    h.dispatch(undefined)
    expect(h.opened).toHaveLength(1)
    expect(h.tunnels.supportedKinds).not.toHaveBeenCalled()
  })

  it('★ 登録簿の openTunnel は guacd の接続先を添えてトンネルを開く', async () => {
    const h = harness()
    const options = (h.realRegistry as unknown as {
      options: {
        openTunnel: (t: unknown, id: string, token: string, original?: string) => Promise<unknown>
      }
    }).options
    const parsed = { kind: 'ssh' }
    await options.openTunnel(parsed, 'sess-9', 'tok', 'orig')
    expect(h.tunnels.open).toHaveBeenCalledWith(parsed, {
      sessionId: 'sess-9',
      guacdHost: 'ais-guacd',
      relayToken: 'tok',
      forwardRoutingToken: 'orig',
    })
  })

  it('既定の tunnels は環境から作る（待ち受け設定なし → 受けない）', () => {
    const ws = new RdpWebSocket('https://api.example.com', 'tok', 'agent-1', () => ({
      host: '127.0.0.1',
      port: 4822,
    }))
    const sent: Record<string, unknown>[] = []
    ;(ws as unknown as { sendMessage: (m: Record<string, unknown>) => void }).sendMessage = (m) => {
      sent.push(m)
    }
    ;(ws as unknown as { onParsedMessage: (m: RdpServerMessage) => void }).onParsedMessage({
      type: 'rdp_open',
      sessionId: 'sess-1',
      parameters: {},
      width: 1,
      height: 1,
      dpi: 96,
      tunnel: sshTunnel,
    } as RdpServerMessage)
    expect(sent[0]).toEqual(expect.objectContaining({ type: 'error', fatal: true }))
  })
})

describe('RdpWebSocket — トンネル経路での証明書検証（多層防御）', () => {
  // トンネル経路では guacd の hostname が中継アドレスで上書きされるため、証明書の
  // ホスト名は一致し得ない。api は接続前に拒否しているが、agent も受け付けない。
  it.each([
    ['ignore-cert=false', { username: 'u', 'ignore-cert': 'false' }],
    ['ignore-cert が無い（guacd の既定は検証あり）', { username: 'u' }],
  ])('★ %s のトンネル接続は、トンネルを開く前・CA を反映する前に断る', (_label, parameters) => {
    const h = harness()
    h.dispatch(sshTunnel, parameters, { trustedCaCertificates: [] })
    expect(h.opened).toEqual([])
    expect(h.tunnels.open).not.toHaveBeenCalled()
    expect(h.trustedCa.apply).not.toHaveBeenCalled()
    expect(h.resolveGuacd).not.toHaveBeenCalled()
    expect(h.sent).toEqual([
      {
        type: 'error',
        sessionId: 'sess-1',
        message: expect.stringMatching(/^certificate_verify_unsupported_on_tunnel: /),
        fatal: true,
      },
    ])
    expect(JSON.stringify(h.sent)).not.toContain(SSH_KEY)
  })

  it('ignore-cert=true のトンネル接続は従来どおり通す', () => {
    const h = harness()
    h.dispatch(sshTunnel, { username: 'u', 'ignore-cert': 'true' })
    expect(h.sent).toEqual([])
    expect(h.opened).toHaveLength(1)
  })

  it('★ 直接接続は証明書検証を有効にしてよい', () => {
    const h = harness()
    h.dispatch(undefined, { username: 'u', 'ignore-cert': 'false' }, { trustedCaCertificates: [] })
    expect(h.sent).toEqual([])
    expect(h.trustedCa.apply).toHaveBeenCalledWith([])
    expect(h.opened).toHaveLength(1)
  })
})

describe('RdpWebSocket — 直接接続の宛先検査と停止処理', () => {
  it('★ 登録簿の checkDirectTarget は guacd の接続先を添えて検査する', async () => {
    const h = harness()
    const options = (h.realRegistry as unknown as {
      options: { checkDirectTarget: (hostname: string) => Promise<string> }
    }).options
    await expect(options.checkDirectTarget('win.example.com')).resolves.toBe('203.0.113.10')
    expect(h.tunnels.checkDirectTarget).toHaveBeenCalledWith('win.example.com', { guacdHost: 'ais-guacd' })
  })

  it('★ shutdown() は切断し、全セッションとトンネルの後始末を待つ', async () => {
    const h = harness()
    let finish: () => void = () => undefined
    const closeAll = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    ;(h.ws as unknown as { registry: unknown }).registry = { ...h.realRegistry, closeAll }
    let done = false
    const shutting = h.ws.shutdown().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(closeAll).toHaveBeenCalledWith('API connection lost')
    expect(done).toBe(false)
    finish()
    await shutting
    expect(done).toBe(true)
  })
})
