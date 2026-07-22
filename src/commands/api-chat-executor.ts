import { Readable } from 'stream'

import axios from 'axios'

import { ApiClient } from '../api-client'
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_CONTENT_TYPE,
  CHAT_TIMEOUT,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  ERR_AGENT_ID_REQUIRED,
  ERR_ANTHROPIC_API_KEY_NOT_SET,
  ERR_MESSAGE_REQUIRED,
  LOG_MESSAGE_LIMIT,
  MAX_TOOL_TURNS,
  SSE_DONE,
  SSE_EVENT,
  SSE_PREFIX,
} from '../constants'
import { logger } from '../logger'
import { getAutoAddDirs } from '../project-dir'
import {
  type AgentServerConfig,
  type AnthropicRequestContentBlock,
  type AnthropicRequestMessage,
  type AnthropicStreamEvent,
  type AnthropicToolResultBlock,
  type AnthropicToolSchema,
  type AnthropicToolUseRequest,
  type ApiUsage,
  type ChatChunkType,
  type ChatPayload,
  type CommandResult,
  errorResult,
  type HistoryMessage,
  successResult,
} from '../types'
import { parseString, truncateString } from '../utils'
import { createActivityTimeout } from '../utils/activity-timeout'
import { safeJsonParse } from '../utils/json-parse'
import { StreamLineParser } from '../utils/stream-parser'

import { buildReadOnlyToolSchemas, executeReadOnlyTool } from './api-tool-executor'
import { cancelProcess, getProcessManager, _getRunningProcesses } from './process-manager'
import { createChunkSender, handleChatError, isSlackMarketplaceCommand, parseHistory, resolveChunkBatchConfig, sendDoneChunk } from './shared-chat-utils'

/** 実行中の API チャットを commandId で管理（chat-executor と共有シングルトン） */
const processManager = getProcessManager()

/** executeApiChatCommand の呼び出し元 (chat-executor.ts) から渡す追加コンテキスト */
export interface ApiChatToolContext {
  /** Slack Marketplace の読み取り専用ツールをサンドボックス化する際の addDir 解決に使う */
  projectDir?: string
  tenantCode?: string
}

/**
 * 実行中の API チャットプロセスをキャンセルする
 * @deprecated Use {@link cancelProcess} from './process-manager' instead.
 * Both chat-executor and api-chat-executor share the same ProcessManager singleton.
 * @returns true: プロセスが見つかりキャンセルした, false: プロセスが見つからなかった
 */
export function cancelApiChatProcess(commandId: string): boolean {
  return cancelProcess(commandId)
}

/**
 * テスト用: runningApiChats の内容を取得
 * @deprecated Use {@link _getRunningProcesses} from './process-manager' instead.
 */
export function _getRunningApiChats(): Map<string, { cancel: () => void }> {
  return _getRunningProcesses()
}

/**
 * Anthropic API を直接呼び出してチャットメッセージを処理する
 * エージェントが持つ ANTHROPIC_API_KEY で Claude を呼び出す
 *
 * 注意: Web で設定された `projectConfig.envVars`（CLAUDE_CODE#API_KEY 等）は
 * 現状この経路では参照されない。`claude_code` モード（spawn 経由）のみ
 * Web 設定の env オーバーライドが有効。API モードでの per-project キー切替
 * 対応は別タスクで実装予定。
 *
 * tool-use: Slack Marketplace 起点（`interactionOrigin: 'slack'` かつ
 * `toolPolicy: 'marketplace_read_only'`）のコマンドに限り、読み取り専用ツール
 * （Read/Grep/Glob、`api-tool-executor.ts`）を `tools` として構築し、
 * `stop_reason: 'tool_use'` が続く限り Anthropic API 呼び出し（モデルとの
 * やり取り）を最大 MAX_TOOL_TURNS 回まで行う。MAX_TOOL_TURNS 回目の呼び出しで
 * tool_use が要求された場合はそのツールを実行せずに打ち切るため、実際のツール
 * 実行往復は最大 MAX_TOOL_TURNS - 1 回にとどまる。
 * それ以外（通常の api モード）は従来どおり `tools` を送らず、tool_use が来ても
 * 「サポートされていない」旨の delta 通知のみ返す（非対応のまま・スコープ外）。
 */
