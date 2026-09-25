import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'

const logged: string[] = []
jest.mock('../../src/logger', () => {
  const record = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  return {
    logger: { debug: record, info: record, warn: record, error: record, success: record },
  }
})

import {
  openTailscaleRdpDialer,
  runTailscaleCli,
  spawnTailscaled,
  spawnTailscaleNc,
  tailscaleNodeName,
  waitForSocketFile,
  type TailscaleDialerDeps,
} from '../../src/rdp/rdp-tunnel-tailscale'
import { parseRdpTunnel, type RdpTunnel } from '../../src/rdp/rdp-tunnel-message'
import { trackedChildProcessCount } from '../../src/utils/child-process-reaper'

/**
 * Tailscale 経路: セッションごとに userspace の tailscaled を起動し、接続ごとに
 * `tailscale nc <target.host> <target.port>` の標準入出力を中継に使う。
 *
 * :::danger
 * - **TCP の待ち受けを 1 つも開かない。** 以前は認証なしの SOCKS5 を
 *   127.0.0.1 に開いており、同じホストの誰でも tailnet の任意の宛先へ
 *   入れた。tailscaled は 0700 の一時ディレクトリ内の unix socket だけを持つ。
 * - **行き先は target に固定。** nc の引数はエージェントが組み立てる。
 * - **authkey をコマンドラインに載せない。** `ps` で見える。
 * - **子プロセスを残さない。** nc も tailscaled も、どの経路で終わっても kill する。
 * :::
 */

const TS_KEY = 'tskey-auth-kSECRETVALUE'

const tunnel = (): Extract<RdpTunnel, { kind: 'tailscale' }> =>
  parseRdpTunnel({
    kind: 'tailscale',
    target: { host: 'win.tail1234.ts.net', port: 3389 },
    via: { hostId: 'win-ts', authKey: TS_KEY },
  }) as Extract<RdpTunnel, { kind: 'tailscale' }>

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = jest.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    setImmediate(() => this.emit('exit', null, signal))
    return true
  })
  exitOnItsOwn(code: number): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

