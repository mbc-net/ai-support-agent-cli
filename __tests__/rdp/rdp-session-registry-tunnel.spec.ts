import { encodeGuacamoleInstruction } from '../../src/rdp/guacamole-protocol'
import type { GuacdSocket } from '../../src/rdp/guacd-handshake'
import type { RdpTunnelHandle } from '../../src/rdp/rdp-tunnel'
import { parseRdpTunnel, type RdpTunnel } from '../../src/rdp/rdp-tunnel-message'
import { RdpSessionRegistry } from '../../src/rdp/rdp-session-registry'

/**
 * トンネル経路のセッション（rdp_open に tunnel がある場合）。
 *
 * - トンネル＋中継を張ってから、その待ち受けアドレスを hostname/port として
 *   guacd に渡す
 * - 失敗は直接接続へ逃げず、既存の rdp_closed 契約で返す
 * - セッション終了でトンネル終了、トンネル切断でセッション終了
 */

class FakeSocket implements GuacdSocket {
  written: string[] = []
  destroyed = false
  private dataHandler: ((chunk: string) => void) | null = null
  private closeHandler: (() => void) | null = null
  write(data: string): void {
    this.written.push(data)
  }
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  onError(): void {}
  destroy(): void {
    this.destroyed = true
  }
  emit(opcode: string, args: string[]): void {
    this.dataHandler?.(encodeGuacamoleInstruction(opcode, args))
  }
  close(): void {
    this.closeHandler?.()
  }
}

const SSH_KEY = 'SECRET-SSH-KEY-MATERIAL'

const TUNNEL: RdpTunnel = parseRdpTunnel({
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
})