export async function executeApiChatCommand(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  config?: AgentServerConfig,
  agentId?: string,
  toolContext?: ApiChatToolContext,
): Promise<CommandResult> {
  if (!agentId) {
    return errorResult(ERR_AGENT_ID_REQUIRED)
  }

  const message = parseString(payload.message)
  if (!message) {
    return errorResult(ERR_MESSAGE_REQUIRED)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return errorResult(ERR_ANTHROPIC_API_KEY_NOT_SET)
  }

  logger.info(
    `[api-chat] Starting API chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`,
  )

  const { sendChunk, getChunkIndex, flush } = createChunkSender(commandId, client, agentId, 'api-chat', { batch: resolveChunkBatchConfig() })

  try {
    const model = config?.claudeCodeConfig?.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxTokens = config?.claudeCodeConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
    const systemPrompt = config?.claudeCodeConfig?.systemPrompt

    const historyMessages = parseHistory(payload.history)

    // 確定方針5: apiモードのtool-useはSlack Marketplace（読み取り専用ポリシー）の
    // 場合のみ有効化する。通常の api モード（非Slack）は対象外・従来どおり。
    const slackMarketplace = isSlackMarketplaceCommand(payload)
    const tools = slackMarketplace ? buildReadOnlyToolSchemas() : undefined
    // 確定方針3: サンドボックスは workspace/repos と workspace/docs のみ
    // （getAutoAddDirs の既存挙動）。server 由来の addDirs は含めない。
    const sandboxRoots = slackMarketplace && toolContext?.projectDir
      ? getAutoAddDirs(toolContext.projectDir)
      : []

    const messages: AnthropicRequestMessage[] = [
      ...historyMessages.map((msg) => toRequestMessage(msg)),
      { role: 'user', content: message },
    ]

    const abortController = new AbortController()
    processManager.register(commandId, { cancel: () => abortController.abort() })

    let fullText = ''
    const totalUsage: ApiUsage = { inputTokens: 0, outputTokens: 0 }
    let toolTurnsTruncated = false

    try {
      for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
        const turnResult = await streamAnthropicMessage(
          apiKey,
          messages,
          model,
          maxTokens,
          systemPrompt,
          tools,
          sendChunk,
          abortController.signal,
          /* legacyToolUseNotice */ !tools,
        )
        totalUsage.inputTokens += turnResult.usage.inputTokens
        totalUsage.outputTokens += turnResult.usage.outputTokens
        fullText += turnResult.text

        const wantsToolExecution = Boolean(tools) && turnResult.stopReason === 'tool_use' && turnResult.toolUses.length > 0
        if (!wantsToolExecution) break

        if (turn >= MAX_TOOL_TURNS) {
          toolTurnsTruncated = true
          // turn はここでは MAX_TOOL_TURNS 回目の「モデルとのやり取り（API 呼び出し）」を
          // 指す。このターンで要求された tool_use は実行せずに打ち切るため、実際の
          // ツール実行往復は MAX_TOOL_TURNS - 1 回にとどまる。
          logger.warn(`[api-chat] Reached the model turn limit [${commandId}]: stopping after ${MAX_TOOL_TURNS} turns without executing this turn's tool call`)
          await sendChunk('delta', `\n[モデルとのやり取り回数の上限（${MAX_TOOL_TURNS}回）に達したため、これ以上のツール呼び出しを中断しました]\n`)
          break
        }

        messages.push({ role: 'assistant', content: turnResult.contentBlocks })
        messages.push({ role: 'user', content: await runToolTurn(turnResult.toolUses, sandboxRoots, commandId, sendChunk, abortController.signal) })
      }
    } finally {
      processManager.remove(commandId)
    }

    // バッファ中の delta を確定送信してから完了ログを出す（chunk 数を正確に集計するため）。
    await flush()
    logger.info(
      `[api-chat] API chat command completed [${commandId}]: output=${fullText.length} chars, ${getChunkIndex()} chunks sent, tokens: in=${totalUsage.inputTokens} out=${totalUsage.outputTokens}`,
    )

    // done チャンクに usage 情報を含める
    await sendDoneChunk(sendChunk, {
      text: fullText,
      usage: {
        totalInputTokens: totalUsage.inputTokens,
        totalOutputTokens: totalUsage.outputTokens,
        totalTokens: totalUsage.inputTokens + totalUsage.outputTokens,
      },
      ...(toolTurnsTruncated ? { toolTurnsTruncated: true } : {}),
    })
    return successResult(fullText)
  } catch (error) {
    return handleChatError(error, commandId, 'api-chat', sendChunk)
  }
}

function toRequestMessage(msg: HistoryMessage): AnthropicRequestMessage {
  return {
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content,
  }
}

