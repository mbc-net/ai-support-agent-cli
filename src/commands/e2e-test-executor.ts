import path from 'path'

import type { ApiClient } from '../api-client'
import { runPlaywrightScript, type PlaywrightRunnerResult } from '../browser/playwright-test-runner'
import { runPlaywrightSubprocess } from '../browser/playwright-subprocess-executor'
import { logger } from '../logger'
import type {
  AgentChatMode,
  AgentServerConfig,
  CommandResult,
  E2eSupportFile,
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
  availableChatModes?: AgentChatMode[]
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  tenantCode?: string
  browserLocalPort?: number
  /**
   * E2E 専用のブラウザーセッションを子プロセス実行前にメインプロセスへ
   * 事前登録するコールバック。未指定（VS Code トンネル未接続等）の場合は
   * セッション事前登録をスキップする。
   */
  getOrCreateBrowserSession?: (sessionId: string) => Promise<void>
  /**
   * E2E 専用のブラウザーセッションを実行後にクローズするコールバック。
   * close失敗はE2E結果報告を妨げないよう呼び出し側でwarn握り潰しする。
   */
  closeBrowserSession?: (sessionId: string) => Promise<void>
}

/**
 * E2E テストを実行する
 *
 * playwrightScript がある場合は @playwright/test サブプロセスで直接実行（高速）、
 * ない場合は従来のAI実行フローを使用する。
 */
export async function executeE2eTest(
  options: ExecuteE2eTestOptions,
): Promise<CommandResult> {
  const { payload, client, agentId, tenantCode } = options
  const projectCode = options.projectConfig?.project?.projectCode

  const executionId = parseString(payload.executionId)
  const scenario = parseString(payload.scenario) ?? ''
  const targetUrl = parseString(payload.targetUrl)
  const credentialId = parseString(payload.credentialId)
  const environmentId = parseString(payload.environmentId)
  const executionMethod = parseString(payload.executionMethod) ?? 'ai'
  const playwrightScript = parseString(payload.playwrightScript)
  const steps = Array.isArray(payload.steps) ? payload.steps : undefined

  if (!executionId) {
    return errorResult('executionId is required for e2e_test')
  }
  if (!scenario && !playwrightScript) {
    return errorResult('scenario is required for e2e_test')
  }
  if (!agentId) {
    return errorResult('agentId is required for e2e_test')
  }

  logger.info(
    `[e2e_test] Starting E2E test execution [${executionId}]: method=${executionMethod}`,
  )

  warnIfLegacyEnvironmentVariablesPresent(payload)

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
      targetUrl: targetUrl ?? undefined,
      environmentId: environmentId ?? undefined,
      startTime,
    })
  }

  // 環境変数の注入は executionMethod='playwright' 専用。他モードでは
  // 配線先が無いため、environmentId 指定を無言破棄せず明示的に警告する。
  warnIfEnvironmentIdIgnored(environmentId ?? undefined)

  if (playwrightScript && executionMethod !== 'ai') {
    return executeScriptMode({
      ...options,
      executionId,
      testCaseId,
      playwrightScript,
      scenario,
      targetUrl: targetUrl ?? undefined,
      credentialId: credentialId ?? undefined,
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
    playwrightScript: playwrightScript ?? undefined,
  })
}

/**
 * environmentId が指定されているが、この実行モードでは環境変数を
 * 注入する仕組みが無い（Playwright サブプロセス専用）場合に警告ログを出す。
 * 無言破棄を避けるための最小限のガード。
 */
function warnIfEnvironmentIdIgnored(environmentId: string | undefined): void {
  if (!environmentId) return

  logger.warn(
    `[e2e_test] environmentId is only supported for executionMethod='playwright'; ignoring the selected environment for this execution`,
  )
}

/**
 * 旧仕様の environmentVariables フィールドはプル方式へ移行済みで参照されない。
 * デプロイ順序の窓（API が旧方式、agent が新方式）で無言破棄されるのを避けるため、
 * フィールドが存在する場合のみ警告する。値の中身はログに出さない（機密情報保護）。
 */
function warnIfLegacyEnvironmentVariablesPresent(
  payload: Record<string, unknown>,
): void {
  if (payload.environmentVariables === undefined) return

  logger.warn(
    `[e2e_test] legacy environmentVariables field is no longer supported; use environmentId instead`,
  )
}

/** Playwright subprocess モードのパラメータ */
interface PlaywrightSubprocessModeParams extends ExecuteE2eTestOptions {
  executionId: string
  testCaseId?: string
  playwrightScript: string
  scenario: string
  targetUrl?: string
  environmentId?: string
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
  const {
    client, tenantCode, executionId, testCaseId, playwrightScript, targetUrl, environmentId, startTime,
  } = params
  const projectCode = params.projectConfig?.project?.projectCode

  let environmentVariables: Record<string, string> | undefined
  if (environmentId) {
    try {
      environmentVariables = await client.getE2eEnvironmentVariables(environmentId)
    } catch (err: unknown) {
      const errorMessage = toErrorMessage(err)
      logger.error(`[e2e_test] Failed to fetch E2E environment variables [${executionId}] environmentId=${environmentId}: ${errorMessage}`)
      await reportExecutionStatus(
        client, tenantCode, projectCode, executionId,
        'error', Date.now() - startTime,
        `Failed to fetch E2E environment variables: ${errorMessage}`, testCaseId,
      )
      return errorResult(`Failed to fetch E2E environment variables: ${errorMessage}`)
    }
  }

