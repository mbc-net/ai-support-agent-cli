import { ENV_VARS } from '../../constants'

/**
 * サービス起動時にラッパースクリプト生成へ渡すエージェント認証情報。
 * いずれも未設定なら `undefined`（プラットフォーム別インストーラで共通）。
 */
export interface AgentCredentialEnv {
  anthropicApiKey?: string
  claudeCodeOauthToken?: string
  codexApiKey?: string
  codexAccessToken?: string
}

/**
 * `process.env` からエージェント認証情報の4項目を読み取る。
 * darwin / linux / win32 の各サービスインストーラで重複していた読み取りを集約する。
 * 呼び出し時に評価されるため、生成対象オブジェクトへ `...readAgentCredentialEnv()`
 * とスプレッドして使う。
 */
export function readAgentCredentialEnv(): AgentCredentialEnv {
  return {
    anthropicApiKey: process.env[ENV_VARS.ANTHROPIC_API_KEY],
    claudeCodeOauthToken: process.env[ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN],
    codexApiKey: process.env[ENV_VARS.CODEX_API_KEY],
    codexAccessToken: process.env[ENV_VARS.CODEX_ACCESS_TOKEN],
  }
}
