import * as fs from 'fs'
import * as path from 'path'

import type { ApiClient } from '../src/api-client'
import type { CachedProjectConfig, ProjectConfigResponse } from '../src/types'

jest.mock('fs')
jest.mock('../src/logger')
jest.mock('../src/project-dir', () => ({
  getCacheDir: (projectDir: string) => path.join(projectDir, '.ai-support-agent', 'cache'),
}))

const mockedFs = fs as jest.Mocked<typeof fs>

import { syncProjectConfig, saveCachedConfig, loadCachedConfig } from '../src/project-config-sync'

function createMockConfig(overrides?: Partial<ProjectConfigResponse>): ProjectConfigResponse {
  return {
    configHash: 'hash-abc123',
    project: {
      projectCode: 'TEST_01',
      projectName: 'Test Project',
      description: 'A test project',
    },
    agent: {
      agentEnabled: true,
      builtinAgentEnabled: false,
      builtinFallbackEnabled: false,
      externalAgentEnabled: true,
      allowedTools: ['execute_command'],
    },
    documentation: {
      sources: [{ type: 'url', url: 'https://docs.example.com' }],
    },
    ...overrides,
  }
}

function createMockClient(config?: ProjectConfigResponse): ApiClient {
  return {
    getProjectConfig: jest.fn().mockResolvedValue(config ?? createMockConfig()),
  } as unknown as ApiClient
}

