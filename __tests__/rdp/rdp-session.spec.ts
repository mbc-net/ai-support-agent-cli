import { GuacdSocket, GuacdHandshakeParams } from '../../src/rdp/guacd-handshake'
import { encodeGuacamoleInstruction } from '../../src/rdp/guacamole-protocol'
import { RdpSession } from '../../src/rdp/rdp-session'

/**
 * RDP relay session: browser <-> API <-> agent <-> guacd.
 *
 * The agent owns the guacd connection. It must not forward anything to the
 * client before the handshake completes (the client's renderer would see a
 * stream with no `ready` and stall), and it must tear the guacd socket down on
 * every exit path — a leaked socket keeps an RDP login session alive on the
 * remote host after the browser is gone.
 */

class FakeSocket implements GuacdSocket {
  written: string[] = []
  destroyed = false
  private dataHandler: ((chunk: string) => void) | null = null
  private closeHandler: (() => void) | null = null
  private errorHandler: ((error: Error) => void) | null = null

  write(data: string): void {
    this.written.push(data)
  }
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }
  destroy(): void {
    this.destroyed = true
  }

  emit(opcode: string, args: string[]): void {
    this.dataHandler?.(encodeGuacamoleInstruction(opcode, args))
  }
  emitRaw(chunk: string): void {
    this.dataHandler?.(chunk)
  }
  close(): void {
    this.closeHandler?.()
  }
  fail(error: Error): void {
    this.errorHandler?.(error)
  }
}

const PASSWORD = 'sup3r-s3cret'

const params: GuacdHandshakeParams = {
  protocol: 'rdp',
  parameters: { hostname: '10.0.0.5', port: '3389', password: PASSWORD },
  optimalWidth: 1024,
  optimalHeight: 768,
  optimalDpi: 96,
}

/** Build a session wired to a fake socket, capturing what it emits. */
function build(): {
  session: RdpSession
  socket: FakeSocket
  outbound: string[]
  closed: { reason: string }[]
  errors: Error[]
} {
  const socket = new FakeSocket()
  const outbound: string[] = []
  const closed: { reason: string }[] = []
  const errors: Error[] = []
  const session = new RdpSession({
    connect: async () => socket,
    params,
    onOutbound: (data) => outbound.push(data),
    onClosed: (reason) => closed.push({ reason }),
    onError: (error) => errors.push(error),
  })
  return { session, socket, outbound, closed, errors }
}

/** Start a session and complete the handshake. */
async function started(): Promise<ReturnType<typeof build>> {
  const ctx = build()
  const promise = ctx.session.start()
  // start() awaits connect(); let the microtask queue drain first.
  await Promise.resolve()
  ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname', 'port', 'password'])
  ctx.socket.emit('ready', ['$conn-1'])
  await promise
  return ctx
}

