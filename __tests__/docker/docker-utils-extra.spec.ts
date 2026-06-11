/**
 * Additional tests for docker utility files:
 * - dockerfile-sync.ts
 * - project-config.ts (migrateProjectConfigDir)
 * - update-handler.ts
 *
 * These cover branch paths not exercised by other test suites.
 */

jest.mock('fs')
jest.mock('../../src/logger')
jest.mock('../../src/i18n', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      let msg = key
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replace(`{{${k}}}`, String(v))
      }
      return msg
    }
    return key
  },
  initI18n: jest.fn(),
}))

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => '/mock/config-dir'),
}))

jest.mock('../../src/docker/dockerfile-path', () => ({
  getDockerfilePath: jest.fn(() => '/mock/docker/Dockerfile'),
  getDockerContextDir: jest.fn(() => '/mock'),
}))

jest.mock('../../src/update-checker', () => ({
  performUpdate: jest.fn(),
  reExecProcess: jest.fn(),
}))

jest.mock('../../src/utils/version', () => ({
  isValidVersion: jest.fn(),
}))

jest.mock('../../src/docker/version-manager', () => ({
  resetInstalledVersionCache: jest.fn(),
}))

import * as crypto from 'crypto'
import * as fs from 'fs'
import { syncDockerfileToConfigDir } from '../../src/docker/dockerfile-sync'
import { migrateProjectConfigDir } from '../../src/docker/project-config'
import { installUpdateAndRestart } from '../../src/docker/update-handler'
import { logger } from '../../src/logger'
import { performUpdate, reExecProcess } from '../../src/update-checker'
import { isValidVersion } from '../../src/utils/version'
import { resetInstalledVersionCache } from '../../src/docker/version-manager'

const mockedFs = jest.mocked(fs)
const mockedPerformUpdate = jest.mocked(performUpdate)
const mockedReExecProcess = jest.mocked(reExecProcess)
const mockedIsValidVersion = jest.mocked(isValidVersion)
const mockedResetInstalledVersionCache = jest.mocked(resetInstalledVersionCache)

const BUNDLED_CONTENT = 'FROM node:24-slim\n# bundled v2'
const BUNDLED_HASH = crypto.createHash('sha256').update(BUNDLED_CONTENT).digest('hex')

describe('dockerfile-sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.copyFileSync.mockReturnValue(undefined)
    mockedFs.writeFileSync.mockReturnValue(undefined)
  })

  describe('syncDockerfileToConfigDir', () => {
    it('should skip if hash file exists and Dockerfile matches saved hash (not customised, up to date)', () => {
      mockedFs.existsSync.mockImplementation((p: unknown) => {
        const s = String(p)
        return s === '/mock/config-dir/.dockerfile-sync-hash' || s === '/mock/config-dir/Dockerfile'
      })
      mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
        const s = String(p)
        if (s === '/mock/docker/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        if (s === '/mock/config-dir/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        if (s === '/mock/config-dir/.dockerfile-sync-hash') return BUNDLED_HASH
        throw new Error(`unexpected readFileSync: ${s}`)
      })

      syncDockerfileToConfigDir()

      expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('should copy Dockerfile and log info when hash file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
        if (String(p) === '/mock/docker/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        throw new Error(`unexpected readFileSync: ${String(p)}`)
      })

      syncDockerfileToConfigDir()

      expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(1)
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('docker.dockerfileSynced'),
      )
    })

    it('should also copy entrypoint.sh when it exists alongside Dockerfile', () => {
      mockedFs.existsSync.mockImplementation((p: unknown) => {
        const s = String(p)
        return s === '/mock/docker/entrypoint.sh'
      })
      mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
        if (String(p) === '/mock/docker/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        // entrypoint.sh is part of the combined sync hash, so it is read too
        if (String(p) === '/mock/docker/entrypoint.sh') return Buffer.from('#!/bin/sh\n# entrypoint')
        throw new Error(`unexpected readFileSync: ${String(p)}`)
      })

      syncDockerfileToConfigDir()

      // Expect 2 copyFileSync calls: Dockerfile + entrypoint.sh
      expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(2)
    })

    it('should log a warning when copy throws a non-Error exception', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
        if (String(p) === '/mock/docker/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        throw new Error(`unexpected: ${String(p)}`)
      })
      // Throw a string (non-Error) to cover the `String(err)` branch
      mockedFs.copyFileSync.mockImplementation(() => { throw 'disk is full' })

      syncDockerfileToConfigDir()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('docker.dockerfileSyncFailed'),
      )
    })

    it('should log a warning when copy throws an Error instance', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
        if (String(p) === '/mock/docker/Dockerfile') return Buffer.from(BUNDLED_CONTENT)
        throw new Error(`unexpected: ${String(p)}`)
      })
      mockedFs.copyFileSync.mockImplementation(() => { throw new Error('permission denied') })

      syncDockerfileToConfigDir()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('docker.dockerfileSyncFailed'),
      )
    })
  })
})

