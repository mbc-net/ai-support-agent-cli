import WebSocket from 'ws'

import { WS_HEARTBEAT_INTERVAL_MS, WS_HEARTBEAT_TIMEOUT_MS } from './constants'
import { logger } from './logger'
import { getErrorMessage } from './utils'
import { attemptReconnect } from './ws-reconnect'

export interface BaseWebSocketOptions {
  maxReconnectRetries: number
  reconnectBaseDelayMs: number
  /** 再接続バックオフの上限 (ms)。省略時は cap なし。 */
  reconnectMaxDelayMs?: number
  logPrefix: string
  /** ping 送信間隔 (ms)。省略時は WS_HEARTBEAT_INTERVAL_MS。0 以下で無効化。 */
  heartbeatIntervalMs?: number
  /** pong 応答待ちのタイムアウト (ms)。省略時は WS_HEARTBEAT_TIMEOUT_MS。 */
  heartbeatTimeoutMs?: number
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null

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
    this.stopHeartbeat()
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
        this.startHeartbeat(ws)
        this.onOpen(ws, resolve)
      })

      ws.on('pong', () => {
        // pong を受信したら生存確認タイマーを解除する（次の ping まで健全）
        if (this.pongTimeoutTimer) {
          clearTimeout(this.pongTimeoutTimer)
          this.pongTimeoutTimer = null
        }
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
        this.stopHeartbeat()
        this.onWebSocketClose()
        if (!this.closed) {
          logger.debug(`${this.options.logPrefix} Connection closed unexpectedly`)
          void this.doReconnect()
        }
      })

      this.ws = ws
    })
  }

  /**
   * ハートビート (ping/pong) を開始する。
   * 一定間隔で ping を送り、次の間隔までに pong が返らなければ接続が
   * 死んでいる（half-open / ロードバランサに切られた）とみなして terminate する。
   * terminate は 'close' イベントを発火させ、既存の再接続ロジックを起動する。
   */
  private startHeartbeat(ws: WebSocket): void {
    const intervalMs = this.options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS
    if (intervalMs <= 0) return
    const timeoutMs = this.options.heartbeatTimeoutMs ?? WS_HEARTBEAT_TIMEOUT_MS
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      // 前回の pong 待ちが残っていれば（=応答なし）ここには来ない（terminate 済み）
      this.pongTimeoutTimer = setTimeout(() => {
        logger.debug(`${this.options.logPrefix} Heartbeat timeout, terminating connection`)
        ws.terminate()
      }, timeoutMs)
      try {
        ws.ping()
      } catch (error) {
        logger.debug(`${this.options.logPrefix} Ping error: ${getErrorMessage(error)}`)
      }
    }, intervalMs)
  }

  /** ハートビートと pong 待ちタイマーを停止する。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer)
      this.pongTimeoutTimer = null
    }
  }

  /** WebSocket close イベント時の追加処理（サブクラスでオーバーライド可能） */
  protected onWebSocketClose(): void {
    // default: no-op
  }

  private async doReconnect(): Promise<void> {
    await attemptReconnect(this.reconnectAttemptsRef, {
      maxRetries: this.options.maxReconnectRetries,
      baseDelayMs: this.options.reconnectBaseDelayMs,
      maxDelayMs: this.options.reconnectMaxDelayMs,
      logPrefix: this.options.logPrefix,
      connectFn: () => this.doConnect(),
      onReconnectedFn: () => this.onReconnected(),
      isClosedFn: () => this.closed,
    })
  }
}
