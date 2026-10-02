import { EventEmitter } from 'events'
import * as net from 'net'
import { PassThrough } from 'stream'

/**
 * kind 別の dial と、トンネル＋中継を 1 つにまとめる openRdpTunnel。
 *
 * ssh2 はモックする（db-tunnel.spec.ts と同じ流儀）。SSM の子プロセスは
 * openSsmTunnel ごと差し替え、dial 先は実 TCP にする。
 */

class FakeSshClient extends EventEmitter {
  connect = jest.fn(() => {
    setImmediate(() => {
      if (sshBehaviour.connectError) this.emit('error', sshBehaviour.connectError)
      else this.emit('ready')
    })
  })
  end = jest.fn(() => {
    this.emit('close')
  })
  forwardOut = jest.fn(
    (
      _srcIp: string,
      _srcPort: number,
      _host: string,
      _port: number,
      cb: (err: Error | undefined, stream?: PassThrough) => void,
    ) => {
      if (sshBehaviour.forwardHang) {
        sshBehaviour.lateForward = (stream: PassThrough) => cb(undefined, stream)
        return
      }
      if (sshBehaviour.forwardError) cb(sshBehaviour.forwardError)
      else cb(undefined, new PassThrough())
    },
  )
}

const sshBehaviour: {
  connectError?: Error
  forwardError?: Error
  forwardHang?: boolean
  lateForward?: (stream: PassThrough) => void
} = {}
let lastClient: FakeSshClient | null = null
jest.mock('ssh2', () => ({
  Client: function () {
    lastClient = new FakeSshClient()
    return lastClient
  },
}))

const logged: string[] = []
jest.mock('../../src/logger', () => {
  const record = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  return {
    logger: { debug: record, info: record, warn: record, error: record, success: record },
  }
})

import {
  createRdpTunnelSupport,
  openRdpTunnel,
  openRdpTunnelDialer,
  openSshRdpDialer,
  openSsmRdpDialer,
  type RdpTunnelDialer,
} from '../../src/rdp/rdp-tunnel'
import {
  parseRdpTunnel,
  type RdpSshTunnel,
  type RdpSsmTunnel,
  type RdpTunnel,
} from '../../src/rdp/rdp-tunnel-message'

const SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-SSH\n-----END OPENSSH PRIVATE KEY-----'
const AWS_SECRET = 'aws-secret-access-key-value'
const TS_KEY = 'tskey-auth-secretvalue'

const sshTunnel = (via: Record<string, unknown> = {}): RdpSshTunnel =>
  parseRdpTunnel({
    kind: 'ssh',
    target: { host: '10.0.0.8', port: 3389 },
    via: {
      hostId: 'bastion-1',
      hostname: 'bastion.example.com',
      port: 2222,
      username: 'ops',
      authType: 'privateKey',
      credential: SSH_KEY,
      ...via,
    },
  }) as RdpSshTunnel

const ssmTunnel = (host = '10.0.1.20'): RdpSsmTunnel =>
  parseRdpTunnel({
    kind: 'ssm',
    target: { host, port: 3389 },
    via: {
      hostId: 'win-ssm',
      instanceId: 'i-0123456789abcdef0',
      region: 'ap-northeast-1',
      awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET },
    },
  }) as RdpSsmTunnel

const tailscaleTunnel = (): RdpTunnel =>
  parseRdpTunnel({
    kind: 'tailscale',
    target: { host: 'win.tail.ts.net', port: 3389 },
    via: { hostId: 'win-ts', authKey: TS_KEY },
  })

beforeEach(() => {
  sshBehaviour.connectError = undefined
  sshBehaviour.forwardError = undefined
  sshBehaviour.forwardHang = undefined
  sshBehaviour.lateForward = undefined
  lastClient = null
  logged.length = 0
})

afterEach(() => {
  for (const line of logged) {
    expect(line).not.toContain('SECRET-SSH')
    expect(line).not.toContain(AWS_SECRET)
    expect(line).not.toContain(TS_KEY)
  }
})

