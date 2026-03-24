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
  DarwinServiceStrategy,
  generatePlist,
} from '../../../src/cli/service/darwin-service'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)

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

  it('should not include --no-docker when docker is true', () => {
    const result = generatePlist({
      nodePath: '/usr/local/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      docker: true,
    })

    expect(result).not.toContain('--no-docker')
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

  it('should include CLAUDE_CODE_OAUTH_TOKEN when set in environment', () => {
    const originalEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
        docker: true,
      })

      expect(result).toContain('<key>CLAUDE_CODE_OAUTH_TOKEN</key>')
      expect(result).toContain('<string>test-oauth-token</string>')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnv
      }
    }
  })

  it('should include ANTHROPIC_API_KEY when set in environment', () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
      })

      expect(result).toContain('<key>ANTHROPIC_API_KEY</key>')
      expect(result).toContain('<string>sk-ant-test-key</string>')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv
      }
    }
  })

  it('should include AI_SUPPORT_AGENT_TOKEN and AI_SUPPORT_AGENT_API_URL when set', () => {
    const origToken = process.env.AI_SUPPORT_AGENT_TOKEN
    const origUrl = process.env.AI_SUPPORT_AGENT_API_URL
    try {
      process.env.AI_SUPPORT_AGENT_TOKEN = 'mbc:test:token'
      process.env.AI_SUPPORT_AGENT_API_URL = 'https://api.example.com'
      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
      })

      expect(result).toContain('<key>AI_SUPPORT_AGENT_TOKEN</key>')
      expect(result).toContain('<string>mbc:test:token</string>')
      expect(result).toContain('<key>AI_SUPPORT_AGENT_API_URL</key>')
      expect(result).toContain('<string>https://api.example.com</string>')
    } finally {
      if (origToken === undefined) delete process.env.AI_SUPPORT_AGENT_TOKEN
      else process.env.AI_SUPPORT_AGENT_TOKEN = origToken
      if (origUrl === undefined) delete process.env.AI_SUPPORT_AGENT_API_URL
      else process.env.AI_SUPPORT_AGENT_API_URL = origUrl
    }
  })

  it('should not include env vars that are not set', () => {
    const origToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const origApiKey = process.env.ANTHROPIC_API_KEY
    const origAgentToken = process.env.AI_SUPPORT_AGENT_TOKEN
    const origAgentUrl = process.env.AI_SUPPORT_AGENT_API_URL
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.AI_SUPPORT_AGENT_TOKEN
      delete process.env.AI_SUPPORT_AGENT_API_URL
      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
      })

      expect(result).not.toContain('<key>CLAUDE_CODE_OAUTH_TOKEN</key>')
      expect(result).not.toContain('<key>ANTHROPIC_API_KEY</key>')
      expect(result).not.toContain('<key>AI_SUPPORT_AGENT_TOKEN</key>')
      expect(result).not.toContain('<key>AI_SUPPORT_AGENT_API_URL</key>')
    } finally {
      if (origToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = origToken
      if (origApiKey !== undefined) process.env.ANTHROPIC_API_KEY = origApiKey
      if (origAgentToken !== undefined) process.env.AI_SUPPORT_AGENT_TOKEN = origAgentToken
      if (origAgentUrl !== undefined) process.env.AI_SUPPORT_AGENT_API_URL = origAgentUrl
    }
  })

  it('should escape XML special characters in env var values', () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY
    try {
      process.env.ANTHROPIC_API_KEY = 'key-with-<special>&"chars"'
      const result = generatePlist({
        nodePath: '/usr/local/bin/node',
        entryPoint: '/path/to/index.js',
        logDir: '/tmp/logs',
      })

      expect(result).toContain('<key>ANTHROPIC_API_KEY</key>')
      expect(result).toContain('&lt;special&gt;')
      expect(result).toContain('&amp;')
      expect(result).toContain('&quot;chars&quot;')
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv
      }
    }
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

  describe('restart', () => {
    it('should error if plist does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
      expect(mockedExecSync).not.toHaveBeenCalled()
    })

    it('should remove and reload the service', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.restart()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'launchctl remove com.ai-support-agent.cli',
        { stdio: 'pipe' },
      )
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should succeed even if remove fails (service not loaded)', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error('not loaded') })
        .mockReturnValueOnce(Buffer.from(''))

      strategy.restart()

      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should log error if load fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // remove succeeds
        .mockImplementationOnce(() => { throw new Error('load failed') })

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })
  })
})