describe('openTailscaleRdpDialer', () => {
  let tmpRoot: string
  let daemon: FakeChild
  let ncChildren: FakeChild[]
  let cliCalls: string[][]
  let keyFileDuringUp: { content: string; mode: number } | null

  beforeEach(() => {
    logged.length = 0
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-ts-spec-'))
    daemon = new FakeChild()
    ncChildren = []
    cliCalls = []
    keyFileDuringUp = null
  })

  afterEach(() => {
    for (const line of logged) expect(line).not.toContain(TS_KEY)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const deps = (overrides: Partial<TailscaleDialerDeps> = {}): TailscaleDialerDeps => ({
    tmpRoot,
    spawnDaemon: jest.fn(() => daemon as never),
    waitForReady: jest.fn(async () => undefined),
    runCli: jest.fn(async (args: string[]) => {
      cliCalls.push(args)
      const keyArg = args.find((a) => a.startsWith('--auth-key=file:'))
      if (keyArg) {
        const file = keyArg.slice('--auth-key=file:'.length)
        keyFileDuringUp = {
          content: fs.readFileSync(file, 'utf8'),
          mode: fs.statSync(file).mode & 0o777,
        }
      }
    }),
    spawnNc: jest.fn(() => {
      const child = new FakeChild()
      ncChildren.push(child)
      setImmediate(() => child.emit('spawn'))
      return child as never
    }),
    timeoutMs: 5_000,
    stdioSettleMs: 10,
    ...overrides,
  })

  const workDirs = () => fs.readdirSync(tmpRoot)

  it('★ tailscaled を userspace + メモリ状態 + 一時ディレクトリで起動し、SOCKS5 を開かない', async () => {
    const d = deps()
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 'sess-1' }, d)
    const args = (d.spawnDaemon as jest.Mock).mock.calls[0][0] as string[]
    const [dir] = workDirs()
    const workDir = path.join(tmpRoot, dir)
    expect(args).toEqual([
      '--tun=userspace-networking',
      '--state=mem:',
      `--statedir=${workDir}`,
      `--socket=${path.join(workDir, 'tailscaled.sock')}`,
      '--port=0',
    ])
    expect(args.join(' ')).not.toMatch(/socks5|outbound-http-proxy/)
    expect(fs.statSync(workDir).mode & 0o777).toBe(0o700)
    expect(d.waitForReady).toHaveBeenCalledWith(
      path.join(workDir, 'tailscaled.sock'),
      5_000,
      expect.any(Function),
    )
    await dialer.close()
  })

  it('★ authkey はファイル（0600）で渡し、引数には載せず、up の後に消す', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 'Sess_1' }, deps())
    const [dir] = workDirs()
    const workDir = path.join(tmpRoot, dir)
    expect(cliCalls[0]).toEqual([
      `--socket=${path.join(workDir, 'tailscaled.sock')}`,
      'up',
      `--auth-key=file:${path.join(workDir, 'authkey')}`,
      '--hostname=ais-rdp-sess-1',
      '--timeout=5s',
    ])
    for (const arg of cliCalls.flat()) expect(arg).not.toContain(TS_KEY)
    expect(keyFileDuringUp).toEqual({ content: TS_KEY, mode: 0o600 })
    expect(fs.existsSync(path.join(workDir, 'authkey'))).toBe(false)
    await dialer.close()
  })

  it('★ dial は `tailscale --socket=… nc <host> <port>` を起動し、その標準入出力を返す', async () => {
    const d = deps()
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)
    const [dir] = workDirs()
    const stream = await dialer.dial()
    expect(d.spawnNc).toHaveBeenCalledWith([
      `--socket=${path.join(tmpRoot, dir, 'tailscaled.sock')}`,
      'nc',
      'win.tail1234.ts.net',
      '3389',
    ])
    const nc = ncChildren[0]
    const toNc = new Promise<string>((resolve) => nc.stdin.once('data', (d) => resolve(d.toString())))
    stream.write('client->rdp')
    expect(await toNc).toBe('client->rdp')
    const fromNc = new Promise<string>((resolve) => stream.once('data', (d: Buffer) => resolve(d.toString())))
    nc.stdout.write('rdp->client')
    expect(await fromNc).toBe('rdp->client')
    stream.destroy()
    await dialer.close()
  })

  it('★ 返したストリームを閉じたら nc を kill する', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, deps())
    const stream = await dialer.dial()
    stream.destroy()
    await new Promise((r) => setImmediate(r))
    expect(ncChildren[0].kill).toHaveBeenCalledWith('SIGTERM')
    await dialer.close()
  })

  it('★ nc が終わったらストリームも閉じる（接続失敗・切断）', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, deps())
    const stream = await dialer.dial()
    const closed = new Promise<void>((resolve) => stream.once('close', () => resolve()))
    ncChildren[0].exitOnItsOwn(1)
    await closed
    await dialer.close()
  })

  it('★ nc を起動できなければ dial は失敗する', async () => {
    const d = deps({
      spawnNc: jest.fn(() => {
        const child = new FakeChild()
        child.pid = undefined
        ncChildren.push(child)
        setImmediate(() => child.emit('error', new Error('spawn tailscale ENOENT')))
        return child as never
      }),
    })
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)
    await expect(dialer.dial()).rejects.toThrow(/tailscale nc \(session s, win\.tail1234\.ts\.net:3389\) could not be started: spawn tailscale ENOENT/)
    await dialer.close()
  })

  it('★ nc の起動が期限内に終わらなければ失敗し、kill する', async () => {
    const d = deps({
      timeoutMs: 20,
      spawnNc: jest.fn(() => {
        const child = new FakeChild()
        ncChildren.push(child)
        return child as never
      }),
    })
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)
    await expect(dialer.dial()).rejects.toThrow(/tailscale nc \(session s, win\.tail1234\.ts\.net:3389\) did not start within 20ms/)
    expect(ncChildren[0].kill).toHaveBeenCalled()
    await dialer.close()
  })

  it('★ close() で残っている nc を kill → logout → tailscaled 終了 → 一時ディレクトリ削除（冪等）', async () => {
    const d = deps()
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)
    await dialer.dial()
    await dialer.close()
    await dialer.close()
    expect(ncChildren[0].kill).toHaveBeenCalled()
    expect(cliCalls.map((a) => a[1])).toEqual(['up', 'logout'])
    expect(daemon.kill).toHaveBeenCalledWith('SIGTERM')
    expect(workDirs()).toEqual([])
  })

  it('logout に失敗しても tailscaled は止めて片付ける', async () => {
    const d = deps({
      runCli: jest.fn(async (args: string[]) => {
        if (args[1] === 'logout') throw new Error('logout failed')
      }),
    })
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)
    await dialer.close()
    expect(daemon.kill).toHaveBeenCalled()
    expect(workDirs()).toEqual([])
    expect(logged.join('\n')).toMatch(/logout failed/)
  })

  it('★ up に失敗したら片付けて失敗（stderr の末尾を添える・authkey は残さない）', async () => {
    const d = deps({
      runCli: jest.fn(async () => {
        daemon.stderr.emit('data', Buffer.from('control: invalid key\n'))
        throw new Error('exit status 1')
      }),
    })
    await expect(openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)).rejects.toThrow(
      /Tailscale could not join the tailnet: exit status 1: control: invalid key/,
    )
    expect(daemon.kill).toHaveBeenCalled()
    expect(workDirs()).toEqual([])
  })

  it('★ tailscaled が起動しきらずに終われば失敗', async () => {
    const d = deps({
      waitForReady: jest.fn(async (_p: string, _t: number, isAlive: () => boolean) => {
        daemon.exitOnItsOwn(1)
        expect(isAlive()).toBe(false)
        throw new Error('tailscaled exited before it was ready')
      }),
    })
    await expect(openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)).rejects.toThrow(
      /Tailscale could not join the tailnet: tailscaled exited/,
    )
    expect(daemon.kill).not.toHaveBeenCalled()
    expect(workDirs()).toEqual([])
  })

  it('★ tailscaled を起動できなければ（pid なし）待たずに失敗', async () => {
    const d = deps({
      waitForReady: jest.fn(async (_p: string, _t: number, isAlive: () => boolean) => {
        daemon.pid = undefined
        daemon.emit('error', new Error('spawn tailscaled ENOENT'))
        expect(isAlive()).toBe(false)
        throw new Error('tailscaled exited before it was ready')
      }),
    })
    await expect(openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)).rejects.toThrow(
      /Tailscale could not join the tailnet: tailscaled exited/,
    )
    expect(daemon.kill).not.toHaveBeenCalled()
    expect(workDirs()).toEqual([])
  })

  it('★ tailscaled の起動（spawn）が投げても一時ディレクトリを残さない（実 tmpdir）', async () => {
    const d = deps({
      spawnDaemon: jest.fn(() => {
        throw new Error('EAGAIN')
      }),
    })
    await expect(openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d)).rejects.toThrow(/EAGAIN/)
    expect(workDirs()).toEqual([])
  })

  it('★ 起動後に tailscaled が落ちたら onClosed を通知し、close では logout しない', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, deps())
    const reasons: string[] = []
    dialer.onClosed((r) => reasons.push(r))
    daemon.exitOnItsOwn(3)
    expect(reasons).toEqual(['tailscaled exited (code=3, signal=null)'])
    await dialer.close()
    expect(cliCalls.map((a) => a[1])).toEqual(['up'])
  })

  it('★ 先に tailscaled が落ち、そのあと onClosed を登録しても通知が届く', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, deps())
    daemon.exitOnItsOwn(7)
    const reason = await new Promise<string>((resolve) => dialer.onClosed(resolve))
    expect(reason).toBe('tailscaled exited (code=7, signal=null)')
    await dialer.close()
  })

  it('子プロセスの error イベントでプロセスを落とさない', async () => {
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, deps())
    daemon.emit('error', new Error('spawn EACCES'))
    expect(logged.join('\n')).toMatch(/spawn EACCES/)
    await dialer.close()
  })

  it('stderr を上限付きで保持する', async () => {
    const d = deps({
      runCli: jest.fn(async () => {
        daemon.stderr.emit('data', 'x'.repeat(20_000))
        daemon.stderr.emit('data', 'TAIL')
        throw new Error('failed')
      }),
    })
    const error = await openTailscaleRdpDialer(tunnel(), { sessionId: 's' }, d).catch((e: Error) => e)
    expect((error as Error).message.endsWith('TAIL')).toBe(true)
    expect((error as Error).message.length).toBeLessThan(9_000)
  })
})

