import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.mock('fs')
jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os')
  return {
    ...actual,
    homedir: jest.fn(() => '/home/testuser'),
  }
})
jest.mock('../src/logger')
jest.mock('../src/i18n', () => ({
  t: jest.fn((key: string, params?: Record<string, string>) => `${key}:${JSON.stringify(params)}`),
}))
jest.mock('../src/config-manager', () => ({
  getConfigDir: jest.fn(() => '/home/testuser/.ai-support-agent'),
}))

import {
  expandPath,
  resolveProjectDir,
  ensureProjectDirs,
  initProjectDir,
  getAutoAddDirs,
  getCacheDir,
  getAwsDir,
  getMetadataDir,
} from '../src/project-dir'
import { getConfigDir } from '../src/config-manager'
import { logger } from '../src/logger'

const mockedFs = fs as jest.Mocked<typeof fs>
const mockedHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>
const mockedGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>

describe('project-dir', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedHomedir.mockReturnValue('/home/testuser')
    mockedGetConfigDir.mockReturnValue('/home/testuser/.ai-support-agent')
  })

  describe('expandPath', () => {
    it('should replace ~ with home directory', () => {
      expect(expandPath('~/projects', 'PROJ_01')).toBe('/home/testuser/projects')
    })

    it('should replace {projectCode} with project code', () => {
      expect(expandPath('/data/{projectCode}/files', 'PROJ_01')).toBe('/data/PROJ_01/files')
    })

    it('should replace both ~ and {projectCode}', () => {
      expect(expandPath('~/projects/{projectCode}', 'MBC_01')).toBe(
        '/home/testuser/projects/MBC_01',
      )
    })

    it('should replace multiple {projectCode} occurrences', () => {
      expect(expandPath('/{projectCode}/data/{projectCode}', 'ABC')).toBe('/ABC/data/ABC')
    })

    it('should not modify path without ~ or {projectCode}', () => {
      expect(expandPath('/absolute/path/here', 'PROJ_01')).toBe('/absolute/path/here')
    })

    it('should not replace ~ in the middle of the path', () => {
      expect(expandPath('/data/~something', 'PROJ_01')).toBe('/data/~something')
    })

    it('should replace ~ only at the start followed by / or end', () => {
      expect(expandPath('~', 'PROJ_01')).toBe('/home/testuser')
      expect(expandPath('~/dir', 'PROJ_01')).toBe('/home/testuser/dir')
    })

    it('should not replace ~user style paths', () => {
      expect(expandPath('~other/dir', 'PROJ_01')).toBe('~other/dir')
    })
  })

  describe('resolveProjectDir', () => {
    it('should use project.projectDir when set', () => {
      const project = {
        projectCode: 'MBC_01',
        token: 'tok',
        apiUrl: 'http://api',
        projectDir: '/custom/{projectCode}',
      }
      expect(resolveProjectDir(project)).toBe('/custom/MBC_01')
    })

    it('should use project.projectDir with ~ expansion', () => {
      const project = {
        projectCode: 'MBC_01',
        token: 'tok',
        apiUrl: 'http://api',
        projectDir: '~/custom/{projectCode}',
      }
      expect(resolveProjectDir(project)).toBe('/home/testuser/custom/MBC_01')
    })

    it('should use defaultProjectDir template when project.projectDir is not set', () => {
      const project = { projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }
      expect(resolveProjectDir(project, '~/custom-base/{projectCode}')).toBe(
        '/home/testuser/custom-base/MBC_01',
      )
    })

    it('should use default template when neither projectDir nor defaultProjectDir is set', () => {
      const project = { projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }
      expect(resolveProjectDir(project)).toBe(
        path.join('/home/testuser/.ai-support-agent', 'projects', 'MBC_01'),
      )
    })

    it('should use custom CONFIG_DIR for default template', () => {
      mockedGetConfigDir.mockReturnValue('/custom/config/dir')
      const project = { projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }
      expect(resolveProjectDir(project)).toBe(
        path.join('/custom/config/dir', 'projects', 'MBC_01'),
      )
    })

    it('should use absolute CONFIG_DIR path for default template', () => {
      mockedGetConfigDir.mockReturnValue('/tmp/beta')
      const project = { projectCode: 'PROJ_A', token: 'tok', apiUrl: 'http://api' }
      expect(resolveProjectDir(project)).toBe(
        path.join('/tmp/beta', 'projects', 'PROJ_A'),
      )
    })

    it('should prioritize project.projectDir over defaultProjectDir', () => {
      const project = {
        projectCode: 'MBC_01',
        token: 'tok',
        apiUrl: 'http://api',
        projectDir: '/explicit/path',
      }
      expect(resolveProjectDir(project, '~/fallback/{projectCode}')).toBe('/explicit/path')
    })
  })

  describe('ensureProjectDirs', () => {
    it('should create project root when it does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureProjectDirs('/projects/MBC_01')

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/projects/MBC_01', {
        recursive: true,
        mode: 0o700,
      })
    })

    it('should not create project root when it already exists', () => {
      mockedFs.existsSync.mockImplementation((p) => {
        return p === '/projects/MBC_01'
      })
      ensureProjectDirs('/projects/MBC_01')

      // First call is for project root check — should NOT create it
      expect(mockedFs.mkdirSync).not.toHaveBeenCalledWith('/projects/MBC_01', expect.anything())
    })

    it('should create all subdirectories when they do not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureProjectDirs('/projects/MBC_01')

      const expectedSubdirs = ['repos', 'docs', 'artifacts', 'uploads']
      for (const subdir of expectedSubdirs) {
        expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
          path.join('/projects/MBC_01', subdir),
          { recursive: true },
        )
      }
    })

    it('should create metadata directory with mode 0o700', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureProjectDirs('/projects/MBC_01')

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent'),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should create cache directory with mode 0o700', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureProjectDirs('/projects/MBC_01')

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent', 'cache'),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should create aws directory with mode 0o700', () => {
      mockedFs.existsSync.mockReturnValue(false)
      ensureProjectDirs('/projects/MBC_01')

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent', 'aws'),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should skip creating directories that already exist', () => {
      mockedFs.existsSync.mockReturnValue(true)
      ensureProjectDirs('/projects/MBC_01')

      expect(mockedFs.mkdirSync).not.toHaveBeenCalled()
    })

    it('should create only missing directories', () => {
      const existingPaths = new Set([
        '/projects/MBC_01',
        path.join('/projects/MBC_01', 'repos'),
        path.join('/projects/MBC_01', 'docs'),
        path.join('/projects/MBC_01', '.ai-support-agent'),
      ])
      mockedFs.existsSync.mockImplementation((p) => existingPaths.has(p as string))

      ensureProjectDirs('/projects/MBC_01')

      // Should NOT create dirs that exist
      expect(mockedFs.mkdirSync).not.toHaveBeenCalledWith(
        '/projects/MBC_01',
        expect.anything(),
      )
      expect(mockedFs.mkdirSync).not.toHaveBeenCalledWith(
        path.join('/projects/MBC_01', 'repos'),
        expect.anything(),
      )
      expect(mockedFs.mkdirSync).not.toHaveBeenCalledWith(
        path.join('/projects/MBC_01', 'docs'),
        expect.anything(),
      )
      expect(mockedFs.mkdirSync).not.toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent'),
        expect.anything(),
      )

      // Should create dirs that don't exist
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', 'artifacts'),
        { recursive: true },
      )
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', 'uploads'),
        { recursive: true },
      )
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent', 'cache'),
        { recursive: true, mode: 0o700 },
      )
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/projects/MBC_01', '.ai-support-agent', 'aws'),
        { recursive: true, mode: 0o700 },
      )
    })
  })

  describe('initProjectDir', () => {
    it('should resolve project dir and create directories', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const project = { projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }
      const result = initProjectDir(project)

      expect(result).toBe(path.join('/home/testuser/.ai-support-agent', 'projects', 'MBC_01'))
      // Verify directories were created (mkdirSync was called)
      expect(mockedFs.mkdirSync).toHaveBeenCalled()
    })

    it('should use defaultProjectDir when provided', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const project = { projectCode: 'PROJ_A', token: 'tok', apiUrl: 'http://api' }
      const result = initProjectDir(project, '~/custom/{projectCode}')

      expect(result).toBe('/home/testuser/custom/PROJ_A')
    })

    it('should use project.projectDir when set', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const project = {
        projectCode: 'PROJ_A',
        token: 'tok',
        apiUrl: 'http://api',
        projectDir: '/explicit/path',
      }
      const result = initProjectDir(project, '~/fallback/{projectCode}')

      expect(result).toBe('/explicit/path')
    })

    it('should log initialization info', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const project = { projectCode: 'MBC_01', token: 'tok', apiUrl: 'http://api' }
      initProjectDir(project)

      expect(logger.info).toHaveBeenCalledTimes(1)
    })

    it('should return the resolved path', () => {
      mockedFs.existsSync.mockReturnValue(true)
      const project = {
        projectCode: 'TEST',
        token: 'tok',
        apiUrl: 'http://api',
        projectDir: '/my/dir',
      }
      const result = initProjectDir(project)
      expect(result).toBe('/my/dir')
    })
  })

  describe('getAutoAddDirs', () => {
    it('should return repos and docs when both exist', () => {
      mockedFs.existsSync.mockReturnValue(true)
      const dirs = getAutoAddDirs('/projects/MBC_01')

      expect(dirs).toEqual([
        path.join('/projects/MBC_01', 'repos'),
        path.join('/projects/MBC_01', 'docs'),
      ])
    })

    it('should return only repos when docs does not exist', () => {
      mockedFs.existsSync.mockImplementation((p) => {
        return p === path.join('/projects/MBC_01', 'repos')
      })
      const dirs = getAutoAddDirs('/projects/MBC_01')

      expect(dirs).toEqual([path.join('/projects/MBC_01', 'repos')])
    })

    it('should return only docs when repos does not exist', () => {
      mockedFs.existsSync.mockImplementation((p) => {
        return p === path.join('/projects/MBC_01', 'docs')
      })
      const dirs = getAutoAddDirs('/projects/MBC_01')

      expect(dirs).toEqual([path.join('/projects/MBC_01', 'docs')])
    })

    it('should return empty array when neither exists', () => {
      mockedFs.existsSync.mockReturnValue(false)
      const dirs = getAutoAddDirs('/projects/MBC_01')

      expect(dirs).toEqual([])
    })
  })

  describe('getCacheDir', () => {
    it('should return correct cache directory path', () => {
      expect(getCacheDir('/projects/MBC_01')).toBe(
        path.join('/projects/MBC_01', '.ai-support-agent', 'cache'),
      )
    })
  })

  describe('getAwsDir', () => {
    it('should return correct aws directory path', () => {
      expect(getAwsDir('/projects/MBC_01')).toBe(
        path.join('/projects/MBC_01', '.ai-support-agent', 'aws'),
      )
    })
  })

  describe('getMetadataDir', () => {
    it('should return correct metadata directory path', () => {
      expect(getMetadataDir('/projects/MBC_01')).toBe(
        path.join('/projects/MBC_01', '.ai-support-agent'),
      )
    })
  })
})
