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
  SSE_DONE,
  SSE_EVENT,
  SSE_PREFIX,
} from '../constants'
import { logger } from '../logger'
import {
  type AgentServerConfig,
  type AnthropicStreamEvent,
  type ApiChatResult,
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

import { cancelProcess, getProcessManager, _getRunningProcesses } from './process-manager'
import { createChunkSender, handleChatError, parseHistory, sendDoneChunk } from './shared-chat-utils'

/** 実行中の API チャットを commandId で管理（chat-executor と共有シングルトン） */
const processManager = getProcessManager()

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
 */
export async function executeApiChatCommand(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  config?: AgentServerConfig,
  agentId?: string,
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

  const { sendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'api-chat')

  try {
    const model = config?.claudeCodeConfig?.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxTokens = config?.claudeCodeConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
    const systemPrompt = config?.claudeCodeConfig?.systemPrompt

    const historyMessages = parseHistory(payload.history)

    const abortController = new AbortController()
    processManager.register(commandId, { cancel: () => abortController.abort() })

    let result: ApiChatResult
    try {
      result = await callAnthropicApi(
        apiKey,
        message,
        model,
        maxTokens,
        systemPrompt,
        sendChunk,
        historyMessages,
        abortController.signal,
      )
    } finally {
      processManager.remove(commandId)
    }

    logger.info(
      `[api-chat] API chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
    )

    // done チャンクに usage 情報を含める
    await sendDoneChunk(sendChunk, {
      text: result.text,
      usage: {
        totalInputTokens: result.usage.inputTokens,
        totalOutputTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      },
    })
    return successResult(result.text)
  } catch (error) {
    return handleChatError(error, commandId, 'api-chat', sendChunk)
  }
}

/**
 * Anthropic Messages API を呼び出し、ストリーミングレスポンスを処理する
 */
async function callAnthropicApi(
  apiKey: string,
  message: string,
  model: string,
  maxTokens: number,
  systemPrompt: string | undefined,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  history?: HistoryMessage[],
  abortSignal?: AbortSignal,
): Promise<ApiChatResult> {
  const messages = [
    ...(history ?? []).map((msg) => ({
      role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: msg.content,
    })),
    { role: 'user' as const, content: message },
  ]
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages,
  }
  if (systemPrompt) {
    body.system = systemPrompt
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

  return new Promise<ApiChatResult>((resolve, reject) => {
    let fullOutput = ''
    const usage: ApiUsage = { inputTokens: 0, outputTokens: 0 }

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
          // message_delta イベントから output_tokens を取得
          const outputTokens = event.usage?.output_tokens
          if (typeof outputTokens === 'number') {
            usage.outputTokens = outputTokens
          }
        } else if (event.type === SSE_EVENT.CONTENT_BLOCK_DELTA) {
          const delta = event.delta
          if (delta?.type === ANTHROPIC_CONTENT_TYPE.TEXT_DELTA && typeof delta.text === 'string') {
            fullOutput += delta.text
            void sendChunk('delta', delta.text)
          }
        } else if (event.type === SSE_EVENT.CONTENT_BLOCK_START) {
          const contentBlock = event.content_block
          if (contentBlock?.type === ANTHROPIC_CONTENT_TYPE.TOOL_USE) {
            const toolName = contentBlock.name ?? 'unknown'
            logger.info(`[api-chat] Tool use requested: ${toolName} (not supported in API mode)`)
            void sendChunk('delta', `\n[Tool call: ${toolName} — tool use is not supported in API chat mode]\n`)
          }
        }
      })
    })

    stream.on('end', () => {
      activityTimeout.clear()
      resolve({ text: fullOutput, usage })
    })

    stream.on('error', (error: Error) => {
      activityTimeout.clear()
      reject(error)
    })
  })
}
