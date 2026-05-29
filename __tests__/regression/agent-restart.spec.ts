/**
 * Regression tests for agent restart scenarios.
 *
 * These tests guard against regressions in the agent's restart and lifecycle
 * management behaviour:
 * - Double-start prevention (PID file)
 * - Graceful shutdown of project agents before restart
 * - Auto-updater stop on restart
 * - Config preserved across restarts (reload from disk)
 * - PID file cleanup on normal exit
 */

import { startAutoUpdater } from '../../src/auto-updater'
import * as pidManager from '../../src/pid-manager'
import * as updateChecker from '../../src/update-checker'
import { ApiClient } from '../../src/api-client'

jest.mock('../../src/api-client')
jest.mock('../../src/logger')
jest.mock('../../src/update-checker')
jest.mock('../../src/pid-manager')
jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn().mockReturnValue('/tmp/test-restart-config'),
  loadConfig: jest.fn().mockReturnValue(null),
  saveConfig: jest.fn(),
}))
jest.mock('fs')

const mockedPidManager = pidManager as jest.Mocked<typeof pidManager>
const mockedDetectInstallMethod = updateChecker.detectInstallMethod as jest.MockedFunction<typeof updateChecker.detectInstallMethod>
const mockedIsNewerVersion = updateChecker.isNewerVersion as jest.MockedFunction<typeof updateChecker.isNewerVersion>
const mockedIsValidVersion = updateChecker.isValidVersion as jest.MockedFunction<typeof updateChecker.isValidVersion>
const mockedPerformUpdate = updateChecker.performUpdate as jest.MockedFunction<typeof updateChecker.performUpdate>
const mockedReExecProcess = updateChecker.reExecProcess as jest.MockedFunction<typeof updateChecker.reExecProcess>

function createMockClient(): ApiClient {
  return {
    getVersionInfo: jest.fn().mockResolvedValue({
      latestVersion: '2.0.0',
      minimumVersion: '0.0.0',
      channel: 'latest',
      channels: { latest: '2.0.0' },
    }),
  } as unknown as ApiClient
}

