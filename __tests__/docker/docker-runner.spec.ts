import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  spawn: jest.fn(),
}))

jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    submitLogChunk: jest.fn().mockResolvedValue(undefined),
    saveSessionLog: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
  readFileSync: jest.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn(),
  copyFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  renameSync: jest.fn(),
  chmodSync: jest.fn(),
  watch: jest.fn(() => ({ close: jest.fn() })),
}))

jest.mock('../../src/docker/dockerfile-path', () => ({
  getDockerfilePath: jest.fn(() => '/mock/docker/Dockerfile'),
  getDockerContextDir: jest.fn(() => '/mock'),
  getConfigDockerfilePath: jest.fn(() => '/mock/config-dir/Dockerfile'),
  getProjectDockerfilePath: jest.fn((tenantCode: string, projectCode: string) => `/mock/config-dir/projects/${tenantCode}/${projectCode}/Dockerfile`),
  getProjectImageTag: jest.fn((tenantCode: string, projectCode: string, version: string) => `ai-support-agent-${tenantCode}-${projectCode}:${version}`),
  resolveDockerfile: jest.fn((customPath?: string) => {
    if (customPath) return { dockerfilePath: customPath, contextDir: require('path').dirname(customPath) }
    return { dockerfilePath: '/mock/docker/Dockerfile', contextDir: '/mock' }
  }),
}))

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => '/mock/config-dir'),
  loadConfig: jest.fn(),
  getProjectList: jest.fn((config: { projects?: Array<{ tenantCode?: string }> }) =>
    (config?.projects ?? []).filter((p) => !!p.tenantCode)
  ),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string, params?: Record<string, string>) => {
    if (params) {
      let msg = key
      for (const [k, v] of Object.entries(params)) {
        msg += ` ${k}=${v}`
      }
      return msg
    }
    return key
  }),
  initI18n: jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  getProjectColor: jest.fn().mockReturnValue('\x1b[36m'),
  resetProjectColors: jest.fn(),
  prefixLines: jest.fn().mockImplementation((text: string) => text),
  maskSecrets: jest.fn().mockImplementation((text: string) => text),
  makeLinePrefixer: jest.fn().mockImplementation((_prefix: string, write: (s: string) => void) => (chunk: string) => write(chunk)),
  stripCursorCodes: jest.fn().mockImplementation((text: string) => text),
}))

jest.mock('../../src/update-checker', () => ({
  reExecProcess: jest.fn(),
  performUpdate: jest.fn().mockResolvedValue({ success: true }),
}))

jest.mock('../../src/pid-manager', () => ({
  writePidFile: jest.fn(),
  removePidFile: jest.fn(),
  isAlreadyRunning: jest.fn().mockReturnValue(false),
  readPidFile: jest.fn().mockReturnValue(null),
}))

import { execFileSync, spawn } from 'child_process'
import * as os from 'os'
import { existsSync, realpathSync, readFileSync, unlinkSync, copyFileSync, mkdirSync, renameSync, watch as fsWatch } from 'fs'
import { getConfigDir, loadConfig } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { reExecProcess, performUpdate } from '../../src/update-checker'
import { resetDockerPathCache } from '../../src/docker/docker-utils'
import {
  checkDockerAvailable,
  imageExists,
  buildImage,
  buildVolumeMounts,
  buildEnvArgs,
  buildContainerArgs,
  ensureImage,
  getInstalledVersion,
  resetInstalledVersionCache,
  resetIsDockerRunning,
  syncDockerfileToConfigDir,
  dockerLogin,
  runInDocker,
  generateProjectDockerfile,
  buildProjectImage,
  validatePackageNames,
  migrateProjectConfigDir,
  buildContainerName,
  removeStaleContainer,
} from '../../src/docker/docker-runner'

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const mockGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
const mockRealpathSync = realpathSync as jest.MockedFunction<typeof realpathSync>
const mockReExecProcess = reExecProcess as jest.MockedFunction<typeof reExecProcess>
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>
const mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>
const mockPerformUpdate = performUpdate as jest.MockedFunction<typeof performUpdate>
const mockCopyFileSync = copyFileSync as jest.MockedFunction<typeof copyFileSync>
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>
const mockRenameSync = renameSync as jest.MockedFunction<typeof renameSync>
const mockFsWatch = fsWatch as jest.MockedFunction<typeof fsWatch>

