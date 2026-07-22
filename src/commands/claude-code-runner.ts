import { spawn } from 'child_process'

import { CHAT_TIMEOUT, CHAT_TOOL_EXECUTION_TIMEOUT, DEFAULT_CLAUDE_MODEL, ERR_CLAUDE_CLI_NOT_FOUND, LOG_DEBUG_LIMIT, LOG_STDERR_ON_FAILURE_LIMIT } from '../constants'
import { logger } from '../logger'
import type { ChatChunkType } from '../types'
import { createActivityTimeout } from '../utils/activity-timeout'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { ensureClaudeJsonOAuthAccount } from '../utils/claude-json-oauth-sync'
import { collectSecretEnvValues, redactSecretValues } from '../utils/secret-redaction'
import { StreamLineParser } from '../utils/stream-parser'

import { buildClaudeArgs, buildCleanEnv } from './claude-code-args'
import { processStreamJsonLine, type StreamJsonUsage } from './claude-code-stream'
import { killWithEscalation } from './cli-process-kill'
import { applyEnvVarsOverride, applyPolicyContextEnv, type PolicyContext } from './cli-runner-env'
import { resolveValidPluginDir } from './plugin-dir'
import { isErrnoException } from '../utils'

// Re-export for backward compatibility
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-args'
export { processStreamJsonLine, parseFileUploadResult } from './claude-code-stream'
export type { StreamJsonContentBlock, StreamJsonLine, StreamJsonMcpServer } from './claude-code-stream'

export const ERR_CLAUDE_USAGE_LIMIT_REACHED = 'claude CLI の利用上限に達しています。Claude Code の Monthly Limit または rate limit を確認してください。'
export const ERR_CLAUDE_EXIT_CODE_1 = 'claude CLI がコード 1 で終了しました'

