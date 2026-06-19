import type { ApiClient } from '../api-client'
import { executePlaywrightScript, type BrowserSessionLike, type ScriptExecutionResult } from '../browser/browser-script-executor'
import { runPlaywrightSubprocess } from '../browser/playwright-subprocess-executor'
import { logger } from '../logger'
import type {
  AgentChatMode,
  AgentServerConfig,
  CommandResult,
  ProjectConfigResponse,
} from '../types'
import { errorResult, successResult } from '../types/command'
import { parseString, toErrorMessage } from '../utils'

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
  browserSessionManager?: unknown
}

/** Maximum number of recovery attempts */
const MAX_RECOVERY_ATTEMPTS = 3

/**
 * E2E テストを実行する
 *
 * playwrightScript がある場合はスクリプト直接実行（高速）、
 * ない場合は従来のAI実行フローを使用する。
 */
export async function executeE2eTest(
  options: ExecuteE2eTestOptions,
): Promise<CommandResult> {
  const { payload, client, agentId, tenantCode } = options
  const projectCode = options.projectConfig?.project?.projectCode

  const executionId = parseString(payload.executionId)
  const scenario = parseString(payload.scenario)
  const targetUrl = parseString(payload.targetUrl)
  const credentialId = parseString(payload.credentialId)
  const executionMethod = parseString(payload.executionMethod) ?? 'ai'
  const playwrightScript = parseString(payload.playwrightScript)
  const recoveryMode = (parseString(payload.recoveryMode) ?? 'auto') as 'auto' | 'manual'
  const steps = payload.steps as unknown[] | undefined

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

  // API にステータス running を報告
  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId, 'running',
    undefined, undefined, testCaseId,
    steps?.length ? { totalSteps: steps.length } : undefined,
  )

  // スクリプト実行モード判定
  if (playwrightScript && executionMethod === 'playwright') {
    return executePlaywrightSubprocessMode({
      ...options,
      executionId,
      testCaseId,
      playwrightScript,
      scenario,
      startTime,
    })
  }

  if (playwrightScript && executionMethod !== 'ai') {
    return executeScriptMode({
      ...options,
      executionId,
      testCaseId,
      playwrightScript,
      scenario,
      targetUrl: targetUrl ?? undefined,
      credentialId: credentialId ?? undefined,
      recoveryMode,
      steps,
      startTime,
    })
  }

  // 従来のAI実行モード
  return executeAiMode(options, {
    executionId,
    testCaseId,
    scenario,
    targetUrl: targetUrl ?? undefined,
    credentialId: credentialId ?? undefined,
    startTime,
  })
}

/** Playwright subprocess モードのパラメータ */
interface PlaywrightSubprocessModeParams extends ExecuteE2eTestOptions {
  executionId: string
  testCaseId?: string
  playwrightScript: string
  scenario: string
  startTime: number
}

/**
 * Playwright subprocess モード
 *
 * エージェントの共有ブラウザを使わず、独立した Playwright 子プロセスで E2E テストを実行する。
 */
async function executePlaywrightSubprocessMode(
  params: PlaywrightSubprocessModeParams,
): Promise<CommandResult> {
  const { client, tenantCode, executionId, testCaseId, playwrightScript, startTime } = params
  const projectCode = params.projectConfig?.project?.projectCode

  let subprocessResult
  try {
    subprocessResult = await runPlaywrightSubprocess({
      script: playwrightScript,
      executionId,
      baseUrl: undefined,
      timeoutMs: undefined,
    })
  } catch (err: unknown) {
    const errorMessage = toErrorMessage(err)
    logger.error(`[e2e_test] Playwright subprocess error: ${errorMessage}`)
    await reportExecutionStatus(
      client, tenantCode, projectCode, executionId,
      'error', Date.now() - startTime, errorMessage, testCaseId,
    )
    return errorResult(`Playwright subprocess error: ${errorMessage}`)
  }

  // Report each step
  for (let i = 0; i < subprocessResult.steps.length; i++) {
    const step = subprocessResult.steps[i]
    if (!tenantCode || !projectCode) break
    try {
      await client.reportE2eTestStep(tenantCode, projectCode, executionId, {
        testCaseId,
        stepNumber: i + 1,
        action: step.title,
        status: step.status,
        ...(step.error && { error: step.error }),
        // screenshotPath is a local filesystem path that the API cannot access;
        // do not send it as screenshotUrl — omit it from the API payload entirely.
      })
    } catch (err: unknown) {
      logger.warn(`[e2e_test] Failed to report playwright step ${i + 1}: ${toErrorMessage(err)}`)
    }
  }

  const duration = Date.now() - startTime
  const finalStatus = subprocessResult.success ? 'passed' : 'failed'

  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    finalStatus, duration,
    subprocessResult.success ? undefined : (subprocessResult.errorOutput ?? `${subprocessResult.failedTests} test(s) failed`),
    testCaseId,
    {
      passedTests: subprocessResult.passedTests,
      failedTests: subprocessResult.failedTests,
      totalTests: subprocessResult.totalTests,
    },
  )

  logger.info(
    `[e2e_test] Playwright subprocess completed [${executionId}]: status=${finalStatus}, duration=${duration}ms`,
  )

  return successResult({
    executionId,
    status: finalStatus,
    duration,
    passedTests: subprocessResult.passedTests,
    failedTests: subprocessResult.failedTests,
    totalTests: subprocessResult.totalTests,
  })
}