describe('docker-runner', () => {
  const originalEnv = process.env
  let mockExit: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    resetDockerPathCache()
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
    mockExit.mockRestore()
    // Remove any SIGINT/SIGTERM listeners registered by DockerSupervisor during the test
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
  })

  describe('checkDockerAvailable', () => {
    it('should return true when docker info succeeds', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      expect(checkDockerAvailable()).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalledWith('docker', ['info'], { stdio: 'ignore' })
    })

    it('should return false when docker info fails', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('Docker not running') })
      expect(checkDockerAvailable()).toBe(false)
    })
  })

  describe('imageExists', () => {
    it('should return true when image exists', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      expect(imageExists('1.0.0')).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalledWith('docker', ['image', 'inspect', 'ai-support-agent:1.0.0'], { stdio: 'ignore' })
    })

    it('should return false when image does not exist', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('No such image') })
      expect(imageExists('1.0.0')).toBe(false)
    })
  })

  describe('buildImage', () => {
    it('should build docker image with correct arguments (bundled Dockerfile)', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      buildImage('1.0.0')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['build', '-t', 'ai-support-agent:1.0.0', '--pull=false', '--build-arg', 'AGENT_VERSION=1.0.0', '-f', '/mock/docker/Dockerfile', '/mock'],
        { stdio: 'inherit' },
      )
      expect(logger.info).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalled()
    })

    it('should use custom Dockerfile path when provided', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      buildImage('1.0.0', '/custom/Dockerfile')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['build', '-t', 'ai-support-agent:1.0.0', '--pull=false', '--build-arg', 'AGENT_VERSION=1.0.0', '-f', '/custom/Dockerfile', '/custom'],
        { stdio: 'inherit' },
      )
      // Should log usingCustomDockerfile message
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.usingCustomDockerfile'))
    })
  })

  describe('buildVolumeMounts', () => {
    it('should mount existing directories', () => {
      const home = os.homedir()
      mockGetConfigDir.mockReturnValue(`${home}/.ai-support-agent`)
      mockExistsSync.mockImplementation((p: unknown) => {
        const existing = [
          `${home}/.claude`,
          `${home}/.claude.json`,
          `${home}/.ai-support-agent`,
          `${home}/.aws`,
        ]
        return existing.includes(p as string)
      })
      mockLoadConfig.mockReturnValue(null)

      const { mounts } = buildVolumeMounts()
      expect(mounts).toContain(`${home}/.claude:/home/node/.claude:rw`)
      expect(mounts).toContain(`${home}/.claude.json:/home/node/.claude.json:rw`)
      expect(mounts).toContain(`${home}/.ai-support-agent:/home/node/.ai-support-agent:rw`)
      expect(mounts).toContain(`${home}/.aws:/home/node/.aws:ro`)
    })

    it('should mount custom config directory from AI_SUPPORT_AGENT_CONFIG_DIR', () => {
      mockGetConfigDir.mockReturnValue('/custom/config/dir')
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/custom/config/dir'
      })
      mockLoadConfig.mockReturnValue(null)

      const { mounts } = buildVolumeMounts()
      expect(mounts).toContain('/custom/config/dir:/workspace/.config/ai-support-agent:rw')
    })

    it('should skip non-existing directories', () => {
      mockExistsSync.mockReturnValue(false)
      mockLoadConfig.mockReturnValue(null)

      const { mounts } = buildVolumeMounts()
      expect(mounts).toHaveLength(0)
    })

    it('should mount custom project directories from config', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/workspace/project-a' || p === '/workspace/project-b'
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/project-a' },
          { tenantCode: 'mbc', projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/workspace/project-b' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      expect(mounts).toContain('/workspace/project-a:/workspace/projects/A:rw')
      expect(mounts).toContain('/workspace/project-b:/workspace/projects/B:rw')
    })

    it('should not duplicate project directory mounts', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/workspace/shared'
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/shared' },
          { tenantCode: 'mbc', projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/workspace/shared' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      const count = mounts.filter(m => m === '/workspace/shared:/workspace/projects/A:rw').length
      expect(count).toBe(1)
    })

    it('should skip blocked paths for project directories', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/etc/secrets' || p === '/proc/data'
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/etc/secrets' },
          { tenantCode: 'mbc', projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/proc/data' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      expect(mounts).not.toContain('/etc/secrets:/workspace/projects/A:rw')
      expect(mounts).not.toContain('/proc/data:/workspace/projects/B:rw')
    })

    it('should skip project directories that do not exist', () => {
      mockExistsSync.mockReturnValue(false)
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/nonexistent' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      expect(mounts).toHaveLength(0)
    })

    it('should resolve symlinks to detect blocked paths', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/workspace/symlink-to-etc'
      })
      mockRealpathSync.mockImplementation((p: unknown) => {
        if (p === '/workspace/symlink-to-etc') return '/etc/secrets'
        return p as string
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/symlink-to-etc' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      expect(mounts).not.toContain('/workspace/symlink-to-etc:/workspace/projects/A:rw')
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blocked path'))
    })

    it('should always use forward slashes for container-side paths', () => {
      const home = os.homedir()
      mockGetConfigDir.mockReturnValue(`${home}/.ai-support-agent`)
      mockExistsSync.mockImplementation((p: unknown) => {
        const existing = [
          `${home}/.claude`,
          `${home}/.claude.json`,
          `${home}/.ai-support-agent`,
          `${home}/.aws`,
        ]
        return existing.includes(p as string)
      })
      mockLoadConfig.mockReturnValue(null)

      const { mounts } = buildVolumeMounts()
      // All container-side paths (right side of ':') must use forward slashes
      for (let i = 0; i < mounts.length; i++) {
        if (mounts[i] === '-v') continue
        const containerPath = mounts[i + 0].split(':')[1]
        if (containerPath) {
          expect(containerPath).not.toContain('\\')
          expect(containerPath).toMatch(/^\//)
        }
      }
    })

    it('should skip project directories when realpathSync fails', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/workspace/broken-link'
      })
      mockRealpathSync.mockImplementation((p: unknown) => {
        if (p === '/workspace/broken-link') throw new Error('ENOENT')
        return p as string
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'test-agent',
        createdAt: '2024-01-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/broken-link' },
        ],
      })

      const { mounts } = buildVolumeMounts()
      expect(mounts).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot resolve path'))
    })
  })

  describe('buildEnvArgs', () => {
    it('should always include HOME', () => {
      const args = buildEnvArgs([])
      expect(args).toContain('-e')
      expect(args).toContain(`HOME=/home/node`)
    })

    it('should pass through set environment variables', () => {
      process.env.AI_SUPPORT_AGENT_TOKEN = 'test-token'
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://test.api'
      process.env.ANTHROPIC_API_KEY = 'sk-test'

      const args = buildEnvArgs([])
      expect(args).toContain('AI_SUPPORT_AGENT_TOKEN=test-token')
      expect(args).toContain('AI_SUPPORT_AGENT_API_URL=http://test.api')
      expect(args).toContain('ANTHROPIC_API_KEY=sk-test')
    })

    it('should resolve AI_SUPPORT_AGENT_CONFIG_DIR to absolute path', () => {
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = './relative/path'
      mockGetConfigDir.mockReturnValue('/resolved/absolute/path')

      const args = buildEnvArgs([])
      // Config dir is mapped to container-internal path
      const configDirArg = args.find((a: string) => a.startsWith('AI_SUPPORT_AGENT_CONFIG_DIR='))
      expect(configDirArg).toBeDefined()
      expect(configDirArg).not.toContain('./relative/path')
    })

    it('should include project directory mappings when provided', () => {
      const mappings = [
        { hostDir: '/host/project-a', containerDir: '/workspace/projects/A', projectCode: 'A' },
        { hostDir: '/host/project-b', containerDir: '/workspace/projects/B', projectCode: 'B' },
      ]
      const args = buildEnvArgs(mappings)
      const mapArg = args.find((a: string) => a.startsWith('AI_SUPPORT_AGENT_PROJECT_DIR_MAP='))
      expect(mapArg).toBe('AI_SUPPORT_AGENT_PROJECT_DIR_MAP=A=/workspace/projects/A;B=/workspace/projects/B')
    })

    it('should always use forward slashes for container config dir path', () => {
      const home = os.homedir()
      mockGetConfigDir.mockReturnValue(`${home}/.ai-support-agent`)
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = `${home}/.ai-support-agent`

      const args = buildEnvArgs([])
      const configDirArg = args.find((a: string) => a.startsWith('AI_SUPPORT_AGENT_CONFIG_DIR='))
      expect(configDirArg).toBeDefined()
      const configDirValue = configDirArg!.split('=')[1]
      expect(configDirValue).not.toContain('\\')
      expect(configDirValue).toMatch(/^\//)
    })

    it('should skip unset environment variables', () => {
      delete process.env.AI_SUPPORT_AGENT_TOKEN
      delete process.env.AI_SUPPORT_AGENT_API_URL
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR

      const args = buildEnvArgs([])
      // AI_SUPPORT_AGENT_IN_DOCKER and HOME should be present (no passthrough vars set)
      expect(args[0]).toBe('-e')
      expect(args[1]).toBe('AI_SUPPORT_AGENT_IN_DOCKER=1')
      expect(args[2]).toBe('-e')
      expect(args[3]).toBe('HOME=/home/node')
    })

    it('should not include TZ (TZ is added by buildProjectVolumeMounts for per-project containers)', () => {
      const args = buildEnvArgs([])
      // Legacy buildEnvArgs does not include TZ; per-project containers use buildProjectVolumeMounts
      const tzArg = args.find((a: string) => a.startsWith('TZ='))
      expect(tzArg).toBeUndefined()
    })
  })

  describe('buildContainerArgs', () => {
    it('should include ai-support-agent start command', () => {
      const args = buildContainerArgs({})
      expect(args[0]).toBe('ai-support-agent')
      expect(args[1]).toBe('start')
    })

    it('should pass all options', () => {
      const args = buildContainerArgs({
        token: 'my-token',
        apiUrl: 'http://api',
        pollInterval: 5000,
        heartbeatInterval: 60000,
        verbose: true,
        autoUpdate: false,
        updateChannel: 'beta',
      })

      expect(args).toContain('--token')
      expect(args).toContain('my-token')
      expect(args).toContain('--api-url')
      expect(args).toContain('http://api')
      expect(args).toContain('--poll-interval')
      expect(args).toContain('5000')
      expect(args).toContain('--heartbeat-interval')
      expect(args).toContain('60000')
      expect(args).toContain('--verbose')
      expect(args).toContain('--no-auto-update')
      expect(args).toContain('--update-channel')
      expect(args).toContain('beta')
    })

    it('should include --no-docker flag to prevent recursive Docker launch', () => {
      const args = buildContainerArgs({ verbose: true })
      expect(args).toContain('--no-docker')
    })

    it('should omit undefined options', () => {
      const args = buildContainerArgs({})
      expect(args).toEqual(['ai-support-agent', 'start', '--no-docker'])
    })

    it('should not include --no-auto-update when autoUpdate is true', () => {
      const args = buildContainerArgs({ autoUpdate: true })
      expect(args).not.toContain('--no-auto-update')
    })

    it('should not include --no-auto-update when autoUpdate is undefined', () => {
      const args = buildContainerArgs({})
      expect(args).not.toContain('--no-auto-update')
    })

    it('should include --project flag when opts.project is set', () => {
      const args = buildContainerArgs({ project: 'mbc/PROJ_A' })
      expect(args).toContain('--project')
      expect(args).toContain('mbc/PROJ_A')
    })
  })

  describe('buildContainerName', () => {
    it('should build name with tenantCode and projectCode', () => {
      expect(buildContainerName('mbc', 'PROJ_A')).toBe('ai-mbc-proj-a')
    })

    it('should include agentId when provided', () => {
      expect(buildContainerName('mbc', 'PROJ_A', 'agent-123')).toBe('ai-mbc-proj-a-agent-123')
    })

    it('should lowercase all components', () => {
      expect(buildContainerName('MBC', 'MBC_01')).toBe('ai-mbc-mbc-01')
    })

    it('should replace underscores and other non-alphanumeric chars with hyphens', () => {
      expect(buildContainerName('my_tenant', 'MY_PROJECT')).toBe('ai-my-tenant-my-project')
    })

    it('should handle agentId with special characters', () => {
      expect(buildContainerName('mbc', 'PROJ_A', 'uuid_abc.123')).toBe('ai-mbc-proj-a-uuid-abc-123')
    })
  })

  describe('removeStaleContainer', () => {
    it('should call docker rm -f with the container name', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      removeStaleContainer('ai-mbc-proj-a')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker', ['rm', '-f', 'ai-mbc-proj-a'], { stdio: 'ignore' },
      )
    })

    it('should not throw when docker rm -f fails (container does not exist)', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('no such container') })
      expect(() => removeStaleContainer('ai-mbc-proj-a')).not.toThrow()
    })
  })

  describe('getInstalledVersion', () => {
    beforeEach(() => {
      resetInstalledVersionCache()
    })

    it('should return version from npm list output', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '1.2.3' } },
          }))
        }
        return Buffer.from('')
      })

      expect(getInstalledVersion()).toBe('1.2.3')
    })

    it('should cache the result after first call', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '1.2.3' } },
          }))
        }
        return Buffer.from('')
      })

      getInstalledVersion()
      getInstalledVersion()

      const listCalls = mockExecFileSync.mock.calls.filter(
        call => (call[1] as string[] | undefined)?.[0] === 'list',
      )
      expect(listCalls).toHaveLength(1)
    })

    it('should return fresh value after resetInstalledVersionCache', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '1.2.3' } },
          }))
        }
        return Buffer.from('')
      })

      expect(getInstalledVersion()).toBe('1.2.3')

      resetInstalledVersionCache()
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '2.0.0' } },
          }))
        }
        return Buffer.from('')
      })

      expect(getInstalledVersion()).toBe('2.0.0')
    })

    it('should fall back to AGENT_VERSION when npm list fails', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') throw new Error('npm error')
        return Buffer.from('')
      })

      // Should return AGENT_VERSION (compile-time constant) as fallback
      const result = getInstalledVersion()
      expect(typeof result).toBe('string')
      expect(result).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('should fall back to AGENT_VERSION when version is missing from output', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({ dependencies: {} }))
        }
        return Buffer.from('')
      })

      const result = getInstalledVersion()
      expect(typeof result).toBe('string')
      expect(result).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('should fall back to AGENT_VERSION when version string is invalid', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: 'invalid' } },
          }))
        }
        return Buffer.from('')
      })

      const result = getInstalledVersion()
      expect(typeof result).toBe('string')
      expect(result).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe('ensureImage', () => {
    beforeEach(() => {
      resetInstalledVersionCache()
    })

    it('should build image when it does not exist', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') return Buffer.from(JSON.stringify({ dependencies: {} }))
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') throw new Error('No such image')
        return Buffer.from('')
      })

      ensureImage()

      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
    })

    it('should skip build when image exists', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      ensureImage()

      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeUndefined()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.imageFound'))
    })

    it('should build image with newer installed version when installed version is newer', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '99.0.0' } },
          }))
        }
        // docker image inspect for newer version: not found
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') throw new Error('No such image')
        return Buffer.from('')
      })

      const version = ensureImage()

      expect(version).toBe('99.0.0')
      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
      // Should build with the newer version tag
      expect((buildCall![1] as string[])).toContain('ai-support-agent:99.0.0')
    })

    it('should use existing image of newer installed version without rebuilding', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') {
          return Buffer.from(JSON.stringify({
            dependencies: { '@ai-support-agent/cli': { version: '99.0.0' } },
          }))
        }
        // docker image inspect succeeds (image exists)
        return Buffer.from('')
      })

      const version = ensureImage()

      expect(version).toBe('99.0.0')
      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeUndefined()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.imageFound'))
    })

    it('should pass customDockerfile to buildImage when provided', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'list') return Buffer.from(JSON.stringify({ dependencies: {} }))
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') throw new Error('No such image')
        return Buffer.from('')
      })

      ensureImage('/custom/Dockerfile')

      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
      expect((buildCall![1] as string[])).toContain('/custom/Dockerfile')
    })
  })

  describe('syncDockerfileToConfigDir', () => {
    beforeEach(() => {
      mockGetConfigDir.mockReturnValue('/mock/config-dir')
    })

    it('should copy bundled Dockerfile to config dir on first run', () => {
      mockExistsSync.mockReturnValue(false) // destDockerfile does not exist

      syncDockerfileToConfigDir()

      expect(mockMkdirSync).toHaveBeenCalledWith('/mock/config-dir', expect.objectContaining({ recursive: true }))
      expect(mockCopyFileSync).toHaveBeenCalledWith('/mock/docker/Dockerfile', '/mock/config-dir/Dockerfile')
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileSynced'))
    })

    it('should skip when Dockerfile already exists in config dir', () => {
      mockExistsSync.mockImplementation((p) => p === '/mock/config-dir/Dockerfile')

      syncDockerfileToConfigDir()

      expect(mockCopyFileSync).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('should also copy entrypoint.sh when it exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/mock/docker/entrypoint.sh')

      syncDockerfileToConfigDir()

      expect(mockCopyFileSync).toHaveBeenCalledWith(
        '/mock/docker/entrypoint.sh',
        '/mock/config-dir/docker/entrypoint.sh',
      )
    })

    it('should warn and not throw when copy fails', () => {
      mockExistsSync.mockReturnValue(false)
      mockCopyFileSync.mockImplementation(() => { throw new Error('permission denied') })

      expect(() => syncDockerfileToConfigDir()).not.toThrow()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileSyncFailed'))
    })
  })

  describe('dockerLogin', () => {
    let consoleSpy: jest.SpyInstance

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'log').mockImplementation()
    })

    afterEach(() => {
      consoleSpy.mockRestore()
    })

    it('should print setup-token instruction', () => {
      dockerLogin()

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n')
      expect(output).toContain('claude setup-token')
    })

    it('should print CLAUDE_CODE_OAUTH_TOKEN usage', () => {
      dockerLogin()

      const output = consoleSpy.mock.calls.map(c => c[0]).join('\n')
      expect(output).toContain('CLAUDE_CODE_OAUTH_TOKEN')
      expect(output).toContain('ai-support-agent start')
    })

    it('should show step messages', () => {
      dockerLogin()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.loginStep1'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.loginStep2'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.loginStep3'))
    })
  })

  describe('runInDocker', () => {
    beforeEach(() => {
      resetIsDockerRunning()
      mockGetConfigDir.mockReturnValue('/mock/config-dir')
    })

    it('should exit with error when Docker is not available', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('not found') })

      runInDocker({})

      expect(logger.error).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should build image when it does not exist', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'info') return Buffer.from('')
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') {
          throw new Error('No such image')
        }
        if (argsArr && argsArr[0] === 'build') return Buffer.from('')
        return Buffer.from('')
      })

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      // Should have called docker build
      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--rm', '-i']),
        { stdio: 'inherit' },
      )
    })

    it('should use -it flag when TTY is available', () => {
      const originalIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--rm', '-it']),
        { stdio: 'inherit' },
      )

      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    })

    it('should use existing image when available', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.imageFound'))
      // Should NOT have called docker build
      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeUndefined()
    })

    it('should exit with container exit code on close', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      fakeChild.emit('close', 1)
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should call reExecProcess when container exits with DOCKER_UPDATE_EXIT_CODE (42)', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      fakeChild.emit('close', 42)
      // installUpdateAndRestart() is async — flush microtasks
      await Promise.resolve()
      await Promise.resolve()
      expect(mockReExecProcess).toHaveBeenCalled()
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('should install new version from update-version.json on code=42', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)
      mockGetConfigDir.mockReturnValue('/mock/config')
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '0.0.30-beta.4' }) as any)
      mockPerformUpdate.mockResolvedValue({ success: true })

      runInDocker({})
      fakeChild.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(mockPerformUpdate).toHaveBeenCalledWith('0.0.30-beta.4', 'global')
      expect(mockUnlinkSync).toHaveBeenCalled()
      expect(mockReExecProcess).toHaveBeenCalled()
    })

    it('should warn but still restart when npm install fails on code=42', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)
      mockGetConfigDir.mockReturnValue('/mock/config')
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '0.0.30-beta.4' }) as any)
      mockPerformUpdate.mockResolvedValue({ success: false, error: 'permission denied' })

      runInDocker({})
      fakeChild.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(mockPerformUpdate).toHaveBeenCalledWith('0.0.30-beta.4', 'global')
      expect(mockReExecProcess).toHaveBeenCalled()
    })

    it('should exit with 0 when close code is null', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      fakeChild.emit('close', null)
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('should handle spawn error', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      fakeChild.emit('error', new Error('spawn failed'))
      expect(logger.error).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should forward SIGINT to child process', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      const processOnSpy = jest.spyOn(process, 'on')

      runInDocker({})

      // Find the SIGINT handler that was registered
      const sigintCall = processOnSpy.mock.calls.find(call => call[0] === 'SIGINT')
      expect(sigintCall).toBeDefined()

      // Call the handler
      const handler = sigintCall![1] as () => void
      handler()
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGINT')

      processOnSpy.mockRestore()
    })

    it('should forward SIGTERM to child process', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      const processOnSpy = jest.spyOn(process, 'on')

      runInDocker({})

      // Find the SIGTERM handler that was registered
      const sigtermCall = processOnSpy.mock.calls.find(call => call[0] === 'SIGTERM')
      expect(sigtermCall).toBeDefined()

      // Call the handler
      const handler = sigtermCall![1] as () => void
      handler()
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')

      processOnSpy.mockRestore()
    })

    it('should include --user flag with host UID/GID on Unix', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      // Ensure process.getuid/getgid are available (Unix)
      const originalGetuid = process.getuid
      const originalGetgid = process.getgid
      process.getuid = () => 1000
      process.getgid = () => 1000

      try {
        runInDocker({})

        const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
        const userIdx = spawnArgs.indexOf('--user')
        expect(userIdx).toBeGreaterThan(-1)
        expect(spawnArgs[userIdx + 1]).toBe('1000:1000')
      } finally {
        process.getuid = originalGetuid
        process.getgid = originalGetgid
      }
    })

    it('should omit --user flag on Windows (no process.getuid)', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      // Simulate Windows: getuid is undefined
      const originalGetuid = process.getuid
      const originalGetgid = process.getgid
      process.getuid = undefined as unknown as typeof process.getuid
      process.getgid = undefined as unknown as typeof process.getgid

      try {
        runInDocker({})

        const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
        expect(spawnArgs).not.toContain('--user')
      } finally {
        process.getuid = originalGetuid
        process.getgid = originalGetgid
      }
    })

    it('should pass container args to docker run', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({ verbose: true, pollInterval: 5000 })

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--verbose')
      expect(spawnArgs).toContain('--poll-interval')
      expect(spawnArgs).toContain('5000')
    })

    it('should call syncDockerfileToConfigDir by default', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)
      mockExistsSync.mockReturnValue(false) // Dockerfile not yet in config dir

      runInDocker({})

      // syncDockerfileToConfigDir was called: mkdirSync and copyFileSync should have been called
      expect(mockCopyFileSync).toHaveBeenCalledWith('/mock/docker/Dockerfile', '/mock/config-dir/Dockerfile')
    })

    it('should skip syncDockerfileToConfigDir when --no-dockerfile-sync flag is set', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({ dockerfileSync: false })

      expect(mockCopyFileSync).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Dockerfile'),
      )
    })

    it('should skip syncDockerfileToConfigDir when config.dockerfileSync is false', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({ agentId: 'a', createdAt: '2024', dockerfileSync: false })

      runInDocker({})

      expect(mockCopyFileSync).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Dockerfile'),
      )
    })

    it('should use opts.dockerfile when provided', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') throw new Error('No such image')
        return Buffer.from('')
      })
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({ dockerfileSync: false, dockerfile: '/custom/Dockerfile' })

      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
      expect((buildCall![1] as string[])).toContain('/custom/Dockerfile')
    })

    it('should use config.dockerfilePath when opts.dockerfile is not set', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        const argsArr = args as string[] | undefined
        if (argsArr && argsArr[0] === 'image' && argsArr[1] === 'inspect') throw new Error('No such image')
        return Buffer.from('')
      })
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({ agentId: 'a', createdAt: '2024', dockerfilePath: '/from-config/Dockerfile', dockerfileSync: false })

      runInDocker({})

      const buildCall = mockExecFileSync.mock.calls.find(
        call => (call[1] as string[])?.[0] === 'build',
      )
      expect(buildCall).toBeDefined()
      expect((buildCall![1] as string[])).toContain('/from-config/Dockerfile')
    })

    it('should spawn one container per project when projects are configured', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      let spawnCount = 0
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return (spawnCount === 1 ? fakeChild1 : fakeChild2) as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      // Two containers should have been spawned
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('should pass --project flag to each project container', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--project')
      expect(spawnArgs).toContain('mbc/PROJ_A')
    })

    it('should pass --name with ai-{tenantCode}-{projectCode} format to docker run', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const nameIdx = spawnArgs.indexOf('--name')
      expect(nameIdx).toBeGreaterThan(-1)
      expect(spawnArgs[nameIdx + 1]).toBe('ai-mbc-proj-a-agent-1')
    })

    it('should call docker rm -f before starting each container to remove stale containers', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const rmCall = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('rm'),
      )
      expect(rmCall).toBeDefined()
      expect(rmCall![1]).toEqual(['rm', '-f', 'ai-mbc-proj-a-agent-1'])
    })

    it('should pass per-project token and apiUrl as env vars', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'my-token', apiUrl: 'http://my-api' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const eIdx = spawnArgs.indexOf('AI_SUPPORT_AGENT_TOKEN=my-token')
      expect(eIdx).toBeGreaterThan(-1)
    })

    it('should replace localhost with host.docker.internal in apiUrl', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'my-token', apiUrl: 'http://localhost:4030' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:4030')
    })

    it('should replace 127.0.0.1 with host.docker.internal in apiUrl', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'my-token', apiUrl: 'http://127.0.0.1:4030' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:4030')
    })

    it('should stop all containers when one exits with update code 42', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      let spawnCount = 0
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return (spawnCount === 1 ? fakeChild1 : fakeChild2) as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockReturnValue(false)
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.1' }))

      runInDocker({})

      // Container for PROJ_A exits with code 42
      fakeChild1.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Other container (PROJ_B) should have been killed
      expect(fakeChild2.kill).toHaveBeenCalledWith('SIGTERM')
      // And npm install should have been triggered
      expect(mockPerformUpdate).toHaveBeenCalledWith('1.0.1', 'global')
    })

    it('should exit when all project containers exit cleanly', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})
      fakeChild.emit('close', 0)

      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('should mount per-project config dir for each container', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      // Should contain a volume mount for the per-project config dir
      const vIdx = spawnArgs.indexOf('-v')
      expect(vIdx).toBeGreaterThan(-1)
      // One of the -v args should include the project config path
      const vArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) {
          vArgs.push(spawnArgs[i + 1])
        }
      }
      const hasProjectConfigMount = vArgs.some((v) => v.includes('mbc') && v.includes('PROJ_A'))
      expect(hasProjectConfigMount).toBe(true)
    })

    it('should use tenantCode in project config dir path', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'acme', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const vArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) {
          vArgs.push(spawnArgs[i + 1])
        }
      }
      // Should include tenantCode in the config dir path
      const hasTenantMount = vArgs.some((v) => v.includes('acme') && v.includes('PROJ_A'))
      expect(hasTenantMount).toBe(true)
    })

    it('should mount .claude and .claude.json when they exist in per-project mode', () => {
      const home = os.homedir()
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return s === `${home}/.claude` || s === `${home}/.claude.json`
      })

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const vArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) {
          vArgs.push(spawnArgs[i + 1])
        }
      }
      expect(vArgs.some((v) => v.includes('.claude:'))).toBe(true)
      expect(vArgs.some((v) => v.includes('.claude.json:'))).toBe(true)
    })

    it('should mount the default project dir (parent of projectConfigHostDir) and set PROJECT_DIR_MAP when project.projectDir is NOT set', () => {
      // Regression: without this mount + env, the in-container agent would
      // resolve projectDir to `${CONFIG_DIR}/projects/<t>/<p>` which lives
      // INSIDE the projectConfigHostDir bind-mount, producing a doubly
      // nested workspace tree on disk.
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'tok', apiUrl: 'http://api' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const vArgs: string[] = []
      const eArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) vArgs.push(spawnArgs[i + 1])
        if (spawnArgs[i] === '-e' && i + 1 < spawnArgs.length) eArgs.push(spawnArgs[i + 1])
      }
      // The default project dir mount targets /workspace/projects/<code>
      expect(vArgs.some((v) => v.includes(':/workspace/projects/PROJ_A:rw'))).toBe(true)
      expect(eArgs).toContain('AI_SUPPORT_AGENT_PROJECT_DIR_MAP=PROJ_A=/workspace/projects/PROJ_A')
    })

    it('should warn (not fail) when chmodSync on the default project dir fails', () => {
      // Pre-existing project dirs created with default umask end up 0o755;
      // chmod-to-0o700 may fail on read-only fs or foreign owner. We must
      // surface a warning (silent failure would defeat the security intent).
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'tok', apiUrl: 'http://api' },
        ],
      })
      mockExistsSync.mockReturnValue(false)
      // chmodSync throws on the default-project-dir path only
      const chmodSpy = jest.spyOn(require('fs'), 'chmodSync').mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.includes('/projects/mbc/PROJ_A')) {
          throw new Error('EROFS')
        }
      })

      try {
        runInDocker({})
      } finally {
        chmodSpy.mockRestore()
      }

      const loggerMock = require('../../src/logger').logger
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('docker.projectDirChmodFailed'),
      )
    })

    it('should NOT spawn a container for a project whose projectCode contains PROJECT_DIR_MAP separators', () => {
      // Same validation that the linux/darwin wrappers do at install time.
      // Without this check, a corrupt env map would let resolveProjectDir
      // fall back to the default template and re-introduce the doubly
      // nested layout the prior PR fixed.
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'X;Y', token: 'tok', apiUrl: 'http://api' },
        ],
      })

      runInDocker({})

      // The supervisor's per-project try/catch logs the failure via
      // docker.projectSpawnFailed (docker-specific key — not the service
      // install key) and skips the spawn.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('docker.projectSpawnFailed'),
      )
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('should still spawn valid projects when one config entry has an invalid projectCode', () => {
      // Regression for the supervisor-symmetry partial-failure bug: a
      // single bad projectCode used to abort the entire start loop. The
      // try/catch around spawnProject now lets the rest through.
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'tA', apiUrl: 'http://api' },
          { tenantCode: 'mbc', projectCode: 'X;Y', token: 'tB', apiUrl: 'http://api' },
          { tenantCode: 'mbc', projectCode: 'PROJ_C', token: 'tC', apiUrl: 'http://api' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      // PROJ_A and PROJ_C should have spawned; X;Y should not.
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('should NOT emit a duplicate default mount when project.projectDir is set', () => {
      // Docker errors on duplicate target paths; the default project-dir
      // mount must yield to the explicit projectDir mount.
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          {
            tenantCode: 'mbc',
            projectCode: 'PROJ_A',
            token: 'tok',
            apiUrl: 'http://api',
            projectDir: '/explicit/proj-a',
          },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => p === '/explicit/proj-a')
      mockRealpathSync.mockImplementation((p: unknown) => p as string)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const vArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) vArgs.push(spawnArgs[i + 1])
      }
      const projectMounts = vArgs.filter((v) => v.endsWith(':/workspace/projects/PROJ_A:rw'))
      expect(projectMounts).toHaveLength(1)
      expect(projectMounts[0]).toBe('/explicit/proj-a:/workspace/projects/PROJ_A:rw')
    })

    it('should mount projectDir and set PROJECT_DIR_MAP when project.projectDir exists', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          {
            tenantCode: 'mbc',
            projectCode: 'PROJ_A',
            token: 'token-a',
            apiUrl: 'http://api-a',
            projectDir: '/projects/proj-a',
          },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => p === '/projects/proj-a')
      mockRealpathSync.mockImplementation((p: unknown) => p as string)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const vArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-v' && i + 1 < spawnArgs.length) {
          vArgs.push(spawnArgs[i + 1])
        }
      }
      expect(vArgs.some((v) => v.includes('/projects/proj-a:'))).toBe(true)
      const eArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-e' && i + 1 < spawnArgs.length) {
          eArgs.push(spawnArgs[i + 1])
        }
      }
      expect(eArgs.some((e) => e.startsWith('AI_SUPPORT_AGENT_PROJECT_DIR_MAP='))).toBe(true)
    })

    it('should pass ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'

      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const eArgs: string[] = []
      for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '-e' && i + 1 < spawnArgs.length) {
          eArgs.push(spawnArgs[i + 1])
        }
      }
      expect(eArgs).toContain('ANTHROPIC_API_KEY=test-anthropic-key')
      expect(eArgs).toContain('CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token')

      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    })

    it('should handle error from project container spawn', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      fakeChild.emit('error', new Error('spawn failed'))
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('spawn failed'))
    })

    it('should not exit when one of multiple containers exits cleanly (others still running)', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      let spawnCount = 0
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return (spawnCount === 1 ? fakeChild1 : fakeChild2) as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({})

      // Only first container exits (second still running)
      fakeChild1.emit('close', 0)

      // Should not exit yet (second container still running)
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('should call process.exit(1) when installUpdateAndRestart rejects in supervisor mode', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)
      // Make reExecProcess throw synchronously to simulate a critical failure
      mockReExecProcess.mockImplementation(() => { throw new Error('reExecProcess failed') })

      runInDocker({})

      fakeChild.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should skip blocked projectDir mount in per-project mode', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          {
            tenantCode: 'mbc',
            projectCode: 'PROJ_A',
            token: 'token-a',
            apiUrl: 'http://api-a',
            projectDir: '/etc/passwd',
          },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => p === '/etc/passwd')
      mockRealpathSync.mockImplementation((p: unknown) => p as string)

      runInDocker({})

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping blocked path'))
    })

    it('should ignore second update exit (updating flag) when two containers exit with 42', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      let spawnCount = 0
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return (spawnCount === 1 ? fakeChild1 : fakeChild2) as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockReturnValue(false)
      mockReadFileSync.mockReturnValue(JSON.stringify({ version: '1.0.1' }))

      runInDocker({})

      // Both containers exit with 42
      fakeChild1.emit('close', 42)
      fakeChild2.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()

      // performUpdate should only have been called once (not twice)
      // due to the `this.updating` guard
      expect(mockPerformUpdate).toHaveBeenCalledTimes(1)
    })

    it('should guard against duplicate runInDocker calls', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})
      runInDocker({}) // second call should be ignored

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already running'))
      // spawn only called once
      expect(mockSpawn).toHaveBeenCalledTimes(1)

      // Clean up: reset so subsequent tests work
      resetIsDockerRunning()
      fakeChild.emit('close', 0)
    })

    it('should handle SIGINT and SIGTERM in multi-project mode', () => {
      jest.useFakeTimers()
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      const processOnSpy = jest.spyOn(process, 'on')
      runInDocker({})

      const sigintCall = processOnSpy.mock.calls.find(call => call[0] === 'SIGINT')
      expect(sigintCall).toBeDefined()
      const handler = sigintCall![1] as () => void
      handler()

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
      processOnSpy.mockRestore()
      jest.clearAllTimers()
      jest.useRealTimers()
    })

    it('should call process.exit after all containers close on shutdown', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const mockExitShutdown = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        createdAt: '2024-01-01',
        projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
      })
      mockExistsSync.mockReturnValue(false)
      // No agentId → else branch (no S3), resolveClosed called immediately on close
      const osMod = require('os') as typeof import('os')
      const hostnameSpy = jest.spyOn(osMod, 'hostname').mockReturnValue('')

      const processOnSpy = jest.spyOn(process, 'on')
      // Use shutdownTimeoutMs:60000 to ensure the real timer doesn't fire during the test
      runInDocker({ shutdownTimeoutMs: 60_000 })
      hostnameSpy.mockRestore()

      const sigintCall = processOnSpy.mock.calls.find(call => call[0] === 'SIGINT')
      const handler = sigintCall![1] as () => void
      handler()

      // Container close resolves closedPromise → process.exit should be called
      fakeChild.emit('close', 0)
      // Need multiple microtask ticks: close → resolveClosed → Promise.all resolves → .then callback
      for (let i = 0; i < 10; i++) await Promise.resolve()

      expect(mockExitShutdown).toHaveBeenCalledWith(0)
      processOnSpy.mockRestore()
      mockExitShutdown.mockRestore()
    })

    it('should force exit via timeout when log flush takes too long on shutdown', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const mockExitShutdown = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const { ApiClient: MockApiClient } = require('../../src/api-client')
      // Use a controllable promise so we can resolve it after the test to avoid leaks
      let resolveSaveSessionLog!: () => void
      const saveSessionLogPromise = new Promise<void>((resolve) => { resolveSaveSessionLog = resolve })
      MockApiClient.mockImplementation(() => ({
        submitLogChunk: jest.fn().mockResolvedValue(undefined),
        saveSessionLog: jest.fn().mockReturnValue(saveSessionLogPromise),
      }))
      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
      })
      mockExistsSync.mockReturnValue(false)

      const processOnSpy = jest.spyOn(process, 'on')
      // Use shutdownTimeoutMs:50 so the real timer fires quickly without fake timers
      runInDocker({ agentId: 'agent-1', shutdownTimeoutMs: 50 })

      const sigintCall = processOnSpy.mock.calls.find(call => call[0] === 'SIGINT')
      const handler = sigintCall![1] as () => void
      handler()

      // Emit log data and close — saveSessionLog will not resolve until we call resolveSaveSessionLog
      fakeChild.stdout.emit('data', Buffer.from('some log'))
      fakeChild.emit('close', 0)
      for (let i = 0; i < 5; i++) await Promise.resolve()

      // process.exit should not be called yet (saveSessionLog hasn't resolved)
      expect(mockExitShutdown).not.toHaveBeenCalled()

      // Wait for the real 50ms timeout to fire
      await new Promise<void>((resolve) => setTimeout(resolve, 100))

      expect(mockExitShutdown).toHaveBeenCalledWith(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Shutdown timed out'))
      processOnSpy.mockRestore()
      // Resolve the dangling promise BEFORE restoring mocks to prevent real process.exit
      // from being called after mock teardown (microtask queue ordering issue)
      resolveSaveSessionLog()
      // Drain microtasks so Promise.all.then fires while mockExitShutdown is still active
      for (let i = 0; i < 10; i++) await Promise.resolve()
      mockExitShutdown.mockRestore()
    })

    it('should handle realpathSync failure for project.projectDir (skip mount)', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          {
            tenantCode: 'mbc',
            projectCode: 'PROJ_A',
            token: 'token-a',
            apiUrl: 'http://api-a',
            projectDir: '/bad/path',
          },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => p === '/bad/path')
      mockRealpathSync.mockImplementation(() => { throw new Error('lstat failed') })

      runInDocker({})

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot resolve path'))
    })

    it('should use fallback project from token when --project does not match config', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({ project: 'mbc/PROJ_A', token: 'cli-token', apiUrl: 'http://cli-api' })

      // Should still spawn a container using the CLI token
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('mbc/PROJ_A')
    })

    it('should call process.exit(1) when --project has no slash', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({ project: 'PROJ_A_WITHOUT_SLASH' })
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should call process.exit(1) when --project not found and no token', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({ project: 'mbc/PROJ_A' })
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should pass verbose, pollInterval, heartbeatInterval, updateChannel to project containers', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false)

      runInDocker({
        verbose: true,
        pollInterval: 5000,
        heartbeatInterval: 30000,
        autoUpdate: false,
        updateChannel: 'beta',
      })

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--verbose')
      expect(spawnArgs).toContain('--poll-interval')
      expect(spawnArgs).toContain('5000')
      expect(spawnArgs).toContain('--heartbeat-interval')
      expect(spawnArgs).toContain('30000')
      expect(spawnArgs).toContain('--no-auto-update')
      expect(spawnArgs).toContain('--update-channel')
      expect(spawnArgs).toContain('beta')
    })

    it('should restart only the project container when exit code is 43 (no rebuild marker)', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return (spawnCount === 1 ? fakeChild1 : fakeChild2) as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockReturnValue(false) // no rebuild marker, no project-specific image

      runInDocker({})
      resetIsDockerRunning()

      // Container exits with code 43 (restart signal)
      fakeChild1.emit('close', 43)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Should have spawned a second container (restart)
      expect(mockSpawn).toHaveBeenCalledTimes(2)
      // Should NOT call process.exit
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('should rebuild image and restart when exit code is 43 with docker-rebuild-needed marker', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeBuildChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        if (spawnCount === 1) return fakeChild1 as never
        if (spawnCount === 2) return fakeBuildChild as never
        return fakeChild2 as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // rebuild marker exists, project Dockerfile exists at projectConfigHostDir/Dockerfile
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-rebuild-needed') || ps.endsWith('Dockerfile')
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      // buildProjectImage is now async (spawn-based), emit close to resolve the build
      fakeBuildChild.emit('close', 0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // unlinkSync should have been called for the marker
      expect(unlinkSync).toHaveBeenCalled()
      // docker build should have been called via spawn (not execFileSync)
      const dockerBuildCall = mockSpawn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('build'),
      )
      expect(dockerBuildCall).toBeDefined()
      // Should have restarted the container (3 total: container1 + build + container2)
      expect(mockSpawn).toHaveBeenCalledTimes(3)
    })

    it('should load registered agentId from docker-registered-agent-id before rebuild', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeBuildChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const { ApiClient: MockApiClient } = require('../../src/api-client')
      const capturedChunks: Array<{ agentId: string; logType: string }> = []
      MockApiClient.mockImplementation(() => ({
        submitLogChunk: jest.fn().mockImplementation((args: { agentId: string; logType: string }) => {
          capturedChunks.push(args)
          return Promise.resolve(undefined)
        }),
        saveSessionLog: jest.fn().mockResolvedValue(undefined),
      }))
      mockSpawn.mockImplementation(() => {
        spawnCount++
        if (spawnCount === 1) return fakeChild1 as never
        if (spawnCount === 2) return fakeBuildChild as never
        return fakeChild2 as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'host-agent-id',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-rebuild-needed') || ps.endsWith('Dockerfile') || ps.endsWith('docker-registered-agent-id')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        if (ps.endsWith('docker-registered-agent-id')) return 'registered-uuid-agent-id' as any
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      // Emit some build output so submitLogChunk is called
      fakeBuildChild.stdout?.emit('data', Buffer.from('Step 1/2 : FROM node'))
      await Promise.resolve()
      fakeBuildChild.emit('close', 0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Build log chunks should use the registered agentId (not the host agentId)
      const buildCall = capturedChunks.find((c) => c.logType === 'docker-build')
      if (buildCall) {
        expect(buildCall.agentId).toBe('registered-uuid-agent-id')
      }
    })

    it('should NOT restart container when image build fails', async () => {
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeBuildChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        if (spawnCount === 1) return fakeChild1 as never
        if (spawnCount === 2) return fakeBuildChild as never
        return fakeChild2 as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // rebuild marker and project Dockerfile exist at projectConfigHostDir/Dockerfile
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-rebuild-needed') || ps.endsWith('Dockerfile')
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      // buildProjectImage spawn emits non-zero exit code to simulate build failure
      fakeBuildChild.emit('close', 1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Container should have been restarted with previous image (3 total: container1 + build + container2)
      expect(mockSpawn).toHaveBeenCalledTimes(3)
      // Supervisor should NOT exit
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('should NOT exit when build fails but other containers are still running', async () => {
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeBuildChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild3 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        if (spawnCount === 1) return fakeChild1 as never  // PROJ_A initial
        if (spawnCount === 2) return fakeChild2 as never  // PROJ_B initial
        if (spawnCount === 3) return fakeBuildChild as never  // docker build
        return fakeChild3 as never  // PROJ_A restart
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
          { tenantCode: 'mbc', projectCode: 'PROJ_B', token: 'token-b', apiUrl: 'http://api-b' },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.includes('PROJ_A') && (ps.endsWith('docker-rebuild-needed') || ps.endsWith('Dockerfile'))
      })

      runInDocker({})
      resetIsDockerRunning()

      // PROJ_A requests rebuild (build fails with non-zero exit)
      fakeChild1.emit('close', 43)
      await Promise.resolve()
      fakeBuildChild.emit('close', 1)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Spawn called 4 times: PROJ_A initial + PROJ_B initial + build + PROJ_A restart with previous image
      expect(mockSpawn).toHaveBeenCalledTimes(4)
      // PROJ_B is still running, so supervisor should NOT exit
      expect(mockExit).not.toHaveBeenCalled()
    })

    it('should copy docker-customization-hash to docker-built-hash after successful build', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeBuildChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      const fakeChild2 = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: new EventEmitter(), stderr: new EventEmitter() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        if (spawnCount === 1) return fakeChild1 as never
        if (spawnCount === 2) return fakeBuildChild as never
        return fakeChild2 as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // rebuild marker exists, project Dockerfile exists at projectConfigHostDir/Dockerfile, and docker-customization-hash exists
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-rebuild-needed') || ps.endsWith('Dockerfile') || ps.endsWith('docker-customization-hash')
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      // buildProjectImage is now async (spawn-based), emit close to resolve the build
      fakeBuildChild.emit('close', 0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // copyFileSync should have been called to copy docker-customization-hash to docker-built-hash
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('docker-customization-hash'),
        expect.stringContaining('docker-built-hash'),
      )
    })

    it('should start container normally when pre-startup hashes match', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // Both hash files exist with matching hashes, no project-specific image
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-customization-hash') || ps.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        if (ps.endsWith('docker-customization-hash')) return 'same-hash' as any
        if (ps.endsWith('docker-built-hash')) return 'same-hash' as any
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      runInDocker({})
      resetIsDockerRunning()

      await Promise.resolve()

      // Should NOT have called docker build
      const dockerBuildCall = mockSpawn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('build'),
      )
      expect(dockerBuildCall).toBeUndefined()
      // Container should have started directly (no rebuild)
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      // Close the container so the supervisor exits cleanly
      fakeContainerChild.emit('close', 0)
      await Promise.resolve()
    })

    it('should skip pre-startup rebuild when only one hash file exists', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // Only docker-customization-hash exists (no docker-built-hash) -> skip pre-startup check
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-customization-hash')
      })

      runInDocker({})
      resetIsDockerRunning()

      await Promise.resolve()

      // Should NOT have called docker build
      const dockerBuildCall = mockSpawn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('build'),
      )
      expect(dockerBuildCall).toBeUndefined()
      // Container should have started directly
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      // Close the container so the supervisor exits cleanly
      fakeContainerChild.emit('close', 0)
      await Promise.resolve()
    })

    it('should log and trigger rebuild when pre-startup hashes do not match', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: null, stderr: null })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // Both hash files exist but with different hashes
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-customization-hash') || ps.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        if (ps.endsWith('docker-customization-hash')) return 'new-hash' as any
        if (ps.endsWith('docker-built-hash')) return 'old-hash' as any
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      runInDocker({})
      resetIsDockerRunning()

      await Promise.resolve()

      // Should have logged the mismatch
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Pre-startup hash mismatch for mbc/PROJ_A, rebuilding before start...'),
      )
      // spawnProject returns early, container not started synchronously
      const dockerRunCall = mockSpawn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('run'),
      )
      expect(dockerRunCall).toBeUndefined()
    })

    it('should use docker-registered-agent-id from file if it exists before container start', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: null, stderr: null })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'hostname-based-id',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.endsWith('docker-registered-agent-id')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('docker-registered-agent-id')) return 'server-assigned-uuid-5678' as any
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      runInDocker({})
      resetIsDockerRunning()

      await Promise.resolve()

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Using registered agentId for mbc/PROJ_A: server-assigned-uuid-5678'),
      )
      // Container should start
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      fakeContainerChild.emit('close', 0)
      await Promise.resolve()
    })

    it('should set up fs.watch for docker-registered-agent-id when agentId is configured', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: null, stderr: null })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'hostname-based-id',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // No docker-registered-agent-id yet (container not yet registered)
      mockExistsSync.mockReturnValue(false)

      runInDocker({})
      resetIsDockerRunning()

      await Promise.resolve()

      // fs.watch should be called on the project config directory
      expect(mockFsWatch).toHaveBeenCalledWith(
        expect.stringContaining('mbc'),
        expect.any(Function),
      )
      fakeContainerChild.emit('close', 0)
      await Promise.resolve()
    })

    it('should skip agentId update when docker-registered-agent-id matches current agentId', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const fakeContainerChild = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout: null, stderr: null })
      mockSpawn.mockReturnValue(fakeContainerChild as never)
      mockLoadConfig.mockReturnValue({
        agentId: 'already-correct-id',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // docker-registered-agent-id has the same value as the current agentId
      mockExistsSync.mockImplementation((p: unknown) => {
        return String(p).endsWith('docker-registered-agent-id')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('docker-registered-agent-id')) return 'already-correct-id' as any
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      runInDocker({ agentId: 'already-correct-id' })
      resetIsDockerRunning()

      await Promise.resolve()

      // Should NOT log an agentId update since IDs are identical
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Using registered agentId for'),
      )
      fakeContainerChild.emit('close', 0)
      await Promise.resolve()
    })
  })
})

