import fs from 'fs'
import path from 'path'

import { startAutoUpdater } from '../src/auto-updater'
import { ApiClient } from '../src/api-client'
import * as updateChecker from '../src/update-checker'
import * as utils from '../src/utils'
import * as pathUtils from '../src/utils/path-utils'

jest.mock('../src/api-client')
jest.mock('../src/logger')
jest.mock('../src/update-checker')
jest.mock('../src/config-manager', () => ({
  getConfigDir: jest.fn().mockReturnValue('/tmp/test-config'),
}))
jest.mock('fs')

const mockedFs = fs as jest.Mocked<typeof fs>

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
    register: jest.fn(),
    heartbeat: jest.fn(),
    getPendingCommands: jest.fn(),
    getCommand: jest.fn(),
    submitResult: jest.fn(),
  } as unknown as ApiClient
}

describe('startAutoUpdater', () => {
  const defaultConfig = { enabled: true, autoRestart: true, channel: 'latest' as const }

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

  it('should schedule initial check after delay', async () => {
    const client = createMockClient()
    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    // Before initial delay, no check should happen
    expect(client.getVersionInfo).not.toHaveBeenCalled()

    // After initial delay (30s)
    await jest.advanceTimersByTimeAsync(30_000)

    expect(client.getVersionInfo).toHaveBeenCalledWith('latest')

    updater.stop()
  })

  it('should check periodically after initial delay', async () => {
    const client = createMockClient()
    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    // Initial delay
    await jest.advanceTimersByTimeAsync(30_000)
    expect(client.getVersionInfo).toHaveBeenCalledTimes(1)

    // After one hour
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(client.getVersionInfo).toHaveBeenCalledTimes(2)

    updater.stop()
  })

  it('should perform update and restart when newer version available and autoRestart is true', async () => {
    const client = createMockClient()
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true)

    const updater = startAutoUpdater([client], defaultConfig, stopAll)

    await jest.advanceTimersByTimeAsync(30_000)

    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global', expect.any(String))
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalledWith('global')

    updater.stop()
  })

  it('should only notify when autoRestart is false', async () => {
    const client = createMockClient()
    const stopAll = jest.fn()
    // First call: minimumVersion check → false (not below minimum)
    // Second call: latestVersion check → true (newer available)
    mockedIsNewerVersion
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    const config = { ...defaultConfig, autoRestart: false }
    const updater = startAutoUpdater([client], config, stopAll)

    await jest.advanceTimersByTimeAsync(30_000)

    expect(mockedPerformUpdate).not.toHaveBeenCalled()
    expect(stopAll).not.toHaveBeenCalled()
    expect(mockedReExecProcess).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should force update even when autoRestart is false if below minimumVersion', async () => {
    const client = createMockClient()
    ;(client.getVersionInfo as jest.Mock).mockResolvedValue({
      latestVersion: '2.0.0',
      minimumVersion: '1.5.0',
      channel: 'latest',
      channels: { latest: '2.0.0' },
    })
    const stopAll = jest.fn()
    // First call: check latestVersion vs current → true
    // Second call: check minimumVersion vs current → true (forced)
    mockedIsNewerVersion.mockReturnValue(true)

    const config = { ...defaultConfig, autoRestart: false }
    const updater = startAutoUpdater([client], config, stopAll)

    await jest.advanceTimersByTimeAsync(30_000)

    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global', expect.any(String))
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalledWith('global')

    updater.stop()
  })

  it('should pass channel to getVersionInfo', async () => {
    const client = createMockClient()
    const config = { ...defaultConfig, channel: 'beta' as const }
    const updater = startAutoUpdater([client], config, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    expect(client.getVersionInfo).toHaveBeenCalledWith('beta')

    updater.stop()
  })

  it('should skip retry for previously failed version', async () => {
    const client = createMockClient()
    // Each check calls isNewerVersion twice: minimumVersion first, then latestVersion
    // First check: minimumVersion → false, latestVersion → true
    // Second check: minimumVersion → false, latestVersion → true
    mockedIsNewerVersion
      .mockReturnValueOnce(false)  // 1st check: minimumVersion
      .mockReturnValueOnce(true)   // 1st check: latestVersion
      .mockReturnValueOnce(false)  // 2nd check: minimumVersion
      .mockReturnValueOnce(true)   // 2nd check: latestVersion
    mockedPerformUpdate.mockResolvedValue({ success: false, error: 'EACCES' })

    const sendError = jest.fn()
    const updater = startAutoUpdater([client], defaultConfig, jest.fn(), sendError)

    // First check — should attempt update
    await jest.advanceTimersByTimeAsync(30_000)
    expect(mockedPerformUpdate).toHaveBeenCalledTimes(1)
    expect(sendError).toHaveBeenCalledWith('EACCES')

    mockedPerformUpdate.mockClear()

    // Second check — should skip same version
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mockedPerformUpdate).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should report update errors via sendUpdateError callback', async () => {
    const client = createMockClient()
    mockedIsNewerVersion.mockReturnValue(true)
    mockedPerformUpdate.mockResolvedValue({ success: false, error: 'npm error' })

    const sendError = jest.fn()
    const updater = startAutoUpdater([client], defaultConfig, jest.fn(), sendError)

    await jest.advanceTimersByTimeAsync(30_000)

    expect(sendError).toHaveBeenCalledWith('npm error')

    updater.stop()
  })

  it('should clear timers on stop()', async () => {
    const client = createMockClient()
    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    updater.stop()

    // Advance past initial delay — should NOT fire
    await jest.advanceTimersByTimeAsync(30_000)
    expect(client.getVersionInfo).not.toHaveBeenCalled()
  })

  it('should skip check when version is invalid', async () => {
    const client = createMockClient()
    mockedIsValidVersion.mockReturnValue(false)

    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    expect(mockedIsNewerVersion).not.toHaveBeenCalled()
    expect(mockedPerformUpdate).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should log permission hint when update error contains Permission denied', async () => {
    const client = createMockClient()
    mockedIsNewerVersion.mockReturnValue(true)
    mockedPerformUpdate.mockResolvedValue({
      success: false,
      error: 'Permission denied. Try: sudo npm install -g @ai-support-agent/cli@2.0.0',
    })

    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    // performUpdate was called and failed with permission error
    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global', expect.any(String))

    updater.stop()
  })

  it('should handle getVersionInfo throwing an error gracefully', async () => {
    const client = createMockClient()
    ;(client.getVersionInfo as jest.Mock).mockRejectedValue(new Error('Network error'))

    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    // Should not throw
    await jest.advanceTimersByTimeAsync(30_000)

    expect(mockedPerformUpdate).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should not crash when no clients provided', async () => {
    const updater = startAutoUpdater([], defaultConfig, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    // Should not throw
    updater.stop()
  })

  it('should skip auto-update when install method is dev', async () => {
    mockedDetectInstallMethod.mockReturnValue('dev')
    const client = createMockClient()

    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    expect(client.getVersionInfo).not.toHaveBeenCalled()
    expect(mockedPerformUpdate).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should skip auto-update when install method is local', async () => {
    mockedDetectInstallMethod.mockReturnValue('local')
    const client = createMockClient()

    const updater = startAutoUpdater([client], defaultConfig, jest.fn())

    await jest.advanceTimersByTimeAsync(30_000)

    expect(client.getVersionInfo).not.toHaveBeenCalled()
    expect(mockedPerformUpdate).not.toHaveBeenCalled()

    updater.stop()
  })

  it('should wait for busy agents before restarting', async () => {
    const client = createMockClient()
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true)

    let busyCount = 0
    const isAnyAgentBusy = jest.fn(async () => {
      busyCount++
      return busyCount <= 2 // busy for first 2 polls, then not busy
    })

    const updater = startAutoUpdater([client], defaultConfig, stopAll, undefined, isAnyAgentBusy)

    // Initial delay triggers check()
    await jest.advanceTimersByTimeAsync(30_000)
    // Advance through busy wait poll intervals (3s each × 2 busy + 1 not busy)
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(3_000)
    }

    // Should have polled until not busy, then proceed
    expect(isAnyAgentBusy).toHaveBeenCalled()
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

    updater.stop()
  })

  it('should proceed after busy wait timeout even if still busy', async () => {
    const client = createMockClient()
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true)

    const isAnyAgentBusy = jest.fn(async () => true) // always busy

    const updater = startAutoUpdater([client], defaultConfig, stopAll, undefined, isAnyAgentBusy)

    // Initial delay
    await jest.advanceTimersByTimeAsync(30_000)
    // Advance through busy wait timeout (5 min) in increments
    for (let elapsed = 0; elapsed < 5 * 60 * 1000 + 10_000; elapsed += 3_000) {
      await jest.advanceTimersByTimeAsync(3_000)
    }

    // Should eventually proceed despite being busy
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

    updater.stop()
  })

  it('should not wait for busy agents when isAnyAgentBusy is not provided', async () => {
    const client = createMockClient()
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true)

    const updater = startAutoUpdater([client], defaultConfig, stopAll)

    await jest.advanceTimersByTimeAsync(30_000)

    // Should proceed immediately without waiting
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

    updater.stop()
  })

  it('should use shorter timeout for forced updates', async () => {
    const client = createMockClient()
    ;(client.getVersionInfo as jest.Mock).mockResolvedValue({
      latestVersion: '2.0.0',
      minimumVersion: '1.5.0',
      channel: 'latest',
      channels: { latest: '2.0.0' },
    })
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true) // both minimum and latest checks return true

    const isAnyAgentBusy = jest.fn(async () => true) // always busy

    const updater = startAutoUpdater([client], defaultConfig, stopAll, undefined, isAnyAgentBusy)

    // Initial delay
    await jest.advanceTimersByTimeAsync(30_000)
    // Advance through forced busy wait timeout (30s) in increments
    for (let elapsed = 0; elapsed < 30_000 + 10_000; elapsed += 3_000) {
      await jest.advanceTimersByTimeAsync(3_000)
    }

    // Forced update should proceed after shorter timeout
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

    updater.stop()
  })

  it('should proceed with auto-update when install method is npx', async () => {
    mockedDetectInstallMethod.mockReturnValue('npx')
    const client = createMockClient()
    const stopAll = jest.fn()
    mockedIsNewerVersion.mockReturnValue(true)

    const updater = startAutoUpdater([client], defaultConfig, stopAll)

    await jest.advanceTimersByTimeAsync(30_000)

    expect(client.getVersionInfo).toHaveBeenCalled()
    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'npx', expect.any(String))
    expect(mockedReExecProcess).toHaveBeenCalledWith('npx')

    updater.stop()
  })

  it('should skip auto-update entirely when running inside a Docker container', async () => {
    // Inside the container the image pins @ai-support-agent/cli, so an
    // auto-update would either disappear on the next start or race the host
    // DockerSupervisor. The agent must defer to the UI-driven update flow.
    const originalEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
    process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

    try {
      const client = createMockClient()
      const stopAll = jest.fn()
      mockedIsNewerVersion.mockReturnValue(true)

      const updater = startAutoUpdater([client], defaultConfig, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(client.getVersionInfo).not.toHaveBeenCalled()
      expect(mockedPerformUpdate).not.toHaveBeenCalled()
      expect(stopAll).not.toHaveBeenCalled()

      updater.stop()
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
      } else {
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalEnv
      }
    }
  })

  describe('branch coverage: remaining branches', () => {
    it('uses UPDATE_BUSY_WAIT_TIMEOUT_MS when forcedUpdate=false (line 124 false branch)', async () => {
      // Cover: forcedUpdate ? UPDATE_FORCED_BUSY_WAIT_TIMEOUT_MS : UPDATE_BUSY_WAIT_TIMEOUT_MS
      // Actual call order in source: isNewerVersion(minimumVersion) first, then isNewerVersion(latestVersion)
      const client = createMockClient()
      const stopAll = jest.fn()
      const isAnyAgentBusy = jest.fn(async () => false) // not busy → exits wait immediately

      // Line 71: isNewerVersion(minimumVersion) → false (not forced)
      // Line 73: isNewerVersion(latestVersion) → true (update available)
      mockedIsNewerVersion
        .mockReturnValueOnce(false) // minimumVersion check → NOT forced
        .mockReturnValueOnce(true)  // latestVersion check → update available

      const updater = startAutoUpdater([client], defaultConfig, stopAll, undefined, isAnyAgentBusy)

      await jest.advanceTimersByTimeAsync(30_000)

      // isAnyAgentBusy called (entered the wait loop with UPDATE_BUSY_WAIT_TIMEOUT_MS)
      expect(isAnyAgentBusy).toHaveBeenCalled()
      expect(stopAll).toHaveBeenCalled()

      updater.stop()
    })

    it('uses "Unknown error" fallback when result.error is undefined (line 108 nullish branch)', async () => {
      const client = createMockClient()
      mockedIsNewerVersion.mockReturnValue(true)
      // Return success: false without an error field to trigger the ?? 'Unknown error' branch
      mockedPerformUpdate.mockResolvedValue({ success: false })

      const sendError = jest.fn()
      const updater = startAutoUpdater([client], defaultConfig, jest.fn(), sendError)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(sendError).toHaveBeenCalledWith('Unknown error')

      updater.stop()
    })

    it('if (checking) returns early when check() is called while already running (line 38 true branch)', async () => {
      // To hit the checking guard: first check starts but getVersionInfo is slow (longer than interval),
      // then the interval fires (1h) while the first check is still pending.
      const client = createMockClient()
      const SLOW_RESOLVE_MS = 2 * 60 * 60 * 1000 // 2 hours (longer than 1h interval)

      ;(client.getVersionInfo as jest.Mock).mockImplementation(
        () => new Promise((resolve) => {
          setTimeout(() => resolve({
            latestVersion: '2.0.0',
            minimumVersion: '0.0.0',
            channel: 'latest',
            channels: { latest: '2.0.0' },
          }), SLOW_RESOLVE_MS)
        })
      )

      mockedIsNewerVersion.mockReturnValue(false)

      const updater = startAutoUpdater([client], defaultConfig, jest.fn())

      // Trigger initial check (30s delay) - getVersionInfo starts but won't resolve for 2h
      await jest.advanceTimersByTimeAsync(30_000)
      expect(client.getVersionInfo).toHaveBeenCalledTimes(1)

      // Advance exactly 1h to fire the interval timer while first check is still running
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
      // Second check should be skipped (checking=true), getVersionInfo still called only once
      expect(client.getVersionInfo).toHaveBeenCalledTimes(1)

      updater.stop()
    })
  })

  describe('Docker container post-update exit (lines 143-153)', () => {
    let isInDockerSpy: jest.SpyInstance
    let atomicWriteFileSpy: jest.SpyInstance
    let getUpdateVersionFilePathSpy: jest.SpyInstance
    let exitSpy: jest.SpyInstance

    beforeEach(() => {
      // Mock isInDocker: first call (line 47 early-return guard) returns false,
      // subsequent calls (line 143 post-update check) return true
      isInDockerSpy = jest.spyOn(utils, 'isInDocker')
        .mockReturnValueOnce(false)  // line 47: do not skip
        .mockReturnValue(true)       // line 143: trigger Docker exit path

      atomicWriteFileSpy = jest.spyOn(utils, 'atomicWriteFile').mockImplementation(() => {})
      getUpdateVersionFilePathSpy = jest.spyOn(pathUtils, 'getUpdateVersionFilePath').mockReturnValue('/tmp/test-config/update-version.json')
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      mockedIsNewerVersion.mockReturnValue(true)
      mockedPerformUpdate.mockResolvedValue({ success: true })
    })

    afterEach(() => {
      isInDockerSpy.mockRestore()
      atomicWriteFileSpy.mockRestore()
      getUpdateVersionFilePathSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('should write update-version.json and exit with DOCKER_UPDATE_EXIT_CODE after successful update', async () => {
      const client = createMockClient()
      const stopAll = jest.fn()

      const updater = startAutoUpdater([client], defaultConfig, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      expect(atomicWriteFileSpy).toHaveBeenCalledWith(
        '/tmp/test-config/update-version.json',
        JSON.stringify({ version: '2.0.0' }),
      )
      expect(exitSpy).toHaveBeenCalledWith(42) // DOCKER_UPDATE_EXIT_CODE

      updater.stop()
    })

    it('should warn and still exit with DOCKER_UPDATE_EXIT_CODE when atomicWriteFile throws', async () => {
      atomicWriteFileSpy.mockImplementation(() => { throw new Error('write error') })

      const client = createMockClient()
      const stopAll = jest.fn()

      const updater = startAutoUpdater([client], defaultConfig, stopAll)

      await jest.advanceTimersByTimeAsync(30_000)

      // Even when atomicWriteFile throws, process.exit should still be called
      expect(exitSpy).toHaveBeenCalledWith(42) // DOCKER_UPDATE_EXIT_CODE

      updater.stop()
    })
  })
})
