/**
 * PlaywrightSubprocessExecutor — runs a Playwright test script in a child process.
 *
 * Unlike browser-script-executor which reuses the shared browser session,
 * this executor spawns an isolated Playwright browser process so E2E tests
 * do not interfere with the agent's interactive browser session.
 */

import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { filterEnvVarsOverride } from '../env-vars-filter'
import { logger } from '../logger'
import type { E2eSupportFile } from '../types'

export interface PlaywrightSubprocessOptions {
  script: string
  executionId: string
  baseUrl?: string
  timeoutMs?: number
  envVars?: Record<string, string>
  /**
   * プロジェクト共有のサポートファイル（例: `lib/login.page.ts`）。
   * 実行ごとの専用ディレクトリ（runDir）へ相対パスのまま展開され、
   * spec 本体から相対 import できるようになる。
   */
  supportFiles?: E2eSupportFile[]
  /**
   * 各 `test.step()` ごとにハーネス側でフルページのスクリーンショットを
   * 自動取得するか（既定: true）。true の場合、生成スクリプトが
   * `testInfo.attach()` を呼んでいなくても、プリロードモジュール
   * （`STEP_SCREENSHOT_PATCH_TEMPLATE`）を `NODE_OPTIONS=--require` で
   * 注入し、トップレベルの各ステップ後に自動でスクリーンショットを添付する。
   * false の場合はプリロードを注入しない。
   */
  captureStepScreenshots?: boolean
}

export interface PlaywrightSubprocessStepResult {
  title: string
  status: 'passed' | 'failed' | 'skipped'
  error?: string
  duration?: number
  /** @deprecated Local filesystem path — kept only for backward compatibility. Prefer `screenshotBase64`. */
  screenshotPath?: string
  /** ISO timestamp of when this step ran, derived from the test's startTime plus cumulative prior step durations. */
  executedAt?: string
  /** Base64-encoded PNG captured via `testInfo.attach()` inside the corresponding `test.step()` call. */
  screenshotBase64?: string
}

export interface PlaywrightSubprocessResult {
  success: boolean
  totalTests: number
  passedTests: number
  failedTests: number
  steps: PlaywrightSubprocessStepResult[]
  errorOutput?: string
}

/** Default timeout for subprocess execution (120 seconds) */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Attachment-name prefix used by the harness step-screenshot preload. Each
 * auto-captured screenshot is attached as `${HARNESS_STEP_SCREENSHOT_PREFIX}<index>`
 * where `<index>` is the 0-based top-level `test.step()` call order. Both the
 * preload template (which writes the name) and `parsePlaywrightJsonOutput`
 * (which reads it back) share this single constant so the two never drift.
 */
export const HARNESS_STEP_SCREENSHOT_PREFIX = 'harness-step-screenshot-'

/**
 * Env keys this module sets internally for the subprocess. `envVars` may not
 * override these — doing so could redirect JSON output or hijack the target URL.
 *
 * This is a module-specific layer on top of `filterEnvVarsOverride`: these
 * keys are not dangerous in general (they're not in the shared denylist),
 * they're only reserved because this module itself assigns them below.
 */
const RESERVED_ENV_KEYS = new Set(['E2E_JSON_OUTPUT', 'E2E_BASE_URL'])

/**
 * Merge user-supplied environment variables into the subprocess env in place.
 *
 * All entries are first passed through the shared `filterEnvVarsOverride`
 * denylist (blocks `NODE_OPTIONS`, `LD_PRELOAD`, `PLAYWRIGHT_BROWSERS_PATH`,
 * `PATH`, etc. — see `src/env-vars-filter.ts`), then this module's own
 * reserved keys (`E2E_JSON_OUTPUT`/`E2E_BASE_URL`, which this function itself
 * sets below) are stripped as a second layer.
 */
function mergeEnvVars(
  env: NodeJS.ProcessEnv,
  envVars: Record<string, string> | undefined,
  executionId: string,
): void {
  if (!envVars) return
  const prefix = `[playwright-subprocess:${executionId}]`
  const filtered = filterEnvVarsOverride(envVars, { prefix })
  for (const [key, value] of Object.entries(filtered)) {
    if (RESERVED_ENV_KEYS.has(key)) {
      logger.warn(`${prefix} Ignoring reserved environment variable key: "${key}"`)
      continue
    }
    env[key] = value
  }
}