/**
 * 1ターン分の tool_use 要求をすべて実行し、tool_call/tool_result チャンクを
 * claude_code 経路（`claude-code-stream.ts`）と同じ形式で送出しつつ、
 * 次のリクエストに積む tool_result コンテンツブロック配列を返す。
 *
 * `abortSignal` はユーザーによるチャットキャンセルを Grep/Glob のツール実行中にも
 * 効かせるために渡す（Worker タイムアウトは構造的な上限を提供するが、それとは別に
 * 能動的キャンセルにも即座に応答する必要があるため）。
 */
async function runToolTurn(
  toolUses: AnthropicToolUseRequest[],
  sandboxRoots: string[],
  commandId: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  abortSignal: AbortSignal,
): Promise<AnthropicToolResultBlock[]> {
  const toolResultBlocks: AnthropicToolResultBlock[] = []
  for (const toolUse of toolUses) {
    await sendChunk('tool_call', JSON.stringify({
      toolName: toolUse.name,
      name: toolUse.name,
      id: toolUse.id,
      input: toolUse.input,
    }))
    const outcome = await executeReadOnlyTool(toolUse.name, toolUse.input, sandboxRoots, abortSignal)
    logger.info(`[api-chat] tool_result: ${toolUse.name} success=${!outcome.isError} [${commandId}]`)
    await sendChunk('tool_result', JSON.stringify({
      toolName: toolUse.name,
      success: !outcome.isError,
      output: safeJsonParse<Record<string, unknown>>(outcome.output) ?? { text: outcome.output },
    }))
    toolResultBlocks.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: outcome.output,
      ...(outcome.isError ? { is_error: true } : {}),
    })
  }
  return toolResultBlocks
}

/** streamAnthropicMessage の戻り値: 1リクエスト（1ターン）分のストリーム結果 */
interface AnthropicTurnResult {
  text: string
  usage: ApiUsage
  stopReason: string | null
  /** 次のリクエストの assistant メッセージとして積む、このターンの content ブロック */
  contentBlocks: AnthropicRequestContentBlock[]
  /** このターンで要求された tool_use（実行対象） */
  toolUses: AnthropicToolUseRequest[]
}

/** ストリーム中に組み立て中の content ブロックの状態 */
interface AssembledBlockState {
  index: number
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  /** tool_use の input（JSON文字列を input_json_delta で逐次連結したもの） */
  inputJson?: string
}

/**
 * Anthropic Messages API を1回呼び出し、ストリーミングレスポンスを処理する。
 * tool_use ブロック（content_block_start + input_json_delta）の組み立てと
 * message_delta.stop_reason の捕捉を行い、呼び出し元（tool-use往復ループ）が
 * 次のターンへ進むかどうかを判断できるようにする。
 *
 * `legacyToolUseNotice` が true の場合（tools 未構築 = 通常 api モード）は、
 * tool_use ブロックを検出した時点で「サポートされていない」旨の delta を
 * その場で送信する（従来の非対応挙動を維持。呼び出し元はこの結果の
 * toolUses/stopReason を無視し、1ターンで打ち切る）。
 */