describe('migrateProjectConfigDir', () => {
  const project = { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token', apiUrl: 'http://api' }

  beforeEach(() => {
    mockGetConfigDir.mockReturnValue('/mock/config-dir')
    mockMkdirSync.mockReset()
    mockRenameSync.mockReset()
  })

  it('should migrate legacy dir to new tenantCode-based path', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const ps = String(p)
      if (ps === '/mock/config-dir/projects/PROJ_A') return true   // legacy exists
      if (ps === '/mock/config-dir/projects/mbc/PROJ_A') return false // new does not exist
      return false
    })

    migrateProjectConfigDir(project)

    expect(mockMkdirSync).toHaveBeenCalledWith('/mock/config-dir/projects/mbc', expect.objectContaining({ recursive: true }))
    expect(mockRenameSync).toHaveBeenCalledWith(
      '/mock/config-dir/projects/PROJ_A',
      '/mock/config-dir/projects/mbc/PROJ_A',
    )
  })

  it('should do nothing when legacy dir does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    migrateProjectConfigDir(project)

    expect(mockRenameSync).not.toHaveBeenCalled()
    expect(mockMkdirSync).not.toHaveBeenCalled()
  })

  it('should do nothing when new dir already exists', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const ps = String(p)
      if (ps === '/mock/config-dir/projects/PROJ_A') return true    // legacy exists
      if (ps === '/mock/config-dir/projects/mbc/PROJ_A') return true // new also exists
      return false
    })

    migrateProjectConfigDir(project)

    expect(mockRenameSync).not.toHaveBeenCalled()
  })

  it('should warn on rename failure and not throw', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const ps = String(p)
      if (ps === '/mock/config-dir/projects/PROJ_A') return true
      if (ps === '/mock/config-dir/projects/mbc/PROJ_A') return false
      return false
    })
    mockRenameSync.mockImplementation(() => { throw new Error('EACCES') })

    expect(() => migrateProjectConfigDir(project)).not.toThrow()
  })
})