/**
 * Parse Playwright JSON reporter output into a structured result.
 * Expected format: { suites: [{ specs: [{ tests: [{ results: [...] }] }] }] }
 */
function parsePlaywrightJsonOutput(jsonContent: string): PlaywrightSubprocessResult {
  let report: Record<string, unknown>
  try {
    report = JSON.parse(jsonContent) as Record<string, unknown>
  } catch {
    return {
      success: false,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
      errorOutput: 'Failed to parse Playwright JSON output',
    }
  }

  const steps: PlaywrightSubprocessStepResult[] = []
  let passedTests = 0
  let failedTests = 0

  const collectSpecs = (suite: Record<string, unknown>): void => {
    const specs = suite.specs as Array<Record<string, unknown>> | undefined
    if (Array.isArray(specs)) {
      for (const spec of specs) {
        const tests = spec.tests as Array<Record<string, unknown>> | undefined
        if (!Array.isArray(tests)) continue

        for (const test of tests) {
          const testTitle = String(spec.title ?? test.title ?? 'unknown')
          const results = test.results as Array<Record<string, unknown>> | undefined
          if (!Array.isArray(results) || results.length === 0) continue

          // Use the last result (most recent retry)
          const lastResult = results[results.length - 1]
          const nestedSteps = lastResult.steps as Array<Record<string, unknown>> | undefined

          if (Array.isArray(nestedSteps) && nestedSteps.length > 0) {
            // test.step() was used: each nested step becomes its own reported
            // step. The harness preload flattens one screenshot per top-level
            // step onto the test's `attachments` array, named
            // `${HARNESS_STEP_SCREENSHOT_PREFIX}<index>` (index = 0-based
            // top-level step call order, which matches steps[] position because
            // skipped steps also consume an index in the preload).
            const testStartTimeMs = Date.parse(String(lastResult.startTime ?? ''))
            const imageAttachments = (
              Array.isArray(lastResult.attachments)
                ? (lastResult.attachments as Array<Record<string, unknown>>)
                : []
            ).filter((a) => a.contentType === 'image/png')

            // Preferred path: map each step to its screenshot by the index
            // embedded in the harness attachment name. Because the mapping is
            // by index, a step whose capture is missing (skipped, page closed,
            // capture error) degrades only that one step — the rest of the
            // test's screenshots are unaffected.
            const indexedBodyByStep = new Map<number, string>()
            for (const att of imageAttachments) {
              const name = typeof att.name === 'string' ? att.name : ''
              if (!name.startsWith(HARNESS_STEP_SCREENSHOT_PREFIX)) continue
              const parsedIndex = Number.parseInt(name.slice(HARNESS_STEP_SCREENSHOT_PREFIX.length), 10)
              if (Number.isInteger(parsedIndex) && parsedIndex >= 0 && typeof att.body === 'string') {
                indexedBodyByStep.set(parsedIndex, att.body)
              }
            }

            // Hooks-inflation guard: `test.step()` invoked inside a
            // beforeEach/afterEach hook consumes a harness index but does NOT
            // appear in `lastResult.steps` (nestedSteps = the test BODY's
            // top-level steps only). That inflates the harness index space, so
            // an index would no longer line up with a body step and every body
            // step would map to the WRONG screenshot. If the highest index we
            // saw is beyond the body-step range, the mapping is untrustworthy —
            // drop all screenshots for this test rather than misattribute.
            //
            // This does NOT false-trigger on test.step.skip: a skipped
            // top-level step consumes an index AND appears in nestedSteps, so
            // the seen indices stay a subset of [0, nestedSteps.length) and the
            // max index stays < nestedSteps.length (the skipped step just has no
            // screenshot of its own).
            let maxIndexedKey = -1
            for (const key of indexedBodyByStep.keys()) {
              if (key > maxIndexedKey) maxIndexedKey = key
            }
            const indexSpaceInflated =
              indexedBodyByStep.size > 0 && maxIndexedKey >= nestedSteps.length
            if (indexSpaceInflated) {
              logger.warn(
                `[playwright-subprocess] Harness screenshot index out of range for test "${testTitle}": ${nestedSteps.length} step(s) but saw index ${maxIndexedKey} (likely test.step() used inside a beforeEach/afterEach hook). Screenshots will not be attached to avoid misattribution.`,
              )
            }
            const hadIndexed = indexedBodyByStep.size > 0
            const useIndexed = hadIndexed && !indexSpaceInflated

            // Backward-compat fallback: only when there were NO harness-indexed
            // attachments at all but there ARE plain image/png attachments
            // (captureStepScreenshots:false with a spec that self-attaches per
            // step, or older output). Fall back to the original positional
            // mapping (Nth step <-> Nth image) with its count-mismatch safety
            // guard — a mismatch there is untrustworthy for ANY step, so drop
            // the association and only warn.
            //
            // Deliberately keyed off `hadIndexed` (not `useIndexed`): when the
            // hooks-inflation guard fired we DROP screenshots, and must NOT then
            // fall back to positional (which is equally wrong under inflation).
            const positionalAttachments = hadIndexed ? [] : imageAttachments
            const positionalCountsMismatch =
              !hadIndexed &&
              positionalAttachments.length !== 0 &&
              positionalAttachments.length !== nestedSteps.length
            if (positionalCountsMismatch) {
              logger.warn(
                `[playwright-subprocess] Screenshot/step count mismatch for test "${testTitle}": ${nestedSteps.length} step(s) but ${positionalAttachments.length} image attachment(s). Screenshots will not be attached to avoid mismatched association.`,
              )
            }

            let cumulativeMs = 0
            nestedSteps.forEach((nestedStep, idx) => {
              const stepDuration = typeof nestedStep.duration === 'number' ? nestedStep.duration : 0
              const stepError = nestedStep.error as Record<string, unknown> | undefined
              const executedAt = Number.isFinite(testStartTimeMs)
                ? new Date(testStartTimeMs + cumulativeMs).toISOString()
                : undefined

              let screenshotBase64: string | undefined
              if (useIndexed) {
                screenshotBase64 = indexedBodyByStep.get(idx)
              } else if (!positionalCountsMismatch) {
                const attachment = positionalAttachments[idx]
                screenshotBase64 =
                  attachment && typeof attachment.body === 'string' ? attachment.body : undefined
              }

              steps.push({
                title: String(nestedStep.title ?? 'unknown'),
                status: stepError ? 'failed' : 'passed',
                ...(stepError && { error: String(stepError.message ?? '') }),
                duration: stepDuration,
                ...(executedAt && { executedAt }),
                ...(screenshotBase64 && { screenshotBase64 }),
              })

              cumulativeMs += stepDuration
              if (stepError) {
                failedTests++
              } else {
                passedTests++
              }
            })
          } else {
            // Legacy fallback for specs that do not use test.step(): report
            // the whole test as a single step (unchanged from before nested
            // step-level reporting was introduced).
            const status = String(lastResult.status ?? 'failed')
            const duration = typeof lastResult.duration === 'number' ? lastResult.duration : undefined

            let errorMessage: string | undefined
            const error = lastResult.error as Record<string, unknown> | undefined
            if (error) {
              errorMessage = String(error.message ?? '')
            }

            // Extract screenshot path from attachments
            let screenshotPath: string | undefined
            const attachments = lastResult.attachments as Array<Record<string, unknown>> | undefined
            if (Array.isArray(attachments)) {
              const screenshotAttachment = attachments.find(
                (a) => a.name === 'screenshot' && a.contentType === 'image/png',
              )
              if (screenshotAttachment && screenshotAttachment.path) {
                screenshotPath = String(screenshotAttachment.path)
              }
            }

            const stepStatus =
              status === 'passed' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed'

            steps.push({
              title: testTitle,
              status: stepStatus,
              ...(errorMessage && { error: errorMessage }),
              ...(duration !== undefined && { duration }),
              ...(screenshotPath && { screenshotPath }),
            })

            if (stepStatus === 'passed') {
              passedTests++
            } else if (stepStatus === 'failed') {
              failedTests++
            }
          }
        }
      }
    }

    const nestedSuites = suite.suites as Array<Record<string, unknown>> | undefined
    if (Array.isArray(nestedSuites)) {
      for (const nestedSuite of nestedSuites) {
        collectSpecs(nestedSuite)
      }
    }
  }

  const suites = report.suites as Array<Record<string, unknown>> | undefined
  if (Array.isArray(suites)) {
    for (const suite of suites) {
      collectSpecs(suite)
    }
  }

  const totalTests = passedTests + failedTests + steps.filter((s) => s.status === 'skipped').length

  return {
    success: failedTests === 0 && totalTests > 0,
    totalTests,
    passedTests,
    failedTests,
    steps,
  }
}

