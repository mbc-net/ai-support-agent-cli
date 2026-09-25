import WebSocket from 'ws'

import { BaseWebSocketConnection, createAgentWebSocket } from '../base-websocket'
import {
  WS_CLOSE_CODE_AUTH_REJECTED,
  WS_RECONNECT_MAX_DELAY_MS,
} from '../constants'
import { logger } from '../logger'
import { buildWsUrl, getErrorMessage } from '../utils'
import { isSafeSessionId } from '../utils/safe-session-id'
import type { GuacdEndpoint } from './guacd-container'
import { createLazyGuacdEndpointResolver } from './guacd-runtime'
import { connectToGuacd } from './guacd-tcp-socket'
import {
  RdpSessionRegistry,
  type RdpRegistryOutbound,
} from './rdp-session-registry'
import { createRdpTunnelSupport, type RdpTunnelSupport } from './rdp-tunnel'
import { parseRdpTunnel, type RdpTunnel } from './rdp-tunnel-message'

/**
 * The agent end of the Web RDP relay.
 *
 * Connects out to the API — the customer network needs no inbound opening —
 * and turns each server message into an action on {@link RdpSessionRegistry}.
 *
 * The registry holds every decision about a session; this class owns only the
 * socket and the validation that must happen **before** anything reaches guacd.
 */

/** Reconnect settings, matching the other agent relays. */
const RDP_WS_RECONNECT_BASE_DELAY_MS = 1_000
/** Retry forever: an RDP relay that gives up leaves the operator with no path in. */
const RDP_WS_MAX_RECONNECT_RETRIES = Number.POSITIVE_INFINITY

/** Display bounds. Mirrors the API-side check; neither side trusts the other. */
const MIN_DIMENSION = 1
const MAX_DIMENSION = 8192

/** Messages the API sends to the agent. */
export type RdpServerMessage =
  | {
      type: 'rdp_open'
      sessionId: string
      parameters: Record<string, string>
      width: number
      height: number
      dpi: number
      /**
       * Tunnel route (contract 1). Unvalidated as received; see
       * {@link parseRdpTunnel}. **Carries credentials.**
       */
      tunnel?: unknown
    }
  | { type: 'rdp_data'; sessionId: string; data: string }
  | { type: 'rdp_resize'; sessionId: string; width: number; height: number }
  | { type: 'rdp_close'; sessionId: string }
  | { type: 'auth_success' }
  | { type: 'error'; sessionId?: string; message: string }

export class RdpWebSocket extends BaseWebSocketConnection<RdpServerMessage> {
  private readonly wsUrl: string
  private readonly registry: RdpSessionRegistry

