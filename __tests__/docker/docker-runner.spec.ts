import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  spawn: jest.fn(),
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
}))

jest.mock('../../src/docker/dockerfile-path', () => ({
  getDockerfilePath: jest.fn(() => '/mock/docker/Dockerfile'),
  getDockerContextDir: jest.fn(() => '/mock'),
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

import { execFileSync, spawn } from 'child_process'
import * as os from 'os'
import { existsSync, realpathSync } from 'fs'
import { getConfigDir, loadConfig } from '../../src/config-manager'
import { logger } from '../../src/logger'
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
  dockerLogin,
  runInDocker,
} from '../../src/docker/docker-runner'

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const mockGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
const mockRealpathSync = realpathSync as jest.MockedFunction<typeof realpathSync>

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
    it('should build docker image with correct arguments', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      buildImage('1.0.0')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['build', '-t', 'ai-support-agent:1.0.0', '--build-arg', 'AGENT_VERSION=1.0.0', '-f', '/mock/docker/Dockerfile', '/mock'],
        { stdio: 'inherit' },
      )
      expect(logger.info).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalled()
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/project-a' },
          { projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/workspace/project-b' },
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/shared' },
          { projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/workspace/shared' },
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/etc/secrets' },
          { projectCode: 'B', token: 't2', apiUrl: 'http://b', projectDir: '/proc/data' },
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/nonexistent' },
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/symlink-to-etc' },
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
          { projectCode: 'A', token: 't1', apiUrl: 'http://a', projectDir: '/workspace/broken-link' },
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
      // Only HOME should be present (no passthrough vars set)
      expect(args[0]).toBe('-e')
      expect(args[1]).toBe('HOME=/home/node')
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

      fakeChild.emit('close', 42)
      expect(mockExit).toHaveBeenCalledWith(42)
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
  })
})
