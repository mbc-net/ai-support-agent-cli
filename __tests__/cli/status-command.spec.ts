import { Command } from 'commander'

import { loadConfig, getProjectList } from '../../src/config-manager'
import { logger } from '../../src/logger'
import { formatStatus, registerStatusCommand } from '../../src/cli/status-command'
import type { AgentConfig } from '../../src/types'

jest.mock('../../src/config-manager')
jest.mock('../../src/logger')

const mockedLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockedGetProjectList = getProjectList as jest.MockedFunction<typeof getProjectList>

describe('cli/status-command', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('formatStatus', () => {
    it('should format config with projects', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
        lastConnected: '2024-06-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'proj-a', token: 'abcdef', apiUrl: 'http://api-a' },
        ],
      }
      mockedGetProjectList.mockReturnValue(config.projects!)
      const output = formatStatus(config)
      expect(output).toContain('status.header')
      expect(output).toContain('status.agentId')
      expect(output).toContain('status.lastConnected')
      expect(output).toContain('proj-a')
      expect(output).toContain('status.apiUrl')
      expect(output).toContain('status.token')
      expect(output).toContain('status.projectCount')
    })

    it('should format config with no projects', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
      }
      mockedGetProjectList.mockReturnValue([])
      const output = formatStatus(config)
      expect(output).toContain('status.header')
      expect(output).toContain('status.noProjects')
    })

    it('should show auto-update disabled', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
        autoUpdate: { enabled: false, autoRestart: true, channel: 'latest' },
      }
      mockedGetProjectList.mockReturnValue([])
      const output = formatStatus(config)
      expect(output).toContain('status.autoUpdate')
      expect(output).not.toContain('status.updateChannel')
    })

    it('should show auto-update enabled with channel', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
        autoUpdate: { enabled: true, autoRestart: true, channel: 'beta' },
      }
      mockedGetProjectList.mockReturnValue([])
      const output = formatStatus(config)
      expect(output).toContain('status.autoUpdate')
      expect(output).toContain('status.updateChannel')
    })

    it('should include project code and status lines for short tokens', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'proj-a', token: 'ab', apiUrl: 'http://api-a' },
        ],
      }
      mockedGetProjectList.mockReturnValue(config.projects!)
      const output = formatStatus(config)
      expect(output).toContain('proj-a')
      expect(output).toContain('status.token')
    })

    it('should show autoRestart false in output', () => {
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
        autoUpdate: { enabled: true, autoRestart: false, channel: 'latest' },
      }
      mockedGetProjectList.mockReturnValue([])
      const output = formatStatus(config)
      expect(output).toContain('status.autoUpdate')
    })
  })

  describe('registerStatusCommand', () => {
    it('should register status command', () => {
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerStatusCommand(program)

      const commandNames = program.commands.map((cmd) => cmd.name())
      expect(commandNames).toContain('status')
    })

    it('should warn when no config exists', () => {
      mockedLoadConfig.mockReturnValue(null)

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerStatusCommand(program)
      program.parse(['node', 'test', 'status'])

      expect(logger.warn).toHaveBeenCalled()
    })

    it('should print status when config exists', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
      const config: AgentConfig = {
        agentId: 'test-agent',
        createdAt: '2024-01-01',
      }
      mockedLoadConfig.mockReturnValue(config)
      mockedGetProjectList.mockReturnValue([])

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerStatusCommand(program)
      program.parse(['node', 'test', 'status'])

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
