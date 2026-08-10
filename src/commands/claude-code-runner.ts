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
import { processStreamJsonLine, type StreamJsonUsage, type StreamJsonError } from './claude-code-stream'
import { killWithEscalation, makeKillFn } from './cli-process-kill'
import { applyEnvVarsOverride, applyPolicyContextEnv, type PolicyContext } from './cli-runner-env'
import { resolveValidPluginDir } from './plugin-dir'
import { isErrnoException } from '../utils'

// Re-export for backward compatibility
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-args'
export { processStreamJsonLine, parseFileUploadResult } from './claude-code-stream'
export type { StreamJsonContentBlock, StreamJsonLine, StreamJsonMcpServer, StreamJsonError } from './claude-code-stream'

export const ERR_CLAUDE_USAGE_LIMIT_REACHED = 'claude CLI の利用上限に達しています。Claude Code の Monthly Limit または rate limit を確認してください。'
export const ERR_CLAUDE_EXIT_CODE_1 = 'claude CLI がコード 1 で終了しました'
export const ERR_CLAUDE_AUTH_FAILED = 'claude CLI の認証に失敗しました (401)。CLAUDE_CODE_OAUTH_TOKEN が無効か失効しています。Web 設定のトークンを再発行（claude setup-token）して更新してください。'

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
  /** `--strict-mcp-config` を付与するか。詳細は claude-code-args.ts のコメント参照 */
  strictMcpConfig?: boolean
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
  const { message, sendChunk, allowedTools, tools, addDirs, locale, awsEnv, mcpConfigPath, strictMcpConfig, cwd, systemPrompt, model, policyContext, envVarsOverride } = options

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
    // 秘密っぽい env 値（トークン等）を spawn 前に一度だけ収集し、以降の値ベースマスク
    // （stderr debug ログ・失敗時 WARN ログ・ユーザー返却メッセージ）で共用する。
    // claude CLI（外部プロセス）は認証エラー時にこれらの値を stderr/stdout にエコーし得るため、
    // logger.ts のパターンマスクでは拾えない「裸のトークン」を値ベースで確実にマスクする。
    // 失敗時 WARN ログとユーザー返却メッセージで共用する、秘密っぽい env 値の集合。
    // claude CLI（外部プロセス）が認証エラー時に stderr / stream-json へエコーし得る env の
    // 値（トークン等）を、logger.ts のパターンマスクでは拾えない「裸の値」として確実にマスクする。
    // 注: 正常な assistant 出力（delta / 成功 result 本文）そのもののマスクは本修正の対象外。
    //     comprehensive な出力マスクは collectSecretEnvValues の過検出（例: GIT_CONFIG_KEY_* の
    //     設定メタ値）や data イベント境界跨ぎへの対処が必要で、別途ハードニングとして扱う。
    const secretEnvValues = collectSecretEnvValues(env)
    // --model に渡す値を「JSON設定 > env > デフォルト」の優先順位で解決する。
    // claude CLI は --model フラグ > ANTHROPIC_MODEL env の順で評価するため、
    // env が指定されている場合は --model を付けず CLI に env を尊重させる。
    // env は envVarsOverride まで反映済みの最終値を参照する。
    const explicitModel = model?.trim()
    const envModel = env.ANTHROPIC_MODEL?.trim()
    const resolvedModel = explicitModel
      ? explicitModel
      : (envModel ? undefined : DEFAULT_CLAUDE_MODEL)
    const args = buildClaudeArgs(message, { allowedTools, tools, addDirs, locale, mcpConfigPath, strictMcpConfig, systemPrompt, model: resolvedModel, pluginDir: resolveValidPluginDir() ?? undefined })

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
    killFn = makeKillFn(child, 'claude')

    let resultText = ''
    let resultUsage: StreamJsonUsage | undefined
    const streamParser = new StreamLineParser()
    // テキストチャンクの重複送信を防ぐため、前回送信済みテキスト長を追跡
    let sentTextLength = 0
    let stderrText = ''
    let hasStderr = false
    // stream-json(stdout) 側に出た API エラー（401 等。stderr は空のことが多い）を保持し、
    // 終了コード非0時のユーザー向けメッセージ分類とログ出力に使う。
    let streamJsonError: StreamJsonError | undefined
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
        const { newSentTextLength, text, toolExecutionChange, usage, error } = processStreamJsonLine(line, sendChunk, child.pid ?? 0, { sentTextLength, pendingFileUploadIds, pendingToolNames })
        sentTextLength = newSentTextLength
        if (text !== undefined) resultText = text
        if (usage !== undefined) resultUsage = usage
        if (error !== undefined) streamJsonError = error
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
      // stream-json(stdout) 側に出た API エラー（401 等）は stderr が空でも起きる。
      // stream-json のエラーテキストは claude CLI（外部プロセス）の未制御な出力で、env の秘密値を
      // エコーし得るため、ここで一度だけ値ベースにマスクした safeStreamJsonError を作り、
      // WARN ログとユーザー返却メッセージ（formatClaudeExitError）の両方でこの安全版を使う。
      // 分類（401/利用上限）は非秘密のキーワードで行うためマスク後テキストでも正しく機能する。
      const safeStreamJsonError: StreamJsonError | undefined = streamJsonError
        ? {
            text: redactSecretValues(streamJsonError.text, secretEnvValues),
            ...(streamJsonError.apiErrorStatus !== undefined ? { apiErrorStatus: streamJsonError.apiErrorStatus } : {}),
          }
        : undefined
      // is_error（safeStreamJsonError）と exit code は別フィールド。claude が明示する失敗シグナル
      // である is_error が立っていれば、exit code が 0 でも「失敗」として扱う。code だけで成功判定
      // すると、空/途中の回答が成功として呼び出し元へ渡り、リトライ抑止・フォールバックも
      // 発火しない（サイレント障害）ため、is_error を単独の真実として reject に倒す。
      const failed = code !== 0 || safeStreamJsonError !== undefined
      if (failed && stderrText) {
        const redactedStderr = redactSecretValues(stderrText, secretEnvValues)
        logger.warn(`[chat] claude CLI failed (pid=${child.pid}, code=${code}): ${redactedStderr.slice(-LOG_STDERR_ON_FAILURE_LIMIT)}`)
      }
      if (failed && safeStreamJsonError) {
        const status = safeStreamJsonError.apiErrorStatus !== undefined ? `, status=${safeStreamJsonError.apiErrorStatus}` : ''
        // code=0 なのに is_error という異常組み合わせは、後追い調査できるよう明示的に注記する。
        const note = code === 0 ? ' (is_error but exit 0)' : ''
        logger.warn(`[chat] claude CLI failed via stream-json (pid=${child.pid}, code=${code}${status})${note}: ${safeStreamJsonError.text.slice(-LOG_STDERR_ON_FAILURE_LIMIT)}`)
      }
      if (!failed) {
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
        reject(new Error(formatClaudeExitError(code, stderrText, safeStreamJsonError)))
      }
    })
  })

  return { result, cancel: () => killFn() }
}