  // プロジェクト共有サポートファイル（lib/ 等）の取得。環境変数取得の「失敗→error」とは
  // 意図的に異なり、取得失敗は実行エラーにしない（旧 API サーバー相手でも import を
  // 使わない spec は従来どおり動く必要があるため）。
  let supportFiles: E2eSupportFile[] = []
  if (tenantCode && projectCode) {
    try {
      supportFiles = await client.getE2eSupportFiles(tenantCode, projectCode)
    } catch (err: unknown) {
      logger.warn(
        `[e2e_test] Failed to fetch support files (continuing without them) [${executionId}]: ${toErrorMessage(err)}`,
      )
    }
  }

  let subprocessResult
  try {
    subprocessResult = await runPlaywrightSubprocess({
      script: playwrightScript,
      executionId,
      baseUrl: targetUrl,
      envVars: environmentVariables,
      supportFiles,
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
        ...(step.duration !== undefined && { duration: step.duration }),
        ...(step.executedAt && { executedAt: step.executedAt }),
        ...(step.screenshotBase64 && { screenshotBase64: step.screenshotBase64 }),
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
    playwrightScript?: string
    startTime: number
  },
): Promise<CommandResult> {
  const { client, commandId, agentId, tenantCode } = options
  const projectCode = options.projectConfig?.project?.projectCode
  const { executionId, testCaseId, scenario, targetUrl, credentialId, playwrightScript, startTime } = params

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

  if (scenario) {
    systemPromptParts.push(
      '## テストシナリオ',
      scenario,
      '',
    )
  }

  if (Array.isArray(options.payload.steps) && options.payload.steps.length > 0) {
    systemPromptParts.push(
      '## ステップ定義',
      JSON.stringify(options.payload.steps, null, 2),
      '',
    )
  }

  if (playwrightScript) {
    systemPromptParts.push(
      '## Playwright スクリプト参照',
      '以下のPlaywrightスクリプトと同等の操作・検証を、ブラウザ操作ツールで実行してください。',
      'スクリプトを直接実行せず、各主要操作または検証の後に report_test_step ツールで結果を報告してください。',
      '```typescript',
      playwrightScript,
      '```',
      '',
    )
  }

  systemPromptParts.push(
    `## 環境変数`,
    `AI_SUPPORT_E2E_EXECUTION_ID=${executionId}`,
  )

  // E2E 実行専用の一意なブラウザーセッションID。
  // コンソールでユーザーが開いているブラウザープレビュー（メインプロセスの
  // BrowserSessionManager に登録された既存セッション）を子プロセスが誤って
  // 乗っ取らないよう、実行ごとに独立したセッションを明示的に割り当てる。
  const browserSessionId = `e2e-${executionId}`

  const chatPayload = {
    message: systemPromptParts.join('\n'),
    browserSessionId,
    policyContext: {
      tenantCode: tenantCode,
      projectCode: options.projectConfig?.project?.projectCode,
      e2eExecutionId: executionId,
      e2eTestCaseId: testCaseId,
    },
  }

  let result: CommandResult

  try {
    if (options.getOrCreateBrowserSession) {
      await options.getOrCreateBrowserSession(browserSessionId)
    }

    result = await executeChatCommand({
      payload: chatPayload,
      commandId,
      client: options.client,
      serverConfig: options.serverConfig,
      activeChatMode: options.activeChatMode,
      availableChatModes: options.availableChatModes,
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
  } finally {
    if (options.closeBrowserSession) {
      try {
        await options.closeBrowserSession(browserSessionId)
      } catch (closeErr: unknown) {
        logger.warn(`[e2e_test] Failed to close E2E browser session [${browserSessionId}]: ${toErrorMessage(closeErr)}`)
      }
    }
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
  startTime: number
}

/**
 * スクリプト直接実行モード
 *
 * @playwright/test をサブプロセスで実行してテスト結果を返す。
 */
async function executeScriptMode(
  params: ScriptModeParams,
): Promise<CommandResult> {
  const {
    client, tenantCode, executionId, testCaseId, playwrightScript, startTime,
  } = params
  const projectCode = params.projectConfig?.project?.projectCode

  const agentRootDir = params.projectDir ?? path.resolve(__dirname, '../../')

  let scriptResult: PlaywrightRunnerResult
  try {
    scriptResult = await runPlaywrightScript(playwrightScript, executionId, agentRootDir)
  } catch (err: unknown) {
    const errorMessage = toErrorMessage(err)
    logger.error(`[e2e_test] Script execution error: ${errorMessage}`)

    await reportExecutionStatus(
      client, tenantCode, projectCode, executionId,
      'error', Date.now() - startTime, errorMessage, testCaseId,
    )
    return errorResult(`Script execution error: ${errorMessage}`)
  }

  const duration = Date.now() - startTime
  const status = scriptResult.success ? 'passed' : 'failed'

  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    status, duration,
    scriptResult.success ? undefined : (scriptResult.errorOutput ?? `${scriptResult.failed} test(s) failed`),
    testCaseId,
    {
      passedSteps: scriptResult.passed,
      failedSteps: scriptResult.failed,
      totalSteps: scriptResult.totalSteps,
    },
  )

  logger.info(
    `[e2e_test] Script execution ${status} [${executionId}]: passed=${scriptResult.passed} failed=${scriptResult.failed} duration=${duration}ms`,
  )

  return successResult({
    executionId,
    status,
    duration,
    passed: scriptResult.passed,
    failed: scriptResult.failed,
    totalSteps: scriptResult.totalSteps,
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
