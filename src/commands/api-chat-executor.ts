import axios from 'axios'

import { ApiClient } from '../api-client'
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_API_VERSION,
  CHAT_TIMEOUT,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  ERR_AGENT_ID_REQUIRED,
  ERR_ANTHROPIC_API_KEY_NOT_SET,
  ERR_MESSAGE_REQUIRED,
  LOG_MESSAGE_LIMIT,
} from '../constants'
import { logger } from '../logger'
import type { AgentServerConfig, ChatChunkType, ChatPayload, CommandResult } from '../types'
import { getErrorMessage, parseString, truncateString } from '../utils'

import { createChunkSender } from './shared-chat-utils'

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
    return { success: false, error: ERR_AGENT_ID_REQUIRED }
  }

  const message = parseString(payload.message)
  if (!message) {
    return { success: false, error: ERR_MESSAGE_REQUIRED }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      success: false,
      error: ERR_ANTHROPIC_API_KEY_NOT_SET,
    }
  }

  logger.info(
    `[api-chat] Starting API chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`,
  )

  const { sendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'api-chat')

  try {
    const model = config?.claudeCodeConfig?.model ?? DEFAULT_ANTHROPIC_MODEL
    const maxTokens = config?.claudeCodeConfig?.maxTokens ?? DEFAULT_MAX_TOKENS
    const systemPrompt = config?.claudeCodeConfig?.systemPrompt

    const result = await callAnthropicApi(
      apiKey,
      message,
      model,
      maxTokens,
      systemPrompt,
      sendChunk,
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
    return { success: true, data: result.text }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    logger.error(`[api-chat] API chat command failed [${commandId}]: ${errorMessage}`)
    await sendChunk('error', errorMessage)
    return { success: false, error: errorMessage }
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
): Promise<ApiChatResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content: message }],
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

    const stream = response.data as NodeJS.ReadableStream

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      const lines = buffer.split('\n')
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        try {
          const event = JSON.parse(data) as Record<string, unknown>
          if (event.type === 'message_start') {
            // message_start イベントから input_tokens を取得
            const msg = event.message as Record<string, unknown> | undefined
            const msgUsage = msg?.usage as Record<string, unknown> | undefined
            if (typeof msgUsage?.input_tokens === 'number') {
              usage.inputTokens = msgUsage.input_tokens
            }
          } else if (event.type === 'message_delta') {
            // message_delta イベントから output_tokens を取得
            const deltaUsage = event.usage as Record<string, unknown> | undefined
            if (typeof deltaUsage?.output_tokens === 'number') {
              usage.outputTokens = deltaUsage.output_tokens
            }
          } else if (event.type === 'content_block_delta') {
            const delta = event.delta as Record<string, unknown> | undefined
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              fullOutput += delta.text
              void sendChunk('delta', delta.text)
            }
          } else if (event.type === 'content_block_start') {
            const contentBlock = event.content_block as Record<string, unknown> | undefined
            if (contentBlock?.type === 'tool_use') {
              const toolName = contentBlock.name as string ?? 'unknown'
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
      resolve({ text: fullOutput, usage })
    })

    stream.on('error', (error: Error) => {
      reject(error)
    })
  })
}
