/**
 * Dedicated tests for src/docker/dockerfile-sync.ts
 *
 * syncDockerfileToConfigDir copies the bundled Dockerfile (and entrypoint.sh)
 * to the user's config directory on first run. It is a no-op when the
 * destination already exists and swallows exceptions with a warning log.
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

import * as fs from 'fs'
import { syncDockerfileToConfigDir } from '../../src/docker/dockerfile-sync'
import { logger } from '../../src/logger'

const mockedFs = jest.mocked(fs)

describe('dockerfile-sync', () => {
  describe('syncDockerfileToConfigDir', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    describe('destination Dockerfile already exists', () => {
      it('should return early without copying when dest Dockerfile exists', () => {
        mockedFs.existsSync.mockReturnValue(true)

        syncDockerfileToConfigDir()

        expect(mockedFs.mkdirSync).not.toHaveBeenCalled()
        expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
      })

      it('should not log info when dest Dockerfile already exists', () => {
        mockedFs.existsSync.mockReturnValue(true)

        syncDockerfileToConfigDir()

        expect(logger.info).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('destination Dockerfile does not exist - entrypoint.sh absent', () => {
      it('should create config dir and copy Dockerfile', () => {
        mockedFs.existsSync.mockReturnValue(false) // dest Dockerfile absent, entrypoint absent
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
          '/mock/config-dir',
          { recursive: true, mode: 0o700 },
        )
        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(
          '/mock/docker/Dockerfile',
          '/mock/config-dir/Dockerfile',
        )
      })

      it('should copy Dockerfile exactly once when entrypoint.sh does not exist', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(1)
      })

      it('should log info with the destination Dockerfile path', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSynced'),
        )
      })
    })

    describe('destination Dockerfile does not exist - entrypoint.sh present', () => {
      it('should copy both Dockerfile and entrypoint.sh', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const filePath = p as string
          // dest Dockerfile is absent; bundled entrypoint.sh exists
          if (filePath === '/mock/config-dir/Dockerfile') return false
          if (filePath.endsWith('entrypoint.sh')) return true
          return false
        })
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(2)
      })

      it('should create the docker subdirectory for entrypoint.sh', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const filePath = p as string
          if (filePath === '/mock/config-dir/Dockerfile') return false
          if (filePath.endsWith('entrypoint.sh')) return true
          return false
        })
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        // mkdirSync should be called for the config dir AND for the docker subdir
        expect(mockedFs.mkdirSync).toHaveBeenCalledTimes(2)
        expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
          '/mock/config-dir/docker',
          { recursive: true },
        )
      })

      it('should copy entrypoint.sh to <configDir>/docker/entrypoint.sh', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const filePath = p as string
          if (filePath === '/mock/config-dir/Dockerfile') return false
          if (filePath.endsWith('entrypoint.sh')) return true
          return false
        })
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenNthCalledWith(
          2,
          '/mock/docker/entrypoint.sh',
          '/mock/config-dir/docker/entrypoint.sh',
        )
      })

      it('should still log info after copying Dockerfile and entrypoint.sh', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const filePath = p as string
          if (filePath === '/mock/config-dir/Dockerfile') return false
          if (filePath.endsWith('entrypoint.sh')) return true
          return false
        })
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockReturnValue(undefined)

        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSynced'),
        )
      })
    })

    describe('error handling', () => {
      it('should log a warning and not throw when copyFileSync throws an Error', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockImplementation(() => {
          throw new Error('permission denied')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
        expect(logger.info).not.toHaveBeenCalled()
      })

      it('should log a warning and not throw when copyFileSync throws a non-Error value', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockImplementation(() => {
          throw 'disk is full'
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should log a warning and not throw when mkdirSync throws', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockImplementation(() => {
          throw new Error('EACCES: permission denied')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should use the dockerfileSyncFailed i18n key for the warning', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.mkdirSync.mockReturnValue(undefined)
        mockedFs.copyFileSync.mockImplementation(() => {
          throw new Error('no space left on device')
        })

        syncDockerfileToConfigDir()

        // The i18n key 'docker.dockerfileSyncFailed' is used for the warning message
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })
    })
  })
})
