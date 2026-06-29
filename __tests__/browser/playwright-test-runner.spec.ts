import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import * as fs from 'fs'

import { runPlaywrightScript } from '../../src/browser/playwright-test-runner'

jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
}))
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock('../../src/utils', () => ({
  getErrorMessage: (e: unknown) => String(e),
}))

type MockProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

function makeMockProcess(stdoutData: string, stderrData: string, exitCode: number): MockProcess {
  const proc = new EventEmitter() as MockProcess
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()

  ;(spawn as jest.Mock).mockReturnValue(proc)

  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(stdoutData))
    proc.stderr.emit('data', Buffer.from(stderrData))
    proc.emit('close', exitCode)
  })

  return proc
}

const passedJson = JSON.stringify({
  suites: [
    {
      specs: [
        {
          title: 'should pass',
          tests: [
            {
              results: [
                { status: 'passed', duration: 100, errors: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
})

const failedJson = JSON.stringify({
  suites: [
    {
      specs: [
        {
          title: 'should fail',
          tests: [
            {
              results: [
                {
                  status: 'failed',
                  duration: 200,
                  errors: [{ message: 'AssertionError: expected true' }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
})

describe('runPlaywrightScript', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(fs.existsSync as jest.Mock).mockReturnValue(false)
  })

  it('should throw when executionId contains path traversal characters', async () => {
    await expect(
      runPlaywrightScript('script', '../../../etc/passwd', '/agent'),
    ).rejects.toThrow('Invalid executionId')
  })

  it('should throw when executionId contains slash', async () => {
    await expect(
      runPlaywrightScript('script', 'foo/bar', '/agent'),
    ).rejects.toThrow('Invalid executionId')
  })

  it('should return success when exit code is 0 with passed test', async () => {
    makeMockProcess(passedJson, '', 0)

    const result = await runPlaywrightScript(
      "const { test, expect } = require('@playwright/test'); test('t', async () => {})",
      'exec-1',
      '/agent',
    )

    expect(result.success).toBe(true)
    expect(result.passed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.totalSteps).toBe(1)
    expect(result.results[0].title).toBe('should pass')
    expect(result.results[0].status).toBe('passed')
    expect(result.errorOutput).toBeUndefined()
  })

  it('should return failure when exit code is 1 with failed test', async () => {
    makeMockProcess(failedJson, 'Error output', 1)

    const result = await runPlaywrightScript(
      "const { test, expect } = require('@playwright/test'); test('t', async () => { throw new Error() })",
      'exec-2',
      '/agent',
    )

    expect(result.success).toBe(false)
    expect(result.passed).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.totalSteps).toBe(1)
    expect(result.results[0].title).toBe('should fail')
    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].error).toBe('AssertionError: expected true')
    expect(result.errorOutput).toBe('Error output')
  })

  it('should reject the promise when spawn emits an error event', async () => {
    const proc = new EventEmitter() as MockProcess
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    ;(spawn as jest.Mock).mockReturnValue(proc)

    setImmediate(() => {
      proc.emit('error', new Error('spawn ENOENT'))
    })

    await expect(
      runPlaywrightScript('script', 'exec-3', '/agent'),
    ).rejects.toThrow('spawn ENOENT')
  })

  it('should handle empty script without throwing', async () => {
    makeMockProcess('{}', '', 0)

    const result = await runPlaywrightScript('', 'exec-4', '/agent')

    expect(result.success).toBe(true)
    expect(result.passed).toBe(0)
    expect(result.totalSteps).toBe(0)
  })

  it('should handle invalid JSON stdout gracefully', async () => {
    makeMockProcess('not json at all', 'some stderr', 1)

    const result = await runPlaywrightScript('script', 'exec-5', '/agent')

    expect(result.success).toBe(false)
    expect(result.results).toEqual([])
    expect(result.passed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.errorOutput).toBe('some stderr')
  })

  it('should clean up spec file after execution even on spawn error', async () => {
    const proc = new EventEmitter() as MockProcess
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    ;(spawn as jest.Mock).mockReturnValue(proc)

    setImmediate(() => {
      proc.emit('error', new Error('spawn failed'))
    })

    await expect(
      runPlaywrightScript('script', 'exec-6', '/agent'),
    ).rejects.toThrow()

    expect(fs.unlinkSync).toHaveBeenCalled()
  })

  it('should clean up spec file after successful execution', async () => {
    makeMockProcess(passedJson, '', 0)

    await runPlaywrightScript('script', 'exec-7', '/agent')

    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('exec-7.spec.js'),
    )
  })

  it('should not throw when unlinkSync fails during cleanup', async () => {
    makeMockProcess(passedJson, '', 0)
    ;(fs.unlinkSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    const result = await runPlaywrightScript('script', 'exec-8', '/agent')

    // cleanup error is swallowed — result still returned
    expect(result.success).toBe(true)
  })

  it('should handle specs with no tests array', async () => {
    const noTests = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'empty spec',
              // no tests field
            },
          ],
        },
      ],
    })
    makeMockProcess(noTests, '', 0)

    const result = await runPlaywrightScript('script', 'exec-x0a', '/agent')

    expect(result.passed).toBe(0)
    expect(result.results).toEqual([])
  })

  it('should handle tests with no results array', async () => {
    const noResults = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'spec with no results',
              tests: [
                {
                  // no results field
                },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(noResults, '', 0)

    const result = await runPlaywrightScript('script', 'exec-x0b', '/agent')

    expect(result.passed).toBe(0)
    expect(result.results).toEqual([])
  })

  it('should use empty string for title and 0 for duration when missing', async () => {
    const noTitleNoduration = JSON.stringify({
      suites: [
        {
          specs: [
            {
              // no title
              tests: [
                {
                  results: [
                    { status: 'passed' /* no duration, no errors */ },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(noTitleNoduration, '', 0)

    const result = await runPlaywrightScript('script', 'exec-x0', '/agent')

    expect(result.passed).toBe(1)
    expect(result.results[0].title).toBe('')
    expect(result.results[0].duration).toBe(0)
    expect(result.results[0].error).toBeUndefined()
  })

  it('should handle JSON that parses but causes extractResults to throw', async () => {
    // JSON parses fine but specs is not iterable → collectSpecs throws → caught at outer catch
    const badStructure = '{"suites": false}'
    makeMockProcess(badStructure, '', 1)

    const result = await runPlaywrightScript('script', 'exec-x1', '/agent')

    // outer catch handles it gracefully, result based on exit code
    expect(result.success).toBe(false)
    expect(result.results).toEqual([])
  })

  it('should handle nested suites in JSON output', async () => {
    const nestedJson = JSON.stringify({
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  title: 'nested test',
                  tests: [
                    { results: [{ status: 'passed', duration: 50, errors: [] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(nestedJson, '', 0)

    const result = await runPlaywrightScript('script', 'exec-9', '/agent')

    expect(result.passed).toBe(1)
    expect(result.results[0].title).toBe('nested test')
  })

  it('should handle timedOut status as a failure', async () => {
    const timedOutJson = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'slow test',
              tests: [
                { results: [{ status: 'timedOut', duration: 30000, errors: [] }] },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(timedOutJson, '', 1)

    const result = await runPlaywrightScript('script', 'exec-10', '/agent')

    expect(result.success).toBe(false)
    expect(result.failed).toBe(1)
    expect(result.results[0].status).toBe('timedOut')
  })

  it('should count skipped tests', async () => {
    const skippedJson = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'skipped test',
              tests: [
                { results: [{ status: 'skipped', duration: 0, errors: [] }] },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(skippedJson, '', 0)

    const result = await runPlaywrightScript('script', 'exec-11', '/agent')

    expect(result.skipped).toBe(1)
    expect(result.passed).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('should not set errorOutput when success is true even with stderr', async () => {
    makeMockProcess(passedJson, 'some warning', 0)

    const result = await runPlaywrightScript('script', 'exec-12', '/agent')

    expect(result.success).toBe(true)
    expect(result.errorOutput).toBeUndefined()
  })

  it('should not set errorOutput when failure has empty stderr', async () => {
    makeMockProcess(failedJson, '', 1)

    const result = await runPlaywrightScript('script', 'exec-13', '/agent')

    expect(result.success).toBe(false)
    expect(result.errorOutput).toBeUndefined()
  })

  it('should pass null exit code as 1', async () => {
    const proc = new EventEmitter() as MockProcess
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    ;(spawn as jest.Mock).mockReturnValue(proc)

    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from(''))
      proc.emit('close', null)
    })

    const result = await runPlaywrightScript('script', 'exec-14', '/agent')

    expect(result.success).toBe(false)
  })

  it('should include playwright config when playwright.config.ts exists', async () => {
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    makeMockProcess(passedJson, '', 0)

    await runPlaywrightScript('script', 'exec-15', '/agent')

    const spawnArgs = (spawn as jest.Mock).mock.calls[0][1] as string[]
    expect(spawnArgs).toContainEqual(expect.stringContaining('playwright.config.ts'))
  })

  it('should handle JSON with text before opening brace', async () => {
    const withPreamble = `Playwright Test Results\n${passedJson}`
    makeMockProcess(withPreamble, '', 0)

    const result = await runPlaywrightScript('script', 'exec-16', '/agent')

    expect(result.passed).toBe(1)
  })

  it('should handle malformed JSON starting with { but invalid', async () => {
    makeMockProcess('{not: valid json!!!', '', 1)

    const result = await runPlaywrightScript('script', 'exec-17', '/agent')

    // parsePlaywrightJson throws on parse, falls into catch in runPlaywrightScript
    expect(result.success).toBe(false)
    expect(result.results).toEqual([])
    expect(result.passed).toBe(0)
  })

  it('should handle specs with nested suites', async () => {
    const withNestedSpecSuites = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'outer spec',
              tests: [
                { results: [{ status: 'passed', duration: 10, errors: [] }] },
              ],
              suites: [
                {
                  specs: [
                    {
                      title: 'inner spec',
                      tests: [
                        { results: [{ status: 'passed', duration: 20, errors: [] }] },
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
    makeMockProcess(withNestedSpecSuites, '', 0)

    const result = await runPlaywrightScript('script', 'exec-18', '/agent')

    expect(result.passed).toBe(2)
    expect(result.results).toHaveLength(2)
  })

  it('should normalize unknown status to skipped', async () => {
    const unknownStatusJson = JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: 'interrupted test',
              tests: [
                { results: [{ status: 'interrupted', duration: 100, errors: [] }] },
              ],
            },
          ],
        },
      ],
    })
    makeMockProcess(unknownStatusJson, '', 0)

    const result = await runPlaywrightScript('script', 'exec-19', '/agent')

    expect(result.skipped).toBe(1)
    expect(result.passed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.results[0].status).toBe('skipped')
  })
})
