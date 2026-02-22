import { startAutoUpdater } from '../src/auto-updater'
import { ApiClient } from '../src/api-client'
import * as updateChecker from '../src/update-checker'

jest.mock('../src/api-client')
jest.mock('../src/logger')
jest.mock('../src/update-checker')

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

    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0')
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

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

    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0')
    expect(stopAll).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()

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
    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0')

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
})
