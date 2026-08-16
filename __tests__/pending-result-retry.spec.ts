/**
 * Regression test — command results orphaned by an API deployment.
 *
 * Production evidence (2026-08-16 deployment):
 * When the API rolls over, the agent's HTTP submit can fail. The result is written
 * to disk (`savePendingResult`) but two things then conspire to lose it:
 *
 *   1. `submitPendingResults()` was only ever called from `registerAndStart()`,
 *      i.e. once per agent process start. The agent is long-lived and does NOT
 *      restart when the API is deployed, so the file just sat there.
 *   2. `STALE_THRESHOLD_MS` was 1 hour, while the API only gives up on a running
 *      command after `MAX_COMMAND_EXECUTION_MS` = 2 hours. The file was therefore
 *      deleted an hour *before* the server stopped waiting for it — guaranteeing
 *      the result could never arrive, and the job was reported as TIMEOUT.
 *
 * These tests pin the corrected contract: retry periodically, and keep the file
 * alive at least as long as the server is still willing to accept it.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ApiClient } from '../src/api-client'
import {
  loadPendingResults,
  savePendingResult,
  startPendingResultFlush,
  PENDING_RESULT_FLUSH_INTERVAL_MS,
  PENDING_RESULT_STALE_THRESHOLD_MS,
  PENDING_RESULT_MIN_RETRY_AGE_MS,
} from '../src/pending-result-store'


jest.mock('../src/api-client')
jest.mock('../src/logger')

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>

/**
 * The server keeps a claimed command in RUNNING for this long before sweeping it
 * to TIMEOUT (api: `MAX_COMMAND_EXECUTION_MS` in src/common/constants/agent.constants.ts).
 * The agent must not throw away a result the server would still accept.
 */
const API_MAX_COMMAND_EXECUTION_MS = 2 * 60 * 60 * 1000

