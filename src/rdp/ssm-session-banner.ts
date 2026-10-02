/**
 * Filter for session-manager-plugin's stdout in stdio mode
 * (`AWS-StartSSHSession`, used by the SSM route via the host itself).
 *
 * The plugin writes status lines to the same stdout that carries the data
 * (aws/session-manager-plugin, mainline):
 *
 * - `src/sessionmanagerplugin/session/session.go` `Execute`, before the data
 *   channel is opened:
 *   `fmt.Fprintf(os.Stdout, "\nStarting session with SessionId: %s\n", s.SessionId)`
 * - `src/datachannel/streaming.go`, when the handshake completes and the agent
 *   sent a customer message: `fmt.Fprintln(os.Stdout, handshakeComplete.CustomerMessage)`
 * - `src/datachannel/streaming.go` `HandleChannelClosedMessage`, when the
 *   channel closes: `"\n\nExiting session with sessionId: %s.\n\n"` (or with
 *   the close output)
 *
 * (`awscli/customizations/sessionmanager.py` runs the plugin with `check_call`
 * and inherited stdio, adding nothing of its own to stdout.)
 *
 * SSH tolerates such lines (it skips text before its identification string);
 * RDP does not. So:
 *
 * 1. the `Starting session` line — fixed format — is dropped when, and only
 *    when, it matches exactly;
 * 2. the next byte must then be the RDP server's TPKT (0x03): anything else
 *    (a customer message, an unknown line) fails the stream rather than being
 *    guessed away;
 * 3. the closing line arrives only after the RDP data, when the session is
 *    already ending, and is passed through: it cannot be told apart from data
 *    without delaying every byte.
 */

import { Transform, type TransformCallback } from 'stream'

const PREFIX = Buffer.from('\nStarting session with SessionId: ')
/** Characters a session id is made of (`<caller>-<hex>`, e.g. `botocore-session-0123…`). */
const SESSION_ID_BYTE = /^[A-Za-z0-9._@:-]$/
const MAX_BANNER_BYTES = 256
const TPKT_VERSION = 0x03

export function createSsmBannerFilter(): Transform {
  let state: 'banner' | 'first' | 'data' = 'banner'
  let pending = Buffer.alloc(0)

  const unexpected = (where: string): Error =>
    new Error(`unexpected output from session-manager-plugin ${where}`)

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      if (state === 'data') {
        callback(null, chunk)
        return
      }
      let buffer = Buffer.concat([pending, chunk])

      if (state === 'banner') {
        const prefixLength = Math.min(buffer.length, PREFIX.length)
        if (!buffer.subarray(0, prefixLength).equals(PREFIX.subarray(0, prefixLength))) {
          callback(unexpected('(not the "Starting session" line)'))
          return
        }
        if (buffer.length <= PREFIX.length) {
          pending = buffer
          callback()
          return
        }
        let index = PREFIX.length
        while (index < buffer.length && buffer[index] !== 0x0a) {
          if (!SESSION_ID_BYTE.test(String.fromCharCode(buffer[index]))) {
            callback(unexpected('(malformed "Starting session" line)'))
            return
          }
          index++
        }
        if (index >= buffer.length) {
          if (buffer.length > MAX_BANNER_BYTES) {
            callback(unexpected('(the "Starting session" line is too long)'))
            return
          }
          pending = buffer
          callback()
          return
        }
        buffer = buffer.subarray(index + 1)
        state = 'first'
      }

      pending = Buffer.alloc(0)
      if (buffer.length === 0) {
        callback()
        return
      }
      if (buffer[0] !== TPKT_VERSION) {
        callback(unexpected('before RDP data (e.g. a customer message); refusing to guess'))
        return
      }
      state = 'data'
      callback(null, buffer)
    },
  })
}
