import {
  GuacdHandshakeParams,
  GuacdSocket,
  performGuacdHandshake,
} from './guacd-handshake'
import {
  encodeGuacamoleInstruction,
  GuacamoleStreamDecoder,
} from './guacamole-protocol'

/**
 * One remote-desktop relay session: browser <-> API <-> agent <-> guacd.
 *
 * The agent owns the guacd connection so the customer network needs no inbound
 * opening, exactly as the terminal relay works.
 *
 * :::danger
 * Every exit path must destroy the guacd socket. A leaked socket keeps an RDP
 * logon alive on the remote host after the browser is gone — the session stays
 * billable, holds locks, and is invisible to the operator.
 * :::
 *
 * Connection parameters carry credentials. Nothing here may log a parameter
 * value or put one in an error.
 */

/** Callbacks the owner supplies. */
export interface RdpSessionOptions {
  /** Opens the transport to guacd. Separated so tests need no real TCP. */
  connect: () => Promise<GuacdSocket>
  params: GuacdHandshakeParams
  /** One complete Guacamole instruction bound for the client. */
  onOutbound: (data: string) => void
  /**
   * Session finished. Fires at most once, and **only after `start()` resolved**.
   * A failed handshake is reported by rejecting `start()` alone, so the owner is
   * not notified twice about the same failure.
   */
  onClosed: (reason: string) => void
  /**
   * Relay-phase failure. Always followed by `onClosed`. Handshake failures do
   * not come through here — they reject `start()`.
   */
  onError: (error: Error) => void
}

/** Result of a successful start. */
export interface RdpSessionStartResult {
  connectionId: string
}

export class RdpSession {
  private socket: GuacdSocket | null = null
  private decoder: GuacamoleStreamDecoder | null = null
  private ready = false
  private closed = false

  constructor(private readonly options: RdpSessionOptions) {}

  /** True once guacd reported `ready` and before the session closes. */
  get isReady(): boolean {
    return this.ready && !this.closed
  }

  /**
   * Connect to guacd, complete the handshake, and begin relaying.
   *
   * Resolves when guacd is ready. Rejects — with the socket already destroyed —
   * if the handshake fails.
   */
  async start(): Promise<RdpSessionStartResult> {
    const socket = await this.options.connect()
    this.socket = socket

    // performGuacdHandshake owns the socket handlers until it settles, and
    // destroys the socket itself on failure.
    const { connectionId, decoder, pending } = await performGuacdHandshake(
      socket,
      this.options.params,
    )

    // A close() that landed while the handshake was in flight must win: the
    // owner already decided this session is over.
    if (this.closed) {
      socket.destroy()
      return { connectionId }
    }

    this.decoder = decoder
    this.ready = true

    // Take over the stream from the handshake (the on* methods replace handlers).
    socket.onData((chunk) => this.handleChunk(chunk))
    socket.onClose(() => this.finish('guacd closed the connection'))
    socket.onError((error) => this.fail(error))

    // Instructions that arrived in the same packet as `ready` are already
    // decoded; relaying them here keeps the client's stream complete.
    for (const instruction of pending) {
      this.options.onOutbound(
        encodeGuacamoleInstruction(instruction.opcode, instruction.args),
      )
    }

    return { connectionId }
  }

  /**
   * Forward one client instruction to guacd.
   *
   * Ignored before `ready` and after close: writing to a socket that is not
   * relaying either desynchronises the handshake or throws on a dead handle.
   */
  send(data: string): void {
    if (!this.isReady || !this.socket) return
    this.socket.write(data)
  }

  /** Close the session. Safe to call repeatedly and before `start()`. */
  close(reason: string): void {
    this.finish(reason)
  }

  private handleChunk(chunk: string): void {
    if (this.closed || !this.decoder) return

    try {
      for (const instruction of this.decoder.push(chunk)) {
        this.options.onOutbound(
          encodeGuacamoleInstruction(instruction.opcode, instruction.args),
        )
      }
    } catch (error) {
      // A desynchronised stream cannot be recovered from: every later byte is
      // interpreted at the wrong offset. Tear down rather than relay garbage.
      this.fail(error as Error)
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.options.onError(error)
    this.finish(`relay error: ${error.message}`)
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.ready = false
    if (this.socket) {
      this.socket.destroy()
    }
    this.options.onClosed(reason)
  }
}
