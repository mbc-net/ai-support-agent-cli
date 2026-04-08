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

// Mock config-manager
jest.mock('../../../src/config-manager', () => ({
  loadConfig: jest.fn(),
  getProjectList: jest.fn(),
}))

// Mock docker-runner (used by async install with projects)
jest.mock('../../../src/docker/docker-runner', () => ({
  ensureImage: jest.fn().mockReturnValue('0.1.0'),
}))

import { execSync } from 'child_process'
import * as fs from 'fs'
import {
  DarwinServiceStrategy,
  generatePlist,
  generateProjectPlist,
  generateWrapperScript,
  generateUpdateScript,
  getProjectLabel,
  getProjectPlistPath,
  getAllProjectPlists,
} from '../../../src/cli/service/darwin-service'
import { logger } from '../../../src/logger'
import { loadConfig, getProjectList } from '../../../src/config-manager'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)
const mockedLoadConfig = jest.mocked(loadConfig)
const mockedGetProjectList = jest.mocked(getProjectList)

// Default: no projects registered → legacy mode
beforeEach(() => {
  jest.clearAllMocks()
  mockedLoadConfig.mockReturnValue(null)
  mockedGetProjectList.mockReturnValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedFs.readdirSync.mockReturnValue([] as any)
})

// ---------------------------------------------------------------------------
// generatePlist
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// generateProjectPlist
// ---------------------------------------------------------------------------
describe('generateProjectPlist', () => {
  it('should generate valid per-project plist with KeepAlive.SuccessfulExit=false', () => {
    const result = generateProjectPlist({
      label: 'com.ai-support-agent.cli.mbc.mbc-01',
      wrapperScriptPath: '/Users/test/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/Users/test/Library/Logs/ai-support-agent/mbc-mbc-01',
    })

    expect(result).toContain('<?xml version="1.0"')
    expect(result).toContain('<string>com.ai-support-agent.cli.mbc.mbc-01</string>')
    expect(result).toContain('<string>/bin/bash</string>')
    expect(result).toContain('/Users/test/.ai-support-agent/services/mbc-mbc-01/run.sh')
    expect(result).toContain('<key>KeepAlive</key>')
    expect(result).toContain('<key>SuccessfulExit</key>')
    expect(result).toContain('<false/>')
    expect(result).toContain('agent.out.log')
    expect(result).toContain('agent.err.log')
    // Should NOT have <true/> as KeepAlive value
    expect(result).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })

  it('should include PATH and HOME in environment variables', () => {
    const result = generateProjectPlist({
      label: 'com.ai-support-agent.cli.mbc.mbc-01',
      wrapperScriptPath: '/tmp/run.sh',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('<key>PATH</key>')
    expect(result).toContain('/usr/local/bin')
    expect(result).toContain('<key>HOME</key>')
    expect(result).toContain(os.homedir())
  })
})

// ---------------------------------------------------------------------------
// generateWrapperScript
// ---------------------------------------------------------------------------
describe('generateWrapperScript', () => {
  const baseOpts = {
    imageTag: 'ai-support-agent:0.1.0',
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    projectConfigHostDir: '/Users/test/.ai-support-agent/projects/mbc/MBC_01/.ai-support-agent',
    token: 'test-token',
    apiUrl: 'https://api.example.com',
    updateScriptPath: '/Users/test/.ai-support-agent/update-and-restart.sh',
  }

  it('should generate a bash script with docker run', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('#!/bin/bash')
    expect(result).toContain('docker run --rm -i')
    expect(result).toContain('ai-support-agent:0.1.0')
    expect(result).toContain('ai-support-agent start --no-docker')
    expect(result).toContain('--project mbc/MBC_01')
  })

  it('should convert localhost to host.docker.internal in apiUrl', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://localhost:4030' })

    expect(result).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:4030')
    expect(result).not.toContain('localhost')
  })

  it('should convert localhost without port to host.docker.internal', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://localhost' })

    expect(result).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal')
    expect(result).not.toContain('localhost')
  })

  it('should convert 127.0.0.1 to host.docker.internal in apiUrl', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://127.0.0.1:4030' })

    expect(result).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:4030')
    expect(result).not.toContain('127.0.0.1')
  })

  it('should not convert non-localhost URLs', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'https://api.example.com' })

    expect(result).toContain('AI_SUPPORT_AGENT_API_URL=https://api.example.com')
  })

  it('should handle exit 42 by delegating to update script', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('EXIT_CODE=$?')
    expect(result).toContain('if [ "$EXIT_CODE" -eq 42 ]; then')
    expect(result).toContain('exec "/Users/test/.ai-support-agent/update-and-restart.sh"')
  })

  it('should include rebuild marker check for exit 43', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('REBUILD_MARKER=')
    expect(result).toContain('docker-rebuild-needed')
    expect(result).toContain('ai-support-agent docker-build')
  })

  it('should include ANTHROPIC_API_KEY when provided', () => {
    const result = generateWrapperScript({ ...baseOpts, anthropicApiKey: 'sk-ant-test' })

    expect(result).toContain('-e ANTHROPIC_API_KEY=sk-ant-test')
  })

  it('should include CLAUDE_CODE_OAUTH_TOKEN when provided', () => {
    const result = generateWrapperScript({ ...baseOpts, claudeCodeOauthToken: 'oauth-token' })

    expect(result).toContain('-e CLAUDE_CODE_OAUTH_TOKEN=oauth-token')
  })

  it('should not include optional env vars when not provided', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).not.toContain('ANTHROPIC_API_KEY')
    expect(result).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generateWrapperScript({ ...baseOpts, verbose: true })

    expect(result).toContain('--verbose')
  })

  it('should include project volume mount when projectDir is provided', () => {
    const result = generateWrapperScript({ ...baseOpts, projectDir: '/Users/test/projects/mbc01' })

    expect(result).toContain('/Users/test/projects/mbc01')
    expect(result).toContain('/workspace/projects/MBC_01')
  })

  it('should mount project config dir', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('/Users/test/.ai-support-agent/projects/mbc/MBC_01/.ai-support-agent:/home/node/.ai-support-agent:rw')
  })
})