/** AI実行モード（従来のフロー） */
async function executeAiMode(
  options: ExecuteE2eTestOptions,
  params: {
    executionId: string
    testCaseId?: string
    scenario: string
    targetUrl?: string
    credentialId?: string
    startTime: number
  },
): Promise<CommandResult> {
  const { client, commandId, agentId, tenantCode } = options
  const projectCode = options.projectConfig?.project?.projectCode
  const { executionId, testCaseId, scenario, targetUrl, credentialId, startTime } = params

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
  } catch (err: unknown) {
    const errorMessage = toErrorMessage(err)
    logger.error(`[e2e_test] Chat execution failed: ${errorMessage}`)

    await reportExecutionStatus(
      client, tenantCode, projectCode, executionId,
      'error', Date.now() - startTime, errorMessage, testCaseId,
    )

    return errorResult(`E2E test execution failed: ${errorMessage}`)
  }

  const duration = Date.now() - startTime

  const finalStatus = result.success ? 'passed' : 'failed'
  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    finalStatus, duration, result.success ? undefined : result.error, testCaseId,
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

/** スクリプト実行モードのパラメータ */
interface ScriptModeParams extends ExecuteE2eTestOptions {
  executionId: string
  testCaseId?: string
  playwrightScript: string
  scenario: string
  targetUrl?: string
  credentialId?: string
  recoveryMode: 'auto' | 'manual'
  steps?: unknown[]
  startTime: number
}

/**
 * スクリプト直接実行モード
 *
 * Playwrightスクリプトを直接実行し、失敗時はAIリカバリを試みる。
 */
async function executeScriptMode(
  params: ScriptModeParams,
): Promise<CommandResult> {
  const {
    client, tenantCode, executionId, testCaseId, playwrightScript,
    scenario, recoveryMode, startTime, browserSessionManager,
  } = params
  const projectCode = params.projectConfig?.project?.projectCode

  const aiFallbackParams = {
    executionId,
    testCaseId,
    scenario,
    targetUrl: params.targetUrl,
    credentialId: params.credentialId,
    startTime,
  }

  // ブラウザセッション取得
  const session = await acquireBrowserSession(browserSessionManager, executionId)
  if (session === null) {
    logger.warn('[e2e_test] No browser session manager available, falling back to AI mode')
    return executeAiMode(params, aiFallbackParams)
  }
  if (session === undefined) {
    // セッション作成失敗 — ログは acquireBrowserSession 内で記録済み
    return executeAiMode(params, aiFallbackParams)
  }

  // ステップ完了コールバック
  const onStepComplete = buildStepCompleteCallback(client, tenantCode, projectCode, executionId, testCaseId)

  // スクリプト実行
  let scriptResult: ScriptExecutionResult
  try {
    scriptResult = await executePlaywrightScript(session, playwrightScript, onStepComplete)
  } catch (err: unknown) {
    const errorMessage = toErrorMessage(err)
    logger.error(`[e2e_test] Script execution error: ${errorMessage}`)

    await reportExecutionStatus(
      client, tenantCode, projectCode, executionId,
      'error', Date.now() - startTime, errorMessage, testCaseId,
    )
    return errorResult(`Script execution error: ${errorMessage}`)
  }

  // fallbackToChat の場合はAI実行にフォールバック
  if (scriptResult.fallbackToChat) {
    logger.info('[e2e_test] Script contains unparseable lines, falling back to AI mode')
    return executeAiMode(params, aiFallbackParams)
  }

  // スクリプト成功
  if (scriptResult.success) {
    return reportScriptSuccess(client, tenantCode, projectCode, executionId, testCaseId, startTime, scriptResult)
  }

  // スクリプト失敗 → AIリカバリ
  logger.info(`[e2e_test] Script failed at: ${scriptResult.failedLine}, attempting AI recovery`)

  return executeAiRecovery({
    ...params,
    session,
    originalScript: playwrightScript,
    scriptResult,
    recoveryMode,
  })
}

