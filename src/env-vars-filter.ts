/**
 * envVarsOverride を spawn 系 API (node-pty / child_process) に流す前に
 * 適用する agent 側の防御フィルタ。
 *
 * - api 側 `AgentEnvVarsService` が同等の denylist を持つが、API 側 regression
 *   や別経路で envVars が流入したケースに備えた二層防御。
 * - 形式チェック (大文字英数字 + `_`、先頭は文字または `_`) を agent 側でも実施。
 * - 非文字列・空文字値の skip も統一。
 *
 * 注意: ここで列挙する denylist は API 側
 * `src/agent/agent-env-vars.service.ts` の `DENYLIST_EXACT` /
 * `DENYLIST_PREFIX` と同期する必要がある。
 */

import { logger } from './logger'

/**
 * セッション起動時に注入する env を都度取得するための provider。
 *
 * 関数として渡すのは、Web 設定の更新（heartbeat 経由の config sync）が
 * agent プロセス起動後に到着し、PTY / code-server を spawn するタイミングで
 * 最新値を反映するため。
 */
export type EnvVarsProvider = () => Record<string, string> | undefined

/** API 側 ENV_NAME_PATTERN と同一の形式チェック */
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

/** 完全一致で拒否する env 名 */
const DENYLIST_EXACT = new Set<string>([
  // OS の基本動作
  'PATH', 'HOME', 'USER', 'SHELL', 'LOGNAME',
  'TMPDIR', 'TEMP', 'TMP',
  // dynamic linker (explicit, LD_ prefix で大半は包括するが念のため)
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  // glibc 内部
  'GCONV_PATH', 'HOSTALIASES', 'NLSPATH', 'LOCPATH', 'RES_OPTIONS',
  // POSIX シェル制御
  'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS',
  // 言語ランタイム差し込み
  'NODE_OPTIONS', 'NODE_PATH',
  'PYTHONPATH', 'PYTHONSTARTUP',
  'PERL5LIB', 'PERL5OPT', 'PERL5DB',
  'RUBYOPT', 'RUBYLIB',
  'LUA_PATH', 'LUA_CPATH',
  // Playwright のブラウザ実行ファイル探索パス差し替え（e2e-test-executor 経由の
  // Playwright サブプロセス実行で任意バイナリを実行させられるのを防ぐ）
  'PLAYWRIGHT_BROWSERS_PATH',
  // agent sandbox anchors
  // ZDOTDIR: PTY の zsh sandbox 用 .zshrc を指す
  // XDG_DATA_HOME / XDG_CONFIG_HOME: code-server (VS Code) の settings.json を指す
  'ZDOTDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  // agent 内部
  'CLAUDECODE',
])

/** プレフィックス一致で拒否する env 名 */
const DENYLIST_PREFIX = ['LD_', 'DYLD_', 'AI_SUPPORT_', 'BASH_FUNC_']

/**
 * `CLAUDE_CODE_*` を直接書き込むのは原則禁止。
 *
 * **例外**: `CLAUDE_CODE_OAUTH_TOKEN` は api 側 `AgentEnvVarsService` が
 * `CLAUDE_CODE#OAUTH_TOKEN` を正規にマップして送ってくる env 名そのもの。
 * これを agent 側で弾くと OAuth 認証経路が壊れる（PR #300 後の regression）。
 *
 * api 側は ENV# 経由での `CLAUDE_CODE_OAUTH_TOKEN` 直書きを完全に拒否しており、
 * agent に届く `CLAUDE_CODE_OAUTH_TOKEN` は CLAUDE_CODE# 固定マップ由来のみ。
 * よって agent 側ではこのキーのみ通し、他の `CLAUDE_CODE_*`（SSE_PORT 等）は引き続き拒否する。
 */
function isProtectedClaudeCodeKey(envName: string): boolean {
  if (envName === 'CLAUDE_CODE_OAUTH_TOKEN') return false
  return envName.startsWith('CLAUDE_CODE_')
}

export interface EnvVarsFilterContext {
  /** ログプレフィックス (例: "[terminal]" / "[vscode-server]") */
  prefix: string
}

/**
 * envVarsOverride をフィルタして spawn に流す env マップを返す。
 *
 * 入力に含まれるキーのうち、形式不正・denylist 該当・空文字/非文字列・
 * 保護対象の env はすべて skip し、安全なものだけを Record に集約する。
 *
 * 結果は呼び出し側で「process.env / safeEnv に上書きマージするレイヤー」
 * として使用する想定。
 */
export function filterEnvVarsOverride(
  envVars: Record<string, string> | undefined,
  ctx: EnvVarsFilterContext,
): Record<string, string> {
  if (!envVars) return {}

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(envVars)) {
    if (!isAllowedEnvName(key, ctx)) continue
    if (!isAcceptableValue(value, key, ctx)) continue
    result[key] = value
  }
  return result
}

function isAllowedEnvName(name: string, ctx: EnvVarsFilterContext): boolean {
  if (!ENV_NAME_PATTERN.test(name)) {
    logger.warn(`${ctx.prefix} Skipping envVar with invalid name format`)
    return false
  }
  if (DENYLIST_EXACT.has(name)) {
    logger.warn(`${ctx.prefix} Skipping denylisted envVar: ${name}`)
    return false
  }
  for (const prefix of DENYLIST_PREFIX) {
    if (name.startsWith(prefix)) {
      logger.warn(`${ctx.prefix} Skipping envVar with denylisted prefix: ${name}`)
      return false
    }
  }
  if (isProtectedClaudeCodeKey(name)) {
    logger.warn(
      `${ctx.prefix} Skipping envVar that targets protected CLAUDE_CODE_* env: ${name}`,
    )
    return false
  }
  return true
}

function isAcceptableValue(
  value: unknown,
  key: string,
  ctx: EnvVarsFilterContext,
): value is string {
  if (typeof value !== 'string') {
    logger.warn(`${ctx.prefix} Skipping envVar ${key} with non-string value`)
    return false
  }
  if (value === '') {
    logger.warn(`${ctx.prefix} Skipping envVar ${key} with empty value`)
    return false
  }
  return true
}
