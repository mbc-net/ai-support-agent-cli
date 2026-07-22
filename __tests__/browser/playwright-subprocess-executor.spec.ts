import { EventEmitter } from 'events'
import * as nodeFs from 'fs'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as childProcess from 'child_process'

import { runPlaywrightSubprocess, parsePlaywrightJsonOutput } from '../../src/browser/playwright-subprocess-executor'

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
    expect(config).toContain("screenshot: 'only-on-failure'")
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
    // Only the spec and the per-run config are expanded
    expect(Object.keys(capture.files ?? {}).sort()).toEqual(['playwright.config.js', 'test.spec.ts'])
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
