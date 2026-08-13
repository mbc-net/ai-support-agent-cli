import { Command } from 'commander'

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}))
jest.mock('../../src/docker/dockerfile-path')
jest.mock('../../src/config-manager')
jest.mock('../../src/logger')
jest.mock('../../src/utils/unified-diff')

// Mock docker-runner for docker-build command
jest.mock('../../src/docker/docker-runner', () => ({
  buildImage: jest.fn(),
  ensureImage: jest.fn(),
  syncDockerfileToConfigDir: jest.fn(),
  hasUnmanagedConfigDockerfile: jest.fn(() => false),
}))

// Mock constants
jest.mock('../../src/constants', () => ({
  AGENT_VERSION: '1.0.0',
  CLI_FLAG_NO_IMAGE_PULL: '--no-image-pull',
}))

import * as fs from 'fs'
import { getDockerfilePath, getConfigDockerfilePath } from '../../src/docker/dockerfile-path'
import { loadConfig } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { computeUnifiedDiff } from '../../src/utils/unified-diff'
import { registerDockerCommands } from '../../src/commands/docker-commands'
import {
  buildImage,
  ensureImage,
  hasUnmanagedConfigDockerfile,
  syncDockerfileToConfigDir,
} from '../../src/docker/docker-runner'
import type { AgentConfig } from '../../src/types'

const mockBuildImage = buildImage as jest.MockedFunction<typeof buildImage>
const mockEnsureImage = ensureImage as jest.MockedFunction<typeof ensureImage>
const mockSyncDockerfile = syncDockerfileToConfigDir as jest.MockedFunction<typeof syncDockerfileToConfigDir>
const mockHasUnmanagedDockerfile = hasUnmanagedConfigDockerfile as jest.MockedFunction<typeof hasUnmanagedConfigDockerfile>

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>
const mockGetDockerfilePath = getDockerfilePath as jest.MockedFunction<typeof getDockerfilePath>
const mockGetConfigDockerfilePath = getConfigDockerfilePath as jest.MockedFunction<typeof getConfigDockerfilePath>
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockComputeUnifiedDiff = computeUnifiedDiff as jest.MockedFunction<typeof computeUnifiedDiff>

