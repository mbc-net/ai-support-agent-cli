import { spawn } from 'child_process'
import os from 'os'

import { CHAT_SIGKILL_DELAY, CHAT_TIMEOUT, ERR_CLAUDE_CLI_NOT_FOUND, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType } from '../types'

/** Claude Code CLI の実行結果 */
export interface ClaudeCodeResult {
  text: string
  metadata: {
    args: string[]
    exitCode: number | null
    hasStderr: boolean
    durationMs: number
  }
}

/** CLAUDECODE / CLAUDE_CODE_* 環境変数を除外した env を構築
 *  ただし CLAUDE_CODE_OAUTH_TOKEN は認証に必要なため保持する */
export function buildCleanEnv(): Record<string, string> {
  const cleanEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN')) continue
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
    mcpConfigPath?: string
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
  if (options?.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
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
export async function runClaudeCode(
  message: string,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
  allowedTools?: string[],
  addDirs?: string[],
  locale?: string,
  awsEnv?: Record<string, string>,
  mcpConfigPath?: string,
): Promise<ClaudeCodeResult> {
  return new Promise<ClaudeCodeResult>((resolve, reject) => {
    const startTime = Date.now()
    // claude CLI が利用可能か確認し、print モードで実行
    // Claude Code セッション内からの起動時にネスト検出やSSEポート干渉を回避するため、
    // CLAUDECODE および CLAUDE_CODE_* 環境変数を除外
    const cleanEnv = buildCleanEnv()
    const env = awsEnv ? { ...cleanEnv, ...awsEnv } : cleanEnv
    const args = buildClaudeArgs(message, { allowedTools, addDirs, locale, mcpConfigPath })

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
        reject(new Error(ERR_CLAUDE_CLI_NOT_FOUND))
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
