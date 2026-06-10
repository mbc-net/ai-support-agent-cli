import WebSocket from 'ws'

import { WS_HEARTBEAT_INTERVAL_MS, WS_PONG_MAX_MISSED } from './constants'
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
  /** 連続未応答 pong の許容回数。省略時は WS_PONG_MAX_MISSED。 */
  pongMaxMissed?: number
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
  /**
   * Liveness state for the isAlive / missed-pong heartbeat method.
   * - alive: set true on every 'pong'. Reset to false right after each ping so
   *   the next tick can tell whether a pong arrived in between.
   * - missed: consecutive ticks without a pong. Reaching pongMaxMissed terminates.
   * alive starts false (consistent with the API side): the very first ping tick
   * counts as one missed unless a pong has already arrived.
   */
  private heartbeatAlive = false
  private heartbeatMissed = 0

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
        // A pong proves the peer is alive; the next heartbeat tick will reset
        // the missed counter. Safe to receive even before the first ping.
        this.heartbeatAlive = true
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
   *
   * ws 標準の「isAlive」単一インターバル方式を使う。各インターバルで:
   *   1. 前回の tick 以降に pong を受信していなければ missed をインクリメントし、
   *      missed が pongMaxMissed に達したら接続を死んでいる（half-open /
   *      ロードバランサに切られた）とみなして terminate する。
   *   2. pong を受信していれば missed を 0 にリセットする。
   *   3. alive を false に戻し、次の ping を送信する。
   *
   * ただし最初の tick は ping を送るだけで miss 判定をしない（接続直後は相手に
   * pong を返す機会がまだ無いため）。これにより健全な接続でも phantom miss を
   * 数えず、pongMaxMissed 回の許容を接続直後からフルに使える（finding #6）。
   *
   * terminate は 'close' イベントを発火させ、既存の再接続ロジックを起動する。
   * 1 回の未応答では terminate しないため、イベントループ stall による誤検知を防ぐ。
   */
  private startHeartbeat(ws: WebSocket): void {
    const intervalMs = this.options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS
    if (intervalMs <= 0) return
    const maxMissed = this.options.pongMaxMissed ?? WS_PONG_MAX_MISSED
    this.stopHeartbeat()
    // Reset liveness state for this connection.
    this.heartbeatAlive = false
    this.heartbeatMissed = 0
    // The first tick only sends a ping; miss evaluation starts on the next tick.
    let firstTick = true
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return

      if (firstTick) {
        // No prior ping was sent, so a missing pong here is not a real miss.
        firstTick = false
      } else if (!this.heartbeatAlive) {
        this.heartbeatMissed++
        if (this.heartbeatMissed >= maxMissed) {
          logger.debug(
            `${this.options.logPrefix} No pong after ${this.heartbeatMissed} consecutive pings, terminating connection`,
          )
          ws.terminate()
          return
        }
      } else {
        this.heartbeatMissed = 0
      }

      // Expect a fresh pong before the next tick.
      this.heartbeatAlive = false
      try {
        ws.ping()
      } catch (error) {
        logger.debug(`${this.options.logPrefix} Ping error: ${getErrorMessage(error)}`)
      }
    }, intervalMs)
  }

  /** ハートビートを停止し、生存確認状態をリセットする。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatAlive = false
    this.heartbeatMissed = 0
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
