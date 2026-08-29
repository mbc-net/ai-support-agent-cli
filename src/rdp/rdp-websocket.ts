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
   * Tear every session down when the API connection drops.
   *
   * Sessions cannot survive the reconnect: the API's session registry is keyed
   * to the old connection, so nothing would ever address them again — while the
   * RDP logons stayed alive on the remote hosts.
   */
  protected override onDisconnect(): void {
    this.registry.closeAll('API connection lost')
  }

  protected onParsedMessage(msg: RdpServerMessage): void {
    switch (msg.type) {
      case 'auth_success':
        return

      case 'error':
        logger.warn(`[rdp-ws] API reported an error: ${msg.message}`)
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
