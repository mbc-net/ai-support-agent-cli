import * as os from 'os'
import * as path from 'path'

jest.mock('fs')
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

import * as fs from 'fs'
import {
  DarwinServiceStrategy,
  generatePlist,
} from '../../../src/cli/service/darwin-service'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)

describe('generatePlist', () => {
  it('should generate valid plist XML', () => {
    const result = generatePlist({
      nodePath: '/usr/local/bin/node',
      entryPoint: '/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js',
      logDir: '/Users/test/Library/Logs/ai-support-agent',
    })

    expect(result).toContain('<?xml version="1.0"')
    expect(result).toContain('<string>com.ai-support-agent.cli</string>')
    expect(result).toContain('<string>/usr/local/bin/node</string>')
    expect(result).toContain('<string>/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js</string>')
    expect(result).toContain('<string>start</string>')
    expect(result).toContain('<string>--no-docker</string>')
    expect(result).toContain('<key>RunAtLoad</key>')
    expect(result).toContain('<key>KeepAlive</key>')
    expect(result).toContain('agent.out.log')
    expect(result).toContain('agent.err.log')
    expect(result).not.toContain('--verbose')
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generatePlist({
      nodePath: '/usr/local/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      verbose: true,
    })

    expect(result).toContain('<string>--verbose</string>')
  })

  it('should escape XML special characters', () => {
    const result = generatePlist({
      nodePath: '/path/with <special> & "chars"',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('&lt;special&gt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&quot;chars&quot;')
  })

  it('should include PATH and HOME environment variables', () => {
    const result = generatePlist({
      nodePath: '/usr/local/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('<key>PATH</key>')
    expect(result).toContain('/usr/local/bin')
    expect(result).toContain('/opt/homebrew/bin')
    expect(result).toContain('<key>HOME</key>')
    expect(result).toContain(os.homedir())
  })
})

describe('DarwinServiceStrategy', () => {
  const strategy = new DarwinServiceStrategy()

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

    it('should create plist file', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(true)  // LaunchAgents dir
        .mockReturnValueOnce(false) // plist does not exist (no overwrite warning)

      strategy.install({})

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath, content] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('LaunchAgents')
      expect(writtenPath).toContain('com.ai-support-agent.cli.plist')
      expect(content).toContain('com.ai-support-agent.cli')
      expect(logger.success).toHaveBeenCalled()
    })

    it('should create log directory if it does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(false) // log dir
        .mockReturnValueOnce(true)  // LaunchAgents dir

      strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Library', 'Logs', 'ai-support-agent'),
        { recursive: true },
      )
    })

    it('should create LaunchAgents directory if it does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(false) // LaunchAgents dir

      strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Library', 'LaunchAgents'),
        { recursive: true },
      )
    })

    it('should pass verbose option to plist generation', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({ verbose: true })

      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--verbose')
    })

    it('should log info when overwriting existing plist', () => {
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
    it('should warn if plist does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.uninstall()

      expect(logger.warn).toHaveBeenCalledWith('service.notInstalled')
    })

    it('should delete plist file when it exists', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.plist'),
      )
      expect(logger.success).toHaveBeenCalled()
    })

    it('should show unload hint before deleting plist', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      const infoCallOrder = (logger.info as jest.Mock).mock.invocationCallOrder[0]
      const unlinkCallOrder = (mockedFs.unlinkSync as jest.Mock).mock.invocationCallOrder[0]
      expect(infoCallOrder).toBeLessThan(unlinkCallOrder!)
    })
  })
})
