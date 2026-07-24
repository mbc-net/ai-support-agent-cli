import { EventEmitter } from 'events'
import * as nodeFs from 'fs'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as childProcess from 'child_process'

import {
  runPlaywrightSubprocess,
  parsePlaywrightJsonOutput,
  HARNESS_STEP_SCREENSHOT_PREFIX,
} from '../../src/browser/playwright-subprocess-executor'

// Only child_process is mocked; file writes are verified against the real
// OS temp directory (spying on fs sync functions is a known trap in this repo).
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

const mockSpawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>

/** The per-execution run directory the executor is expected to use */
function runDirFor(executionId: string): string {
  return path.resolve(os.tmpdir(), `ai-support-e2e-${executionId}`)
}

/** Recursively snapshot a directory's files as { relativePath: content } */
function snapshotDir(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(out, snapshotDir(full, base))
    } else {
      out[path.relative(base, full)] = nodeFs.readFileSync(full, 'utf-8')
    }
  }
  return out
}

/** Helper to create a mock ChildProcess */
function createMockChild(exitCode: number | null = 0, stderrData?: string): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: jest.Mock
  stdin: null
} {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = jest.fn()
  child.stdin = null

  // Emit events asynchronously
  process.nextTick(() => {
    if (stderrData) {
      child.stderr.emit('data', Buffer.from(stderrData))
    }
    child.emit('close', exitCode)
  })

  return child
}

/** What the spawn mock captured at the moment Playwright was launched */
interface SpawnCapture {
  bin?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  /** Files present in the run directory at spawn time */
  files?: Record<string, string>
}

/**
 * Install a spawn mock that captures the CLI invocation and the run-directory
 * contents at spawn time, optionally writes the Playwright JSON reporter
 * output to the path given in E2E_JSON_OUTPUT, then exits.
 */
function setupSpawn(opts: {
  exitCode?: number | null
  stderrData?: string
  resultJson?: string
  capture?: SpawnCapture
}): void {
  const { exitCode = 0, stderrData, resultJson, capture } = opts
  mockSpawn.mockImplementation(((bin: string, args: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
    if (capture) {
      capture.bin = bin
      capture.args = args
      capture.env = spawnOpts?.env
      const configFile = args[args.indexOf('--config') + 1]
      capture.files = snapshotDir(path.dirname(configFile))
    }
    if (resultJson !== undefined) {
      const outputPath = spawnOpts?.env?.E2E_JSON_OUTPUT
      if (outputPath) {
        nodeFs.writeFileSync(outputPath, resultJson, 'utf-8')
      }
    }
    return createMockChild(exitCode, stderrData)
  }) as any)
}

/** Helper to create a Playwright JSON reporter output */
function makePlaywrightJson(
  specs: Array<{
    title: string
    status: 'passed' | 'failed' | 'skipped'
    error?: string
    duration?: number
    screenshotPath?: string
  }>,
): string {
  return JSON.stringify({
    suites: [
      {
        specs: specs.map((s) => ({
          title: s.title,
          tests: [
            {
              title: s.title,
              results: [
                {
                  status: s.status,
                  duration: s.duration ?? 100,
                  ...(s.error && { error: { message: s.error } }),
                  attachments: s.screenshotPath
                    ? [
                        {
                          name: 'screenshot',
                          contentType: 'image/png',
                          path: s.screenshotPath,
                        },
                      ]
                    : [],
                },
              ],
            },
          ],
        })),
      },
    ],
  })
}

