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
import { type AgentServerConfig, type ChatChunkType, type ChatPayload, type CommandResult, errorResult, type HistoryMessage, successResult } from '../types'
import { parseString, truncateString } from '../utils'

import { createChunkSender, handleChatError, parseHistory } from './shared-chat-utils'

/** Anthropic API のトークン使用量 */
interface ApiUsage {
  inputTokens: number
  outputTokens: number
}

/** callAnthropicApi の戻り値 */
interface ApiChatResult {
  text: string
  usage: ApiUsage
}

/** Anthropic SSE ストリーミングイベント型 */
interface AnthropicMessageStartEvent {
  type: 'message_start'
  message?: { usage?: { input_tokens?: number } }
}

interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  usage?: { output_tokens?: number }
}

interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  delta?: { type: string; text?: string }
}

interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  content_block?: { type: string; name?: string }
}

type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicMessageDeltaEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStartEvent

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

    const result = await callAnthropicApi(
      apiKey,
      message,
      model,
      maxTokens,
      systemPrompt,
      sendChunk,
      historyMessages,
    )

    logger.info(
      `[api-chat] API chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, tokens: in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
    )

    // done チャンクに usage 情報を含める
    const doneContent = JSON.stringify({
      text: result.text,
      usage: {
        totalInputTokens: result.usage.inputTokens,
        totalOutputTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      },
    })
    await sendChunk('done', doneContent)
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
    },
  )

  return new Promise<ApiChatResult>((resolve, reject) => {
    let fullOutput = ''
    let buffer = ''
    const usage: ApiUsage = { inputTokens: 0, outputTokens: 0 }

    const stream = response.data as Readable

    // アクティビティベースタイムアウト: ストリームデータ受信が途絶えたら中止
    let activityTimer: NodeJS.Timeout | undefined
    const resetActivityTimer = () => {
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = setTimeout(() => {
        logger.warn(`[api-chat] Stream timed out after ${CHAT_TIMEOUT / 1000}s of inactivity`)
        stream.destroy(new Error(`Stream timed out after ${CHAT_TIMEOUT / 1000}s of inactivity`))
      }, CHAT_TIMEOUT)
    }
    resetActivityTimer()

    stream.on('data', (chunk: Buffer) => {
      resetActivityTimer()
      buffer += chunk.toString()

      const lines = buffer.split('\n')
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith(SSE_PREFIX)) continue
        const data = line.slice(SSE_PREFIX.length).trim()
        if (data === SSE_DONE) continue

        try {
          const event = JSON.parse(data) as AnthropicStreamEvent
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
        } catch {
          // Skip non-JSON lines
        }
      }
    })

    stream.on('end', () => {
      if (activityTimer) clearTimeout(activityTimer)
      resolve({ text: fullOutput, usage })
    })

    stream.on('error', (error: Error) => {
      if (activityTimer) clearTimeout(activityTimer)
      reject(error)
    })
  })
}
