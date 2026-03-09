import { spawn } from 'child_process'

import { CHAT_SIGKILL_DELAY, CHAT_TIMEOUT, ERR_CLAUDE_CLI_NOT_FOUND, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType } from '../types'
import { createActivityTimeout } from '../utils/activity-timeout'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { StreamLineParser } from '../utils/stream-parser'

import { buildClaudeArgs, buildCleanEnv } from './claude-code-args'
import { processStreamJsonLine } from './claude-code-stream'

// Re-export for backward compatibility
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-args'
export { processStreamJsonLine, parseFileUploadResult } from './claude-code-stream'
export type { StreamJsonContentBlock, StreamJsonLine, StreamJsonMcpServer } from './claude-code-stream'

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

/** Claude Code CLI の実行ハンドル（プロセス管理用） */
export interface ClaudeCodeHandle {
  result: Promise<ClaudeCodeResult>
  cancel: () => void
}

/** runClaudeCode のオプション */
export interface RunClaudeCodeOptions {
  message: string
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>
  allowedTools?: string[]
  addDirs?: string[]
  locale?: string
  awsEnv?: Record<string, string>
  mcpConfigPath?: string
  cwd?: string
  systemPrompt?: string
}

/**
 * Claude Code CLI をサブプロセスとして実行し、出力をストリーミングで返す
 * ClaudeCodeHandle を返す: result Promise と kill 関数
 */
export function runClaudeCode(options: RunClaudeCodeOptions): ClaudeCodeHandle {
  const { message, sendChunk, allowedTools, addDirs, locale, awsEnv, mcpConfigPath, cwd, systemPrompt } = options

  let killFn: () => void = () => { /* noop until child is spawned */ }

  const result = new Promise<ClaudeCodeResult>((resolve, reject) => {
    const startTime = Date.now()
    // claude CLI が利用可能か確認し、print モードで実行
    // Claude Code セッション内からの起動時にネスト検出やSSEポート干渉を回避するため、
    // CLAUDECODE および CLAUDE_CODE_* 環境変数を除外
    const cleanEnv = buildCleanEnv()
    const env = awsEnv ? { ...cleanEnv, ...awsEnv } : cleanEnv
    const args = buildClaudeArgs(message, { allowedTools, addDirs, locale, mcpConfigPath, systemPrompt })

    ensureClaudeJsonIntegrity()

    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(cwd ? { cwd } : {}),
    })

    logger.debug(`[chat] claude CLI spawned (pid=${child.pid}, cmd=claude ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')})`)

    // kill 関数を設定: SIGTERM → SIGKILL パターン
    killFn = () => {
      if (child.killed) return
      logger.info(`[chat] Killing claude CLI process (pid=${child.pid})`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] claude CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, CHAT_SIGKILL_DELAY)
    }

    let resultText = ''
    const streamParser = new StreamLineParser()
    // テキストチャンクの重複送信を防ぐため、前回送信済みテキスト長を追跡
    let sentTextLength = 0
    // file_upload ツールの tool_use_id を追跡して tool_result から file_attachment を生成
    const pendingFileUploadIds = new Set<string>()
    // tool_use_id → ツール名のマッピング（tool_result で toolName を復元するため）
    const pendingToolNames = new Map<string, string>()

    // アクティビティベースタイムアウト: 最後の stdout 出力から CHAT_TIMEOUT 経過で強制終了
    let sigkillTimer: NodeJS.Timeout | undefined
    const activityTimeout = createActivityTimeout(CHAT_TIMEOUT, () => {
      logger.warn(`[chat] claude CLI timed out after ${CHAT_TIMEOUT / 1000}s of inactivity (pid=${child.pid}), sending SIGTERM`)
      child.kill('SIGTERM')
      sigkillTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn(`[chat] claude CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
          child.kill('SIGKILL')
        }
      }, CHAT_SIGKILL_DELAY)
    })

    child.stdout.on('data', (data: Buffer) => {
      activityTimeout.reset()
      streamParser.push(data.toString(), (line) => {
        const { newSentTextLength, text } = processStreamJsonLine(line, sendChunk, child.pid ?? 0, { sentTextLength, pendingFileUploadIds, pendingToolNames })
        sentTextLength = newSentTextLength
        if (text !== undefined) resultText = text
      })
    })

    child.stderr.on('data', (data: Buffer) => {
      // --verbose モードでは stderr にも NDJSON が出力されるので、デバッグログのみ
      const text = data.toString()
      logger.debug(`[chat] claude CLI stderr: ${text.substring(0, LOG_DEBUG_LIMIT)}`)
    })

    child.on('error', (error) => {
      activityTimeout.clear()
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(ERR_CLAUDE_CLI_NOT_FOUND))
      } else {
        reject(error)
      }
    })

    child.on('close', (code) => {
      activityTimeout.clear()
      if (sigkillTimer) clearTimeout(sigkillTimer)
      const durationMs = Date.now() - startTime
      // メッセージ本文を除いた引数（監査用）
      const metadataArgs = args.slice(0, -1)
      logger.debug(`[chat] claude CLI exited (pid=${child.pid}, code=${code}, duration=${durationMs}ms)`)
      if (code === 0) {
        resolve({
          text: resultText,
          metadata: {
            args: metadataArgs,
            exitCode: code,
            hasStderr: false,
            durationMs,
          },
        })
      } else {
        reject(
          new Error(
            `claude CLI がコード ${code} で終了しました`,
          ),
        )
      }
    })
  })

  return { result, cancel: () => killFn() }
}