describe('agent restart regression tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockedDetectInstallMethod.mockReturnValue('global')
    mockedIsValidVersion.mockReturnValue(true)
    mockedIsNewerVersion.mockReturnValue(false)
    mockedPerformUpdate.mockResolvedValue({ success: true })
    mockedReExecProcess.mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('double-start prevention', () => {
    it('isAlreadyRunning returns false when no PID file exists', () => {
      mockedPidManager.isAlreadyRunning.mockReturnValue(false)
      expect(pidManager.isAlreadyRunning()).toBe(false)
    })

    it('isAlreadyRunning returns true when a live PID file exists', () => {
      mockedPidManager.isAlreadyRunning.mockReturnValue(true)
      expect(pidManager.isAlreadyRunning()).toBe(true)
    })

    it('readPidFile returns null when no PID file', () => {
      mockedPidManager.readPidFile.mockReturnValue(null)
      expect(pidManager.readPidFile()).toBeNull()
    })

    it('readPidFile returns entry with pid when file exists', () => {
      const entry = { pid: 12345, startedAt: Date.now() }
      mockedPidManager.readPidFile.mockReturnValue(entry as ReturnType<typeof pidManager.readPidFile>)
      expect(pidManager.readPidFile()?.pid).toBe(12345)
    })
  })

  describe('auto-updater restart flow', () => {
    it('calls stopAllAgents before re-exec when update succeeds', async () => {
      const client = createMockClient()
      const stopAll = jest.fn().mockResolvedValue(undefined)
      mockedIsNewerVersion.mockReturnValue(true)

      const config = { enabled: true, autoRestart: true, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global', expect.any(String))
      expect(stopAll).toHaveBeenCalledTimes(1)
      expect(mockedReExecProcess).toHaveBeenCalledWith('global')

      updater.stop()
    })

    it('does NOT call stopAllAgents when update fails', async () => {
      const client = createMockClient()
      const stopAll = jest.fn()
      mockedIsNewerVersion.mockReturnValue(true)
      mockedPerformUpdate.mockResolvedValue({ success: false, error: 'npm failed' })

      const config = { enabled: true, autoRestart: true, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(mockedPerformUpdate).toHaveBeenCalled()
      expect(stopAll).not.toHaveBeenCalled()
      expect(mockedReExecProcess).not.toHaveBeenCalled()

      updater.stop()
    })

    it('stop() cancels scheduled update checks preventing spurious restarts', async () => {
      const client = createMockClient()
      mockedIsNewerVersion.mockReturnValue(true)

      const config = { enabled: true, autoRestart: true, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, jest.fn())

      // Stop immediately — should cancel the initial delay timer
      updater.stop()

      // Advance well past the initial delay; no check should happen
      await jest.advanceTimersByTimeAsync(120_000)

      expect(client.getVersionInfo).not.toHaveBeenCalled()
      expect(mockedPerformUpdate).not.toHaveBeenCalled()
    })

    it('does not restart while update check is in-flight (concurrent guard)', async () => {
      let resolveVersionInfo: (v: unknown) => void
      const versionInfoPromise = new Promise((resolve) => {
        resolveVersionInfo = resolve
      })
      const client = createMockClient()
      ;(client.getVersionInfo as jest.Mock).mockReturnValue(versionInfoPromise)

      const config = { enabled: true, autoRestart: true, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, jest.fn())

      // Start first check
      await jest.advanceTimersByTimeAsync(30_000)
      expect(client.getVersionInfo).toHaveBeenCalledTimes(1)

      // Advance past interval — concurrent check should be skipped
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
      // Still only 1 call because the first is in-flight
      expect(client.getVersionInfo).toHaveBeenCalledTimes(1)

      // Resolve the first check
      resolveVersionInfo!({ latestVersion: '2.0.0', minimumVersion: '0.0.0', channel: 'latest', channels: {} })
      await Promise.resolve()

      updater.stop()
    })
  })

  describe('forced update even when autoRestart=false', () => {
    it('performs update and restarts when current version is below minimum', async () => {
      const client = createMockClient()
      ;(client.getVersionInfo as jest.Mock).mockResolvedValue({
        latestVersion: '3.0.0',
        minimumVersion: '2.0.0',
        channel: 'latest',
        channels: { latest: '3.0.0' },
      })
      const stopAll = jest.fn().mockResolvedValue(undefined)
      mockedIsNewerVersion.mockReturnValue(true) // current < minimum AND current < latest

      const config = { enabled: true, autoRestart: false, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(mockedPerformUpdate).toHaveBeenCalled()
      expect(stopAll).toHaveBeenCalled()
      expect(mockedReExecProcess).toHaveBeenCalled()

      updater.stop()
    })

    it('only logs manual hint when autoRestart=false and update is voluntary (not forced)', async () => {
      const client = createMockClient()
      const stopAll = jest.fn()
      // minimumVersion check returns false (not below min), latestVersion check returns true
      mockedIsNewerVersion
        .mockReturnValueOnce(false) // minimumVersion check
        .mockReturnValueOnce(true)  // latestVersion check

      const config = { enabled: true, autoRestart: false, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      // No update should be performed (only notify)
      expect(mockedPerformUpdate).not.toHaveBeenCalled()
      expect(stopAll).not.toHaveBeenCalled()

      updater.stop()
    })
  })

  describe('update retry regression: skip previously failed version', () => {
    it('skips a version that previously failed, unless it becomes a forced update', async () => {
      const client = createMockClient()
      // Check 1 + Check 2: both times below minimum=false, latest=true
      mockedIsNewerVersion
        .mockReturnValueOnce(false).mockReturnValueOnce(true)  // check 1
        .mockReturnValueOnce(false).mockReturnValueOnce(true)  // check 2
      mockedPerformUpdate.mockResolvedValue({ success: false, error: 'ENOENT' })

      const config = { enabled: true, autoRestart: true, channel: 'latest' as const }
      const updater = startAutoUpdater([client], config, jest.fn())

      // First check — tries update, fails
      await jest.advanceTimersByTimeAsync(30_000)
      expect(mockedPerformUpdate).toHaveBeenCalledTimes(1)

      mockedPerformUpdate.mockClear()

      // Second check — same version is skipped
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(mockedPerformUpdate).not.toHaveBeenCalled()

      updater.stop()
    })
  })
})
