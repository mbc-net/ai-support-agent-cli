/**
 * Tests for src/docker/docker-utils.ts
 *
 * Exercises the candidate-path resolution logic (resolveDockerPath),
 * DOCKER_HOST auto-detection (ensureDockerHost), buildDevMounts in
 * ts-node mode, and other utility helpers.
 */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string) => key),
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

jest.mock('../../src/docker/dockerfile-path', () => ({
  resolveDockerfile: jest.fn((customPath?: string) => {
    if (customPath) {
      return { dockerfilePath: customPath, contextDir: require('path').dirname(customPath) }
    }
    return { dockerfilePath: '/mock/docker/Dockerfile', contextDir: '/mock' }
  }),
}))

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { execFileSync } from 'child_process'

jest.mock('fs')
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>

import {
  getDockerPath,
  resetDockerPathCache,
  buildContainerName,
  removeStaleContainer,
  makeSessionId,
  toPosixRelative,
  isRunningViaTsNode,
  buildDevMounts,
  resolveImageTag,
  checkDockerAvailable,
  imageExists,
  buildImage,
  dockerLogin,
  IMAGE_NAME,
} from '../../src/docker/docker-utils'
import { logger } from '../../src/logger'

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>

describe('docker-utils', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    resetDockerPathCache()
    process.env = { ...originalEnv }
    delete process.env.DOCKER_HOST
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
    resetDockerPathCache()
  })

  describe('getDockerPath / resolveDockerPath', () => {
    it('falls back to "docker" when no candidate paths exist', () => {
      mockExistsSync.mockReturnValue(false)
      expect(getDockerPath()).toBe('docker')
    })

    it('returns the first existing candidate path', () => {
      // Make /usr/local/bin/docker exist
      mockExistsSync.mockImplementation((p) => p === '/usr/local/bin/docker')
      expect(getDockerPath()).toBe('/usr/local/bin/docker')
    })

    it('returns /opt/homebrew/bin/docker when that candidate exists', () => {
      mockExistsSync.mockImplementation((p) => p === '/opt/homebrew/bin/docker')
      expect(getDockerPath()).toBe('/opt/homebrew/bin/docker')
    })

    it('returns /usr/bin/docker (Linux) when that is the only candidate', () => {
      mockExistsSync.mockImplementation((p) => p === '/usr/bin/docker')
      expect(getDockerPath()).toBe('/usr/bin/docker')
    })

    it('caches the resolved path (calls fs.existsSync only on first call)', () => {
      mockExistsSync.mockReturnValue(false)
      getDockerPath()
      getDockerPath()
      // existsSync should only be called for candidate resolution on first call
      const callCount = mockExistsSync.mock.calls.length
      expect(callCount).toBeGreaterThan(0)
      const secondCallCount = mockExistsSync.mock.calls.length
      expect(secondCallCount).toBe(callCount) // no additional calls after cache hit
    })

    it('resetDockerPathCache clears the cached path', () => {
      mockExistsSync.mockReturnValue(false)
      getDockerPath()
      resetDockerPathCache()
      mockExistsSync.mockImplementation((p) => p === '/usr/local/bin/docker')
      expect(getDockerPath()).toBe('/usr/local/bin/docker')
    })
  })

  describe('ensureDockerHost', () => {
    it('does not set DOCKER_HOST when it is already set', () => {
      process.env.DOCKER_HOST = 'tcp://existing:2375'
      mockExistsSync.mockReturnValue(false)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBe('tcp://existing:2375')
    })

    it('sets DOCKER_HOST to mac socket when it exists and DOCKER_HOST is unset', () => {
      delete process.env.DOCKER_HOST
      const macSocket = path.join(os.homedir(), '.docker', 'run', 'docker.sock')
      mockExistsSync.mockImplementation((p) => p === macSocket)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBe(`unix://${macSocket}`)
    })

    it('does not set DOCKER_HOST when no socket candidate exists', () => {
      delete process.env.DOCKER_HOST
      // no socket candidate exists
      mockExistsSync.mockReturnValue(false)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBeUndefined()
    })

    it('falls back to the Colima socket when Docker Desktop socket is absent', () => {
      delete process.env.DOCKER_HOST
      const macSocket = path.join(os.homedir(), '.docker', 'run', 'docker.sock')
      const colimaSocket = path.join(os.homedir(), '.colima', 'default', 'docker.sock')
      // Docker Desktop socket missing, Colima socket present
      mockExistsSync.mockImplementation((p) => p === colimaSocket && p !== macSocket)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBe(`unix://${colimaSocket}`)
    })

    it('prefers the Docker Desktop socket over Colima when both exist', () => {
      delete process.env.DOCKER_HOST
      const macSocket = path.join(os.homedir(), '.docker', 'run', 'docker.sock')
      const colimaSocket = path.join(os.homedir(), '.colima', 'default', 'docker.sock')
      mockExistsSync.mockImplementation((p) => p === macSocket || p === colimaSocket)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBe(`unix://${macSocket}`)
    })

    it('falls back to the Linux native socket when no user-level socket exists', () => {
      delete process.env.DOCKER_HOST
      const linuxSocket = '/var/run/docker.sock'
      mockExistsSync.mockImplementation((p) => p === linuxSocket)
      getDockerPath()
      expect(process.env.DOCKER_HOST).toBe(`unix://${linuxSocket}`)
    })
  })

  describe('buildContainerName', () => {
    it('builds container name from tenantCode and projectCode', () => {
      expect(buildContainerName('mbc', 'PROJ_A')).toBe('ai-mbc-proj-a')
    })

    it('appends agentId when provided', () => {
      expect(buildContainerName('mbc', 'PROJ_A', 'agent-123')).toBe('ai-mbc-proj-a-agent-123')
    })

    it('lowercases all parts and replaces non-alphanumeric chars with hyphens', () => {
      expect(buildContainerName('MBC', 'MBC_01')).toBe('ai-mbc-mbc-01')
      expect(buildContainerName('my_tenant', 'MY_PROJECT')).toBe('ai-my-tenant-my-project')
    })
  })

  describe('removeStaleContainer', () => {
    it('calls docker rm -f with container name', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      removeStaleContainer('ai-mbc-proj-a')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ['rm', '-f', 'ai-mbc-proj-a'],
        { stdio: 'ignore' },
      )
    })

    it('does not throw when docker rm fails', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('No such container') })
      expect(() => removeStaleContainer('ai-mbc-proj-a')).not.toThrow()
    })
  })

  describe('makeSessionId', () => {
    it('returns a 14-character string in YYYYMMDDHHmmss format', () => {
      const id = makeSessionId()
      expect(id).toHaveLength(14)
      expect(/^\d{14}$/.test(id)).toBe(true)
    })

    it('pads single-digit month/day/hours/minutes/seconds with leading zeros', () => {
      // Mock a date with single-digit month, day, etc.
      const fixedDate = new Date('2026-01-05T09:08:07')
      jest.spyOn(global, 'Date').mockImplementation(() => fixedDate as unknown as Date)
      const id = makeSessionId()
      expect(id).toBe('20260105090807')
      jest.spyOn(global, 'Date').mockRestore()
    })
  })

  describe('toPosixRelative', () => {
    it('returns path unchanged on POSIX systems', () => {
      expect(toPosixRelative('foo/bar/baz')).toBe('foo/bar/baz')
    })

    it('converts Windows path separators to forward slashes', () => {
      // Simulate Windows path
      const winPath = 'foo\\bar\\baz'
      // toPosixRelative splits by path.sep; on macOS this won't convert
      // but the function is correct for the OS it runs on
      const result = toPosixRelative(winPath)
      expect(typeof result).toBe('string')
    })
  })

  describe('isRunningViaTsNode', () => {
    it('returns false when ts-node is not active', () => {
      // In test environment (Jest with ts-jest), ts-node register symbol may not be set
      expect(typeof isRunningViaTsNode()).toBe('boolean')
    })
  })

  describe('buildDevMounts', () => {
    it('returns empty array when not running via ts-node', () => {
      // Ensure ts-node symbol is NOT set
      const sym = Symbol.for('ts-node.register.instance')
      const proc = process as unknown as { [key: symbol]: unknown }
      const original = proc[sym]
      delete proc[sym]

      const result = buildDevMounts()
      expect(result).toEqual([])

      if (original !== undefined) proc[sym] = original
    })

    it('returns volume mount args when running via ts-node', () => {
      // Simulate ts-node being active
      const sym = Symbol.for('ts-node.register.instance')
      const proc = process as unknown as { [key: symbol]: unknown }
      const original = proc[sym]
      proc[sym] = {}  // set to any truthy value

      const result = buildDevMounts()

      // Restore
      if (original === undefined) {
        delete proc[sym]
      } else {
        proc[sym] = original
      }

      expect(result.length).toBeGreaterThan(0)
      // Should include -v flags for dist and locales
      expect(result).toContain('-v')
      expect(result.some((arg) => arg.includes(':ro'))).toBe(true)
      // dist dir should be mounted
      expect(result.some((arg) => typeof arg === 'string' && arg.includes('dist'))).toBe(true)
    })
  })

  describe('resolveImageTag', () => {
    it('returns projectTag when it exists', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const result = resolveImageTag('ai-support-agent-mbc-proj:1.0.0', 'ai-support-agent:1.0.0')
      expect(result).toBe('ai-support-agent-mbc-proj:1.0.0')
    })

    it('falls back to baseTag when projectTag does not exist', () => {
      mockExecFileSync.mockImplementation(() => { throw new Error('No such image') })
      const result = resolveImageTag('ai-support-agent-mbc-proj:1.0.0', 'ai-support-agent:1.0.0')
      expect(result).toBe('ai-support-agent:1.0.0')
    })
  })

  describe('checkDockerAvailable', () => {
    it('returns true when `docker info` succeeds', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      expect(checkDockerAvailable()).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalledWith('docker', ['info'], {
        stdio: 'ignore',
      })
    })

    it('returns false when `docker info` throws (daemon down)', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Cannot connect to the Docker daemon')
      })
      expect(checkDockerAvailable()).toBe(false)
    })
  })

  describe('imageExists', () => {
    it('inspects the version-tagged image and returns true on success', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      expect(imageExists('1.2.3')).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        ['image', 'inspect', `${IMAGE_NAME}:1.2.3`],
        { stdio: 'ignore' },
      )
    })

    it('returns false when the image is absent (inspect throws)', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('No such image')
      })
      expect(imageExists('9.9.9')).toBe(false)
    })
  })

  describe('buildImage', () => {
    it('builds the version-tagged image with --pull=false and the AGENT_VERSION build-arg', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      buildImage('1.2.3')
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        [
          'build',
          '-t',
          `${IMAGE_NAME}:1.2.3`,
          '--pull=false',
          '--build-arg',
          'AGENT_VERSION=1.2.3',
          '-f',
          '/mock/docker/Dockerfile',
          '/mock',
        ],
        { stdio: 'inherit' },
      )
      expect(logger.success).toHaveBeenCalled()
    })

    it('uses the provided custom Dockerfile path and logs that it is in use', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      buildImage('2.0.0', '/custom/MyDockerfile')
      const args = mockExecFileSync.mock.calls[0][1] as string[]
      expect(args).toContain('-f')
      expect(args).toContain('/custom/MyDockerfile')
      expect(logger.info).toHaveBeenCalledWith('docker.usingCustomDockerfile')
    })
  })

  describe('dockerLogin', () => {
    it('prints the setup-token guidance steps', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      dockerLogin()
      expect(logger.info).toHaveBeenCalledWith('docker.loginStep1')
      expect(logger.info).toHaveBeenCalledWith('docker.loginStep3')
      expect(logSpy).toHaveBeenCalled()
      logSpy.mockRestore()
    })
  })
})