describe('project-config-sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('syncProjectConfig', () => {
    it('should return config when hash changes', async () => {
      const config = createMockConfig({ configHash: 'new-hash' })
      const client = createMockClient(config)

      const result = await syncProjectConfig(client, 'old-hash', undefined, '[test]')

      expect(result).toEqual(config)
      expect(client.getProjectConfig).toHaveBeenCalledTimes(1)
    })

    it('should return config when currentHash is undefined (first sync)', async () => {
      const config = createMockConfig()
      const client = createMockClient(config)

      const result = await syncProjectConfig(client, undefined, undefined, '[test]')

      expect(result).toEqual(config)
    })

    it('should return null when hash is same', async () => {
      const config = createMockConfig({ configHash: 'same-hash' })
      const client = createMockClient(config)

      const result = await syncProjectConfig(client, 'same-hash', undefined, '[test]')

      expect(result).toBeNull()
    })

    it('should save cache when projectDir is set and hash changes', async () => {
      const config = createMockConfig({ configHash: 'new-hash' })
      const client = createMockClient(config)

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const result = await syncProjectConfig(client, 'old-hash', '/projects/test', '[test]')

      expect(result).toEqual(config)
      // saveCachedConfig should have been called (verify via fs calls)
      expect(mockedFs.writeFileSync).toHaveBeenCalled()
      expect(mockedFs.renameSync).toHaveBeenCalled()
    })

    it('should not save cache when projectDir is undefined', async () => {
      const config = createMockConfig({ configHash: 'new-hash' })
      const client = createMockClient(config)

      const result = await syncProjectConfig(client, 'old-hash', undefined, '[test]')

      expect(result).toEqual(config)
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('should load from cache on failure when projectDir is set and hash differs', async () => {
      const client = {
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      const cachedData: CachedProjectConfig = {
        cachedAt: '2026-01-01T00:00:00Z',
        configHash: 'cached-hash',
        config: {
          configHash: 'cached-hash',
          project: { projectCode: 'TEST_01', projectName: 'Test Project' },
          agent: {
            agentEnabled: true,
            builtinAgentEnabled: false,
            builtinFallbackEnabled: false,
            externalAgentEnabled: true,
            allowedTools: [],
          },
        },
      }

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(cachedData))

      const result = await syncProjectConfig(client, 'old-hash', '/projects/test', '[test]')

      expect(result).not.toBeNull()
      expect(result?.configHash).toBe('cached-hash')
      expect(result?.project.projectCode).toBe('TEST_01')
    })

    it('should return null on failure when no cache exists', async () => {
      const client = {
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      mockedFs.existsSync.mockReturnValue(false)

      const result = await syncProjectConfig(client, 'old-hash', '/projects/test', '[test]')

      expect(result).toBeNull()
    })

    it('should return null on failure when projectDir is undefined', async () => {
      const client = {
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      const result = await syncProjectConfig(client, 'old-hash', undefined, '[test]')

      expect(result).toBeNull()
    })

    it('should return null on failure when cache exists but hash is same', async () => {
      const client = {
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      const cachedData: CachedProjectConfig = {
        cachedAt: '2026-01-01T00:00:00Z',
        configHash: 'same-hash',
        config: {
          configHash: 'same-hash',
          project: { projectCode: 'TEST_01', projectName: 'Test Project' },
          agent: {
            agentEnabled: true,
            builtinAgentEnabled: false,
            builtinFallbackEnabled: false,
            externalAgentEnabled: true,
            allowedTools: [],
          },
        },
      }

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(cachedData))

      const result = await syncProjectConfig(client, 'same-hash', '/projects/test', '[test]')

      expect(result).toBeNull()
    })
  })

  describe('saveCachedConfig', () => {
    it('should create cache directory if missing', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.mkdirSync.mockImplementation(() => '' as unknown as string)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const config = createMockConfig()
      saveCachedConfig('/projects/test', config)

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('.ai-support-agent', 'cache')),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should always call mkdir (recursive) even if cache directory already exists', () => {
      mockedFs.mkdirSync.mockImplementation(() => '' as unknown as string)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const config = createMockConfig()
      saveCachedConfig('/projects/test', config)

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('.ai-support-agent', 'cache')),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should write config with atomic write (tmp + rename)', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const config = createMockConfig()
      saveCachedConfig('/projects/test', config)

      const cacheDir = path.join('/projects/test', '.ai-support-agent', 'cache')
      const cachePath = path.join(cacheDir, 'project-config.json')
      const tmpPath = cachePath + '.tmp'

      // Should write to tmp file first
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        tmpPath,
        expect.any(String),
        { mode: 0o600 },
      )

      // Should rename tmp to final
      expect(mockedFs.renameSync).toHaveBeenCalledWith(tmpPath, cachePath)
    })

    it('should exclude AWS from cached data', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const config = createMockConfig({
        aws: {
          accounts: [{
            id: 'acc-1',
            name: 'Dev Account',
            region: 'ap-northeast-1',
            accountId: '123456789012',
            auth: { method: 'access_key' },
            isDefault: true,
          }],
        },
      })

      saveCachedConfig('/projects/test', config)

      const writtenData = JSON.parse(
        (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1] as string,
      ) as CachedProjectConfig

      expect(writtenData.config).not.toHaveProperty('aws')
      expect(writtenData.configHash).toBe(config.configHash)
      expect(writtenData.config.project).toEqual(config.project)
      expect(writtenData.config.agent).toEqual(config.agent)
      expect(writtenData.cachedAt).toBeDefined()
    })

    it('should include documentation in cached data', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.renameSync.mockImplementation(() => {})

      const config = createMockConfig({
        documentation: {
          sources: [{ type: 'url', url: 'https://docs.example.com' }],
        },
      })

      saveCachedConfig('/projects/test', config)

      const writtenData = JSON.parse(
        (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1] as string,
      ) as CachedProjectConfig

      expect(writtenData.config.documentation).toEqual(config.documentation)
    })

    it('should handle write errors gracefully', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      const config = createMockConfig()

      // Should not throw
      expect(() => saveCachedConfig('/projects/test', config)).not.toThrow()
    })

    it('should handle mkdirSync errors gracefully', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.mkdirSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      const config = createMockConfig()

      // Should not throw
      expect(() => saveCachedConfig('/projects/test', config)).not.toThrow()
    })
  })

  describe('loadCachedConfig', () => {
    it('should return cached data when file exists', () => {
      const cachedData: CachedProjectConfig = {
        cachedAt: '2026-01-01T00:00:00Z',
        configHash: 'cached-hash',
        config: {
          configHash: 'cached-hash',
          project: { projectCode: 'TEST_01', projectName: 'Test Project' },
          agent: {
            agentEnabled: true,
            builtinAgentEnabled: false,
            builtinFallbackEnabled: false,
            externalAgentEnabled: true,
            allowedTools: ['execute_command'],
          },
          documentation: {
            sources: [{ type: 'url', url: 'https://docs.example.com' }],
          },
        },
      }

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(cachedData))

      const result = loadCachedConfig('/projects/test')

      expect(result).toEqual(cachedData)
      expect(mockedFs.existsSync).toHaveBeenCalledWith(
        path.join('/projects/test', '.ai-support-agent', 'cache', 'project-config.json'),
      )
      expect(mockedFs.readFileSync).toHaveBeenCalledWith(
        path.join('/projects/test', '.ai-support-agent', 'cache', 'project-config.json'),
        'utf-8',
      )
    })

    it('should return null when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      const result = loadCachedConfig('/projects/test')

      expect(result).toBeNull()
      expect(mockedFs.readFileSync).not.toHaveBeenCalled()
    })

    it('should return null on parse error', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue('{ invalid json !!!')

      const result = loadCachedConfig('/projects/test')

      expect(result).toBeNull()
    })

    it('should return null when readFileSync throws', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      const result = loadCachedConfig('/projects/test')

      expect(result).toBeNull()
    })
  })
})