describe('parsePlaywrightJsonOutput', () => {
  it('should parse a passing test result', () => {
    const json = makePlaywrightJson([{ title: 'Login test', status: 'passed', duration: 200 }])
    const result = parsePlaywrightJsonOutput(json)

    expect(result.success).toBe(true)
    expect(result.totalTests).toBe(1)
    expect(result.passedTests).toBe(1)
    expect(result.failedTests).toBe(0)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toEqual({
      title: 'Login test',
      status: 'passed',
      duration: 200,
    })
  })

  it('should parse a failing test result', () => {
    const json = makePlaywrightJson([
      { title: 'Checkout test', status: 'failed', error: 'Element not found', duration: 500 },
    ])
    const result = parsePlaywrightJsonOutput(json)

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(1)
    expect(result.passedTests).toBe(0)
    expect(result.failedTests).toBe(1)
    expect(result.steps[0]).toEqual({
      title: 'Checkout test',
      status: 'failed',
      error: 'Element not found',
      duration: 500,
    })
  })

  it('should parse a skipped test result', () => {
    const json = makePlaywrightJson([{ title: 'Skipped test', status: 'skipped' }])
    const result = parsePlaywrightJsonOutput(json)

    // skipped-only run: no failures → success is true (totalTests=1, failedTests=0)
    expect(result.success).toBe(true)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.failedTests).toBe(0)
    expect(result.totalTests).toBe(1)
  })

  it('should parse specs from nested suites', () => {
    const json = JSON.stringify({
      suites: [
        {
          title: 'tmp spec file',
          suites: [
            {
              title: 'ログイン画面',
              specs: [
                {
                  title: 'ログインページが正しく表示される',
                  tests: [
                    {
                      results: [{ status: 'passed', duration: 123, attachments: [] }],
                    },
                  ],
                },
              ],
            },
            {
              title: '認証リダイレクト',
              specs: [
                {
                  title: '認証済みユーザーはプロジェクト一覧にアクセスできる',
                  tests: [
                    {
                      results: [
                        {
                          status: 'failed',
                          duration: 5000,
                          error: { message: 'Expected not /login/' },
                          attachments: [],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(2)
    expect(result.passedTests).toBe(1)
    expect(result.failedTests).toBe(1)
    expect(result.steps.map((step) => step.title)).toEqual([
      'ログインページが正しく表示される',
      '認証済みユーザーはプロジェクト一覧にアクセスできる',
    ])
  })

  it('should include screenshotPath when present in attachments', () => {
    const json = makePlaywrightJson([
      {
        title: 'Screenshot test',
        status: 'failed',
        screenshotPath: '/tmp/screenshot.png',
      },
    ])
    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotPath).toBe('/tmp/screenshot.png')
  })

  it('should handle multiple tests across specs', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Test A',
              tests: [
                { title: 'Test A', results: [{ status: 'passed', duration: 100, attachments: [] }] },
              ],
            },
            {
              title: 'Test B',
              tests: [
                {
                  title: 'Test B',
                  results: [
                    { status: 'failed', duration: 200, error: { message: 'fail' }, attachments: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)

    expect(result.totalTests).toBe(2)
    expect(result.passedTests).toBe(1)
    expect(result.failedTests).toBe(1)
    expect(result.success).toBe(false)
  })

  it('should return error result when JSON is invalid', () => {
    const result = parsePlaywrightJsonOutput('not json {{{')

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(0)
    expect(result.errorOutput).toContain('Failed to parse')
  })

  it('should handle missing suites gracefully', () => {
    const result = parsePlaywrightJsonOutput(JSON.stringify({ stats: {} }))

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(0)
    expect(result.steps).toHaveLength(0)
  })

  it('should handle specs without tests gracefully', () => {
    const json = JSON.stringify({
      suites: [{ specs: [{ title: 'Empty spec', tests: [] }] }],
    })
    const result = parsePlaywrightJsonOutput(json)

    expect(result.totalTests).toBe(0)
    expect(result.steps).toHaveLength(0)
  })

  it('should handle tests without results gracefully', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'No results',
              tests: [{ title: 'No results', results: [] }],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)

    expect(result.totalTests).toBe(0)
    expect(result.steps).toHaveLength(0)
  })

  it('should use the last result when there are multiple retries', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Retry test',
              tests: [
                {
                  title: 'Retry test',
                  results: [
                    { status: 'failed', duration: 100, error: { message: 'first fail' }, attachments: [] },
                    { status: 'passed', duration: 200, attachments: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].status).toBe('passed')
    expect(result.passedTests).toBe(1)
  })

  it('should handle attachments without screenshot', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'No screenshot',
              tests: [
                {
                  title: 'No screenshot',
                  results: [
                    {
                      status: 'failed',
                      duration: 100,
                      error: { message: 'fail' },
                      attachments: [{ name: 'trace', contentType: 'application/zip', path: '/tmp/trace.zip' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotPath).toBeUndefined()
  })

  it('should handle non-array specs gracefully', () => {
    const json = JSON.stringify({
      suites: [{ specs: 'not-array' }],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps).toHaveLength(0)
  })

  it('should handle non-array tests gracefully', () => {
    const json = JSON.stringify({
      suites: [{ specs: [{ title: 'test', tests: 'not-array' }] }],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps).toHaveLength(0)
  })

  it('should fall back to test.title when spec.title is missing', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              // no title on spec
              tests: [
                {
                  title: 'from-test-title',
                  results: [{ status: 'passed', duration: 50, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].title).toBe('from-test-title')
  })

  it('should fall back to unknown when both spec.title and test.title are missing', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  results: [{ status: 'passed', duration: 50, attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].title).toBe('unknown')
  })

  it('should default status to failed when result.status is undefined', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'No status test',
              tests: [
                {
                  results: [
                    { duration: 100, attachments: [] }, // no status field
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('failed')
    expect(result.failedTests).toBe(1)
  })

  it('should omit duration when result.duration is not a number', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'No duration test',
              tests: [
                {
                  results: [{ status: 'passed', duration: 'slow', attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].duration).toBeUndefined()
  })

  it('should omit error field when error object has no message', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Error no message',
              tests: [
                {
                  results: [
                    {
                      status: 'failed',
                      duration: 100,
                      error: {}, // error object without message → message defaults to '' (falsy, not included)
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    // Empty string error message is falsy, so error field is not included in the step
    expect(result.steps[0].error).toBeUndefined()
    expect(result.steps[0].status).toBe('failed')
  })

  it('should handle non-array attachments gracefully', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Bad attachments',
              tests: [
                {
                  results: [
                    {
                      status: 'passed',
                      duration: 100,
                      attachments: 'not-array',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].screenshotPath).toBeUndefined()
  })

  // --- nested test.step() results (new format) ---

  /** Build a single-test JSON reporter output with nested `steps[]` (test.step() format). */
  function makeNestedStepJson(opts: {
    startTime?: string
    steps: Array<{ title: string; duration?: number; error?: string }>
    attachments?: Array<{ name?: string; contentType?: string; body?: unknown }>
  }): string {
    return JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Nested step test',
              tests: [
                {
                  title: 'Nested step test',
                  results: [
                    {
                      status: opts.steps.some((s) => s.error) ? 'failed' : 'passed',
                      duration: opts.steps.reduce((sum, s) => sum + (s.duration ?? 0), 0),
                      ...(opts.startTime !== undefined && { startTime: opts.startTime }),
                      steps: opts.steps.map((s) => ({
                        title: s.title,
                        duration: s.duration,
                        ...(s.error && { error: { message: s.error } }),
                      })),
                      attachments: opts.attachments ?? [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  }

  it('should parse nested test.step() results into individual steps with title/duration/executedAt/screenshotBase64', () => {
    const startTime = '2026-07-23T04:09:18.639Z'
    const json = makeNestedStepJson({
      startTime,
      steps: [
        { title: 'step one', duration: 22 },
        { title: 'step two', duration: 18 },
      ],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'AAAA-base64' },
        { name: 'screenshot', contentType: 'image/png', body: 'BBBB-base64' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toEqual({
      title: 'step one',
      status: 'passed',
      duration: 22,
      executedAt: new Date(Date.parse(startTime)).toISOString(),
      screenshotBase64: 'AAAA-base64',
    })
    expect(result.steps[1]).toEqual({
      title: 'step two',
      status: 'passed',
      duration: 18,
      executedAt: new Date(Date.parse(startTime) + 22).toISOString(),
      screenshotBase64: 'BBBB-base64',
    })
    // Step two's executedAt must be strictly later than step one's
    expect(Date.parse(result.steps[1].executedAt!)).toBeGreaterThan(Date.parse(result.steps[0].executedAt!))
    expect(result.passedTests).toBe(2)
    expect(result.failedTests).toBe(0)
    expect(result.totalTests).toBe(2)
    expect(result.success).toBe(true)
  })

  it('should mark a nested step failed with its error, matching real JSON where later steps never appear', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 22 },
        { title: 'step two', duration: 18, error: 'Element not found' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    // Only the two steps present in the JSON are reported (a would-be "step
    // three" simply never appears in Playwright's output, so there is
    // nothing for the parser to truncate).
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[1]).toEqual(
      expect.objectContaining({
        title: 'step two',
        status: 'failed',
        error: 'Element not found',
        duration: 18,
      }),
    )
    expect(result.passedTests).toBe(1)
    expect(result.failedTests).toBe(1)
    expect(result.totalTests).toBe(2)
    expect(result.success).toBe(false)
  })

  it('should omit executedAt for nested steps when the test result has no valid startTime', () => {
    const json = makeNestedStepJson({
      steps: [{ title: 'step one', duration: 10 }],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].executedAt).toBeUndefined()
  })

  it('should warn and omit screenshotBase64 for ALL nested steps when there are fewer image attachments than steps (count mismatch — shortage)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
        { title: 'step three', duration: 10 },
      ],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'one' },
        { name: 'screenshot', contentType: 'image/png', body: 'two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(result.steps[2].screenshotBase64).toBeUndefined()
    // Other fields must still be reported normally
    expect(result.steps[0].title).toBe('step one')
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[0].duration).toBe(10)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Screenshot/step count mismatch'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3 step(s)'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2 image attachment(s)'))
    warnSpy.mockRestore()
  })

  it('should warn and omit screenshotBase64 for ALL nested steps when there are more image attachments than steps (count mismatch — excess)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'one' },
        { name: 'screenshot', contentType: 'image/png', body: 'two' },
        { name: 'screenshot', contentType: 'image/png', body: 'three' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Screenshot/step count mismatch'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2 step(s)'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3 image attachment(s)'))
    warnSpy.mockRestore()
  })

  it('should NOT warn and should associate screenshots correctly when step count and image attachment count match', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'match-one' },
        { name: 'screenshot', contentType: 'image/png', body: 'match-two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('match-one')
    expect(result.steps[1].screenshotBase64).toBe('match-two')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('should NOT warn and should leave screenshotBase64 undefined for all steps when there are zero image attachments (captureStepScreenshots=false)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('should map only image/png attachments positionally, ignoring other attachment types (e.g. trace zip)', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        { name: 'trace', contentType: 'application/zip', body: 'zip-bytes' },
        { name: 'screenshot', contentType: 'image/png', body: 'png-one' },
        { name: 'screenshot', contentType: 'image/png', body: 'png-two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('png-one')
    expect(result.steps[1].screenshotBase64).toBe('png-two')
  })

  it('should omit screenshotBase64 when the matching attachment has no string body', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [{ title: 'step one', duration: 10 }],
      attachments: [{ name: 'screenshot', contentType: 'image/png' }],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBeUndefined()
  })

  it('should fall back to unknown for a nested step with no title', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'No step title',
              tests: [
                {
                  results: [
                    {
                      status: 'passed',
                      duration: 10,
                      startTime: '2026-07-23T04:09:18.639Z',
                      steps: [{ duration: 10 }],
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].title).toBe('unknown')
  })

  it('should use the legacy per-test fallback when the result has an empty nested steps array', () => {
    // Some older/edge-case reporter output may include `steps: []` explicitly
    // (as opposed to omitting the field entirely) — this must still fall
    // back to reporting the whole test as a single step.
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Empty nested steps',
              tests: [
                {
                  results: [{ status: 'passed', duration: 100, steps: [], attachments: [] }],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toEqual({
      title: 'Empty nested steps',
      status: 'passed',
      duration: 100,
    })
  })

  // --- skip reason capture (LEGACY per-test branch) ---

  /**
   * Build a legacy-branch (no nested test.step) JSON result carrying the given
   * status, optional annotations, and no nested `steps` — the shape real
   * Playwright 1.61 emits for a whole-test `test.skip(cond, reason)`.
   */
  function makeLegacyResultJson(opts: {
    title?: string
    status: 'passed' | 'failed' | 'skipped'
    annotations?: unknown
    error?: string
  }): string {
    const result: Record<string, unknown> = {
      status: opts.status,
      duration: 0,
      steps: [],
      attachments: [],
    }
    if (opts.annotations !== undefined) result.annotations = opts.annotations
    if (opts.error) result.error = { message: opts.error }
    return JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: opts.title ?? 'legacy test',
              tests: [{ results: [result] }],
            },
          ],
        },
      ],
    })
  }

  it('should capture skipReason from the test result annotations for a skipped legacy test', () => {
    const json = makeLegacyResultJson({
      status: 'skipped',
      annotations: [{ type: 'skip', description: 'my reason' }],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].skipReason).toBe('my reason')
  })

  it('should leave skipReason undefined when a skipped legacy test has no annotations', () => {
    const json = makeLegacyResultJson({ status: 'skipped' })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should leave skipReason undefined when annotations exist but none has type "skip"', () => {
    const json = makeLegacyResultJson({
      status: 'skipped',
      annotations: [{ type: 'issue', description: 'JIRA-123' }],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should leave skipReason undefined when the "skip" annotation lacks a description', () => {
    const json = makeLegacyResultJson({
      status: 'skipped',
      annotations: [{ type: 'skip' }],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should leave skipReason undefined when annotations is present but not an array', () => {
    const json = makeLegacyResultJson({
      status: 'skipped',
      annotations: { type: 'skip', description: 'not-an-array' },
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('skipped')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should NOT set skipReason on a passed legacy test even if a skip annotation is present', () => {
    const json = makeLegacyResultJson({
      status: 'passed',
      annotations: [{ type: 'skip', description: 'should be ignored' }],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should NOT set skipReason on a failed legacy test even if a skip annotation is present', () => {
    const json = makeLegacyResultJson({
      status: 'failed',
      error: 'boom',
      annotations: [{ type: 'skip', description: 'should be ignored' }],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].skipReason).toBeUndefined()
  })

  it('should treat a nested step with a zero duration correctly (falsy but valid)', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'instant step', duration: 0 },
        { title: 'next step', duration: 5 },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].duration).toBe(0)
    // cumulative offset must still be 0 (not skipped) so the next step's
    // executedAt is exactly startTime, not shifted
    expect(result.steps[1].executedAt).toBe(
      new Date(Date.parse('2026-07-23T04:09:18.639Z') + 0).toISOString(),
    )
  })

  it('should default a nested step duration to 0 when duration is not a number', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Non-numeric nested duration',
              tests: [
                {
                  results: [
                    {
                      status: 'passed',
                      duration: 100,
                      startTime: '2026-07-23T04:09:18.639Z',
                      steps: [{ title: 'weird step', duration: 'fast' }],
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].duration).toBe(0)
  })

  // --- harness index-based screenshot mapping (preferred path) ---

  it('should map screenshots to steps by the index embedded in the harness attachment name', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'shot-zero' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}1`, contentType: 'image/png', body: 'shot-one' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('shot-zero')
    expect(result.steps[1].screenshotBase64).toBe('shot-one')
  })

  it('should map by index regardless of attachment order in the array', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      // index 1 listed before index 0 on purpose
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}1`, contentType: 'image/png', body: 'shot-one' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'shot-zero' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('shot-zero')
    expect(result.steps[1].screenshotBase64).toBe('shot-one')
  })

  it('should leave only the missing-index step without a screenshot and NOT warn (per-step degradation for a skipped step)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    // Three steps, but index 0 (a skipped step) has no harness screenshot.
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'skipped step', duration: 1 },
        { title: 'real step one', duration: 10 },
        { title: 'real step two', duration: 10 },
      ],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}1`, contentType: 'image/png', body: 'shot-one' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}2`, contentType: 'image/png', body: 'shot-two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBe('shot-one')
    expect(result.steps[2].screenshotBase64).toBe('shot-two')
    // Index mapping never trips the positional count-mismatch warning.
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('should DROP all screenshots and warn when the harness index space is inflated by hook steps', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    // 2 body steps in nestedSteps, but harness indices 0,1,2 present: a
    // test.step() ran inside a beforeEach/afterEach hook (invisible to the
    // parser), inflating the index space. Mapping by index would misattribute
    // the hook's screenshot to a body step, so drop them all.
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'body one', duration: 10 },
        { title: 'body two', duration: 10 },
      ],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'hook-shot' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}1`, contentType: 'image/png', body: 'body-one-shot' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}2`, contentType: 'image/png', body: 'body-two-shot' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Harness screenshot index out of range'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Nested step test')) // testTitle in message
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('saw index 2'))
    warnSpy.mockRestore()
  })

  it('should NOT trigger the inflation guard for a skipped step (max index stays within range)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    // 3 steps where index 1 (the skipped step) has no screenshot: harness keys
    // are {0,2}, max key 2 < nestedSteps.length(3), so the guard must NOT fire —
    // the skipped step simply has no screenshot, the others keep theirs.
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'real zero', duration: 10 },
        { title: 'skipped one', duration: 1 },
        { title: 'real two', duration: 10 },
      ],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'shot-zero' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}2`, contentType: 'image/png', body: 'shot-two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('shot-zero')
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(result.steps[2].screenshotBase64).toBe('shot-two')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('should ignore non-indexed image attachments when harness-indexed ones exist', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        // a self-attached (non-indexed) screenshot from the spec — must be ignored
        { name: 'screenshot', contentType: 'image/png', body: 'self-attached' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'harness-zero' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}1`, contentType: 'image/png', body: 'harness-one' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('harness-zero')
    expect(result.steps[1].screenshotBase64).toBe('harness-one')
  })

  it('should ignore a harness attachment whose index is not a valid integer', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [{ title: 'step one', duration: 10 }],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}notanumber`, contentType: 'image/png', body: 'bad' },
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'good-zero' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('good-zero')
  })

  it('should omit the screenshot when a harness-indexed attachment has no string body', () => {
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [{ title: 'step one', duration: 10 }],
      attachments: [
        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    // No indexed body → falls through to fallback which also finds no usable
    // (string-bodied) attachment, so the step simply has no screenshot.
    expect(result.steps[0].screenshotBase64).toBeUndefined()
  })

  it('should fall back to positional mapping when only non-indexed image attachments are present (backward compat)', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
      ],
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'positional-one' },
        { name: 'screenshot', contentType: 'image/png', body: 'positional-two' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBe('positional-one')
    expect(result.steps[1].screenshotBase64).toBe('positional-two')
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('should treat non-array attachments on a nested-step result as no screenshots', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Bad nested attachments',
              tests: [
                {
                  results: [
                    {
                      status: 'passed',
                      duration: 10,
                      startTime: '2026-07-23T04:09:18.639Z',
                      steps: [{ title: 'step one', duration: 10 }],
                      attachments: 'not-array',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].screenshotBase64).toBeUndefined()
  })

  it('should ignore an image attachment whose name is not a string', () => {
    const json = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'Non-string attachment name',
              tests: [
                {
                  results: [
                    {
                      status: 'passed',
                      duration: 10,
                      startTime: '2026-07-23T04:09:18.639Z',
                      steps: [{ title: 'step one', duration: 10 }],
                      attachments: [
                        { name: 123, contentType: 'image/png', body: 'weird' },
                        { name: `${HARNESS_STEP_SCREENSHOT_PREFIX}0`, contentType: 'image/png', body: 'good' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)
    expect(result.steps[0].screenshotBase64).toBe('good')
  })

  it('should keep the positional count-mismatch warning on the fallback path', () => {
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const json = makeNestedStepJson({
      startTime: '2026-07-23T04:09:18.639Z',
      steps: [
        { title: 'step one', duration: 10 },
        { title: 'step two', duration: 10 },
        { title: 'step three', duration: 10 },
      ],
      // non-indexed and fewer than the step count → positional mismatch → drop
      attachments: [
        { name: 'screenshot', contentType: 'image/png', body: 'only-one' },
      ],
    })

    const result = parsePlaywrightJsonOutput(json)

    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
    expect(result.steps[2].screenshotBase64).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Screenshot/step count mismatch'))
    warnSpy.mockRestore()
  })
})

describe('runPlaywrightSubprocess', () => {
  /** executionIds used per test — their run directories are force-removed after each test */
  const usedExecutionIds: string[] = []

  function uniqueExecutionId(label: string): string {
    const id = `jesttest-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    usedExecutionIds.push(id)
    return id
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // Safety net: the executor is expected to remove its run directory itself,
    // but never leave residue in the shared temp dir if an assertion failed.
    for (const id of usedExecutionIds.splice(0)) {
      await fs.rm(runDirFor(id), { recursive: true, force: true })
    }
  })

  // --- executionId validation (path traversal prevention) ---

  it('should throw when executionId contains path traversal sequences', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: '../../etc/passwd',
      }),
    ).rejects.toThrow(/Invalid executionId/)
  })

  it('should throw when executionId contains a forward slash', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec/001',
      }),
    ).rejects.toThrow(/Invalid executionId/)
  })

  it('should throw when executionId contains a null byte', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec\x00001',
      }),
    ).rejects.toThrow(/Invalid executionId/)
  })

  it('should throw when executionId contains spaces', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec 001',
      }),
    ).rejects.toThrow(/Invalid executionId/)
  })

  it('should throw when executionId contains dots', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec.001',
      }),
    ).rejects.toThrow(/Invalid executionId/)
  })

  it('should accept executionId with alphanumeric characters, hyphens, and underscores', async () => {
    setupSpawn({ resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]) })

    // Should not throw for a valid executionId
    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('valid_ABC-1'),
    })
    expect(result.success).toBe(true)
  })

  it('should not create a run directory nor spawn when executionId is invalid', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: '../traversal',
      }),
    ).rejects.toThrow(/Invalid executionId/)

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  // --- run directory expansion ---

  it('should write the script to test.spec.ts inside the run directory and run playwright', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test 1', status: 'passed', duration: 100 }]),
      capture,
    })
    const executionId = uniqueExecutionId('write-spec')

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(capture.files?.['test.spec.ts']).toBe("await page.goto('/')")
    expect(capture.args?.[1]).toBe(path.join(runDirFor(executionId), 'test.spec.ts'))
    expect(result.success).toBe(true)
    expect(result.passedTests).toBe(1)
  })

  it('should generate a per-run playwright config with testDir set to the run directory', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('config')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    const config = capture.files?.['playwright.config.js']
    expect(config).toBeDefined()
    // testDir must point at the run directory itself so relative imports resolve
    expect(config).toContain('testDir: __dirname')
    // Settings carried over from playwright.subprocess.config.js
    expect(config).toContain('timeout: 120_000')
    expect(config).toContain('headless: true')
    // Automatic Playwright screenshots are disabled — steps attach their own
    // screenshots explicitly via testInfo.attach() (see RUN_CONFIG_TEMPLATE comment).
    expect(config).toContain("screenshot: 'off'")
    expect(config).toContain("trace: 'retain-on-failure'")
    expect(config).toContain("baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000'")
    expect(config).toContain("reporter: [['json', { outputFile: process.env.E2E_JSON_OUTPUT")
    expect(config).toContain('workers: 1')
  })

  it('should pass the per-run config file as the --config argument', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('args')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(capture.args?.[0]).toBe('test')
    expect(capture.args).toContain('--config')
    const configArg = capture.args![capture.args!.indexOf('--config') + 1]
    expect(configArg).toBe(path.join(runDirFor(executionId), 'playwright.config.js'))
  })

  // --- support files ---

  it('should expand support files with nested relative paths into the run directory', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('support-nested')

    const result = await runPlaywrightSubprocess({
      script: "import { LoginPage } from './lib/pages/login.page'",
      executionId,
      supportFiles: [
        { path: 'lib/pages/login.page.ts', content: 'export class LoginPage {}' },
        { path: 'helpers.ts', content: 'export const wait = () => {}' },
      ],
    })

    expect(capture.files?.[path.join('lib', 'pages', 'login.page.ts')]).toBe('export class LoginPage {}')
    expect(capture.files?.['helpers.ts']).toBe('export const wait = () => {}')
    expect(result.success).toBe(true)
  })

  it('should reject a support file path containing ".." and not spawn playwright', async () => {
    const executionId = uniqueExecutionId('support-dotdot')

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
        supportFiles: [{ path: '../evil.ts', content: 'evil' }],
      }),
    ).rejects.toThrow(/Invalid support file path/)

    expect(mockSpawn).not.toHaveBeenCalled()
    // The run directory must still be cleaned up
    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should reject a support file path with ".." nested inside a subdirectory', async () => {
    const executionId = uniqueExecutionId('support-nested-dotdot')

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
        supportFiles: [{ path: 'lib/../../evil.ts', content: 'evil' }],
      }),
    ).rejects.toThrow(/Invalid support file path/)

    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('should reject an absolute support file path', async () => {
    const executionId = uniqueExecutionId('support-absolute')

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
        supportFiles: [{ path: '/etc/hostile.ts', content: 'evil' }],
      }),
    ).rejects.toThrow(/Invalid support file path/)

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(nodeFs.existsSync('/etc/hostile.ts')).toBe(false)
  })

  it('should let the spec win when a support file path collides with test.spec.ts', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('support-collision')

    await runPlaywrightSubprocess({
      script: 'the real spec',
      executionId,
      supportFiles: [{ path: 'test.spec.ts', content: 'hostile spec override' }],
    })

    expect(capture.files?.['test.spec.ts']).toBe('the real spec')
  })

  it('should behave as before when supportFiles is not provided (backward compatibility)', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('no-support')

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(result.success).toBe(true)
    // The spec, the per-run config, and (captureStepScreenshots defaults to
    // true) the harness step-screenshot preload module are expanded.
    expect(Object.keys(capture.files ?? {}).sort()).toEqual([
      'playwright.config.js',
      'step-screenshot-patch.js',
      'test.spec.ts',
    ])
  })

  // --- env wiring ---

  it('should set E2E_JSON_OUTPUT to result.json inside the run directory', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('json-output')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(capture.env?.E2E_JSON_OUTPUT).toBe(path.join(runDirFor(executionId), 'result.json'))
  })

  it('should set E2E_BASE_URL when baseUrl is provided', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('base-url'),
      baseUrl: 'https://myapp.example.com',
    })

    expect(capture.env?.E2E_BASE_URL).toBe('https://myapp.example.com')
  })

  it('should not set E2E_BASE_URL when baseUrl is not provided', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('no-base-url'),
    })

    expect(capture.env?.E2E_BASE_URL).toBeUndefined()
  })

  // --- step-screenshot preload injection (captureStepScreenshots) ---

  /** Path the harness preload module is expected to occupy in the run dir. */
  function patchPathFor(executionId: string): string {
    return path.join(runDirFor(executionId), 'step-screenshot-patch.js')
  }

  it('should write the step-screenshot preload and inject it via NODE_OPTIONS by default', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('screenshot-default')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    // The preload module is written into the run directory...
    const patch = capture.files?.['step-screenshot-patch.js']
    expect(patch).toBeDefined()
    expect(patch).toContain("require('@playwright/test')")
    expect(patch).toContain('fullPage: true')
    // ...and injected into the child's NODE_OPTIONS as a QUOTED --require so a
    // temp path containing a space cannot break Node startup.
    expect(capture.env?.NODE_OPTIONS).toContain(`--require "${patchPathFor(executionId)}"`)
  })

  it('should inject the preload when captureStepScreenshots is explicitly true', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('screenshot-true')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      captureStepScreenshots: true,
    })

    expect(capture.files?.['step-screenshot-patch.js']).toBeDefined()
    expect(capture.env?.NODE_OPTIONS).toContain(`--require "${patchPathFor(executionId)}"`)
  })

  it('should quote the injected --require path so a temp dir with a space does not break Node startup', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('screenshot-quoted')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    // The injected fragment must open with `--require "` (quote immediately
    // after the flag) rather than an unquoted path.
    expect(capture.env?.NODE_OPTIONS).toContain('--require "')
    expect(capture.env?.NODE_OPTIONS).toMatch(/--require "[^"]*step-screenshot-patch\.js"/)
  })

  it('should NOT write the preload nor set --require when captureStepScreenshots is false', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('screenshot-false')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      captureStepScreenshots: false,
    })

    // No preload module is written...
    expect(capture.files?.['step-screenshot-patch.js']).toBeUndefined()
    expect(Object.keys(capture.files ?? {}).sort()).toEqual([
      'playwright.config.js',
      'test.spec.ts',
    ])
    // ...and NODE_OPTIONS carries no injected --require for our patch.
    expect(capture.env?.NODE_OPTIONS ?? '').not.toContain('step-screenshot-patch.js')
  })

  it('should preserve a pre-existing NODE_OPTIONS when injecting the preload', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const executionId = uniqueExecutionId('screenshot-preserve-node-options')

    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--max-old-space-size=2048'
    try {
      await runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
      })
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }

    // Both the inherited flag and the injected (quoted) --require must be present.
    expect(capture.env?.NODE_OPTIONS).toContain('--max-old-space-size=2048')
    expect(capture.env?.NODE_OPTIONS).toContain(`--require "${patchPathFor(executionId)}"`)
  })

  // --- cleanup ---

  it('should remove the run directory on success', async () => {
    setupSpawn({ resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]) })
    const executionId = uniqueExecutionId('cleanup-ok')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should remove the run directory even when the subprocess fails', async () => {
    setupSpawn({ exitCode: 1, stderrData: 'Error: test failed' })
    const executionId = uniqueExecutionId('cleanup-fail')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      supportFiles: [{ path: 'lib/util.ts', content: 'export {}' }],
    })

    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should remove the run directory when the subprocess rejects (spawn error)', async () => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    child.stdin = null
    mockSpawn.mockImplementation((() => {
      process.nextTick(() => {
        child.emit('error', new Error('ENOENT: playwright not found'))
      })
      return child
    }) as any)
    const executionId = uniqueExecutionId('cleanup-spawn-error')

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
      }),
    ).rejects.toThrow('ENOENT: playwright not found')

    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should clean up and rethrow when the run directory cannot be created', async () => {
    const executionId = uniqueExecutionId('mkdir-fail')
    // Pre-create a regular file where the run directory should go → mkdir fails
    nodeFs.writeFileSync(runDirFor(executionId), 'not a directory', 'utf-8')

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId,
      }),
    ).rejects.toThrow()

    expect(mockSpawn).not.toHaveBeenCalled()
    // finally-cleanup removes even the offending file (rm with force+recursive)
    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should ignore errors during run directory cleanup', async () => {
    setupSpawn({ resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]) })
    const rmSpy = jest.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Permission denied'))

    // Should not throw despite rm failure
    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('cleanup-error-ignored'),
    })
    expect(result.success).toBe(true)
    rmSpy.mockRestore()
  })

  // --- result handling ---

  it('should return failure when JSON output file cannot be read', async () => {
    // Spawn exits with error and never writes the result file
    setupSpawn({ exitCode: 1, stderrData: 'Something went wrong' })

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('no-json'),
    })

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(0)
    expect(result.errorOutput).toBe('Something went wrong')
  })

  it('should use fallback message when JSON output missing and no stderr', async () => {
    // exit code 0 means no stderr (success exit but no output file)
    setupSpawn({ exitCode: 0 })

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('no-stderr'),
    })

    expect(result.success).toBe(false)
    expect(result.errorOutput).toBe('Playwright did not produce JSON output')
  })

  it('should include stderr output in error result when tests fail', async () => {
    setupSpawn({
      exitCode: 1,
      stderrData: 'Playwright stderr output',
      resultJson: makePlaywrightJson([
        { title: 'Failing test', status: 'failed', error: 'Assertion error' },
      ]),
    })

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('stderr'),
    })

    expect(result.success).toBe(false)
    expect(result.errorOutput).toBe('Playwright stderr output')
  })

  it('should reject when process times out', async () => {
    // Create a child that never emits close until killed
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn(() => {
      // Simulate kill causing close
      process.nextTick(() => child.emit('close', null))
    })
    child.stdin = null
    mockSpawn.mockReturnValue(child as any)
    const executionId = uniqueExecutionId('timeout')

    const resultPromise = runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      timeoutMs: 10, // Very short timeout
    })

    await expect(resultPromise).rejects.toThrow(/timed out/)
    expect(nodeFs.existsSync(runDirFor(executionId))).toBe(false)
  })

  it('should handle success result without errorOutput when tests pass', async () => {
    setupSpawn({ resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]) })

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('pass'),
    })

    expect(result.success).toBe(true)
    expect(result.errorOutput).toBeUndefined()
  })

  it('should handle stdout data from subprocess', async () => {
    // Child that emits stdout data
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    child.stdin = null
    const executionId = uniqueExecutionId('stdout')
    mockSpawn.mockImplementation(((bin: string, args: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
      const outputPath = spawnOpts?.env?.E2E_JSON_OUTPUT
      if (outputPath) {
        nodeFs.writeFileSync(outputPath, makePlaywrightJson([{ title: 'Test', status: 'passed' }]), 'utf-8')
      }
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('Running 1 test...\n'))
        child.emit('close', 0)
      })
      return child
    }) as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })
    expect(result.success).toBe(true)
  })

  it('should route [step-screenshot] stderr lines to logger.warn and other lines to logger.debug, even on exit code 0', async () => {
    // The harness preload writes capture-failure diagnostics to stderr; those
    // must be VISIBLE in normal operation (logger.debug is gated behind
    // --verbose), so a "[step-screenshot]" line goes to logger.warn while
    // routine Playwright stderr stays at logger.debug. Both must be forwarded on
    // a PASSING test (stderrOutput is only returned on a non-zero exit).
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const debugSpy = jest.spyOn(require('../../src/logger').logger, 'debug').mockImplementation(() => {})
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    child.stdin = null
    const executionId = uniqueExecutionId('stderr-forward')
    mockSpawn.mockImplementation(((bin: string, args: string[], spawnOpts: { env?: NodeJS.ProcessEnv }) => {
      const outputPath = spawnOpts?.env?.E2E_JSON_OUTPUT
      if (outputPath) {
        nodeFs.writeFileSync(outputPath, makePlaywrightJson([{ title: 'Test', status: 'passed' }]), 'utf-8')
      }
      process.nextTick(() => {
        // One [step-screenshot] line (→ warn) and one routine line (→ debug),
        // delivered in a single chunk to also exercise per-line splitting.
        child.stderr.emit(
          'data',
          Buffer.from('[step-screenshot] capture failed for step "x"\nRoutine Playwright noise\n'),
        )
        child.emit('close', 0) // success exit code
      })
      return child
    }) as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
    })

    expect(result.success).toBe(true)
    // The capture-failure line is surfaced at warn level.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[playwright-subprocess] stderr:'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('capture failed for step'))
    // Routine stderr stays at debug and never reaches warn.
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Routine Playwright noise'))
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Routine Playwright noise'))
    warnSpy.mockRestore()
    debugSpy.mockRestore()
  })

  // --- envVars merging ---

  it('should merge valid envVars into the subprocess env', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('envvars-ok'),
      envVars: { API_KEY: 'secret-value', RETRY_COUNT: '3' },
    })

    expect(capture.env?.API_KEY).toBe('secret-value')
    expect(capture.env?.RETRY_COUNT).toBe('3')
  })

  it('should ignore envVars keys with an invalid format and log a warning', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const executionId = uniqueExecutionId('envvars-bad-key')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      envVars: {
        'lowercase_key': 'value',
        'has space': 'value',
        '1STARTS_WITH_DIGIT': 'value',
        'VALID_KEY': 'kept',
      },
    })

    expect(capture.env?.['lowercase_key']).toBeUndefined()
    expect(capture.env?.['has space']).toBeUndefined()
    expect(capture.env?.['1STARTS_WITH_DIGIT']).toBeUndefined()
    expect(capture.env?.VALID_KEY).toBe('kept')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(executionId))
    warnSpy.mockRestore()
  })

  it('should not allow envVars to override reserved keys (E2E_JSON_OUTPUT, E2E_BASE_URL, PATH)', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const executionId = uniqueExecutionId('envvars-reserved')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      baseUrl: 'https://real.example.com',
      envVars: {
        E2E_JSON_OUTPUT: '/tmp/malicious.json',
        E2E_BASE_URL: 'https://evil.example.com',
        PATH: '/malicious/bin',
      },
    })

    expect(capture.env?.E2E_JSON_OUTPUT).toBe(path.join(runDirFor(executionId), 'result.json'))
    expect(capture.env?.E2E_BASE_URL).toBe('https://real.example.com')
    expect(capture.env?.PATH).toBe(process.env.PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('E2E_JSON_OUTPUT'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('E2E_BASE_URL'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PATH'))
    // The reserved-key warnings (module-specific) must be traceable to the execution.
    expect(warnSpy.mock.calls.some(
      (call) => typeof call[0] === 'string'
        && call[0].includes(executionId)
        && call[0].includes('E2E_JSON_OUTPUT'),
    )).toBe(true)
    warnSpy.mockRestore()
  })

  it('should reject dangerous runtime-hijacking env keys (NODE_OPTIONS, PLAYWRIGHT_BROWSERS_PATH, LD_PRELOAD, DYLD_INSERT_LIBRARIES) via the shared denylist', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: uniqueExecutionId('envvars-rce'),
      // Disable the harness preload so NODE_OPTIONS is not legitimately set by
      // this module — this test's sole concern is that USER-supplied
      // NODE_OPTIONS cannot hijack the runtime via the shared denylist.
      captureStepScreenshots: false,
      envVars: {
        NODE_OPTIONS: '--require /tmp/evil.js',
        PLAYWRIGHT_BROWSERS_PATH: '/tmp/evil-browsers',
        LD_PRELOAD: '/tmp/evil.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        SAFE_KEY: 'kept',
      },
    })

    expect(capture.env?.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS)
    expect(capture.env?.PLAYWRIGHT_BROWSERS_PATH).toBe(process.env.PLAYWRIGHT_BROWSERS_PATH)
    expect(capture.env?.LD_PRELOAD).toBe(process.env.LD_PRELOAD)
    expect(capture.env?.DYLD_INSERT_LIBRARIES).toBe(process.env.DYLD_INSERT_LIBRARIES)
    expect(capture.env?.SAFE_KEY).toBe('kept')
    warnSpy.mockRestore()
  })

  it('should include the executionId in warnings emitted by the shared env filter', async () => {
    setupSpawn({ resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]) })
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})
    const executionId = uniqueExecutionId('trace-me')

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId,
      envVars: { NODE_OPTIONS: '--require /tmp/evil.js' },
    })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(executionId))
    warnSpy.mockRestore()
  })

  it('should set NODE_PATH to bundled node_modules so run-dir specs can import @playwright/test', async () => {
    const capture: SpawnCapture = {}
    setupSpawn({
      resultJson: makePlaywrightJson([{ title: 'Test', status: 'passed' }]),
      capture,
    })

    await runPlaywrightSubprocess({
      script: "import { test } from '@playwright/test'; test('t', async () => {})",
      executionId: uniqueExecutionId('node-path'),
      envVars: { NODE_PATH: '/tmp/evil-node-path' },
    })

    expect(capture.env?.NODE_PATH).toContain('node_modules')
    expect(capture.env?.NODE_PATH).not.toBe('/tmp/evil-node-path')
  })
})
