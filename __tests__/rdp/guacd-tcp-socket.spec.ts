import { EventEmitter } from 'events'

import { createGuacdTcpSocket } from '../../src/rdp/guacd-tcp-socket'

/**
 * TCP adapter between Node's net.Socket and the {@link GuacdSocket} contract.
 *
 * guacd speaks UTF-8 text. Reading it as anything else corrupts multi-byte
 * characters, and — because the Guacamole framing counts characters — a single
 * corrupted character desynchronises the whole stream.
 */

/** Stand-in for net.Socket with just what the adapter touches. */
class FakeNetSocket extends EventEmitter {
  written: string[] = []
  destroyed = false
  encoding: string | null = null
  setEncoding(encoding: string): this {
    this.encoding = encoding
    return this
  }
  write(data: string): boolean {
    this.written.push(data)
    return true
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
}

function build(): { net: FakeNetSocket; socket: ReturnType<typeof createGuacdTcpSocket> } {
  const fake = new FakeNetSocket()
  return {
    net: fake,
    socket: createGuacdTcpSocket(fake as never),
  }
}

describe('createGuacdTcpSocket', () => {
  it('★ reads the stream as UTF-8', () => {
    const { net } = build()
    expect(net.encoding).toBe('utf8')
  })

  it('forwards writes to the socket', () => {
    const { net, socket } = build()
    socket.write('3.nop;')
    expect(net.written).toEqual(['3.nop;'])
  })

  it('delivers data to the registered handler', () => {
    const { net, socket } = build()
    const chunks: string[] = []
    socket.onData((chunk) => chunks.push(chunk))
    net.emit('data', '3.nop;')
    expect(chunks).toEqual(['3.nop;'])
  })

  it('★ replaces the handler rather than accumulating subscriptions', () => {
    // The handshake installs a handler and the relay takes over. If both stayed
    // registered, every instruction would be processed twice.
    const { net, socket } = build()
    const first: string[] = []
    const second: string[] = []
    socket.onData((chunk) => first.push(chunk))
    socket.onData((chunk) => second.push(chunk))
    net.emit('data', '3.nop;')
    expect(first).toEqual([])
    expect(second).toEqual(['3.nop;'])
  })

  it('converts Buffer chunks to UTF-8 text', () => {
    const { net, socket } = build()
    const chunks: string[] = []
    socket.onData((chunk) => chunks.push(chunk))
    net.emit('data', Buffer.from('9.clipboard;', 'utf8'))
    expect(chunks).toEqual(['9.clipboard;'])
  })

  it('reports close', () => {
    const { net, socket } = build()
    let closed = 0
    socket.onClose(() => {
      closed++
    })
    net.emit('close')
    expect(closed).toBe(1)
  })

  it('reports errors', () => {
    const { net, socket } = build()
    const errors: Error[] = []
    socket.onError((error) => errors.push(error))
    net.emit('error', new Error('ECONNRESET'))
    expect(errors.map((e) => e.message)).toEqual(['ECONNRESET'])
  })

  it('★ swallows errors that arrive with no handler registered', () => {
    // An unhandled "error" event on an EventEmitter crashes the process. The
    // adapter must always keep a listener attached.
    const { net } = build()
    expect(() => net.emit('error', new Error('early failure'))).not.toThrow()
  })

  it('destroys the underlying socket', () => {
    const { net, socket } = build()
    socket.destroy()
    expect(net.destroyed).toBe(true)
  })

  it('★ destroys only once even when called repeatedly', () => {
    // RdpSession.finish() and the handshake's own failure path can both destroy
    // the same socket; the second call must be a no-op.
    const { net, socket } = build()
    let destroyCalls = 0
    const original = net.destroy.bind(net)
    net.destroy = ((): FakeNetSocket => {
      destroyCalls++
      return original()
    }) as typeof net.destroy
    socket.destroy()
    socket.destroy()
    expect(destroyCalls).toBe(1)
  })

  it('does not write after destroy', () => {
    const { net, socket } = build()
    socket.destroy()
    socket.write('3.nop;')
    expect(net.written).toEqual([])
  })
})
