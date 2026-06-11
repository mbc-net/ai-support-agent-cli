/**
 * Tests for ALB sticky-cookie support in BaseWebSocketConnection
 * (reconnect-resilience design 5).
 *
 * The WS handshake (upgrade) response's Set-Cookie headers (AWSALB /
 * AWSALBCORS) are captured in-memory and re-sent as a Cookie header on
 * reconnect so the agent keeps hitting the SAME API task behind a scaled-out
 * ALB. Verified against a real ws server (the 'headers' hook injects
 * Set-Cookie into the 101 handshake response).
 */

import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../src/base-websocket'
import * as terminalConstants from '../src/terminal/constants'
import { TerminalWebSocket } from '../src/terminal/terminal-websocket'

jest.mock('../src/logger')

interface TestMessage {
  type: string
}

class StickyTestConnection extends BaseWebSocketConnection<TestMessage> {
  constructor(private readonly url: string) {
    super({
      maxReconnectRetries: 2,
      reconnectBaseDelayMs: 20,
      logPrefix: '[sticky-test]',
      heartbeatIntervalMs: 0,
    })
  }

  protected createWebSocket(): WebSocket {
    const cookie = this.getStickyCookieHeader()
    return new WebSocket(this.url, {
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
  }

  protected onOpen(_ws: WebSocket, resolve: (value: void) => void): void {
    this.reconnectAttemptsRef.current = 0
    resolve()
  }

  protected onParsedMessage(): void {
    /* no-op */
  }

  // Test seams for the protected/private members.
  cookieHeader(): string | undefined {
    return this.getStickyCookieHeader()
  }

  capture(headers: Record<string, string[] | undefined>): void {
    ;(this as unknown as {
      captureStickyCookies(res: { headers: Record<string, string[] | undefined> }): void
    }).captureStickyCookies({ headers })
  }
}

describe('BaseWebSocketConnection sticky cookies', () => {
  let server: WebSocket.Server
  let serverPort: number
  let conn: StickyTestConnection | null = null

  beforeEach((done) => {
    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      ;(server as unknown as { _server: { unref(): void } })._server?.unref()
      done()
    })
  })

  afterEach((done) => {
    conn?.disconnect()
    conn = null
    server.close(() => done())
  })

  it('captures Set-Cookie from the handshake and re-sends it as Cookie on reconnect', async () => {
    // Inject ALB-style sticky cookies into the 101 handshake response.
    server.on('headers', (headers) => {
      headers.push('Set-Cookie: AWSALB=alb-target-hash; Expires=Thu, 18 Jun 2026 00:00:00 GMT; Path=/')
      headers.push('Set-Cookie: AWSALBCORS=cors-target-hash; SameSite=None; Secure; Path=/')
    })

    const requestCookies: Array<string | undefined> = []
    const connections: WebSocket[] = []
    const secondConnection = new Promise<void>((resolve) => {
      server.on('connection', (ws, req) => {
        requestCookies.push(req.headers.cookie)
        connections.push(ws)
        if (requestCookies.length === 2) resolve()
      })
    })

    conn = new StickyTestConnection(`ws://localhost:${serverPort}`)
    await conn.connect()

    // First handshake carries no cookie (none captured yet).
    expect(requestCookies[0]).toBeUndefined()
    // The handshake response cookies are now stored.
    expect(conn.cookieHeader()).toBe('AWSALB=alb-target-hash; AWSALBCORS=cors-target-hash')

    // Transient drop → automatic reconnect must present the sticky cookies.
    connections[0].close()
    await secondConnection

    expect(requestCookies[1]).toBe('AWSALB=alb-target-hash; AWSALBCORS=cors-target-hash')
  })

  it('returns undefined when no Set-Cookie was received on the handshake', async () => {
    conn = new StickyTestConnection(`ws://localhost:${serverPort}`)
    await conn.connect()
    expect(conn.cookieHeader()).toBeUndefined()
  })

  it('overwrites a cookie by name on a later handshake (latest value wins)', () => {
    conn = new StickyTestConnection(`ws://localhost:${serverPort}`)
    conn.capture({ 'set-cookie': ['AWSALB=first-value; Path=/'] })
    conn.capture({ 'set-cookie': ['AWSALB=second-value; Path=/'] })
    expect(conn.cookieHeader()).toBe('AWSALB=second-value')
  })

  it('ignores malformed Set-Cookie entries (no "=" / empty name)', () => {
    conn = new StickyTestConnection(`ws://localhost:${serverPort}`)
    conn.capture({
      'set-cookie': [
        'malformed-without-equals',
        '=value-with-empty-name',
        'VALID=ok; Path=/',
      ],
    })
    expect(conn.cookieHeader()).toBe('VALID=ok')
  })

  it('is a no-op when the upgrade response has no set-cookie header', () => {
    conn = new StickyTestConnection(`ws://localhost:${serverPort}`)
    conn.capture({})
    conn.capture({ 'set-cookie': [] })
    expect(conn.cookieHeader()).toBeUndefined()
  })
})

describe('TerminalWebSocket sticky cookies', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket

  beforeEach((done) => {
    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      ;(server as unknown as { _server: { unref(): void } })._server?.unref()
      done()
    })
  })

  afterEach((done) => {
    if (terminalWs) terminalWs.disconnect()
    server.close(() => done())
  })

  it('re-sends the ALB sticky cookie together with the auth headers on reconnect', async () => {
    const origDelay = terminalConstants.TERMINAL_WS_RECONNECT_BASE_DELAY_MS
    Object.defineProperty(terminalConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: 20, writable: true })

    server.on('headers', (headers) => {
      headers.push('Set-Cookie: AWSALB=terminal-sticky; Path=/')
    })

    const requests: Array<{ cookie?: string; authorization?: string; agentId?: string }> = []
    const connections: WebSocket[] = []
    const secondConnection = new Promise<void>((resolve) => {
      server.on('connection', (ws, req) => {
        requests.push({
          cookie: req.headers.cookie,
          authorization: req.headers.authorization,
          agentId: req.headers['x-agent-id'] as string | undefined,
        })
        connections.push(ws)
        if (requests.length === 2) resolve()
      })
    })

    terminalWs = new TerminalWebSocket(`http://localhost:${serverPort}`, 'test-token', 'agent-1', '/tmp')
    await terminalWs.connect()

    expect(requests[0].cookie).toBeUndefined()

    // Transient drop → reconnect must carry both auth headers AND the cookie.
    connections[0].close()
    await secondConnection

    expect(requests[1].cookie).toBe('AWSALB=terminal-sticky')
    expect(requests[1].authorization).toBe('Bearer test-token')
    expect(requests[1].agentId).toBe('agent-1')

    Object.defineProperty(terminalConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: origDelay, writable: true })
  })
})