describe('openSshRdpDialer', () => {
  it('★ via の SSH ホストへ接続する（鍵認証）', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    expect(lastClient?.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'bastion.example.com',
        port: 2222,
        username: 'ops',
        privateKey: SSH_KEY,
      }),
    )
    await dialer.close()
  })

  it('パスワード認証', async () => {
    const dialer = await openSshRdpDialer(sshTunnel({ authType: 'password', credential: 'pw' }))
    const config = (lastClient?.connect.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(config.password).toBe('pw')
    expect(config.privateKey).toBeUndefined()
    await dialer.close()
  })

  it('★ dial は target へ forwardOut する', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    const stream = await dialer.dial()
    expect(stream).toBeInstanceOf(PassThrough)
    expect(lastClient?.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      '10.0.0.8',
      3389,
      expect.any(Function),
    )
    await dialer.close()
  })

  it('forwardOut の失敗を返す', async () => {
    sshBehaviour.forwardError = new Error('administratively prohibited')
    const dialer = await openSshRdpDialer(sshTunnel())
    await expect(dialer.dial()).rejects.toThrow(/administratively prohibited/)
    await dialer.close()
  })

  it('★ forwardOut に上限時間を設け、後から届いたストリームは捨てる', async () => {
    sshBehaviour.forwardHang = true
    const dialer = await openSshRdpDialer(sshTunnel(), { dialTimeoutMs: 20 })
    await expect(dialer.dial()).rejects.toThrow(/forward to 10\.0\.0\.8:3389 timed out after 20ms/)
    const late = new PassThrough()
    sshBehaviour.lateForward?.(late)
    await new Promise((r) => setImmediate(r))
    expect(late.destroyed).toBe(true)
    await dialer.close()
  })

  it('SSH 接続の失敗を返す', async () => {
    sshBehaviour.connectError = new Error('All configured authentication methods failed')
    await expect(openSshRdpDialer(sshTunnel())).rejects.toThrow(/authentication methods failed/)
  })

  it('★ SSH 接続が切れたら onClosed を通知', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    const reasons: string[] = []
    dialer.onClosed((r) => reasons.push(r))
    lastClient?.emit('close')
    expect(reasons).toEqual(['SSH connection to bastion-1 closed'])
  })

  it('★ 先に SSH 接続が切れ、そのあと onClosed を登録しても通知が届く', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    lastClient?.emit('close')
    const reason = await new Promise<string>((resolve) => dialer.onClosed(resolve))
    expect(reason).toBe('SSH connection to bastion-1 closed')
  })

  it('SSH の切断通知は 1 回だけ（複数の listener にはそれぞれ 1 回）', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    const a: string[] = []
    const b: string[] = []
    dialer.onClosed((r) => a.push(r))
    lastClient?.emit('close')
    lastClient?.emit('close')
    dialer.onClosed((r) => b.push(r))
    await new Promise((r) => setImmediate(r))
    expect(a).toEqual(['SSH connection to bastion-1 closed'])
    expect(b).toEqual(['SSH connection to bastion-1 closed'])
  })

  it('close() で SSH 接続を終える', async () => {
    const dialer = await openSshRdpDialer(sshTunnel())
    await dialer.close()
    expect(lastClient?.end).toHaveBeenCalled()
  })
})

