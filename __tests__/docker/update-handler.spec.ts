/**
 * Tests for src/docker/update-handler.ts
 *
 * Exercises installUpdateAndRestart():
 * - reads update-version.json from project-specific or global config dir
 * - validates the version; installs it; calls reExecProcess
 * - handles missing files, invalid versions, failed installs
 */

jest.mock('fs')

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn().mockReturnValue('/global-config'),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

jest.mock('../../src/utils/version', () => ({
  isValidVersion: jest.fn(),
}))

jest.mock('../../src/update-checker', () => ({
  performUpdate: jest.fn(),
  reExecProcess: jest.fn(),
}))

jest.mock('../../src/docker/version-manager', () => ({
  resetInstalledVersionCache: jest.fn(),
}))

import * as fs from 'fs'
import * as path from 'path'
import { getConfigDir } from '../../src/config-manager'
import { isValidVersion } from '../../src/utils/version'
import { performUpdate, reExecProcess } from '../../src/update-checker'
import { resetInstalledVersionCache } from '../../src/docker/version-manager'
import { installUpdateAndRestart } from '../../src/docker/update-handler'
import { logger } from '../../src/logger'

const mockFs = fs as jest.Mocked<typeof fs>
const mockGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>
const mockIsValidVersion = isValidVersion as jest.MockedFunction<typeof isValidVersion>
const mockPerformUpdate = performUpdate as jest.MockedFunction<typeof performUpdate>
const mockReExecProcess = reExecProcess as jest.MockedFunction<typeof reExecProcess>
const mockResetInstalledVersionCache = resetInstalledVersionCache as jest.MockedFunction<typeof resetInstalledVersionCache>
const mockLogger = logger as jest.Mocked<typeof logger>

describe('installUpdateAndRestart', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetConfigDir.mockReturnValue('/global-config')
  })

  // ------------------------------------------------------------------ happy paths

  it('reads version from global config dir and installs it', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart()

    expect(mockPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global')
    expect(mockReExecProcess).toHaveBeenCalled()
  })

  it('reads version from project-specific config dir first', async () => {
    const versionData = JSON.stringify({ version: '3.1.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart('/project-config')

    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      path.join('/project-config', 'update-version.json'),
      'utf-8',
    )
    expect(mockPerformUpdate).toHaveBeenCalledWith('3.1.0', 'global')
  })

  it('falls back to global config dir when project config dir file is missing', async () => {
    const versionData = JSON.stringify({ version: '2.5.0' })
    // First call (project dir) throws, second call (global dir) succeeds
    mockFs.readFileSync
      .mockImplementationOnce(() => { throw new Error('ENOENT') })
      .mockReturnValueOnce(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart('/project-config')

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2)
    expect(mockFs.readFileSync).toHaveBeenNthCalledWith(
      2,
      path.join('/global-config', 'update-version.json'),
      'utf-8',
    )
    expect(mockPerformUpdate).toHaveBeenCalledWith('2.5.0', 'global')
  })

  it('invalidates version cache after successful install', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart()

    expect(mockResetInstalledVersionCache).toHaveBeenCalled()
  })

  it('removes the version file after reading it', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart()

    expect(mockFs.unlinkSync).toHaveBeenCalledWith(
      path.join('/global-config', 'update-version.json'),
    )
  })

  // ------------------------------------------------------------------ no version file

  it('calls reExecProcess even when no version file exists', async () => {
    // All readFileSync calls throw (no version file anywhere)
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    await installUpdateAndRestart()

    expect(mockPerformUpdate).not.toHaveBeenCalled()
    expect(mockReExecProcess).toHaveBeenCalled()
  })

  it('does not call performUpdate when no newVersion found', async () => {
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    await installUpdateAndRestart('/project-config')

    expect(mockPerformUpdate).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------ invalid version in file

  it('does not install when version in file is invalid', async () => {
    const versionData = JSON.stringify({ version: 'not-semver' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(false)

    await installUpdateAndRestart()

    expect(mockPerformUpdate).not.toHaveBeenCalled()
    expect(mockReExecProcess).toHaveBeenCalled()
  })

  it('does not install when version field is missing from JSON', async () => {
    const versionData = JSON.stringify({ other: 'data' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)

    await installUpdateAndRestart()

    expect(mockPerformUpdate).not.toHaveBeenCalled()
  })

  it('removes the version file even when version is invalid', async () => {
    const versionData = JSON.stringify({ version: 'bad-version' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(false)

    await installUpdateAndRestart()

    // unlinkSync should still be called to remove the invalid file
    expect(mockFs.unlinkSync).toHaveBeenCalled()
  })

  // ------------------------------------------------------------------ failed install

  it('warns but still calls reExecProcess when performUpdate fails', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: false, error: 'network error' })

    await installUpdateAndRestart()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('network error'),
    )
    expect(mockResetInstalledVersionCache).not.toHaveBeenCalled()
    expect(mockReExecProcess).toHaveBeenCalled()
  })

  it('warns with "unknown" error when performUpdate fails without error message', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: false })

    await installUpdateAndRestart()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown'),
    )
  })

  it('does not invalidate version cache when install fails', async () => {
    const versionData = JSON.stringify({ version: '2.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: false, error: 'fail' })

    await installUpdateAndRestart()

    expect(mockResetInstalledVersionCache).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------ logging

  it('logs install info message before calling performUpdate', async () => {
    const versionData = JSON.stringify({ version: '4.0.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart()

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('4.0.0'),
    )
  })

  // ------------------------------------------------------------------ no project config dir argument

  it('uses only global config dir when no projectConfigDir provided', async () => {
    const versionData = JSON.stringify({ version: '1.5.0' })
    mockFs.readFileSync.mockReturnValue(versionData)
    mockFs.unlinkSync.mockReturnValue(undefined)
    mockIsValidVersion.mockReturnValue(true)
    mockPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart() // no argument

    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      path.join('/global-config', 'update-version.json'),
      'utf-8',
    )
    // Should only search one dir (global only)
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1)
  })

  it('passes 2 search dirs when projectConfigDir is provided', async () => {
    // Both throw so we can count the attempts
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    await installUpdateAndRestart('/project-dir')

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(2)
  })
})
