import WebSocket from 'ws'

import { logger } from './logger'
import { getErrorMessage } from './utils'
import { attemptReconnect } from './ws-reconnect'

export interface BaseWebSocketOptions {
  maxReconnectRetries: number
  reconnectBaseDelayMs: number
  logPrefix: string
}

/**
 * WebSocket 接続の共通ライフサイクル管理
 * - 接続 / 再接続 / 切断
 * - JSON メッセージパース
 * - 再接続時のコールバック
 */
export abstract class BaseWebSocketConnection<TMessage> {
  protected ws: WebSocket | null = null
  protected closed = false
  protected readonly reconnectAttemptsRef = { current: 0 }
  protected readonly options: BaseWebSocketOptions

  constructor(options: BaseWebSocketOptions) {
    this.options = options
  }

  connect(): Promise<void> {
    this.closed = false
    this.reconnectAttemptsRef.current = 0
    return this.doConnect()
  }

  disconnect(): void {
    this.closed = true
    this.onDisconnect()
    if (this.ws) {
      this.closeWebSocket(this.ws)
      this.ws = null
    }
  }

  /** WebSocket URL とオプションを返す */
  protected abstract createWebSocket(): WebSocket

  /** 接続成功時の処理。Promise を resolve するタイミングはサブクラスが決める */
  protected abstract onOpen(ws: WebSocket, resolve: (value: void) => void): void

  /** パースされたメッセージを処理する */
  protected abstract onParsedMessage(msg: TMessage, resolve?: (value: void) => void): void

  /** 切断時のクリーンアップ（サブクラスでオーバーライド） */
  protected onDisconnect(): void {
    // default: no-op
  }

  /** WebSocket を閉じる（サブクラスでオーバーライド可能） */
  protected closeWebSocket(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      ws.close()
    } else {
      ws.terminate()
    }
  }

  protected sendMessage(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch (error) {
      logger.debug(`${this.options.logPrefix} Send error: ${getErrorMessage(error)}`)
    }
  }

  /** 再接続成功時のコールバック（サブクラスでオーバーライド可能） */
  protected onReconnected(): void {
    // default: no-op
  }

  protected doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.createWebSocket()

      ws.on('open', () => {
        this.onOpen(ws, resolve)
      })

      ws.on('message', (data: WebSocket.Data) => {
        let msg: TMessage
        try {
          msg = JSON.parse(data.toString()) as TMessage
        } catch {
          logger.debug(`${this.options.logPrefix} Failed to parse message`)
          return
        }
        this.onParsedMessage(msg, resolve)
      })

      ws.on('error', (error: Error) => {
        logger.debug(`${this.options.logPrefix} WebSocket error: ${getErrorMessage(error)}`)
        if (this.reconnectAttemptsRef.current === 0 && !this.ws) {
          reject(error)
        }
      })

      ws.on('close', () => {
        this.onWebSocketClose()
        if (!this.closed) {
          logger.debug(`${this.options.logPrefix} Connection closed unexpectedly`)
          void this.doReconnect()
        }
      })

      this.ws = ws
    })
  }

  /** WebSocket close イベント時の追加処理（サブクラスでオーバーライド可能） */
  protected onWebSocketClose(): void {
    // default: no-op
  }

  private async doReconnect(): Promise<void> {
    await attemptReconnect(this.reconnectAttemptsRef, {
      maxRetries: this.options.maxReconnectRetries,
      baseDelayMs: this.options.reconnectBaseDelayMs,
      logPrefix: this.options.logPrefix,
      connectFn: () => this.doConnect(),
      onReconnectedFn: () => this.onReconnected(),
      isClosedFn: () => this.closed,
    })
  }
}