describe('openSsmRdpDialer', () => {
  let server: net.Server
  let port: number

  beforeEach(async () => {
    server = net.createServer((s) => s.on('error', () => undefined))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as net.AddressInfo).port
  })

  afterEach(() => {
    server.close()
  })

  it('★ openSsmTunnel を ToRemoteHost で呼び、そのローカルポートへ dial する', async () => {
    const close = jest.fn(async () => undefined)
    const openSsmTunnel = jest.fn(async () => ({ host: '127.0.0.1', port, close, onClosed: jest.fn() }))
    const dialer = await openSsmRdpDialer(ssmTunnel(), { openSsmTunnel })
    expect(openSsmTunnel).toHaveBeenCalledWith({
      instanceId: 'i-0123456789abcdef0',
      region: 'ap-northeast-1',
      awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET },
      target: { host: '10.0.1.20', port: 3389 },
    })
    const stream = (await dialer.dial()) as net.Socket
    expect(stream.remotePort).toBe(port)
    stream.destroy()
    await dialer.close()
    expect(close).toHaveBeenCalled()
  })

  it('★ SSM のプロセスが終わったら onClosed を通知（トンネル自体の切断）', async () => {
    const listeners: ((reason: string) => void)[] = []
    const dialer = await openSsmRdpDialer(ssmTunnel(), {
      openSsmTunnel: async () => ({
        host: '127.0.0.1',
        port,
        close: async () => undefined,
        onClosed: (l: (reason: string) => void) => {
          listeners.push(l)
        },
      }),
    })
    const reasons: string[] = []
    dialer.onClosed((r) => reasons.push(r))
    listeners.forEach((l) => l('SSM session subprocess exited (code=0, signal=null)'))
    expect(reasons).toEqual(['SSM session subprocess exited (code=0, signal=null)'])
  })

  describe('自ホスト経由（target.host = localhost）は stdio 方式（待ち受けなし）', () => {
    class FakeChild extends EventEmitter {
      pid = 99
      stdin = new PassThrough()
      stdout = new PassThrough()
      stderr = new PassThrough()
      exitCode: number | null = null
      signalCode: NodeJS.Signals | null = null
      kill = jest.fn((signal: NodeJS.Signals) => {
        this.signalCode = signal
        setImmediate(() => this.emit('exit', null, signal))
        return true
      })
    }

    const setup = () => {
      const children: FakeChild[] = []
      const spawnSsmStdio = jest.fn((_args: string[], _env: NodeJS.ProcessEnv) => {
        const child = new FakeChild()
        children.push(child)
        setImmediate(() => child.emit('spawn'))
        return child as never
      })
      const openSsmTunnel = jest.fn()
      return { children, spawnSsmStdio, openSsmTunnel }
    }

    it('★ ローカルポートを開かず、dial ごとに AWS-StartSSHSession を stdio で起動する', async () => {
      const { children, spawnSsmStdio, openSsmTunnel } = setup()
      const dialer = await openSsmRdpDialer(ssmTunnel('localhost'), { spawnSsmStdio, openSsmTunnel, stdioSettleMs: 10 })
      expect(openSsmTunnel).not.toHaveBeenCalled()
      expect(spawnSsmStdio).not.toHaveBeenCalled()
      const stream = await dialer.dial()
      await dialer.dial()
      expect(spawnSsmStdio).toHaveBeenCalledTimes(2)
      const [args, env] = spawnSsmStdio.mock.calls[0]
      expect(args).toEqual([
        'ssm',
        'start-session',
        '--target',
        'i-0123456789abcdef0',
        '--document-name',
        'AWS-StartSSHSession',
        '--parameters',
        'portNumber=3389',
        '--region',
        'ap-northeast-1',
      ])
      expect(args.join(' ')).not.toContain(AWS_SECRET)
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(AWS_SECRET)
      expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA')
      const toChild = new Promise<string>((r) => children[0].stdin.once('data', (d) => r(d.toString())))
      stream.write('x224')
      expect(await toChild).toBe('x224')
      await dialer.close()
      expect(children[0].kill).toHaveBeenCalled()
      expect(children[1].kill).toHaveBeenCalled()
    })

    it('★ session-manager-plugin の Starting 行を捨て、RDP データだけを渡す', async () => {
      const { children, spawnSsmStdio } = setup()
      const dialer = await openSsmRdpDialer(ssmTunnel('localhost'), { spawnSsmStdio, stdioSettleMs: 60_000 })
      const opening = dialer.dial()
      await new Promise((r) => setImmediate(r))
      children[0].stdout.write('\nStarting session with SessionId: botocore-0123456789abcdef0\n')
      const stream = await opening
      const received = new Promise<Buffer>((r) => stream.once('data', (d: Buffer) => r(d)))
      children[0].stdout.write(Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0, 0, 0, 0, 0]))
      expect(await received).toEqual(Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0, 0, 0, 0, 0]))
      await dialer.close()
    })

    it('トンネル自体の切断は無い（常駐プロセスを持たない）: onClosed は登録を受けるだけ', async () => {
      const { spawnSsmStdio } = setup()
      const dialer = await openSsmRdpDialer(ssmTunnel('localhost'), { spawnSsmStdio, stdioSettleMs: 60_000 })
      const listener = jest.fn()
      dialer.onClosed(listener)
      await dialer.close()
      await new Promise((r) => setImmediate(r))
      expect(listener).not.toHaveBeenCalled()
    })

    it('既定の起動関数でも組み立てられる（aws が無ければ dial が失敗する）', async () => {
      const saved = process.env.PATH
      process.env.PATH = '/nonexistent'
      try {
        const dialer = await openSsmRdpDialer(ssmTunnel('localhost'), { dialTimeoutMs: 2_000 })
        await expect(dialer.dial()).rejects.toThrow(/could not be started/)
        await dialer.close()
      } finally {
        process.env.PATH = saved
      }
    })
  })

  it('dial 先が閉じていれば失敗', async () => {
    const dialer = await openSsmRdpDialer(ssmTunnel(), {
      openSsmTunnel: async () => ({
        host: '127.0.0.1',
        port: 1,
        close: async () => undefined,
        onClosed: () => undefined,
      }),
    })
    await expect(dialer.dial()).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('openRdpTunnelDialer', () => {
  const fake = (): RdpTunnelDialer => ({
    dial: jest.fn(),
    close: jest.fn(async () => undefined),
    onClosed: jest.fn(),
  })

  it.each([
    ['ssh', sshTunnel],
    ['ssm', ssmTunnel],
    ['tailscale', tailscaleTunnel],
  ])('kind=%s を対応する dialer へ振り分ける', async (kind, make) => {
    const openers = {
      ssh: jest.fn(async () => fake()),
      ssm: jest.fn(async () => fake()),
      tailscale: jest.fn(async () => fake()),
    }
    await openRdpTunnelDialer(make(), { sessionId: 'sess-1' }, openers)
    for (const [name, opener] of Object.entries(openers)) {
      expect(opener).toHaveBeenCalledTimes(name === kind ? 1 : 0)
    }
  })
})

describe('openRdpTunnel', () => {
  const LOOPBACK = { bindHost: '127.0.0.1', advertiseHost: '127.0.0.1' }

  function fakeDialer(stream?: PassThrough | Error) {
    const listeners: ((reason: string) => void)[] = []
    const dialer = {
      dial: jest.fn(async () => {
        if (stream instanceof Error) throw stream
        return stream ?? new PassThrough()
      }),
      close: jest.fn(async () => undefined),
      onClosed: jest.fn((l: (reason: string) => void) => {
        listeners.push(l)
      }),
      fireClosed: (reason: string) => listeners.forEach((l) => l(reason)),
    }
    return dialer
  }

  const RELAY_TOKEN = 'relay_token-0123456789abcdefABCDEF'
  const ctx = {
    sessionId: 'sess-1',
    guacdHost: '127.0.0.1',
    listenMode: 'loopback' as const,
    relayToken: RELAY_TOKEN,
  }

  /** guacd の代わり: 接続して、合言葉付きの Connection Request を送る。 */
  const connectAsGuacd = (port: number): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1')
      c.on('error', () => undefined)
      c.once('connect', () => {
        const variable = Buffer.from(`${RELAY_TOKEN}\r\n`)
        const total = 11 + variable.length
        c.write(
          Buffer.concat([
            Buffer.from([0x03, 0x00, total >> 8, total & 0xff, total - 5, 0xe0, 0, 0, 0, 0, 0]),
            variable,
          ]),
        )
        resolve(c)
      })
      c.once('error', reject)
    })

  it('★ トンネルを張って dial し、中継のアドレスを返す', async () => {
    const dialer = fakeDialer()
    const resolveBinding = jest.fn(async () => LOOPBACK)
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding,
    })
    expect(resolveBinding).toHaveBeenCalledWith('loopback', '127.0.0.1')
    expect(dialer.dial).toHaveBeenCalledTimes(1)
    expect(handle.host).toBe('127.0.0.1')
    expect(handle.port).toBeGreaterThan(0)
    await handle.close()
    expect(dialer.close).toHaveBeenCalled()
  })

  it('★ dial に失敗したらトンネルを閉じ、理由から秘匿値を伏せる', async () => {
    const dialer = fakeDialer(new Error(`channel open failed near ${SSH_KEY}`))
    let caught: Error | undefined
    try {
      await openRdpTunnel(sshTunnel(), ctx, {
        openDialer: async () => dialer,
        resolveBinding: async () => LOOPBACK,
      })
    } catch (error) {
      caught = error as Error
    }
    expect(caught?.message).toMatch(/^RDP tunnel \(ssh via bastion-1\) failed: channel open failed near \*\*\*$/)
    expect(dialer.close).toHaveBeenCalled()
  })

  it('トンネルを張れなければ失敗（秘匿値を伏せる）', async () => {
    await expect(
      openRdpTunnel(tailscaleTunnel(), ctx, {
        openDialer: async () => {
          throw new Error(`up failed for ${TS_KEY}`)
        },
        resolveBinding: async () => LOOPBACK,
      }),
    ).rejects.toThrow('RDP tunnel (tailscale via win-ts) failed: up failed for ***')
  })

  it('★ 待ち受け先を決められなければトンネルを張らない', async () => {
    const openDialer = jest.fn()
    await expect(
      openRdpTunnel(sshTunnel(), ctx, {
        openDialer,
        resolveBinding: async () => {
          throw new Error('could not resolve guacd host')
        },
      }),
    ).rejects.toThrow(/could not resolve guacd host/)
    expect(openDialer).not.toHaveBeenCalled()
  })

  it('★ トンネルが切れたら中継も閉じて onClosed を通知', async () => {
    const dialer = fakeDialer()
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    const reasons: string[] = []
    handle.onClosed((r) => reasons.push(r))
    dialer.fireClosed('SSH connection to bastion-1 closed')
    dialer.fireClosed('again')
    await new Promise((r) => setImmediate(r))
    expect(reasons).toEqual(['SSH connection to bastion-1 closed'])
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(handle.port, '127.0.0.1')
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      }),
    ).rejects.toThrow(/ECONNREFUSED/)
    expect(dialer.close).toHaveBeenCalled()
  })

  it('★ guacd の 1 本が切れてもセッションは続く（トンネルも中継も閉じない）', async () => {
    const stream = new PassThrough()
    const dialer = fakeDialer(stream)
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    const reasons: string[] = []
    handle.onClosed((r) => reasons.push(r))
    stream.destroy()
    await new Promise((r) => setTimeout(r, 10))
    expect(reasons).toEqual([])
    expect(dialer.close).not.toHaveBeenCalled()
    const s = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.connect(handle.port, '127.0.0.1')
      c.once('connect', () => resolve(c))
      c.once('error', reject)
    })
    s.destroy()
    await handle.close()
  })

  it('★ guacd の接続ごとにトンネル側でも dial する（1 本目は事前に張った分を使う）', async () => {
    const dialer = fakeDialer()
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    const open = () => connectAsGuacd(handle.port)
    const a = await open()
    const b = await open()
    const c = await open()
    const deadline = Date.now() + 2_000
    while (dialer.dial.mock.calls.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(dialer.dial).toHaveBeenCalledTimes(3)
    for (const sock of [a, b, c]) sock.destroy()
    await handle.close()
  })

  it('接続ごとの dial の失敗は警告に留め、秘匿値を伏せる', async () => {
    const dialer = fakeDialer()
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    dialer.dial.mockRejectedValue(new Error(`refused near ${SSH_KEY}`))
    const first = await connectAsGuacd(handle.port)
    // 事前に張った 1 本が 1 本目に使われたと確かめてから 2 本目を開く
    await new Promise((r) => setTimeout(r, 20))
    const second = await connectAsGuacd(handle.port)
    await new Promise<void>((resolve) => second.once('close', () => resolve()))
    expect(logged.join('\n')).toMatch(/dial failed for session sess-1: refused near \*\*\*/)
    first.destroy()
    await handle.close()
  })

  it('★ dial の最中にトンネルが切れたら（onClosed 登録前の切断）開かずに失敗し、片付ける', async () => {
    const dialer = fakeDialer()
    dialer.dial.mockImplementationOnce(async () => {
      dialer.fireClosed('SSH connection to bastion-1 closed')
      return new PassThrough()
    })
    await expect(
      openRdpTunnel(sshTunnel(), ctx, {
        openDialer: async () => dialer,
        resolveBinding: async () => LOOPBACK,
      }),
    ).rejects.toThrow(
      'RDP tunnel (ssh via bastion-1) failed: tunnel closed before it was ready: SSH connection to bastion-1 closed',
    )
    expect(dialer.close).toHaveBeenCalled()
  })

  it('★ openRdpTunnel 全体に期限を設け、期限後に開いたトンネルは閉じる', async () => {
    const dialer = fakeDialer()
    let resolveDialer: (d: typeof dialer) => void = () => undefined
    await expect(
      openRdpTunnel(sshTunnel(), ctx, {
        openDialer: () =>
          new Promise((resolve) => {
            resolveDialer = resolve
          }),
        resolveBinding: async () => LOOPBACK,
        openTimeoutMs: 20,
      }),
    ).rejects.toThrow('RDP tunnel (ssh via bastion-1) failed: timed out after 20ms')
    resolveDialer(dialer)
    const deadline = Date.now() + 2_000
    while (!dialer.close.mock.calls.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(dialer.close).toHaveBeenCalled()
  })

  it('★ openDialer 直後（dial より前）に onClosed を登録する', async () => {
    const order: string[] = []
    const dialer = fakeDialer()
    dialer.onClosed.mockImplementation(() => {
      order.push('onClosed')
    })
    dialer.dial.mockImplementation(async () => {
      order.push('dial')
      return new PassThrough()
    })
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    expect(order[0]).toBe('onClosed')
    await handle.close()
  })

  it('トンネルの close() の失敗は警告に留め、秘匿値を伏せる', async () => {
    const dialer = fakeDialer()
    dialer.close.mockRejectedValue(new Error(`teardown near ${SSH_KEY}`))
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    await expect(handle.close()).resolves.toBeUndefined()
    expect(logged.join('\n')).toMatch(/close failed: teardown near \*\*\*/)
  })

  it('閉じた後に登録した onClosed も呼ばれる', async () => {
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => fakeDialer(),
      resolveBinding: async () => LOOPBACK,
    })
    await handle.close()
    await expect(new Promise((resolve) => handle.onClosed(resolve))).resolves.toBe(
      'closed by session',
    )
  })

  it('★ 合言葉も秘匿値として伏せる', async () => {
    const dialer = fakeDialer(new Error(`refused, token was ${RELAY_TOKEN}`))
    await expect(
      openRdpTunnel(sshTunnel(), ctx, {
        openDialer: async () => dialer,
        resolveBinding: async () => LOOPBACK,
      }),
    ).rejects.toThrow('RDP tunnel (ssh via bastion-1) failed: refused, token was ***')
  })

  it('★ 合言葉の無い接続では dial しない（中継の入口で弾く）', async () => {
    const dialer = fakeDialer()
    const handle = await openRdpTunnel(sshTunnel(), ctx, {
      openDialer: async () => dialer,
      resolveBinding: async () => LOOPBACK,
    })
    const first = await connectAsGuacd(handle.port) // 事前に張った 1 本を使う
    const stranger = await new Promise<net.Socket>((resolve) => {
      const c = net.connect(handle.port, '127.0.0.1', () => resolve(c))
      c.on('error', () => undefined)
    })
    stranger.write('not rdp')
    await new Promise<void>((resolve) => stranger.once('close', () => resolve()))
    expect(dialer.dial).toHaveBeenCalledTimes(1)
    first.destroy()
    await handle.close()
  })

  it('既定の openDialer / resolveBinding でも動く（ssh・loopback）', async () => {
    const handle = await openRdpTunnel(sshTunnel(), ctx)
    expect(lastClient?.forwardOut).toHaveBeenCalled()
    await handle.close()
    expect(lastClient?.end).toHaveBeenCalled()
  })
})

