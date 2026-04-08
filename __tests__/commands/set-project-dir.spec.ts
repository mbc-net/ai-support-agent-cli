import { Command } from 'commander'

import { loadConfig, setDefaultProjectDir, setProjectDir } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { ensureProjectDirs, resolveProjectDir } from '../../src/project-dir'
import { registerSetProjectDirCommand } from '../../src/commands/set-project-dir'
import type { AgentConfig } from '../../src/types'

jest.mock('../../src/config-manager')
jest.mock('../../src/logger')
jest.mock('../../src/project-dir')

const mockedLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockedSetProjectDir = setProjectDir as jest.MockedFunction<typeof setProjectDir>
const mockedSetDefaultProjectDir = setDefaultProjectDir as jest.MockedFunction<typeof setDefaultProjectDir>
const mockedEnsureProjectDirs = ensureProjectDirs as jest.MockedFunction<typeof ensureProjectDirs>
const mockedResolveProjectDir = resolveProjectDir as jest.MockedFunction<typeof resolveProjectDir>

describe('commands/set-project-dir', () => {
  let program: Command

  beforeEach(() => {
    jest.clearAllMocks()
    program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    registerSetProjectDirCommand(program)
  })

  describe('registerSetProjectDirCommand', () => {
    it('should register set-project-dir command on program', () => {
      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('set-project-dir')
    })
  })

  describe('no options provided', () => {
    it('should show usage hint when no options are given', () => {
      program.parse(['node', 'test', 'set-project-dir'])

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.usageHint'),
      )
    })
  })

  describe('--default option', () => {
    it('should call setDefaultProjectDir with the template', () => {
      program.parse(['node', 'test', 'set-project-dir', '--default', '~/my-projects/{projectCode}'])

      expect(mockedSetDefaultProjectDir).toHaveBeenCalledWith('~/my-projects/{projectCode}')
      expect(logger.success).toHaveBeenCalled()
    })
  })

  describe('--project and --path options', () => {
    const configWithProject: AgentConfig = {
      agentId: 'test-agent',
      createdAt: '2024-01-01',
      defaultProjectDir: '~/default/{projectCode}',
      projects: [
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 'token-1', apiUrl: 'http://api-1' },
        { tenantCode: 'mbc', projectCode: 'MBC_02', token: 'token-2', apiUrl: 'http://api-2' },
      ],
    }

    it('should set project directory and ensure dirs when project exists and setProjectDir succeeds', () => {
      mockedLoadConfig.mockReturnValue(configWithProject)
      mockedSetProjectDir.mockReturnValue(true)
      mockedResolveProjectDir.mockReturnValue('/home/user/custom-path')

      program.parse(['node', 'test', 'set-project-dir', '--project', 'MBC_01', '--path', '~/custom-path'])

      expect(mockedLoadConfig).toHaveBeenCalled()
      expect(mockedSetProjectDir).toHaveBeenCalledWith('MBC_01', '~/custom-path')
      expect(mockedResolveProjectDir).toHaveBeenCalledWith(
        { ...configWithProject.projects![0], projectDir: '~/custom-path' },
        configWithProject.defaultProjectDir,
      )
      expect(mockedEnsureProjectDirs).toHaveBeenCalledWith('/home/user/custom-path')
      expect(logger.success).toHaveBeenCalled()
    })

    it('should show error when project not found in config', () => {
      mockedLoadConfig.mockReturnValue(configWithProject)

      program.parse(['node', 'test', 'set-project-dir', '--project', 'NONEXISTENT', '--path', '~/some-path'])

      expect(mockedLoadConfig).toHaveBeenCalled()
      expect(mockedSetProjectDir).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.noProject'),
      )
    })

    it('should show error when config is null (no config file)', () => {
      mockedLoadConfig.mockReturnValue(null)

      program.parse(['node', 'test', 'set-project-dir', '--project', 'MBC_01', '--path', '~/some-path'])

      expect(mockedLoadConfig).toHaveBeenCalled()
      expect(mockedSetProjectDir).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.noProject'),
      )
    })

    it('should show error when setProjectDir returns false', () => {
      mockedLoadConfig.mockReturnValue(configWithProject)
      mockedSetProjectDir.mockReturnValue(false)

      program.parse(['node', 'test', 'set-project-dir', '--project', 'MBC_01', '--path', '~/custom-path'])

      expect(mockedSetProjectDir).toHaveBeenCalledWith('MBC_01', '~/custom-path')
      expect(mockedEnsureProjectDirs).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.noProject'),
      )
    })
  })

  describe('partial options', () => {
    it('should show usage hint when only --project is provided without --path', () => {
      program.parse(['node', 'test', 'set-project-dir', '--project', 'MBC_01'])

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.usageHint'),
      )
    })

    it('should show usage hint when only --path is provided without --project', () => {
      program.parse(['node', 'test', 'set-project-dir', '--path', '~/some-path'])

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('projectDir.usageHint'),
      )
    })
  })
})
