import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  spawn: jest.fn(),
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
  readFileSync: jest.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn(),
  copyFileSync: jest.fn(),
  mkdirSync: jest.fn(),
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
}))

jest.mock('../../src/update-checker', () => ({
  reExecProcess: jest.fn(),
  performUpdate: jest.fn().mockResolvedValue({ success: true }),
}))

import { execFileSync, spawn } from 'child_process'
import * as os from 'os'
import { existsSync, realpathSync, readFileSync, unlinkSync, copyFileSync, mkdirSync } from 'fs'
import { getConfigDir, loadConfig } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { reExecProcess, performUpdate } from '../../src/update-checker'
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

describe('docker-runner', () => {
  const originalEnv = process.env
  let mockExit: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
    mockExit.mockRestore()
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
      // rebuild marker exists, project Dockerfile exists
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.includes('docker-rebuild-needed') || ps.includes('PROJ_A/Dockerfile')
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // unlinkSync should have been called for the marker
      expect(unlinkSync).toHaveBeenCalled()
      // docker build should have been called for the project image
      const dockerBuildCall = mockExecFileSync.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('build'),
      )
      expect(dockerBuildCall).toBeDefined()
      // Should have restarted the container
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('should NOT restart container when image build fails', async () => {
      let spawnCount = 0
      const fakeChild1 = Object.assign(new EventEmitter(), { kill: jest.fn() })
      mockSpawn.mockImplementation(() => {
        spawnCount++
        return fakeChild1 as never
      })
      mockLoadConfig.mockReturnValue({
        agentId: 'agent-1',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'PROJ_A', token: 'token-a', apiUrl: 'http://api-a' },
        ],
      })
      // rebuild marker and project Dockerfile exist
      mockExistsSync.mockImplementation((p: unknown) => {
        const ps = String(p)
        return ps.includes('docker-rebuild-needed') || ps.includes('PROJ_A/Dockerfile')
      })
      // docker build throws
      mockExecFileSync.mockImplementation((...args: unknown[]) => {
        const cmdArgs = args[1] as string[]
        if (Array.isArray(cmdArgs) && cmdArgs.includes('build')) {
          throw new Error('Build failed')
        }
        return Buffer.from('')
      })

      runInDocker({})
      resetIsDockerRunning()

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Container should NOT have been restarted (spawn called only once for initial start)
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      expect(mockExit).not.toHaveBeenCalled()
    })
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

  it('should throw when apt package name is invalid', () => {
    expect(() => generateProjectDockerfile('1.0.0', ['curl; evil'], [])).toThrow('Invalid apt package name')
  })

  it('should throw when npm package name is invalid', () => {
    expect(() => generateProjectDockerfile('1.0.0', [], ['ts; evil'])).toThrow('Invalid npm package name')
  })
})

describe('buildProjectImage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should call execFileSync with correct docker build arguments', () => {
    const mockExec = execFileSync as jest.MockedFunction<typeof execFileSync>
    mockExec.mockReturnValue(Buffer.from(''))

    buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/to/Dockerfile')

    expect(mockExec).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['build', '-t', expect.stringContaining('mbc'), '-f', '/path/to/Dockerfile']),
      expect.any(Object),
    )
  })
})
