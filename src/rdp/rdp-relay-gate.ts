/**
 * The relay's front door: only guacd holding this session's token gets in.
 *
 * Why a token: the relay listens where guacd can reach it — loopback in a
 * K8s Pod / ECS task, the shared `ais-rdp` network in the Docker form — and
 * anything else that can reach that address (another process in the Pod,
 * another project's session through the shared guacd) would otherwise be piped
 * straight into this session's tunnel.
 *
 * How it travels: the registry hands guacd the token as the `load-balance-info`
 * parameter. FreeRDP 2.x sends LoadBalanceInfo as the RDP **routing token**:
 * the raw value followed by CRLF, at the start of the X.224 Connection
 * Request's variable part, **instead of** the `Cookie: mstshash=` line
 * (FreeRDP 2.11.7 `libfreerdp/core/nego.c` `nego_send_negotiation_request`;
 * guacd 1.5.5 `src/protocols/rdp/settings.c` maps `load-balance-info` to
 * `LoadBalanceInfo`). Captured from guacd 1.5.5:
 *
 * ```
 * 03 00 00 26 | 21 e0 00 00 00 00 00 | <token> 0d 0a | 01 00 08 00 03 00 00 00
 *  TPKT (len)   LI CR  dst  src  cls   routing token   RDP_NEG_REQ
 * ```
 *
 * The relay reads that first TPKT, compares the line with `timingSafeEqual`,
 * and forwards the request **without** the line (TPKT length and LI
 * rewritten), so the RDP host never sees the token. A routing token is
 * optional in the protocol, so the host accepts the request without it. When
 * the API supplied its own `load-balance-info` (RD Connection Broker), that
 * value is put back in the token's place.
 */

import { timingSafeEqual } from 'crypto'
import type { Socket } from 'net'

/** Largest first packet accepted. A Connection Request is well under 100 bytes. */
export const RELAY_GATE_MAX_BYTES = 1024
/** How long a new connection has to send its Connection Request. */
export const RELAY_GATE_TIMEOUT_MS = 5_000

const TPKT_VERSION = 0x03
const TPKT_HEADER_LENGTH = 4
/** TPKT header + LI + code + DST-REF(2) + SRC-REF(2) + class. */
const CR_FIXED_LENGTH = 11
const X224_CONNECTION_REQUEST = 0xe0
/** X.224 length indicator: 0-254 are valid, 255 is reserved. */
const X224_LI_RESERVED = 0xff
const CRLF = Buffer.from('\r\n')

export type GateResult = { ok: true; rewritten: Buffer } | { ok: false; reason: string }

/**
 * Check one complete TPKT carrying the X.224 Connection Request.
 *
 * Reasons name the defect only — never the bytes received, which may be the
 * token of another session being probed for.
 */
export function inspectConnectionRequest(
  packet: Buffer,
  expectedToken: string,
  forwardRoutingToken?: string,
): GateResult {
  if (packet.length < TPKT_HEADER_LENGTH || packet[0] !== TPKT_VERSION || packet[1] !== 0x00) {
    return { ok: false, reason: 'first packet is not a TPKT' }
  }
  const length = packet.readUInt16BE(2)
  if (length !== packet.length || length < CR_FIXED_LENGTH) {
    return { ok: false, reason: 'TPKT length does not match a Connection Request' }
  }
  if (packet[4] !== length - 5) {
    return { ok: false, reason: 'X.224 length indicator does not match the TPKT length' }
  }
  if (packet[4] >= X224_LI_RESERVED) {
    return { ok: false, reason: 'X.224 length indicator 255 is reserved' }
  }
  if (packet[5] !== X224_CONNECTION_REQUEST) {
    return { ok: false, reason: 'first packet is not an X.224 Connection Request' }
  }

  const lineEnd = packet.indexOf(CRLF, CR_FIXED_LENGTH)
  if (lineEnd < 0) {
    return { ok: false, reason: 'Connection Request carries no routing token' }
  }
  const line = packet.subarray(CR_FIXED_LENGTH, lineEnd)
  const expected = Buffer.from(expectedToken, 'latin1')
  // Lengths are compared first (timingSafeEqual requires it); the length of a
  // fixed-size random token is not a secret.
  if (line.length !== expected.length || !timingSafeEqual(line, expected)) {
    return { ok: false, reason: 'routing token mismatch' }
  }

  // The API's own routing token (if any) takes the token's place, terminated
  // the way FreeRDP terminates it: CRLF added unless already there.
  const restored = forwardRoutingToken
    ? Buffer.from(
        forwardRoutingToken.endsWith('\r\n') ? forwardRoutingToken : `${forwardRoutingToken}\r\n`,
        'latin1',
      )
    : Buffer.alloc(0)
  const rewritten = Buffer.concat([
    packet.subarray(0, CR_FIXED_LENGTH),
    restored,
    packet.subarray(lineEnd + CRLF.length),
  ])
  // LI is one byte and 255 is reserved (valid: 0-254): a request it cannot
  // describe must not be forwarded.
  if (rewritten.length - 5 >= X224_LI_RESERVED) {
    return { ok: false, reason: 'restored routing token is too long for an X.224 Connection Request' }
  }
  rewritten.writeUInt16BE(rewritten.length, 2)
  rewritten[4] = rewritten.length - 5
  return { ok: true, rewritten }
}

/**
 * Read exactly the first TPKT from a new connection.
 *
 * Resolves with the packet and whatever arrived after it in the same reads;
 * the socket is left **paused** with its data listener removed, so the caller
 * can pipe it without losing bytes. Rejects — without reading further — on a
 * non-TPKT start, an oversized length, the deadline, or the socket ending.
 */
export function readFirstTpkt(
  socket: Pick<Socket, 'on' | 'removeListener' | 'pause'>,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ packet: Buffer; rest: Buffer }> {
  const maxBytes = options.maxBytes ?? RELAY_GATE_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? RELAY_GATE_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false

    const cleanup = (): void => {
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onEnd)
      socket.removeListener('error', onError)
    }
    const fail = (message: string): void => {
      if (settled) return
      cleanup()
      reject(new Error(message))
    }
    const onData = (chunk: Buffer | string): void => {
      if (settled) return
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk])
      if (buffer[0] !== TPKT_VERSION) {
        fail('first packet is not a TPKT')
        return
      }
      if (buffer.length < TPKT_HEADER_LENGTH) return
      const length = buffer.readUInt16BE(2)
      if (length > maxBytes) {
        fail(`first packet length ${length} exceeds ${maxBytes} bytes`)
        return
      }
      if (buffer.length < length) return
      cleanup()
      socket.pause()
      resolve({ packet: buffer.subarray(0, length), rest: buffer.subarray(length) })
    }
    const onEnd = (): void => fail('connection closed before the Connection Request arrived')
    const onError = (err: Error): void => fail(`connection error before the Connection Request: ${err.message}`)

    const timer = setTimeout(
      () => fail(`no Connection Request within ${timeoutMs}ms`),
      timeoutMs,
    )
    timer.unref?.()
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onError)
  })
}
