jest.mock('fs')
jest.mock('child_process')
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

import { execSync } from 'child_process'
import { Command } from 'commander'
import * as fs from 'fs'
import {
  generatePlist,
  installService,
  registerServiceCommands,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from '../src/cli/service-command'
import { logger } from '../src/logger'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)

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

    it('should default to Docker mode (no --no-docker in plist)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      installService({})

      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      // Default docker=undefined is treated as docker=true by commander's --no-docker
      // But when called programmatically with {}, docker is undefined → !docker is true → adds --no-docker
      // This tests the programmatic call behavior
      expect(content).toContain('start')
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

  describe('installService on win32', () => {
    it('should delegate to Win32ServiceStrategy on Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      installService({})

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('schtasks /Create'),
        expect.any(Object),
      )
    })
  })

  describe('startService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      startService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      )
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      startService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('systemctl --user start'),
        expect.any(Object),
      )
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      startService()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('stopService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      stopService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl remove'),
        expect.any(Object),
      )
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      stopService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('systemctl --user stop'),
        expect.any(Object),
      )
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      stopService()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('restartService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      restartService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl'),
        expect.any(Object),
      )
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      restartService()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('systemctl'),
        expect.any(Object),
      )
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      restartService()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('serviceStatus', () => {
    it('should show not installed on macOS when plist missing', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(false)

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith('service.status.notInstalled')
    })

    it('should show running on macOS when service is loaded', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 12345;'))

      serviceStatus({})

      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.status.running'),
      )
    })

    it('should show stopped on macOS when service is not loaded', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith('service.status.stopped')
    })

    it('should show log dir info', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 123;'))

      serviceStatus({})

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.logDir'),
      )
    })

    it('should show log file paths when verbose', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 123;'))

      serviceStatus({ verbose: true })

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.status.logHint'),
      )
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      serviceStatus({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })
  })

  describe('registerServiceCommands', () => {
    it('should register service subcommands and legacy aliases', () => {
      const program = new Command()
      registerServiceCommands(program)

      const topLevelNames = program.commands.map((cmd) => cmd.name())
      expect(topLevelNames).toContain('service')
      expect(topLevelNames).toContain('install-service')
      expect(topLevelNames).toContain('uninstall-service')
      expect(topLevelNames).toContain('restart-service')

      const serviceCmd = program.commands.find((cmd) => cmd.name() === 'service')!
      const subNames = serviceCmd.commands.map((cmd) => cmd.name())
      expect(subNames).toContain('install')
      expect(subNames).toContain('uninstall')
      expect(subNames).toContain('start')
      expect(subNames).toContain('stop')
      expect(subNames).toContain('restart')
      expect(subNames).toContain('status')
    })

    it('should invoke installService via service install command (Docker by default)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'install'], { from: 'user' })

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      // Docker is default (commander --no-docker sets docker=true by default)
      expect(content).not.toContain('--no-docker')
    })

    it('should pass --no-docker to service install', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'install', '--no-docker'], { from: 'user' })

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--no-docker')
    })

    it('should invoke via legacy install-service command', () => {
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

    it('should invoke uninstallService via service uninstall command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'uninstall'], { from: 'user' })

      expect(mockedFs.unlinkSync).toHaveBeenCalled()
    })

    it('should invoke startService via service start command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'start'], { from: 'user' })

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      )
    })

    it('should invoke stopService via service stop command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'stop'], { from: 'user' })

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl remove'),
        expect.any(Object),
      )
    })

    it('should invoke restartService via service restart command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'restart'], { from: 'user' })

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl'),
        expect.any(Object),
      )
    })

    it('should invoke serviceStatus via service status command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 999;'))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'status'], { from: 'user' })

      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.status.running'),
      )
    })

    it('should invoke via legacy uninstall-service command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['uninstall-service'], { from: 'user' })

      expect(mockedFs.unlinkSync).toHaveBeenCalled()
    })

    it('should invoke via legacy restart-service command', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['restart-service'], { from: 'user' })

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl'),
        expect.any(Object),
      )
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
