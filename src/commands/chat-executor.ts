import { spawn } from 'child_process'

import { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { AgentChatMode, AgentServerConfig, ChatChunkType, ChatPayload, CommandResult } from '../types'
import { getErrorMessage, parseString } from '../utils'

import { executeApiChatCommand } from './api-chat-executor'

/**
 * エージェントチャットモードに応じてチャットメッセージを処理する
 * - claude_code: Claude Code CLI を使用（デフォルト）
 * - api: Anthropic API 直接呼び出し
 *
 * activeChatMode はサーバーの chatMode ではなく、エージェント内部の実行方式を指す
 */
export async function executeChatCommand(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  serverConfig?: AgentServerConfig,
  activeChatMode?: AgentChatMode,
  agentId?: string,
): Promise<CommandResult> {
  if (!agentId) {
    return { success: false, error: 'agentId is required for chat command' }
  }

  const mode = activeChatMode ?? 'claude_code'

  switch (mode) {
    case 'api':
      return executeApiChatCommand(payload, commandId, client, serverConfig, agentId)
    case 'claude_code':
    default:
      return executeClaudeCodeChat(payload, commandId, client, agentId)
  }
}

/**
 * Claude Code CLI を使用してチャットメッセージを処理する
 * サブプロセスとして起動し、stdout をストリーミングで読み取り、
 * チャンクとしてAPIに送信する
 */
async function executeClaudeCodeChat(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  agentId: string,
): Promise<CommandResult> {
  const message = parseString(payload.message)
  if (!message) {
    return { success: false, error: 'message is required' }
  }

  logger.info(`[chat] Starting chat command [${commandId}]: message="${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`)

  let chunkIndex = 0

  const sendChunk = async (
    type: ChatChunkType,
    content: string,
  ): Promise<void> => {
    try {
      logger.debug(`[chat] Sending chunk #${chunkIndex} (${type}) [${commandId}]: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`)
      await client.submitChatChunk(commandId, {
        index: chunkIndex++,
        type,
        content,
      }, agentId)
    } catch (error) {
      logger.warn(`[chat] Failed to send chunk #${chunkIndex - 1}: ${getErrorMessage(error)}`)
    }
  }

  try {
    logger.debug(`[chat] Spawning claude CLI for command [${commandId}]`)
    const result = await runClaudeCode(message, sendChunk)
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.length} chars, ${chunkIndex} chunks sent`)
    // 完了チャンクを送信
    await sendChunk('done', result)
    return { success: true, data: result }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    logger.error(`[chat] Chat command failed [${commandId}]: ${errorMessage}`)
    await sendChunk('error', errorMessage)
    return { success: false, error: errorMessage }
  }
}

/**
 * Claude Code CLI をサブプロセスとして実行し、出力をストリーミングで返す
 */
async function runClaudeCode(
  message: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // claude CLI が利用可能か確認し、print モードで実行
    // Claude Code セッション内からの起動時にネスト検出やSSEポート干渉を回避するため、
    // CLAUDECODE および CLAUDE_CODE_* 環境変数を除外
    const cleanEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue
      if (value !== undefined) cleanEnv[key] = value
    }
    const child = spawn('claude', ['-p', message], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv,
    })

    logger.debug(`[chat] claude CLI spawned (pid=${child.pid}, CLAUDECODE removed=${!cleanEnv['CLAUDECODE']})`)

    let fullOutput = ''
    let stderrOutput = ''

    // タイムアウト: 120秒で応答がなければ強制終了
    let sigkillTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      logger.warn(`[chat] claude CLI timed out after 120s (pid=${child.pid}), sending SIGTERM`)
      child.kill('SIGTERM')
      // SIGTERM後5秒で応答なければSIGKILL
      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] claude CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, 5_000)
    }, 120_000)

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      fullOutput += text
      // delta チャンクとしてAPIに送信（fire-and-forget）
      void sendChunk('delta', text)
    })

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrOutput += text
      logger.debug(`[chat] claude CLI stderr: ${text.substring(0, 200)}`)
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            'claude CLI が見つかりません。Claude Code がインストールされていることを確認してください。',
          ),
        )
      } else {
        reject(error)
      }
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      logger.debug(`[chat] claude CLI exited (pid=${child.pid}, code=${code}, stdout=${fullOutput.length}b, stderr=${stderrOutput.length}b)`)
      if (code === 0) {
        resolve(fullOutput)
      } else {
        reject(
          new Error(
            `claude CLI がコード ${code} で終了しました${stderrOutput ? `: ${stderrOutput}` : ''}`,
          ),
        )
      }
    })
  })
}