describe('commands/docker-commands', () => {
  let program: Command

  beforeEach(() => {
    jest.clearAllMocks()
    program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    registerDockerCommands(program)
    mockGetDockerfilePath.mockReturnValue('/bundled/docker/Dockerfile')
    mockGetConfigDockerfilePath.mockReturnValue('/config/Dockerfile')
    mockLoadConfig.mockReturnValue(null)
    mockHasUnmanagedDockerfile.mockReturnValue(false)
  })

  describe('registerDockerCommands', () => {
    it('should register docker-diff-dockerfile command on program', () => {
      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('docker-diff-dockerfile')
    })

    it('should register docker-build command on program', () => {
      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('docker-build')
    })

    it('should register docker-ensure-image command on program', () => {
      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('docker-ensure-image')
    })
  })

  describe('docker-build', () => {
    it('should call buildImage with AGENT_VERSION and no dockerfile', async () => {
      await program.parseAsync(['node', 'test', 'docker-build'])

      expect(mockBuildImage).toHaveBeenCalledWith('1.0.0', undefined)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.building'))
      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('docker.buildComplete'))
    })

    it('should resolve custom dockerfile path and pass to buildImage', async () => {
      await program.parseAsync(['node', 'test', 'docker-build', '--dockerfile', '/custom/Dockerfile'])

      expect(mockBuildImage).toHaveBeenCalledWith('1.0.0', '/custom/Dockerfile')
    })
  })

  describe('docker-ensure-image', () => {
    it('should pull-or-build via ensureImage with pulling allowed by default', async () => {
      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockEnsureImage).toHaveBeenCalledWith(undefined, true)
      // docker-build stays a forced build; this command must not call it.
      expect(mockBuildImage).not.toHaveBeenCalled()
    })

    it('should resolve a custom dockerfile path and pass it to ensureImage', async () => {
      await program.parseAsync(['node', 'test', 'docker-ensure-image', '--dockerfile', '/custom/Dockerfile'])

      expect(mockEnsureImage).toHaveBeenCalledWith('/custom/Dockerfile', true)
    })

    it('should use config.dockerfilePath when no flag is given', async () => {
      mockLoadConfig.mockReturnValue({ dockerfilePath: '/config/custom/Dockerfile' } as AgentConfig)

      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockEnsureImage).toHaveBeenCalledWith('/config/custom/Dockerfile', true)
    })

    it('should disable pulling with --no-image-pull', async () => {
      await program.parseAsync(['node', 'test', 'docker-ensure-image', '--no-image-pull'])

      expect(mockEnsureImage).toHaveBeenCalledWith(undefined, false)
    })

    it('should sync the bundled Dockerfile before deciding, so a stale config-dir copy is not read as a customisation', async () => {
      // REGRESSION guard: the service wrappers run the container directly and
      // never reach runInDocker, so this command is the only place that can
      // refresh the config-dir copy. Without the sync, every CLI update leaves
      // a stale copy behind and the agent builds locally forever.
      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockSyncDockerfile).toHaveBeenCalled()
      expect(mockSyncDockerfile.mock.invocationCallOrder[0]).toBeLessThan(
        mockEnsureImage.mock.invocationCallOrder[0],
      )
    })

    it('should not sync over a hand-placed Dockerfile that has no sync hash', async () => {
      // The sync treats a missing hash file as a first run and overwrites the
      // Dockerfile unconditionally, which would destroy the user's file the
      // first time this command runs on a service-installed host.
      mockHasUnmanagedDockerfile.mockReturnValue(true)

      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockSyncDockerfile).not.toHaveBeenCalled()
      // The image is still ensured — ensureImage() sees the untouched file as
      // customised and builds from it.
      expect(mockEnsureImage).toHaveBeenCalled()
    })

    it('should honour dockerfileSync: false and skip the sync', async () => {
      mockLoadConfig.mockReturnValue({ dockerfileSync: false } as AgentConfig)

      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockSyncDockerfile).not.toHaveBeenCalled()
      expect(mockEnsureImage).toHaveBeenCalled()
    })

    it('should disable pulling when config.dockerImagePull is "never"', async () => {
      mockLoadConfig.mockReturnValue({ dockerImagePull: 'never' } as AgentConfig)

      await program.parseAsync(['node', 'test', 'docker-ensure-image'])

      expect(mockEnsureImage).toHaveBeenCalledWith(undefined, false)
    })
  })

  describe('docker-diff-dockerfile', () => {
    describe('target resolution', () => {
      it('should use argument path when provided', () => {
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue('content' as any)
        mockComputeUnifiedDiff.mockReturnValue('')

        program.parse(['node', 'test', 'docker-diff-dockerfile', '/custom/Dockerfile'])

        expect(mockExistsSync).toHaveBeenCalledWith('/custom/Dockerfile')
      })

      it('should resolve relative argument path to absolute', () => {
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue('content' as any)
        mockComputeUnifiedDiff.mockReturnValue('')

        program.parse(['node', 'test', 'docker-diff-dockerfile', 'relative/Dockerfile'])

        // path.resolve should have made it absolute
        const existsCall = mockExistsSync.mock.calls.find(([p]) => (p as string).includes('relative'))
        expect(existsCall?.[0]).toMatch(/^\//)
      })

      it('should use config.dockerfilePath when no argument given', () => {
        const config: AgentConfig = {
          agentId: 'a',
          createdAt: '2024-01-01',
          dockerfilePath: '/config-path/Dockerfile',
        }
        mockLoadConfig.mockReturnValue(config)
        mockExistsSync.mockReturnValue(true)
        mockReadFileSync.mockReturnValue('content' as any)
        mockComputeUnifiedDiff.mockReturnValue('')

        program.parse(['node', 'test', 'docker-diff-dockerfile'])

        expect(mockExistsSync).toHaveBeenCalledWith(expect.stringContaining('config-path'))
      })

      it('should use configDir Dockerfile when no argument and no config.dockerfilePath', () => {
        mockLoadConfig.mockReturnValue(null)
        mockExistsSync.mockImplementation((p) => p === '/config/Dockerfile')
        mockReadFileSync.mockReturnValue('content' as any)
        mockComputeUnifiedDiff.mockReturnValue('')

        program.parse(['node', 'test', 'docker-diff-dockerfile'])

        expect(mockExistsSync).toHaveBeenCalledWith('/config/Dockerfile')
      })

      it('should error when no target can be resolved', () => {
        mockLoadConfig.mockReturnValue(null)
        mockExistsSync.mockReturnValue(false) // configDir Dockerfile does not exist

        program.parse(['node', 'test', 'docker-diff-dockerfile'])

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('docker.diffNoTarget'))
      })

      it('should error when resolved target file does not exist', () => {
        mockExistsSync.mockReturnValue(false)

        program.parse(['node', 'test', 'docker-diff-dockerfile', '/missing/Dockerfile'])

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('docker.diffTargetNotFound'))
      })
    })

    describe('diff output', () => {
      it('should report identical when files have the same content', () => {
        mockExistsSync.mockReturnValue(true)
        // Both readFileSync calls return the same string → defaultContent === targetContent
        mockReadFileSync
          .mockReturnValueOnce('same content' as any)
          .mockReturnValueOnce('same content' as any)

        program.parse(['node', 'test', 'docker-diff-dockerfile', '/custom/Dockerfile'])

        expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('docker.diffIdentical'))
      })

      it('should print diff and log diffDone when files differ', () => {
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
        mockExistsSync.mockReturnValue(true)
        // First call: getDockerfilePath() reads bundled; second call: reads target
        mockReadFileSync
          .mockReturnValueOnce('bundled content' as any)
          .mockReturnValueOnce('custom content' as any)
        // computeUnifiedDiff is mocked and returns the diff string above
        mockComputeUnifiedDiff.mockReturnValue('--- bundled\n+++ custom\n@@ -1 +1 @@\n-bundled\n+custom')

        program.parse(['node', 'test', 'docker-diff-dockerfile', '/custom/Dockerfile'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('---'))
        // i18n mock returns the key string
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.diffDone'))
        consoleSpy.mockRestore()
      })

      it('should error when bundled Dockerfile cannot be read', () => {
        mockExistsSync.mockReturnValue(true)
        mockGetDockerfilePath.mockImplementation(() => {
          throw new Error('File not found')
        })

        program.parse(['node', 'test', 'docker-diff-dockerfile', '/custom/Dockerfile'])

        // i18n mock returns the key string
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('docker.diffDefaultError'))
      })
    })
  })
})
