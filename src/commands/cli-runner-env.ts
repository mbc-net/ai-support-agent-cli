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
 * 非文字列値（null/undefined/数値等）は spawn が文字列化して "null" 等が
 * env として設定されてしまうため、防御的に typeof チェックする。
 */
export function applyEnvVarsOverride(env: Record<string, string>, envVarsOverride?: Record<string, string>): void {
  if (!envVarsOverride) return
  for (const [key, value] of Object.entries(envVarsOverride)) {
    if (typeof value !== 'string' || value === '') continue
    env[key] = value
  }
}
