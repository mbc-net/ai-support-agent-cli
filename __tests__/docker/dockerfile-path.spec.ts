import { join } from 'path'

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}))

import { existsSync } from 'fs'
import { getDockerfilePath, getDockerContextDir } from '../../src/docker/dockerfile-path'

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
})
