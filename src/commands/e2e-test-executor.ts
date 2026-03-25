import type { ApiClient } from '../api-client'
import { logger } from '../logger'
import type {
  AgentChatMode,
  AgentServerConfig,
  CommandResult,
  ProjectConfigResponse,
} from '../types'
import { errorResult, successResult } from '../types/command'
import { parseString } from '../utils'

import { executeChatCommand } from './chat-executor'

/** Options for E2E test execution */
export interface ExecuteE2eTestOptions {
  payload: Record<string, unknown>
  commandId: string
  client: ApiClient
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  tenantCode?: string
  browserLocalPort?: number
}

/**
 * E2E テストを実行する
 *
 * シナリオ（自然言語）をチャットコマンドとして実行し、
 * AI がブラウザ操作ツールを使ってテストを自動実行する。
 * 各ステップの結果は report_test_step MCP ツールで API に報告される。
 */
export async function executeE2eTest(
  options: ExecuteE2eTestOptions,
): Promise<CommandResult> {
  const { payload, commandId, client, agentId, tenantCode } = options
  const projectCode = options.projectConfig?.project?.projectCode

  const executionId = parseString(payload.executionId)
  const scenario = parseString(payload.scenario)
  const targetUrl = parseString(payload.targetUrl)
  const credentialId = parseString(payload.credentialId)
  const executionMethod = parseString(payload.executionMethod) ?? 'ai'

  if (!executionId) {
    return errorResult('executionId is required for e2e_test')
  }
  if (!scenario) {
    return errorResult('scenario is required for e2e_test')
  }
  if (!agentId) {
    return errorResult('agentId is required for e2e_test')
  }

  logger.info(
    `[e2e_test] Starting E2E test execution [${executionId}]: method=${executionMethod}`,
  )

  const startTime = Date.now()

  const testCaseId = parseString(payload.testCaseId) ?? undefined

  // API にステータス running を報告（内部でエラーハンドリング済み）
  await reportExecutionStatus(client, tenantCode, projectCode, executionId, 'running', undefined, undefined, testCaseId)

  // テスト用システムプロンプトを構築
  const systemPromptParts: string[] = [
    '# E2E テスト実行モード',
    '',
    'あなたはE2Eテストの自動実行エージェントです。',
    '以下のシナリオに従い、ブラウザ操作ツールを使ってテストを実行してください。',
    '',
    '## ルール',
    '1. 各ステップを実行したら、report_test_step ツールで結果を報告してください（スクリーンショットは自動的に撮影されます）',
    '2. 期待結果と異なる場合は status="failed" で報告してください',
    '3. エラーが発生した場合は error フィールドにエラー内容を含めてください',
    '4. すべてのステップ完了後に最終結果をまとめてください',
    '',
  ]

  if (targetUrl) {
    systemPromptParts.push(
      `## テスト対象URL`,
      `最初に browser_navigate で ${targetUrl} にアクセスしてください。`,
      '',
    )
  }

  if (credentialId) {
    systemPromptParts.push(
      `## 認証`,
      `credentialId: ${credentialId} を使って browser_login で認証してください。`,
      '',
    )
  }

  systemPromptParts.push(
    '## テストシナリオ',
    scenario,
    '',
    `## 環境変数`,
    `AI_SUPPORT_E2E_EXECUTION_ID=${executionId}`,
  )

  // チャットコマンドとして実行（既存のチャット実行フローを再利用）
  const chatPayload = {
    message: systemPromptParts.join('\n'),
    policyContext: {
      tenantCode: tenantCode,
      projectCode: options.projectConfig?.project?.projectCode,
      e2eExecutionId: executionId,
      e2eTestCaseId: testCaseId,
    },
  }

  let result: CommandResult

  try {
    result = await executeChatCommand({
      payload: chatPayload,
      commandId,
      client: options.client,
      serverConfig: options.serverConfig,
      activeChatMode: options.activeChatMode,
      agentId,
      projectDir: options.projectDir,
      projectConfig: options.projectConfig,
      mcpConfigPath: options.mcpConfigPath,
      tenantCode,
      browserLocalPort: options.browserLocalPort,
    })
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : String(err)
    logger.error(`[e2e_test] Chat execution failed: ${errorMessage}`)

    await reportExecutionStatus(
      client,
      tenantCode,
      projectCode,
      executionId,
      'error',
      Date.now() - startTime,
      errorMessage,
      testCaseId,
    )

    return errorResult(`E2E test execution failed: ${errorMessage}`)
  }

  const duration = Date.now() - startTime

  // 最終ステータスを報告（内部でエラーハンドリング済み）
  const finalStatus = result.success ? 'passed' : 'failed'
  await reportExecutionStatus(
    client,
    tenantCode,
    projectCode,
    executionId,
    finalStatus,
    duration,
    result.success ? undefined : result.error,
    testCaseId,
  )

  logger.info(
    `[e2e_test] E2E test execution completed [${executionId}]: status=${finalStatus}, duration=${duration}ms`,
  )

  return successResult({
    executionId,
    status: finalStatus,
    duration,
  })
}

/**
 * API に実行ステータスを報告する
 */
async function reportExecutionStatus(
  client: ApiClient,
  tenantCode: string | undefined,
  projectCode: string | undefined,
  executionId: string,
  status: string,
  duration?: number,
  errorMessage?: string,
  testCaseId?: string,
): Promise<void> {
  if (!tenantCode || !projectCode) {
    logger.warn('[e2e_test] tenantCode/projectCode not available, skipping status report')
    return
  }

  try {
    await client.updateE2eExecutionStatus(
      tenantCode,
      projectCode,
      executionId,
      {
        status,
        ...(duration !== undefined && { duration }),
        ...(errorMessage && { errorMessage }),
        ...(testCaseId && { testCaseId }),
      },
    )
  } catch (err) {
    logger.warn(
      `[e2e_test] Failed to update execution status: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
