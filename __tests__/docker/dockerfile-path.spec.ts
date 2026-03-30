import { join } from 'path'

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}))

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn().mockReturnValue('/mock/config'),
}))

import { existsSync } from 'fs'
import { getDockerfilePath, getDockerContextDir, getConfigDockerfilePath, resolveDockerfile } from '../../src/docker/dockerfile-path'

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>

describe('dockerfile-path', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getDockerContextDir', () => {
    it('should return the package root directory (two levels up from __dirname)', () => {
      const result = getDockerContextDir()
      // __dirname for compiled code is dist/docker/, so two levels up is the package root
      // In test context, __dirname is src/docker/, but the logic is the same
      expect(result).toBe(join(__dirname, '..', '..', 'src', 'docker', '..', '..'))
    })
  })

  describe('getDockerfilePath', () => {
    it('should return the Dockerfile path when file exists', () => {
      mockExistsSync.mockReturnValue(true)
      const result = getDockerfilePath()
      const contextDir = getDockerContextDir()
      expect(result).toBe(join(contextDir, 'docker', 'Dockerfile'))
      expect(mockExistsSync).toHaveBeenCalledWith(result)
    })

    it('should throw an error when Dockerfile does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      expect(() => getDockerfilePath()).toThrow('Dockerfile not found:')
    })
  })

  describe('getConfigDockerfilePath', () => {
    it('should return Dockerfile path inside config directory', () => {
      const result = getConfigDockerfilePath()
      expect(result).toBe('/mock/config/Dockerfile')
    })
  })

  describe('resolveDockerfile', () => {
    it('should return custom path and its parent dir when customPath is provided and exists', () => {
      mockExistsSync.mockReturnValue(true)
      const result = resolveDockerfile('/custom/path/Dockerfile')
      expect(result.dockerfilePath).toBe('/custom/path/Dockerfile')
      expect(result.contextDir).toBe('/custom/path')
    })

    it('should throw when customPath is provided but does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      expect(() => resolveDockerfile('/missing/Dockerfile')).toThrow('Dockerfile not found: /missing/Dockerfile')
    })

    it('should return configDir Dockerfile when no customPath and configDir file exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/mock/config/Dockerfile')
      const result = resolveDockerfile()
      expect(result.dockerfilePath).toBe('/mock/config/Dockerfile')
      expect(result.contextDir).toBe('/mock/config')
    })

    it('should fall back to bundled default when no customPath and configDir file does not exist', () => {
      // configDir Dockerfile does not exist, but bundled Dockerfile does
      mockExistsSync.mockImplementation((p) => {
        if (p === '/mock/config/Dockerfile') return false
        return true // bundled Dockerfile exists
      })
      const result = resolveDockerfile()
      const contextDir = getDockerContextDir()
      expect(result.dockerfilePath).toBe(join(contextDir, 'docker', 'Dockerfile'))
      expect(result.contextDir).toBe(contextDir)
    })

    it('should use undefined customPath and return configDir path when it exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/mock/config/Dockerfile')
      const result = resolveDockerfile(undefined)
      expect(result.dockerfilePath).toBe('/mock/config/Dockerfile')
    })
  })
})