class FakeHandle implements RdpTunnelHandle {
  host = '127.0.0.1'
  port = 45123
  closeCount = 0
  private listeners: ((reason: string) => void)[] = []
  close = jest.fn(async () => {
    this.closeCount++
  })
  onClosed(listener: (reason: string) => void): void {
    this.listeners.push(listener)
  }
  drop(reason: string): void {
    this.listeners.forEach((l) => l(reason))
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('RdpSessionRegistry — トンネル経路', () => {
  let sockets: FakeSocket[]
  let outbound: Record<string, unknown>[]
  let handle: FakeHandle
  let openTunnel: jest.Mock
  let registry: RdpSessionRegistry

  beforeEach(() => {
    sockets = []
    outbound = []
    handle = new FakeHandle()
    openTunnel = jest.fn(async () => handle)
    registry = new RdpSessionRegistry({
      connect: async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      send: (msg) => outbound.push(msg as unknown as Record<string, unknown>),
      openTunnel,
    })
  })

  const request = (sessionId = 'sess-1') => ({
    sessionId,
    parameters: { username: 'u', password: 'pw' },
    width: 1280,
    height: 800,
    dpi: 96,
    tunnel: TUNNEL,
  })

  const openToReady = async (sessionId = 'sess-1'): Promise<FakeSocket> => {
    const promise = registry.open(request(sessionId))
    await flush()
    const socket = sockets[sockets.length - 1]
    socket.emit('args', ['VERSION_1_5_0', 'hostname', 'port', 'username', 'password'])
    socket.emit('ready', ['$c1'])
    await promise
    return socket
  }

  it('★ 合言葉を作ってトンネルに渡し、load-balance-info に上書きで入れる（api の値は捨てる）', async () => {
    const promise = registry.open({
      ...request(),
      parameters: { username: 'u', 'load-balance-info': 'from-api' },
    })
    await flush()
    const socket = sockets[0]
    socket.emit('args', ['VERSION_1_5_0', 'hostname', 'port', 'load-balance-info'])
    socket.emit('ready', ['$c1'])
    await promise
    const token = openTunnel.mock.calls[0][2] as string
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const connect = socket.written.find((w) => w.includes('7.connect')) as string
    expect(connect).toContain(`32.${token}`)
    expect(connect).not.toContain('from-api')
    // 元の値は中継へ渡し、RDP ホストへは中継が差し戻す
    expect(openTunnel.mock.calls[0][3]).toBe('from-api')
  })

  it('api の load-balance-info が無ければ中継へは undefined を渡す', async () => {
    await openToReady()
    expect(openTunnel.mock.calls[0][3]).toBeUndefined()
  })

  it('合言葉はセッションごとに変わる', async () => {
    await openToReady('sess-a')
    await openToReady('sess-b')
    expect(openTunnel.mock.calls[0][2]).not.toBe(openTunnel.mock.calls[1][2])
  })

  it('★ トンネルを張ってから guacd へ繋ぎ、中継のアドレスを hostname/port に差し込む', async () => {
    const socket = await openToReady()
    expect(openTunnel).toHaveBeenCalledWith(TUNNEL, 'sess-1', expect.any(String), undefined)
    const connect = socket.written.find((w) => w.includes('7.connect'))
    expect(connect).toContain('9.127.0.0.1')
    expect(connect).toContain('5.45123')
    expect(outbound).toEqual([{ type: 'rdp_ready', sessionId: 'sess-1', connectionId: '$c1' }])
  })

  it('★ トンネルに失敗したら guacd へ繋がず rdp_closed で返す（直接接続へ逃げない）', async () => {
    openTunnel.mockRejectedValueOnce(new Error('RDP tunnel (ssh via win-1) failed: refused'))
    await registry.open(request())
    expect(sockets).toHaveLength(0)
    expect(outbound).toEqual([
      {
        type: 'rdp_closed',
        sessionId: 'sess-1',
        reason: 'RDP tunnel (ssh via win-1) failed: refused',
      },
    ])
    expect(registry.size).toBe(0)
    expect(JSON.stringify(outbound)).not.toContain(SSH_KEY)
  })

  it('★ セッション終了でトンネルを閉じる', async () => {
    await openToReady()
    registry.close('sess-1', 'closed by API')
    await flush()
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(outbound.map((m) => m.type)).toEqual(['rdp_ready', 'rdp_closed'])
  })

  it('★ トンネルが切れたらセッションを終える', async () => {
    const socket = await openToReady()
    handle.drop('SSH connection to win-1 closed')
    await flush()
    expect(socket.destroyed).toBe(true)
    expect(outbound[outbound.length - 1]).toEqual({
      type: 'rdp_closed',
      sessionId: 'sess-1',
      reason: 'RDP tunnel closed: SSH connection to win-1 closed',
    })
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('★ トンネル確立中に閉じられたら、確立後すぐ閉じて guacd へ繋がない', async () => {
    let resolveTunnel: (h: FakeHandle) => void = () => undefined
    openTunnel.mockImplementationOnce(
      () =>
        new Promise<FakeHandle>((resolve) => {
          resolveTunnel = resolve
        }),
    )
    const promise = registry.open(request())
    await flush()
    registry.close('sess-1', 'client went away')
    resolveTunnel(handle)
    await promise
    await flush()
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(0)
    expect(outbound.map((m) => m.type)).toEqual(['rdp_closed'])
  })

  it('★ guacd のハンドシェイクに失敗したらトンネルを閉じる', async () => {
    const promise = registry.open(request())
    await flush()
    sockets[0].emit('error', ['refused', '519'])
    await promise
    await flush()
    expect(handle.close).toHaveBeenCalledTimes(1)
    expect(outbound.map((m) => m.type)).toEqual(['rdp_closed'])
  })

  it('トンネルの close() が失敗しても投げない', async () => {
    handle.close.mockRejectedValueOnce(new Error('already gone'))
    await openToReady()
    registry.close('sess-1', 'bye')
    await flush()
    expect(outbound.map((m) => m.type)).toEqual(['rdp_ready', 'rdp_closed'])
  })

  it('★ トンネルに対応していない構成（openTunnel 未設定）では断る', async () => {
    const plain = new RdpSessionRegistry({
      connect: async () => new FakeSocket(),
      send: (msg) => outbound.push(msg as unknown as Record<string, unknown>),
    })
    await plain.open(request())
    expect(outbound).toEqual([
      {
        type: 'rdp_closed',
        sessionId: 'sess-1',
        reason: 'RDP tunnels are not supported by this agent',
      },
    ])
  })

  it('tunnel が無ければ openTunnel を呼ばない（既存の直接接続）', async () => {
    const promise = registry.open({ ...request(), tunnel: undefined, parameters: { hostname: 'h' } })
    await flush()
    sockets[0].emit('args', ['VERSION_1_5_0', 'hostname'])
    sockets[0].emit('ready', ['$c'])
    await promise
    expect(openTunnel).not.toHaveBeenCalled()
  })
})

describe('RdpSessionRegistry — closeAll はトンネルの close を待つ', () => {
  it('★ closeAll は全トンネルの close が終わるまで待つ', async () => {
    let finishClose: () => void = () => undefined
    const handle = new FakeHandle()
    handle.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            handle.closeCount++
            resolve()
          }
        }),
    )
    const sockets: FakeSocket[] = []
    const registry = new RdpSessionRegistry({
      connect: async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      send: () => undefined,
      openTunnel: async () => handle,
    })
    const opening = registry.open({
      sessionId: 's1',
      parameters: {},
      width: 1,
      height: 1,
      dpi: 96,
      tunnel: TUNNEL,
    })
    await flush()
    sockets[0].emit('args', ['VERSION_1_5_0', 'hostname'])
    sockets[0].emit('ready', ['$c'])
    await opening

    let done = false
    const closing = registry.closeAll('shutdown').then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)
    finishClose()
    await closing
    expect(done).toBe(true)
    expect(handle.closeCount).toBe(1)
  })