// ---------------------------------------------------------------------------
// generateUpdateScript
// ---------------------------------------------------------------------------
describe('generateUpdateScript', () => {
  it('should generate a bash script that unloads/reloads plists', () => {
    const result = generateUpdateScript()

    expect(result).toContain('#!/bin/bash')
    expect(result).toContain('launchctl unload')
    expect(result).toContain('launchctl load')
    expect(result).toContain('com.ai-support-agent.cli.*.plist')
  })

  it('should install new version from update-version.json', () => {
    const result = generateUpdateScript()

    expect(result).toContain('update-version.json')
    expect(result).toContain('npm install -g')
    expect(result).toContain('@ai-support-agent/cli@')
    expect(result).toContain('ai-support-agent service install')
  })

  it('should exit 0', () => {
    const result = generateUpdateScript()

    expect(result).toContain('exit 0')
  })

  it('should use AI_SUPPORT_AGENT_CONFIG_DIR when set', () => {
    const originalConfigDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    try {
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/custom/config-dir'
      const result = generateUpdateScript()

      expect(result).toContain('/custom/config-dir')
    } finally {
      if (originalConfigDir === undefined) delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
      else process.env.AI_SUPPORT_AGENT_CONFIG_DIR = originalConfigDir
    }
  })
})

// ---------------------------------------------------------------------------
// getProjectLabel / getProjectPlistPath
// ---------------------------------------------------------------------------
describe('getProjectLabel', () => {
  it('should generate label from tenantCode and projectCode', () => {
    expect(getProjectLabel('mbc', 'MBC_01')).toBe('com.ai-support-agent.cli.mbc.mbc-01')
  })

  it('should sanitize special characters', () => {
    expect(getProjectLabel('my_tenant', 'MY.PROJECT')).toBe('com.ai-support-agent.cli.my-tenant.my-project')
  })

  it('should lowercase the codes', () => {
    expect(getProjectLabel('MBC', 'TEST')).toBe('com.ai-support-agent.cli.mbc.test')
  })
})

describe('getProjectPlistPath', () => {
  it('should return plist path under LaunchAgents', () => {
    const result = getProjectPlistPath('mbc', 'MBC_01')
    expect(result).toBe(
      path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.mbc.mbc-01.plist'),
    )
  })
})

