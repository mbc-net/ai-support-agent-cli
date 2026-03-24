import * as os from 'os'
import * as path from 'path'

jest.mock('fs')
jest.mock('child_process')
jest.mock('../../../src/logger')
jest.mock('../../../src/i18n', () => ({
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
import * as fs from 'fs'
import {
  LinuxServiceStrategy,
  generateServiceUnit,
} from '../../../src/cli/service/linux-service'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)

describe('generateServiceUnit', () => {
  it('should generate valid systemd unit file', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/usr/lib/node_modules/@ai-support-agent/cli/dist/index.js',
      logDir: '/home/user/.local/share/ai-support-agent/logs',
    })

    expect(result).toContain('[Unit]')
    expect(result).toContain('Description=AI Support Agent')
    expect(result).toContain('After=network-online.target')
    expect(result).toContain('[Service]')
    expect(result).toContain('Type=simple')
    expect(result).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@ai-support-agent/cli/dist/index.js start --no-docker')
    expect(result).toContain('Restart=always')
    expect(result).toContain('RestartSec=10')
    expect(result).toContain(`Environment=HOME=${os.homedir()}`)
    expect(result).toContain('StandardOutput=append:/home/user/.local/share/ai-support-agent/logs/agent.out.log')
    expect(result).toContain('StandardError=append:/home/user/.local/share/ai-support-agent/logs/agent.err.log')
    expect(result).toContain('[Install]')
    expect(result).toContain('WantedBy=default.target')
    expect(result).not.toContain('--verbose')
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      verbose: true,
    })

    expect(result).toContain('--verbose')
  })

  it('should not include --no-docker when docker is true', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      docker: true,
    })

    expect(result).not.toContain('--no-docker')
  })

  it('should quote paths containing spaces in ExecStart', () => {
    const result = generateServiceUnit({
      nodePath: '/opt/my programs/node',
      entryPoint: '/home/user/my app/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('ExecStart="/opt/my programs/node" "/home/user/my app/index.js" start --no-docker')
  })

  it('should include PATH environment variable', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin')
  })
})

describe('LinuxServiceStrategy', () => {
  const strategy = new LinuxServiceStrategy()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('install', () => {
    it('should reject if entry point does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.entryPointNotFound'),
      )
    })

    it('should create systemd service file', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(true)  // systemd dir
        .mockReturnValueOnce(false) // service file does not exist

      strategy.install({})

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath, content] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('.config/systemd/user/ai-support-agent.service')
      expect(content).toContain('[Unit]')
      expect(content).toContain('ExecStart=')
      expect(logger.success).toHaveBeenCalled()
    })

    it('should create log directory if it does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(false) // log dir
        .mockReturnValueOnce(true)  // systemd dir

      strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), '.local', 'share', 'ai-support-agent', 'logs'),
        { recursive: true },
      )
    })

    it('should create systemd user directory if it does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(false) // systemd dir

      strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), '.config', 'systemd', 'user'),
        { recursive: true },
      )
    })

    it('should pass verbose option to unit generation', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({ verbose: true })

      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--verbose')
    })

    it('should log info when overwriting existing service file', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({})

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.overwriting'),
      )
    })

    it('should log no-log-rotation notice', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({})

      expect(logger.info).toHaveBeenCalledWith('service.noLogRotation')
    })
  })

  describe('uninstall', () => {
    it('should warn if service file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.uninstall()

      expect(logger.warn).toHaveBeenCalledWith('service.notInstalled.linux')
    })

    it('should delete service file when it exists', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        path.join(os.homedir(), '.config', 'systemd', 'user', 'ai-support-agent.service'),
      )
      expect(logger.success).toHaveBeenCalled()
    })

    it('should show unload hint before deleting service file', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      const infoCallOrder = (logger.info as jest.Mock).mock.invocationCallOrder[0]
      const unlinkCallOrder = (mockedFs.unlinkSync as jest.Mock).mock.invocationCallOrder[0]
      expect(infoCallOrder).toBeLessThan(unlinkCallOrder!)
    })
  })

  describe('restart', () => {
    it('should error if service file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.linux')
      expect(mockedExecSync).not.toHaveBeenCalled()
    })

    it('should daemon-reload and restart the service', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.restart()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user daemon-reload',
        { stdio: 'pipe' },
      )
      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user restart ai-support-agent',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should log error if restart fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('systemctl failed') })

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })
  })
})