describe('tailscaleNodeName', () => {
  it.each([
    ['sess-1', 'ais-rdp-sess-1'],
    ['ABC_def.9', 'ais-rdp-abc-def-9'],
    ['x'.repeat(100), `ais-rdp-${'x'.repeat(40)}`],
  ])('%s → %s', (id, expected) => {
    expect(tailscaleNodeName(id)).toBe(expected)
  })
})

describe('既定の実装（実プロセス）', () => {
  // 実プロセスを起動する。高負荷のホストでも既定の 5 秒で偽の失敗にならないよう延ばす
  jest.setTimeout(30_000)

  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-ts-bin-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const script = (name: string, body: string): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  it('runTailscaleCli: 成功', async () => {
    const bin = script('tailscale', 'exit 0')
    await expect(runTailscaleCli(['status'], 5_000, bin)).resolves.toBeUndefined()
  })

  it('runTailscaleCli: 失敗は stderr を添える', async () => {
    const bin = script('tailscale', 'echo "backend error" >&2; exit 2')
    await expect(runTailscaleCli(['up'], 5_000, bin)).rejects.toThrow(/backend error/)
  })

  it('runTailscaleCli: 失敗で stderr が空なら元のエラー', async () => {
    const bin = script('tailscale', 'exit 2')
    await expect(runTailscaleCli(['up'], 5_000, bin)).rejects.toThrow(/Command failed/)
  })

  it('spawnTailscaled: 引数を渡して起動し、追跡する（親の終了で残さない）', async () => {
    const out = path.join(dir, 'args.txt')
    const bin = script('tailscaled', `echo "$@" > ${out}; sleep 1`)
    const before = trackedChildProcessCount()
    const proc = spawnTailscaled(['--a', '--b'], bin)
    expect(trackedChildProcessCount()).toBe(before + 1)
    await new Promise((resolve) => proc.once('exit', resolve))
    expect(fs.readFileSync(out, 'utf8').trim()).toBe('--a --b')
    expect(trackedChildProcessCount()).toBe(before)
  })

  it('spawnTailscaleNc: 標準入出力をパイプにして起動し、追跡する', async () => {
    const bin = script('tailscale', 'cat')
    const before = trackedChildProcessCount()
    const proc = spawnTailscaleNc(['nc', 'h', '1'], bin)
    expect(trackedChildProcessCount()).toBe(before + 1)
    const echoed = new Promise<string>((resolve) => proc.stdout?.once('data', (d: Buffer) => resolve(d.toString())))
    proc.stdin?.write('ping')
    expect(await echoed).toBe('ping')
    proc.stdin?.end()
    await new Promise((resolve) => proc.once('exit', resolve))
  })

  it('spawnTailscaled / runTailscaleCli / spawnTailscaleNc は現在の process.env を渡す（PATH で探す）', async () => {
    const out = path.join(dir, 'env.txt')
    script('tailscaled', `echo "$AIS_TS_PROBE" > ${out}`)
    script('tailscale', `test "$AIS_TS_PROBE" = yes`)
    const saved = { ...process.env }
    process.env.PATH = `${dir}${path.delimiter}${saved.PATH ?? ''}`
    process.env.AIS_TS_PROBE = 'yes'
    try {
      const proc = spawnTailscaled([])
      await new Promise((resolve) => proc.once('exit', resolve))
      expect(fs.readFileSync(out, 'utf8').trim()).toBe('yes')
      await expect(runTailscaleCli([], 5_000)).resolves.toBeUndefined()
      const nc = spawnTailscaleNc([])
      const code = await new Promise((resolve) => nc.once('exit', resolve))
      expect(code).toBe(0)
    } finally {
      process.env = saved
    }
  })

  it('waitForSocketFile: unix socket が現れたら解決', async () => {
    const socketPath = path.join(dir, 'd.sock')
    const server = net.createServer()
    setTimeout(() => server.listen(socketPath), 50)
    await expect(waitForSocketFile(socketPath, 5_000, () => true)).resolves.toBeUndefined()
    server.close()
  })

  it('waitForSocketFile: 通常のファイルでは解決しない（期限切れ）', async () => {
    const file = path.join(dir, 'not-a-socket')
    fs.writeFileSync(file, '')
    await expect(waitForSocketFile(file, 50, () => true)).rejects.toThrow(/Timed out waiting for tailscaled/)
  })

  it('waitForSocketFile: プロセスが終われば失敗', async () => {
    await expect(waitForSocketFile(path.join(dir, 'none'), 5_000, () => false)).rejects.toThrow(
      /tailscaled exited before it was ready/,
    )
  })
})

