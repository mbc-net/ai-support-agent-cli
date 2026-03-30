import { Command } from 'commander'

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}))
jest.mock('../../src/docker/dockerfile-path')
jest.mock('../../src/config-manager')
jest.mock('../../src/logger')
jest.mock('../../src/utils/unified-diff')

import * as fs from 'fs'
import { getDockerfilePath, getConfigDockerfilePath } from '../../src/docker/dockerfile-path'
import { loadConfig } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { computeUnifiedDiff } from '../../src/utils/unified-diff'
import { registerDockerCommands } from '../../src/commands/docker-commands'
import type { AgentConfig } from '../../src/types'

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
  })

  describe('registerDockerCommands', () => {
    it('should register docker-diff-dockerfile command on program', () => {
      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('docker-diff-dockerfile')
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