/**
 * Per-run Playwright config written into the run directory.
 *
 * Mirrors the settings of the repo-level `playwright.subprocess.config.js`
 * (timeout, use.headless/trace/baseURL, JSON reporter, workers), except
 * `testDir` points at the run directory itself (`__dirname`) so the spec
 * can relative-import support files expanded alongside it, and `use.screenshot`
 * is intentionally `'off'` here (see comment below) instead of the mirrored
 * file's `'only-on-failure'`.
 */
const RUN_CONFIG_TEMPLATE = `const path = require('path')
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: __dirname,
  // Playwright's default outputDir ('test-results') resolves relative to the
  // CHILD PROCESS's cwd, not this config file's directory — confirmed
  // experimentally. Without this, trace/artifact output leaks into whatever
  // directory the agent process happened to be started from instead of the
  // per-execution runDir, and is never cleaned up by cleanupRunDir.
  outputDir: path.join(__dirname, 'test-results'),
  timeout: 120_000,
  use: {
    headless: true,
    // Screenshots are captured explicitly inside test.step() via
    // testInfo.attach(), so Playwright's own automatic screenshot capture
    // is disabled here to avoid duplicate/unassociated screenshots.
    screenshot: 'off',
    trace: 'retain-on-failure',
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
  reporter: [['json', { outputFile: process.env.E2E_JSON_OUTPUT ?? path.join(__dirname, 'result.json') }]],
  workers: 1,
})
`

