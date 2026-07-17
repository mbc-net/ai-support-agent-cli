/**
 * Tests for src/docker/version-manager.ts
 *
 * Exercises getInstalledVersion(), resetInstalledVersionCache(), and ensureImage().
 */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}))

jest.mock('../../src/constants', () => ({
  AGENT_VERSION: '1.0.0',
  NPM_COMMAND: 'npm',
}))

jest.mock('../../src/utils/version', () => ({
  isValidVersion: jest.fn(),
  isNewerVersion: jest.fn(),
}))

jest.mock('../../src/docker/docker-utils', () => ({
  imageExists: jest.fn(),
  buildImage: jest.fn(),
  pruneOldImages: jest.fn(),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string) => key),
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

import { execFileSync } from 'child_process'
import { isValidVersion, isNewerVersion } from '../../src/utils/version'
import { imageExists, buildImage, pruneOldImages } from '../../src/docker/docker-utils'
import {
  getInstalledVersion,
  resetInstalledVersionCache,
  ensureImage,
} from '../../src/docker/version-manager'
import { logger } from '../../src/logger'

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>
const mockIsValidVersion = isValidVersion as jest.MockedFunction<typeof isValidVersion>
const mockIsNewerVersion = isNewerVersion as jest.MockedFunction<typeof isNewerVersion>
const mockImageExists = imageExists as jest.MockedFunction<typeof imageExists>
const mockBuildImage = buildImage as jest.MockedFunction<typeof buildImage>
const mockPruneOldImages = pruneOldImages as jest.MockedFunction<typeof pruneOldImages>
const mockLogger = logger as jest.Mocked<typeof logger>

describe('version-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetInstalledVersionCache()
  })

  afterEach(() => {
    resetInstalledVersionCache()
  })

  // ------------------------------------------------------------------ getInstalledVersion
  describe('getInstalledVersion', () => {
    it('returns npm-listed version when available and valid', () => {
      const npmOutput = JSON.stringify({
        dependencies: {
          '@ai-support-agent/cli': { version: '2.3.4' },
        },
      })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(true)

      const version = getInstalledVersion()
      expect(version).toBe('2.3.4')
    })

    it('falls back to AGENT_VERSION when npm list fails', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('npm not found')
      })

      const version = getInstalledVersion()
      expect(version).toBe('1.0.0')
    })

    it('falls back to AGENT_VERSION when version is not valid', () => {
      const npmOutput = JSON.stringify({
        dependencies: {
          '@ai-support-agent/cli': { version: 'not-a-semver' },
        },
      })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(false)

      const version = getInstalledVersion()
      expect(version).toBe('1.0.0')
    })

    it('falls back to AGENT_VERSION when @ai-support-agent/cli is missing from dependencies', () => {
      const npmOutput = JSON.stringify({ dependencies: {} })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(false)

      const version = getInstalledVersion()
      expect(version).toBe('1.0.0')
    })

    it('falls back to AGENT_VERSION when dependencies field is missing', () => {
      const npmOutput = JSON.stringify({})
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)

      const version = getInstalledVersion()
      expect(version).toBe('1.0.0')
    })

    it('calls npm with correct arguments', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fail')
      })

      getInstalledVersion()

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'npm',
        ['list', '-g', '--json', '--depth=0'],
        { encoding: 'utf-8', timeout: 10_000 },
      )
    })

    it('caches the result and does not call npm on subsequent calls', () => {
      const npmOutput = JSON.stringify({
        dependencies: {
          '@ai-support-agent/cli': { version: '3.0.0' },
        },
      })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(true)

      const v1 = getInstalledVersion()
      const v2 = getInstalledVersion()

      expect(v1).toBe('3.0.0')
      expect(v2).toBe('3.0.0')
      // npm should only be called once
      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------------ resetInstalledVersionCache
  describe('resetInstalledVersionCache', () => {
    it('clears the cached version so the next call re-runs npm list', () => {
      // First call caches a version
      const firstOutput = JSON.stringify({
        dependencies: { '@ai-support-agent/cli': { version: '1.1.0' } },
      })
      mockExecFileSync.mockReturnValue(firstOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(true)
      expect(getInstalledVersion()).toBe('1.1.0')

      // Reset and provide different output
      resetInstalledVersionCache()
      const secondOutput = JSON.stringify({
        dependencies: { '@ai-support-agent/cli': { version: '1.2.0' } },
      })
      mockExecFileSync.mockReturnValue(secondOutput as unknown as Buffer)

      expect(getInstalledVersion()).toBe('1.2.0')
      // npm should have been called twice
      expect(mockExecFileSync).toHaveBeenCalledTimes(2)
    })
  })

  // ------------------------------------------------------------------ ensureImage
  describe('ensureImage', () => {
    it('builds image when it does not exist', () => {
      // npm installed version = '1.0.0' (fallback)
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      // isNewerVersion: installed (1.0.0) not newer than AGENT_VERSION (1.0.0)
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(false)

      const version = ensureImage()

      expect(mockBuildImage).toHaveBeenCalledWith('1.0.0', undefined)
      expect(version).toBe('1.0.0')
    })

    it('prunes old versioned images after a fresh build so disk usage does not grow unbounded across version bumps', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(false)

      const version = ensureImage()

      expect(mockBuildImage).toHaveBeenCalledWith('1.0.0', undefined)
      expect(mockPruneOldImages).toHaveBeenCalledWith(version)
      // Prune must run after the build completes, not before
      expect(mockBuildImage.mock.invocationCallOrder[0]).toBeLessThan(
        mockPruneOldImages.mock.invocationCallOrder[0],
      )
    })

    it('logs info when image already exists', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(true)

      ensureImage()

      expect(mockBuildImage).not.toHaveBeenCalled()
      expect(mockLogger.info).toHaveBeenCalledWith('docker.imageFound')
    })

    it('does not prune when the image already exists (nothing new was built)', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(true)

      ensureImage()

      expect(mockPruneOldImages).not.toHaveBeenCalled()
    })

    it('uses installed version when it is newer than compile-time version', () => {
      const npmOutput = JSON.stringify({
        dependencies: { '@ai-support-agent/cli': { version: '2.0.0' } },
      })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(true)
      // installed (2.0.0) is newer than AGENT_VERSION (1.0.0)
      mockIsNewerVersion.mockReturnValue(true)
      mockImageExists.mockReturnValue(false)

      const version = ensureImage()

      expect(version).toBe('2.0.0')
      expect(mockBuildImage).toHaveBeenCalledWith('2.0.0', undefined)
    })

    it('uses AGENT_VERSION when installed version is not newer', () => {
      const npmOutput = JSON.stringify({
        dependencies: { '@ai-support-agent/cli': { version: '0.9.0' } },
      })
      mockExecFileSync.mockReturnValue(npmOutput as unknown as Buffer)
      mockIsValidVersion.mockReturnValue(true)
      // installed (0.9.0) is NOT newer than AGENT_VERSION (1.0.0)
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(false)

      const version = ensureImage()

      expect(version).toBe('1.0.0')
    })

    it('passes customDockerfile to buildImage when provided', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(false)

      ensureImage('/custom/Dockerfile')

      expect(mockBuildImage).toHaveBeenCalledWith('1.0.0', '/custom/Dockerfile')
    })

    it('returns the selected version string', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('fail') })
      mockIsNewerVersion.mockReturnValue(false)
      mockImageExists.mockReturnValue(true)

      const version = ensureImage()
      expect(typeof version).toBe('string')
      expect(version).toBe('1.0.0')
    })
  })
})