  it('★ 確立中のトンネルも、確立を待って閉じてから解決する', async () => {
    let resolveTunnel: (h: FakeHandle) => void = () => undefined
    const handle = new FakeHandle()
    const registry = new RdpSessionRegistry({
      connect: async () => new FakeSocket(),
      send: () => undefined,
      openTunnel: () =>
        new Promise<FakeHandle>((resolve) => {
          resolveTunnel = resolve
        }),
    })
    void registry.open({ sessionId: 's1', parameters: {}, width: 1, height: 1, dpi: 96, tunnel: TUNNEL })
    await flush()
    let done = false
    const closing = registry.closeAll('shutdown').then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)
    resolveTunnel(handle)
    await closing
    expect(handle.close).toHaveBeenCalledTimes(1)
  })

  it('★ 上限時間を過ぎたら待つのをやめる（停止処理を止めない）', async () => {
    const handle = new FakeHandle()
    handle.close.mockImplementation(() => new Promise<void>(() => undefined))
    const sockets: FakeSocket[] = []
    const registry = new RdpSessionRegistry({
      connect: async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      send: () => undefined,
      openTunnel: async () => handle,
      closeTimeoutMs: 20,
    })
    const opening = registry.open({ sessionId: 's1', parameters: {}, width: 1, height: 1, dpi: 96, tunnel: TUNNEL })
    await flush()
    sockets[0].emit('args', ['VERSION_1_5_0', 'hostname'])
    sockets[0].emit('ready', ['$c'])
    await opening
    const started = Date.now()
    await registry.closeAll('shutdown')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('セッションが無ければすぐ解決する', async () => {
    const registry = new RdpSessionRegistry({ connect: async () => new FakeSocket(), send: () => undefined })
    await expect(registry.closeAll('x')).resolves.toBeUndefined()
  })
})

describe('RdpSessionRegistry — 直接接続の宛先検査', () => {
  const direct = (hostname?: string) => ({
    sessionId: 'sess-1',
    parameters: (hostname === undefined
      ? { username: 'u' }
      : { hostname, port: '3389', username: 'u' }) as Record<string, string>,
    width: 1280,
    height: 800,
    dpi: 96,
  })

  const make = (check: jest.Mock) => {
    const sockets: FakeSocket[] = []
    const outbound: Record<string, unknown>[] = []
    const registry = new RdpSessionRegistry({
      connect: async () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      send: (msg) => outbound.push(msg as unknown as Record<string, unknown>),
      checkDirectTarget: check,
    })
    return { registry, sockets, outbound }
  }

  it('★ 検査を通った宛先は、名前のまま guacd に渡す（証明書検証・Kerberos を変えない）', async () => {
    const check = jest.fn(async () => '203.0.113.10')
    const { registry, sockets } = make(check)
    const opening = registry.open(direct('win.example.com'))
    await flush()
    sockets[0].emit('args', ['VERSION_1_5_0', 'hostname', 'port'])
    sockets[0].emit('ready', ['$c'])
    await opening
    expect(check).toHaveBeenCalledWith('win.example.com')
    const connect = sockets[0].written.find((w) => w.includes('7.connect'))
    expect(connect).toContain('15.win.example.com')
    expect(connect).not.toContain('203.0.113.10')
  })

  it('直接接続には合言葉を入れない（api の load-balance-info をそのまま渡す）', async () => {
    const check = jest.fn(async () => '203.0.113.10')
    const { registry, sockets } = make(check)
    const opening = registry.open({
      ...direct('win.example.com'),
      parameters: { hostname: 'win.example.com', 'load-balance-info': 'tsv://MS Terminal Services Plugin.1.C' },
    })
    await flush()
    sockets[0].emit('args', ['VERSION_1_5_0', 'hostname', 'load-balance-info'])
    sockets[0].emit('ready', ['$c'])
    await opening
    const connect = sockets[0].written.find((w) => w.includes('7.connect'))
    expect(connect).toContain('tsv://MS Terminal Services Plugin.1.C')
  })

  it('★ 拒否されたら guacd へ繋がず、error（fatal）で返す（rdp_closed ではない）', async () => {
    const { RdpOpenRefusedError } = jest.requireActual('../../src/rdp/rdp-session-registry')
    const check = jest.fn(async () => {
      throw new RdpOpenRefusedError('direct_target_forbidden: 127.0.0.1 is a loopback address')
    })
    const { registry, sockets, outbound } = make(check)
    await registry.open(direct('127.0.0.1'))
    expect(sockets).toHaveLength(0)
    expect(outbound).toEqual([
      {
        type: 'error',
        sessionId: 'sess-1',
        message: 'direct_target_forbidden: 127.0.0.1 is a loopback address',
        fatal: true,
      },
    ])
    expect(registry.size).toBe(0)
  })

  it('★ hostname が無ければ拒否', async () => {
    const check = jest.fn()
    const { registry, sockets, outbound } = make(check)
    await registry.open(direct(undefined))
    expect(check).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(0)
    expect(outbound[0]).toEqual(
      expect.objectContaining({ type: 'error', fatal: true, message: 'direct_target_forbidden: hostname is required' }),
    )
  })

  it('★ 検査中に閉じられたら guacd へ繋がない', async () => {
    let resolveCheck: (v: string) => void = () => undefined
    const check = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCheck = resolve
        }),
    )
    const { registry, sockets, outbound } = make(check)
    const opening = registry.open(direct('win.example.com'))
    await flush()
    registry.close('sess-1', 'client went away')
    resolveCheck('203.0.113.10')
    await opening
    expect(sockets).toHaveLength(0)
    expect(outbound.map((m) => m.type)).toEqual(['rdp_closed'])
  })
})
