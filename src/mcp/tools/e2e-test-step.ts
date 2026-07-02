import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { ENV_VARS } from '../../constants'
import { logger } from '../../logger'
import { getActiveSession } from './browser'
import { BrowserSession } from './browser/browser-session'
import { BrowserSessionManager } from './browser/browser-session-manager'
import { mcpTextResponse, withMcpErrorHandling } from './mcp-response'
import { toErrorMessage } from '../../utils'

/**
 * report_test_step ツールを MCP サーバーに登録する
 *
 * E2E テスト実行中に各ステップの結果を API に報告する。
 * 環境変数 AI_SUPPORT_E2E_EXECUTION_ID がセットされている場合のみ有効。
 * ブラウザセッション（browser_navigate等と共有）からスクリーンショットを自動撮影する。
 */
export function registerE2eTestStepTool(
  server: McpServer,
  apiClient: ApiClient,
  browserSession?: BrowserSession,
  browserSessionManager?: BrowserSessionManager,
): void {
  server.tool(
    'report_test_step',
    'Report the result of an E2E test step. Use this after each test action to record pass/fail status. A screenshot is automatically captured from the browser. Only available during E2E test execution.',
    {
      stepNumber: z.number().describe('Step number (sequential, starting from 1)'),
      action: z.string().describe('Description of the action performed (e.g., "Click login button", "Verify page title")'),
      selector: z.string().optional().describe('CSS selector or locator used'),
      expected: z.string().optional().describe('Expected result'),
      actual: z.string().optional().describe('Actual result observed'),
      status: z.enum(['passed', 'failed', 'skipped']).describe('Step result status'),
      error: z.string().optional().describe('Error message if step failed'),
      duration: z.number().optional().describe('Step duration in milliseconds'),
    },
    async (args) =>
      withMcpErrorHandling(async () => {
        const executionId = process.env.AI_SUPPORT_E2E_EXECUTION_ID
        if (!executionId) {
          return mcpTextResponse(
            'report_test_step is only available during E2E test execution (AI_SUPPORT_E2E_EXECUTION_ID not set)',
          )
        }

        const tenantCode = process.env[ENV_VARS.TENANT_CODE]
        const projectCode = process.env[ENV_VARS.PROJECT_CODE]
        const testCaseId = process.env.AI_SUPPORT_E2E_TEST_CASE_ID
        if (!tenantCode || !projectCode) {
          return mcpTextResponse(
            'Missing tenant or project code for E2E step reporting',
          )
        }

        logger.debug(
          `[e2e_test] Reporting step ${args.stepNumber}: ${args.action} -> ${args.status}`,
        )

        // browser_navigate等と共有しているBrowserSessionからスクリーンショットを撮影する。
        // browser_navigate/browser_click等はgetActiveSession()で毎回アクティブなセッション
        // （プロキシ経由の場合は実際にナビゲートされた別インスタンス）を解決しているため、
        // ここでも同じ解決を行わないと、一度もナビゲートされていない静的な browserSession
        // （about:blank のまま）を撮影してしまい、常に白紙のスクリーンショットになる。
        let screenshotBase64: string | undefined
        if (browserSession) {
          try {
            const activeSession = browserSessionManager
              ? await getActiveSession(browserSessionManager, browserSession)
              : browserSession
            // isActive()がfalseの場合、resolved先が一度もnavigateされていない
            // （ブラウザ自体が未起動の）静的セッションであることを意味する。
            // このままscreenshot()を呼ぶと新規Chromiumがabout:blankで起動され、
            // 例外を投げずに白紙PNGを「撮影成功」として返してしまうため、
            // 事前にガードしてスキップする（browser_click等の他ツールと同じガード）。
            if (!activeSession.isActive()) {
              logger.warn(
                `[e2e_test] No active browser session for step ${args.stepNumber} (execution ${executionId}); skipping screenshot`,
              )
            } else {
              const buffer = await activeSession.screenshot(true)
              screenshotBase64 = buffer.toString('base64')
              logger.debug(`[e2e_test] Screenshot captured for step ${args.stepNumber} (${(buffer.length / 1024).toFixed(1)}KB)`)
            }
          } catch (err: unknown) {
            logger.warn(
              `[e2e_test] Failed to capture screenshot for step ${args.stepNumber}: ${toErrorMessage(err)}`,
            )
          }
        }

        await apiClient.reportE2eTestStep(
          tenantCode,
          projectCode,
          executionId,
          {
            stepNumber: args.stepNumber,
            action: args.action,
            selector: args.selector,
            expected: args.expected,
            actual: args.actual,
            status: args.status,
            error: args.error,
            duration: args.duration,
            ...(screenshotBase64 && { screenshotBase64 }),
            ...(testCaseId && { testCaseId }),
          },
        )

        return mcpTextResponse(
          `Step ${args.stepNumber}: ${args.status}${screenshotBase64 ? ' (screenshot captured)' : ''}${args.error ? ` - ${args.error}` : ''}`,
        )
      }),
  )
}
