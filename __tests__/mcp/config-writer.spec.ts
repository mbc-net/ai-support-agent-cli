import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

jest.mock('../../src/logger')

import { logger } from '../../src/logger'
import { buildMcpConfig, cleanupStaleCommandMcpConfigs, getMcpConfigPath, writeCommandMcpConfig, writeMcpConfig } from '../../src/mcp/config-writer'

describe('config-writer', () => {
  const testDir = join(tmpdir(), 'ai-support-agent-test-mcp-' + Date.now())

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('getMcpConfigPath', () => {
    it('should return correct path', () => {
      const result = getMcpConfigPath('/project/dir')
      expect(result).toBe(join('/project/dir', '.ai-support-agent', 'mcp', 'config.json'))
    })
  })

  describe('buildMcpConfig', () => {
    it('should build correct config structure', () => {
      const config = buildMcpConfig(
        'http://localhost:3030',
        'TEST_01',
        '/path/to/server.js',
        'test_tenant',
      )

      expect(config).toEqual({
        mcpServers: {
          'ai-support-agent': {
            command: 'node',
            args: ['/path/to/server.js'],
            env: {
              AI_SUPPORT_AGENT_API_URL: 'http://localhost:3030',
              AI_SUPPORT_AGENT_TOKEN: '${AI_SUPPORT_AGENT_TOKEN}',
              AI_SUPPORT_AGENT_PROJECT_CODE: 'TEST_01',
              AI_SUPPORT_AGENT_TENANT_CODE: 'test_tenant',
            },
          },
        },
      })
    })
  })

  describe('writeMcpConfig', () => {
    it('should write config file with correct content', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test_tenant:tokenId:rawToken',
        'TEST_01',
        '/path/to/server.js',
      )

      expect(existsSync(configPath)).toBe(true)

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].command).toBe('node')
      expect(content.mcpServers['ai-support-agent'].args).toEqual(['/path/to/server.js'])
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_API_URL).toBe('http://localhost:3030')
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_TOKEN).toBe('test_tenant:tokenId:rawToken')
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_PROJECT_CODE).toBe('TEST_01')
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_TENANT_CODE).toBe('test_tenant')
    })

    it('should use explicit tenantCode when provided', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        undefined,
        'explicit_tenant',
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_TENANT_CODE).toBe('explicit_tenant')
    })

    it('should set file permission to 0600', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const stat = statSync(configPath)
      // 0o600 = owner read+write only
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('should return the config path', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'token',
        'PROJ',
        '/srv.js',
      )

      expect(configPath).toBe(getMcpConfigPath(testDir))
    })

    it('should include backlog MCP server when backlogConfigs provided', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [{ domain: 'myspace.backlog.jp', apiKey: 'backlog-api-key-123', projectKey: 'MY_PROJ' }],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers.backlog).toBeDefined()
      expect(content.mcpServers.backlog.command).toBe('npx')
      expect(content.mcpServers.backlog.args).toEqual(['backlog-mcp-server'])
      expect(content.mcpServers.backlog.env.BACKLOG_DOMAIN).toBe('myspace.backlog.jp')
      expect(content.mcpServers.backlog.env.BACKLOG_API_KEY).toBe('backlog-api-key-123')
    })

    it('should not include backlog MCP server when backlogConfigs is undefined', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers.backlog).toBeUndefined()
    })

    it('should not include backlog MCP server when backlogConfigs is empty', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers.backlog).toBeUndefined()
    })

    it('should include browserLocalPort env var when provided', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        undefined,
        undefined,
        9222,
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_BROWSER_LOCAL_PORT).toBe('9222')
    })

    it('should not include browserLocalPort env var when not provided', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_BROWSER_LOCAL_PORT).toBeUndefined()
    })

    it('should not include a conversationId env var (writeMcpConfig has no conversationId parameter)', () => {
      // conversationId は per-command で変わる値であり、config sync 時にのみ再生成される
      // このプロジェクト単位の静的ファイルには書き込まない設計（writeCommandMcpConfig を使う）。
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBeUndefined()
    })

    it('should expose every backlog config via the official multi-org env vars (single process, multi-org support)', () => {
      // 回帰再現: テナントが複数Backlog連携(異なる組織を含む)を設定していても、
      // 従来は配列先頭の1件しかMCPサーバーの環境変数として露出せず、2件目以降が
      // エージェントから一切アクセス不能になっていた。
      // backlog-mcp-server(nulab公式)は単一プロセスでBACKLOG_ORG_<NAME>_DOMAIN /
      // BACKLOG_ORG_<NAME>_API_KEY の環境変数ペアにより複数組織に対応するため、
      // それを使って全件を1つの `backlog` サーバーに載せる。
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [
          { domain: 'mbc-net.backlog.com', apiKey: 'key-1', projectKey: 'JCCI_ECO_DEV' },
          { domain: 'mbc-net.backlog.com', apiKey: 'key-1', projectKey: 'JCCI_ECO' },
          { domain: 'tokuteico.backlog.com', apiKey: 'key-2', projectKey: 'JCCI_ECO2', isDefault: true },
        ],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      const backlog = content.mcpServers.backlog

      expect(backlog.command).toBe('npx')
      expect(backlog.args).toEqual(['backlog-mcp-server'])

      expect(backlog.env.BACKLOG_ORG_JCCI_ECO_DEV_DOMAIN).toBe('mbc-net.backlog.com')
      expect(backlog.env.BACKLOG_ORG_JCCI_ECO_DEV_API_KEY).toBe('key-1')

      expect(backlog.env.BACKLOG_ORG_JCCI_ECO_DOMAIN).toBe('mbc-net.backlog.com')
      expect(backlog.env.BACKLOG_ORG_JCCI_ECO_API_KEY).toBe('key-1')

      expect(backlog.env.BACKLOG_ORG_JCCI_ECO2_DOMAIN).toBe('tokuteico.backlog.com')
      expect(backlog.env.BACKLOG_ORG_JCCI_ECO2_API_KEY).toBe('key-2')

      // isDefault: true の項目がデフォルト組織として選ばれること
      expect(backlog.env.BACKLOG_DEFAULT_ORG).toBe('JCCI_ECO2')

      // 単一組織用の env は複数組織モードでは含めない(backlog-mcp-server の仕様上不要)
      expect(backlog.env.BACKLOG_DOMAIN).toBeUndefined()
      expect(backlog.env.BACKLOG_API_KEY).toBeUndefined()
    })

    it('should default to the first backlog config when none is marked isDefault', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [
          { domain: 'first.backlog.jp', apiKey: 'key-1', projectKey: 'FIRST' },
          { domain: 'second.backlog.jp', apiKey: 'key-2', projectKey: 'SECOND' },
        ],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers.backlog.env.BACKLOG_DEFAULT_ORG).toBe('FIRST')
    })

    it('should disambiguate backlog org env var names when projectKey collides after sanitization', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [
          { domain: 'a.backlog.com', apiKey: 'key-a', projectKey: 'proj' },
          { domain: 'b.backlog.com', apiKey: 'key-b', projectKey: 'PROJ' },
        ],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      const env = content.mcpServers.backlog.env as Record<string, string>

      expect(env.BACKLOG_ORG_PROJ_DOMAIN).toBe('a.backlog.com')
      expect(env.BACKLOG_ORG_PROJ_API_KEY).toBe('key-a')
      expect(env.BACKLOG_ORG_PROJ_2_DOMAIN).toBe('b.backlog.com')
      expect(env.BACKLOG_ORG_PROJ_2_API_KEY).toBe('key-b')
    })

    it('should sanitize a projectKey that would otherwise produce an invalid env var name', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [
          { domain: 'a.backlog.com', apiKey: 'key-a', projectKey: '1-proj/key' },
          { domain: 'b.backlog.com', apiKey: 'key-b', projectKey: 'OK_PROJ' },
        ],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      const env = content.mcpServers.backlog.env as Record<string, string>

      expect(env.BACKLOG_ORG_ORG_1_PROJ_KEY_DOMAIN).toBe('a.backlog.com')
      expect(env.BACKLOG_ORG_OK_PROJ_DOMAIN).toBe('b.backlog.com')
    })
  })

  describe('writeCommandMcpConfig', () => {
    it('should write a command-scoped config file embedding AI_SUPPORT_CONVERSATION_ID', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test_tenant:tokenId:rawToken',
        'TEST_01',
        '/path/to/server.js',
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, 'cmd-1', 'conv-123')

      expect(commandConfigPath).not.toBe(baseConfigPath)
      expect(existsSync(commandConfigPath)).toBe(true)

      const content = JSON.parse(readFileSync(commandConfigPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-123')
      // Preserves the fields already present in the base config
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_API_URL).toBe('http://localhost:3030')
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_AGENT_TOKEN).toBe('test_tenant:tokenId:rawToken')
    })

    it('should embed AI_SUPPORT_TASK_ID when taskId is provided (task detail E2E tab reverse lookup)', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test_tenant:tokenId:rawToken',
        'TEST_01',
        '/path/to/server.js',
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, 'cmd-task-1', 'conv-123', 'task-abc-123')

      const content = JSON.parse(readFileSync(commandConfigPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_TASK_ID).toBe('task-abc-123')
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-123')
    })

    it('should not include AI_SUPPORT_TASK_ID when taskId is not provided', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test_tenant:tokenId:rawToken',
        'TEST_01',
        '/path/to/server.js',
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, 'cmd-task-2', 'conv-123')

      const content = JSON.parse(readFileSync(commandConfigPath, 'utf-8'))
      expect(content.mcpServers['ai-support-agent'].env.AI_SUPPORT_TASK_ID).toBeUndefined()
    })

    it('should not mutate the base config file', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      writeCommandMcpConfig(baseConfigPath, 'cmd-2', 'conv-456')

      const baseContent = JSON.parse(readFileSync(baseConfigPath, 'utf-8'))
      expect(baseContent.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBeUndefined()
    })

    it('should set file permission to 0600', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, 'cmd-3', 'conv-789')

      const stat = statSync(commandConfigPath)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('should preserve the backlog MCP server entry unchanged', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [{ domain: 'myspace.backlog.jp', apiKey: 'backlog-api-key-123', projectKey: 'MY_PROJ' }],
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, 'cmd-4', 'conv-abc')

      const content = JSON.parse(readFileSync(commandConfigPath, 'utf-8'))
      expect(content.mcpServers.backlog.env.BACKLOG_DOMAIN).toBe('myspace.backlog.jp')
      // conversationId must not leak into unrelated MCP servers
      expect(content.mcpServers.backlog.env.AI_SUPPORT_CONVERSATION_ID).toBeUndefined()
    })

    it('should produce distinct files for distinct commandIds sharing the same base config (no cross-conversation collision)', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const pathA = writeCommandMcpConfig(baseConfigPath, 'cmd-concurrent-a', 'conv-a')
      const pathB = writeCommandMcpConfig(baseConfigPath, 'cmd-concurrent-b', 'conv-b')

      expect(pathA).not.toBe(pathB)

      const contentA = JSON.parse(readFileSync(pathA, 'utf-8'))
      const contentB = JSON.parse(readFileSync(pathB, 'utf-8'))
      expect(contentA.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-a')
      expect(contentB.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-b')
    })

    it('should produce distinct files for commandIds that collide after sanitization (e.g. "cmd/a" and "cmd_a")', () => {
      // Both `cmd/a` and `cmd_a` sanitize to the same "cmd_a" string. A filename derived
      // only from the sanitized commandId (no randomness/hash) would collide, letting one
      // command's cleanup delete the other's still-in-use per-command MCP config file —
      // or letting one conversationId leak into a concurrently-running unrelated command.
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const pathSlash = writeCommandMcpConfig(baseConfigPath, 'cmd/a', 'conv-slash')
      const pathUnderscore = writeCommandMcpConfig(baseConfigPath, 'cmd_a', 'conv-underscore')

      expect(pathSlash).not.toBe(pathUnderscore)
      expect(existsSync(pathSlash)).toBe(true)
      expect(existsSync(pathUnderscore)).toBe(true)

      const contentSlash = JSON.parse(readFileSync(pathSlash, 'utf-8'))
      const contentUnderscore = JSON.parse(readFileSync(pathUnderscore, 'utf-8'))
      expect(contentSlash.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-slash')
      expect(contentUnderscore.mcpServers['ai-support-agent'].env.AI_SUPPORT_CONVERSATION_ID).toBe('conv-underscore')
    })

    it('should sanitize path-traversal characters in commandId', () => {
      const baseConfigPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
      )

      const commandConfigPath = writeCommandMcpConfig(baseConfigPath, '../../etc/evil', 'conv-evil')

      expect(commandConfigPath.startsWith(testDir)).toBe(true)
      expect(commandConfigPath).not.toContain('..')
      expect(existsSync(commandConfigPath)).toBe(true)
    })

    it('should throw when the base config file does not exist', () => {
      expect(() => writeCommandMcpConfig(join(testDir, 'does-not-exist.json'), 'cmd-5', 'conv-x'))
        .toThrow()
    })

    it('should not throw when the base config is missing the ai-support-agent server entry', () => {
      const malformedConfigPath = join(testDir, 'malformed-config.json')
      writeFileSync(malformedConfigPath, JSON.stringify({ mcpServers: {} }))

      const commandConfigPath = writeCommandMcpConfig(malformedConfigPath, 'cmd-6', 'conv-y')

      const content = JSON.parse(readFileSync(commandConfigPath, 'utf-8'))
      expect(content.mcpServers).toEqual({})
    })
  })

  describe('cleanupStaleCommandMcpConfigs', () => {
    // Mirrors TerminalSession.cleanupStaleSandboxes: orphaned per-command MCP config
    // files (plaintext token + conversationId) can be left behind if the agent process
    // is SIGKILLed/OOM-killed before chat-executor.ts's cleanup runs. Sweep old ones on
    // config sync so they don't accumulate indefinitely.
    let cleanupTestDir: string

    beforeEach(() => {
      cleanupTestDir = join(tmpdir(), 'ai-support-agent-cleanup-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
      mkdirSync(cleanupTestDir, { recursive: true })
    })

    afterEach(() => {
      rmSync(cleanupTestDir, { recursive: true, force: true })
    })

    function makeCommandConfigFile(dir: string, name: string, mtimeMs: number): string {
      const fullPath = join(dir, name)
      writeFileSync(fullPath, '{}')
      const t = new Date(mtimeMs)
      utimesSync(fullPath, t, t)
      return fullPath
    }

    it('should remove per-command config files older than maxAgeMs', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const stalePath = makeCommandConfigFile(cleanupTestDir, 'config-cmd-old-uuid1.json', Date.now() - 25 * 60 * 60 * 1000)

      const removed = cleanupStaleCommandMcpConfigs(baseConfigPath)

      expect(removed).toBe(1)
      expect(existsSync(stalePath)).toBe(false)
    })

    it('should not remove per-command config files newer than maxAgeMs', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const freshPath = makeCommandConfigFile(cleanupTestDir, 'config-cmd-fresh-uuid2.json', Date.now() - 1000)

      const removed = cleanupStaleCommandMcpConfigs(baseConfigPath)

      expect(removed).toBe(0)
      expect(existsSync(freshPath)).toBe(true)
    })

    it('should not remove the shared static config.json itself', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const t = new Date(Date.now() - 25 * 60 * 60 * 1000)
      utimesSync(baseConfigPath, t, t)

      cleanupStaleCommandMcpConfigs(baseConfigPath)

      expect(existsSync(baseConfigPath)).toBe(true)
    })

    it('should not remove unrelated files in the same directory', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const unrelatedPath = makeCommandConfigFile(cleanupTestDir, 'unrelated-file.json', Date.now() - 25 * 60 * 60 * 1000)

      cleanupStaleCommandMcpConfigs(baseConfigPath)

      expect(existsSync(unrelatedPath)).toBe(true)
    })

    it('should remove all matching files when maxAgeMs=0', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const freshPath = makeCommandConfigFile(cleanupTestDir, 'config-cmd-fresh-uuid3.json', Date.now() - 1000)

      const removed = cleanupStaleCommandMcpConfigs(baseConfigPath, 0)

      expect(removed).toBe(1)
      expect(existsSync(freshPath)).toBe(false)
    })

    it('should return 0 when the directory cannot be read', () => {
      const removed = cleanupStaleCommandMcpConfigs(join(cleanupTestDir, 'does-not-exist', 'config.json'))
      expect(removed).toBe(0)
    })

    it('should ignore individual file removal failures, log a warning, and continue', () => {
      const baseConfigPath = join(cleanupTestDir, 'config.json')
      writeFileSync(baseConfigPath, '{}')
      const stalePath = makeCommandConfigFile(cleanupTestDir, 'config-cmd-old-uuid4.json', Date.now() - 25 * 60 * 60 * 1000)

      const rmSpy = jest.spyOn(require('fs'), 'rmSync').mockImplementationOnce(() => {
        throw new Error('EBUSY: resource busy')
      })
      try {
        const removed = cleanupStaleCommandMcpConfigs(baseConfigPath)
        expect(removed).toBe(0)
        expect(existsSync(stalePath)).toBe(true)
        // Previously this failure was swallowed with zero observability. It must now
        // be logged (with the offending file name) so operators can diagnose why a
        // stale per-command config didn't get swept.
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('config-cmd-old-uuid4.json'))
      } finally {
        rmSpy.mockRestore()
      }
    })
  })
})
