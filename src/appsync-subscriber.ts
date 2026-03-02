import WebSocket from 'ws'

import { DEFAULT_APPSYNC_TIMEOUT_MS } from './constants'
import { logger } from './logger'
import { calculateBackoff } from './retry-strategy'
import { getErrorMessage } from './utils'

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

const MAX_RECONNECT_RETRIES = 5
const RECONNECT_BASE_DELAY_MS = 1000

export class AppSyncSubscriber {
  private ws: WebSocket | null = null
  private readonly realtimeUrl: string
  private readonly host: string
  private readonly apiKey: string
  private subscriptionId: string | null = null
  private tenantCode: string | null = null
  private messageHandler: ((notification: AppSyncNotification) => void) | null = null
  private reconnectCallback: (() => void) | null = null
  private reconnectAttempts = 0
  private closed = false
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimeoutMs = 0

  constructor(appsyncUrl: string, apiKey: string) {
    this.apiKey = apiKey
    const url = new URL(appsyncUrl)
    if (url.protocol !== 'https:') {
      throw new Error('AppSync URL must use HTTPS protocol')
    }
    this.host = url.host
    this.realtimeUrl = appsyncUrl
      .replace('https://', 'wss://')
      + '/realtime'
  }

  connect(): Promise<void> {
    this.closed = false
    this.reconnectAttempts = 0
    return this.doConnect()
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

  disconnect(): void {
    this.closed = true
    this.clearKeepAliveTimer()
    if (this.ws) {
      if (this.subscriptionId) {
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
      this.ws.close()
      this.ws = null
    }
    this.subscriptionId = null
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

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildConnectionUrl()
      const ws = new WebSocket(url, ['graphql-ws'])

      ws.on('open', () => {
        const initMessage: AppSyncMessage = { type: 'connection_init' }
        ws.send(JSON.stringify(initMessage))
      })

      ws.on('message', (data: WebSocket.Data) => {
        let msg: AppSyncMessage
        try {
          msg = JSON.parse(data.toString()) as AppSyncMessage
        } catch {
          logger.debug('AppSync: Failed to parse message')
          return
        }

        this.handleMessage(msg, resolve)
      })

      ws.on('error', (error: Error) => {
        logger.debug(`AppSync WebSocket error: ${getErrorMessage(error)}`)
        if (this.reconnectAttempts === 0 && !this.ws) {
          reject(error)
        }
      })

      ws.on('close', () => {
        this.clearKeepAliveTimer()
        if (!this.closed) {
          logger.debug('AppSync WebSocket closed unexpectedly')
          void this.attemptReconnect()
        }
      })

      this.ws = ws
    })
  }

  private handleMessage(msg: AppSyncMessage, resolveConnect?: (value: void) => void): void {
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

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
      if (this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
        logger.error('AppSync: Max reconnect attempts reached')
      }
      return
    }

    this.reconnectAttempts++
    const delay = calculateBackoff({
      baseDelayMs: RECONNECT_BASE_DELAY_MS,
      attempt: this.reconnectAttempts - 1,
      jitter: false,
    })
    logger.info(`AppSync: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_RETRIES})`)

    await new Promise<void>((resolve) => setTimeout(resolve, delay))

    if (this.closed) return

    try {
      await this.doConnect()
      logger.info('AppSync: Reconnected successfully')
      this.reconnectAttempts = 0
      if (this.reconnectCallback) {
        this.reconnectCallback()
      }
    } catch (error) {
      logger.warn(`AppSync: Reconnect failed: ${getErrorMessage(error)}`)
      void this.attemptReconnect()
    }
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