/** Filename of the preload patch module written into the run directory. */
const STEP_SCREENSHOT_PATCH_FILENAME = 'step-screenshot-patch.js'

/**
 * Preload module injected into the Playwright subprocess via
 * `NODE_OPTIONS=--require`. It monkeypatches `@playwright/test` so that after
 * every TOP-LEVEL `test.step()` a fullPage screenshot is auto-attached via
 * `testInfo.attach()`, WITHOUT the spec itself having to call `testInfo`/`attach`.
 *
 * This makes step-level screenshots a property of the HARNESS, not of the
 * generated script: git-synced / hand-authored specs that never call
 * `testInfo.attach()` still get one screenshot per step.
 *
 * Robust index-based mapping: every top-level step is assigned a 0-based index
 * SYNCHRONOUSLY at the start of the wrapper (in call order, so it is stable even
 * under `Promise.all`), and its screenshot is attached as
 * `${HARNESS_STEP_SCREENSHOT_PREFIX}<index>`. Skipped top-level steps also
 * consume an index (they still occupy a slot in Playwright's `steps[]` array),
 * so `parsePlaywrightJsonOutput` can map each step to its own screenshot by
 * index. A missing capture (skip / closed page / capture error) therefore
 * degrades only that one step instead of dropping the whole test's screenshots.
 *
 * The harness ALWAYS captures once per top-level step, on both success and
 * failure. Note: a generated spec that STILL self-attaches its own screenshot
 * per step now produces a redundant extra image; that is expected and harmless
 * (the parser only reads harness-indexed names). Screenshot capture never fails
 * the step (try/catch; diagnostics go to stderr as `[step-screenshot] ...` and
 * the parent process routes those to `logger.warn`).
 *
 * Multi-page: the fixture tracks the most-recently-opened page (popups/tabs),
 * but if that tracked page has been closed (e.g. an OAuth popup that opened then
 * closed) the capture falls back to the still-open initial fixture page instead
 * of silently skipping every subsequent step's screenshot.
 *
 * Written as a self-contained CommonJS module (requires `@playwright/test` at
 * runtime inside the subprocess) so it can be `--require`d before the spec.
 */
