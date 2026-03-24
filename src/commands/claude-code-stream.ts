import { LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType } from '../types'
import { safeJsonParse } from '../utils/json-parse'

/** stream-json の assistant/user メッセージ内のコンテンツブロック */
export interface StreamJsonContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'tool_reference'
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  // tool_result 固有フィールド
  tool_use_id?: string
  /** 組み込みツールでは string、MCP ツールでは {type, text}[] or {type, source}[] の配列 */
  content?: string | Array<{ type: string; text?: string; data?: string; source?: { type: string; media_type?: string; data?: string } }>
}

/** stream-json の MCP サーバー接続情報 */
export interface StreamJsonMcpServer {
  name: string
  status: string
  error?: string
}

/** stream-json の1行（NDJSON）の型定義 */
export interface StreamJsonLine {
  type: string
  subtype?: string
  message?: {
    content?: StreamJsonContentBlock[]
  }
  result?: string
  // init イベントのフィールド
  tools?: string[]
  mcp_servers?: StreamJsonMcpServer[]
}

/** file_upload ツール結果を file_attachment チャンクに変換する */
const FILE_UPLOAD_TOOL_NAME = 'mcp__ai-support-agent__file_upload'

/** Screenshot base64 の最大サイズ（バイト） */
const SCREENSHOT_MAX_BASE64_BYTES = 512 * 1024

/**
 * stream-json の NDJSON 1行をパースし、テキストやツール呼び出し情報を処理する
 * sendChunk は fire-and-forget で呼び出される（同期的に状態を返すため）
 *
 * @returns newSentTextLength: 送信済みテキスト長, text: resultイベントのテキスト(undefinedなら未取得),
 *          toolExecutionChange: ツール実行状態の変化 ('started' | 'finished' | undefined)
 */