describe('RdpSession', () => {
  describe('start', () => {
    it('completes the handshake and reports the connection id', async () => {
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      ctx.socket.emit('ready', ['$conn-1'])
      await expect(promise).resolves.toEqual({ connectionId: '$conn-1' })
    })

    it('★ forwards nothing to the client before ready', async () => {
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      expect(ctx.outbound).toEqual([])
      ctx.socket.emit('ready', ['$conn-1'])
      await promise
    })

    it('★ destroys the socket when the handshake fails', async () => {
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('error', ['refused', '519'])
      await expect(promise).rejects.toThrow()
      expect(ctx.socket.destroyed).toBe(true)
    })

    it('★ never puts the password in a rejection', async () => {
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('error', ['auth failed', '771'])
      await expect(promise).rejects.not.toThrow(PASSWORD)
    })
  })

  describe('relay', () => {
    it('forwards guacd instructions to the client after ready', async () => {
      const ctx = await started()
      ctx.socket.emit('sync', ['123'])
      expect(ctx.outbound).toEqual(['4.sync,3.123;'])
    })

    it('★ delivers instructions pipelined behind ready', async () => {
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      ctx.socket.emitRaw(
        encodeGuacamoleInstruction('ready', ['$c']) +
          encodeGuacamoleInstruction('sync', ['1']),
      )
      await promise
      expect(ctx.outbound).toEqual(['4.sync,1.1;'])
    })

    it('reassembles instructions split across chunks', async () => {
      const ctx = await started()
      ctx.socket.emitRaw('4.syn')
      expect(ctx.outbound).toEqual([])
      ctx.socket.emitRaw('c,3.123;')
      expect(ctx.outbound).toEqual(['4.sync,3.123;'])
    })

    it('forwards client input to guacd verbatim', async () => {
      const ctx = await started()
      const before = ctx.socket.written.length
      ctx.session.send('3.key,1.a,1.1;')
      expect(ctx.socket.written.slice(before)).toEqual(['3.key,1.a,1.1;'])
    })

    it('★ drops client input sent before the session is ready', async () => {
      const ctx = build()
      ctx.session.send('3.key,1.a,1.1;')
      expect(ctx.socket.written).toEqual([])
    })

    it('★ drops client input after close (no writes to a dead socket)', async () => {
      const ctx = await started()
      ctx.session.close('client went away')
      const before = ctx.socket.written.length
      ctx.session.send('3.key,1.a,1.1;')
      expect(ctx.socket.written).toHaveLength(before)
    })
  })

  describe('teardown', () => {
    it('reports guacd closing the connection', async () => {
      const ctx = await started()
      ctx.socket.close()
      expect(ctx.closed).toHaveLength(1)
      expect(ctx.socket.destroyed).toBe(true)
    })

    it('close() destroys the socket and reports the reason once', async () => {
      const ctx = await started()
      ctx.session.close('client went away')
      ctx.session.close('again')
      expect(ctx.socket.destroyed).toBe(true)
      expect(ctx.closed).toEqual([{ reason: 'client went away' }])
    })

    it('stops relaying after close', async () => {
      const ctx = await started()
      ctx.session.close('done')
      ctx.socket.emit('sync', ['9'])
      expect(ctx.outbound).toEqual([])
    })

    it('★ tears down on a malformed guacd stream instead of relaying garbage', async () => {
      const ctx = await started()
      ctx.socket.emitRaw('3nope;')
      expect(ctx.errors).toHaveLength(1)
      expect(ctx.socket.destroyed).toBe(true)
      expect(ctx.closed).toHaveLength(1)
    })

    it('reports a socket error and tears down', async () => {
      const ctx = await started()
      ctx.socket.fail(new Error('ECONNRESET'))
      expect(ctx.errors).toHaveLength(1)
      expect(ctx.socket.destroyed).toBe(true)
    })

    it('★ close() during the handshake wins: the socket is destroyed, not relayed', async () => {
      // The owner (client disconnect, API teardown) decided the session is over
      // while guacd was still negotiating. Resuming the relay here would leave an
      // RDP logon running on the remote host with nobody watching it.
      const ctx = build()
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.session.close('client disconnected mid-handshake')
      ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      ctx.socket.emit('ready', ['$conn-1'])
      await promise

      expect(ctx.socket.destroyed).toBe(true)
      expect(ctx.session.isReady).toBe(false)
      ctx.socket.emit('sync', ['1'])
      expect(ctx.outbound).toEqual([])
      expect(ctx.closed).toEqual([{ reason: 'client disconnected mid-handshake' }])
    })

    it('is safe to close a session that never started', () => {
      const ctx = build()
      expect(() => ctx.session.close('never started')).not.toThrow()
    })
  })

  describe('state', () => {
    it('reports readiness', async () => {
      const ctx = build()
      expect(ctx.session.isReady).toBe(false)
      const promise = ctx.session.start()
      await Promise.resolve()
      ctx.socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      ctx.socket.emit('ready', ['$c'])
      await promise
      expect(ctx.session.isReady).toBe(true)
      ctx.session.close('done')
      expect(ctx.session.isReady).toBe(false)
    })
  })
})