const STEP_SCREENSHOT_PATCH_TEMPLATE = `// AUTO-GENERATED by playwright-subprocess-executor. Preloaded via
// NODE_OPTIONS=--require to auto-attach an INDEXED fullPage screenshot after
// each top-level test.step(), independent of the generated spec.
const { AsyncLocalStorage } = require('async_hooks')
const pw = require('@playwright/test')

// Most-recently-active page per test (see the auto fixture below).
const pageByTestInfo = new WeakMap()
// The initial fixture page per test, used as a fallback when the tracked
// "newest" page has since been closed (e.g. an OAuth popup opened then closed).
const initialPageByTestInfo = new WeakMap()
// Next 0-based index to assign to a test's next TOP-LEVEL step.
const nextStepIndexByTestInfo = new WeakMap()

// AsyncLocalStorage tracks step nesting per async context. Nested steps must
// neither consume an index nor be screenshotted; only top-level steps do. A
// shared module-level counter would misbehave under parallel top-level steps
// (Promise.all) — ALS answers "am I nested?" from the enclosing async context,
// which is parallel- and throw-safe.
const als = new AsyncLocalStorage()

// Extend \`test\` with an auto fixture that records the active page keyed by the
// current testInfo, so the patched step can screenshot the right page.
const patched = pw.test.extend({
  _autoScreenshotPage: [
    async ({ page }, use) => {
      const testInfo = pw.test.info()
      pageByTestInfo.set(testInfo, page)
      initialPageByTestInfo.set(testInfo, page)
      // Best-effort "newest page" heuristic: if the spec opens additional pages
      // (popup / new tab), capture the most recently opened one. The initial
      // page stays the default until another opens. This tracker never reverts
      // on its own — the capture logic falls back to the initial page when the
      // tracked page turns out to be closed (see pickCapturePage).
      page.context().on('page', (p) => {
        pageByTestInfo.set(testInfo, p)
      })
      await use(page)
    },
    { auto: true },
  ],
})

// Assign and consume the next top-level index for a test (synchronous).
function consumeStepIndex(testInfo) {
  const i = nextStepIndexByTestInfo.get(testInfo) || 0
  nextStepIndexByTestInfo.set(testInfo, i + 1)
  return i
}

// Choose the page to screenshot. Prefer the tracked "newest" page, but if it
// has been closed (e.g. a popup that opened then closed), fall back to the
// initial fixture page when that is still open. Returns { page, fellBack } or
// null when neither page is usable. Never throws.
function pickCapturePage(testInfo) {
  const tracked = pageByTestInfo.get(testInfo)
  if (tracked && !tracked.isClosed()) {
    return { page: tracked, fellBack: false }
  }
  const initial = initialPageByTestInfo.get(testInfo)
  if (initial && initial !== tracked && !initial.isClosed()) {
    return { page: initial, fellBack: true }
  }
  return null
}

const origStep = patched.step
function patchedStep(title, body, opts) {
  return origStep.call(
    pw.test,
    title,
    async (...args) => {
      const nested = als.getStore() === true
      const testInfo = pw.test.info()
      // Assign this step's index SYNCHRONOUSLY (before any await) so it matches
      // the call order of top-level steps, including inside Promise.all.
      const index = nested ? -1 : consumeStepIndex(testInfo)
      let result
      let error
      let threw = false
      try {
        result = nested ? await body(...args) : await als.run(true, () => body(...args))
      } catch (e) {
        threw = true
        error = e
      }
      if (!nested) {
        // ALWAYS capture one indexed screenshot per top-level step, on both
        // success and failure (the failed-step screenshot is the most useful
        // for debugging). The parser maps by index, so a missing capture
        // degrades only this step rather than dropping the whole test's.
        try {
          const picked = pickCapturePage(testInfo)
          if (picked) {
            if (picked.fellBack) {
              // Observable (routed to logger.warn by the parent process) so a
              // closed-popup situation is visible in normal runs.
              console.error(
                '[step-screenshot] tracked page closed, fell back to initial page for step ' + index,
              )
            }
            const buf = await picked.page.screenshot({ fullPage: true })
            await testInfo.attach('${HARNESS_STEP_SCREENSHOT_PREFIX}' + index, {
              body: buf,
              contentType: 'image/png',
            })
          }
        } catch (e) {
          // Never fail the step because of screenshot capture, but make the
          // failure observable rather than silently swallowed.
          console.error(
            '[step-screenshot] capture failed for step "' + title + '" (index ' + index + '): ' + ((e && e.message) || e),
          )
        }
      }
      if (threw) throw error
      return result
    },
    opts,
  )
}

// Preserve the original step's own sub-properties (notably test.step.skip),
// which a bare function replacement would otherwise drop.
const origSkip = origStep.skip
Object.assign(patchedStep, origStep)
// A skipped TOP-LEVEL step is still listed in Playwright's steps[] array, so it
// must consume an index (without screenshotting) to keep executed steps aligned
// with their steps[] position. Nested skips do not consume a top-level index.
if (typeof origSkip === 'function') {
  patchedStep.skip = function (title, body, opts) {
    if (als.getStore() !== true) {
      consumeStepIndex(pw.test.info())
    }
    return origSkip.call(pw.test, title, body, opts)
  }
}
patched.step = patchedStep

pw.test = patched
module.exports = pw
`

