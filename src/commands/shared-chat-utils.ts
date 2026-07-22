import { ApiClient } from '../api-client'
import {
  CHAT_CHUNK_BATCH_MAX_BYTES,
  CHAT_CHUNK_BATCH_WINDOW_MS,
  CHUNK_LOG_LIMIT,
  ENV_VARS,
} from '../constants'
import { logger } from '../logger'
import type { ChatChunkType, ChatFileInfo, ChatPayload, CommandResult, HistoryMessage } from '../types'
import { getErrorMessage, truncateString } from '../utils'

/**
 * Slack Marketplace 起点（読み取り専用ツールポリシー）のコマンドかどうかを判定する。
 * chat-executor.ts（claude_code 経路）と api-chat-executor.ts（api 経路）の両方から
 * 参照される共有判定ロジック。
 */
export function isSlackMarketplaceCommand(payload: ChatPayload): boolean {
  return payload.interactionOrigin === 'slack' &&
    payload.toolPolicy === 'marketplace_read_only'
}

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

/**
 * チャンクのバッチ送信設定。
 * - enabled: false の場合は従来どおり 1 チャンク = 1 POST（即時送信）
 * - windowMs: delta をまとめる時間窓（この時間内の連続 delta を 1 POST に結合）
 * - maxBytes: バッファ結合サイズがこの値に達したら時間窓を待たず即 flush
 */
export interface ChunkBatchConfig {
  enabled: boolean
  windowMs: number
  maxBytes: number
}

export interface ChunkSenderOptions {
  debugLog?: boolean
  /** バッチ送信設定。未指定時は従来どおり即時送信（後方互換） */
  batch?: ChunkBatchConfig
}

/**
 * 環境変数からチャンクバッチ設定を解決する。
 * 本番のデフォルトは有効（`CHAT_CHUNK_BATCH_ENABLED` 未設定時）。
 * `'false'` を明示した場合のみ無効化する（切り戻し用キルスイッチ）。
 * window/maxBytes は正の整数の env 値のみ採用し、不正値は既定へフォールバックする。
 */
export function resolveChunkBatchConfig(): ChunkBatchConfig {
  const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  return {
    enabled: process.env[ENV_VARS.CHAT_CHUNK_BATCH_ENABLED] !== 'false',
    windowMs: parsePositiveInt(
      process.env[ENV_VARS.CHAT_CHUNK_BATCH_WINDOW_MS],
      CHAT_CHUNK_BATCH_WINDOW_MS,
    ),
    maxBytes: parsePositiveInt(
      process.env[ENV_VARS.CHAT_CHUNK_BATCH_MAX_BYTES],
      CHAT_CHUNK_BATCH_MAX_BYTES,
    ),
  }
}

/**
 * チャンクを送信する関数を生成するファクトリ
 *
 * `options.batch.enabled` が true の場合、`delta` チャンクは短い時間窓／バイト閾値で
 * まとめて 1 回の POST に結合する（本文増分の連結は web 側の index 順連結と等価）。
 * `delta` 以外（tool_call/tool_result/file_attachment/done/error/system）は、
 * バッファ中の delta を先に flush してから即時送信し、順序を保証する。
 *
 * @param commandId - コマンドID
 * @param client - APIクライアント
 * @param agentId - エージェントID
 * @param logTag - ログのプレフィックスタグ（例: "chat", "api-chat"）
 * @param options - オプション（debugLog: デバッグログ出力 / batch: バッチ送信設定）
 * @returns sendChunk（送信）・getChunkIndex（実送信数）・flush（残バッファ強制送信）
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
  flush: () => Promise<void>
} {
  let chunkIndex = 0

  // 実際に 1 チャンクを送信する（index はここで採番するため常に連続・単調）。
  const rawSend = async (
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

  const batch = options?.batch
  if (!batch || !batch.enabled) {
    // 後方互換: バッチ無効時は従来どおり 1 チャンク = 1 即時 POST。
    return { sendChunk: rawSend, getChunkIndex: () => chunkIndex, flush: async () => {} }
  }

  // --- バッチ有効時 ---
  let buffer: string[] = []
  let bufferedBytes = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  // flush を直列化し、タイマー flush と閾値 flush が交錯しても
  // index 採番・送信順序が決定的になるようにする。
  let flushChain: Promise<void> = Promise.resolve()

  const flushDelta = (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (buffer.length === 0) return flushChain
    // バッファを同期的に確定・クリアするため、並行呼び出しは空バッファを見て二重送信しない。
    const combined = buffer.join('')
    buffer = []
    bufferedBytes = 0
    flushChain = flushChain.then(() => rawSend('delta', combined))
    return flushChain
  }

  const sendChunk = async (
    type: ChatChunkType,
    content: string,
  ): Promise<void> => {
    if (type === 'delta') {
      buffer.push(content)
      bufferedBytes += Buffer.byteLength(content, 'utf8')
      if (bufferedBytes >= batch.maxBytes) {
        await flushDelta()
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => { void flushDelta() }, batch.windowMs)
      }
      return
    }
    // 非 delta: バッファ中の delta を先に送ってから当該チャンクを送る（順序保証）。
    await flushDelta()
    await rawSend(type, content)
  }

  const flush = async (): Promise<void> => {
    await flushDelta()
  }

  return { sendChunk, getChunkIndex: () => chunkIndex, flush }
}

/**
 * チャットコマンドのエラーを共通的に処理する
 * catch ブロックで使用し、ログ出力 + エラーチャンク送信 + 失敗結果を返す
 */
export async function handleChatError(
  error: unknown,
  commandId: string,
  logTag: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
): Promise<CommandResult> {
  const errorMessage = getErrorMessage(error)
  logger.error(`[${logTag}] Chat command failed [${commandId}]: ${errorMessage}`)
  await sendChunk('error', errorMessage)
  return { success: false, error: errorMessage }
}

/**
 * done チャンクを送信する（結果テキストとメタデータを含む）
 */
export async function sendDoneChunk(
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  content: Record<string, unknown>,
): Promise<void> {
  await sendChunk('done', JSON.stringify(content))
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
