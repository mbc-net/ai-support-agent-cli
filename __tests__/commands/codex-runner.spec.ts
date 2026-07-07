import os from 'os'
import fs from 'fs'
import path from 'path'

import { ERR_CODEX_AUTH_INVALID, buildCodexArgs, buildCodexMcpConfigOverrides, formatCodexExitError, isCodexAuthError, redactCodexArgs } from '../../src/commands/codex-runner'

describe('codex-runner', () => {
  describe('buildCodexArgs', () => {
    it('builds non-interactive JSONL args', () => {
      const args = buildCodexArgs('hello')

      expect(args.slice(0, -1)).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
      ])
      expect(args.at(-1)).toBe('hello')
    })

    it('does not pass unsupported approval flags to codex exec', () => {
      const args = buildCodexArgs('hello')

      expect(args).not.toContain('--ask-for-approval')
    })

    it('adds cwd, model, and add-dir options', () => {
      const args = buildCodexArgs('hello', {
        cwd: '/tmp/project',
        model: 'gpt-5-codex',
        addDirs: ['~/shared', '/tmp/other'],
        outputLastMessagePath: '/tmp/last-message.txt',
        profile: 'ai-support-agent-bundled',
      })

      expect(args).toContain('--profile')
      expect(args[args.indexOf('--profile') + 1]).toBe('ai-support-agent-bundled')
      expect(args).toContain('--cd')
      expect(args[args.indexOf('--cd') + 1]).toBe('/tmp/project')
      expect(args).toContain('--model')
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex')
      expect(args).toContain('--add-dir')
      expect(args).toContain(`${os.homedir()}/shared`)
      expect(args).toContain('/tmp/other')
      expect(args).toContain('--output-last-message')
      expect(args[args.indexOf('--output-last-message') + 1]).toBe('/tmp/last-message.txt')
    })

    it('prepends locale and system prompt to the user message', () => {
      const args = buildCodexArgs('hello', {
        locale: 'ja',
        systemPrompt: 'Custom instructions',
      })

      expect(args.at(-1)).toBe([
        'Always respond in Japanese. Use Japanese for all explanations and communications.',
        'Custom instructions',
        'hello',
      ].join('\n\n'))
    })

    it('adds Codex MCP config overrides from Claude MCP config JSON', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-test-'))
      const mcpConfigPath = path.join(tmpDir, 'mcp.json')
      fs.writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          'ai-support-agent': {
            command: 'node',
            args: ['/tmp/server.js'],
            env: {
              AI_SUPPORT_AGENT_TOKEN: 'token',
              AI_SUPPORT_AGENT_PROJECT_CODE: 'TEST_01',
            },
          },
        },
      }))

      const args = buildCodexArgs('hello', { mcpConfigPath })

      expect(args).toContain('-c')
      expect(args).toContain('mcp_servers.ai-support-agent.command="node"')
      expect(args).toContain('mcp_servers.ai-support-agent.default_tools_approval_mode="approve"')
      expect(args).toContain('mcp_servers.ai-support-agent.args=["/tmp/server.js"]')
      expect(args).toContain('mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_TOKEN="token"')
      expect(args).toContain('mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_PROJECT_CODE="TEST_01"')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('buildCodexMcpConfigOverrides', () => {
    it('returns an empty list when config file is missing', () => {
      expect(buildCodexMcpConfigOverrides('/tmp/missing-mcp-config.json')).toEqual([])
    })
  })

  describe('redactCodexArgs', () => {
    it('redacts sensitive MCP env config values in metadata args', () => {
      expect(redactCodexArgs([
        'exec',
        'mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_TOKEN="secret-token"',
        'mcp_servers.backlog.env.BACKLOG_API_KEY="secret-key"',
        'mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_PROJECT_CODE="AI_SUPPORT_AGENT"',
      ])).toEqual([
        'exec',
        'mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_TOKEN="****"',
        'mcp_servers.backlog.env.BACKLOG_API_KEY="****"',
        'mcp_servers.ai-support-agent.env.AI_SUPPORT_AGENT_PROJECT_CODE="AI_SUPPORT_AGENT"',
      ])
    })
  })

  describe('Codex auth error handling', () => {
    it('detects invalidated Codex auth token from stderr', () => {
      expect(isCodexAuthError('unexpected status 401 Unauthorized: Your authentication token has been invalidated. Please try sign in again')).toBe(true)
      expect(isCodexAuthError('Failed to refresh token: 401 Unauthorized: Your session has ended. Please log in again.')).toBe(true)
      expect(isCodexAuthError('failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses')).toBe(true)
    })

    it('formats auth failures as actionable messages', () => {
      expect(formatCodexExitError(1, 'Your session has ended. Please log in again.')).toBe(ERR_CODEX_AUTH_INVALID)
      expect(formatCodexExitError(1, 'some other failure')).toBe('codex CLI がコード 1 で終了しました')
    })
  })
})