describe('pending result retry — surviving an API deployment', () => {
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-retry-'))
    jest
      .spyOn(require('../src/config-manager'), 'getConfigDir')
      .mockReturnValue(tempDir)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  const mockResult = { success: true as const, data: 'test output' }

  /**
   * Age a pending file past PENDING_RESULT_MIN_RETRY_AGE_MS so the periodic flush
   * will take it over (the guard exists so the flush cannot race the main-path
   * submit, which writes the file before sending).
   */
  const ageBeyondRetryGuard = (commandId: string): void => {
    const filePath = path.join(tempDir, 'pending-results', `${commandId}.json`)
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    content.savedAt = new Date(
      Date.now() - PENDING_RESULT_MIN_RETRY_AGE_MS - 1000,
    ).toISOString()
    fs.writeFileSync(filePath, JSON.stringify(content))
  }

  describe('stale threshold', () => {
    it('outlives the server-side command timeout', () => {
      // If the agent discards first, the result is provably unrecoverable.
      expect(PENDING_RESULT_STALE_THRESHOLD_MS).toBeGreaterThan(
        API_MAX_COMMAND_EXECUTION_MS,
      )
    })

    it('keeps a result saved 90 minutes ago (server still waiting for it)', () => {
      savePendingResult(
        'cmd-90min',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      const filePath = path.join(tempDir, 'pending-results', 'cmd-90min.json')
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      content.savedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString()
      fs.writeFileSync(filePath, JSON.stringify(content))

      const results = loadPendingResults()

      expect(results.map((r) => r.commandId)).toContain('cmd-90min')
      expect(fs.existsSync(filePath)).toBe(true)
    })
  })

  describe('observability of lost results', () => {
    // `logger.debug` is gated behind --verbose (src/logger.ts), so anything that
    // loses a completed command's result must be logged above debug or it is
    // invisible in normal operation.
    const logger = require('../src/logger').logger as {
      error: jest.Mock
      warn: jest.Mock
      debug: jest.Mock
    }

    it('reports a failed save at error level and tells the caller it failed', () => {
      jest
        .spyOn(require('../src/config-manager'), 'getConfigDir')
        .mockReturnValue('/nonexistent/path/that/will/fail')

      const persisted = savePendingResult(
        'cmd-unsaveable',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      expect(persisted).toBe(false)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('cmd-unsaveable'),
      )
    })

    it('returns true when the result reaches disk', () => {
      expect(
        savePendingResult(
          'cmd-saveable',
          'agent-1',
          mockResult,
          'http://api',
          'tok',
          'tenant-1',
        ),
      ).toBe(true)
    })

    it('warns when a result is discarded for exceeding the retention window', () => {
      savePendingResult(
        'cmd-expired',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )
      const filePath = path.join(tempDir, 'pending-results', 'cmd-expired.json')
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      content.savedAt = new Date(
        Date.now() - PENDING_RESULT_STALE_THRESHOLD_MS - 60 * 1000,
      ).toISOString()
      fs.writeFileSync(filePath, JSON.stringify(content))

      loadPendingResults()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('cmd-expired'),
      )
    })
  })

  describe('periodic flush', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('retries pending results on an interval, not only at process start', async () => {
      const submitResult = jest.fn().mockResolvedValue(undefined)
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult,
            setTenantCode: jest.fn(),
            restoreAssignment: jest.fn(),
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-orphaned',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )
      ageBeyondRetryGuard('cmd-orphaned')

      const timer = startPendingResultFlush()
      try {
        expect(submitResult).not.toHaveBeenCalled()

        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)

        expect(submitResult).toHaveBeenCalledWith(
          'cmd-orphaned',
          mockResult,
          'agent-1',
        )
      } finally {
        clearInterval(timer)
      }
    })

    it('keeps retrying while submission keeps failing', async () => {
      const submitResult = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('ECONNRESET'), {}))
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult,
            setTenantCode: jest.fn(),
            restoreAssignment: jest.fn(),
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-retry',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )
      ageBeyondRetryGuard('cmd-retry')

      const timer = startPendingResultFlush()
      try {
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)

        expect(submitResult.mock.calls.length).toBeGreaterThanOrEqual(3)
        // The file must still be there — a transient network failure is not a
        // reason to drop a completed job's result.
        expect(
          fs.existsSync(path.join(tempDir, 'pending-results', 'cmd-retry.json')),
        ).toBe(true)
      } finally {
        clearInterval(timer)
      }
    })

    it('does not overlap flushes when one is still in flight', async () => {
      let resolveSubmit: (() => void) | undefined
      const submitResult = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSubmit = resolve
          }),
      )
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult,
            setTenantCode: jest.fn(),
            restoreAssignment: jest.fn(),
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-slow',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )
      ageBeyondRetryGuard('cmd-slow')

      const timer = startPendingResultFlush()
      try {
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(submitResult).toHaveBeenCalledTimes(1)

        // A second tick while the first submit is still pending must not pile on.
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(submitResult).toHaveBeenCalledTimes(1)

        resolveSubmit?.()
      } finally {
        clearInterval(timer)
      }
    })

    it('survives an unexpected failure and keeps flushing on later ticks', async () => {
      // If the flush loop wedged on an unexpected error (no catch, or the
      // in-flight guard never released), every subsequent retry would be dead
      // and the orphaned result would be lost for good.
      const submitResult = jest.fn().mockResolvedValue(undefined)
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult,
            setTenantCode: jest.fn(),
            restoreAssignment: jest.fn(),
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-after-error',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      const configManager = require('../src/config-manager')
      const getConfigDir = jest.spyOn(configManager, 'getConfigDir')
      // getPendingDir() runs outside loadPendingResults' try/catch, so this
      // rejects submitPendingResults() itself.
      getConfigDir.mockImplementationOnce(() => {
        throw new Error('config dir unavailable')
      })

      const timer = startPendingResultFlush()
      try {
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(submitResult).not.toHaveBeenCalled()

        // Next tick must still run — the guard has to be released in `finally`.
        getConfigDir.mockReturnValue(tempDir)
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)

        expect(submitResult).toHaveBeenCalledWith(
          'cmd-after-error',
          mockResult,
          'agent-1',
        )
      } finally {
        clearInterval(timer)
      }
    })

    it('escalates to error when the flush loop keeps failing', async () => {
      const logger = require('../src/logger').logger as {
        error: jest.Mock
        warn: jest.Mock
      }
      const getConfigDir = jest.spyOn(
        require('../src/config-manager'),
        'getConfigDir',
      )

      const timer = startPendingResultFlush()
      try {
        // The consecutive-failure counter lives at module scope, so a previous test
        // could leave it non-zero. Drive one successful tick first (no pending files
        // => submitPendingResults resolves immediately) to reset the streak to 0.
        getConfigDir.mockReturnValue(tempDir)
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        ;(logger.error as jest.Mock).mockClear()
        ;(logger.warn as jest.Mock).mockClear()
        getConfigDir.mockImplementation(() => {
          throw new Error('config dir unavailable')
        })

        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(logger.warn).toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()

        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('no longer being resent'),
        )
      } finally {
        clearInterval(timer)
        getConfigDir.mockReturnValue(tempDir)
      }
    })

    it('does not touch a result whose main-path submit may still be in flight', async () => {
      // agent-transport writes the file BEFORE calling submitResult, and that submit
      // can take ~35s (10s timeout x 3 retries + backoff). Picking it up here would
      // POST the same result twice in parallel.
      const submitResult = jest.fn().mockResolvedValue(undefined)
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult,
            setTenantCode: jest.fn(),
            restoreAssignment: jest.fn(),
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-just-saved',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      const timer = startPendingResultFlush()
      try {
        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(submitResult).not.toHaveBeenCalled()

        // Once the file is older than the main path could possibly still be using,
        // the flush takes it over.
        const filePath = path.join(
          tempDir,
          'pending-results',
          'cmd-just-saved.json',
        )
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        content.savedAt = new Date(
          Date.now() - PENDING_RESULT_MIN_RETRY_AGE_MS - 1000,
        ).toISOString()
        fs.writeFileSync(filePath, JSON.stringify(content))

        await jest.advanceTimersByTimeAsync(PENDING_RESULT_FLUSH_INTERVAL_MS)
        expect(submitResult).toHaveBeenCalledWith(
          'cmd-just-saved',
          mockResult,
          'agent-1',
        )
      } finally {
        clearInterval(timer)
      }
    })

    it('the retry age guard exceeds the worst-case main-path submit duration', () => {
      // API_REQUEST_TIMEOUT (10s) x API_MAX_RETRIES (3) plus backoff.
      const WORST_CASE_SUBMIT_MS = 10_000 * 3 + 5_000
      expect(PENDING_RESULT_MIN_RETRY_AGE_MS).toBeGreaterThan(
        WORST_CASE_SUBMIT_MS,
      )
    })

    it('uses an interval short enough to recover within a deployment window', () => {
      // A production rollover takes ~85 seconds end to end (measured 2026-08-16:
      // stoppingAt 12:55:24 → stoppedAt 12:56:49). Retrying less often than that
      // would leave results stranded for multiple deploys.
      expect(PENDING_RESULT_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(2 * 60 * 1000)
    })
  })
})
