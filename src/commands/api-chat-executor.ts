import axios from 'axios'

import { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { AgentServerConfig, ChatChunkType, ChatPayload, CommandResult } from '../types'
import { getErrorMessage, parseString } from '../utils'

const DEFAULT_MODEL = 'claude-sonnet-4-6-20250514'

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
    return { success: false, error: 'agentId is required for chat command' }
  }

  const message = parseString(payload.message)
  if (!message) {
    return { success: false, error: 'message is required' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      success: false,
      error: 'ANTHROPIC_API_KEY is not set. API chat mode requires an Anthropic API key.',
    }
  }

  logger.info(
    `[api-chat] Starting API chat command [${commandId}]: message="${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`,
  )

  let chunkIndex = 0

  const sendChunk = async (
    type: ChatChunkType,
    content: string,
  ): Promise<void> => {
    try {
      await client.submitChatChunk(commandId, {
        index: chunkIndex++,
        type,
        content,
      }, agentId)
    } catch (error) {
      logger.warn(
        `[api-chat] Failed to send chunk #${chunkIndex - 1}: ${getErrorMessage(error)}`,
      )
    }
  }

  try {
    const model = config?.claudeCodeConfig?.model ?? DEFAULT_MODEL
    const maxTokens = config?.claudeCodeConfig?.maxTokens ?? 4096
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
      `[api-chat] API chat command completed [${commandId}]: output=${result.length} chars, ${chunkIndex} chunks sent`,
    )
    await sendChunk('done', result)
    return { success: true, data: result }
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
): Promise<string> {
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
    'https://api.anthropic.com/v1/messages',
    body,
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      responseType: 'stream',
      timeout: 120_000,
    },
  )

  return new Promise<string>((resolve, reject) => {
    let fullOutput = ''
    let buffer = ''

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
          if (event.type === 'content_block_delta') {
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
      resolve(fullOutput)
    })

    stream.on('error', (error: Error) => {
      reject(error)
    })
  })
}
