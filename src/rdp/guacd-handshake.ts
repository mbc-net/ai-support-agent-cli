import {
  encodeGuacamoleInstruction,
  GuacamoleInstruction,
  GuacamoleStreamDecoder,
} from './guacamole-protocol'

/**
 * guacd connection handshake.
 *
 * ```text
 * client -> guacd  select   <protocol>
 * guacd  -> client args     <version> <name> <name> ...
 * client -> guacd  size / audio / video / image
 * client -> guacd  connect  <one value per name, in the order guacd listed them>
 * guacd  -> client ready    <connection id>
 * ```
 *
 * :::danger
 * The `connect` values are **positional**. guacd matches them to the names it sent
 * in `args`, so emitting them in any other order feeds the password into whatever
 * parameter happens to occupy that slot. Always project our parameter map through
 * the requested name list — never send our own ordering.
 * :::
 *
 * Credentials pass through here. Nothing in this module may log a parameter value
 * or place one in an error message.
 */

/** Raised when the handshake cannot complete. Never carries parameter values. */
export class GuacdHandshakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuacdHandshakeError'
  }
}

/**
 * Transport the handshake drives. Implemented over TCP in production.
 *
 * The `on*` methods are **setters, not subscriptions**: registering again
 * replaces the previous handler. The handshake installs its own handlers and
 * leaves them in place when it resolves, so the relay phase must re-register
 * `onData` / `onClose` / `onError` to take over the stream.
 */
export interface GuacdSocket {
  write(data: string): void
  onData(handler: (chunk: string) => void): void
  onClose(handler: () => void): void
  onError(handler: (error: Error) => void): void
  destroy(): void
}

/** Handshake inputs. */
export interface GuacdHandshakeParams {
  /** Remote-desktop protocol to ask guacd for. */
  protocol: 'rdp' | 'vnc'
  /**
   * Connection parameters by guacd parameter name (`hostname`, `port`,
   * `username`, `password`, `domain`, `disable-copy`, ...). Names guacd does not
   * ask for are ignored; names it asks for that are absent are sent empty.
   */
  parameters: Record<string, string>
  optimalWidth: number
  optimalHeight: number
  optimalDpi: number
  audioMimetypes?: readonly string[]
  videoMimetypes?: readonly string[]
  imageMimetypes?: readonly string[]
  /**
   * How long to wait for `ready` before giving up.
   *
   * guacd can accept the TCP connection and then stall — while it dials the RDP
   * host, or because it wedged. Without a deadline the promise never settles and
   * the session hangs with nothing logged anywhere. Defaults to
   * {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}.
   */
  timeoutMs?: number
}

/** Result of a completed handshake. */
export interface GuacdHandshakeResult {
  connectionId: string
  /**
   * Decoder carrying any bytes that arrived after `ready`. Handing it back lets
   * the caller keep relaying without losing instructions that were pipelined
   * behind the handshake.
   */
  decoder: GuacamoleStreamDecoder
  /** Instructions already decoded after `ready` but not yet relayed. */
  pending: GuacamoleInstruction[]
}

/**
 * Default handshake deadline.
 *
 * guacd only sends `ready` once it has connected to the remote desktop host, and
 * a cold Windows host can take well over ten seconds, so this is deliberately
 * generous. It exists to bound a stall, not to enforce latency.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000

const DEFAULT_AUDIO_MIMETYPES = ['audio/L16;rate=44100,channels=2'] as const
const DEFAULT_VIDEO_MIMETYPES: readonly string[] = []
const DEFAULT_IMAGE_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/**
 * Run the handshake and resolve once guacd reports `ready`.
 *
 * @throws {GuacdHandshakeError} guacd reported an error, the socket closed or
 *   errored before `ready`, or the stream was malformed
 */
export function performGuacdHandshake(
  socket: GuacdSocket,
  params: GuacdHandshakeParams,
): Promise<GuacdHandshakeResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS

  return new Promise<GuacdHandshakeResult>((resolve, reject) => {
    const decoder = new GuacamoleStreamDecoder()
    let settled = false
    let sentConnect = false

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      settleReject(
        `guacd did not complete the handshake within ${timeoutMs}ms`,
      )
    }, timeoutMs)

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const settleReject = (message: string): void => {
      if (settled) return
      settled = true
      clearTimer()
      socket.destroy()
      reject(new GuacdHandshakeError(message))
    }

    socket.onClose(() => {
      settleReject('guacd closed the connection during the handshake')
    })

    socket.onError((error) => {
      // Only the error's own message; parameter values never reach it.
      settleReject(`guacd socket error during the handshake: ${error.message}`)
    })

    socket.onData((chunk) => {
      if (settled) return

      let instructions: GuacamoleInstruction[]
      try {
        instructions = decoder.push(chunk)
      } catch (error) {
        settleReject(
          `guacd sent a malformed instruction stream: ${(error as Error).message}`,
        )
        return
      }

      for (let index = 0; index < instructions.length; index++) {
        const instruction = instructions[index]

        if (instruction.opcode === 'error') {
          // args are [message, status]; guacd's own text, no parameters of ours.
          settleReject(
            `guacd rejected the connection: ${instruction.args[0] ?? 'unknown error'}`,
          )
          return
        }

        if (instruction.opcode === 'args' && !sentConnect) {
          sentConnect = true
          sendConnect(socket, params, instruction.args)
          continue
        }

        if (instruction.opcode === 'ready') {
          const connectionId = instruction.args[0]
          if (!connectionId) {
            settleReject('guacd sent ready without a connection id')
            return
          }
          settled = true
          clearTimer()
          resolve({
            connectionId,
            decoder,
            pending: instructions.slice(index + 1),
          })
          return
        }
      }
    })

    socket.write(encodeGuacamoleInstruction('select', [params.protocol]))
  })
}

/**
 * Send the display/codec capabilities and the positional `connect` values.
 *
 * `argNames` is guacd's `args` payload: element 0 is the protocol version and the
 * rest are parameter names.
 */
function sendConnect(
  socket: GuacdSocket,
  params: GuacdHandshakeParams,
  argNames: readonly string[],
): void {
  socket.write(
    encodeGuacamoleInstruction('size', [
      String(params.optimalWidth),
      String(params.optimalHeight),
      String(params.optimalDpi),
    ]),
  )
  socket.write(
    encodeGuacamoleInstruction('audio', [
      ...(params.audioMimetypes ?? DEFAULT_AUDIO_MIMETYPES),
    ]),
  )
  socket.write(
    encodeGuacamoleInstruction('video', [
      ...(params.videoMimetypes ?? DEFAULT_VIDEO_MIMETYPES),
    ]),
  )
  socket.write(
    encodeGuacamoleInstruction('image', [
      ...(params.imageMimetypes ?? DEFAULT_IMAGE_MIMETYPES),
    ]),
  )

  // Element 0 is the protocol version, not a parameter name.
  const requestedNames = argNames.slice(1)
  const values = requestedNames.map((name) =>
    // Own-property lookup only: a name like "constructor" must not resolve to
    // something off Object.prototype and end up sent to guacd.
    Object.prototype.hasOwnProperty.call(params.parameters, name)
      ? params.parameters[name]
      : '',
  )

  socket.write(encodeGuacamoleInstruction('connect', values))
}
