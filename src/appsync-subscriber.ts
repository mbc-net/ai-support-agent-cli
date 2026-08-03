import WebSocket from 'ws'

import { BaseWebSocketConnection } from './base-websocket'
import {
  APPSYNC_CONNECT_FAILURE_ESCALATION_THRESHOLD,
  APPSYNC_MAX_RECONNECT_RETRIES,
  APPSYNC_RECONNECT_BASE_DELAY_MS,
  DEFAULT_APPSYNC_TIMEOUT_MS,
  WS_RECONNECT_MAX_DELAY_MS,
} from './constants'
import { logger } from './logger'

export interface AppSyncNotification {
  id: string
  table: string
  pk: string
  sk: string
  tenantCode: string
  action: string
  content: Record<string, unknown>
}

interface AppSyncMessage {
  id?: string
  type: string
  payload?: Record<string, unknown>
}

const SUBSCRIPTION_QUERY = `subscription OnMessage($tenantCode: String!) {
  onMessage(tenantCode: $tenantCode) {
    id
    table
    pk
    sk
    tenantCode
    action
    content
  }
}`

export class AppSyncSubscriber extends BaseWebSocketConnection<AppSyncMessage> {
  private readonly realtimeUrl: string
  private readonly host: string
  /**
   * Agent token (`{tenantCode}:{tokenId}:{rawToken}`) sent via the
   * `Authorization` header. The AppSync Lambda authorizer validates it and
   * enforces tenant scope. This replaces the former master API key.
   */
  private readonly authToken: string
  private subscriptionId: string | null = null
  private tenantCode: string | null = null
  private messageHandler: ((notification: AppSyncNotification) => void) | null = null
  private reconnectCallback: (() => void) | null = null
  private persistentFailureCallback: (() => void) | null = null
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimeoutMs = 0
  /**
   * Whether the current connection attempt reached connection_ack. Reset to
   * false at the start of each attempt (in onWebSocketClose, after counting)
   * and set true on connection_ack. Used to distinguish a real, established
   * connection from an attempt that closed before ever acking (handshake
   * rejection or an immediate post-open drop).
   */
  private ackedThisConnection = false
  /** Consecutive connection attempts that closed without ever acking. */
  private consecutiveConnectFailures = 0
  /** Guards the persistent-failure escalation so it fires at most once per streak. */
  private persistentFailureNotified = false

  constructor(appsyncUrl: string, authToken: string) {
    super({
      maxReconnectRetries: APPSYNC_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: APPSYNC_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: WS_RECONNECT_MAX_DELAY_MS,
      logPrefix: 'AppSync:',
    })
    this.authToken = authToken
    const url = new URL(appsyncUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('AppSync URL must use HTTP or HTTPS protocol')
    }
    this.host = url.host
    const isAwsAppSync = url.host.includes('.appsync-api.')
    if (isAwsAppSync) {
      this.realtimeUrl = appsyncUrl
        .replace('https://', 'wss://')
        .replace('.appsync-api.', '.appsync-realtime-api.')
    } else {
      // Local AppSync simulator uses /graphql/realtime path
      this.realtimeUrl = appsyncUrl
        .replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace(/\/graphql$/, '/graphql/realtime')
    }
  }

