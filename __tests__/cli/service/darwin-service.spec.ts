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

import { execSync } from 'child_process'
import * as fs from 'fs'
import { IMAGE_NAME } from '../../../src/docker/docker-utils'
import {
  DarwinServiceStrategy,
  generatePlist,
  generateProjectPlist,
  generateWrapperScript,
  generateUpdateScript,
  getProjectLabel,
  getProjectPlistPath,
  getAllProjectPlists,
  writeProjectServiceFiles,
  installAndStartProject,
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
  it('should generate valid per-project plist with KeepAlive=true', () => {
    const result = generateProjectPlist({
      label: 'com.ai-support-agent.cli.mbc.mbc-01',
      wrapperScriptPath: '/Users/test/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/Users/test/Library/Logs/ai-support-agent/mbc-mbc-01',
    })

    expect(result).toContain('<?xml version="1.0"')
    expect(result).toContain('<string>com.ai-support-agent.cli.mbc.mbc-01</string>')
    expect(result).toContain('<string>/bin/bash</string>')
    expect(result).toContain('/Users/test/.ai-support-agent/services/mbc-mbc-01/run.sh')
    expect(result).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(result).not.toContain('<key>SuccessfulExit</key>')
    expect(result).toContain('agent.out.log')
    expect(result).toContain('agent.err.log')
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
    imageName: IMAGE_NAME,
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
    // image tag is resolved dynamically at runtime via npm root -g
    expect(result).toContain('IMAGE_TAG="ai-support-agent:')
    expect(result).toContain('"$IMAGE_TAG"')
    expect(result).toContain('npm root -g')
    expect(result).toContain('@ai-support-agent/cli/package.json')
    expect(result).toContain('ai-support-agent start --no-docker')
    expect(result).toContain('--project mbc/MBC_01')
  })

  it('should load nvm and set PATH for launchd compatibility', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('NVM_DIR')
    expect(result).toContain('nvm.sh')
    expect(result).toContain('/opt/homebrew/bin:/usr/local/bin')
  })

  it('should exit with error when version cannot be determined', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('if [ -z "$_INSTALLED_VERSION" ]')
    expect(result).toContain('Could not determine installed version')
    expect(result).toContain('exit 1')
    // must NOT use :- fallback to latest
    expect(result).not.toContain(':-latest')
  })

  it('should build CLI package.json path via separate variable (not inline $() concatenation)', () => {
    const result = generateWrapperScript(baseOpts)

    // _NPM_ROOT must be set first, then _CLI_PKG_JSON built from it
    expect(result).toContain('_NPM_ROOT=$(npm root -g')
    // eslint-disable-next-line no-template-curly-in-string
    expect(result).toContain('_CLI_PKG_JSON="${_NPM_ROOT}/@ai-support-agent/cli/package.json"')
    // must NOT concatenate string directly after $() — invalid shell syntax
    expect(result).not.toMatch(/\$\(npm root -g[^)]*\)\//)
  })

  it('should include container name derived from tenantCode and projectCode', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('--name "ai-mbc-mbc-01"')
    expect(result).toContain('docker rm -f "ai-mbc-mbc-01"')
  })

  it('should sanitize special characters in container name', () => {
    const result = generateWrapperScript({ ...baseOpts, tenantCode: 'my_tenant', projectCode: 'MY.PROJECT' })

    expect(result).toContain('--name "ai-my-tenant-my-project"')
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

  it('should auto-build Docker image when it does not exist locally', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('docker image inspect "$IMAGE_TAG"')
    expect(result).toContain('ai-support-agent docker-build || { echo "ERROR: docker-build failed')
    expect(result).toContain('exit 1; }')
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

  it('should mount the parent of projectConfigHostDir as the in-container project dir when projectDir is NOT provided', () => {
    // Regression for the double-nesting bug: same as the Linux wrapper.
    const result = generateWrapperScript(baseOpts)

    // New project-dir mount is shell-quoted (POSIX single quotes)
    expect(result).toContain("'/Users/test/.ai-support-agent/projects/mbc/MBC_01:/workspace/projects/MBC_01:rw'")
    // env value is shell-quoted to defend against shell metacharacters
    expect(result).toContain("AI_SUPPORT_AGENT_PROJECT_DIR_MAP='MBC_01=/workspace/projects/MBC_01'")
  })

  it('should shell-quote the new project-dir mount even when projectDir contains $', () => {
    // The legacy `"..."`-quoted mounts above expand $; the NEW project-dir
    // mount uses shellQuote so a host path with `$` is bind-mounted
    // literally instead of being shell-expanded at launchd start time.
    const result = generateWrapperScript({ ...baseOpts, projectDir: '/Users/test/$work/proj-a' })

    expect(result).toContain("-v '/Users/test/$work/proj-a:/workspace/projects/MBC_01:rw'")
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

  it('should load nvm and set PATH for launchd compatibility', () => {
    const result = generateUpdateScript()

    expect(result).toContain('NVM_DIR')
    expect(result).toContain('nvm.sh')
    expect(result).toContain('/opt/homebrew/bin:/usr/local/bin')
  })

  it('should record failure but still reload services when npm install fails', () => {
    const result = generateUpdateScript()

    expect(result).toContain('npm install -g')
    expect(result).toContain('_INSTALL_OK=false')
    // launchctl load must appear after the install block (services always reloaded)
    const installIdx = result.indexOf('_INSTALL_OK=false')
    const reloadIdx = result.indexOf('launchctl load')
    expect(reloadIdx).toBeGreaterThan(installIdx)
  })

  it('should capture npm install stderr instead of discarding it', () => {
    const result = generateUpdateScript()

    // Output is captured into NPM_OUTPUT and echoed on failure so the real
    // npm error reaches the agent log (after redaction).
    expect(result).toContain('NPM_OUTPUT=$(npm install -g')
    expect(result).toContain('"$NPM_OUTPUT" | redact_secrets')
    expect(result).not.toContain('npm install -g "@ai-support-agent/cli@$NEW_VERSION" --quiet 2>/dev/null || true')
  })

  it('should record failure but still reload services when service install fails', () => {
    const result = generateUpdateScript()

    expect(result).toContain('SI_OUTPUT=$(ai-support-agent service install')
    expect(result).toContain('"$SI_OUTPUT" | redact_secrets')
    expect(result).not.toContain('ai-support-agent service install 2>/dev/null || true')
    // exit 1 appears after launchctl load (services reloaded before failing)
    const reloadIdx = result.indexOf('launchctl load')
    const exitOneIdx = result.lastIndexOf('exit 1')
    expect(exitOneIdx).toBeGreaterThan(reloadIdx)
  })

  it('should retry launchd reload and verify each label was registered', () => {
    const result = generateUpdateScript()

    // reload_plist helper retries up to 3 times and verifies via launchctl list
    expect(result).toContain('reload_plist()')
    expect(result).toContain('for attempt in 1 2 3')
    expect(result).toContain('launchctl list "$label"')
    expect(result).toContain('_RELOAD_FAILED')
    // exit non-zero when any reload failed so the launchd "exit 1" surfaces
    expect(result).toContain('_RELOAD_FAILED" -gt 0')
  })

  it('should not unload plists inside the retry loop (would SIGTERM the running child)', () => {
    const result = generateUpdateScript()

    const reloadStart = result.indexOf('reload_plist()')
    expect(reloadStart).toBeGreaterThan(-1)
    // Find the end of the reload_plist function (next closing brace after for-loop body)
    const reloadBody = result.slice(reloadStart, result.indexOf('\n}\n', reloadStart) + 2)
    expect(reloadBody).not.toContain('launchctl unload')
  })

  it('should redact secrets from npm/service-install stderr before echoing', () => {
    const result = generateUpdateScript()

    expect(result).toContain('redact_secrets()')
    expect(result).toContain('Bearer ')
    expect(result).toContain('authToken')
    expect(result).toContain('X-Auth-Token')
    expect(result).toContain('| redact_secrets >&2')
    // Both npm and service-install outputs must pass through the redactor.
    expect(result).toContain('"$NPM_OUTPUT" | redact_secrets')
    expect(result).toContain('"$SI_OUTPUT" | redact_secrets')
  })

  it('should use UTC date for the log prefix to avoid macOS/GNU date drift', () => {
    const result = generateUpdateScript()

    expect(result).toContain("date -u '+%Y-%m-%dT%H:%M:%SZ'")
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
// DarwinServiceStrategy — no projects configured
// ---------------------------------------------------------------------------
describe('DarwinServiceStrategy — no projects configured', () => {
  const strategy = new DarwinServiceStrategy()

  beforeEach(() => {
    mockedLoadConfig.mockReturnValue(null)
    mockedGetProjectList.mockReturnValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([] as any)
  })

  it('install should log error when no projects configured', async () => {
    await strategy.install({})

    expect(logger.error).toHaveBeenCalledWith('service.noProjectsConfigured')
  })

  it('uninstall should warn when no plists found', () => {
    strategy.uninstall()

    expect(logger.warn).toHaveBeenCalledWith('service.notInstalled')
  })

  it('start should log error when not installed', () => {
    strategy.start()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('stop should log error when not installed', () => {
    strategy.stop()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('restart should log error when not installed', () => {
    strategy.restart()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('status should return not installed', () => {
    const result = strategy.status()

    expect(result).toEqual({ installed: false, running: false })
  })
})

// ---------------------------------------------------------------------------
// DarwinServiceStrategy — per-project mode (projects registered)
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

    it('should not abort the install loop when one project has an invalid projectCode', async () => {
      // Regression: same as the Linux test. One bad project must not stop
      // the rest from being installed.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_03', token: 't3', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectInstallFailed'),
      )
      const plistCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.plist'),
      )
      // Two valid projects, one plist each.
      expect(plistCalls).toHaveLength(2)
    })

    it('should refuse to install when two projects sanitize to the same plist label', async () => {
      // sanitize() inside getProjectLabel collapses `_` and `-` to `-`, so
      // `MBC_01` and `MBC-01` both produce 'com.ai-support-agent.cli.mbc.mbc-01'.
      // Without collision detection the second project's writeProjectServiceFiles
      // would silently overwrite the first's plist.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't2', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
      const plistCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.plist'),
      )
      expect(plistCalls).toHaveLength(0)
    })

    it('should log partialInstallSummary when at least one project fails via collision (darwin asymmetry fix)', async () => {
      // Regression: darwin install() used to swallow per-project failures
      // silently. A wrapping script could not tell that some projects
      // were refused — orphan-cleanup-skip on Linux communicated this,
      // but Darwin has no cleanup phase. Now both platforms emit the
      // same partialInstallSummary warning at the end.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't2', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('should log partialInstallSummary when at least one project fails via invalid code', async () => {
      // Coverage parity with the Linux throw-path test.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('should NOT log partialInstallSummary when all projects install successfully', async () => {
      // Negative case — sanity check that the warning is gated.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('should use projectDuplicateEntry message when the same tenant/project pair appears twice', async () => {
      // True literal duplicate. The collision helper deduplicates FQNs and
      // returns `others=[]`, which must route to the dedicated duplicate
      // key instead of the generic collision message rendering empty `()`.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectDuplicateEntry'),
      )
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
    })

    it('should suppress the start hint and log lines when ALL projects fail (no plists written)', async () => {
      // Z1 regression: if every project is refused, the post-loop info
      // hints (loadHintMulti, logDir, noLogRotation) used to fire and
      // tell the user to start services that do not exist. Skip them.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't1', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      expect(logger.info).not.toHaveBeenCalledWith('service.loadHintMulti')
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('service.logDir'),
      )
      expect(logger.info).not.toHaveBeenCalledWith('service.noLogRotation')
    })

    it('should report only ONE collision error per shared label even when listed many times', async () => {
      // Z5 regression: an N-times-listed entry used to emit N identical
      // error lines. The reportedCollisionLabels Set in install() now
      // deduplicates them.
      mockedFs.existsSync.mockReturnValue(true)
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't3', apiUrl: 'https://api' },
      ])

      await strategy.install({})

      const dupCalls = (logger.error as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string'
          && (call[0] as string).includes('service.projectDuplicateEntry'),
      )
      expect(dupCalls).toHaveLength(1)
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

    it('should only delete per-project plists (not legacy plist)', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.uninstall()

      const legacyPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-support-agent.cli.plist')
      expect(mockedFs.unlinkSync).not.toHaveBeenCalledWith(legacyPath)
    })
  })

  describe('start', () => {
    it('should load all per-project plists', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.start()

      for (const { plistPath } of mockProjectPlists) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl load "${plistPath}"`,
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
          `launchctl remove "${label}"`,
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
          `launchctl remove "${label}"`,
          { stdio: 'pipe' },
        )
        expect(mockedExecSync).toHaveBeenCalledWith(
          `launchctl load "${plistPath}"`,
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

    it('should return per-project status in projects array', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"PID" = 111;')) // mbc-01 running
        .mockReturnValueOnce(Buffer.from('"Label" = "...";')) // mbc-02 no PID

      const result = strategy.status()

      expect(result.projects).toHaveLength(2)
      expect(result.projects![0].running).toBe(true)
      expect(result.projects![0].pid).toBe(111)
      expect(result.projects![1].running).toBe(false)
      expect(result.projects![1].pid).toBeUndefined()
    })

    it('should return running=false when no project is running', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
      expect(result.projects?.every(p => !p.running)).toBe(true)
    })

    it('should return logDir', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const result = strategy.status()

      expect(result.logDir).toBeTruthy()
      expect(result.logDir).toContain('ai-support-agent')
    })
  })
})

// ---------------------------------------------------------------------------
// writeProjectServiceFiles
// ---------------------------------------------------------------------------
describe('writeProjectServiceFiles', () => {
  const project = {
    tenantCode: '00000005',
    projectCode: 'SMART_QUOTE',
    token: '00000005:uuid:secret',
    apiUrl: 'https://api.ai-support-agent.com',
  }

  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.writeFileSync.mockReturnValue(undefined)
  })

  it('should create service dirs, write run.sh and plist, return plist path', () => {
    const plistPath = writeProjectServiceFiles(project)

    expect(plistPath).toContain('com.ai-support-agent.cli.00000005.smart-quote.plist')
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('run.sh'),
      expect.any(String),
      expect.objectContaining({ mode: 0o700 }),
    )
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.plist'),
      expect.any(String),
      'utf-8',
    )
  })

  it('should embed the token and apiUrl in the wrapper script', () => {
    writeProjectServiceFiles(project)

    const runShCall = mockedFs.writeFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('run.sh'),
    )
    expect(runShCall).toBeDefined()
    const script = runShCall![1] as string
    expect(script).toContain(project.token)
    expect(script).toContain(project.apiUrl)
  })

  it('should reject projectCodes that would break PROJECT_DIR_MAP parsing', () => {
    // ';' is the multi-entry separator; '=' is the key/value separator.
    // Either one in the projectCode would silently truncate the env map.
    expect(() => writeProjectServiceFiles({ ...project, projectCode: 'A;B' })).toThrow(
      /service\.invalidProjectCode/,
    )
    expect(() => writeProjectServiceFiles({ ...project, projectCode: 'A=B' })).toThrow(
      /service\.invalidProjectCode/,
    )
  })

  it('should reject tenantCodes containing PROJECT_DIR_MAP separators', () => {
    expect(() => writeProjectServiceFiles({ ...project, tenantCode: 't;x' })).toThrow(
      /service\.invalidProjectCode/,
    )
  })

  it('should drop project.projectDir when the host path does not exist and fall back to default', () => {
    // existsSync mocked false (default) → validation drops projectDir → wrapper
    // falls back to default mount. Without this guard the wrapper would emit a
    // `-v <missing-path>:/workspace/projects/<code>:rw` line which docker
    // auto-creates as root-owned.
    writeProjectServiceFiles({ ...project, projectDir: '/nonexistent/path' })

    const runShCall = mockedFs.writeFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('run.sh'),
    )
    const script = runShCall![1] as string
    expect(script).not.toContain('/nonexistent/path')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('service.projectDirMissing'),
    )
  })
})

// ---------------------------------------------------------------------------
// installAndStartProject
// ---------------------------------------------------------------------------
describe('installAndStartProject', () => {
  const project = {
    tenantCode: '00000005',
    projectCode: 'SMART_QUOTE',
    token: '00000005:uuid:secret',
    apiUrl: 'https://api.ai-support-agent.com',
  }

  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.writeFileSync.mockReturnValue(undefined)
    mockedExecSync.mockReturnValue(Buffer.from(''))
  })

  it('should remove existing service before loading (idempotent update)', () => {
    installAndStartProject(project)

    const removeCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('launchctl remove'),
    )
    expect(removeCall).toBeDefined()
    // Verify the label is quoted to handle labels with hyphens/special chars
    expect(removeCall![0]).toBe('launchctl remove "com.ai-support-agent.cli.00000005.smart-quote"')
  })

  it('should write service files and call launchctl load', () => {
    installAndStartProject(project)

    const loadCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('launchctl load'),
    )
    expect(loadCall).toBeDefined()
    expect(loadCall![0]).toContain('com.ai-support-agent.cli.00000005.smart-quote.plist')
  })

  it('should call launchctl list to verify the service loaded', () => {
    installAndStartProject(project)

    const listCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('launchctl list'),
    )
    expect(listCall).toBeDefined()
    expect(listCall![0]).toContain('com.ai-support-agent.cli.00000005.smart-quote')
  })

  it('should not throw when launchctl remove fails (not yet loaded)', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl remove')) {
        throw new Error('no such process')
      }
      return Buffer.from('')
    })

    expect(() => installAndStartProject(project)).not.toThrow()
  })

  it('should warn and return early when launchctl load fails', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl load')) {
        throw new Error('permission denied')
      }
      return Buffer.from('')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
    // launchctl list should NOT be called after load failure
    const listCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('launchctl list'),
    )
    expect(listCall).toBeUndefined()
  })

  it('should log warning when launchctl list fails after load', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('launchctl list')) {
        throw new Error('not registered')
      }
      return Buffer.from('')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
  })
})