async function streamAnthropicMessage(
  apiKey: string,
  messages: AnthropicRequestMessage[],
  model: string,
  maxTokens: number,
  systemPrompt: string | undefined,
  tools: AnthropicToolSchema[] | undefined,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  abortSignal: AbortSignal,
  legacyToolUseNotice: boolean,
): Promise<AnthropicTurnResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages,
  }
  if (systemPrompt) {
    body.system = systemPrompt
  }
  if (tools) {
    body.tools = tools
  }

  const response = await axios.post(
    ANTHROPIC_API_URL,
    body,
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      responseType: 'stream',
      timeout: CHAT_TIMEOUT,
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  )

  return new Promise<AnthropicTurnResult>((resolve, reject) => {
    let fullOutput = ''
    const usage: ApiUsage = { inputTokens: 0, outputTokens: 0 }
    let stopReason: string | null = null
    const blocks = new Map<number, AssembledBlockState>()
    let blockCounter = 0

    const stream = response.data as Readable
    const lineParser = new StreamLineParser()

    // アクティビティベースタイムアウト: ストリームデータ受信が途絶えたら中止
    const activityTimeout = createActivityTimeout(CHAT_TIMEOUT, () => {
      logger.warn(`[api-chat] Stream timed out after ${CHAT_TIMEOUT / 1000}s of inactivity`)
      stream.destroy(new Error(`Stream timed out after ${CHAT_TIMEOUT / 1000}s of inactivity`))
    })

    stream.on('data', (chunk: Buffer) => {
      activityTimeout.reset()
      // SSE lines use \n as line separator; StreamLineParser handles buffering
      // but SSE format needs special handling: lines start with "data: "
      // We parse manually since SSE lines may contain empty lines as delimiters
      lineParser.push(chunk.toString(), (line) => {
        if (!line.startsWith(SSE_PREFIX)) return
        const data = line.slice(SSE_PREFIX.length).trim()
        if (data === SSE_DONE) return

        const event = safeJsonParse<AnthropicStreamEvent>(data)
        if (!event) return

        if (event.type === SSE_EVENT.MESSAGE_START) {
          // message_start イベントから input_tokens を取得
          const inputTokens = event.message?.usage?.input_tokens
          if (typeof inputTokens === 'number') {
            usage.inputTokens = inputTokens
          }
        } else if (event.type === SSE_EVENT.MESSAGE_DELTA) {
          // message_delta イベントから output_tokens と stop_reason を取得
          const outputTokens = event.usage?.output_tokens
          if (typeof outputTokens === 'number') {
            usage.outputTokens = outputTokens
          }
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason
          }
        } else if (event.type === SSE_EVENT.CONTENT_BLOCK_START) {
          const idx = typeof event.index === 'number' ? event.index : blockCounter
          blockCounter = Math.max(blockCounter, idx + 1)
          const contentBlock = event.content_block
          if (contentBlock?.type === ANTHROPIC_CONTENT_TYPE.TOOL_USE) {
            const toolName = contentBlock.name ?? 'unknown'
            blocks.set(idx, { index: idx, type: 'tool_use', id: contentBlock.id, name: contentBlock.name, inputJson: '' })
            if (legacyToolUseNotice) {
              logger.info(`[api-chat] Tool use requested: ${toolName} (not supported in API mode)`)
              void sendChunk('delta', `\n[Tool call: ${toolName} — tool use is not supported in API chat mode]\n`)
            }
          } else if (contentBlock) {
            blocks.set(idx, { index: idx, type: 'text', text: '' })
          }
        } else if (event.type === SSE_EVENT.CONTENT_BLOCK_DELTA) {
          const idx = typeof event.index === 'number' ? event.index : Math.max(blockCounter - 1, 0)
          const delta = event.delta
          if (delta?.type === ANTHROPIC_CONTENT_TYPE.TEXT_DELTA && typeof delta.text === 'string') {
            fullOutput += delta.text
            void sendChunk('delta', delta.text)
            const block = blocks.get(idx)
            if (block) {
              block.text = (block.text ?? '') + delta.text
            } else {
              blocks.set(idx, { index: idx, type: 'text', text: delta.text })
            }
          } else if (delta?.type === ANTHROPIC_CONTENT_TYPE.INPUT_JSON_DELTA && typeof delta.partial_json === 'string') {
            const block = blocks.get(idx)
            if (block && block.type === 'tool_use') {
              block.inputJson = (block.inputJson ?? '') + delta.partial_json
            }
          }
        }
      })
    })

    stream.on('end', () => {
      activityTimeout.clear()
      const { contentBlocks, toolUses } = assembleBlocks(blocks)
      resolve({ text: fullOutput, usage, stopReason, contentBlocks, toolUses })
    })

    stream.on('error', (error: Error) => {
      activityTimeout.clear()
      reject(error)
    })
  })
}

function assembleBlocks(
  blocks: Map<number, AssembledBlockState>,
): { contentBlocks: AnthropicRequestContentBlock[]; toolUses: AnthropicToolUseRequest[] } {
  const contentBlocks: AnthropicRequestContentBlock[] = []
  const toolUses: AnthropicToolUseRequest[] = []
  const sortedBlocks = Array.from(blocks.values()).sort((a, b) => a.index - b.index)
  for (const block of sortedBlocks) {
    if (block.type === 'text') {
      if (block.text) {
        contentBlocks.push({ type: 'text', text: block.text })
      }
      continue
    }
    const input = safeJsonParse<Record<string, unknown>>(
      block.inputJson && block.inputJson.length > 0 ? block.inputJson : '{}',
    ) ?? {}
    const id = block.id ?? `toolu_unknown_${block.index}`
    const name = block.name ?? 'unknown'
    contentBlocks.push({ type: 'tool_use', id, name, input })
    toolUses.push({ id, name, input })
  }
  return { contentBlocks, toolUses }
}