/**
 * ブラウザセッションを取得する。
 * - セッションマネージャーなし → null（AI fallback シグナル）
 * - セッション作成失敗 → undefined（AI fallback シグナル）
 * - 成功 → セッションオブジェクト
 */
async function acquireBrowserSession(
  browserSessionManager: unknown,
  executionId: string,
): Promise<BrowserSessionLike | null | undefined> {
  const sessionManager = browserSessionManager as {
    getOrCreate: (id: string) => Promise<BrowserSessionLike>
  } | undefined

  if (!sessionManager) {
    return null
  }

  try {
    return await sessionManager.getOrCreate(`e2e-${executionId}`)
  } catch (err: unknown) {
    logger.warn(`[e2e_test] Failed to create browser session: ${toErrorMessage(err)}`)
    return undefined
  }
}

/**
 * ステップ完了コールバックを生成する
 */
function buildStepCompleteCallback(
  client: ApiClient,
  tenantCode: string | undefined,
  projectCode: string | undefined,
  executionId: string,
  testCaseId: string | undefined,
): (step: number, _total: number, line: string) => Promise<void> {
  return async (step: number, _total: number, line: string) => {
    if (!tenantCode || !projectCode) return
    try {
      await client.reportE2eTestStep(tenantCode, projectCode, executionId, {
        testCaseId,
        stepNumber: step,
        action: line,
        status: 'passed',
      })
    } catch (err: unknown) {
      logger.warn(`[e2e_test] Failed to report step ${step}: ${toErrorMessage(err)}`)
    }
  }
}

/**
 * スクリプト成功時のステータス報告と結果返却
 */
async function reportScriptSuccess(
  client: ApiClient,
  tenantCode: string | undefined,
  projectCode: string | undefined,
  executionId: string,
  testCaseId: string | undefined,
  startTime: number,
  scriptResult: ScriptExecutionResult,
): Promise<CommandResult> {
  const duration = Date.now() - startTime
  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    'passed', duration, undefined, testCaseId,
    { passedSteps: scriptResult.completedSteps, totalSteps: scriptResult.totalSteps },
  )

  logger.info(`[e2e_test] Script execution passed [${executionId}]: ${scriptResult.completedSteps}/${scriptResult.totalSteps} steps`)
  return successResult({
    executionId,
    status: 'passed',
    duration,
    completedSteps: scriptResult.completedSteps,
    totalSteps: scriptResult.totalSteps,
  })
}

/** AIリカバリのパラメータ */
interface RecoveryParams extends ScriptModeParams {
  session: BrowserSessionLike
  originalScript: string
  scriptResult: ScriptExecutionResult
  recoveryMode: 'auto' | 'manual'
}

/**
 * AIリカバリ実行
 *
 * スクリプト失敗時にAIに修正スクリプトを生成させ、再実行する。
 */
