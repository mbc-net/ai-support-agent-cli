/**
 * PlaywrightSubprocessExecutor — runs a Playwright test script in a child process.
 *
 * Unlike browser-script-executor which reuses the shared browser session,
 * this executor spawns an isolated Playwright browser process so E2E tests
 * do not interfere with the agent's interactive browser session.
 */

import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import * as path from 'path'

import { filterEnvVarsOverride } from '../env-vars-filter'
import { logger } from '../logger'

export interface PlaywrightSubprocessOptions {
  script: string
  executionId: string
  baseUrl?: string
  timeoutMs?: number
  envVars?: Record<string, string>
}

export interface PlaywrightSubprocessStepResult {
  title: string
  status: 'passed' | 'failed' | 'skipped'
  error?: string
  duration?: number
  screenshotPath?: string
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
 * Run a Playwright test script in a child process.
 *
 * Writes the script to a temp file, executes it via the Playwright CLI,
 * and parses the JSON reporter output. Temp files are always cleaned up.
 */
export async function runPlaywrightSubprocess(
  options: PlaywrightSubprocessOptions,
): Promise<PlaywrightSubprocessResult> {
  const { script, executionId, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, envVars } = options

  // Sanitize executionId to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(executionId)) {
    throw new Error(
      `Invalid executionId: "${executionId}" — must be alphanumeric, hyphens, or underscores only`,
    )
  }
  const tmpSpecFile = path.resolve('/tmp', `ai-support-e2e-${executionId}.spec.ts`)
  const tmpResultFile = path.resolve('/tmp', `ai-support-e2e-${executionId}-result.json`)
  // Verify paths are inside /tmp as a safety net
  if (!tmpSpecFile.startsWith('/tmp/') || !tmpResultFile.startsWith('/tmp/')) {
    throw new Error('Resolved tmp file path is outside /tmp directory')
  }

  try {
    // Write the test script to a temp file
    await fs.writeFile(tmpSpecFile, script, 'utf-8')

    // Run Playwright subprocess
    const errorOutput = await spawnPlaywright(
      tmpSpecFile, tmpResultFile, baseUrl, timeoutMs, envVars, executionId,
    )

    // Read and parse the JSON output
    let jsonContent: string
    try {
      jsonContent = await fs.readFile(tmpResultFile, 'utf-8')
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
    // Always clean up temp files
    await cleanupFile(tmpSpecFile)
    await cleanupFile(tmpResultFile)
  }
}

/**
 * Spawn the Playwright CLI process and wait for it to finish.
 * Returns stderr output (empty string on success).
 */
function spawnPlaywright(
  specFile: string,
  resultFile: string,
  baseUrl: string | undefined,
  timeoutMs: number,
  envVars: Record<string, string> | undefined,
  executionId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Find the config file relative to the spec file's project root
    const agentRootDir = path.join(__dirname, '..', '..')
    const configFile = path.join(agentRootDir, 'playwright.subprocess.config.js')
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

/** Remove a file, ignoring errors if it doesn't exist */
async function cleanupFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // File may not exist if Playwright failed early — ignore
  }
}

/** Exported for testing */
export { parsePlaywrightJsonOutput }
