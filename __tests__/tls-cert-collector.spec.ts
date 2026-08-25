import { EventEmitter } from 'node:events'

import {
  collectTlsCertificates,
  inspectTlsCertificate,
  type TlsConnectFn,
} from '../src/tls-cert/tls-cert-collector'

/**
 * Minimal stand-in for a `tls.TLSSocket`. Only the surface the collector uses
 * is implemented: the events it listens for plus `getPeerCertificate`,
 * `setTimeout` and `destroy`.
 */
class FakeSocket extends EventEmitter {
  destroyed = false
  timeoutMs: number | undefined
  peerCertificate: Record<string, unknown> = {}

  setTimeout(ms: number): this {
    this.timeoutMs = ms
    return this
  }

  getPeerCertificate(): Record<string, unknown> {
    return this.peerCertificate
  }

  destroy(): void {
    this.destroyed = true
  }
}

const VALID_CERT = {
  valid_from: 'Jun 26 00:00:00 2026 GMT',
  valid_to: 'Sep 24 23:59:59 2026 GMT',
  issuer: { O: "Let's Encrypt", CN: 'R3' },
  subject: { CN: 'example.com' },
}

/** Builds a connect fn that hands back `socket` and runs `drive` on next tick. */
function connectWith(
  socket: FakeSocket,
  drive: (socket: FakeSocket) => void,
): { fn: TlsConnectFn; calls: unknown[] } {
  const calls: unknown[] = []
  const fn = ((options: unknown) => {
    calls.push(options)
    setImmediate(() => drive(socket))
    return socket as never
  }) as TlsConnectFn
  return { fn, calls }
}

describe('inspectTlsCertificate', () => {
  it('reports the certificate validity window on a successful handshake', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = VALID_CERT
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'example.com', port: 443 },
      { connect: fn },
    )

    expect(result).toEqual({
      domain: 'example.com',
      port: 443,
      reachable: true,
      notBefore: new Date('Jun 26 00:00:00 2026 GMT').toISOString(),
      notAfter: new Date('Sep 24 23:59:59 2026 GMT').toISOString(),
      issuer: "Let's Encrypt",
      subject: 'example.com',
    })
  })

  it('passes SNI and disables verification so an expired or internal-CA cert is still readable', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = VALID_CERT
    const { fn, calls } = connectWith(socket, (s) => s.emit('secureConnect'))

    await inspectTlsCertificate(
      { domain: 'internal.example.com', port: 8443 },
      { connect: fn },
    )

    expect(calls[0]).toMatchObject({
      host: 'internal.example.com',
      port: 8443,
      servername: 'internal.example.com',
      // The whole point is to *read* the certificate, not to trust it. Verifying
      // would abort the handshake exactly for the certs we most need to report
      // on (expired, self-signed, internal CA).
      rejectUnauthorized: false,
    })
  })

  it('closes the socket after reading the certificate', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = VALID_CERT
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    await inspectTlsCertificate({ domain: 'example.com', port: 443 }, { connect: fn })

    expect(socket.destroyed).toBe(true)
  })

  it('reports an unreachable target when the connection errors', async () => {
    const socket = new FakeSocket()
    const { fn } = connectWith(socket, (s) =>
      s.emit('error', new Error('ECONNREFUSED')),
    )

    const result = await inspectTlsCertificate(
      { domain: 'down.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
    expect(result.notAfter).toBeUndefined()
    expect(socket.destroyed).toBe(true)
  })

  it('reports an unreachable target on timeout', async () => {
    const socket = new FakeSocket()
    const { fn } = connectWith(socket, (s) => s.emit('timeout'))

    const result = await inspectTlsCertificate(
      { domain: 'slow.example.com', port: 443 },
      { connect: fn, timeoutMs: 1234 },
    )

    expect(result.reachable).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    expect(socket.timeoutMs).toBe(1234)
  })

  it('treats a connection closed before the handshake as unreachable', async () => {
    const socket = new FakeSocket()
    const { fn } = connectWith(socket, (s) => s.emit('close'))

    const result = await inspectTlsCertificate(
      { domain: 'reset.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('reports reachable-without-expiry when the peer sends no certificate', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = {}
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'nocert.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(true)
    expect(result.notAfter).toBeUndefined()
    expect(result.error).toBeDefined()
  })

  it('reports reachable-without-expiry when valid_to cannot be parsed', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = { ...VALID_CERT, valid_to: 'not a date' }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'weird.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(true)
    expect(result.notAfter).toBeUndefined()
    expect(result.error).toBeDefined()
  })

  it('reports an unreachable target when connect() itself throws', async () => {
    const fn = (() => {
      throw new Error('EAI_AGAIN')
    }) as TlsConnectFn

    const result = await inspectTlsCertificate(
      { domain: 'dns-fail.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(false)
    expect(result.error).toContain('EAI_AGAIN')
  })

  it('ignores events that arrive after the first outcome', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = VALID_CERT
    const { fn } = connectWith(socket, (s) => {
      s.emit('secureConnect')
      s.emit('error', new Error('late error'))
      s.emit('close')
    })

    const result = await inspectTlsCertificate(
      { domain: 'example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('omits issuer and subject when the certificate carries neither', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = { valid_to: 'Sep 24 23:59:59 2026 GMT' }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'bare.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.reachable).toBe(true)
    expect(result.notAfter).toBeDefined()
    expect(result.notBefore).toBeUndefined()
    expect(result.issuer).toBeUndefined()
    expect(result.subject).toBeUndefined()
  })

  it('falls back to CN for the issuer and to O for the subject', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = {
      valid_to: 'Sep 24 23:59:59 2026 GMT',
      issuer: { CN: 'Internal CA' },
      subject: { O: 'Example Inc' },
    }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'internal.example.com', port: 443 },
      { connect: fn },
    )

    expect(result.issuer).toBe('Internal CA')
    expect(result.subject).toBe('Example Inc')
  })

  it('ignores empty DN parts rather than reporting a blank name', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = {
      valid_to: 'Sep 24 23:59:59 2026 GMT',
      issuer: { O: '', CN: 'Fallback CA' },
      subject: { CN: '', O: '' },
    }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'example.com', port: 443 },
      { connect: fn },
    )

    expect(result.issuer).toBe('Fallback CA')
    expect(result.subject).toBeUndefined()
  })

  it('keeps working when destroying the socket throws', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = VALID_CERT
    socket.destroy = () => {
      throw new Error('already destroyed')
    }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'example.com', port: 443 },
      { connect: fn },
    )

    // Teardown noise must not mask an observation we already made.
    expect(result.reachable).toBe(true)
    expect(result.notAfter).toBeDefined()
  })

  it('falls back to the raw issuer value when it is not an object', async () => {
    const socket = new FakeSocket()
    socket.peerCertificate = { ...VALID_CERT, issuer: 'plain issuer', subject: 42 }
    const { fn } = connectWith(socket, (s) => s.emit('secureConnect'))

    const result = await inspectTlsCertificate(
      { domain: 'example.com', port: 443 },
      { connect: fn },
    )

    expect(result.issuer).toBe('plain issuer')
    expect(result.subject).toBeUndefined()
  })
})