async function executeAiRecovery(
  params: RecoveryParams,
): Promise<CommandResult> {
  const {
    client, commandId, tenantCode, executionId, testCaseId,
    scenario, originalScript, scriptResult, session, startTime, recoveryMode,
  } = params
  const projectCode = params.projectConfig?.project?.projectCode

  for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
    logger.info(`[e2e_test] Recovery attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS}`)

    // AIにスクリプト修正を依頼
    const recoveryPrompt = buildRecoveryPrompt(originalScript, scriptResult, scenario, attempt)

    let chatResult: CommandResult
    try {
      chatResult = await executeChatCommand({
        payload: {
          message: recoveryPrompt,
          policyContext: {
            tenantCode,
            projectCode,
            e2eExecutionId: executionId,
            e2eTestCaseId: testCaseId,
          },
        },
        commandId: `${commandId}-recovery-${attempt}`,
        client,
        serverConfig: params.serverConfig,
        activeChatMode: params.activeChatMode,
        agentId: params.agentId,
        projectDir: params.projectDir,
        projectConfig: params.projectConfig,
        mcpConfigPath: params.mcpConfigPath,
        tenantCode,
        browserLocalPort: params.browserLocalPort,
      })
    } catch (err: unknown) {
      logger.warn(`[e2e_test] Recovery chat failed: ${toErrorMessage(err)}`)
      continue
    }

    if (!chatResult.success) {
      logger.warn(`[e2e_test] Recovery chat returned failure: ${chatResult.error}`)
      continue
    }

    // チャット結果からスクリプトを抽出
    const updatedScript = extractScriptFromChatResult(chatResult)
    if (!updatedScript) {
      logger.warn('[e2e_test] Could not extract script from recovery chat result')
      continue
    }

    // 修正スクリプトで再実行
    let retryResult: ScriptExecutionResult
    try {
      retryResult = await executePlaywrightScript(session, updatedScript)
    } catch (err: unknown) {
      logger.warn(`[e2e_test] Recovery script execution error: ${toErrorMessage(err)}`)
      continue
    }

    if (retryResult.success) {
      logger.info(`[e2e_test] Recovery succeeded on attempt ${attempt}`)

      // 修正スクリプトを保存
      if (tenantCode && projectCode && testCaseId) {
        try {
          await client.updateE2eTestScript(tenantCode, projectCode, executionId, {
            playwrightScript: updatedScript,
            testCaseId,
            recoveryMode,
          })
        } catch (err: unknown) {
          logger.warn(`[e2e_test] Failed to save recovered script: ${toErrorMessage(err)}`)
        }
      }

      const duration = Date.now() - startTime
      await reportExecutionStatus(
        client, tenantCode, projectCode, executionId,
        'passed', duration, undefined, testCaseId,
        {
          passedSteps: retryResult.completedSteps,
          totalSteps: retryResult.totalSteps,
          recoveryAttempts: attempt,
        },
      )

      return successResult({
        executionId,
        status: 'passed',
        duration,
        recoveredOnAttempt: attempt,
      })
    }
  }

  // 全リトライ失敗
  const duration = Date.now() - startTime
  const errorMessage = `Script recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts. Last failure: ${scriptResult.failedLine}`

  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    'failed', duration, errorMessage, testCaseId,
    {
      passedSteps: scriptResult.completedSteps,
      failedSteps: 1,
      totalSteps: scriptResult.totalSteps,
      recoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    },
  )

  return successResult({
    executionId,
    status: 'failed',
    duration,
    error: errorMessage,
  })
}

/** リカバリ用プロンプトを構築 */
function buildRecoveryPrompt(
  originalScript: string,
  scriptResult: ScriptExecutionResult,
  scenario: string,
  attempt: number,
): string {
  const completedLines = scriptResult.results
    .filter(r => r.success)
    .map(r => r.line)
    .join('\n')

  const failedInfo = scriptResult.results
    .filter(r => !r.success)
    .map(r => `Line: ${r.line}\nError: ${r.error ?? 'unknown'}`)
    .join('\n')

  return [
    '# E2E テストスクリプト修正依頼',
    '',
    `リカバリ試行: ${attempt}/${MAX_RECOVERY_ATTEMPTS}`,
    '',
    '## 元のテストシナリオ',
    scenario,
    '',
    '## 元のスクリプト',
    '```',
    originalScript,
    '```',
    '',
    '## 成功したステップ',
    completedLines || '(なし)',
    '',
    '## 失敗情報',
    failedInfo,
    '',
    '## 修正指示',
    '上記の失敗を修正した新しいPlaywrightスクリプトを生成してください。',
    '対応コマンド: page.goto, page.click, page.fill, page.keyboard.type/press, page.mouse.wheel, page.waitForTimeout, page.locator().innerText()',
    '',
    'スクリプトのみを出力してください（```で囲まないでください）。',
  ].join('\n')
}

/** チャット結果からスクリプトを抽出 */
function extractScriptFromChatResult(result: CommandResult): string | null {
  if (!result.success) return null

  const data = result.data
  if (typeof data === 'string') {
    // コードブロックから抽出
    const codeBlockMatch = data.match(/```(?:typescript|javascript|playwright)?\n([\s\S]*?)```/)
    if (codeBlockMatch) return codeBlockMatch[1].trim()
    // await page. で始まる行があればスクリプトとして扱う
    if (data.includes('await page.')) return data.trim()
  }

  return null
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
  extra?: Record<string, unknown>,
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
        ...extra,
      },
    )
  } catch (err: unknown) {
    logger.warn(
      `[e2e_test] Failed to update execution status: ${toErrorMessage(err)}`,
    )
  }
}
