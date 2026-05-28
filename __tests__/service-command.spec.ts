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

jest.mock('../src/config-manager', () => ({
  loadConfig: jest.fn(),
  getProjectList: jest.fn(),
}))

jest.mock('../src/docker/docker-runner', () => ({
  ensureImage: jest.fn().mockReturnValue('0.1.0'),
}))

import { execSync } from 'child_process'
import { Command } from 'commander'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  generatePlist,
  installService,
  installAndStartProject,
  registerServiceCommands,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from '../src/cli/service-command'
import { loadConfig, getProjectList } from '../src/config-manager'
import { logger } from '../src/logger'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)
const mockedLoadConfig = jest.mocked(loadConfig)
const mockedGetProjectList = jest.mocked(getProjectList)

const mockProjects = [
  { tenantCode: 'mbc', projectCode: 'MBC_01', token: 'token-01', apiUrl: 'https://api.example.com' },
]
const mockProjectPlists = [
  {
    label: 'com.ai-support-agent.cli.mbc.mbc-01',
    plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.mbc.mbc-01.plist'),
  },
]

describe('service-command orchestrator', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    jest.clearAllMocks()
    // Default: per-project mode with one project
    mockedLoadConfig.mockReturnValue({ projects: {} } as ReturnType<typeof loadConfig>)
    mockedGetProjectList.mockReturnValue(mockProjects)
    // readdirSync returns per-project plists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'com.ai-support-agent.cli.mbc.mbc-01.plist',
    ] as any)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  describe('installService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      await installService({})

      // per-project mode: update-and-restart.sh + wrapper script + plist = 3 writes
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(3)
      const plistCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => String(call[0]).endsWith('.plist'),
      )
      expect(plistCall?.[0]).toContain('LaunchAgents')
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)

      installService({})

      // per-project mode: update-and-restart.sh + wrapper + unit = 3 writes
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(3)
      const unitCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => String(call[0]).endsWith('.service'),
      )
      expect(unitCall?.[0]).toContain('systemd')
    })

    it('should reject unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      installService({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unsupportedPlatform'),
      )
    })

    it('should default to Docker mode (no --no-docker in plist)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      await installService({})

      // wrapper script should contain docker run
      const wrapperCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => String(call[0]).endsWith('run.sh'),
      )
      expect(wrapperCall?.[1]).toContain('docker run')
    })
  })

  describe('uninstallService', () => {
    it('should delegate to DarwinServiceStrategy on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      uninstallService()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('com.ai-support-agent.cli.mbc.mbc-01.plist'),
      )
    })

    it('should delegate to LinuxServiceStrategy on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
      ] as any)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      uninstallService()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('ai-support-agent-mbc-mbc-01.service'),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
      ] as any)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
      ] as any)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
      ] as any)
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
    it('should show not installed on macOS when no plists found', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith('service.status.notInstalled')
    })

    it('should show noProjects message on macOS when projects array is empty', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      // readdirSync returns one plist but launchctl list will throw (not running) — we need
      // to simulate status() returning projects=[] by having readdirSync return empty here
      // while installed=true. Achieve by keeping one plist but making status return empty projects.
      // Easiest: override readdirSync so getAllProjectPlists returns [] but status.installed is true.
      // DarwinServiceStrategy.status() returns installed:false when no plists, so we can't get
      // projects=[] via the normal flow. Test the serviceStatus() branch directly via a mock:
      // Instead, verify that the noProjects key is used when status.projects exists but is empty.
      // We'll test via the real DarwinServiceStrategy with a single plist but no PID — that gives
      // projects=[{running:false}], not empty. So we test the empty case via a spy on strategy.status.
      const { DarwinServiceStrategy } = require('../src/cli/service/darwin-service')
      const spy = jest.spyOn(DarwinServiceStrategy.prototype, 'status').mockReturnValue({
        installed: true,
        running: false,
        projects: [],
        logDir: '/tmp/logs',
      })

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith('service.status.noProjects')
      spy.mockRestore()
    })

    it('should show per-project running status on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 12345;'))

      serviceStatus({})

      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.status.projectRunning'),
      )
    })

    it('should show per-project stopped status on macOS when not loaded', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.status.projectStopped'),
      )
    })

    it('should show log dir info', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 123;'))

      serviceStatus({})

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.logDir'),
      )
    })

    it('should show log file paths when verbose', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 123;'))

      serviceStatus({ verbose: true })

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.status.logHint'),
      )
    })

    it('should show aggregate running status on Win32 when service is running', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const { Win32ServiceStrategy } = require('../src/cli/service/win32-service')
      const spy = jest.spyOn(Win32ServiceStrategy.prototype, 'status').mockReturnValue({
        installed: true,
        running: true,
        pid: 42,
        logDir: '/tmp/logs',
      })

      serviceStatus({})

      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.status.running'),
      )
      spy.mockRestore()
    })

    it('should show aggregate stopped status on Win32 when service is stopped', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const { Win32ServiceStrategy } = require('../src/cli/service/win32-service')
      const spy = jest.spyOn(Win32ServiceStrategy.prototype, 'status').mockReturnValue({
        installed: true,
        running: false,
        logDir: '/tmp/logs',
      })

      serviceStatus({})

      expect(logger.warn).toHaveBeenCalledWith('service.status.stopped')
      spy.mockRestore()
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

    it('should invoke installService via service install command (Docker by default)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      await program.parseAsync(['service', 'install'], { from: 'user' })

      // per-project mode: update-and-restart.sh + wrapper + plist = 3 writes
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(3)
      // wrapper script should use docker run (Docker mode by default)
      const wrapperCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => String(call[0]).endsWith('run.sh'),
      )
      expect(wrapperCall?.[1]).toContain('docker run')
    })

    it('should pass --no-docker to service install', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      await program.parseAsync(['service', 'install', '--no-docker'], { from: 'user' })

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(3)
    })

    it('should invoke via legacy install-service command', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(true)

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      await program.parseAsync(['install-service', '--verbose'], { from: 'user' })

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(3)
      const wrapperCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => String(call[0]).endsWith('run.sh'),
      )
      expect(wrapperCall?.[1]).toContain('--verbose')
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
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 999;'))

      const program = new Command()
      program.exitOverride()
      registerServiceCommands(program)

      program.parse(['service', 'status'], { from: 'user' })

      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.status.projectRunning'),
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

  describe('installAndStartProject', () => {
    const project = {
      tenantCode: '00000005',
      projectCode: 'SMART_QUOTE',
      token: '00000005:uuid:secret',
      apiUrl: 'https://api.ai-support-agent.com',
    }

    it('should write service files and call launchctl load on macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.mkdirSync.mockReturnValue(undefined)
      mockedFs.writeFileSync.mockReturnValue(undefined)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      installAndStartProject(project)

      const loadCall = (mockedExecSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('launchctl load'),
      )
      expect(loadCall).toBeDefined()
    })

    it('should write service files and call systemctl start on Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.mkdirSync.mockReturnValue(undefined)
      mockedFs.writeFileSync.mockReturnValue(undefined)
      mockedExecSync.mockReturnValue(Buffer.from('active'))

      installAndStartProject(project)

      const startCall = (mockedExecSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('systemctl --user start'),
      )
      expect(startCall).toBeDefined()
      expect(startCall![0]).toContain('ai-support-agent-00000005-smart-quote.service')
    })

    it('should log autoStartNotSupported notice on unsupported platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'freebsd' })

      installAndStartProject(project)

      expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      expect(mockedExecSync).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.autoStartNotSupported'),
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
