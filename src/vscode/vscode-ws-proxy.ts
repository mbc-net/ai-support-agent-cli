import WebSocket from 'ws'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

import { VSCODE_BIND_HOST } from './constants'

/**
 * ローカル code-server への WebSocket プロキシ
 *
 * トンネル経由で受け取った WS フレームをローカルの code-server に転送し、
 * レスポンスフレームをコールバックで返す。
 */
export class VsCodeWsProxy {
  private readonly connections = new Map<string, WebSocket>()

  constructor(private readonly port: number) {}

  /**
   * code-server への WebSocket 接続を開く
   */
  openConnection(
    subSocketId: string,
    path: string,
    onData: (data: string) => void,
    onClose: () => void,
  ): void {
    const url = `ws://${VSCODE_BIND_HOST}:${this.port}${path}`
    logger.debug(`[vscode-ws-proxy] Opening connection ${subSocketId} to ${url}`)

    const ws = new WebSocket(url)

    ws.on('open', () => {
      logger.debug(`[vscode-ws-proxy] Connection ${subSocketId} opened`)
      this.connections.set(subSocketId, ws)
    })

    ws.on('message', (data: WebSocket.Data) => {
      const encoded = Buffer.isBuffer(data)
        ? data.toString('base64')
        : Buffer.from(data.toString()).toString('base64')
      onData(encoded)
    })

    ws.on('close', () => {
      logger.debug(`[vscode-ws-proxy] Connection ${subSocketId} closed`)
      this.connections.delete(subSocketId)
      onClose()
    })

    ws.on('error', (error: Error) => {
      logger.debug(`[vscode-ws-proxy] Connection ${subSocketId} error: ${getErrorMessage(error)}`)
    })
  }

  /**
   * code-server にフレームを送信する
   */
  sendFrame(subSocketId: string, data: string): void {
    const ws = this.connections.get(subSocketId)
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    try {
      ws.send(Buffer.from(data, 'base64'))
    } catch (error) {
      logger.debug(`[vscode-ws-proxy] Send error for ${subSocketId}: ${getErrorMessage(error)}`)
    }
  }

  /**
   * 特定の接続を閉じる
   */
  closeConnection(subSocketId: string): void {
    const ws = this.connections.get(subSocketId)
    if (ws) {
      ws.close()
      this.connections.delete(subSocketId)
    }
  }

  /**
   * 全接続を閉じる
   */
  closeAll(): void {
    for (const [id, ws] of this.connections) {
      ws.close()
      this.connections.delete(id)
    }
  }
}
