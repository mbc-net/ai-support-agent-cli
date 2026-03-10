import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildMcpConfig, getMcpConfigPath, writeMcpConfig } from '../../src/mcp/config-writer'

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
        [{ domain: 'myspace.backlog.jp', apiKey: 'backlog-api-key-123' }],
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

    it('should use first backlog config when multiple provided', () => {
      const configPath = writeMcpConfig(
        testDir,
        'http://localhost:3030',
        'test-token-123',
        'TEST_01',
        '/path/to/server.js',
        [
          { domain: 'first.backlog.jp', apiKey: 'key-1' },
          { domain: 'second.backlog.jp', apiKey: 'key-2' },
        ],
      )

      const content = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(content.mcpServers.backlog.env.BACKLOG_DOMAIN).toBe('first.backlog.jp')
      expect(content.mcpServers.backlog.env.BACKLOG_API_KEY).toBe('key-1')
    })
  })
})