/**
 * Resolve a support file's relative path against the run directory,
 * rejecting any path that would escape it (path traversal defense).
 *
 * The API validates paths server-side too, but the agent re-validates at
 * its own trust boundary: reject any path containing `..` outright, then
 * verify the resolved destination stays inside the run directory (this
 * also rejects absolute paths).
 */
function resolveSupportFilePath(runDir: string, relativePath: string): string {
  if (relativePath.includes('..')) {
    throw new Error(`Invalid support file path (contains ".."): "${relativePath}"`)
  }
  const dest = path.resolve(runDir, relativePath)
  if (!dest.startsWith(runDir + path.sep)) {
    throw new Error(`Invalid support file path (escapes run directory): "${relativePath}"`)
  }
  return dest
}

/**
 * Run a Playwright test script in a child process.
 *
 * Expands the spec, an optional set of project support files, and a per-run
 * Playwright config into a dedicated run directory under the OS temp dir,
 * executes the spec via the Playwright CLI, and parses the JSON reporter
 * output. The run directory is always cleaned up.
 */
export async function runPlaywrightSubprocess(
  options: PlaywrightSubprocessOptions,
): Promise<PlaywrightSubprocessResult> {
  const {
    script,
    executionId,
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    envVars,
    supportFiles,
    captureStepScreenshots = true,
  } = options

  // Sanitize executionId to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(executionId)) {
    throw new Error(
      `Invalid executionId: "${executionId}" — must be alphanumeric, hyphens, or underscores only`,
    )
  }
  const runDir = path.resolve(os.tmpdir(), `ai-support-e2e-${executionId}`)
  const specFile = path.join(runDir, 'test.spec.ts')
  const configFile = path.join(runDir, 'playwright.config.js')
  const resultFile = path.join(runDir, 'result.json')

  try {
    await fs.mkdir(runDir, { recursive: true })

    // Expand support files first so the spec and config (written below)
    // always win if a support file path collides with them.
    for (const file of supportFiles ?? []) {
      const dest = resolveSupportFilePath(runDir, file.path)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.writeFile(dest, file.content, 'utf-8')
    }

    // Write the test script and the per-run Playwright config
    await fs.writeFile(specFile, script, 'utf-8')
    await fs.writeFile(configFile, RUN_CONFIG_TEMPLATE, 'utf-8')

    // Write the harness-level step-screenshot preload module unless disabled.
    // When present, its path is injected into the child's NODE_OPTIONS below.
    let patchModulePath: string | undefined
    if (captureStepScreenshots) {
      patchModulePath = path.join(runDir, STEP_SCREENSHOT_PATCH_FILENAME)
      await fs.writeFile(patchModulePath, STEP_SCREENSHOT_PATCH_TEMPLATE, 'utf-8')
    }

    // Run Playwright subprocess
    const errorOutput = await spawnPlaywright(
      specFile, configFile, resultFile, baseUrl, timeoutMs, envVars, executionId, patchModulePath,
    )

    // Read and parse the JSON output
    let jsonContent: string
    try {
      jsonContent = await fs.readFile(resultFile, 'utf-8')
    } catch {
      logger.warn(`[playwright-subprocess] JSON output not found for execution ${executionId}`)
      return {
        success: false,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        steps: [],
        errorOutput: errorOutput || 'Playwright did not produce JSON output',
      }
    }

    const result = parsePlaywrightJsonOutput(jsonContent)
    if (errorOutput && !result.success) {
      return { ...result, errorOutput }
    }
    return result
  } finally {
    // Always clean up the entire run directory
    await cleanupRunDir(runDir)
  }
}

