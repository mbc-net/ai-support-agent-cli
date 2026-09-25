import * as net from 'net'
import type { Duplex } from 'stream'

import {
  listActiveRelayAddresses,
  normalizePeerAddress,
  RDP_TUNNEL_MAX_CONNECTIONS,
  RDP_TUNNEL_MAX_PENDING_CONNECTIONS,
  type RdpRelayBinding,
  resolveRdpRelayBinding,
  startRdpTunnelRelay,
  type RdpTunnelRelay,
} from '../../src/rdp/rdp-tunnel'

/**
 * guacd から届くアドレスで待ち受け、接続ごとにトンネル側でも 1 本張って中継する。
 *
 * guacd（FreeRDP）はセキュリティ方式の交渉のやり直しや自動再接続で TCP を
 * 張り直すことがあるため、セッション中は**複数**の接続を受け付ける。
 *
 * :::danger
 * guacd と同じく、この中継にも認証は無い。到達できる者はトンネルの先
 * （顧客網の RDP ホスト）へ素通しで入れる。だから
 * - 接続元を guacd に限る（Docker 形態は ais-guacd の IP、loopback は 127.0.0.1）
 * - 同時接続数に上限を設ける（RDP_TUNNEL_MAX_CONNECTIONS）
 * - セッション終了で即閉じる
 * を実ソケットで確かめる。
 * :::
 */

/** 中継の合言葉（guacd に load-balance-info として渡す値）。 */
const TOKEN = 'relay-token_0123456789abcdefABCDEF'

/** FreeRDP と同じ形の X.224 Connection Request（routing token 付き）。 */
function connectionRequest(token: string | null = TOKEN): Buffer {
  const variable = token === null ? Buffer.alloc(0) : Buffer.from(`${token}\r\n`, 'latin1')
  const neg = Buffer.from([0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00])
  const total = 11 + variable.length + neg.length
  return Buffer.concat([
    Buffer.from([0x03, 0x00, total >> 8, total & 0xff, total - 5, 0xe0, 0, 0, 0, 0, 0]),
    variable,
    neg,
  ])
}

/**
 * トンネルの向こう側の代わり: 実 TCP のエコーサーバ。
 * 最初の TPKT（書き直された Connection Request）は記録してエコーしない。
 */
async function farSide(): Promise<{
  server: net.Server
  port: number
  accepted: net.Socket[]
  firstPackets: Buffer[]
}> {
  const accepted: net.Socket[] = []
  const firstPackets: Buffer[] = []
  const server = net.createServer((s) => {
    s.on('error', () => undefined)
    accepted.push(s)
    let head: Buffer | null = Buffer.alloc(0)
    s.on('data', (d: Buffer) => {
      if (head === null) {
        s.write(d)
        return
      }
      head = Buffer.concat([head, d])
      if (head.length < 4) return
      const len = head.readUInt16BE(2)
      if (head.length < len) return
      firstPackets.push(head.subarray(0, len))
      const rest = head.subarray(len)
      head = null
      if (rest.length) s.write(rest)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as net.AddressInfo).port, accepted, firstPackets }
}

/** 接続して、合言葉付きの Connection Request を送る（guacd の代わり）。 */
async function connectWithToken(port: number, token: string | null = TOKEN): Promise<net.Socket> {
  const socket = await connect(port)
  socket.on('error', () => undefined)
  socket.write(connectionRequest(token))
  return socket
}

function dialTo(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('error', () => undefined)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextData(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => socket.once('data', (d) => resolve(d.toString())))
}

function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve()
    else socket.once('close', () => resolve())
  })
}

/** 往復してから返す（中継がその接続を受理・dial し終えたことの確認）。 */
async function roundTrip(socket: net.Socket, text: string): Promise<string> {
  socket.write(text)
  return nextData(socket)
}

const until = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) await new Promise((r) => setTimeout(r, 5))
}

const LOOPBACK: RdpRelayBinding = {
  bindHost: '127.0.0.1',
  advertiseHost: '127.0.0.1',
  allowedPeer: '127.0.0.1',
}

describe('RDP_TUNNEL_MAX_CONNECTIONS', () => {
  it('同時接続の上限は 4', () => {
    expect(RDP_TUNNEL_MAX_CONNECTIONS).toBe(4)
  })
})

