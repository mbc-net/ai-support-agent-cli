import path from 'path'

import type { ApiClient } from '../api-client'
import { runPlaywrightScript, type PlaywrightRunnerResult } from '../browser/playwright-test-runner'
import { runPlaywrightSubprocess } from '../browser/playwright-subprocess-executor'
import { logger } from '../logger'
import type {
  CommandResult,
  E2eBasicAuth,
  E2eSupportFile,
} from '../types'
import { errorResult, successResult } from '../types/command'
import { getErrorMessage, parseString, toErrorMessage, truncateString } from '../utils'

import { type AgentExecutionContext, forwardAgentExecutionContext } from './agent-execution-context'
import { executeChatCommand } from './chat-executor'

/**
 * Hard upper bound (suffix marker included) for the step-report failure reason
 * carried in logs and the aggregate errorMessage.
 */
const STEP_REPORT_FAILURE_REASON_MAX_LENGTH = 500

/**
 * Upper bound for the errorMessage sent to the API (execution status update).
 * It can embed unbounded Playwright stderr; a multi-MB body would hit 413.
 * Used both to size the stderr part in the subprocess mode and as the
 * catch-all in reportExecutionStatus, so the two can never drift apart.
 */
const E2E_ERROR_MESSAGE_MAX_LENGTH = 4000

/** Prefix marking that the head of an over-long errorMessage was dropped. */
const TRUNCATED_HEAD_MARKER = '[...truncated] '

/**
 * Leading line(s) the Playwright subprocess executor prepends to errorOutput on
 * a timeout (`Playwright subprocess timed out after …`). They state the cause
 * and must survive tail-keeping truncation of the stderr that follows them.
 */
const TIMEOUT_NOTE_PREFIX = 'Playwright subprocess timed out'

/**
 * Bound `text` to `limit` chars (marker included), keeping the TAIL — for
 * stderr the last lines carry the actual failure (same convention as
 * claude-code-runner's `.slice(-LOG_STDERR_ON_FAILURE_LIMIT)`).
 */
function truncateKeepingTail(text: string, limit: number): string {
  if (text.length <= limit) return text
  return TRUNCATED_HEAD_MARKER + text.slice(-(limit - TRUNCATED_HEAD_MARKER.length))
}

/** Bound `text` to at most `limit` chars INCLUDING the `...` suffix (head kept). */
function truncateWithinLimit(text: string, limit: number): string {
  if (text.length <= limit) return text
  return truncateString(text, limit - '...'.length)
}

/**
 * Bound the Playwright errorOutput to `limit` chars: leading timeout note
 * line(s) are kept verbatim, and only the stderr after them is cut (tail kept).
 */
function boundErrorOutput(output: string, limit: number): string {
  if (output.length <= limit) return output
  const lines = output.split('\n')
  let noteLines = 0
  while (noteLines < lines.length && lines[noteLines].startsWith(TIMEOUT_NOTE_PREFIX)) noteLines++
  if (noteLines === 0) return truncateKeepingTail(output, limit)
  const head = lines.slice(0, noteLines).join('\n')
  const rest = lines.slice(noteLines).join('\n')
  return `${head}\n${truncateKeepingTail(rest, limit - head.length - 1)}`
}

/** Options for E2E test execution */
export interface ExecuteE2eTestOptions extends AgentExecutionContext {
  payload: Record<string, unknown>
  commandId: string
  client: ApiClient
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
  // tenantCode/projectCode come from the agent itself (transport deps / oneshot
  // env), NOT from the config-synced projectConfig: a failed config sync must
  // not make a correctly routed e2e_test unreportable. No fallback.
  const { payload, client, agentId, tenantCode, projectCode } = options

  const executionId = parseString(payload.executionId)
  const scenario = parseString(payload.scenario) ?? ''
  const targetUrl = parseString(payload.targetUrl)
  const credentialId = parseString(payload.credentialId)
  const environmentId = parseString(payload.environmentId)
  const executionMethod = parseString(payload.executionMethod) ?? 'ai'
  const playwrightScript = parseString(payload.playwrightScript)
  const steps = Array.isArray(payload.steps) ? payload.steps : undefined
  const basicAuth = parseBasicAuth(payload.basicAuth, executionId ?? 'unknown')