describe('createRdpTunnelSupport — checkDirectTarget', () => {
  it('形態（listen mode）と guacd の接続先を添えて検査する', async () => {
    const check = jest.fn(async () => '203.0.113.10')
    const support = createRdpTunnelSupport(
      { AI_SUPPORT_AGENT_IN_DOCKER: '1', AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN: 'docker-network' },
      { checkDirectTarget: check },
    )
    await expect(support.checkDirectTarget('win', { guacdHost: 'ais-guacd' })).resolves.toBe('203.0.113.10')
    expect(check).toHaveBeenCalledWith(
      'win',
      expect.objectContaining({ listenMode: 'docker-network', guacdHost: 'ais-guacd' }),
    )
  })

  it('既定の検査（実 DNS）: 中継を使う形態ではループバックを拒否', async () => {
    const support = createRdpTunnelSupport({
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN: 'loopback',
    })
    await expect(support.checkDirectTarget('127.0.0.1', { guacdHost: '127.0.0.1' })).rejects.toThrow(
      /direct_target_forbidden/,
    )
  })

  it('★ 中継を使わない形態（CLI 直起動・外部 guacd）では検査しない（従来どおり）', async () => {
    const check = jest.fn()
    const support = createRdpTunnelSupport({}, { checkDirectTarget: check })
    await expect(support.checkDirectTarget('127.0.0.1', { guacdHost: '127.0.0.1' })).resolves.toBeUndefined()
    expect(check).not.toHaveBeenCalled()
  })
})