  /**
   * @param resolveGuacdEndpoint Resolves the guacd endpoint **at connection
   *   time**, and throws when RDP is not usable here.
   *
   *   :::danger コンストラクタで接続先を焼き込まない
   *   以前はここで `GUACD_HOST` / `GUACD_PORT` を読んで固定していた。そのため
   *   画面から capability を ON にしても、エージェントを再起動するまで RDP は
   *   使えなかった。関数として受け取り、**初回の `rdp_open` で解決する**ことで、
   *   ホスト直起動ではプロセス再起動なしに有効化できる。
   *
   *   投げるのも役割のうちである。無効なまま接続を試みると、利用者には
   *   「しばらく待たされて繋がらない」としか見えず、設定不備と障害の区別が
   *   付かない。
   *   :::
   */
  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    private readonly resolveGuacdEndpoint: () => GuacdEndpoint = createLazyGuacdEndpointResolver(),
    /** Tunnel routes this process serves (contract 2) and how to open them. */
    private readonly tunnels: RdpTunnelSupport = createRdpTunnelSupport(),
  ) {
    super({
      maxReconnectRetries: RDP_WS_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: RDP_WS_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: WS_RECONNECT_MAX_DELAY_MS,
      logPrefix: '[rdp-ws]',
      authRejectedCloseCode: WS_CLOSE_CODE_AUTH_REJECTED,
    })
    this.wsUrl = buildWsUrl(apiUrl, '/ws/agent-rdp')
    this.registry = new RdpSessionRegistry({
      connect: () => {
        const endpoint = this.resolveGuacdEndpoint()
        return connectToGuacd(endpoint.host, endpoint.port)
      },
      send: (msg) => this.sendToApi(msg),
      // guacd's host decides where the relay listens (Docker form), so it is
      // resolved per session like the connect above.
      openTunnel: (tunnel, sessionId, relayToken, forwardRoutingToken) =>
        this.tunnels.open(tunnel, {
          sessionId,
          guacdHost: this.resolveGuacdEndpoint().host,
          relayToken,
          forwardRoutingToken,
        }),
      // Direct connections are checked too: in the Docker form guacd is shared
      // between projects and could otherwise be pointed at another session's
      // relay, at loopback or at the metadata service.
      checkDirectTarget: (hostname) =>
        this.tunnels.checkDirectTarget(hostname, {
          guacdHost: this.resolveGuacdEndpoint().host,
        }),
    })
  }

  /** Live session count. Exposed for health reporting. */
  get sessionCount(): number {
    return this.registry.size
  }

  protected createWebSocket(): WebSocket {
    return createAgentWebSocket(
      this.wsUrl,
      this.token,
      this.agentId,
      this.getStickyCookieHeader(),
    )
  }

  protected onOpen(_ws: WebSocket, resolve: (value: void) => void): void {
    logger.info('[rdp-ws] Connected to RDP WebSocket')
    this.reconnectAttemptsRef.current = 0
    resolve()
  }

  /**
   * API 接続が失われたときのセッションの扱い。
   *
   * :::danger
   * **3 つのフックを取り違えない。** 基底クラスが `onDisconnect()` を呼ぶのは
   * 公開 `disconnect()`（明示的なシャットダウン）からだけである。実運用の切断
   * （ALB のアイドル切断、瞬断、ハートビートの誤検知、API の再起動）はすべて
   * `onWebSocketClose()` に、恒久的な認証拒否は `onPermanentClose()` に来る。
   * `onDisconnect()` だけに配線すると、再接続のたびに guacd 接続と
   * その先の RDP ログオンが誰にも触れない形で残る。
   *
   * `TerminalWebSocket` は一時切断だけ猶予付き（`closeAllGracefully`）にして
   * いるが、**RDP は同じ形にできない**。ターミナルの猶予が成立するのは出力を
   * リングバッファに溜めて再接続時に再生するからで、RDP 側に同等の仕組みは
   * 無く、`sendMessage` は WS が OPEN でなければ黙って捨てる。Guacamole の
   * 命令列は差分の積み重ねで、`sync` / `ack` は欠落した描画命令の再送機構では
   * ないため、欠落を挟んで再開すると画面は静かにずれる。3 つとも即座に畳み、
   * ブラウザ側に張り直させる
   * （詳細は `RdpSessionRegistry.closeAll` の danger）。
   * :::
   */

  /** 一時的な切断（再接続する）。実際の切断はほぼここに来る。 */
  protected override onWebSocketClose(): void {
    this.trackClosing()
  }

  /** 恒久的な認証拒否（再接続しない）。 */
  protected override onPermanentClose(): void {
    this.trackClosing()
  }

  /** 明示的なシャットダウン（エージェント終了時）。 */
  protected override onDisconnect(): void {
    this.trackClosing()
  }

  /** The latest closeAll() in progress, for {@link shutdown} to wait on. */
  private closing: Promise<void> = Promise.resolve()

  private trackClosing(): void {
    this.closing = Promise.resolve(this.registry.closeAll('API connection lost')).catch(
      (error: unknown) => {
        logger.warn(`[rdp-ws] Closing RDP sessions failed: ${getErrorMessage(error)}`)
      },
    )
  }

  /**
   * Disconnect and wait until every session's tunnel is closed.
   *
   * Called from the agent's shutdown path: exiting before the tunnels are
   * down would leave subprocesses (tailscaled, the SSM plugin) and remote
   * sessions behind. closeAll() itself bounds the wait.
   */
  async shutdown(): Promise<void> {
    this.disconnect()
    await this.closing
  }

  protected onParsedMessage(msg: RdpServerMessage): void {
    switch (msg.type) {
      case 'auth_success':
        return

      case 'error':
        logger.warn(`[rdp-ws] API reported an error: ${msg.message}`)
        // API が知らないセッションを、こちらだけが抱えている状態。grace で
        // 生き延びたあと API 側のセッションが既に消えていた場合に起こる。
        // 閉じなければ guacd 接続とリモートホスト上の RDP ログオンが、
        // 誰にも見えないまま残り続ける。
        if (
          typeof msg.sessionId === 'string' &&
          msg.message.startsWith('Session not found') &&
          this.registry.has(msg.sessionId)
        ) {
          this.registry.close(
            msg.sessionId,
            'the API no longer knows this session',
          )
        }
        return

      case 'rdp_open':
        this.handleOpen(msg)
        return

      case 'rdp_data':
        if (!isSafeSessionId(msg.sessionId ?? '')) return
        this.registry.send(msg.sessionId, msg.data)
        return

      case 'rdp_resize':
        if (!isSafeSessionId(msg.sessionId ?? '')) return
        if (!isValidDimension(msg.width) || !isValidDimension(msg.height)) {
          logger.warn(
            `[rdp-ws] Ignoring resize with invalid dimensions for session ${msg.sessionId}`,
          )
          return
        }
        this.registry.resize(msg.sessionId, msg.width, msg.height)
        return

      case 'rdp_close':
        if (!isSafeSessionId(msg.sessionId ?? '')) return
        this.registry.close(msg.sessionId, 'closed by API')
        return

      default: {
        const unknown = msg as unknown as Record<string, unknown>
        logger.warn(`[rdp-ws] Unknown message type: ${String(unknown.type)}`)
      }
    }
  }

  private handleOpen(
    msg: Extract<RdpServerMessage, { type: 'rdp_open' }>,
  ): void {
    // The sessionId reaches file paths and log lines; restrict it to the same
    // character set the terminal relay requires.
    if (!isSafeSessionId(msg.sessionId ?? '')) {
      logger.warn('[rdp-ws] Ignoring rdp_open with an unsafe sessionId')
      return
    }
    if (!msg.parameters || typeof msg.parameters !== 'object') {
      logger.warn(
        `[rdp-ws] Ignoring rdp_open without parameters for session ${msg.sessionId}`,
      )
      return
    }
    if (!isValidDimension(msg.width) || !isValidDimension(msg.height)) {
      logger.warn(
        `[rdp-ws] Ignoring rdp_open with invalid dimensions for session ${msg.sessionId}`,
      )
      return
    }

    // A tunnel route is checked before anything else happens: its shape, and
    // whether this process serves that route at all (the same answer the
    // heartbeat reports). Refusing here states the reason; a session that
    // started anyway would only fail later at guacd with nothing to go on.
    let tunnel: RdpTunnel | undefined
    if (msg.tunnel !== undefined) {
      const refusal = this.checkTunnel(msg.tunnel)
      if (typeof refusal === 'string') {
        logger.warn(`[rdp-ws] Refusing rdp_open for session ${msg.sessionId}: ${refusal}`)
        this.sendToApi({
          type: 'error',
          sessionId: msg.sessionId,
          message: refusal,
          fatal: true,
        })
        return
      }
      tunnel = refusal
    }

    // Resolve the endpoint **before** registering a session. Two reasons:
    //   - a refusal (capability off, waiting on a restart/redeploy, guacd could
    //     not be started) must reach the browser as a stated reason rather than
    //     as a connection that hangs and eventually times out;
    //   - the session registry must not hold an entry for a session that was
    //     never opened.
    try {
      this.resolveGuacdEndpoint()
    } catch (error) {
      const message = getErrorMessage(error)
      logger.warn(
        `[rdp-ws] Refusing rdp_open for session ${msg.sessionId}: ${message}`,
      )
      this.sendToApi({
        type: 'error',
        sessionId: msg.sessionId,
        message,
        // 一時的なフレーム落ちではなく、この接続は成立しない。ブラウザ側は
        // 待ち続けず終了として扱うべきなので致命として伝える。
        fatal: true,
      })
      return
    }

    // open() reports its own failures to the API and never rejects; the catch is
    // a backstop so a bug there cannot become an unhandled rejection.
    void this.registry.open({ ...msg, tunnel }).catch((error: unknown) => {
      logger.warn(
        `[rdp-ws] Failed to open RDP session ${msg.sessionId}: ${getErrorMessage(error)}`,
      )
    })
  }

  /**
   * Validate a tunnel instruction and confirm this process serves its route.
   *
   * @returns the parsed tunnel, or the refusal message (never carrying a value
   *   from the instruction — it goes to the browser)
   */
  private checkTunnel(raw: unknown): RdpTunnel | string {
    let tunnel: RdpTunnel
    try {
      tunnel = parseRdpTunnel(raw)
    } catch (error) {
      return `rdp_tunnel_invalid: ${getErrorMessage(error)}`
    }
    const kinds = this.tunnels.supportedKinds()
    if (!kinds) {
      return (
        'rdp_tunnel_unsupported: this agent does not relay RDP through tunnels ' +
        '(no tunnel relay is configured for its deployment form)'
      )
    }
    if (!kinds.includes(tunnel.kind)) {
      return `rdp_tunnel_unsupported: this agent cannot open ${tunnel.kind} tunnels`
    }
    return tunnel
  }

  private sendToApi(msg: RdpRegistryOutbound): void {
    this.sendMessage(msg)
  }
}

/** Display size guacd can accept. */
function isValidDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_DIMENSION &&
    value <= MAX_DIMENSION
  )
}
