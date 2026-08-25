import { filterEnvVarsOverride } from '../env-vars-filter'

/** Hook payload に含めるポリシー評価コンテキスト */
export interface PolicyContext {
  tenantCode?: string
  projectCode?: string
  conversationId?: string
  browserSessionId?: string
  browserLocalPort?: number
  e2eExecutionId?: string
  e2eTestCaseId?: string
  taskId?: string
}

/** ポリシーコンテキストを Hook payload 用の環境変数として env に書き込む */
export function applyPolicyContextEnv(env: Record<string, string>, policyContext?: PolicyContext): void {
  if (!policyContext) return
  if (policyContext.tenantCode) env.AI_SUPPORT_TENANT_CODE = policyContext.tenantCode
  if (policyContext.projectCode) env.AI_SUPPORT_PROJECT_CODE = policyContext.projectCode
  if (policyContext.conversationId) env.AI_SUPPORT_CONVERSATION_ID = policyContext.conversationId
  if (policyContext.browserSessionId) env.AI_SUPPORT_BROWSER_SESSION_ID = policyContext.browserSessionId
  if (policyContext.browserLocalPort) env.AI_SUPPORT_BROWSER_LOCAL_PORT = String(policyContext.browserLocalPort)
  if (policyContext.e2eExecutionId) env.AI_SUPPORT_E2E_EXECUTION_ID = policyContext.e2eExecutionId
  if (policyContext.e2eTestCaseId) env.AI_SUPPORT_E2E_TEST_CASE_ID = policyContext.e2eTestCaseId
  if (policyContext.taskId) env.AI_SUPPORT_TASK_ID = policyContext.taskId
}

/**
 * Web 設定（CLAUDE_CODE# / ENV#）由来の env 上書きを適用する。
 *
 * terminal / vscode 経路と同じ `filterEnvVarsOverride` を通してから代入する。
 * これにより PATH / LD_PRELOAD / NODE_OPTIONS / ZDOTDIR / CODEX_HOME /
 * CODEX_SANDBOX_MODE 等の sandbox・ローダ関連キーが chat 経路からも
 * 上書きできなくなる（従来は api 側 denylist だけが唯一の防御だった）。
 *
 * 非文字列値（null/undefined/数値等）と空文字の skip もフィルタ側が担う
 * （spawn が文字列化して "null" 等が env に入るのを防ぐ）。
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` はフィルタ側で明示的に許可されているため、
 * OAuth 認証経路は従来どおり動作する。
 */
export function applyEnvVarsOverride(env: Record<string, string>, envVarsOverride?: Record<string, string>): void {
  if (!envVarsOverride) return
  const filtered = filterEnvVarsOverride(envVarsOverride, { prefix: '[chat]' })
  for (const [key, value] of Object.entries(filtered)) {
    env[key] = value
  }
}
