jest.mock('fs')
jest.mock('../src/logger')
jest.mock('../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{{${k}}}`, String(v))
      }
      return result
    }
    return key
  },
}))

import { Command } from 'commander'
import * as fs from 'fs'
import {
  generatePlist,
  installService,
  registerServiceCommands,
  uninstallService,
} from '../src/cli/service-command'
import { logger } from '../src/logger'

const mockedFs = jest.mocked(fs)

describe('service-command orchestrator', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  describe('installService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      installService({})

      // Darwin strategy writes a plist file
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('LaunchAgents')
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)

      installService({})

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('systemd')
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      installService({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('uninstallService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      uninstallService()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('com.ai-support-agent.cli.plist'),
      )
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)

      uninstallService()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('ai-support-agent.service'),
      )
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      uninstallService()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('registerServiceCommands', () => {
    it('should register install-service and uninstall-service commands', () => {
      const program = new Command()
      registerServiceCommands(program)

      const commands = program.commands.map((cmd) => cmd.name())
      expect(commands).toContain('install-service')
      expect(commands).toContain('uninstall-service')
    })

    it('should invoke installService via install-service command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['install-service', '--verbose'], { from: 'user' })

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--verbose')
    })

    it('should invoke uninstallService via uninstall-service command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['uninstall-service'], { from: 'user' })

      expect(mockedFs.unlinkSync).toHaveBeenCalled()
    })
  })

  describe('generatePlist re-export', () => {
    it('should re-export generatePlist from darwin-service', () => {
      expect(typeof generatePlist).toBe('function')

      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
      })

      expect(result).toContain('<?xml version="1.0"')
      expect(result).toContain('com.ai-support-agent.cli')
    })
  })
})