// ---------------------------------------------------------------------------
// getAllProjectPlists
// ---------------------------------------------------------------------------
describe('getAllProjectPlists', () => {
  it('should return empty array when LaunchAgents dir read fails', () => {
    mockedFs.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })

    const result = getAllProjectPlists()

    expect(result).toEqual([])
  })

  it('should return per-project plists (excluding legacy plist)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'com.ai-support-agent.cli.plist',         // legacy — should be excluded
      'com.ai-support-agent.cli.mbc.mbc-01.plist',
      'com.ai-support-agent.cli.mbc.mbc-02.plist',
      'other-service.plist',                     // unrelated — should be excluded
    ] as any)

    const result = getAllProjectPlists()

    expect(result).toHaveLength(2)
    expect(result[0].label).toBe('com.ai-support-agent.cli.mbc.mbc-01')
    expect(result[1].label).toBe('com.ai-support-agent.cli.mbc.mbc-02')
  })

  it('should return empty array when no per-project plists exist', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'com.ai-support-agent.cli.plist',
    ] as any)

    const result = getAllProjectPlists()

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DarwinServiceStrategy — legacy mode (no registered projects)
// ---------------------------------------------------------------------------
describe('DarwinServiceStrategy — legacy mode', () => {
  const strategy = new DarwinServiceStrategy()

  beforeEach(() => {
    // Default: no projects → legacy mode
    mockedLoadConfig.mockReturnValue(null)
    mockedGetProjectList.mockReturnValue([])
    // readdirSync returns no per-project plists by default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([] as any)
  })

  describe('install', () => {
    it('should reject if entry point does not exist', async () => {
      mockedFs.existsSync.mockReturnValue(false)

      await strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.entryPointNotFound'),
      )
    })

    it('should create plist file', async () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(true)  // LaunchAgents dir
        .mockReturnValueOnce(false) // plist does not exist (no overwrite warning)

      await strategy.install({})

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath, content] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('LaunchAgents')
      expect(writtenPath).toContain('com.ai-support-agent.cli.plist')
      expect(content).toContain('com.ai-support-agent.cli')
      expect(logger.success).toHaveBeenCalled()
    })

    it('should create log directory if it does not exist', async () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(false) // log dir
        .mockReturnValueOnce(true)  // LaunchAgents dir

      await strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Library', 'Logs', 'ai-support-agent'),
        { recursive: true },
      )
    })

    it('should create LaunchAgents directory if it does not exist', async () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(false) // LaunchAgents dir

      await strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Library', 'LaunchAgents'),
        { recursive: true },
      )
    })

    it('should pass verbose option to plist generation', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({ verbose: true })

      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--verbose')
    })

    it('should log info when overwriting existing plist', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({})

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.overwriting'),
      )
    })

    it('should log no-log-rotation notice', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({})

      expect(logger.info).toHaveBeenCalledWith('service.noLogRotation')
    })
  })

  describe('uninstall', () => {
    it('should warn if no plist exists', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.uninstall()

      expect(logger.warn).toHaveBeenCalledWith('service.notInstalled')
    })

    it('should delete legacy plist file when it exists', () => {
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

  describe('start', () => {
    it('should error if no plist exists', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
      expect(mockedExecSync).not.toHaveBeenCalled()
    })

    it('should load the service', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.start()

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('should log error if load fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('load failed') })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
    })

    it('should handle non-Error throw from start', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw 'string start error' })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
    })
  })

  describe('stop', () => {
    it('should error if no plist exists', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
      expect(mockedExecSync).not.toHaveBeenCalled()
    })

    it('should remove the service', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.stop()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'launchctl remove com.ai-support-agent.cli',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.stopped')
    })

    it('should log error if remove fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('remove failed') })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
    })

    it('should handle non-Error throw from stop', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw 'string stop error' })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
    })
  })

  describe('restart', () => {
    it('should error if no plist exists', () => {
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

  describe('status', () => {
    it('should return not installed when plist does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      const result = strategy.status()

      expect(result).toEqual({ installed: false, running: false })
    })

    it('should return running with PID when service is loaded', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"PID" = 12345;'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.pid).toBe(12345)
      expect(result.logDir).toBeTruthy()
    })

    it('should return installed but not running when launchctl list fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
      expect(result.logDir).toBeTruthy()
    })

    it('should return installed but not running when PID is not in output', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from('"Label" = "com.ai-support-agent.cli";'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// DarwinServiceStrategy — multi-project mode (projects registered)
// ---------------------------------------------------------------------------
describe('DarwinServiceStrategy — multi-project mode', () => {
  const strategy = new DarwinServiceStrategy()

  const mockProjects = [
    {
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
      token: 'token-01',
      apiUrl: 'https://api.example.com',
      projectDir: '/Users/test/projects/mbc01',
    },
    {
      tenantCode: 'mbc',
      projectCode: 'MBC_02',
      token: 'token-02',
      apiUrl: 'https://api.example.com',
    },
  ]

  const mockProjectPlists = [
    {
      label: 'com.ai-support-agent.cli.mbc.mbc-01',
      plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.mbc.mbc-01.plist'),
    },
    {
      label: 'com.ai-support-agent.cli.mbc.mbc-02',
      plistPath: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.mbc.mbc-02.plist'),
    },
  ]

  beforeEach(() => {
    mockedLoadConfig.mockReturnValue({ projects: {} } as ReturnType<typeof loadConfig>)
    mockedGetProjectList.mockReturnValue(mockProjects)
    // readdirSync returns per-project plists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'com.ai-support-agent.cli.mbc.mbc-01.plist',
      'com.ai-support-agent.cli.mbc.mbc-02.plist',
    ] as any)
  })

  describe('install', () => {
    it('should create per-project plists and wrapper scripts', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({})

      // update-and-restart.sh + 2 wrapper scripts + 2 plists = 5 writes
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(5)

      // Check that wrapper scripts were written
      const wrapperCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('run.sh'),
      )
      expect(wrapperCalls).toHaveLength(2)

      // Check that plists were written
      const plistCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.plist'),
      )
      expect(plistCalls).toHaveLength(2)
      expect(plistCalls[0][0]).toContain('com.ai-support-agent.cli.mbc.mbc-01.plist')
      expect(plistCalls[1][0]).toContain('com.ai-support-agent.cli.mbc.mbc-02.plist')
    })

    it('should log success for each project', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({})

      expect(logger.success).toHaveBeenCalledTimes(2)
    })

    it('should log multi hint and log rotation notice', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      await strategy.install({})

      expect(logger.info).toHaveBeenCalledWith('service.loadHintMulti')
      expect(logger.info).toHaveBeenCalledWith('service.noLogRotation')
    })

    it('should warn about legacy plist if present', async () => {
      mockedFs.existsSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith('com.ai-support-agent.cli.plist')) return true
        return true
      })

      await strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.legacyPlistFound'),
      )
    })

    it('should create missing directories', async () => {
      mockedFs.existsSync.mockReturnValue(false)

      await strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalled()
    })

    it('should use AI_SUPPORT_AGENT_CONFIG_DIR when set', async () => {
      const originalConfigDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
      try {
        process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/custom/config-dir'
        mockedFs.existsSync.mockReturnValue(true)

        await strategy.install({})

        // The wrapper script should reference the custom config dir
        const wrapperCalls = mockedFs.writeFileSync.mock.calls.filter(
          (call) => String(call[0]).endsWith('run.sh'),
        )
        expect(wrapperCalls[0][1]).toContain('/custom/config-dir')
      } finally {
        if (originalConfigDir === undefined) delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
        else process.env.AI_SUPPORT_AGENT_CONFIG_DIR = originalConfigDir
      }
    })
  })

  describe('uninstall', () => {
    it('should delete all per-project plists', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      for (const { plistPath } of mockProjectPlists) {
        expect(mockedFs.unlinkSync).toHaveBeenCalledWith(plistPath)
      }
      expect(logger.success).toHaveBeenCalledWith('service.uninstalled')
    })

    it('should also delete legacy plist if present', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      const legacyPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.plist')
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(legacyPath)
    })
  })

  describe('start', () => {
    it('should load all per-project plists', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.start()

      for (const { plistPath } of mockProjectPlists) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl load ${plistPath}`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('should log error and not log success if any load fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))
        .mockImplementationOnce(() => { throw new Error('load failed') })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('should remove all per-project services', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.stop()

      for (const { label } of mockProjectPlists) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl remove ${label}`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.stopped')
    })

    it('should log error and not log success if any remove fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))
        .mockImplementationOnce(() => { throw new Error('remove failed') })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })
  })

  describe('restart', () => {
    it('should remove and reload all per-project services', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.restart()

      for (const { label, plistPath } of mockProjectPlists) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl remove ${label}`,
          { stdio: 'pipe' },
        )
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl load ${plistPath}`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should tolerate remove failure (service not loaded)', () => {
      mockedExecSync
        .mockImplementationOnce(() => { throw new Error('not loaded') }) // remove fails
        .mockReturnValue(Buffer.from(''))

      strategy.restart()

      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should log error if reload fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('')) // remove ok
        .mockImplementationOnce(() => { throw new Error('load failed') }) // load fails

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })
  })

  describe('status', () => {
    it('should return running=true when any project is running', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"PID" = 12345;'))
        .mockReturnValueOnce(Buffer.from('"Label" = "...";'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.pid).toBe(12345)
    })

    it('should return running=false when no project is running', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
    })

    it('should return logDir', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const result = strategy.status()

      expect(result.logDir).toBeTruthy()
      expect(result.logDir).toContain('ai-support-agent')
    })
  })
})
