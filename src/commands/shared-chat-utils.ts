import { ApiClient } from '../api-client'
import { CHUNK_LOG_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType, ChatFileInfo, HistoryMessage } from '../types'
import { getErrorMessage, truncateString } from '../utils'

/**
 * 外部からのhistoryデータをパースし、有効なHistoryMessage配列を返す
 */
export function parseHistory(history: unknown): HistoryMessage[] {
  if (!Array.isArray(history)) return []
  return history.filter(
    (item): item is HistoryMessage =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.role === 'string' &&
      typeof item.content === 'string',
  ).map(({ role, content }) => ({ role, content }))
}

/**
 * Claude Code CLI 向けに会話履歴をメッセージに埋め込む
 */
export function formatHistoryForClaudeCode(
  history: HistoryMessage[],
  currentMessage: string,
): string {
  if (history.length === 0) return currentMessage
  const historyBlock = history
    .map((msg) => `[${msg.role}]: ${msg.content}`)
    .join('\n\n')
  return `<conversation_history>\n${historyBlock}\n</conversation_history>\n\n${currentMessage}`
}

export interface ChunkSenderOptions {
  debugLog?: boolean
}

/**
 * チャンクを送信する関数を生成するファクトリ
 *
 * @param commandId - コマンドID
 * @param client - APIクライアント
 * @param agentId - エージェントID
 * @param logTag - ログのプレフィックスタグ（例: "chat", "api-chat"）
 * @param options - オプション（debugLog: チャンク送信時のデバッグログ出力）
 * @returns chunkIndex を内部管理する sendChunk 関数と、現在の chunkIndex を取得する関数
 */
export function createChunkSender(
  commandId: string,
  client: ApiClient,
  agentId: string,
  logTag: string,
  options?: ChunkSenderOptions,
): {
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>
  getChunkIndex: () => number
} {
  let chunkIndex = 0

  const sendChunk = async (
    type: ChatChunkType,
    content: string,
  ): Promise<void> => {
    try {
      if (options?.debugLog) {
        logger.debug(`[${logTag}] Sending chunk #${chunkIndex} (${type}) [${commandId}]: ${truncateString(content, CHUNK_LOG_LIMIT)}`)
      }
      await client.submitChatChunk(commandId, {
        index: chunkIndex++,
        type,
        content,
      }, agentId)
    } catch (error) {
      logger.warn(`[${logTag}] Failed to send chunk #${chunkIndex - 1}: ${getErrorMessage(error)}`)
    }
  }

  return { sendChunk, getChunkIndex: () => chunkIndex }
}

/**
 * ファイル添付チャンクを送信する
 */
export async function sendFileAttachmentChunk(
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  file: ChatFileInfo,
): Promise<void> {
  await sendChunk('file_attachment', JSON.stringify({
    fileId: file.fileId,
    s3Key: file.s3Key,
    filename: file.filename,
    contentType: file.contentType,
    fileSize: file.fileSize,
  }))
}
