import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}))

jest.mock('fs', () => ({
  existsSync: jest.fn(),
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

import { execSync, spawn } from 'child_process'
import * as os from 'os'
import { existsSync } from 'fs'
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
  dockerLogin,
  runInDocker,
} from '../../src/docker/docker-runner'

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const mockGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>

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
      mockExecSync.mockReturnValue(Buffer.from(''))
      expect(checkDockerAvailable()).toBe(true)
      expect(mockExecSync).toHaveBeenCalledWith('docker info', { stdio: 'ignore' })
    })

    it('should return false when docker info fails', () => {
      mockExecSync.mockImplementation(() => { throw new Error('Docker not running') })
      expect(checkDockerAvailable()).toBe(false)
    })
  })

  describe('imageExists', () => {
    it('should return true when image exists', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))
      expect(imageExists('1.0.0')).toBe(true)
      expect(mockExecSync).toHaveBeenCalledWith('docker image inspect ai-support-agent:1.0.0', { stdio: 'ignore' })
    })

    it('should return false when image does not exist', () => {
      mockExecSync.mockImplementation(() => { throw new Error('No such image') })
      expect(imageExists('1.0.0')).toBe(false)
    })
  })

  describe('buildImage', () => {
    it('should build docker image with correct arguments', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))
      buildImage('1.0.0')
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker build -t ai-support-agent:1.0.0 --build-arg AGENT_VERSION=1.0.0 -f /mock/docker/Dockerfile /mock',
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

      const mounts = buildVolumeMounts()
      expect(mounts).toContain(`${home}/.claude:${home}/.claude:rw`)
      expect(mounts).toContain(`${home}/.claude.json:${home}/.claude.json:rw`)
      expect(mounts).toContain(`${home}/.ai-support-agent:${home}/.ai-support-agent:rw`)
      expect(mounts).toContain(`${home}/.aws:${home}/.aws:ro`)
    })

    it('should mount custom config directory from AI_SUPPORT_AGENT_CONFIG_DIR', () => {
      mockGetConfigDir.mockReturnValue('/custom/config/dir')
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/custom/config/dir'
      })
      mockLoadConfig.mockReturnValue(null)

      const mounts = buildVolumeMounts()
      expect(mounts).toContain('/custom/config/dir:/custom/config/dir:rw')
    })

    it('should skip non-existing directories', () => {
      mockExistsSync.mockReturnValue(false)
      mockLoadConfig.mockReturnValue(null)

      const mounts = buildVolumeMounts()
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

      const mounts = buildVolumeMounts()
      expect(mounts).toContain('/workspace/project-a:/workspace/project-a:rw')
      expect(mounts).toContain('/workspace/project-b:/workspace/project-b:rw')
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

      const mounts = buildVolumeMounts()
      const count = mounts.filter(m => m === '/workspace/shared:/workspace/shared:rw').length
      expect(count).toBe(1)
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

      const mounts = buildVolumeMounts()
      expect(mounts).toHaveLength(0)
    })
  })

  describe('buildEnvArgs', () => {
    it('should always include HOME', () => {
      const args = buildEnvArgs()
      expect(args).toContain('-e')
      expect(args).toContain(`HOME=${os.homedir()}`)
    })

    it('should pass through set environment variables', () => {
      process.env.AI_SUPPORT_AGENT_TOKEN = 'test-token'
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://test.api'
      process.env.ANTHROPIC_API_KEY = 'sk-test'

      const args = buildEnvArgs()
      expect(args).toContain('AI_SUPPORT_AGENT_TOKEN=test-token')
      expect(args).toContain('AI_SUPPORT_AGENT_API_URL=http://test.api')
      expect(args).toContain('ANTHROPIC_API_KEY=sk-test')
    })

    it('should resolve AI_SUPPORT_AGENT_CONFIG_DIR to absolute path', () => {
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = './relative/path'
      mockGetConfigDir.mockReturnValue('/resolved/absolute/path')

      const args = buildEnvArgs()
      expect(args).toContain('AI_SUPPORT_AGENT_CONFIG_DIR=/resolved/absolute/path')
      expect(args).not.toContain('AI_SUPPORT_AGENT_CONFIG_DIR=./relative/path')
    })

    it('should skip unset environment variables', () => {
      delete process.env.AI_SUPPORT_AGENT_TOKEN
      delete process.env.AI_SUPPORT_AGENT_API_URL
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR

      const args = buildEnvArgs()
      // Only HOME should be present
      expect(args).toEqual(['-e', `HOME=${os.homedir()}`])
    })
  })

  describe('buildContainerArgs', () => {
    it('should include start command', () => {
      const args = buildContainerArgs({})
      expect(args[0]).toBe('start')
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

    it('should not include --docker flag', () => {
      const args = buildContainerArgs({ verbose: true })
      expect(args).not.toContain('--docker')
    })

    it('should omit undefined options', () => {
      const args = buildContainerArgs({})
      expect(args).toEqual(['start'])
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

  describe('ensureImage', () => {
    it('should build image when it does not exist', () => {
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd)
        if (cmdStr.startsWith('docker image inspect')) throw new Error('No such image')
        return Buffer.from('')
      })

      ensureImage()

      const buildCall = mockExecSync.mock.calls.find(
        call => String(call[0]).startsWith('docker build'),
      )
      expect(buildCall).toBeDefined()
    })

    it('should skip build when image exists', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

      ensureImage()

      const buildCall = mockExecSync.mock.calls.find(
        call => String(call[0]).startsWith('docker build'),
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
      expect(output).toContain('ai-support-agent start --docker')
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
      mockExecSync.mockImplementation(() => { throw new Error('not found') })

      runInDocker({})

      expect(logger.error).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)
    })

    it('should build image when it does not exist', () => {
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd)
        if (cmdStr === 'docker info') return Buffer.from('')
        if (cmdStr.startsWith('docker image inspect')) {
          throw new Error('No such image')
        }
        if (cmdStr.startsWith('docker build')) return Buffer.from('')
        return Buffer.from('')
      })

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      // Should have called docker build
      const buildCall = mockExecSync.mock.calls.find(
        call => String(call[0]).startsWith('docker build'),
      )
      expect(buildCall).toBeDefined()
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--rm', '-it']),
        { stdio: 'inherit' },
      )
    })

    it('should use existing image when available', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

      const fakeChild = Object.assign(new EventEmitter(), {
        kill: jest.fn(),
      })
      mockSpawn.mockReturnValue(fakeChild as never)
      mockLoadConfig.mockReturnValue(null)

      runInDocker({})

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.imageFound'))
      // Should NOT have called docker build
      const buildCall = mockExecSync.mock.calls.find(
        call => String(call[0]).startsWith('docker build'),
      )
      expect(buildCall).toBeUndefined()
    })

    it('should exit with container exit code on close', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

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
      mockExecSync.mockReturnValue(Buffer.from(''))

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
      mockExecSync.mockReturnValue(Buffer.from(''))

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
      mockExecSync.mockReturnValue(Buffer.from(''))

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
      mockExecSync.mockReturnValue(Buffer.from(''))

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

    it('should pass container args to docker run', () => {
      mockExecSync.mockReturnValue(Buffer.from(''))

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
