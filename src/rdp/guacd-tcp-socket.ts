import * as net from 'net'

import { GuacdSocket } from './guacd-handshake'

/**
 * Adapter from Node's `net.Socket` to the {@link GuacdSocket} contract.
 *
 * guacd speaks UTF-8 text. The Guacamole framing counts characters, so a single
 * mis-decoded byte shifts every subsequent length and desynchronises the stream
 * for good — hence the explicit `setEncoding('utf8')` and the Buffer fallback.
 */

/** Port guacd listens on by default. */
export const DEFAULT_GUACD_PORT = 4822

/**
 * Upper bound on the TCP connect to guacd.
 *
 * :::danger
 * **The connect must have its own deadline.** guacd sits on loopback or a
 * sidecar, so a connect takes milliseconds; if the address blackholes (SYN with
 * no reply) Node waits for the OS timeout — minutes on Linux, longer elsewhere.
 * Without this bound, closing the session cannot free the socket: `RdpSession`
 * only gets to check `closed` once `connect()` settles, so the raw socket and
 * the pending open outlive the browser giving up.
 * :::
 */
export const GUACD_CONNECT_TIMEOUT_MS = 10_000

/** Wrap an existing socket. Exposed separately so tests need no real TCP. */
export function createGuacdTcpSocket(socket: net.Socket): GuacdSocket {
  socket.setEncoding('utf8')

  let dataHandler: ((chunk: string) => void) | null = null
  let closeHandler: (() => void) | null = null
  let errorHandler: ((error: Error) => void) | null = null
  let destroyed = false

  // Registered once and dispatched through the mutable handler slots. Adding a
  // listener per onData() call would deliver every instruction more than once
  // when the relay takes over from the handshake.
  socket.on('data', (chunk: string | Buffer) => {
    dataHandler?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
  })
  socket.on('close', () => {
    closeHandler?.()
  })
  // Always listening: an unhandled 'error' event on an EventEmitter throws and
  // takes the agent process down, which would turn one bad RDP target into an
  // outage for every session on the agent.
  socket.on('error', (error: Error) => {
    errorHandler?.(error)
  })

  return {
    write(data: string): void {
      if (destroyed) return
      socket.write(data)
    },
    onData(handler: (chunk: string) => void): void {
      dataHandler = handler
    },
    onClose(handler: () => void): void {
      closeHandler = handler
    },
    onError(handler: (error: Error) => void): void {
      errorHandler = handler
    },
    destroy(): void {
      if (destroyed) return
      destroyed = true
      socket.destroy()
    },
  }
}

/** Open a TCP connection to guacd and wrap it. */
export function connectToGuacd(
  host: string,
  port: number = DEFAULT_GUACD_PORT,
  timeoutMs: number = GUACD_CONNECT_TIMEOUT_MS,
): Promise<GuacdSocket> {
  return new Promise<GuacdSocket>((resolve, reject) => {
    const socket = net.createConnection({ host, port })

    const timer = setTimeout(() => {
      socket.destroy()
      reject(
        new Error(
          `failed to connect to guacd at ${host}:${port}: timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
    // Do not keep the process alive for a pending connect deadline.
    timer.unref?.()

    const onConnectError = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(
        new Error(`failed to connect to guacd at ${host}:${port}: ${error.message}`),
      )
    }

    socket.once('error', onConnectError)
    socket.once('connect', () => {
      // Hand the socket over only after the connect attempt settled, so the
      // connect-time error path cannot fire once the relay owns the socket.
      clearTimeout(timer)
      socket.removeListener('error', onConnectError)
      resolve(createGuacdTcpSocket(socket))
    })
  })
}
