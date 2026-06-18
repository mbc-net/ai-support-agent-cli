import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

export interface PlaywrightRunnerResult {
  success: boolean
  passed: number
  failed: number
  skipped: number
  totalSteps: number
  results: PlaywrightTestResult[]
  errorOutput?: string
}

export interface PlaywrightTestResult {
  title: string
  status: 'passed' | 'failed' | 'skipped' | 'timedOut'
  duration: number
  error?: string
}

interface PlaywrightJsonSpec {
  title?: string
  tests?: Array<{
    results?: Array<{
      status: string
      duration: number
      errors?: Array<{ message?: string }>
    }>
  }>
  suites?: PlaywrightJsonSuite[]
}

interface PlaywrightJsonSuite {
  specs?: PlaywrightJsonSpec[]
  suites?: PlaywrightJsonSuite[]
}

/**
 * Playwright JSON reporter output を再帰的に走査して TestResult を収集する。
 */
function collectSpecs(suite: PlaywrightJsonSuite, results: PlaywrightTestResult[]): void {
  for (const spec of suite.specs ?? []) {
    const title = spec.title ?? ''
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        const rawStatus = result.status
        const status: PlaywrightTestResult['status'] =
          rawStatus === 'passed' || rawStatus === 'failed' || rawStatus === 'timedOut'
            ? rawStatus
            : 'skipped'
        const errorMsg = result.errors?.[0]?.message
        results.push({
          title,
          status,
          duration: result.duration ?? 0,
          ...(errorMsg ? { error: errorMsg } : {}),
        })
      }
    }
    for (const nested of spec.suites ?? []) {
      collectSpecs(nested, results)
    }
  }
  for (const nested of suite.suites ?? []) {
    collectSpecs(nested, results)
  }
}

interface ExtractedResults {
  results: PlaywrightTestResult[]
  passed: number
  failed: number
  skipped: number
}

function extractResults(json: PlaywrightJsonSuite): ExtractedResults {
  const results: PlaywrightTestResult[] = []
  collectSpecs(json, results)

  let passed = 0
  let failed = 0
  let skipped = 0

  for (const r of results) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed' || r.status === 'timedOut') failed++
    else skipped++
  }

  return { results, passed, failed, skipped }
}

/**
 * stdout から Playwright JSON 出力を探して返す。
 * JSON の前後に他のテキストが混入することがあるため、最初の '{' を起点に抽出を試みる。
 */
function parsePlaywrightJson(stdout: string): PlaywrightJsonSuite | null {
  const start = stdout.indexOf('{')
  if (start === -1) return null

  try {
    return JSON.parse(stdout.slice(start)) as PlaywrightJsonSuite
  } catch {
    return null
  }
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runPlaywrightProcess(
  agentRootDir: string,
  specFile: string,
  executionId: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const playwrightBin = path.join(agentRootDir, 'node_modules', '.bin', 'playwright')
    const configFile = path.join(agentRootDir, 'playwright.config.ts')
    const relativeSpec = path.relative(agentRootDir, specFile)

    logger.info(`[playwright-test-runner] Running test [${executionId}]: ${relativeSpec}`)

    const args = ['test', relativeSpec, '--reporter=json']
    if (fs.existsSync(configFile)) {
      args.push(`--config=${configFile}`)
    }

    const proc = spawn(playwrightBin, args, {
      cwd: agentRootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutData = ''
    let stderrData = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString()
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString()
    })

    proc.on('error', (err: Error) => {
      reject(err)
    })

    proc.on('close', (code: number | null) => {
      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        exitCode: code ?? 1,
      })
    })
  })
}

const VALID_EXECUTION_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Playwright テストスクリプトをサブプロセスで実行し、結果を返す。
 *
 * @param scriptContent - 実行する JavaScript テストコード
 * @param executionId   - ログ追跡用の実行 ID（英数字・ハイフン・アンダースコアのみ許可）
 * @param agentRootDir  - エージェントのルートディレクトリ（node_modules/.bin/playwright が存在する場所）
 */
export async function runPlaywrightScript(
  scriptContent: string,
  executionId: string,
  agentRootDir: string,
): Promise<PlaywrightRunnerResult> {
  if (!VALID_EXECUTION_ID.test(executionId)) {
    throw new Error(`Invalid executionId: must match /^[a-zA-Z0-9_-]+$/`)
  }

  const e2eDir = path.join(agentRootDir, 'tmp', 'e2e')
  fs.mkdirSync(e2eDir, { recursive: true })

  const specFile = path.join(e2eDir, `${executionId}.spec.js`)
  fs.writeFileSync(specFile, scriptContent, 'utf-8')

  try {
    const { stdout, stderr, exitCode } = await runPlaywrightProcess(agentRootDir, specFile, executionId)

    let results: PlaywrightTestResult[] = []
    let passed = 0
    let failed = 0
    let skipped = 0

    try {
      const jsonOutput = parsePlaywrightJson(stdout)
      if (jsonOutput) {
        const parsed = extractResults(jsonOutput)
        results = parsed.results
        passed = parsed.passed
        failed = parsed.failed
        skipped = parsed.skipped
      }
    } catch (parseErr) {
      logger.warn(`[playwright-test-runner] Failed to parse JSON output: ${getErrorMessage(parseErr)}`)
    }

    const success = exitCode === 0

    return {
      success,
      passed,
      failed,
      skipped,
      totalSteps: results.length,
      results,
      errorOutput: !success && stderr ? stderr : undefined,
    }
  } finally {
    try {
      fs.unlinkSync(specFile)
    } catch {
      // ignore cleanup errors
    }
  }
}