describe('createRdpTunnelSupport', () => {
  const LISTEN = 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN'

  it('★ 待ち受け設定が無ければ申告せず、open も断る', async () => {
    const support = createRdpTunnelSupport({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })
    expect(support.supportedKinds()).toBeUndefined()
    await expect(
      support.open(sshTunnel(), { sessionId: 's', guacdHost: '127.0.0.1', relayToken: 't' }),
    ).rejects.toThrow(/not configured/)
  })

  it('待ち受け設定があれば形態に合わせて openRdpTunnel を呼ぶ', async () => {
    const openTunnel = jest.fn(async () => ({
      host: '127.0.0.1',
      port: 1,
      close: async () => undefined,
      onClosed: () => undefined,
    }))
    const env = { KUBERNETES_SERVICE_HOST: '10.0.0.1', [LISTEN]: 'loopback', PATH: '' }
    const support = createRdpTunnelSupport(env, { openTunnel })
    expect(support.supportedKinds()).toEqual(['ssh'])
    const tunnel = sshTunnel()
    await support.open(tunnel, { sessionId: 's', guacdHost: '127.0.0.1', relayToken: 't', forwardRoutingToken: 'o' })
    expect(openTunnel).toHaveBeenCalledWith(tunnel, {
      sessionId: 's',
      guacdHost: '127.0.0.1',
      listenMode: 'loopback',
      relayToken: 't',
      forwardRoutingToken: 'o',
    })
  })
})