/**
 * Spawn the Playwright CLI process and wait for it to finish.
 * Returns stderr output (empty string on success).
 */
function spawnPlaywright(
  specFile: string,
  configFile: string,
  resultFile: string,
  baseUrl: string | undefined,
  timeoutMs: number,
  envVars: Record<string, string> | undefined,
  executionId: string,
  patchModulePath: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Resolve the agent's bundled node_modules so the spec can import @playwright/test
    const agentRootDir = path.join(__dirname, '..', '..')
    const nodeModulesDir = path.join(agentRootDir, 'node_modules')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_JSON_OUTPUT: resultFile,
      NODE_PATH: nodeModulesDir,
    }
    if (baseUrl) {
      env.E2E_BASE_URL = baseUrl
    }
    mergeEnvVars(env, envVars, executionId)

    // Inject the harness step-screenshot preload via NODE_OPTIONS, preserving
    // any pre-existing NODE_OPTIONS. This is set AFTER mergeEnvVars so it wins:
    // user-supplied NODE_OPTIONS is denylisted (see env-vars-filter) and can
    // never reach here, so only the module's own value is present.
    if (patchModulePath) {
      const existing = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''
      // Quote the path so a temp dir containing a space (e.g. Windows
      // "C:\\Users\\John Smith\\...\\Temp") does not break Node startup and
      // fail every E2E run on that machine. Node parses quoted NODE_OPTIONS
      // values correctly.
      env.NODE_OPTIONS = `${existing}--require "${patchModulePath}"`
    }

    const args = [
      'test',
      specFile,
      '--config',
      configFile,
    ]

    const playwrightBin = path.join(nodeModulesDir, '.bin', 'playwright')

    logger.info(
      `[playwright-subprocess] Spawning: ${playwrightBin} ${args.join(' ')}`,
    )

    const child = spawn(playwrightBin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderrOutput = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      // Accumulate for the error-return path (unchanged), but ALSO forward in
      // real time regardless of exit code — otherwise diagnostics the preload
      // writes to stderr are discarded on a passing test, since stderrOutput is
      // only surfaced when the child exits non-zero.
      stderrOutput += text
      // Route per line: the harness preload's "[step-screenshot] ..." messages
      // (capture failure / page-closed fallback) must be visible in normal
      // operation, so they go to logger.warn; logger.debug is gated behind
      // --verbose and would hide them. Routine Playwright stderr stays at debug
      // to avoid spamming warn.
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.includes('[step-screenshot]')) {
          logger.warn(`[playwright-subprocess] stderr: ${trimmed}`)
        } else {
          logger.debug(`[playwright-subprocess] stderr: ${trimmed}`)
        }
      }
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.debug(`[playwright-subprocess] stdout: ${chunk.toString().trim()}`)
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      logger.warn(`[playwright-subprocess] Timeout after ${timeoutMs}ms, killing process`)
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`Playwright subprocess timed out after ${timeoutMs}ms`))
        return
      }
      // Playwright exits with non-zero on test failures, which is expected
      // We resolve in all cases and let the JSON output determine success
      logger.info(`[playwright-subprocess] Process exited with code ${code}`)
      resolve(code !== 0 ? stderrOutput : '')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Remove the run directory recursively, ignoring cleanup errors */
async function cleanupRunDir(runDir: string): Promise<void> {
  try {
    await fs.rm(runDir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup — ignore
  }
}

/** Exported for testing */
export { parsePlaywrightJsonOutput }