describe('collectTlsCertificates', () => {
  function alwaysOk(): TlsConnectFn {
    return ((_options: unknown) => {
      const socket = new FakeSocket()
      socket.peerCertificate = VALID_CERT
      setImmediate(() => socket.emit('secureConnect'))
      return socket as never
    }) as TlsConnectFn
  }

  it('returns one observation per target, in the order given', async () => {
    const results = await collectTlsCertificates(
      [
        { domain: 'a.example.com', port: 443 },
        { domain: 'b.example.com', port: 8443 },
        { domain: 'c.example.com', port: 443 },
      ],
      { connect: alwaysOk() },
    )

    expect(results.map((r) => r.domain)).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ])
    expect(results.every((r) => r.reachable)).toBe(true)
  })

  it('returns an empty list for no targets without opening a connection', async () => {
    const connect = jest.fn() as unknown as TlsConnectFn

    expect(await collectTlsCertificates([], { connect })).toEqual([])
    expect(connect).not.toHaveBeenCalled()
  })

  it('keeps going when one target fails', async () => {
    const connect = ((options: { host: string }) => {
      const socket = new FakeSocket()
      socket.peerCertificate = VALID_CERT
      setImmediate(() => {
        if (options.host === 'bad.example.com') {
          socket.emit('error', new Error('ECONNREFUSED'))
        } else {
          socket.emit('secureConnect')
        }
      })
      return socket as never
    }) as TlsConnectFn

    const results = await collectTlsCertificates(
      [
        { domain: 'bad.example.com', port: 443 },
        { domain: 'good.example.com', port: 443 },
      ],
      { connect },
    )

    expect(results[0].reachable).toBe(false)
    expect(results[1].reachable).toBe(true)
  })

  it('limits how many connections are open at once', async () => {
    let open = 0
    let maxOpen = 0
    const connect = (() => {
      const socket = new FakeSocket()
      socket.peerCertificate = VALID_CERT
      open += 1
      maxOpen = Math.max(maxOpen, open)
      setImmediate(() => {
        open -= 1
        socket.emit('secureConnect')
      })
      return socket as never
    }) as TlsConnectFn

    const targets = Array.from({ length: 20 }, (_, i) => ({
      domain: `h${i}.example.com`,
      port: 443,
    }))
    await collectTlsCertificates(targets, { connect, concurrency: 3 })

    expect(maxOpen).toBeLessThanOrEqual(3)
  })

  it('does not start more workers than there are targets', async () => {
    let started = 0
    const connect = (() => {
      const socket = new FakeSocket()
      socket.peerCertificate = VALID_CERT
      started += 1
      setImmediate(() => socket.emit('secureConnect'))
      return socket as never
    }) as TlsConnectFn

    const results = await collectTlsCertificates(
      [{ domain: 'only.example.com', port: 443 }],
      { connect, concurrency: 10 },
    )

    expect(started).toBe(1)
    expect(results).toHaveLength(1)
  })
})