  subscribe(
    tenantCode: string,
    onMessage: (notification: AppSyncNotification) => void,
  ): void {
    this.tenantCode = tenantCode
    this.messageHandler = onMessage
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(tenantCode)
    }
  }

  onReconnect(callback: () => void): void {
    this.reconnectCallback = callback
  }

  /**
   * Registers a callback fired when AppSync has failed to establish a working
   * realtime connection (never reaching connection_ack) for
   * APPSYNC_CONNECT_FAILURE_ESCALATION_THRESHOLD consecutive attempts. This is
   * the signal-agnostic degraded-state escalation: it covers a handshake
   * rejection (HTTP 401), an invalid/expired/empty agent token, and a Lambda
   * authorizer that is not enabled for the environment, all of which surface as
   * "closed without ack". Reconnection continues (transient issues self-heal);
   * the callback exists so the listener can surface the degraded state. Fires
   * at most once per failure streak (a successful ack resets it). Distinct from
   * onReconnect, which signals a successful transient recovery.
   */
  onPersistentFailure(callback: () => void): void {
    this.persistentFailureCallback = callback
  }

  protected createWebSocket(): WebSocket {
    const url = this.buildConnectionUrl()
    return new WebSocket(url, ['graphql-ws'])
  }

  protected onOpen(ws: WebSocket): void {
    const initMessage: AppSyncMessage = { type: 'connection_init' }
    ws.send(JSON.stringify(initMessage))
  }

  protected onParsedMessage(msg: AppSyncMessage, resolveConnect?: (value: void) => void): void {
    switch (msg.type) {
      case 'connection_ack': {
        // A successful ack proves this attempt reached a working connection, so
        // reset the persistent-failure escalation state for the next streak.
        this.ackedThisConnection = true
        this.consecutiveConnectFailures = 0
        this.persistentFailureNotified = false
        const timeoutMs = (msg.payload?.connectionTimeoutMs as number) ?? DEFAULT_APPSYNC_TIMEOUT_MS
        this.keepAliveTimeoutMs = timeoutMs
        this.resetKeepAliveTimer()
        logger.debug(`AppSync: Connection acknowledged (timeout: ${timeoutMs}ms)`)
        if (resolveConnect) {
          resolveConnect()
        }
        if (this.tenantCode && this.messageHandler) {
          this.sendSubscription(this.tenantCode)
        }
        break
      }

      case 'start_ack':
        logger.debug(`AppSync: Subscription started (id: ${msg.id})`)
        break

      case 'data': {
        this.resetKeepAliveTimer()
        const onMessageData = (msg.payload?.data as Record<string, unknown>)?.onMessage as
          | AppSyncNotification
          | undefined
        if (onMessageData && this.messageHandler) {
          this.messageHandler(onMessageData)
        }
        break
      }

      case 'ka':
        this.resetKeepAliveTimer()
        break

      case 'error':
        // Do NOT try to classify this as an auth rejection from the payload:
        // substring-matching 401/403/Unauthorized/AccessDenied here false-positives
        // on unrelated downstream errors (e.g. a transient IAM AccessDenied) and
        // would permanently stop a healthy subscription. Auth/handshake failures
        // are handled signal-agnostically by the connection-failure escalation in
        // onWebSocketClose(). Here we just warn and keep reconnecting.
        logger.warn(`AppSync error: ${JSON.stringify(msg.payload)}`)
        break

      case 'complete':
        logger.debug(`AppSync: Subscription completed (id: ${msg.id})`)
        this.subscriptionId = null
        break
    }
  }

  protected onDisconnect(): void {
    this.clearKeepAliveTimer()
    if (this.ws && this.subscriptionId) {
      const stopMessage: AppSyncMessage = {
        id: this.subscriptionId,
        type: 'stop',
      }
      try {
        this.ws.send(JSON.stringify(stopMessage))
      } catch {
        // ignore send errors during disconnect
      }
    }
    this.subscriptionId = null
  }

  protected onWebSocketClose(): void {
    // Signal-agnostic connection-failure escalation. If this attempt closed
    // without ever reaching connection_ack, it never became a working
    // connection — count it. A handshake rejection (HTTP 401 during the WS
    // upgrade, which produces no parsed message) and an immediate post-open
    // drop both land here, so this catches invalid/expired/empty tokens and a
    // Lambda authorizer that is not enabled, without inspecting error payloads.
    if (!this.ackedThisConnection) {
      this.consecutiveConnectFailures++
      if (
        this.consecutiveConnectFailures >= APPSYNC_CONNECT_FAILURE_ESCALATION_THRESHOLD &&
        !this.persistentFailureNotified
      ) {
        logger.error(
          `AppSync realtime persistently failing to connect (${this.consecutiveConnectFailures} consecutive) — ` +
            'likely invalid/expired agent token or Lambda authorizer not enabled for this environment. ' +
            'Check the agent token and server rollout order. Realtime delivery is degraded.',
        )
        this.persistentFailureCallback?.()
        this.persistentFailureNotified = true
      }
    }
    // Reset for the next connection attempt. We intentionally do NOT set
    // closed=true: reconnection continues so transient outages and rollout lag
    // self-heal; the escalation above only makes the degraded state visible.
    this.ackedThisConnection = false
    this.clearKeepAliveTimer()
  }

  protected onReconnected(): void {
    this.reconnectCallback?.()
  }

  // ROLLOUT DEPENDENCY — READ BEFORE DISTRIBUTING THIS BUILD.
  // This client authenticates to AppSync exclusively via the `Authorization`
  // header (agent token), validated by the AppSync Lambda authorizer (LAMBDA
  // auth mode). The former `x-api-key` fallback has been removed and there is
  // NO dual-header send (AppSync treats multiple auth headers as ambiguous).
  // Therefore this build MUST NOT be distributed to any environment before its
  // AppSync Lambda authorizer is enabled — otherwise every agent silently
  // fails authentication (prod does not have LAMBDA enabled yet). Migration
  // order: (1) enable the authorizer in ALL target environments, (2) distribute
  // this CLI, (3) remove the API key. The safety net for an out-of-order
  // rollout is the connection-failure escalation in onWebSocketClose(): after
  // APPSYNC_CONNECT_FAILURE_ESCALATION_THRESHOLD consecutive attempts that
  // close WITHOUT reaching connection_ack — which includes a handshake
  // rejection (HTTP 401 during the WS upgrade) as well as post-open drops — it
  // emits a loud ERROR and fires onPersistentFailure, so the degraded state is
  // visible instead of an invisible, infinitely-retrying silent failure.
  // Reconnection is NOT stopped (transient issues self-heal). The exact
  // close/HTTP/message shape of an authorizer rejection must be confirmed in
  // dev verification (A8) and the threshold tuned accordingly.
  private buildConnectionUrl(): string {
    const header = {
      host: this.host,
      Authorization: this.authToken,
      'content-type': 'application/json',
    }
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64')
    const encodedPayload = Buffer.from(JSON.stringify({})).toString('base64')
    return `${this.realtimeUrl}?header=${encodedHeader}&payload=${encodedPayload}`
  }

  private sendSubscription(tenantCode: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const id = `sub-${Date.now()}`
    this.subscriptionId = id

    const extensions = {
      authorization: {
        host: this.host,
        Authorization: this.authToken,
        'content-type': 'application/json',
      },
    }

    const startMessage = {
      id,
      type: 'start',
      payload: {
        data: JSON.stringify({
          query: SUBSCRIPTION_QUERY,
          variables: { tenantCode },
        }),
        extensions,
      },
    }

    this.ws.send(JSON.stringify(startMessage))
  }

  private resetKeepAliveTimer(): void {
    this.clearKeepAliveTimer()
    if (this.keepAliveTimeoutMs > 0) {
      this.keepAliveTimer = setTimeout(() => {
        logger.warn('AppSync: Keep-alive timeout, reconnecting...')
        if (this.ws) {
          this.ws.close()
        }
      }, this.keepAliveTimeoutMs)
    }
  }

  private clearKeepAliveTimer(): void {
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }
}
