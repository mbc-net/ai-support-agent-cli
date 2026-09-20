import WebSocket from 'ws'

import { BaseWebSocketConnection, buildAgentWsHeaders } from '../base-websocket'
import {
  WS_CLOSE_CODE_AUTH_REJECTED,
  WS_RECONNECT_MAX_DELAY_MS,
} from '../constants'
import { logger } from '../logger'
import { buildWsUrl, getErrorMessage } from '../utils'
import { isSafeSessionId } from '../utils/safe-session-id'
import { connectToGuacd, DEFAULT_GUACD_PORT } from './guacd-tcp-socket'
import {
  RdpSessionRegistry,
  type RdpRegistryOutbound,
} from './rdp-session-registry'

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
    }
  | { type: 'rdp_data'; sessionId: string; data: string }
  | { type: 'rdp_resize'; sessionId: string; width: number; height: number }
  | { type: 'rdp_close'; sessionId: string }
  | { type: 'auth_success' }
  | { type: 'error'; sessionId?: string; message: string }

export class RdpWebSocket extends BaseWebSocketConnection<RdpServerMessage> {
  private readonly wsUrl: string
  private readonly registry: RdpSessionRegistry

  constructor(
    apiUrl: string,
    private readonly token: string,
    private readonly agentId: string,
    guacdHost = process.env.GUACD_HOST ?? '127.0.0.1',
    guacdPort = Number(process.env.GUACD_PORT ?? DEFAULT_GUACD_PORT),
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
      connect: () => connectToGuacd(guacdHost, guacdPort),
      send: (msg) => this.sendToApi(msg),
    })
  }

  /** Live session count. Exposed for health reporting. */
  get sessionCount(): number {
    return this.registry.size
  }

  protected createWebSocket(): WebSocket {
    return new WebSocket(this.wsUrl, {
      headers: buildAgentWsHeaders(
        this.token,
        this.agentId,
        this.getStickyCookieHeader(),
      ),
    })
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
    this.registry.closeAll('API connection lost')
  }

  /** 恒久的な認証拒否（再接続しない）。 */
  protected override onPermanentClose(): void {
    this.registry.closeAll('API connection lost')
  }

  /** 明示的なシャットダウン（エージェント終了時）。 */
  protected override onDisconnect(): void {
    this.registry.closeAll('API connection lost')
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

    // open() reports its own failures to the API and never rejects; the catch is
    // a backstop so a bug there cannot become an unhandled rejection.
    void this.registry.open(msg).catch((error: unknown) => {
      logger.warn(
        `[rdp-ws] Failed to open RDP session ${msg.sessionId}: ${getErrorMessage(error)}`,
      )
    })
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
