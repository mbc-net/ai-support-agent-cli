import WebSocket from 'ws'

import { BaseWebSocketConnection } from './base-websocket'
import { APPSYNC_MAX_RECONNECT_RETRIES, APPSYNC_RECONNECT_BASE_DELAY_MS, DEFAULT_APPSYNC_TIMEOUT_MS } from './constants'
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
  private readonly apiKey: string
  private subscriptionId: string | null = null
  private tenantCode: string | null = null
  private messageHandler: ((notification: AppSyncNotification) => void) | null = null
  private reconnectCallback: (() => void) | null = null
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimeoutMs = 0

  constructor(appsyncUrl: string, apiKey: string) {
    super({
      maxReconnectRetries: APPSYNC_MAX_RECONNECT_RETRIES,
      reconnectBaseDelayMs: APPSYNC_RECONNECT_BASE_DELAY_MS,
      logPrefix: 'AppSync:',
    })
    this.apiKey = apiKey
    const url = new URL(appsyncUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('AppSync URL must use HTTP or HTTPS protocol')
    }
    this.host = url.host
    this.realtimeUrl = appsyncUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://')
      .replace('.appsync-api.', '.appsync-realtime-api.')
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
    this.clearKeepAliveTimer()
  }

  protected onReconnected(): void {
    this.reconnectCallback?.()
  }

  private buildConnectionUrl(): string {
    const header = {
      host: this.host,
      'x-api-key': this.apiKey,
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
        'x-api-key': this.apiKey,
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
