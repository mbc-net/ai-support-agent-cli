import { spawn } from 'child_process'
import os from 'os'

import { ApiClient } from '../api-client'
import { CHAT_SIGKILL_DELAY, CHAT_TIMEOUT, ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED, LOG_DEBUG_LIMIT, LOG_MESSAGE_LIMIT } from '../constants'
import { logger } from '../logger'
import type { AgentChatMode, AgentServerConfig, ChatChunkType, ChatPayload, CommandResult } from '../types'
import { getErrorMessage, parseString, truncateString } from '../utils'

import { executeApiChatCommand } from './api-chat-executor'
import { createChunkSender } from './shared-chat-utils'

/** Claude Code CLI の実行結果 */
interface ClaudeCodeResult {
  text: string
  metadata: {
    args: string[]
    exitCode: number | null
    hasStderr: boolean
    durationMs: number
  }
}

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
    return { success: false, error: ERR_AGENT_ID_REQUIRED }
  }

  const mode = activeChatMode ?? 'claude_code'

  switch (mode) {
    case 'api':
      return executeApiChatCommand(payload, commandId, client, serverConfig, agentId)
    case 'claude_code':
    default:
      return executeClaudeCodeChat(payload, commandId, client, agentId, serverConfig)
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
  serverConfig?: AgentServerConfig,
): Promise<CommandResult> {
  const message = parseString(payload.message)
  if (!message) {
    return { success: false, error: ERR_MESSAGE_REQUIRED }
  }

  logger.info(`[chat] Starting chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`)

  const { sendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'chat', { debugLog: true })

  try {
    const allowedTools = serverConfig?.claudeCodeConfig?.allowedTools
    const addDirs = serverConfig?.claudeCodeConfig?.addDirs
    const locale = parseString(payload.locale) ?? undefined

    // AWS認証情報をJust-In-Timeで取得
    const awsAccountId = parseString(payload.awsAccountId) ?? undefined
    let awsEnv: Record<string, string> | undefined
    if (awsAccountId) {
      try {
        logger.info(`[chat] Fetching AWS credentials for account: ${awsAccountId}`)
        const creds = await client.getAwsCredentials(awsAccountId)
        awsEnv = {
          AWS_ACCESS_KEY_ID: creds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
          AWS_DEFAULT_REGION: creds.region,
          ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
        }
        logger.info(`[chat] AWS credentials obtained for region=${creds.region}`)
      } catch (error) {
        logger.warn(`[chat] Failed to get AWS credentials: ${getErrorMessage(error)}`)
      }
    }

    logger.debug(`[chat] Spawning claude CLI for command [${commandId}]${allowedTools?.length ? ` with allowedTools: ${allowedTools.join(', ')}` : ' (no allowedTools)'}${addDirs?.length ? ` with addDirs: ${addDirs.join(', ')}` : ''}${locale ? ` locale=${locale}` : ''}${awsEnv ? ' with AWS credentials' : ''}`)
    logger.debug(`[chat] serverConfig.claudeCodeConfig: ${JSON.stringify(serverConfig?.claudeCodeConfig ?? null)}`)
    const result = await runClaudeCode(message, sendChunk, allowedTools, addDirs, locale, awsEnv)
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, duration=${result.metadata.durationMs}ms`)
    // 完了チャンクを送信（metadata を含める）
    const doneContent = JSON.stringify({
      text: result.text,
      metadata: result.metadata,
    })
    await sendChunk('done', doneContent)
    return { success: true, data: result.text }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    logger.error(`[chat] Chat command failed [${commandId}]: ${errorMessage}`)
    await sendChunk('error', errorMessage)
    return { success: false, error: errorMessage }
  }
}

/** CLAUDECODE / CLAUDE_CODE_* 環境変数を除外した env を構築 */
export function buildCleanEnv(): Record<string, string> {
  const cleanEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue
    if (value !== undefined) cleanEnv[key] = value
  }
  return cleanEnv
}

/** Claude CLI の引数配列を構築 */
export function buildClaudeArgs(
  message: string,
  options?: {
    allowedTools?: string[]
    addDirs?: string[]
    locale?: string
  },
): string[] {
  const args = ['-p']
  if (options?.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push('--allowedTools', tool)
    }
  }
  if (options?.addDirs?.length) {
    for (const dir of options.addDirs) {
      const resolved = dir.replace(/^~/, os.homedir())
      args.push('--add-dir', resolved)
    }
  }
  if (options?.locale) {
    const langPrompt = options.locale === 'ja'
      ? 'Always respond in Japanese. Use Japanese for all explanations and communications.'
      : 'Always respond in English. Use English for all explanations and communications.'
    args.push('--append-system-prompt', langPrompt)
  }
  args.push(message)
  return args
}

/**
 * Claude Code CLI をサブプロセスとして実行し、出力をストリーミングで返す
 */
async function runClaudeCode(
  message: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  allowedTools?: string[],
  addDirs?: string[],
  locale?: string,
  awsEnv?: Record<string, string>,
): Promise<ClaudeCodeResult> {
  return new Promise<ClaudeCodeResult>((resolve, reject) => {
    const startTime = Date.now()
    // claude CLI が利用可能か確認し、print モードで実行
    // Claude Code セッション内からの起動時にネスト検出やSSEポート干渉を回避するため、
    // CLAUDECODE および CLAUDE_CODE_* 環境変数を除外
    const cleanEnv = buildCleanEnv()
    const env = awsEnv ? { ...cleanEnv, ...awsEnv } : cleanEnv
    const args = buildClaudeArgs(message, { allowedTools, addDirs, locale })

    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    logger.debug(`[chat] claude CLI spawned (pid=${child.pid}, cmd=claude ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')})`)

    let fullOutput = ''
    let stderrOutput = ''

    // タイムアウト: 120秒で応答がなければ強制終了
    let sigkillTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      logger.warn(`[chat] claude CLI timed out after ${CHAT_TIMEOUT / 1000}s (pid=${child.pid}), sending SIGTERM`)
      child.kill('SIGTERM')
      // SIGTERM後5秒で応答なければSIGKILL
      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] claude CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, CHAT_SIGKILL_DELAY)
    }, CHAT_TIMEOUT)

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      fullOutput += text
      // delta チャンクとしてAPIに送信（fire-and-forget）
      void sendChunk('delta', text)
    })

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrOutput += text
      logger.debug(`[chat] claude CLI stderr: ${text.substring(0, LOG_DEBUG_LIMIT)}`)
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
      const durationMs = Date.now() - startTime
      // メッセージ本文を除いた引数（監査用）
      const metadataArgs = args.slice(0, -1)
      logger.debug(`[chat] claude CLI exited (pid=${child.pid}, code=${code}, stdout=${fullOutput.length}b, stderr=${stderrOutput.length}b, duration=${durationMs}ms)`)
      if (code === 0) {
        resolve({
          text: fullOutput,
          metadata: {
            args: metadataArgs,
            exitCode: code,
            hasStderr: stderrOutput.length > 0,
            durationMs,
          },
        })
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