export function formatClaudeExitError(code: number | null, stderrText: string, streamError?: StreamJsonError): string {
  // 認証エラー(401): stderr は空でも stream-json 側の result(is_error)/api_error_status に出る。
  // CLI バージョン差で stderr 側にのみ 401 が出るケースも拾えるよう、stderr も判定対象にする。
  // これを最優先で分類し、汎用文言ではなく対処可能なメッセージを返す。
  if (
    (streamError && (streamError.apiErrorStatus === 401 || isClaudeAuthError(streamError.text))) ||
    isClaudeAuthError(stderrText)
  ) {
    return ERR_CLAUDE_AUTH_FAILED
  }
  // 利用上限: stderr だけでなく stream-json 側のエラーテキストも判定対象にする。
  if (isClaudeUsageLimitError(stderrText) || (streamError ? isClaudeUsageLimitError(streamError.text) : false)) {
    return ERR_CLAUDE_USAGE_LIMIT_REACHED
  }
  // その他の stream-json エラーは、汎用文言で握り潰さず実際のエラーテキストを添える。
  // text は呼び出し側で redact 済み。長さは LOG_STDERR_ON_FAILURE_LIMIT で上限を設ける。
  // 注: code===1 のときこの文言は ERR_CLAUDE_EXIT_CODE_1（`claude CLI がコード 1 で終了しました`）を
  //     プレフィックスに含むため、chat-executor 側の `.includes(ERR_CLAUDE_EXIT_CODE_1)` 判定に
  //     ヒットしてフォールバック対象になる（従来 code===1 は無条件でフォールバックしていた挙動を維持）。
  //     ERR_CLAUDE_EXIT_CODE_1 の文言を変える場合はこのプレフィックスも合わせて維持すること。
  if (streamError?.text) {
    return `claude CLI がコード ${code} で終了しました: ${streamError.text.slice(0, LOG_STDERR_ON_FAILURE_LIMIT)}`
  }
  if (code === 1) return ERR_CLAUDE_EXIT_CODE_1
  return `claude CLI がコード ${code} で終了しました`
}

/**
 * claude CLI のエラーテキストが認証失敗（401 / bearer トークン不正 / 要 login）かを判定する。
 * api_error_status が無いケース（本文のみ）でも拾えるようにするが、過検出を避けるため
 * 明確な認証シグナルに限定し、"401" は単語境界＋認証/API 文脈が伴う場合のみ認証と見なす。
 */
export function isClaudeAuthError(text: string): boolean {
  const t = text.toLowerCase()
  // 明確な認証失敗シグナル（それ自体で認証エラーと断定できる文言）
  if (
    t.includes('invalid bearer token') ||
    t.includes('authentication_failed') ||
    t.includes('oauth access token is invalid') ||
    t.includes('please run /login') ||
    t.includes('unauthorized')
  ) {
    return true
  }
  // HTTP 401: 単語境界で判定し（"40123" 等の誤検出を避ける）、かつ認証/API 文脈に限定する。
  return /\b401\b/.test(t) && /(auth|api error|api_error|token|bearer|\/login|unauthor)/.test(t)
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
