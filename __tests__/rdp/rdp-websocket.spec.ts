import { RdpSessionRegistry } from '../../src/rdp/rdp-session-registry'
import { encodeGuacamoleInstruction } from '../../src/rdp/guacamole-protocol'
import type { GuacdSocket } from '../../src/rdp/guacd-handshake'

/**
 * The registry that turns API messages into guacd sessions.
 *
 * This is the transport-independent half of the agent's RDP relay: the
 * WebSocket class owns reconnection and framing, while everything that decides
 * *what happens* to a session lives here so it can be tested without a socket.
 *
 * Two properties matter most:
 *
 * - **Every message names a session.** Acting on the wrong one would stream one
 *   customer's desktop to another's browser.
 * - **Closing is idempotent and always destroys the guacd socket.** A leaked
 *   socket keeps an RDP logon alive on the remote host after the browser is gone.
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
  close(): void {
    this.closeHandler?.()
  }
  fail(error: Error): void {
    this.errorHandler?.(error)
  }
}

const PASSWORD = 'sup3r-s3cret'

/** Base64 of a Guacamole instruction, as it travels over the API socket. */
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('RdpSessionRegistry', () => {
  let registry: RdpSessionRegistry
  let sockets: FakeSocket[]
  let outbound: Record<string, unknown>[]

  beforeEach(() => {
    sockets = []
    outbound = []
    registry = new RdpSessionRegistry({
      connect: async () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      send: (msg) => outbound.push(msg),
    })
  })

  /** Drive an open through to `ready`. */
  const open = async (sessionId = 'sess-1'): Promise<FakeSocket> => {
    const promise = registry.open({
      sessionId,
      parameters: { hostname: '10.0.0.5', port: '3389', password: PASSWORD },
      width: 1280,
      height: 800,
      dpi: 96,
    })
    await Promise.resolve()
    const socket = sockets[sockets.length - 1]
    socket.emit('args', ['VERSION_1_5_0', 'hostname', 'port', 'password'])
    socket.emit('ready', [`$${sessionId}`])
    await promise
    return socket
  }

  describe('open', () => {
    it('reports readiness with the guacd connection id', async () => {
      await open()
      expect(outbound).toEqual([
        { type: 'rdp_ready', sessionId: 'sess-1', connectionId: '$sess-1' },
      ])
    })

    it('passes the parameters through to the handshake', async () => {
      const socket = await open()
      const connect = socket.written.find((w) => w.includes('7.connect'))
      expect(connect).toContain('10.0.0.5')
    })

    it('★ reports a failure instead of leaving the browser waiting', async () => {
      const promise = registry.open({
        sessionId: 'sess-1',
        parameters: { hostname: '10.0.0.5' },
        width: 1280,
        height: 800,
        dpi: 96,
      })
      await Promise.resolve()
      sockets[0].emit('error', ['refused', '519'])
      await promise

      expect(outbound).toEqual([
        expect.objectContaining({ type: 'rdp_closed', sessionId: 'sess-1' }),
      ])
    })

    it('★ never puts a parameter value in the failure report', async () => {
      const promise = registry.open({
        sessionId: 'sess-1',
        parameters: { hostname: '10.0.0.5', password: PASSWORD },
        width: 1280,
        height: 800,
        dpi: 96,
      })
      await Promise.resolve()
      sockets[0].emit('error', ['auth failed', '771'])
      await promise
      expect(JSON.stringify(outbound)).not.toContain(PASSWORD)
    })

    it('★ does not report ready for a session closed during the handshake', async () => {
      // RdpSession.start() still resolves when close() lands mid-handshake (the
      // socket is destroyed and the id released). Reporting ready afterwards
      // would arrive AFTER rdp_closed and leave the browser believing it is
      // connected to a session that no longer exists.
      const promise = registry.open({
        sessionId: 'sess-1',
        parameters: { hostname: '10.0.0.5' },
        width: 1280,
        height: 800,
        dpi: 96,
      })
      await Promise.resolve()
      registry.close('sess-1', 'client went away')
      sockets[0].emit('args', ['VERSION_1_5_0', 'hostname'])
      sockets[0].emit('ready', ['$c'])
      await promise

      expect(outbound.map((m) => m.type)).toEqual(['rdp_closed'])
      expect(registry.size).toBe(0)
    })

    it('★ rejects a duplicate sessionId rather than orphaning the first socket', async () => {
      const first = await open('sess-1')
      outbound.length = 0

      const promise = registry.open({
        sessionId: 'sess-1',
        parameters: { hostname: '10.0.0.9' },
        width: 800,
        height: 600,
        dpi: 96,
      })
      await promise

      expect(first.destroyed).toBe(false)
      expect(sockets).toHaveLength(1)
      expect(outbound[0]).toMatchObject({ type: 'error', sessionId: 'sess-1' })
    })
  })

  describe('relay', () => {
    it('forwards guacd output to the API as base64', async () => {
      const socket = await open()
      outbound.length = 0
      socket.emit('sync', ['1'])
      expect(outbound).toEqual([
        { type: 'rdp_data', sessionId: 'sess-1', data: b64('4.sync,1.1;') },
      ])
    })

    it('forwards client input to guacd', async () => {
      const socket = await open()
      const before = socket.written.length
      registry.send('sess-1', b64('3.key,1.a;'))
      expect(socket.written.slice(before)).toEqual(['3.key,1.a;'])
    })

    it('★ ignores input for an unknown session', () => {
      expect(() => registry.send('missing', b64('3.nop;'))).not.toThrow()
    })

    it('★ discards malformed base64 rather than writing garbage to guacd, and says so', async () => {
      const socket = await open()
      const before = socket.written.length
      outbound.length = 0

      registry.send('sess-1', '!!!not base64!!!')

      expect(socket.written).toHaveLength(before)
      // Dropping input silently presents as "the keyboard stopped working"
      // with nothing to diagnose from.
      expect(outbound).toEqual([
        expect.objectContaining({ type: 'error', sessionId: 'sess-1' }),
      ])
    })

    it('sends a resize instruction', async () => {
      const socket = await open()
      const before = socket.written.length
      registry.resize('sess-1', 1920, 1080)
      expect(socket.written.slice(before)).toEqual(['4.size,4.1920,4.1080;'])
    })

    it('ignores a resize for an unknown session', () => {
      expect(() => registry.resize('missing', 800, 600)).not.toThrow()
    })
  })

  describe('close', () => {
    it('destroys the guacd socket and reports closure', async () => {
      const socket = await open()
      outbound.length = 0
      registry.close('sess-1', 'client asked')

      expect(socket.destroyed).toBe(true)
      expect(outbound).toEqual([
        { type: 'rdp_closed', sessionId: 'sess-1', reason: 'client asked' },
      ])
    })

    it('★ is idempotent', async () => {
      await open()
      outbound.length = 0
      registry.close('sess-1', 'first')
      registry.close('sess-1', 'second')
      expect(outbound).toHaveLength(1)
    })

    it('reports closure when guacd drops the connection', async () => {
      const socket = await open()
      outbound.length = 0
      socket.close()
      expect(outbound[0]).toMatchObject({
        type: 'rdp_closed',
        sessionId: 'sess-1',
      })
    })

    it('★ closeAll tears down every session (agent shutdown / API disconnect)', async () => {
      const a = await open('sess-1')
      const b = await open('sess-2')
      outbound.length = 0

      registry.closeAll('agent shutting down')

      expect(a.destroyed).toBe(true)
      expect(b.destroyed).toBe(true)
      expect(outbound).toHaveLength(2)
      expect(registry.size).toBe(0)
    })

    it('drops the session from the registry so the id can be reused', async () => {
      await open('sess-1')
      registry.close('sess-1', 'done')
      expect(registry.size).toBe(0)
      await expect(open('sess-1')).resolves.toBeDefined()
    })
  })
})
