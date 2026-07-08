import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import * as childProcess from 'child_process'

import { runPlaywrightSubprocess, parsePlaywrightJsonOutput } from '../../src/browser/playwright-subprocess-executor'

// Mock fs and child_process
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}))

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

const mockFs = fs as jest.Mocked<typeof fs>
const mockSpawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>

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
  beforeEach(() => {
    jest.clearAllMocks()
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.unlink.mockResolvedValue(undefined)
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
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    // Should not throw for a valid executionId
    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-001_ABC',
    })
    expect(result.success).toBe(true)
  })

  it('should not clean up temp files when executionId is invalid (throws before writeFile)', async () => {
    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: '../traversal',
      }),
    ).rejects.toThrow(/Invalid executionId/)

    // writeFile and unlink should never have been called
    expect(mockFs.writeFile).not.toHaveBeenCalled()
    expect(mockFs.unlink).not.toHaveBeenCalled()
  })

  it('should write the script to a temp file and run playwright', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test 1', status: 'passed', duration: 100 }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-001',
    })

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/tmp/ai-support-e2e-exec-001.spec.ts',
      "await page.goto('/')",
      'utf-8',
    )
    expect(result.success).toBe(true)
    expect(result.passedTests).toBe(1)
  })

  it('should set E2E_JSON_OUTPUT env var for the subprocess', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-002',
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.E2E_JSON_OUTPUT).toBe('/tmp/ai-support-e2e-exec-002-result.json')
  })

  it('should set E2E_BASE_URL when baseUrl is provided', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-003',
      baseUrl: 'https://myapp.example.com',
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.E2E_BASE_URL).toBe('https://myapp.example.com')
  })

  it('should not set E2E_BASE_URL when baseUrl is not provided', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-004',
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.E2E_BASE_URL).toBeUndefined()
  })

  it('should clean up temp files on success', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-005',
    })

    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-005.spec.ts')
    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-005-result.json')
  })

  it('should clean up temp files even when subprocess fails', async () => {
    mockFs.readFile.mockRejectedValue(new Error('File not found'))
    mockSpawn.mockReturnValue(createMockChild(1, 'Error: test failed') as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-006',
    })

    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-006.spec.ts')
    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-006-result.json')
  })

  it('should return failure when JSON output file cannot be read', async () => {
    mockFs.readFile.mockRejectedValue(new Error('File not found'))
    mockSpawn.mockReturnValue(createMockChild(1, 'Something went wrong') as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-007',
    })

    expect(result.success).toBe(false)
    expect(result.totalTests).toBe(0)
    expect(result.errorOutput).toBeTruthy()
  })

  it('should use fallback message when JSON output missing and no stderr', async () => {
    mockFs.readFile.mockRejectedValue(new Error('File not found'))
    // exit code 0 means no stderr (success exit but no output file)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-no-stderr',
    })

    expect(result.success).toBe(false)
    expect(result.errorOutput).toBe('Playwright did not produce JSON output')
  })

  it('should include stderr output in error result when tests fail', async () => {
    const jsonOutput = makePlaywrightJson([
      { title: 'Failing test', status: 'failed', error: 'Assertion error' },
    ])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(1, 'Playwright stderr output') as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-008',
    })

    expect(result.success).toBe(false)
    expect(result.errorOutput).toBe('Playwright stderr output')
  })

  it('should reject when process times out', async () => {
    // Create a child that never emits close
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn(() => {
      // Simulate kill causing close
      process.nextTick(() => child.emit('close', null))
    })
    child.stdin = null
    mockSpawn.mockReturnValue(child as any)
    mockFs.readFile.mockRejectedValue(new Error('File not found'))

    const resultPromise = runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-timeout',
      timeoutMs: 10, // Very short timeout
    })

    await expect(resultPromise).rejects.toThrow(/timed out/)
  })

  it('should reject when spawn emits an error event', async () => {
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    child.stdin = null
    mockSpawn.mockReturnValue(child as any)

    process.nextTick(() => {
      child.emit('error', new Error('ENOENT: playwright not found'))
    })

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec-spawn-error',
      }),
    ).rejects.toThrow('ENOENT: playwright not found')
  })

  it('should clean up temp files even when writeFile throws', async () => {
    mockFs.writeFile.mockRejectedValue(new Error('Disk full'))
    mockFs.unlink.mockResolvedValue(undefined)

    await expect(
      runPlaywrightSubprocess({
        script: "await page.goto('/')",
        executionId: 'exec-writefail',
      }),
    ).rejects.toThrow('Disk full')

    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-writefail.spec.ts')
    expect(mockFs.unlink).toHaveBeenCalledWith('/tmp/ai-support-e2e-exec-writefail-result.json')
  })

  it('should ignore errors when cleaning up temp files', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)
    mockFs.unlink.mockRejectedValue(new Error('Permission denied'))

    // Should not throw despite unlink failure
    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-cleanup-fail',
    })
    expect(result.success).toBe(true)
  })

  it('should handle success result without errorOutput when tests pass', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-pass',
    })

    expect(result.success).toBe(true)
    expect(result.errorOutput).toBeUndefined()
  })

  it('should handle stdout data from subprocess', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)

    // Child that emits stdout data
    const child = new EventEmitter() as any
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = jest.fn()
    child.stdin = null
    mockSpawn.mockReturnValue(child as any)

    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('Running 1 test...\n'))
      child.emit('close', 0)
    })

    const result = await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-stdout',
    })
    expect(result.success).toBe(true)
  })

  // --- envVars merging ---

  it('should merge valid envVars into the subprocess env', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-envvars-ok',
      envVars: { API_KEY: 'secret-value', RETRY_COUNT: '3' },
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.API_KEY).toBe('secret-value')
    expect(spawnEnv.RETRY_COUNT).toBe('3')
  })

  it('should ignore envVars keys with an invalid format and log a warning', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-envvars-bad-key',
      envVars: {
        'lowercase_key': 'value',
        'has space': 'value',
        '1STARTS_WITH_DIGIT': 'value',
        'VALID_KEY': 'kept',
      },
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv['lowercase_key']).toBeUndefined()
    expect(spawnEnv['has space']).toBeUndefined()
    expect(spawnEnv['1STARTS_WITH_DIGIT']).toBeUndefined()
    expect(spawnEnv.VALID_KEY).toBe('kept')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exec-envvars-bad-key'))
    warnSpy.mockRestore()
  })

  it('should not allow envVars to override reserved keys (E2E_JSON_OUTPUT, E2E_BASE_URL, PATH)', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-envvars-reserved',
      baseUrl: 'https://real.example.com',
      envVars: {
        E2E_JSON_OUTPUT: '/tmp/malicious.json',
        E2E_BASE_URL: 'https://evil.example.com',
        PATH: '/malicious/bin',
      },
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.E2E_JSON_OUTPUT).toBe('/tmp/ai-support-e2e-exec-envvars-reserved-result.json')
    expect(spawnEnv.E2E_BASE_URL).toBe('https://real.example.com')
    expect(spawnEnv.PATH).toBe(process.env.PATH)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('E2E_JSON_OUTPUT'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('E2E_BASE_URL'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PATH'))
    // The reserved-key warnings (module-specific) must be traceable to the execution.
    expect(warnSpy.mock.calls.some(
      (call) => typeof call[0] === 'string'
        && call[0].includes('exec-envvars-reserved')
        && call[0].includes('E2E_JSON_OUTPUT'),
    )).toBe(true)
    warnSpy.mockRestore()
  })

  it('should reject dangerous runtime-hijacking env keys (NODE_OPTIONS, PLAYWRIGHT_BROWSERS_PATH, LD_PRELOAD, DYLD_INSERT_LIBRARIES) via the shared denylist', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-envvars-rce',
      envVars: {
        NODE_OPTIONS: '--require /tmp/evil.js',
        PLAYWRIGHT_BROWSERS_PATH: '/tmp/evil-browsers',
        LD_PRELOAD: '/tmp/evil.so',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        SAFE_KEY: 'kept',
      },
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS)
    expect(spawnEnv.PLAYWRIGHT_BROWSERS_PATH).toBe(process.env.PLAYWRIGHT_BROWSERS_PATH)
    expect(spawnEnv.LD_PRELOAD).toBe(process.env.LD_PRELOAD)
    expect(spawnEnv.DYLD_INSERT_LIBRARIES).toBe(process.env.DYLD_INSERT_LIBRARIES)
    expect(spawnEnv.SAFE_KEY).toBe('kept')
    warnSpy.mockRestore()
  })

  it('should include the executionId in warnings emitted by the shared env filter', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)
    const warnSpy = jest.spyOn(require('../../src/logger').logger, 'warn').mockImplementation(() => {})

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-trace-me',
      envVars: { NODE_OPTIONS: '--require /tmp/evil.js' },
    })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exec-trace-me'))
    warnSpy.mockRestore()
  })

  it('should set only internal env vars when envVars is not provided', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-envvars-none',
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.E2E_JSON_OUTPUT).toBe('/tmp/ai-support-e2e-exec-envvars-none-result.json')
  })

  it('should set NODE_PATH to bundled node_modules so /tmp specs can import @playwright/test', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "import { test } from '@playwright/test'; test('t', async () => {})",
      executionId: 'exec-node-path',
      envVars: { NODE_PATH: '/tmp/evil-node-path' },
    })

    const spawnCall = mockSpawn.mock.calls[0]
    const spawnEnv = spawnCall[2]?.env as NodeJS.ProcessEnv
    expect(spawnEnv.NODE_PATH).toContain('node_modules')
    expect(spawnEnv.NODE_PATH).not.toBe('/tmp/evil-node-path')
  })

  it('should pass spec file and config file as playwright arguments', async () => {
    const jsonOutput = makePlaywrightJson([{ title: 'Test', status: 'passed' }])
    mockFs.readFile.mockResolvedValue(jsonOutput as any)
    mockSpawn.mockReturnValue(createMockChild(0) as any)

    await runPlaywrightSubprocess({
      script: "await page.goto('/')",
      executionId: 'exec-args',
    })

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
    expect(spawnArgs[0]).toBe('test')
    expect(spawnArgs[1]).toContain('ai-support-e2e-exec-args.spec.ts')
    expect(spawnArgs).toContain('--config')
    expect(spawnArgs[spawnArgs.indexOf('--config') + 1]).toContain('playwright.subprocess.config.js')
  })
})