describe('project-config', () => {
  const project = { tenantCode: 'mbc', projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }

  describe('getProjectConfigHostDir', () => {
    it('should return the per-project config directory path', () => {
      const { getProjectConfigHostDir } = require('../../src/docker/project-config') as typeof import('../../src/docker/project-config')
      const dir = getProjectConfigHostDir(project)
      expect(dir).toContain('/mock/config-dir')
      expect(dir).toContain('/mbc/')
      expect(dir).toContain('/MBC_01/')
      expect(dir).toContain('.ai-support-agent')
    })
  })

  describe('migrateProjectConfigDir', () => {

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should do nothing when legacy dir does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false)

    migrateProjectConfigDir(project)

    expect(mockedFs.renameSync).not.toHaveBeenCalled()
  })

  it('should do nothing when new dir already exists (already migrated)', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => {
      const s = p as string
      // Legacy dir exists, new dir also exists → skip
      return true
    })

    migrateProjectConfigDir(project)

    expect(mockedFs.renameSync).not.toHaveBeenCalled()
  })

  it('should migrate legacy dir to new dir when only legacy exists', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => {
      const s = p as string
      // Legacy dir (/mock/config-dir/projects/MBC_01) exists
      if (s.endsWith('/MBC_01') && !s.includes('/mbc/')) return true
      // New dir (/mock/config-dir/projects/mbc/MBC_01) does NOT exist
      return false
    })
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.renameSync.mockReturnValue(undefined)

    migrateProjectConfigDir(project)

    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('/MBC_01'),
      expect.stringContaining('/mbc/MBC_01'),
    )
    expect(logger.info).toHaveBeenCalled()
  })

  it('should log a warning when rename throws an Error', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => {
      const s = p as string
      if (s.endsWith('/MBC_01') && !s.includes('/mbc/')) return true
      return false
    })
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.renameSync.mockImplementation(() => { throw new Error('EACCES') })

    migrateProjectConfigDir(project)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to migrate'),
    )
  })

  it('should log a warning with String(err) when rename throws a non-Error', () => {
    mockedFs.existsSync.mockImplementation((p: unknown) => {
      const s = p as string
      if (s.endsWith('/MBC_01') && !s.includes('/mbc/')) return true
      return false
    })
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.renameSync.mockImplementation(() => { throw 'rename failed: disk full' })

    migrateProjectConfigDir(project)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rename failed: disk full'),
    )
  })
  }) // end describe('migrateProjectConfigDir')
}) // end describe('project-config')

describe('update-handler (installUpdateAndRestart)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedReExecProcess.mockReturnValue(undefined)
  })

  it('should call reExecProcess when no version file found', async () => {
    mockedFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT') })

    await installUpdateAndRestart()

    expect(mockedReExecProcess).toHaveBeenCalled()
    expect(mockedPerformUpdate).not.toHaveBeenCalled()
  })

  it('should call reExecProcess when version file has an invalid version', async () => {
    mockedIsValidVersion.mockReturnValue(false)
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ version: 'invalid-version' }))
    mockedFs.unlinkSync.mockReturnValue(undefined)

    await installUpdateAndRestart()

    expect(mockedPerformUpdate).not.toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()
  })

  it('should perform update and reset cache when version is valid and update succeeds', async () => {
    mockedIsValidVersion.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }))
    mockedFs.unlinkSync.mockReturnValue(undefined)
    mockedPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart()

    expect(mockedPerformUpdate).toHaveBeenCalledWith('1.2.3', 'global')
    expect(mockedResetInstalledVersionCache).toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()
  })

  it('should log a warning when update fails (result.success is false)', async () => {
    mockedIsValidVersion.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }))
    mockedFs.unlinkSync.mockReturnValue(undefined)
    mockedPerformUpdate.mockResolvedValue({ success: false, error: 'npm failed' })

    await installUpdateAndRestart()

    expect(mockedPerformUpdate).toHaveBeenCalledWith('1.2.3', 'global')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('npm failed'),
    )
    expect(mockedResetInstalledVersionCache).not.toHaveBeenCalled()
    expect(mockedReExecProcess).toHaveBeenCalled()
  })

  it('should log a warning with unknown when update fails with no error message', async () => {
    mockedIsValidVersion.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ version: '1.2.3' }))
    mockedFs.unlinkSync.mockReturnValue(undefined)
    mockedPerformUpdate.mockResolvedValue({ success: false })

    await installUpdateAndRestart()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown'),
    )
    expect(mockedReExecProcess).toHaveBeenCalled()
  })

  it('should search projectConfigDir first, then fall back to global config dir', async () => {
    mockedIsValidVersion.mockReturnValue(true)
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const filePath = p as string
      if (filePath.startsWith('/project/config')) {
        return JSON.stringify({ version: '2.0.0' })
      }
      throw new Error('ENOENT')
    })
    mockedFs.unlinkSync.mockReturnValue(undefined)
    mockedPerformUpdate.mockResolvedValue({ success: true })

    await installUpdateAndRestart('/project/config')

    expect(mockedPerformUpdate).toHaveBeenCalledWith('2.0.0', 'global')
    expect(mockedReExecProcess).toHaveBeenCalled()
  })
})
