import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { logger } from '../../logger'
import { mcpErrorResponse, mcpJsonResponse, mcpTextResponse, newIdempotencyKey, withMcpErrorHandling } from './mcp-response'

/**
 * trigger_e2e_test ツールを MCP サーバーに登録する
 *
 * タスク実行中（AI_SUPPORT_TASK_ID がセットされている場合）のみ有効。起動した
 * E2E 実行にタスクIDを紐付け、タスク詳細画面の E2E テストタブから逆引きできる
 * ようにする。testCaseId は対象プロジェクトのアクティブな E2E テストケースの
 * ID を指定する必要がある。
 */
export function registerTriggerE2eTestTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'trigger_e2e_test',
    'Trigger a registered E2E test case to run. Only available during task execution — the launched E2E run is linked '
      + 'to this task so it shows up in the task detail\'s E2E test tab. testCaseId must be an existing E2E test case ID '
      + 'for this project.',
    {
      testCaseId: z.string().describe('ID of the E2E test case to execute'),
      executionMethod: z.enum(['ai', 'script', 'hybrid', 'playwright']).optional()
        .describe('Execution method (optional; defaults to the test case setting)'),
      environmentId: z.string().optional().describe('E2E environment ID (optional)'),
    },
    async (args) => withMcpErrorHandling(async () => {
      const taskId = process.env.AI_SUPPORT_TASK_ID
      if (!taskId) {
        logger.warn(`[trigger_e2e_test] Guarded: AI_SUPPORT_TASK_ID not set (testCaseId=${args.testCaseId})`)
        return mcpTextResponse(
          'trigger_e2e_test is only available during task execution (AI_SUPPORT_TASK_ID not set)',
        )
      }

      const callId = newIdempotencyKey()
      const result = await apiClient.triggerE2eTest(
        args.testCaseId, taskId, args.executionMethod, args.environmentId, callId,
      )
      if (!result.success) {
        const message = result.error?.message ?? 'Failed to trigger E2E test'
        logger.warn(`[trigger_e2e_test] Failed: testCaseId=${args.testCaseId} taskId=${taskId}: ${message}`)
        return mcpErrorResponse(message)
      }
      logger.debug(`[trigger_e2e_test] Triggered: testCaseId=${args.testCaseId} taskId=${taskId} executionId=${result.data?.executionId}`)
      return mcpJsonResponse(result.data)
    }),
  )
}