export function processStreamJsonLine(
  line: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  pid: number,
  state: { sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> },
): { newSentTextLength: number; text?: string; toolExecutionChange?: 'started' | 'finished' } {
  const parsed = safeJsonParse<StreamJsonLine>(line)
  if (!parsed) {
    logger.debug(`[chat] stream-json parse error (pid=${pid}): ${line.substring(0, LOG_DEBUG_LIMIT)}`)
    return { newSentTextLength: state.sentTextLength }
  }

  if (parsed.type === 'assistant' && parsed.message?.content) {
    let newSentTextLength = state.sentTextLength
    // assistant メッセージからテキストとツール呼び出しを抽出
    let fullText = ''
    let hasToolUse = false
    for (const block of parsed.message.content) {
      if (block.type === 'text' && block.text) {
        fullText += block.text
      } else if (block.type === 'tool_use' && block.name) {
        hasToolUse = true
        // ツール呼び出し情報をログ出力
        logger.info(`[chat] tool_use: ${block.name} (pid=${pid})`)
        // tool_call チャンクとして送信（input は大きすぎる場合があるため省略可）
        void sendChunk('tool_call', JSON.stringify({
          toolName: block.name,
          name: block.name,
          id: block.id,
          input: block.input ?? {},
        }))
        // tool_use_id → ツール名のマッピングを追跡（tool_result で toolName を復元するため）
        if (block.id) {
          if (!state.pendingToolNames) state.pendingToolNames = new Map()
          state.pendingToolNames.set(block.id, block.name)
        }
        // file_upload ツールの呼び出しを追跡（tool_result から file_attachment を生成するため）
        if (block.name === FILE_UPLOAD_TOOL_NAME && block.id) {
          if (!state.pendingFileUploadIds) state.pendingFileUploadIds = new Set()
          state.pendingFileUploadIds.add(block.id)
        }
      }
    }
    // 新しいテキスト部分のみ delta チャンクとして送信（重複防止）
    if (fullText.length > newSentTextLength) {
      const newText = fullText.substring(newSentTextLength)
      void sendChunk('delta', newText)
      newSentTextLength = fullText.length
    }
    return { newSentTextLength, toolExecutionChange: hasToolUse ? 'started' : undefined }
  }

  // user メッセージ内の tool_result を処理
  // 1. 全ツールの tool_result を tool_result チャンクとして送信（RDS保存・UI表示用）
  // 2. file_upload ツールの結果は追加で file_attachment チャンクも送信
  // MCP ツールの tool_result は2回来る: 1回目は tool_reference（スキップ）、2回目が実際の結果
  //
  // 重要: user メッセージ（tool_result）の後に来る次の assistant メッセージは
  // 新しいメッセージなので、sentTextLength をリセットする。
  // リセットしないと、新メッセージのテキストが前メッセージより短い場合に
  // delta チャンクが送信されず、テキストが欠落する。
  if (parsed.type === 'user' && parsed.message?.content) {
    let hasActualToolResult = false
    for (const block of parsed.message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue

      // tool_reference ブロックはスキップ（MCP ツールの1回目）
      if (Array.isArray(block.content) && block.content.length > 0 && block.content[0].type === 'tool_reference') {
        continue
      }

      hasActualToolResult = true

      // ツール名を復元
      const toolName = state.pendingToolNames?.get(block.tool_use_id) ?? 'unknown'

      // tool_result の内容をテキストとして抽出（image ブロックがあればスクリーンショットも含める）
      let resultText: string
      let screenshotBase64: string | undefined
      if (typeof block.content === 'string') {
        resultText = block.content
      } else if (Array.isArray(block.content)) {
        const textBlock = block.content.find(b => b.type === 'text' && b.text)
        resultText = textBlock?.text ?? ''
        // Extract screenshot from image blocks
        const imageBlock = block.content.find(b => b.type === 'image')
        if (imageBlock) {
          // image block can have data directly or in source.data
          const base64Data = imageBlock.data ?? imageBlock.source?.data
          // Size guard: skip if base64 > 512KB
          if (base64Data && base64Data.length <= SCREENSHOT_MAX_BASE64_BYTES) {
            screenshotBase64 = base64Data
          } else if (base64Data) {
            logger.warn(`[stream] Screenshot base64 too large (${base64Data.length} bytes), skipped`)
          }
        }
      } else {
        resultText = ''
      }

      // Append screenshot marker if present
      if (screenshotBase64) {
        resultText += `\n[screenshot:base64:${screenshotBase64}]`
      }

      // tool_result チャンクを送信
      const isError = resultText.startsWith('Error:') || resultText.startsWith('error:')
      const output = safeJsonParse<Record<string, unknown>>(resultText) ?? { text: resultText }
      void sendChunk('tool_result', JSON.stringify({
        toolName,
        success: !isError,
        output,
      }))
      logger.info(`[chat] tool_result: ${toolName} success=${!isError} (pid=${pid})`)

      // file_upload ツールの場合は追加で file_attachment チャンクも送信
      if (state.pendingFileUploadIds?.has(block.tool_use_id)) {
        const fileData = parseFileUploadResult(block.content)
        if (fileData) {
          state.pendingFileUploadIds.delete(block.tool_use_id)
          logger.info(`[chat] file_upload result: fileId=${fileData.fileId}, filename=${fileData.filename} (pid=${pid})`)
          void sendChunk('file_attachment', JSON.stringify(fileData))
        }
      }

      // マッピングをクリーンアップ
      state.pendingToolNames?.delete(block.tool_use_id)
    }
    // sentTextLength をリセット: 次の assistant メッセージは新しいメッセージなので
    // 前メッセージのテキスト長に基づく重複防止は不要
    // tool_reference のみの場合はツール実行中のまま（タイマー再開しない）
    return { newSentTextLength: 0, toolExecutionChange: hasActualToolResult ? 'finished' : undefined }
  }

  if (parsed.type === 'result' && parsed.result !== undefined) {
    return { newSentTextLength: state.sentTextLength, text: parsed.result }
  }

  if (parsed.type === 'system' && parsed.subtype === 'init') {
    // MCP サーバー接続状態とツール一覧をログ出力（デバッグ用）
    if (parsed.mcp_servers?.length) {
      for (const mcp of parsed.mcp_servers) {
        if (mcp.status === 'connected') {
          logger.info(`[chat] MCP server "${mcp.name}" connected (pid=${pid})`)
        } else {
          logger.warn(`[chat] MCP server "${mcp.name}" status=${mcp.status}${mcp.error ? ` error=${mcp.error}` : ''} (pid=${pid})`)
        }
      }
    }
    if (parsed.tools?.length) {
      const mcpTools = parsed.tools.filter(t => t.startsWith('mcp__'))
      logger.info(`[chat] stream-json init: ${parsed.tools.length} tools available, MCP tools: [${mcpTools.join(', ')}] (pid=${pid})`)
    } else {
      logger.info(`[chat] stream-json init received, no tools listed (pid=${pid})`)
    }
  }

  return { newSentTextLength: state.sentTextLength }
}

/**
 * file_upload ツールの結果をパースし、file_attachment チャンク用データを返す
 *
 * MCP ツールの tool_result.content は配列形式: [{type: "text", text: "..."}]
 * 組み込みツールの tool_result.content は文字列形式
 */
export function parseFileUploadResult(content: string | Array<{ type: string; text?: string }> | undefined): {
  fileId: string
  s3Key: string
  filename: string
  contentType: string
  fileSize: number
} | null {
  if (!content) return null

  // content からテキストを抽出
  let textContent: string
  if (typeof content === 'string') {
    textContent = content
  } else if (Array.isArray(content)) {
    // MCP ツール形式: [{type: "text", text: "..."}, ...]
    const textBlock = content.find(b => b.type === 'text' && b.text)
    if (!textBlock?.text) return null
    textContent = textBlock.text
  } else {
    return null
  }

  const data = safeJsonParse<Record<string, unknown>>(textContent)
  if (data?.success && typeof data.fileId === 'string' && typeof data.s3Key === 'string' && typeof data.filename === 'string') {
    return {
      fileId: data.fileId as string,
      s3Key: data.s3Key as string,
      filename: data.filename as string,
      contentType: (data.contentType as string) ?? 'application/octet-stream',
      fileSize: typeof data.fileSize === 'number' ? (data.fileSize as number) : 0,
    }
  }
  return null
}
