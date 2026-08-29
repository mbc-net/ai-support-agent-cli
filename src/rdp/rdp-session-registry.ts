import { GuacdSocket } from './guacd-handshake'
import { encodeGuacamoleInstruction } from './guacamole-protocol'
import { RdpSession } from './rdp-session'

/**
 * Owns the agent's live RDP sessions and turns API messages into guacd actions.
 *
 * Deliberately transport-independent: the WebSocket class handles reconnection
 * and framing, while every decision about a session lives here so it can be
 * exercised without a socket.
 *
 * :::danger
 * Every entry point is keyed by `sessionId`. Acting on the wrong session would
 * stream one customer's desktop into another's browser.
 * :::
 */

/** Messages this registry emits back to the API. */
export type RdpRegistryOutbound =
  | { type: 'rdp_ready'; sessionId: string; connectionId: string }
  | { type: 'rdp_data'; sessionId: string; data: string }
  | { type: 'rdp_closed'; sessionId: string; reason: string }
  | { type: 'error'; sessionId: string; message: string }

/** Everything the registry needs from its surroundings. */
export interface RdpSessionRegistryOptions {
  /** Opens a transport to guacd. Injected so tests need no real TCP. */
  connect: () => Promise<GuacdSocket>
  /** Sends a message back to the API. */
  send: (msg: RdpRegistryOutbound) => void
}

/** Parameters for opening a session, as received from the API. */
export interface RdpOpenRequest {
  sessionId: string
  /** guacd connection parameters. **Carries credentials.** */
  parameters: Record<string, string>
  width: number
  height: number
  dpi: number
}

export class RdpSessionRegistry {
  private readonly sessions = new Map<string, RdpSession>()

  constructor(private readonly options: RdpSessionRegistryOptions) {}

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Open a session and relay it until it closes.
   *
   * Never rejects: a failure is reported to the API as `rdp_closed` so the
   * browser stops waiting. Leaving it to an unhandled rejection would strand
   * the client on a spinner with nothing logged on its side.
   */
  async open(request: RdpOpenRequest): Promise<void> {
    if (this.sessions.has(request.sessionId)) {
      // Reusing a live id would orphan the first guacd socket — it would keep
      // an RDP logon alive with no way left to address it.
      this.options.send({
        type: 'error',
        sessionId: request.sessionId,
        message: 'session id already in use',
      })
      return
    }

    const session = new RdpSession({
      connect: this.options.connect,
      params: {
        protocol: 'rdp',
        parameters: request.parameters,
        optimalWidth: request.width,
        optimalHeight: request.height,
        optimalDpi: request.dpi,
      },
      onOutbound: (data) => {
        this.options.send({
          type: 'rdp_data',
          sessionId: request.sessionId,
          data: Buffer.from(data, 'utf8').toString('base64'),
        })
      },
      onClosed: (reason) => {
        this.sessions.delete(request.sessionId)
        this.options.send({
          type: 'rdp_closed',
          sessionId: request.sessionId,
          reason,
        })
      },
      onError: () => {
        // onClosed always follows; reporting here too would double-notify.
      },
    })

    this.sessions.set(request.sessionId, session)

    try {
      const { connectionId } = await session.start()

      // start() also resolves when close() landed mid-handshake — the socket is
      // destroyed and the entry already removed. Reporting ready then would
      // arrive AFTER rdp_closed and leave the browser believing it is connected
      // to a session that no longer exists.
      if (this.sessions.get(request.sessionId) !== session) {
        return
      }

      this.options.send({
        type: 'rdp_ready',
        sessionId: request.sessionId,
        connectionId,
      })
    } catch (error) {
      this.sessions.delete(request.sessionId)
      // The message comes from the handshake, which never embeds parameter
      // values — but keep it to the message alone regardless.
      this.options.send({
        type: 'rdp_closed',
        sessionId: request.sessionId,
        reason: (error as Error).message,
      })
    }
  }

  /** Forward base64-encoded client input to guacd. */
  send(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const decoded = decodeBase64(data)
    if (decoded === null) {
      // Writing undecodable input would desynchronise guacd's parser for the
      // rest of the session. Log it: silently dropping input presents as
      // "the keyboard stopped working" with nothing to go on.
      this.options.send({
        type: 'error',
        sessionId,
        message: 'discarded a frame that was not valid base64',
      })
      return
    }
    session.send(decoded)
  }

  /** Tell guacd the client's display size changed. */
  resize(sessionId: string, width: number, height: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.send(
      encodeGuacamoleInstruction('size', [String(width), String(height)]),
    )
  }

  /** Close one session. Safe to call repeatedly. */
  close(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // RdpSession.close() fires onClosed, which removes the entry and reports.
    session.close(reason)
  }

  /** Close every session — agent shutdown, or the API connection dropping. */
  closeAll(reason: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId, reason)
    }
  }
}

/**
 * Strict base64 decode.
 *
 * `Buffer.from(x, 'base64')` silently skips invalid characters, so a corrupted
 * frame would decode to plausible-looking bytes and be written straight to
 * guacd. Round-tripping catches that.
 */
function decodeBase64(value: string): string | null {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    return null
  }
  return decoded.toString('utf8')
}
