import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { openStdioStream } from '../../src/utils/stdio-stream'

/**
 * 子プロセスの stdin/stdout を 1 本のストリームにする（`tailscale nc`、
 * SSM の AWS-StartSSHSession）。どの経路で終わっても子プロセスを残さない。
 */

class FakeChild extends EventEmitter {
  pid: number | undefined = 1
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

describe('openStdioStream', () => {
  it('★ spawn したらストリームを返し、双方向につなぐ', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 10 })
    child.emit('spawn')
    const stream = await opening
    const toChild = new Promise<string>((r) => child.stdin.once('data', (d) => r(d.toString())))
    stream.write('in')
    expect(await toChild).toBe('in')
    const fromChild = new Promise<string>((r) => stream.once('data', (d: Buffer) => r(d.toString())))
    child.stdout.write('out')
    expect(await fromChild).toBe('out')
    stream.destroy()
  })

  it('★ ストリームを閉じたら子を kill する', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 10 })
    child.emit('spawn')
    const stream = await opening
    stream.destroy()
    await new Promise((r) => setImmediate(r))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('★ 子が終わったら、stdout を読み切ってからストリームを閉じる（末尾のデータを落とさない）', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 10 })
    child.emit('spawn')
    const stream = await opening
    const received: string[] = []
    stream.on('data', (d: Buffer) => received.push(d.toString()))
    const closed = new Promise<void>((r) => stream.once('close', () => r()))
    child.exitCode = 1
    child.stderr.write('TargetNotConnected')
    child.emit('exit', 1, null)
    // exit の後にも stdout の残りが届く
    child.stdout.write('tail')
    child.stdout.end()
    await closed
    expect(received.join('')).toBe('tail')
  })

  it('★ 最初のデータが届いたら待たずに成功し、そのデータも落とさない', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 60_000 })
    child.emit('spawn')
    child.stdout.write('first')
    const stream = await opening
    const data = await new Promise<string>((r) => stream.once('data', (d: Buffer) => r(d.toString())))
    expect(data).toBe('first')
    stream.destroy()
  })

  it('★ spawn しただけでは成功にしない: 一定時間生きていれば成功', async () => {
    const child = new FakeChild()
    let resolved = false
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 5_000, settleMs: 50 }).then((s) => {
      resolved = true
      return s
    })
    child.emit('spawn')
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
    const stream = await opening
    expect(resolved).toBe(true)
    stream.destroy()
  })

  it('★ 生存確認の前に終わったら失敗（stderr の末尾を添える）', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 5_000, settleMs: 1_000 })
    child.emit('spawn')
    child.stderr.write('An error occurred (TargetNotConnected)')
    await new Promise((r) => setImmediate(r))
    child.exitCode = 254
    child.emit('exit', 254, null)
    await expect(opening).rejects.toThrow(/x exited before it was ready \(code=254\): An error occurred \(TargetNotConnected\)/)
  })

  it('stdout の変換を挟める', async () => {
    const { Transform } = await import('stream')
    const child = new FakeChild()
    const upper = () =>
      new Transform({
        transform(chunk: Buffer, _e, cb) {
          cb(null, Buffer.from(chunk.toString().toUpperCase()))
        },
      })
    const opening = openStdioStream(child as never, {
      label: 'x',
      timeoutMs: 1_000,
      settleMs: 10,
      transformStdout: upper,
    })
    child.emit('spawn')
    const stream = await opening
    const data = new Promise<string>((r) => stream.once('data', (d: Buffer) => r(d.toString())))
    child.stdout.write('abc')
    expect(await data).toBe('ABC')
    stream.destroy()
  })

  it('stdout の変換がエラーを出したらストリームを閉じる', async () => {
    const { Transform } = await import('stream')
    const child = new FakeChild()
    const failing = () =>
      new Transform({
        transform(_c: Buffer, _e, cb) {
          cb(new Error('bad banner'))
        },
      })
    const opening = openStdioStream(child as never, {
      label: 'x',
      timeoutMs: 1_000,
      settleMs: 10,
      transformStdout: failing,
    })
    child.emit('spawn')
    const stream = await opening
    const closed = new Promise<void>((r) => stream.once('close', () => r()))
    stream.on('error', () => undefined)
    child.stdout.write('abc')
    await closed
    await new Promise((r) => setImmediate(r))
    expect(child.kill).toHaveBeenCalled()
  })

  it('★ 起動に失敗したら拒否', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 10 })
    child.emit('error', new Error('spawn aws ENOENT'))
    await expect(opening).rejects.toThrow(/x could not be started: spawn aws ENOENT/)
  })

  it('★ 期限内に起動しなければ kill して拒否', async () => {
    const child = new FakeChild()
    await expect(openStdioStream(child as never, { label: 'x', timeoutMs: 10, settleMs: 5_000 })).rejects.toThrow(
      /x did not start within 10ms/,
    )
    expect(child.kill).toHaveBeenCalled()
  })

  it('起動後の error ではプロセスを落とさない', async () => {
    const child = new FakeChild()
    const opening = openStdioStream(child as never, { label: 'x', timeoutMs: 1_000, settleMs: 10 })
    child.emit('spawn')
    await opening
    expect(() => child.emit('error', new Error('late'))).not.toThrow()
  })

  it('実プロセス（cat）でも往復する', async () => {
    const stream = await openStdioStream(spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'] }), {
      label: 'cat',
      timeoutMs: 5_000,
      settleMs: 50,
    })
    const echoed = new Promise<string>((r) => stream.once('data', (d: Buffer) => r(d.toString())))
    stream.write('ping')
    expect(await echoed).toBe('ping')
    stream.destroy()
  })
})