describe('既定の依存で通しで動く（偽の tailscaled / tailscale を PATH に置く）', () => {
  // 実プロセスを起動する。高負荷のホストでも既定の 5 秒で偽の失敗にならないよう延ばす
  jest.setTimeout(30_000)

  let dir: string
  const savedPath = process.env.PATH

  beforeEach(() => {
    logged.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-ts-e2e-'))
    // 偽 tailscaled: --socket の unix socket で待ち受けるだけ（TCP は開かない）
    fs.writeFileSync(
      path.join(dir, 'tailscaled'),
      `#!/usr/bin/env node
const net = require('net')
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(path.join(dir, 'daemon-args'))}, process.argv.slice(2).join('\\n'))
const sock = process.argv.find((a) => a.startsWith('--socket=')).slice('--socket='.length)
net.createServer(() => undefined).listen(sock)
process.on('SIGTERM', () => process.exit(0))
`,
      { mode: 0o755 },
    )
    // 偽 tailscale: up/logout は記録するだけ、nc は標準入出力をエコーする
    fs.writeFileSync(
      path.join(dir, 'tailscale'),
      `#!/bin/sh
echo "$@" >> ${path.join(dir, 'cli-args')}
for a in "$@"; do
  case "$a" in --auth-key=file:*) cat "\${a#--auth-key=file:}" > ${path.join(dir, 'key-seen')};; esac
done
if [ "$2" = "nc" ]; then exec cat; fi
exit 0
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`
  })

  afterEach(() => {
    process.env.PATH = savedPath
    fs.rmSync(dir, { recursive: true, force: true })
    for (const line of logged) expect(line).not.toContain(TS_KEY)
  })

  it('★ 参加 → nc で dial → logout・停止まで（TCP の待ち受けなし）', async () => {
    const before = trackedChildProcessCount()
    const dialer = await openTailscaleRdpDialer(tunnel(), { sessionId: 'sess-e2e' })
    const socket = await dialer.dial()
    socket.write('rdp')
    const echoed = await new Promise<string>((resolve) =>
      socket.once('data', (d: Buffer) => resolve(d.toString())),
    )
    expect(echoed).toBe('rdp')
    await dialer.close()
    expect(trackedChildProcessCount()).toBe(before)

    const cli = fs.readFileSync(path.join(dir, 'cli-args'), 'utf8')
    expect(cli).toMatch(/ up --auth-key=file:\S+ --hostname=ais-rdp-sess-e2e --timeout=30s/)
    expect(cli).toMatch(/ nc win\.tail1234\.ts\.net 3389/)
    expect(cli).toMatch(/ logout/)
    expect(cli).not.toContain(TS_KEY)
    expect(fs.readFileSync(path.join(dir, 'key-seen'), 'utf8')).toBe(TS_KEY)
    const daemonArgs = fs.readFileSync(path.join(dir, 'daemon-args'), 'utf8')
    expect(daemonArgs).not.toContain(TS_KEY)
    expect(daemonArgs).not.toMatch(/socks5/)
  })
})