describe('startRdpTunnelRelay（実 TCP）', () => {
  const servers: net.Server[] = []
  const relays: RdpTunnelRelay[] = []
  const clients: net.Socket[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy()
    for (const relay of relays.splice(0)) await relay.close()
    for (const server of servers.splice(0)) server.close()
  })

  const start = async (
    binding: RdpRelayBinding = LOOPBACK,
    extra: { preDialed?: Duplex; dial?: () => Promise<Duplex>; gateTimeoutMs?: number } = {},
  ) => {
    const far = await farSide()
    servers.push(far.server)
    const dial = jest.fn(extra.dial ?? (() => dialTo(far.port)))
    const relay = await startRdpTunnelRelay(binding, {
      dial,
      preDialed: extra.preDialed,
      expectedToken: TOKEN,
      gateTimeoutMs: extra.gateTimeoutMs,
    })
    relays.push(relay)
    const guacd = async (token: string | null = TOKEN) => {
      const s = await connectWithToken(relay.port, token)
      clients.push(s)
      return s
    }
    const raw = async () => {
      const s = await connect(relay.port)
      s.on('error', () => undefined)
      clients.push(s)
      return s
    }
    return { far, relay, dial, guacd, raw }
  }

  it('★ 合言葉が一致した接続だけを dial し、合言葉を取り除いて送る', async () => {
    const { guacd, dial, far } = await start()
    expect(await roundTrip(await guacd(), 'hello')).toBe('hello')
    expect(dial).toHaveBeenCalledTimes(1)
    expect(far.firstPackets).toEqual([connectionRequest(null)])
    expect(far.firstPackets[0].includes(Buffer.from(TOKEN))).toBe(false)
  })

  it('★ api の元の load-balance-info があれば、合言葉の行と差し替えて送る', async () => {
    const far = await farSide()
    servers.push(far.server)
    const relay = await startRdpTunnelRelay(LOOPBACK, {
      dial: () => dialTo(far.port),
      expectedToken: TOKEN,
      forwardRoutingToken: 'tsv://MS Terminal Services Plugin.1.Sessions',
    })
    relays.push(relay)
    const s = await connectWithToken(relay.port)
    clients.push(s)
    expect(await roundTrip(s, 'x')).toBe('x')
    expect(far.firstPackets).toEqual([connectionRequest('tsv://MS Terminal Services Plugin.1.Sessions')])
  })

  it('★ 合言葉が違えば dial せずに切断する（実ソケット）', async () => {
    const { guacd, dial, relay } = await start()
    await closed(await guacd('relay-token_0123456789abcdefABCDEX'))
    expect(dial).not.toHaveBeenCalled()
    expect(relay.isClosed).toBe(false)
  })

  it('★ 合言葉が無い Connection Request は dial せずに切断する', async () => {
    const { guacd, dial } = await start()
    await closed(await guacd(null))
    expect(dial).not.toHaveBeenCalled()
  })

  it('★ mstshash の Cookie だけの Connection Request は dial せずに切断する', async () => {
    const { guacd, dial } = await start()
    await closed(await guacd('Cookie: mstshash=administrator'))
    expect(dial).not.toHaveBeenCalled()
  })

  it('★ RDP ではないデータは dial せずに切断する', async () => {
    const { raw, dial } = await start()
    const s = await raw()
    s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    await closed(s)
    expect(dial).not.toHaveBeenCalled()
  })

  it('★ 期限内に Connection Request が届かなければ dial せずに切断する', async () => {
    const { raw, dial } = await start(LOOPBACK, { gateTimeoutMs: 30 })
    const s = await raw()
    await closed(s)
    expect(dial).not.toHaveBeenCalled()
  })

  it('★ 1 バイトずつ届いても検査して通す', async () => {
    const { raw, dial } = await start()
    const s = await raw()
    for (const byte of connectionRequest()) {
      s.write(Buffer.from([byte]))
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(await roundTrip(s, 'slow')).toBe('slow')
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('検査に落ちた接続は事前に張った 1 本を消費しない', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    const { guacd, dial } = await start(LOOPBACK, { preDialed, dial: () => dialTo(far.port) })
    await closed(await guacd('wrong-token'))
    expect(await roundTrip(await guacd(), 'kept')).toBe('kept')
    expect(dial).not.toHaveBeenCalled()
  })

  it('advertiseHost とランダムポートを返す', async () => {
    const { relay } = await start({ bindHost: '127.0.0.1', advertiseHost: '10.1.2.3' })
    expect(relay.host).toBe('10.1.2.3')
    expect(relay.port).toBeGreaterThan(0)
  })

  it('★ 両方向に中継する', async () => {
    const { guacd } = await start()
    expect(await roundTrip(await guacd(), 'hello')).toBe('hello')
  })

  it('★ 接続ごとにトンネル側でも 1 本張る', async () => {
    const { guacd, dial, far } = await start()
    const a = await guacd()
    const b = await guacd()
    expect(await roundTrip(a, 'a')).toBe('a')
    expect(await roundTrip(b, 'b')).toBe('b')
    expect(dial).toHaveBeenCalledTimes(2)
    expect(far.accepted).toHaveLength(2)
  })

  it('★ 接続が切れても、セッションが続く限り待ち受けは残る（張り直しを受ける）', async () => {
    const { guacd, relay, far } = await start()
    const first = await guacd()
    await roundTrip(first, 'x')
    first.destroy()
    await until(() => relay.activeConnections === 0)
    expect(relay.isClosed).toBe(false)
    const second = await guacd()
    expect(await roundTrip(second, 'again')).toBe('again')
    expect(far.accepted).toHaveLength(2)
  })

  it('★ トンネル側の 1 本が切れたら、その guacd 接続だけ閉じる', async () => {
    const { guacd, relay, far } = await start()
    const a = await guacd()
    const b = await guacd()
    await roundTrip(a, 'a')
    await roundTrip(b, 'b')
    far.accepted[0].destroy()
    await closed(a)
    expect(await roundTrip(b, 'still')).toBe('still')
    expect(relay.isClosed).toBe(false)
  })

  it(`★ 同時接続は上限まで。超えた接続は拒否し、トンネル側に張らない`, async () => {
    const { guacd, relay, dial } = await start()
    const live: net.Socket[] = []
    for (let i = 0; i < RDP_TUNNEL_MAX_CONNECTIONS; i++) {
      const s = await guacd()
      await roundTrip(s, `c${i}`)
      live.push(s)
    }
    expect(relay.activeConnections).toBe(RDP_TUNNEL_MAX_CONNECTIONS)
    const over = await guacd()
    await closed(over)
    expect(dial).toHaveBeenCalledTimes(RDP_TUNNEL_MAX_CONNECTIONS)
    // 1 本空けば、また受ける
    live[0].destroy()
    await until(() => relay.activeConnections < RDP_TUNNEL_MAX_CONNECTIONS)
    expect(await roundTrip(await guacd(), 'ok')).toBe('ok')
  })

  it('★ 合言葉の確認待ちの空の接続で埋められても、正規の接続は通る', async () => {
    const { raw, guacd, dial } = await start()
    const idle: net.Socket[] = []
    for (let i = 0; i < RDP_TUNNEL_MAX_PENDING_CONNECTIONS; i++) idle.push(await raw())
    await new Promise((r) => setTimeout(r, 20))
    expect(await roundTrip(await guacd(), 'legit')).toBe('legit')
    expect(dial).toHaveBeenCalledTimes(1)
    // 押し出された空の接続がある（確認待ちの上限を超えた分）
    await closed(idle[0])
  })

  it('★ 確認待ちの接続は、確認済みの上限（4 本）に数えない', async () => {
    const { raw, guacd, relay } = await start()
    for (let i = 0; i < 3; i++) await raw()
    const live: net.Socket[] = []
    for (let i = 0; i < RDP_TUNNEL_MAX_CONNECTIONS; i++) {
      const s = await guacd()
      await roundTrip(s, `c${i}`)
      live.push(s)
    }
    expect(relay.activeConnections).toBe(RDP_TUNNEL_MAX_CONNECTIONS)
  })

  it('確認待ちの上限は 4', () => {
    expect(RDP_TUNNEL_MAX_PENDING_CONNECTIONS).toBe(4)
  })

  it('★ 上限は dial 待ちの接続も数える（同時に押し寄せても超えない）', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const far = await farSide()
    servers.push(far.server)
    const dial = jest.fn(async () => {
      await gate
      return dialTo(far.port)
    })
    const relay = await startRdpTunnelRelay(LOOPBACK, { dial, expectedToken: TOKEN })
    relays.push(relay)
    const sockets = await Promise.all(
      Array.from({ length: RDP_TUNNEL_MAX_CONNECTIONS + 2 }, () => connectWithToken(relay.port)),
    )
    clients.push(...sockets)
    await until(() => dial.mock.calls.length === RDP_TUNNEL_MAX_CONNECTIONS)
    await new Promise((r) => setTimeout(r, 20))
    expect(dial).toHaveBeenCalledTimes(RDP_TUNNEL_MAX_CONNECTIONS)
    release()
  })

  it('★ 許可していない接続元は切り、トンネル側に張らない', async () => {
    const { relay, dial, guacd } = await start({ ...LOOPBACK, allowedPeer: '10.9.9.9' })
    await closed(await guacd())
    await closed(await guacd())
    expect(dial).not.toHaveBeenCalled()
    expect(relay.isClosed).toBe(false)
  })

  it('★ dial に失敗したらその guacd 接続だけ閉じ、待ち受けは残す', async () => {
    let fail = true
    const far = await farSide()
    servers.push(far.server)
    const relay = await startRdpTunnelRelay(LOOPBACK, {
      expectedToken: TOKEN,
      dial: async () => {
        if (fail) throw new Error('channel open failed')
        return dialTo(far.port)
      },
    })
    relays.push(relay)
    const first = await connectWithToken(relay.port)
    clients.push(first)
    await closed(first)
    expect(relay.isClosed).toBe(false)
    fail = false
    const second = await connectWithToken(relay.port)
    clients.push(second)
    expect(await roundTrip(second, 'y')).toBe('y')
  })

  it('★ 事前に張った 1 本は最初の接続に使い、2 本目から dial する', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    const { guacd, dial } = await start(LOOPBACK, { preDialed, dial: () => dialTo(far.port) })
    expect(await roundTrip(await guacd(), 'p')).toBe('p')
    expect(dial).not.toHaveBeenCalled()
    expect(await roundTrip(await guacd(), 'q')).toBe('q')
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('★ 事前に張った 1 本が使う前に閉じていたら捨てて dial し直す', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    preDialed.destroy()
    const { guacd, dial } = await start(LOOPBACK, { preDialed, dial: () => dialTo(far.port) })
    expect(await roundTrip(await guacd(), 'fresh')).toBe('fresh')
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('★ 事前に張った 1 本が保持中に閉じられても、使わずに dial する', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    const { guacd, dial } = await start(LOOPBACK, { preDialed, dial: () => dialTo(far.port) })
    await until(() => far.accepted.length === 1)
    far.accepted[0].destroy()
    await closed(preDialed)
    expect(await roundTrip(await guacd(), 'fresh')).toBe('fresh')
    expect(dial).toHaveBeenCalledTimes(1)
  })

  it('★ 待ち受け中のアドレスを公開し、閉じたら外す（直接接続の宛先検査に使う）', async () => {
    const { relay } = await start({ ...LOOPBACK, bindHost: '127.0.0.1' })
    expect(listActiveRelayAddresses()).toContain('127.0.0.1')
    await relay.close()
    expect(listActiveRelayAddresses()).not.toContain('127.0.0.1')
  })

  it('事前に張った 1 本が使われないまま閉じたら破棄する', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    const { relay } = await start(LOOPBACK, { preDialed })
    await relay.close()
    expect(preDialed.destroyed).toBe(true)
  })

  it('★ close() で待ち受け・全接続を閉じ、onClosed を 1 回だけ通知（冪等）', async () => {
    const { relay, guacd } = await start()
    const reasons: string[] = []
    relay.onClosed((r) => reasons.push(r))
    const a = await guacd()
    const b = await guacd()
    await roundTrip(a, 'a')
    await roundTrip(b, 'b')
    await relay.close()
    await relay.close()
    await closed(a)
    await closed(b)
    expect(relay.isClosed).toBe(true)
    expect(reasons).toEqual(['relay closed'])
    await expect(connect(relay.port)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('★ close() は dial 待ちの接続も閉じ、後から届いたストリームを破棄する', async () => {
    let release: ((s: net.Socket) => void) | null = null
    const far = await farSide()
    servers.push(far.server)
    const late = await dialTo(far.port)
    const relay = await startRdpTunnelRelay(LOOPBACK, {
      expectedToken: TOKEN,
      dial: () =>
        new Promise<net.Socket>((r) => {
          release = r
        }),
    })
    relays.push(relay)
    const s = await connectWithToken(relay.port)
    clients.push(s)
    // 入口の検査を通って dial が始まるまで待つ（接続の受理だけでは早すぎる）
    await until(() => release !== null)
    await relay.close()
    await closed(s)
    ;(release as unknown as (s: net.Socket) => void)(late)
    await closed(late)
  })

  it('閉じた後に登録した onClosed も呼ばれる', async () => {
    const { relay } = await start()
    await relay.close()
    const reason = await new Promise<string>((resolve) => relay.onClosed(resolve))
    expect(reason).toBe('relay closed')
  })

  it('中継中のソケットエラーでも、その接続だけ閉じる（プロセスを落とさない）', async () => {
    let upstream: net.Socket | null = null
    const far = await farSide()
    servers.push(far.server)
    const relay = await startRdpTunnelRelay(LOOPBACK, {
      expectedToken: TOKEN,
      dial: async () => {
        upstream = await dialTo(far.port)
        return upstream
      },
    })
    relays.push(relay)
    const s = await connectWithToken(relay.port)
    clients.push(s)
    await roundTrip(s, 'z')
    ;(upstream as unknown as net.Socket).emit('error', new Error('boom'))
    await closed(s)
    expect(relay.isClosed).toBe(false)
  })

  it('★ 待ち受けに失敗したら事前に張った 1 本も閉じて失敗を返す', async () => {
    const far = await farSide()
    servers.push(far.server)
    const preDialed = await dialTo(far.port)
    await expect(
      // TEST-NET-3: どのインタフェースにも無いアドレス
      startRdpTunnelRelay(
        { bindHost: '203.0.113.254', advertiseHost: '203.0.113.254' },
        { dial: () => dialTo(far.port), preDialed, expectedToken: TOKEN },
      ),
    ).rejects.toThrow(/RDP tunnel relay could not listen/)
    expect(preDialed.destroyed).toBe(true)
  })
})

describe('normalizePeerAddress', () => {
  it.each([
    ['::ffff:172.18.0.2', '172.18.0.2'],
    ['::ffff:ac12:2', '172.18.0.2'],
    ['0:0:0:0:0:ffff:ac12:2', '172.18.0.2'],
    ['172.18.0.2', '172.18.0.2'],
    [undefined, ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizePeerAddress(input)).toBe(expected)
  })
})

describe('resolveRdpRelayBinding', () => {
  it('★ loopback: 127.0.0.1 で待ち受け、接続元も 127.0.0.1 に限る', async () => {
    await expect(resolveRdpRelayBinding('loopback', '127.0.0.1')).resolves.toEqual({
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      allowedPeer: '127.0.0.1',
    })
  })

  it('★ docker-network: guacd へ向かう経路のアドレスで待ち受け、接続元を guacd の IP に限る（実 DNS・実 UDP）', async () => {
    await expect(resolveRdpRelayBinding('docker-network', 'localhost')).resolves.toEqual({
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      allowedPeer: '127.0.0.1',
    })
  })

  it('docker-network: 注入した解決結果を使う', async () => {
    const binding = await resolveRdpRelayBinding('docker-network', 'ais-guacd', {
      lookup: async () => ({ address: '172.18.0.2', family: 4 }),
      localAddressFor: async (peer) => (peer === '172.18.0.2' ? '172.18.0.3' : 'x'),
    })
    expect(binding).toEqual({
      bindHost: '172.18.0.3',
      advertiseHost: '172.18.0.3',
      allowedPeer: '172.18.0.2',
    })
  })

  it('★ docker-network: 経路を選べないと 0.0.0.0 が返る — それで待ち受けず失敗する（実 UDP）', async () => {
    // dgram は経路を選べない宛先でもエラーにせず 0.0.0.0 を返す（実測）。
    // そのまま待ち受けると中継が全インタフェースに露出する。
    await expect(
      resolveRdpRelayBinding('docker-network', 'ais-guacd', {
        lookup: async () => ({ address: '999.1.1.1', family: 4 }),
      }),
    ).rejects.toThrow(/could not determine the local address that reaches guacd/)
  })

  it('docker-network: 注入した経路解決が IPv4 以外を返しても待ち受けない', async () => {
    await expect(
      resolveRdpRelayBinding('docker-network', 'ais-guacd', {
        lookup: async () => ({ address: '172.18.0.2', family: 4 }),
        localAddressFor: async () => '::',
      }),
    ).rejects.toThrow(/could not determine the local address/)
  })

  it('★ docker-network: guacd を解決できなければ失敗（直接接続へ逃げない）', async () => {
    await expect(
      resolveRdpRelayBinding('docker-network', 'ais-guacd', {
        lookup: async () => {
          throw new Error('ENOTFOUND ais-guacd')
        },
      }),
    ).rejects.toThrow(/could not resolve guacd host ais-guacd.*ENOTFOUND/)
  })
})