  if (!executionId) {
    return errorResult('executionId is required for e2e_test')
  }
  if (!scenario && !playwrightScript) {
    return errorResult('scenario is required for e2e_test')
  }
  if (!agentId) {
    return errorResult('agentId is required for e2e_test')
  }
  // Without tenantCode/projectCode nothing can be persisted (neither the
  // running/final status nor any step evidence). Running the test anyway would
  // only produce a result that exists nowhere but this process, so refuse up
  // front for every mode instead of returning a misleading "passed".
  if (!tenantCode || !projectCode) {
    const message = 'tenantCode/projectCode is not set; E2E results cannot be reported'
    logger.error(`[e2e_test] ${message} [${executionId}]`)
    return errorResult(message, { executionId, status: 'error' })
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
      tenantCode,
      projectCode,
      executionId,
      testCaseId,
      playwrightScript,
      scenario,
      targetUrl: targetUrl ?? undefined,
      environmentId: environmentId ?? undefined,
      basicAuth,
      startTime,
    })
  }

  // 環境変数の注入は executionMethod='playwright' 専用。他モードでは
  // 配線先が無いため、environmentId 指定を無言破棄せず明示的に警告する。
  warnIfEnvironmentIdIgnored(environmentId ?? undefined)

  if (playwrightScript && executionMethod !== 'ai') {
    return executeScriptMode({
      ...options,
      tenantCode,
      projectCode,
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
    tenantCode,
    projectCode,
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

/**
 * `captureStepScreenshots` ペイロードフィールドを boolean として解釈する。
 *
 * API は boolean で送るが、デプロイ順序の窓や手動再実行で文字列 `"false"` が
 * 来る可能性も考慮する。未指定（undefined/null）や解釈不能な値は既定の
 * true（ハーネス側スクリーンショット取得を有効）にフォールバックし、明示的な
 * false（boolean false / 文字列 "false"）のときのみ無効化する。
 */
function parseBooleanDefaultTrue(value: unknown): boolean {
  if (value === false) return false
  if (typeof value === 'string' && value.toLowerCase() === 'false') return false
  return true
}

/**
 * payload.basicAuth を `E2eBasicAuth` としてパースする。
 *
 * `username` と `passwordVariableKey` が両方とも非空文字列のときのみ有効な
 * オブジェクトを返す。平文パスワードは payload に含まれない設計のため、
 * ここでも受け取らない。
 *
 * - `basicAuth` 自体が完全に無い（null/undefined/非オブジェクト）場合は、
 *   Basic 認証を使わない通常の実行なので**無言で** undefined を返す。
 * - オブジェクトは在るが `username` か `passwordVariableKey` の**片方だけ**が
 *   欠落/空の場合は、設定ミスの可能性が高い（無言で認証なし実行して 401 →
 *   要素待ちタイムアウトになると原因が分かりにくい）ため、`logger.warn` で
 *   可視化してから undefined を返す。警告には triage 用に executionId のみを
 *   含め、値（username 等）は出さない。
 */
function parseBasicAuth(value: unknown, executionId: string): E2eBasicAuth | undefined {
  if (!value || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  const username = parseString(obj.username)
  const passwordVariableKey = parseString(obj.passwordVariableKey)
  if (!username || !passwordVariableKey) {
    logger.warn(
      `[e2e_test] basicAuth ignored: incomplete (missing username or passwordVariableKey) [${executionId}]`,
    )
    return undefined
  }
  return { username, passwordVariableKey }
}

/** Playwright subprocess モードのパラメータ */
interface PlaywrightSubprocessModeParams extends ExecuteE2eTestOptions {
  /** Validated non-empty at the entry point (executeE2eTest). */
  tenantCode: string
  projectCode: string
  executionId: string
  testCaseId?: string
  playwrightScript: string
  scenario: string
  targetUrl?: string
  environmentId?: string
  basicAuth?: E2eBasicAuth
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
    client, tenantCode, projectCode, executionId, testCaseId, playwrightScript, targetUrl, environmentId, basicAuth,
    startTime,
  } = params

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

  // Basic 認証（HTTP Basic）の資格情報を解決する。password は payload に含まれず、
  // E2E シークレット変数マップ（environmentVariables）から passwordVariableKey で
  // 引く。解決できない場合はフォールバックせず error にして早期終了する
  // （黙って続行すると 401 で要素待ちが 120 秒 SIGKILL タイムアウトになるため）。
  // エラーメッセージにはキー名のみ含め、パスワード値は決して出さない。
  let httpCredentials: { username: string; password: string } | undefined
  if (basicAuth) {
    // 契約: `environmentVariables` のキーは API 側 `resolveByPrefix('E2E#')` により
    // `E2E#` プレフィックスが除去済み（例: DDB 上の `E2E#BASIC_AUTH_PASSWORD` は
    // ここでは `BASIC_AUTH_PASSWORD` として現れる）。`passwordVariableKey` も
    // 同様に `E2E#` を付けない素のキー名で、そのまま添字参照で一致する。
    const password = environmentVariables?.[basicAuth.passwordVariableKey]
    if (!password) {
      const message = `Basic auth password variable "${basicAuth.passwordVariableKey}" not found`
      logger.error(`[e2e_test] ${message} [${executionId}]`)
      await reportExecutionStatus(
        client, tenantCode, projectCode, executionId,
        'error', Date.now() - startTime, message, testCaseId,
      )
      return errorResult(message)
    }
    httpCredentials = { username: basicAuth.username, password }
  }

  // プロジェクト共有サポートファイル（lib/ 等）の取得。環境変数取得の「失敗→error」とは
  // 意図的に異なり、取得失敗は実行エラーにしない（旧 API サーバー相手でも import を
  // 使わない spec は従来どおり動く必要があるため）。
  let supportFiles: E2eSupportFile[] = []
  try {
    supportFiles = await client.getE2eSupportFiles(tenantCode, projectCode)
  } catch (err: unknown) {
    logger.warn(
      `[e2e_test] Failed to fetch support files (continuing without them) [${executionId}]: ${toErrorMessage(err)}`,
    )
  }

  // captureStepScreenshots defaults to true; only an explicit `false`
  // (boolean or the string "false") disables the harness-level auto-capture.
  const captureStepScreenshots = parseBooleanDefaultTrue(params.payload.captureStepScreenshots)

  let subprocessResult
  try {
    subprocessResult = await runPlaywrightSubprocess({
      script: playwrightScript,
      executionId,
      baseUrl: targetUrl,
      envVars: environmentVariables,
      supportFiles,
      timeoutMs: undefined,
      captureStepScreenshots,
      httpCredentials,
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

  // Report each step. These per-step reports carry the RECOVERED partial
  // failures (the true cause on a timeout) to the API, so a failure here is not
  // cosmetic — it means real evidence may never reach the operator. Escalate to
  // logger.error with identifying context (matching reportExecutionStatus's own
  // error logging) and count the failures so the aggregate report can flag that
  // some recovered steps may be missing. Do not swallow at warn level.
  let stepReportFailures = 0
  // The first failure's reason (incl. HTTP status for AxiosErrors, e.g. a 413
  // body-size rejection) is surfaced in the aggregate errorMessage so an
  // operator can see WHY evidence is missing without reading agent logs.
  let firstStepReportFailureReason: string | undefined
  for (let i = 0; i < subprocessResult.steps.length; i++) {
    const step = subprocessResult.steps[i]
    try {
      await client.reportE2eTestStep(tenantCode, projectCode, executionId, {
        testCaseId,
        stepNumber: i + 1,
        action: step.title,
        status: step.status,
        ...(step.error && { error: step.error }),
        ...(step.skipReason && { skipReason: step.skipReason }),
        ...(step.duration !== undefined && { duration: step.duration }),
        ...(step.executedAt && { executedAt: step.executedAt }),
        ...(step.screenshotBase64 && { screenshotBase64: step.screenshotBase64 }),
        // screenshotPath is a local filesystem path that the API cannot access;
        // do not send it as screenshotUrl — omit it from the API payload entirely.
      })
    } catch (err: unknown) {
      stepReportFailures++
      // Bounded: a non-Axios error (or a huge server message) must not blow up
      // the log line or the aggregate errorMessage sent to the API.
      const reason = truncateWithinLimit(getErrorMessage(err), STEP_REPORT_FAILURE_REASON_MAX_LENGTH)
      firstStepReportFailureReason ??= reason
      logger.error(
        `[e2e_test] Failed to report playwright step ` +
          `[execution=${executionId} step=${i + 1} title="${step.title}" status=${step.status}]: ${reason}`,
      )
    }
  }

  const duration = Date.now() - startTime
  // On timeout the subprocess now resolves (no throw) so partial per-test
  // failures — reported as steps just above — are never lost. Reflect reality:
  // - passed → passed
  // - timed out WITH no recovered evidence (no steps) → error (nothing ran to
  //   completion; the errorOutput carries the timeout as the cause)
  // - otherwise (real failures, or a timeout WITH recovered partial results) →
  //   failed, with the timeout noted in errorOutput. No symptom hiding.
  // - passed BUT some per-step reports failed to persist → error (design 9.3:
  //   status=error / testOutcome=passed / evidenceStatus=incomplete). Showing
  //   "passed" while the evidence is missing is exactly the symptom-hiding we
  //   must avoid (dev: 3/3 step reports rejected with HTTP 413, yet "passed").
  const stepReportNote = stepReportFailures > 0
    ? `${stepReportFailures}/${subprocessResult.steps.length} step report(s) failed to persist`
    : undefined
  // A failed run with no steps at all never produced a test result (timeout
  // before anything finished, missing/unparsable JSON reporter output, ...):
  // that is an execution error, not a test failure (design 9.3 row 5).
  const producedNoResult = !subprocessResult.success && subprocessResult.steps.length === 0
  let finalStatus: string
  if (subprocessResult.success) {
    finalStatus = stepReportNote ? 'error' : 'passed'
  } else if (producedNoResult) {
    finalStatus = 'error'
  } else {
    finalStatus = 'failed'
  }

  // Build the aggregate errorMessage.
  // - Test passed, all step reports persisted → undefined (unchanged contract).
  // - Test passed, some step reports failed → the note itself plus the first
  //   failure reason (this is what turned the status into error above).
  // - Test failed → the failure output; if any step report failed, append the
  //   note and the first failure reason so an operator reading only the
  //   aggregate result knows some recovered evidence is missing and why.
  // Bounded: errorOutput is the raw Playwright stderr (unbounded). Only the
  // stderr part is cut (tail kept; a leading timeout note line is kept
  // verbatim), sized so that the note appended after it
  // (itself bounded via the 500-char reason) is never cut and the whole
  // message stays within the same limit reportExecutionStatus enforces.
  let errorMessage: string | undefined
  if (subprocessResult.success) {
    errorMessage = stepReportNote
      ? `Tests passed but ${stepReportNote}; evidence is incomplete (first failure: ${firstStepReportFailureReason})`
      : undefined
  } else {
    const note = stepReportNote
      ? ` (${stepReportNote}; first failure: ${firstStepReportFailureReason})`
      : ''
    const output = subprocessResult.errorOutput
      ?? (producedNoResult
        ? 'Playwright subprocess produced no test results'
        : `${subprocessResult.failedTests} test(s) failed`)
    errorMessage = boundErrorOutput(output, E2E_ERROR_MESSAGE_MAX_LENGTH - note.length) + note
  }

  // Design 9.3: carry the test's own outcome separately from the execution
  // status. testOutcome is omitted when the test never produced a result.
  // evidenceStatus is sent ONLY as 'incomplete' (a step report was rejected,
  // the run timed out, or there is no evidence at all): 'complete' is reserved for the API after
  // the S3 manifest check (phase C), so in phase A it is never sent and an
  // absent value means legacy. Older API versions without these DTO fields
  // strip them (whitelist), which is harmless.
  const testOutcome = subprocessResult.success
    ? 'passed'
    : producedNoResult ? undefined : 'failed'
  // A timeout means the run was cut short: even recovered partial results are
  // not the full evidence.
  const evidenceIncomplete = stepReportNote !== undefined || producedNoResult || Boolean(subprocessResult.timedOut)

  await reportExecutionStatus(
    client, tenantCode, projectCode, executionId,
    finalStatus, duration,
    errorMessage,
    testCaseId,
    // The step counters must match the API DTO (UpdateExecutionStatusDto)
    // names totalSteps/passedSteps/failedSteps — the subprocess executor's
    // *Tests counters are per-test.step() counts — otherwise
    // ValidationPipe({whitelist:true}) strips them and the execution's
    // totalSteps stays at its creation-time default of 0.
    {
      passedSteps: subprocessResult.passedTests,
      failedSteps: subprocessResult.failedTests,
      totalSteps: subprocessResult.totalTests,
      ...(testOutcome && { testOutcome }),
      ...(evidenceIncomplete && { evidenceStatus: 'incomplete' }),
    },
  )

  logger.info(
    `[e2e_test] Playwright subprocess completed [${executionId}]: status=${finalStatus}, duration=${duration}ms` +
      (stepReportNote ? `, ${stepReportNote}` : ''),
  )

  return successResult({
    executionId,
    status: finalStatus,
    duration,
    passedTests: subprocessResult.passedTests,
    failedTests: subprocessResult.failedTests,
    totalTests: subprocessResult.totalTests,
    ...(errorMessage && { errorMessage }),
  })
}

/** AI実行モード（従来のフロー） */
async function executeAiMode(
  options: ExecuteE2eTestOptions,
  params: {
    /** Validated non-empty at the entry point (executeE2eTest). */
    tenantCode: string
    projectCode: string
    executionId: string
    testCaseId?: string
    scenario: string
    targetUrl?: string
    credentialId?: string
    playwrightScript?: string
    startTime: number
  },
): Promise<CommandResult> {
  const { client, commandId } = options
  const { tenantCode, projectCode, executionId, testCaseId, scenario, targetUrl, credentialId, playwrightScript, startTime } = params

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
      // AI mode keeps its chat context on the config-synced project (same
      // source as executeChatCommand); redesigned in phase F.
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
      ...forwardAgentExecutionContext(options),
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
  /** Validated non-empty at the entry point (executeE2eTest). */
  tenantCode: string
  projectCode: string
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
    client, tenantCode, projectCode, executionId, testCaseId, playwrightScript, startTime,
  } = params

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
  tenantCode: string,
  projectCode: string,
  executionId: string,
  status: string,
  duration?: number,
  errorMessage?: string,
  testCaseId?: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await client.updateE2eExecutionStatus(
      tenantCode,
      projectCode,
      executionId,
      {
        status,
        ...(duration !== undefined && { duration }),
        // Single choke point for every mode (subprocess/script/ai): the
        // message can embed unbounded stderr, and a multi-MB body would make
        // this update fail with 413. Tail kept (the failure is at the end).
        ...(errorMessage && { errorMessage: truncateKeepingTail(errorMessage, E2E_ERROR_MESSAGE_MAX_LENGTH) }),
        ...(testCaseId && { testCaseId }),
        ...extra,
      },
    )
  } catch (err: unknown) {
    // This report carries the execution's outcome (status + step aggregates)
    // and is what drives the API-side alarm/notification workflow. A failure
    // here must be loud: non-retryable 4xx (e.g. a DTO whitelist/validation
    // mismatch — the same class of bug that silently left totalSteps at 0) are
    // never retried by RetryStrategy, so warning-only would let the execution
    // stay stuck as "running" with no signal to anyone. Log at error level with
    // identifying context and the API's own message (getErrorMessage surfaces
    // the HTTP status and server-side validation message for AxiosErrors).
    logger.error(
      `[e2e_test] Failed to report execution status (status=${status}) ` +
        `[execution=${executionId} tenant=${tenantCode} project=${projectCode}]: ${getErrorMessage(err)}`,
    )
  }
}