/** Claude Code CLI の実行結果 */
export interface ClaudeCodeResult {
  text: string
  usage?: StreamJsonUsage
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

export type { PolicyContext }

/** runClaudeCode のオプション */
export interface RunClaudeCodeOptions {
  message: string
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>
  allowedTools?: string[]
  tools?: string[]
  addDirs?: string[]
  locale?: string
  awsEnv?: Record<string, string>
  mcpConfigPath?: string
  cwd?: string
  systemPrompt?: string
  /** claude CLI に渡すモデル。
   *  省略時は env（ANTHROPIC_MODEL / envVarsOverride）が有効値なら CLI に委譲し、
   *  env も未設定の場合に DEFAULT_CLAUDE_MODEL が使われる。
   */
  model?: string
  policyContext?: PolicyContext
  /**
   * Web 設定（CLAUDE_CODE# / ENV#）由来の環境変数オーバーレイ。
   *
   * cleanEnv → awsEnv → policyContext の最後にマージされ、含まれるキーのみ
   * 上書きする。含まれないキーは process.env の値が残る。
   */
  envVarsOverride?: Record<string, string>
}

/**
 * Claude Code CLI をサブプロセスとして実行し、出力をストリーミングで返す
 * ClaudeCodeHandle を返す: result Promise と kill 関数
 */
export function runClaudeCode(options: RunClaudeCodeOptions): ClaudeCodeHandle {
  const { message, sendChunk, allowedTools, tools, addDirs, locale, awsEnv, mcpConfigPath, cwd, systemPrompt, model, policyContext, envVarsOverride } = options

  let killFn: () => void = () => { /* noop until child is spawned */ }

  const result = new Promise<ClaudeCodeResult>((resolve, reject) => {
    const startTime = Date.now()
    // claude CLI が利用可能か確認し、print モードで実行
    // Claude Code セッション内からの起動時にネスト検出やSSEポート干渉を回避するため、
    // CLAUDECODE および CLAUDE_CODE_* 環境変数を除外
    const cleanEnv = buildCleanEnv()
    const env: Record<string, string> = awsEnv ? { ...cleanEnv, ...awsEnv } : { ...cleanEnv }

    // Hook payload 用のポリシーコンテキスト環境変数を設定
    applyPolicyContextEnv(env, policyContext)

    // Web 設定（CLAUDE_CODE# / ENV#）の env 上書き — 最後にマージして cleanEnv より優先
    applyEnvVarsOverride(env, envVarsOverride)
    // --model に渡す値を「JSON設定 > env > デフォルト」の優先順位で解決する。
    // claude CLI は --model フラグ > ANTHROPIC_MODEL env の順で評価するため、
    // env が指定されている場合は --model を付けず CLI に env を尊重させる。
    // env は envVarsOverride まで反映済みの最終値を参照する。
    const explicitModel = model?.trim()
    const envModel = env.ANTHROPIC_MODEL?.trim()
    const resolvedModel = explicitModel
      ? explicitModel
      : (envModel ? undefined : DEFAULT_CLAUDE_MODEL)
    const args = buildClaudeArgs(message, { allowedTools, tools, addDirs, locale, mcpConfigPath, systemPrompt, model: resolvedModel, pluginDir: resolveValidPluginDir() ?? undefined })

    // どの経路でモデルが決まったかをログ出力し、「--model が付かなかった理由
    // （env 尊重 vs バグ）」をログだけで判別できるようにする。
    if (explicitModel) {
      logger.debug(`[chat] model resolved: ${explicitModel} (source=config)`)
    } else if (envModel) {
      logger.debug(`[chat] model resolved: ${envModel} via ANTHROPIC_MODEL (source=env, --model omitted)`)
    } else {
      logger.debug(`[chat] model resolved: ${DEFAULT_CLAUDE_MODEL} (source=default)`)
    }

    ensureClaudeJsonIntegrity()
    // Web 経由で OAuth Token が設定されているなら ~/.claude.json の
    // oauthAccount キーを確保する。chat の --print 経路でも将来の claude CLI
    // 仕様変更で要求される可能性があるため defensive に呼ぶ。
    ensureClaudeJsonOAuthAccount(envVarsOverride, { prefix: '[chat]' })

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
      killWithEscalation(child, 'claude')
    }

    let resultText = ''
    let resultUsage: StreamJsonUsage | undefined
    const streamParser = new StreamLineParser()
    // テキストチャンクの重複送信を防ぐため、前回送信済みテキスト長を追跡
    let sentTextLength = 0
    let stderrText = ''
    let hasStderr = false
    // file_upload ツールの tool_use_id を追跡して tool_result から file_attachment を生成
    const pendingFileUploadIds = new Set<string>()
    // tool_use_id → ツール名のマッピング（tool_result で toolName を復元するため）
    const pendingToolNames = new Map<string, string>()

    // アクティビティベースタイムアウト: 最後の stdout 出力から CHAT_TIMEOUT 経過で強制終了
    // ツール実行中は pause() で通常タイムアウトを停止するが、
    // フォールバックとして CHAT_TOOL_EXECUTION_TIMEOUT 後に強制終了する（ハング防止）
    let sigkillTimer: NodeJS.Timeout | undefined
    const activityTimeout = createActivityTimeout(CHAT_TIMEOUT, () => {
      logger.warn(`[chat] claude CLI timed out (pid=${child.pid}), sending SIGTERM`)
      sigkillTimer = killWithEscalation(child, 'claude')
    }, CHAT_TOOL_EXECUTION_TIMEOUT)

    child.stdout.on('data', (data: Buffer) => {
      activityTimeout.reset()
      streamParser.push(data.toString(), (line) => {
        const { newSentTextLength, text, toolExecutionChange, usage } = processStreamJsonLine(line, sendChunk, child.pid ?? 0, { sentTextLength, pendingFileUploadIds, pendingToolNames })
        sentTextLength = newSentTextLength
        if (text !== undefined) resultText = text
        if (usage !== undefined) resultUsage = usage
        // ツール実行開始時はタイマーを一時停止（ツール実行中はstdout出力がないため）
        // ツール実行完了時はタイマーを再開
        if (toolExecutionChange === 'started') {
          activityTimeout.pause()
        } else if (toolExecutionChange === 'finished') {
          activityTimeout.reset()
        }
      })
    })

    child.stderr.on('data', (data: Buffer) => {
      // --verbose モードでは stderr にも NDJSON が出力されるので、デバッグログのみ
      const text = data.toString()
      hasStderr = true
      stderrText += text
      logger.debug(`[chat] claude CLI stderr: ${text.substring(0, LOG_DEBUG_LIMIT)}`)
    })

    child.on('error', (error) => {
      activityTimeout.clear()
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (isErrnoException(error, 'ENOENT')) {
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
      // stderr は既定（--verbose 無し）では logger.debug が抑制されるため、失敗時の
      // 診断情報が本番相当環境で一切残らない問題があった。ここで warn レベルに
      // 出力し、--verbose 無しでも失敗原因を追えるようにする（ユーザー向け
      // エラーメッセージ自体は formatClaudeExitError の安全な汎用文言のまま変更しない）。
      // - redactSecretValues: stderr は claude CLI という外部プロセスの未制御なテキストで、
      //   認証エラー時に渡した env の値（ANTHROPIC_API_KEY 等）をそのままエコーする可能性が
      //   ある。maskSecrets（logger.ts）はパターンベースで `key=value` 形式等しか拾えないため、
      //   ここでは実際に渡した秘密っぽい env 値そのものを値ベースで追加マスクする。
      // - slice(-LIMIT): 実際の失敗原因（fatal error）は通常 stderr の末尾に出るため、
      //   先頭ではなく末尾を優先して残す。
      if (code !== 0 && stderrText) {
        const redactedStderr = redactSecretValues(stderrText, collectSecretEnvValues(env))
        logger.warn(`[chat] claude CLI failed (pid=${child.pid}, code=${code}): ${redactedStderr.slice(-LOG_STDERR_ON_FAILURE_LIMIT)}`)
      }
      if (code === 0) {
        resolve({
          text: resultText,
          usage: resultUsage,
          metadata: {
            args: metadataArgs,
            exitCode: code,
            hasStderr,
            durationMs,
          },
        })
      } else {
        reject(new Error(formatClaudeExitError(code, stderrText)))
      }
    })
  })

  return { result, cancel: () => killFn() }
}

export function formatClaudeExitError(code: number | null, stderrText: string): string {
  if (isClaudeUsageLimitError(stderrText)) return ERR_CLAUDE_USAGE_LIMIT_REACHED
  if (code === 1) return ERR_CLAUDE_EXIT_CODE_1
  return `claude CLI がコード ${code} で終了しました`
}

export function isClaudeUsageLimitError(stderrText: string): boolean {
  const text = stderrText.toLowerCase()
  const compactText = text.replace(/\s+/g, '')
  const hasJapaneseUsageContext =
    compactText.includes('月間制限') ||
    compactText.includes('月次制限') ||
    compactText.includes('利用上限') ||
    compactText.includes('使用上限') ||
    compactText.includes('利用制限') ||
    compactText.includes('使用制限') ||
    compactText.includes('レート制限')
  return (
    text.includes('monthly limit') ||
    text.includes('monthly spend limit') ||
    (hasJapaneseUsageContext && (
      compactText.includes('達') ||
      compactText.includes('超過') ||
      compactText.includes('超え')
    )) ||
    (text.includes('usage limit') && (text.includes('reached') || text.includes('exceeded'))) ||
    (text.includes('spend limit') && (text.includes('hit') || text.includes('reached') || text.includes('exceeded'))) ||
    (text.includes('rate limit') && (text.includes('reached') || text.includes('exceeded'))) ||
    ((text.includes('usage') || text.includes('spend') || text.includes('rate')) && text.includes('limit') && text.includes('exceeded'))
  )
}
