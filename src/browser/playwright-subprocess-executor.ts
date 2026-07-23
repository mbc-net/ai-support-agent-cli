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
            // step. Screenshots attached via testInfo.attach() inside a step
            // are flattened onto the test's `attachments` array (not nested
            // under the step), so they are matched back to steps positionally
            // (Nth test.step() call <-> Nth image/png attachment).
            const testStartTimeMs = Date.parse(String(lastResult.startTime ?? ''))
            const imageAttachments = (
              Array.isArray(lastResult.attachments)
                ? (lastResult.attachments as Array<Record<string, unknown>>)
                : []
            ).filter((a) => a.contentType === 'image/png')

            // Screenshots are matched back to steps purely positionally (Nth
            // test.step() call <-> Nth image/png attachment) since Playwright
            // flattens attachments onto the test, not the step. If the
            // counts don't line up — e.g. the generated script (outside this
            // repo) skipped or double-called attach() in some step — that
            // positional mapping is no longer trustworthy for ANY step, not
            // just the tail. Silently misattributing a screenshot to the
            // wrong step is worse than reporting none, so skip the
            // association entirely and only warn.
            const countsMismatch =
              imageAttachments.length !== 0 && imageAttachments.length !== nestedSteps.length
            if (countsMismatch) {
              logger.warn(
                `[playwright-subprocess] Screenshot/step count mismatch for a test: ${nestedSteps.length} step(s) but ${imageAttachments.length} image attachment(s). Screenshots will not be attached to avoid mismatched association.`,
              )
            }

            let cumulativeMs = 0
            nestedSteps.forEach((nestedStep, idx) => {
              const stepDuration = typeof nestedStep.duration === 'number' ? nestedStep.duration : 0
              const stepError = nestedStep.error as Record<string, unknown> | undefined
              const executedAt = Number.isFinite(testStartTimeMs)
                ? new Date(testStartTimeMs + cumulativeMs).toISOString()
                : undefined
              const attachment = countsMismatch ? undefined : imageAttachments[idx]
              const screenshotBase64 =
                attachment && typeof attachment.body === 'string' ? attachment.body : undefined

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
  const { script, executionId, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, envVars, supportFiles } = options

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

    // Run Playwright subprocess
    const errorOutput = await spawnPlaywright(
      specFile, configFile, resultFile, baseUrl, timeoutMs, envVars, executionId,
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
      stderrOutput += chunk.toString()
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