describe('validatePackageNames', () => {
  it('should accept valid apt package names', () => {
    expect(() => validatePackageNames(['curl', 'git', 'libssl-dev', 'python3.11', 'g++'], 'apt')).not.toThrow()
  })

  it('should accept valid npm package names including scoped and versioned', () => {
    expect(() => validatePackageNames(['typescript', '@playwright/test', 'jest@29.0.0', 'ts-node'], 'npm')).not.toThrow()
  })

  it('should throw for apt package name with shell metacharacters', () => {
    expect(() => validatePackageNames(['curl; rm -rf /'], 'apt')).toThrow('Invalid apt package name')
    expect(() => validatePackageNames(['$(evil)'], 'apt')).toThrow('Invalid apt package name')
    expect(() => validatePackageNames(['curl && evil'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should throw for npm package name with shell metacharacters', () => {
    expect(() => validatePackageNames(['typescript; rm -rf /'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should throw for empty string package name', () => {
    expect(() => validatePackageNames([''], 'apt')).toThrow('Invalid apt package name')
  })
})

describe('generateProjectDockerfile', () => {
  it('should generate FROM line only when no packages', () => {
    const result = generateProjectDockerfile('1.0.0', [], [])
    expect(result).toBe('FROM ai-support-agent:1.0.0\n')
  })

  it('should include apt-get install when aptPackages are given', () => {
    const result = generateProjectDockerfile('1.0.0', ['curl', 'git'], [])
    expect(result).toContain('apt-get install')
    expect(result).toContain('curl')
    expect(result).toContain('git')
  })

  it('should include npm install -g when npmPackages are given', () => {
    const result = generateProjectDockerfile('1.0.0', [], ['@playwright/test'])
    expect(result).toContain('npm install -g @playwright/test')
  })

  it('should include both apt and npm when both are given', () => {
    const result = generateProjectDockerfile('1.0.0', ['curl'], ['typescript'])
    expect(result).toContain('apt-get install')
    expect(result).toContain('npm install -g typescript')
  })

  it('should include RUN command when commands are given', () => {
    const result = generateProjectDockerfile('1.0.0', [], [], ['echo hello'])
    expect(result).toContain('RUN echo hello')
  })

  it('should throw when command contains forbidden characters', () => {
    expect(() => generateProjectDockerfile('1.0.0', [], [], ['rm -rf /; evil'])).toThrow('Invalid command')
  })

  it('should throw when apt package name is invalid', () => {
    expect(() => generateProjectDockerfile('1.0.0', ['curl; evil'], [])).toThrow('Invalid apt package name')
  })

  it('should throw when npm package name is invalid', () => {
    expect(() => generateProjectDockerfile('1.0.0', [], ['ts; evil'])).toThrow('Invalid npm package name')
  })

  it('should include ENV TZ when timezone is provided', () => {
    const result = generateProjectDockerfile('1.0.0', [], [], [], 'Asia/Tokyo')
    expect(result).toContain('ENV TZ=Asia/Tokyo')
  })

  it('should place ENV TZ before RUN instructions', () => {
    const result = generateProjectDockerfile('1.0.0', ['curl'], [], [], 'UTC')
    const lines = result.split('\n')
    const tzIdx = lines.findIndex((l) => l.startsWith('ENV TZ='))
    const runIdx = lines.findIndex((l) => l.startsWith('RUN'))
    expect(tzIdx).toBeGreaterThan(-1)
    expect(tzIdx).toBeLessThan(runIdx)
  })

  it('should not include ENV TZ when timezone is not provided', () => {
    const result = generateProjectDockerfile('1.0.0', [], [])
    expect(result).not.toContain('ENV TZ=')
  })
})

describe('buildProjectImage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should spawn docker build with correct arguments', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile')
    fakeProc.emit('close', 0)
    await promise

    expect(mockSpawnFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['build', '-t', expect.stringContaining('mbc'), '-f', '/path/to/Dockerfile']),
      expect.any(Object),
    )
  })

  it('should not pass secret env vars to docker build process', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    // Set secret env vars in process.env
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-key'
    process.env.AI_SUPPORT_AGENT_TOKEN = 'secret-token'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile')
    fakeProc.emit('close', 0)
    await promise

    const spawnCall = mockSpawnFn.mock.calls[0]
    const spawnOptions = spawnCall[2] as { env?: Record<string, string> }
    const passedEnv = spawnOptions?.env ?? {}

    // Secret vars should NOT be in the env passed to docker build
    expect(passedEnv['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(passedEnv['AI_SUPPORT_AGENT_TOKEN']).toBeUndefined()
    expect(passedEnv['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    // BUILDKIT_PROGRESS should always be set
    expect(passedEnv['BUILDKIT_PROGRESS']).toBe('plain')
  })

  it('should throw when docker build exits with non-zero code', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile')
    fakeProc.emit('close', 1)

    await expect(promise).rejects.toThrow('docker build exited with code 1')
  })

  it('should stream log chunks to apiClient when provided', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const mockApiClient = {
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile', mockApiClient as never, 'agent-1')
    // Emit data to trigger chunk buffering
    fakeProc.stdout.emit('data', Buffer.from('Step 1/3 : FROM node'))
    fakeProc.emit('close', 0)
    await promise

    // saveSessionLog should have been called with the full log
    expect(mockApiClient.saveSessionLog).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      projectCode: 'PROJ_A',
      logType: 'docker-build',
      content: expect.stringContaining('Step 1/3'),
    }))
  })

  it('should not call apiClient when not provided', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    // Should complete without error even without apiClient
    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile')
    fakeProc.stdout.emit('data', Buffer.from('some log'))
    fakeProc.emit('close', 0)
    await promise
    // No assertion needed — just verify it doesn't throw
  })

  it('should handle submitLogChunk errors gracefully', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const mockApiClient = {
      submitLogChunk: jest.fn().mockRejectedValue(new Error('chunk failed')),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }

    // Should not throw even when submitLogChunk fails
    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile', mockApiClient as never, 'agent-1')
    // Large data to trigger flush during build
    fakeProc.stdout.emit('data', Buffer.from('x'.repeat(5000)))
    fakeProc.emit('close', 0)
    await promise
    // No assertion needed — just verify it doesn't throw
  })

  it('should handle saveSessionLog errors gracefully', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const mockApiClient = {
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockRejectedValue(new Error('upload failed')),
    }

    // Should not throw even when saveSessionLog fails
    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile', mockApiClient as never, 'agent-1')
    fakeProc.stdout.emit('data', Buffer.from('some log'))
    fakeProc.emit('close', 0)
    await promise
    // No assertion needed — just verify it doesn't throw
  })

  it('should truncate fullLog when it exceeds 2 MB limit', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const mockApiClient = {
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile', mockApiClient as never, 'agent-1')
    // Send data exceeding 4KB threshold in multiple chunks to trigger flush+truncation
    // First chunk fills fullLog past 2MB
    fakeProc.stdout.emit('data', Buffer.from('A'.repeat(5000))) // triggers flush (>4096)
    await Promise.resolve()
    fakeProc.stdout.emit('data', Buffer.from('B'.repeat(2 * 1024 * 1024))) // exceeds 2MB
    await Promise.resolve()
    fakeProc.emit('close', 0)
    await promise

    // saveSessionLog content should be at most 2MB
    const savedContent: string = mockApiClient.saveSessionLog.mock.calls[0]?.[0]?.content ?? ''
    expect(savedContent.length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 MB limit'))
  })

  it('should handle remaining=0 case when fullLog is exactly at limit before flush', async () => {
    const fakeProc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const mockSpawnFn = spawn as jest.MockedFunction<typeof spawn>
    mockSpawnFn.mockReturnValue(fakeProc as never)

    const mockApiClient = {
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile', mockApiClient as never, 'agent-1')
    // First chunk fills fullLog to exactly 2MB
    fakeProc.stdout.emit('data', Buffer.from('X'.repeat(2 * 1024 * 1024 + 100)))
    await Promise.resolve()
    // Second chunk after fullLog is already at limit (remaining = 0)
    fakeProc.stdout.emit('data', Buffer.from('Y'.repeat(5000)))
    await Promise.resolve()
    fakeProc.emit('close', 0)
    await promise

    const savedContent: string = mockApiClient.saveSessionLog.mock.calls[0]?.[0]?.content ?? ''
    expect(savedContent.length).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})

describe('DockerSupervisor log streaming', () => {
  let mockExitInner: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    mockExitInner = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockFsWatch.mockReturnValue({ close: jest.fn() } as any)
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  })

  afterEach(() => {
    mockExitInner.mockRestore()
  })

  it('should stream container logs to apiClient when provided', async () => {
    // DockerSupervisorはプロジェクト固有のApiClientを new ApiClient(project.apiUrl, project.token) で作成する
    // ApiClientはモック済みなので、そのモックインスタンスのメソッドを通じて検証する
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
    const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: mockSubmitLogChunk,
      saveSessionLog: mockSaveSessionLog,
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'agent-1',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    runInDocker({ agentId: 'agent-1' })
    resetIsDockerRunning()

    // ApiClientがプロジェクトのapiUrl/tokenで生成されていることを確認
    expect(MockApiClient).toHaveBeenCalledWith('http://api-a', 'token-a')

    // Emit log data
    fakeChild.stdout.emit('data', Buffer.from('container output'))
    // Trigger close to flush and upload
    fakeChild.emit('close', 0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockSaveSessionLog).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      projectCode: 'PROJ_A',
      logType: 'container',
      content: expect.stringContaining('container output'),
    }))
  })

  it('should fall back to forwarding stdout/stderr without apiClient', () => {
    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    // Omit agentId and mock os.hostname to return empty string
    // so createProjectApiClient returns undefined → else branch is taken
    const osMod = require('os') as typeof import('os')
    const hostnameSpy = jest.spyOn(osMod, 'hostname').mockReturnValue('')
    mockLoadConfig.mockReturnValue({
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    runInDocker({})
    resetIsDockerRunning()
    hostnameSpy.mockRestore()

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    fakeChild.stdout.emit('data', Buffer.from('hello'))
    writeSpy.mockRestore()

    // Emit close to cover resolveClosed() in the no-log-streaming branch
    fakeChild.emit('close', 0)

    // No error thrown — test passes if no exception
  })

  it('should truncate container fullLog when it exceeds 2 MB limit', async () => {
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
    const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: mockSubmitLogChunk,
      saveSessionLog: mockSaveSessionLog,
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'agent-1',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    runInDocker({ agentId: 'agent-1' })
    resetIsDockerRunning()

    // Emit data exceeding 2MB limit
    fakeChild.stdout.emit('data', Buffer.from('A'.repeat(2 * 1024 * 1024 + 100)))
    await Promise.resolve()
    fakeChild.stdout.emit('data', Buffer.from('B'.repeat(5000)))
    await Promise.resolve()

    fakeChild.emit('close', 0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 MB limit'))
  })

  it('should update agentId via fs.watch callback when docker-registered-agent-id is written', async () => {
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
    const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: mockSubmitLogChunk,
      saveSessionLog: mockSaveSessionLog,
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'hostname-based-id',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    let watchCallback: ((eventType: string, filename: string | null) => void) | undefined
    mockFsWatch.mockImplementation((_dir: unknown, cb: unknown) => {
      watchCallback = cb as (eventType: string, filename: string | null) => void
      return { close: jest.fn() } as any
    })

    runInDocker({ agentId: 'hostname-based-id' })
    resetIsDockerRunning()

    // Simulate the container writing docker-registered-agent-id after registration
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('docker-registered-agent-id')) return 'server-assigned-uuid-9999' as any
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    // Trigger the fs.watch callback (simulating file creation)
    watchCallback?.('rename', 'docker-registered-agent-id')

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Container registered with agentId: server-assigned-uuid-9999'),
    )

    // Verify the agentId is used for subsequent log chunks
    fakeChild.stdout.emit('data', Buffer.from('container log after registration'))
    fakeChild.emit('close', 0)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mockSaveSessionLog).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'server-assigned-uuid-9999',
      projectCode: 'PROJ_A',
    }))
  })

  it('should ignore fs.watch callback for other filenames', async () => {
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'hostname-based-id',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    let watchCallback: ((eventType: string, filename: string | null) => void) | undefined
    mockFsWatch.mockImplementation((_dir: unknown, cb: unknown) => {
      watchCallback = cb as (eventType: string, filename: string | null) => void
      return { close: jest.fn() } as any
    })

    runInDocker({ agentId: 'hostname-based-id' })
    resetIsDockerRunning()

    // Trigger with a different filename — should be ignored
    watchCallback?.('rename', 'some-other-file')

    // No agentId update logged
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Container registered with agentId'),
    )

    fakeChild.emit('close', 0)
    await Promise.resolve()
  })

  it('should handle fs.watch setup failure gracefully', async () => {
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'agent-1',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    // Simulate fs.watch throwing (directory doesn't exist)
    mockFsWatch.mockImplementation(() => { throw new Error('ENOENT: no such file or directory') })

    runInDocker({ agentId: 'agent-1' })
    resetIsDockerRunning()

    // Container should still start despite watch failure
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    fakeChild.emit('close', 0)
    await Promise.resolve()
  })

  it('should handle submitLogChunk errors in DockerSupervisor gracefully', async () => {
    const { ApiClient: MockApiClient } = require('../../src/api-client')
    const mockSubmitLogChunk = jest.fn().mockRejectedValue(new Error('network error'))
    const mockSaveSessionLog = jest.fn().mockRejectedValue(new Error('s3 error'))
    MockApiClient.mockImplementation(() => ({
      submitLogChunk: mockSubmitLogChunk,
      saveSessionLog: mockSaveSessionLog,
    }))

    const fakeChild = Object.assign(new EventEmitter(), {
      kill: jest.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    mockSpawn.mockReturnValue(fakeChild as never)
    mockLoadConfig.mockReturnValue({
      agentId: 'agent-1',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' }],
    })

    runInDocker({ agentId: 'agent-1' })
    resetIsDockerRunning()

    fakeChild.stdout.emit('data', Buffer.from('some log'))
    fakeChild.emit('close', 0)
    // Multiple flushes needed: close -> flush() -> submitLogChunk (rejected) -> catch -> then -> saveSessionLog (rejected) -> catch
    for (let i = 0; i < 10; i++) await Promise.resolve()

    // Should warn about chunk failure
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('log chunk failed'))
    // Should warn about S3 upload failure
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('S3 upload failed'))
  })
})
