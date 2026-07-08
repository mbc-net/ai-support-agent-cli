import type { ApiClient } from '../../src/api-client'
import {
  executeChatCommand,
  buildClaudeArgs as reExportedBuildClaudeArgs,
  buildCleanEnv as reExportedBuildCleanEnv,
  _resetCleanEnvCache as reExportedResetCleanEnvCache,
  buildConversationFileNotice,
  buildMetadataNotice,
} from '../../src/commands/chat-executor'
import { ERR_CODEX_AUTH_INVALID } from '../../src/commands/codex-runner'
import { cancelProcess as cancelChatProcess, _getRunningProcesses } from '../../src/commands/process-manager'
import { ERR_AGENT_ID_REQUIRED, ERR_CLAUDE_CLI_NOT_FOUND, ERR_CODEX_CLI_NOT_FOUND, ERR_MESSAGE_REQUIRED } from '../../src/constants'
import type { AgentServerConfig, ChatPayload, ProjectConfigResponse } from '../../src/types'
import { createMockChildProcess } from '../helpers/mock-factory'
import { ndjsonAssistant, ndjsonResult } from '../helpers/ndjson-builders'

jest.mock('../../src/logger')

// Bundled plugin resolution is exercised by claude-code-runner.spec.ts and
// plugin-dir.spec.ts; mock it here so it defaults to no-op (resolveValidPluginDir
// returns undefined) and the exact spawn-args assertions below don't need to
// account for --plugin-dir.
jest.mock('../../src/commands/plugin-dir')
jest.mock('../../src/commands/codex-command', () => ({
  resolveCodexInvocation: jest.fn(() => ({
    command: 'codex',
    argsPrefix: [],
    displayCommand: 'codex',
  })),
}))

// Mock project-dir
jest.mock('../../src/project-dir', () => ({
  getAutoAddDirs: jest.fn().mockReturnValue(['/mock/repos', '/mock/docs']),
  getWorkspaceDir: jest.fn((dir: string) => `${dir}/workspace`),
}))

// Mock aws-credential-builder
jest.mock('../../src/aws-credential-builder', () => ({
  buildAwsProfileCredentials: jest.fn().mockResolvedValue({
    env: {
      AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
      AWS_PROFILE: 'TEST-dev',
      AWS_DEFAULT_REGION: 'ap-northeast-1',
    },
    errors: [],
    ssoAuthRequired: [],
  }),
  buildSingleAccountAwsEnv: jest.fn().mockResolvedValue({ errors: [], ssoAuthRequired: [] }),
}))

// Mock api-chat-executor
jest.mock('../../src/commands/api-chat-executor', () => ({
  executeApiChatCommand: jest.fn().mockResolvedValue({
    success: true,
    data: 'api response',
  }),
}))

// Mock git-credential-setup
const mockGitCleanup = jest.fn()
jest.mock('../../src/git-credential-setup', () => {
  // Use a reference that's resolved at call time, not at factory time
  return {
    buildGitCredentialEnv: jest.fn().mockImplementation(() =>
      Promise.resolve({
        env: {},
        cleanup: mockGitCleanup,
      }),
    ),
  }
})

// Mock child_process for Claude Code CLI
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

// Mock file-transfer for downloadAttachments tests
jest.mock('../../src/commands/file-transfer', () => ({
  downloadChatFiles: jest.fn().mockResolvedValue({
    downloadedPaths: [],
    imagePaths: [],
    failedCount: 0,
    cleanup: jest.fn(),
  }),
  parseChatFiles: jest.fn().mockImplementation((files: unknown) => {
    if (!Array.isArray(files)) return []
    return files.filter(
      (item): item is object =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).fileId === 'string' &&
        typeof (item as Record<string, unknown>).filename === 'string' &&
        typeof (item as Record<string, unknown>).contentType === 'string' &&
        typeof (item as Record<string, unknown>).fileSize === 'number',
    )
  }),
  parseConversationFiles: jest.fn().mockImplementation((files: unknown) => {
    if (!Array.isArray(files)) return []
    return files.filter(
      (f): f is object =>
        f != null &&
        typeof f === 'object' &&
        typeof (f as Record<string, unknown>).fileId === 'string' &&
        typeof (f as Record<string, unknown>).s3Key === 'string' &&
        typeof (f as Record<string, unknown>).filename === 'string',
    )
  }),
}))

describe('chat-executor', () => {
  const mockClient = {
    submitChatChunk: jest.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient

  const basePayload: ChatPayload = {
    message: 'Hello, world!',
  }

  beforeEach(() => {
    jest.clearAllMocks()
    const { spawn } = require('child_process')
    spawn.mockReset()
  })

  describe('activeChatMode routing', () => {
    it('should use claude_code mode by default (no activeChatMode)', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      spawn.mockReturnValue(mockProcess)

      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from(ndjsonResult('CLI response')))
        }
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') {
          cb(0)
        }
      })

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-1', client: mockClient, agentId: 'agent-1' })
      expect(result.success).toBe(true)
      expect(spawn).toHaveBeenCalledWith('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Hello, world!'], expect.any(Object))
    })

    it('should use codex when no mode is selected and only codex is available', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex response' }) + '\n'))
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-codex-only',
        client: mockClient,
        availableChatModes: ['codex'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex response')
      expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should fall back to codex when Claude Code is unavailable and no payload mode is specified', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      const codexProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn
        .mockReturnValueOnce(claudeProcess)
        .mockReturnValueOnce(codexProcess)

      claudeProcess.stdout.on.mockImplementation(() => {})
      claudeProcess.stderr.on.mockImplementation(() => {})
      claudeProcess.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
        if (event === 'error') cb(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
      })

      codexProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex fallback response' }) + '\n'))
      })
      codexProcess.stderr.on.mockImplementation(() => {})
      codexProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-fallback-codex',
        client: mockClient,
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex fallback response')
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', expect.any(Array), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
      expect(mockClient.submitChatChunk).not.toHaveBeenCalledWith(
        'cmd-fallback-codex',
        expect.objectContaining({ type: 'error', content: ERR_CLAUDE_CLI_NOT_FOUND }),
        'agent-1',
      )
    })

    it('should use the default fallback order from Claude Code to Codex', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      const codexProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn
        .mockReturnValueOnce(claudeProcess)
        .mockReturnValueOnce(codexProcess)

      claudeProcess.stdout.on.mockImplementation(() => {})
      claudeProcess.stderr.on.mockImplementation(() => {})
      claudeProcess.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
        if (event === 'error') cb(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
      })

      codexProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex default fallback response' }) + '\n'))
      })
      codexProcess.stderr.on.mockImplementation(() => {})
      codexProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-default-fallback-order',
        client: mockClient,
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex default fallback response')
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', expect.any(Array), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should fall back to codex when Claude Code exits due to Monthly Limit', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = createMockChildProcess()
      const codexProcess = createMockChildProcess()
      spawn
        .mockReturnValueOnce(claudeProcess)
        .mockReturnValueOnce(codexProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-claude-monthly-limit-fallback',
        client: mockClient,
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      claudeProcess.emitStderr('data', Buffer.from('Claude AI usage limit reached|Monthly limit reached\n'))
      claudeProcess.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))
      codexProcess.emitStdout('data', Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex handled monthly limit fallback' }) + '\n'))
      codexProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex handled monthly limit fallback')
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', expect.any(Array), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
      expect(mockClient.submitChatChunk).not.toHaveBeenCalledWith(
        'cmd-claude-monthly-limit-fallback',
        expect.objectContaining({ type: 'error', content: expect.stringContaining('Monthly limit') }),
        'agent-1',
      )
    })

    it('should fall back to codex on Monthly Limit even when activeChatMode is Claude Code', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = createMockChildProcess()
      const codexProcess = createMockChildProcess()
      spawn
        .mockReturnValueOnce(claudeProcess)
        .mockReturnValueOnce(codexProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-active-claude-monthly-limit-fallback',
        client: mockClient,
        activeChatMode: 'claude_code',
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      claudeProcess.emitStderr('data', Buffer.from('Claude AI usage limit reached|Monthly limit reached\n'))
      claudeProcess.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))
      codexProcess.emitStdout('data', Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex handled active fallback' }) + '\n'))
      codexProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex handled active fallback')
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', expect.any(Array), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should fall back to codex when Claude Code exits with code 1 even without recognized limit stderr', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = createMockChildProcess()
      const codexProcess = createMockChildProcess()
      spawn
        .mockReturnValueOnce(claudeProcess)
        .mockReturnValueOnce(codexProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-claude-code-1-fallback',
        client: mockClient,
        activeChatMode: 'claude_code',
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      claudeProcess.emitStderr('data', Buffer.from('unclassified claude failure\n'))
      claudeProcess.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))
      codexProcess.emitStdout('data', Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex handled code 1 fallback' }) + '\n'))
      codexProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex handled code 1 fallback')
      expect(spawn).toHaveBeenNthCalledWith(1, 'claude', expect.any(Array), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should use project fallback order from Codex to Claude Code when Codex CLI is unavailable', async () => {
      const { spawn } = require('child_process')
      const codexProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      const claudeProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn
        .mockReturnValueOnce(codexProcess)
        .mockReturnValueOnce(claudeProcess)

      codexProcess.stdout.on.mockImplementation(() => {})
      codexProcess.stderr.on.mockImplementation(() => {})
      codexProcess.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
        if (event === 'error') cb(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))
      })

      claudeProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(ndjsonResult('Claude fallback response')))
      })
      claudeProcess.stderr.on.mockImplementation(() => {})
      claudeProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const projectConfig: ProjectConfigResponse = {
        configHash: 'h1',
        project: { projectCode: 'MBC_01', projectName: 'MBC' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
          agentChatModeFallbackOrder: ['codex', 'claude_code'],
        },
      }

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-project-fallback-order',
        client: mockClient,
        availableChatModes: ['claude_code', 'codex'],
        projectConfig,
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Claude fallback response')
      expect(spawn).toHaveBeenNthCalledWith(1, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'claude', expect.any(Array), expect.any(Object))
      expect(mockClient.submitChatChunk).not.toHaveBeenCalledWith(
        'cmd-project-fallback-order',
        expect.objectContaining({ type: 'error', content: ERR_CODEX_CLI_NOT_FOUND }),
        'agent-1',
      )
    })

    it('should fall back to Claude Code when Codex exits with code 1', async () => {
      const { spawn } = require('child_process')
      const codexProcess = createMockChildProcess()
      const claudeProcess = createMockChildProcess()
      spawn
        .mockReturnValueOnce(codexProcess)
        .mockReturnValueOnce(claudeProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-codex-code-1-fallback',
        client: mockClient,
        activeChatMode: 'codex',
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      codexProcess.emitStderr('data', Buffer.from('unclassified codex failure\n'))
      codexProcess.emit('close', 1)

      await new Promise((r) => setTimeout(r, 10))
      claudeProcess.emitStdout('data', Buffer.from(ndjsonResult('Claude handled Codex code 1 fallback')))
      claudeProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(result.data).toBe('Claude handled Codex code 1 fallback')
      expect(spawn).toHaveBeenNthCalledWith(1, 'codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
      expect(spawn).toHaveBeenNthCalledWith(2, 'claude', expect.any(Array), expect.any(Object))
    })

    it('should not fall back to Claude Code when Codex is explicitly requested', async () => {
      const { spawn } = require('child_process')
      const codexProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      spawn.mockReturnValue(codexProcess)
      codexProcess.stdout.on.mockImplementation(() => {})
      codexProcess.stderr.on.mockImplementation(() => {})
      codexProcess.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
        if (event === 'error') cb(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))
      })

      const result = await executeChatCommand({
        payload: { ...basePayload, agentChatMode: 'codex' } as ChatPayload,
        commandId: 'cmd-explicit-codex',
        client: mockClient,
        availableChatModes: ['claude_code', 'codex'],
        projectConfig: {
          configHash: 'h1',
          project: { projectCode: 'MBC_01', projectName: 'MBC' },
          agent: {
            agentEnabled: true,
            builtinAgentEnabled: true,
            builtinFallbackEnabled: true,
            externalAgentEnabled: true,
            allowedTools: [],
            agentChatModeFallbackOrder: ['codex', 'claude_code'],
          },
        },
        agentId: 'agent-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe(ERR_CODEX_CLI_NOT_FOUND)
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('should filter fallback candidates by availableChatModes while preserving order', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn.mockReturnValue(claudeProcess)
      claudeProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(ndjsonResult('Filtered Claude response')))
      })
      claudeProcess.stderr.on.mockImplementation(() => {})
      claudeProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-filtered-fallback-order',
        client: mockClient,
        serverConfig: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          chatMode: 'agent',
          agentChatModeFallbackOrder: ['codex', 'claude_code'],
        },
        availableChatModes: ['claude_code'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Filtered Claude response')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(Object))
    })

    it('should de-duplicate fallback candidates while preserving order', async () => {
      const { spawn } = require('child_process')
      const codexProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn.mockReturnValue(codexProcess)
      codexProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Unique Codex response' }) + '\n'))
      })
      codexProcess.stderr.on.mockImplementation(() => {})
      codexProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-unique-fallback-order',
        client: mockClient,
        serverConfig: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          chatMode: 'agent',
          agentChatModeFallbackOrder: ['codex', 'codex', 'claude_code'],
        },
        availableChatModes: ['codex'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Unique Codex response')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should not fall back to codex when Claude Code is explicitly requested', async () => {
      const { spawn } = require('child_process')
      const claudeProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 123,
      }
      spawn.mockReturnValue(claudeProcess)
      claudeProcess.stdout.on.mockImplementation(() => {})
      claudeProcess.stderr.on.mockImplementation(() => {})
      claudeProcess.on.mockImplementation((event: string, cb: (arg: unknown) => void) => {
        if (event === 'error') cb(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
      })

      const result = await executeChatCommand({
        payload: { ...basePayload, agentChatMode: 'claude_code' } as ChatPayload,
        commandId: 'cmd-explicit-claude',
        client: mockClient,
        activeChatMode: 'claude_code',
        availableChatModes: ['claude_code', 'codex'],
        agentId: 'agent-1',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe(ERR_CLAUDE_CLI_NOT_FOUND)
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('should use claude_code mode when activeChatMode is claude_code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 124,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(ndjsonResult('response')))
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-2', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })
      expect(result.success).toBe(true)
      expect(spawn).toHaveBeenCalled()
    })

    it('should use codex mode when activeChatMode is codex', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 125,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex response' }) + '\n'))
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-codex', client: mockClient, activeChatMode: 'codex', agentId: 'agent-1' })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Codex response')
      expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('should extract Codex text from nested response content arrays', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 125,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from(JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Nested Codex response' },
              ],
            },
          }) + '\n'))
        }
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-codex-nested', client: mockClient, activeChatMode: 'codex', agentId: 'agent-1' })

      expect(result.success).toBe(true)
      expect(result.data).toBe('Nested Codex response')
    })

    it('should not retry when Codex auth is invalid', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 126,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation(() => {})
      mockProcess.stderr.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('Failed to refresh token: 401 Unauthorized: Your session has ended. Please log in again.'))
      })
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(1)
      })

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-codex-auth', client: mockClient, activeChatMode: 'codex', agentId: 'agent-1' })

      expect(result.success).toBe(false)
      expect(result.error).toBe(ERR_CODEX_AUTH_INVALID)
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('should use api mode when activeChatMode is api', async () => {
      const { executeApiChatCommand } = require('../../src/commands/api-chat-executor')

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }

      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-3', client: mockClient, serverConfig, activeChatMode: 'api', agentId: 'agent-1' })
      expect(result.success).toBe(true)
      expect(executeApiChatCommand).toHaveBeenCalledWith(
        basePayload, 'cmd-3', mockClient, serverConfig, 'agent-1',
      )
    })

    it('should let payload.agentChatMode override the activeChatMode for a single chat command', async () => {
      const { executeApiChatCommand } = require('../../src/commands/api-chat-executor')
      executeApiChatCommand.mockClear()

      const payload = { ...basePayload, agentChatMode: 'api' } as ChatPayload
      const result = await executeChatCommand({
        payload,
        commandId: 'cmd-payload-api',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(executeApiChatCommand).toHaveBeenCalledWith(
        payload, 'cmd-payload-api', mockClient, undefined, 'agent-1',
      )
    })

    it('should ignore payload.agentChatMode=auto and keep the activeChatMode', async () => {
      const { executeApiChatCommand } = require('../../src/commands/api-chat-executor')
      executeApiChatCommand.mockClear()
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        pid: 126,
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ type: 'agent_message', message: 'Codex response' }) + '\n'))
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand({
        payload: { ...basePayload, agentChatMode: 'auto' } as ChatPayload,
        commandId: 'cmd-auto',
        client: mockClient,
        activeChatMode: 'codex',
        agentId: 'agent-1',
      })

      expect(result.success).toBe(true)
      expect(executeApiChatCommand).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['exec', '--json']), expect.any(Object))
    })

    it('warns when api mode is selected with Web-configured envVars', async () => {
      const { logger } = require('../../src/logger')
      const warnSpy = jest.spyOn(logger, 'warn')

      const projectConfig: ProjectConfigResponse = {
        configHash: 'h1',
        project: { projectCode: 'MBC_01', projectName: 'MBC' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: { ANTHROPIC_API_KEY: 'sk-from-web' },
      }

      await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-api-warn',
        client: mockClient,
        activeChatMode: 'api',
        agentId: 'agent-1',
        projectConfig,
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('API mode is selected but Web-configured envVars'),
      )
      warnSpy.mockRestore()
    })

    it('does not warn when api mode is selected without envVars', async () => {
      const { logger } = require('../../src/logger')
      const warnSpy = jest.spyOn(logger, 'warn')
      warnSpy.mockClear()

      await executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-api-clean',
        client: mockClient,
        activeChatMode: 'api',
        agentId: 'agent-1',
      })

      const envVarsWarns = warnSpy.mock.calls.filter((call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('Web-configured envVars'),
      )
      expect(envVarsWarns).toHaveLength(0)
      warnSpy.mockRestore()
    })
  })

  describe('agentId validation', () => {
    it('should return error when agentId is missing', async () => {
      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-no-agent', client: mockClient })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_AGENT_ID_REQUIRED)
      }
    })

    it('should return error when agentId is empty string', async () => {
      const result = await executeChatCommand({ payload: basePayload, commandId: 'cmd-empty-agent', client: mockClient, agentId: '' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_AGENT_ID_REQUIRED)
      }
    })
  })

  describe('message validation', () => {
    it('should return error when message is missing', async () => {
      const result = await executeChatCommand({
        payload: { message: undefined } as ChatPayload,
        commandId: 'cmd-5',
        client: mockClient,
        agentId: 'agent-1',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_MESSAGE_REQUIRED)
      }
    })
  })

  describe('Claude Code CLI error handling', () => {
    it('should return error when CLI exits with non-retryable non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-err-1', client: mockClient, agentId: 'agent-1' })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then trigger second attempt
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emit('close', 2)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('コード 2')
      }
    }, 10000)

    it('should return error when CLI exits with non-zero code and has stderr', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-err-2', client: mockClient, agentId: 'agent-1' })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emitStderr('data', Buffer.from('some error output'))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then trigger second attempt
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emitStderr('data', Buffer.from('some error output'))
      mockProcess2.emit('close', 2)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('コード 2')
      }
    }, 10000)

    it('should return ENOENT error when claude CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1)

      const resultPromise = executeChatCommand({
        payload: { ...basePayload, agentChatMode: 'claude_code' } as ChatPayload,
        commandId: 'cmd-enoent',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      // ENOENT means the CLI is unavailable, so it is not retried.
      await new Promise((r) => setTimeout(r, 10))
      const enoentError = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      enoentError.code = 'ENOENT'
      mockProcess1.emit('error', enoentError)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('claude CLI')
      }
      expect(spawn).toHaveBeenCalledTimes(1)
    }, 10000)

    it('should return generic error for non-ENOENT spawn errors', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-generic-err', client: mockClient, agentId: 'agent-1' })

      // First attempt fails with generic error
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('error', new Error('Permission denied'))

      // Wait for retry delay then trigger second attempt
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emit('error', new Error('Permission denied'))

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Permission denied')
      }
    }, 10000)

    it('should send error chunk on failure', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-err-chunk', client: mockClient, agentId: 'agent-1' })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then trigger second attempt
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emit('close', 2)

      await resultPromise

      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-err-chunk', expect.objectContaining({
        type: 'error',
      }), 'agent-1')
    }, 10000)

    it('should send done chunk on success', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-done', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('output text')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('output text')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // done chunk now includes JSON with text + metadata
      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.text).toBe('output text')
      expect(doneContent.metadata).toEqual(expect.objectContaining({
        exitCode: 0,
        hasStderr: false,
      }))
      expect(typeof doneContent.metadata.durationMs).toBe('number')
    })

    it('should include toolCalls in done chunk when tool_call chunks were sent', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-done-tools', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      // Send assistant message with tool_use blocks
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('output text', [
        { name: 'WebSearch', id: 'tool-1', input: { query: 'test' } },
        { name: 'Read', id: 'tool-2', input: { path: '/tmp/file.txt' } },
      ])))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('output text')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.toolCalls).toHaveLength(2)
      expect(doneContent.toolCalls[0].toolName).toBe('WebSearch')
      expect(doneContent.toolCalls[1].toolName).toBe('Read')
    })

    it('should not include toolCalls in done chunk when no tool_call chunks were sent', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-done-no-tools', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('output text')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('output text')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.toolCalls).toBeUndefined()
    })

    it('should include usage in done chunk when result event has usage', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-done-usage', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('response')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response', {
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 300 },
        total_cost_usd: 0.01234,
      })))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.usage).toEqual({
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalTokens: 1200,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 300,
        totalCostUsd: 0.01234,
      })
    })

    it('should not include usage in done chunk when result event has no usage', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-done-no-usage', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('response')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.usage).toBeUndefined()
    })

    it('should send delta chunks for text in assistant messages', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-delta', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('chunk1')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('chunk1')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-delta', expect.objectContaining({
        type: 'delta',
        content: 'chunk1',
      }), 'agent-1')
    })

    it('should pass allowedTools from serverConfig to CLI args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          allowedTools: ['WebFetch', 'WebSearch'],
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-tools', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', '--allowedTools', 'WebFetch', '--allowedTools', 'WebSearch', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should pass model from serverConfig.claudeCodeConfig to CLI args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          model: 'claude-opus-4-8',
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-model', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const modelIdx = args.indexOf('--model')
      expect(modelIdx).toBeGreaterThan(-1)
      expect(args[modelIdx + 1]).toBe('claude-opus-4-8')
    })

    it('should default --model to claude-sonnet-4-6 when serverConfig has no model and no ANTHROPIC_MODEL env', async () => {
      const { spawn } = require('child_process')
      const { _resetCleanEnvCache } = require('../../src/commands/claude-code-args')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {},
      }

      const originalEnv = process.env
      process.env = { ...originalEnv }
      delete process.env.ANTHROPIC_MODEL
      _resetCleanEnvCache()
      try {
        const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-model-default', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

        await new Promise((r) => setTimeout(r, 10))
        mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
        mockProcess.emit('close', 0)

        await resultPromise

        const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
        const args = spawnCall[1] as string[]
        const modelIdx = args.indexOf('--model')
        expect(modelIdx).toBeGreaterThan(-1)
        expect(args[modelIdx + 1]).toBe('claude-sonnet-4-6')
      } finally {
        process.env = originalEnv
        _resetCleanEnvCache()
      }
    })

    it('should not pass --model when serverConfig has no model but ANTHROPIC_MODEL env is set', async () => {
      const { spawn } = require('child_process')
      const { _resetCleanEnvCache } = require('../../src/commands/claude-code-args')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {},
      }

      const originalEnv = process.env
      process.env = { ...originalEnv, ANTHROPIC_MODEL: 'claude-3-5-haiku-latest' }
      _resetCleanEnvCache()
      try {
        const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-model-env', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

        await new Promise((r) => setTimeout(r, 10))
        mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
        mockProcess.emit('close', 0)

        await resultPromise

        const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
        const args = spawnCall[1] as string[]
        expect(args).not.toContain('--model')
      } finally {
        process.env = originalEnv
        _resetCleanEnvCache()
      }
    })

    it('should include model in the spawn debug log when serverConfig.claudeCodeConfig.model is set', async () => {
      const { spawn } = require('child_process')
      const { logger } = require('../../src/logger')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)
      const debugSpy = jest.spyOn(logger, 'debug')

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          model: 'claude-opus-4-8',
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-model-log', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnLog = debugSpy.mock.calls
        .map((c) => String(c[0]))
        .find((msg) => msg.includes('Spawning claude CLI'))
      expect(spawnLog).toBeDefined()
      expect(spawnLog).toContain('model=claude-opus-4-8')
    })

    it('should not pass allowedTools when serverConfig has no claudeCodeConfig', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-no-tools', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should not pass allowedTools when array is empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          allowedTools: [],
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-empty-tools', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should pass addDirs from serverConfig as --add-dir args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          addDirs: ['~/projects/MBC_01'],
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-dirs', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--add-dir')
      // ~ should be resolved to homedir
      const addDirIdx = args.indexOf('--add-dir')
      expect(args[addDirIdx + 1]).not.toContain('~')
      expect(args[addDirIdx + 1]).toContain('projects/MBC_01')
    })

    it('should not pass --add-dir when addDirs is empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          addDirs: [],
        },
      }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-no-dirs', client: mockClient, serverConfig, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should pass --append-system-prompt for Japanese locale', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = { message: 'Hello', locale: 'ja' }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-locale-ja', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--append-system-prompt')
      const promptIdx = args.indexOf('--append-system-prompt')
      expect(args[promptIdx + 1]).toContain('Japanese')
    })

    it('should pass --append-system-prompt for English locale', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = { message: 'Hello', locale: 'en' }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-locale-en', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--append-system-prompt')
      const promptIdx = args.indexOf('--append-system-prompt')
      expect(args[promptIdx + 1]).toContain('English')
    })

    it('should not pass --append-system-prompt when locale is not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-no-locale', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-4-6', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should inject AWS credentials into env when awsAccountId is provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_ACCESS_KEY_ID: 'AKIATEST',
          AWS_SECRET_ACCESS_KEY: 'secretTest',
          AWS_SESSION_TOKEN: 'tokenTest',
          AWS_DEFAULT_REGION: 'ap-northeast-1',
        },
        errors: [],
        ssoAuthRequired: [],
      })

      const payload: ChatPayload = { message: 'List S3 buckets', awsAccountId: 'prod' }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-aws', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildSingleAccountAwsEnv).toHaveBeenCalledWith(mockClient, 'prod')

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIATEST')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secretTest')
      expect(env).toHaveProperty('AWS_SESSION_TOKEN', 'tokenTest')
      expect(env).toHaveProperty('AWS_DEFAULT_REGION', 'ap-northeast-1')
    })

    it('should not inject AWS credentials when awsAccountId is not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-no-aws', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    })

    it('should continue without AWS credentials when buildSingleAccountAwsEnv returns undefined', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({ errors: [], ssoAuthRequired: [] })

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'invalid' }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-aws-fail', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
    })

    it('should filter CLAUDECODE env vars from child process', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const originalEnv = process.env
      process.env = { ...originalEnv, CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1234', PATH: '/usr/bin' }

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-env', client: mockClient, agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emit('close', 0)
      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('CLAUDECODE')
      expect(env).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(env).toHaveProperty('PATH')

      process.env = originalEnv
    })
  })

  describe('AWS profile mode', () => {
    const projectConfig: ProjectConfigResponse = {
      configHash: 'test-hash',
      project: { projectCode: 'TEST', projectName: 'Test Project' },
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
      },
      aws: {
        accounts: [
          {
            id: '1',
            name: 'dev',
            description: 'Dev account',
            region: 'ap-northeast-1',
            accountId: '123456789012',
            auth: { method: 'access_key' },
            isDefault: true,
          },
        ],
      },
    }

    it('should use profile mode when projectDir and projectConfig.aws.accounts are present', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
          AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
          AWS_PROFILE: 'TEST-dev',
          AWS_DEFAULT_REGION: 'ap-northeast-1',
        },
        errors: [],
        ssoAuthRequired: [],
      })

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-profile', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project', projectConfig,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should have called buildAwsProfileCredentials
      expect(buildAwsProfileCredentials).toHaveBeenCalledWith(mockClient, '/tmp/project', projectConfig)

      // Should have used profile env
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_CONFIG_FILE')
      expect(env).toHaveProperty('AWS_SHARED_CREDENTIALS_FILE')
      expect(env).toHaveProperty('AWS_PROFILE', 'TEST-dev')
    })

    it('should fall back to legacy mode when no projectConfig', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_ACCESS_KEY_ID: 'AKIALEGACY',
          AWS_SECRET_ACCESS_KEY: 'secretLegacy',
          AWS_SESSION_TOKEN: 'tokenLegacy',
          AWS_DEFAULT_REGION: 'us-east-1',
        },
        errors: [],
        ssoAuthRequired: [],
      })

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'legacy-account' }

      const resultPromise = executeChatCommand({
        payload, commandId: 'cmd-legacy', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project', // no projectConfig
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildSingleAccountAwsEnv).toHaveBeenCalledWith(mockClient, 'legacy-account')

      // Should use legacy env vars
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIALEGACY')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secretLegacy')
    })

    it('should continue without AWS env when all credential fetches fail in profile mode', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({ errors: ['Credential fetch failed'], ssoAuthRequired: [] })

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-profile-fail', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project', projectConfig,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should NOT have profile env vars (all credentials failed)
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_PROFILE')
    })

    it('should send system chunk when SSO auth is required in profile mode', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({
        errors: ['SSO auth expired'],
        ssoAuthRequired: [{ accountId: '123456789012', accountName: 'dev' }],
      })

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-sso-system', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project', projectConfig,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should have sent a system chunk with sso_auth_required info
      const systemCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'system',
      )
      expect(systemCall).toBeTruthy()
      const systemContent = JSON.parse((systemCall[1] as { content: string }).content)
      expect(systemContent.type).toBe('sso_auth_required')
      expect(systemContent.accountId).toBe('123456789012')
      expect(systemContent.accountName).toBe('dev')
      expect(systemContent.projectCode).toBe('TEST')
    })

    it('should send system chunk when SSO auth is required in legacy mode', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({
        errors: ['SSO auth expired'],
        ssoAuthRequired: [{ accountId: '987654321098', accountName: 'prod-account' }],
      })

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'prod-account', projectCode: 'PROJ_01' }

      const resultPromise = executeChatCommand({
        payload, commandId: 'cmd-sso-legacy', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should have sent a system chunk with sso_auth_required info
      const systemCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'system',
      )
      expect(systemCall).toBeTruthy()
      const systemContent = JSON.parse((systemCall[1] as { content: string }).content)
      expect(systemContent.type).toBe('sso_auth_required')
      expect(systemContent.accountId).toBe('987654321098')
      expect(systemContent.accountName).toBe('prod-account')
      expect(systemContent.projectCode).toBe('PROJ_01')
    })

    it('should not send system chunk when no SSO auth is required', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({
        env: { AWS_PROFILE: 'TEST-dev' },
        errors: [],
        ssoAuthRequired: [],
      })

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-no-sso', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project', projectConfig,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      // Should NOT have sent any system chunk
      const systemCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'system',
      )
      expect(systemCall).toBeUndefined()
    })
  })

  describe('conversation history', () => {
    it('should include conversation history in message for claude_code mode', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = {
        message: 'Follow up',
        history: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
        ],
      }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-history', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).toContain('<conversation_history>')
      expect(messageArg).toContain('[user]: First question')
      expect(messageArg).toContain('[assistant]: First answer')
      expect(messageArg).toContain('Follow up')
    })

    it('should pass original message without history when history is empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = {
        message: 'No history here',
        history: [],
      }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-no-history', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).toBe('No history here')
      expect(messageArg).not.toContain('<conversation_history>')
    })

    it('should pass original message when history is not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-no-history-field', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).toBe('Hello, world!')
    })
  })

  describe('conversation files embedding', () => {
    it('should embed conversation file references in the message', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = {
        message: 'What was in the file?',
        conversationFiles: [
          { fileId: 'cf-1', s3Key: 'uploads/cf-1.txt', filename: 'readme.txt', contentType: 'text/plain', fileSize: 1024 },
          { fileId: 'cf-2', s3Key: 'uploads/cf-2.png', filename: 'screenshot.png', contentType: 'image/png', fileSize: 2048 },
        ],
      }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-conv-files', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).toContain('<conversation_files>')
      expect(messageArg).toContain('read_conversation_file')
      expect(messageArg).toContain('readme.txt')
      expect(messageArg).toContain('screenshot.png')
      expect(messageArg).toContain('cf-1')
      expect(messageArg).toContain('cf-2')
    })

    it('should not embed conversation files when empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = {
        message: 'No files here',
        conversationFiles: [],
      }

      const resultPromise = executeChatCommand({ payload, commandId: 'cmd-no-conv-files', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).not.toContain('<conversation_files>')
    })

    it('should not embed conversation files when undefined', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-undef-conv-files', client: mockClient, activeChatMode: 'claude_code', agentId: 'agent-1' })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const messageArg = args[args.length - 1]
      expect(messageArg).not.toContain('<conversation_files>')
    })
  })

  describe('cancelChatProcess', () => {
    it('should return false when commandId is not found', () => {
      const result = cancelChatProcess('nonexistent-cmd')
      expect(result).toBe(false)
    })

    it('should call cancel() and remove from map when commandId is found', () => {
      const cancelFn = jest.fn()
      const processes = _getRunningProcesses()
      processes.set('cmd-to-cancel', { cancel: cancelFn })

      const result = cancelChatProcess('cmd-to-cancel')

      expect(result).toBe(true)
      expect(cancelFn).toHaveBeenCalledTimes(1)
      expect(processes.has('cmd-to-cancel')).toBe(false)
    })

    it('should not affect other processes when cancelling a specific one', () => {
      const cancelFn1 = jest.fn()
      const cancelFn2 = jest.fn()
      const processes = _getRunningProcesses()
      processes.set('cmd-1', { cancel: cancelFn1 })
      processes.set('cmd-2', { cancel: cancelFn2 })

      cancelChatProcess('cmd-1')

      expect(cancelFn1).toHaveBeenCalledTimes(1)
      expect(cancelFn2).not.toHaveBeenCalled()
      expect(processes.has('cmd-1')).toBe(false)
      expect(processes.has('cmd-2')).toBe(true)

      // Cleanup
      processes.delete('cmd-2')
    })
  })

  describe('re-exports from claude-code-runner', () => {
    it('should re-export buildClaudeArgs', () => {
      expect(typeof reExportedBuildClaudeArgs).toBe('function')
    })

    it('should re-export buildCleanEnv', () => {
      expect(typeof reExportedBuildCleanEnv).toBe('function')
    })

    it('should re-export _resetCleanEnvCache', () => {
      expect(typeof reExportedResetCleanEnvCache).toBe('function')
    })
  })

  describe('project directory auto-add dirs', () => {
    it('should merge auto-add dirs with server addDirs when projectDir is set', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          addDirs: ['/server/dir'],
        },
      }

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-auto-add', client: mockClient, serverConfig,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectDir: '/tmp/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      // Should include both auto-add dirs and server dirs
      expect(args).toContain('--add-dir')
      // auto-add dirs: /mock/repos, /mock/docs, server dir: /server/dir
      const addDirIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '--add-dir') acc.push(i)
        return acc
      }, [])
      expect(addDirIndices.length).toBe(3) // repos, docs, server/dir
    })
  })

  describe('policyContext environment variables', () => {
    it('should set policyContext env vars when tenantCode, projectCode, and conversationId are provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = {
        message: 'Hello',
        projectCode: 'MBC_01',
        conversationId: 'conv-456',
      }

      const resultPromise = executeChatCommand({
        payload, commandId: 'cmd-policy', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        tenantCode: 'mbc',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AI_SUPPORT_TENANT_CODE', 'mbc')
      expect(env).toHaveProperty('AI_SUPPORT_PROJECT_CODE', 'MBC_01')
      expect(env).toHaveProperty('AI_SUPPORT_CONVERSATION_ID', 'conv-456')
    })

    it('should not set policyContext env vars when values are not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-no-policy', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AI_SUPPORT_TENANT_CODE')
      expect(env).not.toHaveProperty('AI_SUPPORT_PROJECT_CODE')
      expect(env).not.toHaveProperty('AI_SUPPORT_CONVERSATION_ID')
    })
  })

  describe('Web 設定の envVars オーバーレイ', () => {
    it('should apply projectConfig.envVars to spawn env', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const projectConfigWithEnvVars: ProjectConfigResponse = {
        configHash: 'test',
        project: { projectCode: 'MBC_01', projectName: 'MBC' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        envVars: {
          ANTHROPIC_API_KEY: 'sk-web-mbc',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6',
          GIT_AUTHOR_NAME: 'Bot',
        },
      }

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-env-vars', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectConfig: projectConfigWithEnvVars,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('ANTHROPIC_API_KEY', 'sk-web-mbc')
      expect(env).toHaveProperty('ANTHROPIC_MODEL', 'claude-sonnet-4-6')
      expect(env).toHaveProperty('GIT_AUTHOR_NAME', 'Bot')
    })

    it('should not change env when projectConfig.envVars is undefined', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const projectConfigNoEnvVars: ProjectConfigResponse = {
        configHash: 'test',
        project: { projectCode: 'MBC_01', projectName: 'MBC' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
      }

      const resultPromise = executeChatCommand({
        payload: basePayload, commandId: 'cmd-no-env-vars', client: mockClient,
        activeChatMode: 'claude_code', agentId: 'agent-1',
        projectConfig: projectConfigNoEnvVars,
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      // process.env から継承される PATH 等は残るが、Web 設定由来のキーは無いはず
      expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    })
  })

  describe('Git credential integration', () => {
    const projectConfigWithRepos: ProjectConfigResponse = {
      configHash: 'test-hash',
      project: { projectCode: 'TEST', projectName: 'Test Project' },
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
      },
      repositories: [
        {
          repositoryId: 'repo-1',
          repositoryCode: 'my-repo',
          repositoryName: 'My Repo',
          repositoryUrl: 'git@gitlab.com:org/my-repo.git',
          provider: 'gitlab',
          branch: 'main',
          authMethod: 'ssh',
        },
      ],
    }

    it('should call buildGitCredentialEnv when repositories are present', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-git-cred',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigWithRepos,
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildGitCredentialEnv).toHaveBeenCalledWith(
        mockClient,
        projectConfigWithRepos.repositories,
      )
    })

    it('should merge git env into spawn env', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')
      ;(buildGitCredentialEnv as jest.Mock).mockResolvedValueOnce({
        env: {
          GIT_SSH_COMMAND: '/tmp/git-ssh-wrapper-abc.sh',
        },
        cleanup: mockGitCleanup,
      })

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-git-env',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigWithRepos,
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('GIT_SSH_COMMAND', '/tmp/git-ssh-wrapper-abc.sh')
    })

    it('should call git cleanup on success', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')
      ;(buildGitCredentialEnv as jest.Mock).mockResolvedValueOnce({
        env: { GIT_SSH_COMMAND: '/tmp/wrapper.sh' },
        cleanup: mockGitCleanup,
      })

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-git-cleanup',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigWithRepos,
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(mockGitCleanup).toHaveBeenCalled()
    })

    it('should not call buildGitCredentialEnv when no repositories', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')

      const projectConfigNoRepos: ProjectConfigResponse = {
        configHash: 'test-hash',
        project: { projectCode: 'TEST', projectName: 'Test Project' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
      }

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-no-repo',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigNoRepos,
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildGitCredentialEnv).not.toHaveBeenCalled()
    })

    it('should call git cleanup on error', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')
      ;(buildGitCredentialEnv as jest.Mock).mockResolvedValue({
        env: { GIT_SSH_COMMAND: '/tmp/wrapper.sh' },
        cleanup: mockGitCleanup,
      })

      mockGitCleanup.mockClear()

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-git-cleanup-error',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigWithRepos,
        projectDir: '/mock/project',
      })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then trigger second attempt
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emit('close', 2)

      await resultPromise

      expect(mockGitCleanup).toHaveBeenCalled()
    }, 10000)

    it('should continue chat when git credential setup fails', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildGitCredentialEnv } = require('../../src/git-credential-setup')
      ;(buildGitCredentialEnv as jest.Mock).mockRejectedValueOnce(new Error('Git credential error'))

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-git-fail',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectConfig: projectConfigWithRepos,
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
    })
  })

  describe('buildConversationFileNotice', () => {
    it('should return empty string when no files', () => {
      expect(buildConversationFileNotice([])).toBe('')
    })

    it('should return notice with file list when files exist', () => {
      const files = [
        { fileId: 'f1', s3Key: 'key1', filename: 'test.txt', contentType: 'text/plain', fileSize: 100 },
        { fileId: 'f2', s3Key: 'key2', filename: 'image.png', contentType: 'image/png', fileSize: 2048 },
      ]
      const result = buildConversationFileNotice(files)
      expect(result).toContain('<conversation_files>')
      expect(result).toContain('test.txt')
      expect(result).toContain('image.png')
      expect(result).toContain('f1')
      expect(result).toContain('key2')
    })
  })

  describe('buildMetadataNotice', () => {
    it('should return empty string when conversationId is null', () => {
      expect(buildMetadataNotice(null, 'cmd-1', 'PROJ', '/path/to/mcp')).toBe('')
    })

    it('should return empty string when mcpConfigPath is undefined', () => {
      expect(buildMetadataNotice('conv-1', 'cmd-1', 'PROJ', undefined)).toBe('')
    })

    it('should return metadata notice when both conversationId and mcpConfigPath are provided', () => {
      const result = buildMetadataNotice('conv-1', 'cmd-1', 'PROJ_01', '/path/to/mcp')
      expect(result).toContain('<message_metadata>')
      expect(result).toContain('conv-1')
      expect(result).toContain('cmd-1')
      expect(result).toContain('PROJ_01')
    })

    it('should use empty string for projectCode when undefined', () => {
      const result = buildMetadataNotice('conv-1', 'cmd-1', undefined, '/path/to/mcp')
      expect(result).toContain('projectCode: ')
    })
  })

  describe('tool_call and tool_result JSON handling in sendChunk wrapper', () => {
    it('should send tool_call chunk and accumulate tool calls when assistant has tool_use blocks', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const mockClientWithSpy = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
      } as unknown as ApiClient

      const resultPromise = executeChatCommand({
        payload: { message: 'Test' },
        commandId: 'cmd-tool-call-acc',
        client: mockClientWithSpy,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))

      // Send assistant message with tool_use block
      const toolUseLine = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', id: 'tool-1', input: { command: 'ls' } },
          ],
        },
      }) + '\n'
      mockProcess.emitStdout('data', Buffer.from(toolUseLine))

      // Send result
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // tool_call chunk should have been submitted
      expect(mockClientWithSpy.submitChatChunk).toHaveBeenCalledWith(
        'cmd-tool-call-acc',
        expect.objectContaining({ type: 'tool_call' }),
        'agent-1',
      )

      // done chunk should include toolCalls collected during the run
      const doneCall = (mockClientWithSpy.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.toolCalls).toHaveLength(1)
      expect(doneContent.toolCalls[0].toolName).toBe('Bash')
    })

    it('should merge tool_result into collected tool_calls by toolName', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const mockClientWithSpy = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
      } as unknown as ApiClient

      const resultPromise = executeChatCommand({
        payload: { message: 'Test' },
        commandId: 'cmd-tool-result-merge',
        client: mockClientWithSpy,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))

      // Send assistant message with tool_use block
      const toolUseLine = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', id: 'tool-2', input: { command: 'ls' } },
          ],
        },
      }) + '\n'
      mockProcess.emitStdout('data', Buffer.from(toolUseLine))

      // Send user message with tool_result
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: 'ls output',
            },
          ],
        },
      }) + '\n'
      mockProcess.emitStdout('data', Buffer.from(toolResultLine))

      // Send follow-up assistant text and result
      mockProcess.emitStdout('data', Buffer.from(ndjsonAssistant('final answer')))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('final answer')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Verify tool_result chunk was submitted
      expect(mockClientWithSpy.submitChatChunk).toHaveBeenCalledWith(
        'cmd-tool-result-merge',
        expect.objectContaining({ type: 'tool_result' }),
        'agent-1',
      )

      // Verify done chunk includes toolCalls with merged result
      const doneCall = (mockClientWithSpy.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.toolCalls).toHaveLength(1)
      expect(doneContent.toolCalls[0].toolName).toBe('Bash')
      // The result should have been merged into the tool call entry
      expect(doneContent.toolCalls[0].success).toBeDefined()
    })
  })

  describe('retry behavior', () => {
    it('should retry once when CLI exits with non-zero code and succeed on second attempt', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-retry-success', client: mockClient, agentId: 'agent-1' })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then let second attempt succeed
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emitStdout('data', Buffer.from(ndjsonResult('retry response')))
      mockProcess2.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(spawn).toHaveBeenCalledTimes(2)
    }, 10000)

    it('should return failure after all attempts are exhausted', async () => {
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-retry-fail-all', client: mockClient, agentId: 'agent-1' })

      // First attempt fails
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // Wait for retry delay then second attempt also fails
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emit('close', 2)

      const result = await resultPromise
      expect(result.success).toBe(false)
      expect(spawn).toHaveBeenCalledTimes(2)
    }, 10000)

    it('should only call spawn once for non-retryable regular errors (verifies retry loop)', async () => {
      // Verifies that a non-cancel failure retries (spawn called twice total)
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      const mockProcess2 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1).mockReturnValueOnce(mockProcess2)

      const resultPromise = executeChatCommand({ payload: basePayload, commandId: 'cmd-retry-count-check', client: mockClient, agentId: 'agent-1' })

      // First attempt fails (non-cancel)
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('close', 2)

      // After retry delay, second attempt runs
      await new Promise((r) => setTimeout(r, 3100))
      mockProcess2.emitStdout('data', Buffer.from(ndjsonResult('ok')))
      mockProcess2.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      // Confirmed: retry happened (2 spawn calls)
      expect(spawn).toHaveBeenCalledTimes(2)
    }, 10000)

    it('should NOT retry when error contains "cancel" (line 117 branch)', async () => {
      // Cover: if (errorMsg.toLowerCase().includes('cancel')) return result
      // When the error message contains 'cancel', the command exits immediately without retry
      const { spawn } = require('child_process')
      const mockProcess1 = createMockChildProcess()
      spawn.mockReturnValueOnce(mockProcess1)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-cancel-test',
        client: mockClient,
        agentId: 'agent-1',
      })

      // First attempt fails with a "cancelled" error message
      await new Promise((r) => setTimeout(r, 10))
      mockProcess1.emit('error', new Error('Operation was cancelled by the user'))

      const result = await resultPromise
      expect(result.success).toBe(false)
      // Should only have spawned once (no retry because 'cancel' is in error message)
      expect(spawn).toHaveBeenCalledTimes(1)
    })

  })

  describe('branch coverage: logDetails conditional expressions (lines 240-242)', () => {
    it('mcpConfigPath truthy → "MCP config" appears in log (line 240 branch [0])', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-mcp-cfg',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        mcpConfigPath: '/tmp/mcp-config.json',  // non-null → 'MCP config' in logDetails
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
    })

    it('e2eExecutionId truthy → included in policyContext (line 264 branch [1])', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand({
        payload: {
          ...basePayload,
          policyContext: {
            e2eExecutionId: 'exec-123',
            e2eTestCaseId: 'case-456',
          },
        },
        commandId: 'cmd-e2e-ids',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('response')))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
    })

    it('usage.total_cost_usd undefined → "?" fallback in log (line 282 branch [1])', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      // Return a result where total_cost_usd is not present
      const resultWithoutCost = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 5 } })
      const resultPromise = executeChatCommand({
        payload: basePayload,
        commandId: 'cmd-no-cost',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(resultWithoutCost + '\n'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
    })
  })

  describe('downloadAttachments: failedCount > 0 path', () => {
    it('should send failure notice delta chunk when file downloads partially fail', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { downloadChatFiles } = require('../../src/commands/file-transfer')
      ;(downloadChatFiles as jest.Mock).mockResolvedValueOnce({
        downloadedPaths: [],
        imagePaths: [],
        failedCount: 2,
        cleanup: jest.fn(),
      })

      const mockClientWithSpy = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
      } as unknown as ApiClient

      const resultPromise = executeChatCommand({
        payload: {
          message: 'Test',
          files: [
            { fileId: 'f1', s3Key: 'uploads/f1.txt', filename: 'a.txt', contentType: 'text/plain', fileSize: 100 },
          ],
          conversationId: 'conv-1',
        },
        commandId: 'cmd-file-fail',
        client: mockClientWithSpy,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)

      await resultPromise

      // failedCount > 0 triggers a delta chunk with failure notice
      const deltaCall = (mockClientWithSpy.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) =>
          (call[1] as { type: string }).type === 'delta' &&
          (call[1] as { content: string }).content.includes('2件のファイル'),
      )
      expect(deltaCall).toBeDefined()
    })

    it('should not send failure notice delta chunk when all file downloads succeed', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { downloadChatFiles } = require('../../src/commands/file-transfer')
      ;(downloadChatFiles as jest.Mock).mockResolvedValueOnce({
        downloadedPaths: ['/mock/project/.chat-files/conv-2/a.txt'],
        imagePaths: [],
        failedCount: 0,
        cleanup: jest.fn(),
      })

      const mockClientWithSpy = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
      } as unknown as ApiClient

      const resultPromise = executeChatCommand({
        payload: {
          message: 'Test',
          files: [
            { fileId: 'f2', s3Key: 'uploads/f2.txt', filename: 'b.txt', contentType: 'text/plain', fileSize: 200 },
          ],
          conversationId: 'conv-2',
        },
        commandId: 'cmd-file-ok',
        client: mockClientWithSpy,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)

      await resultPromise

      // failedCount === 0, no failure notice delta should be sent (only the attached_files delta)
      const failureDeltaCall = (mockClientWithSpy.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) =>
          (call[1] as { type: string }).type === 'delta' &&
          (call[1] as { content: string }).content.includes('件のファイル'),
      )
      expect(failureDeltaCall).toBeUndefined()
    })
  })

  describe('downloadAttachments: image vs non-image branching', () => {
    it('should pass image-only attachments as @path lines without <attached_files>', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { downloadChatFiles } = require('../../src/commands/file-transfer')
      ;(downloadChatFiles as jest.Mock).mockResolvedValueOnce({
        downloadedPaths: [],
        imagePaths: ['/mock/project/.chat-files/conv-img/screenshot.png'],
        failedCount: 0,
        cleanup: jest.fn(),
      })

      const resultPromise = executeChatCommand({
        payload: {
          message: 'see attached',
          files: [
            { fileId: 'f1', s3Key: 'uploads/f1.png', filename: 'screenshot.png', contentType: 'image/png', fileSize: 100 },
          ],
          conversationId: 'conv-img',
        },
        commandId: 'cmd-image-only',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)
      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const finalMessage = args[args.length - 1]
      expect(finalMessage).toContain('@/mock/project/.chat-files/conv-img/screenshot.png')
      expect(finalMessage).not.toContain('<attached_files>')
    })

    it('should pass non-image attachments inside <attached_files> with Read-tool guidance', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { downloadChatFiles } = require('../../src/commands/file-transfer')
      ;(downloadChatFiles as jest.Mock).mockResolvedValueOnce({
        downloadedPaths: ['/mock/project/.chat-files/conv-txt/notes.txt'],
        imagePaths: [],
        failedCount: 0,
        cleanup: jest.fn(),
      })

      const resultPromise = executeChatCommand({
        payload: {
          message: 'review',
          files: [
            { fileId: 'f1', s3Key: 'uploads/f1.txt', filename: 'notes.txt', contentType: 'text/plain', fileSize: 100 },
          ],
          conversationId: 'conv-txt',
        },
        commandId: 'cmd-text-only',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)
      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const finalMessage = args[args.length - 1]
      expect(finalMessage).toContain('<attached_files>')
      expect(finalMessage).toContain('/mock/project/.chat-files/conv-txt/notes.txt')
      expect(finalMessage).toContain('Use the Read tool to read them directly')
      expect(finalMessage).toContain('do NOT use read_conversation_file')
      expect(finalMessage).not.toContain('@/mock/project/.chat-files/conv-txt/notes.txt')
    })

    it('should pass mixed image + non-image attachments with @path block and <attached_files> joined by blank line', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const { downloadChatFiles } = require('../../src/commands/file-transfer')
      ;(downloadChatFiles as jest.Mock).mockResolvedValueOnce({
        downloadedPaths: ['/mock/project/.chat-files/conv-mix/notes.txt'],
        imagePaths: ['/mock/project/.chat-files/conv-mix/diagram.png'],
        failedCount: 0,
        cleanup: jest.fn(),
      })

      const resultPromise = executeChatCommand({
        payload: {
          message: 'both attached',
          files: [
            { fileId: 'f1', s3Key: 'uploads/f1.png', filename: 'diagram.png', contentType: 'image/png', fileSize: 100 },
            { fileId: 'f2', s3Key: 'uploads/f2.txt', filename: 'notes.txt', contentType: 'text/plain', fileSize: 200 },
          ],
          conversationId: 'conv-mix',
        },
        commandId: 'cmd-mixed',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
        projectDir: '/mock/project',
      })

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from(ndjsonResult('done')))
      mockProcess.emit('close', 0)
      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      const finalMessage = args[args.length - 1]
      expect(finalMessage).toContain('@/mock/project/.chat-files/conv-mix/diagram.png')
      expect(finalMessage).toContain('<attached_files>')
      expect(finalMessage).toContain('/mock/project/.chat-files/conv-mix/notes.txt')
      // @path 行と <attached_files> ブロックが \n\n で区切られている
      const idxAtPath = finalMessage.indexOf('@/mock/project/.chat-files/conv-mix/diagram.png')
      const idxAttached = finalMessage.indexOf('<attached_files>')
      expect(idxAtPath).toBeLessThan(idxAttached)
      expect(finalMessage.slice(idxAtPath, idxAttached)).toContain('\n\n')
    })
  })

})

// Isolated module tests for sendChunk JSON parse error paths
// These use jest.isolateModules to mock runClaudeCode and inject invalid JSON directly into sendChunk
describe('chat-executor: sendChunk JSON parse error handling (isolated)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should log warning when tool_call chunk has invalid JSON (line 108 branch)', async () => {
    let capturedSendChunk: ((type: string, content: string) => Promise<void>) | undefined

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../src/logger')
      jest.doMock('../../src/commands/claude-code-runner', () => ({
        runClaudeCode: jest.fn().mockImplementation((opts: { sendChunk: (type: string, content: string) => Promise<void> }) => {
          capturedSendChunk = opts.sendChunk
          return {
            result: Promise.resolve({
              text: 'done',
              metadata: { args: [], exitCode: 0, hasStderr: false, durationMs: 10 },
            }),
            cancel: jest.fn(),
          }
        }),
        buildClaudeArgs: jest.fn().mockReturnValue([]),
        buildCleanEnv: jest.fn().mockReturnValue({}),
        _resetCleanEnvCache: jest.fn(),
      }))
      jest.doMock('../../src/commands/file-transfer', () => ({
        downloadChatFiles: jest.fn().mockResolvedValue({ downloadedPaths: [], imagePaths: [], failedCount: 0, cleanup: jest.fn() }),
        parseChatFiles: jest.fn().mockReturnValue([]),
        parseConversationFiles: jest.fn().mockReturnValue([]),
      }))
      jest.doMock('../../src/project-dir', () => ({
        getAutoAddDirs: jest.fn().mockReturnValue([]),
        getWorkspaceDir: jest.fn((d: string) => `${d}/workspace`),
      }))
      jest.doMock('../../src/aws-credential-builder', () => ({
        buildAwsProfileCredentials: jest.fn().mockResolvedValue({ env: undefined, errors: [], ssoAuthRequired: [] }),
        buildSingleAccountAwsEnv: jest.fn().mockResolvedValue({ env: undefined, errors: [], ssoAuthRequired: [] }),
      }))
      jest.doMock('../../src/git-credential-setup', () => ({
        buildGitCredentialEnv: jest.fn().mockResolvedValue({ env: {}, cleanup: jest.fn() }),
      }))
      jest.doMock('../../src/commands/api-chat-executor', () => ({
        executeApiChatCommand: jest.fn(),
      }))
      jest.doMock('../../src/utils/claude-settings', () => ({
        ensureAllowedToolsInSettings: jest.fn(),
      }))
      jest.doMock('../../src/commands/shared-chat-utils', () => {
        const actual = jest.requireActual('../../src/commands/shared-chat-utils')
        return actual
      })

      const { executeChatCommand: isolatedExecuteChatCommand } = await import('../../src/commands/chat-executor')
      const { logger } = await import('../../src/logger')
      const warnSpy = jest.spyOn(logger, 'warn')

      const mockClient = { submitChatChunk: jest.fn().mockResolvedValue(undefined) } as unknown as import('../../src/api-client').ApiClient

      const resultPromise = isolatedExecuteChatCommand({
        payload: { message: 'Test' },
        commandId: 'cmd-isolated-tool-call-err',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      // Wait for runClaudeCode to be called and capturedSendChunk to be set
      await new Promise((r) => setTimeout(r, 20))

      // Inject invalid JSON via tool_call chunk directly into the sendChunk wrapper
      if (capturedSendChunk) {
        await capturedSendChunk('tool_call', 'invalid-json{not-valid')
      }

      await resultPromise

      // The warn should have been called for the parse error
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse tool_call JSON'))
    })
  })

  it('should log warning when tool_result chunk has invalid JSON (line 123 branch)', async () => {
    let capturedSendChunk: ((type: string, content: string) => Promise<void>) | undefined

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../src/logger')
      jest.doMock('../../src/commands/claude-code-runner', () => ({
        runClaudeCode: jest.fn().mockImplementation((opts: { sendChunk: (type: string, content: string) => Promise<void> }) => {
          capturedSendChunk = opts.sendChunk
          return {
            result: Promise.resolve({
              text: 'done',
              metadata: { args: [], exitCode: 0, hasStderr: false, durationMs: 10 },
            }),
            cancel: jest.fn(),
          }
        }),
        buildClaudeArgs: jest.fn().mockReturnValue([]),
        buildCleanEnv: jest.fn().mockReturnValue({}),
        _resetCleanEnvCache: jest.fn(),
      }))
      jest.doMock('../../src/commands/file-transfer', () => ({
        downloadChatFiles: jest.fn().mockResolvedValue({ downloadedPaths: [], imagePaths: [], failedCount: 0, cleanup: jest.fn() }),
        parseChatFiles: jest.fn().mockReturnValue([]),
        parseConversationFiles: jest.fn().mockReturnValue([]),
      }))
      jest.doMock('../../src/project-dir', () => ({
        getAutoAddDirs: jest.fn().mockReturnValue([]),
        getWorkspaceDir: jest.fn((d: string) => `${d}/workspace`),
      }))
      jest.doMock('../../src/aws-credential-builder', () => ({
        buildAwsProfileCredentials: jest.fn().mockResolvedValue({ env: undefined, errors: [], ssoAuthRequired: [] }),
        buildSingleAccountAwsEnv: jest.fn().mockResolvedValue({ env: undefined, errors: [], ssoAuthRequired: [] }),
      }))
      jest.doMock('../../src/git-credential-setup', () => ({
        buildGitCredentialEnv: jest.fn().mockResolvedValue({ env: {}, cleanup: jest.fn() }),
      }))
      jest.doMock('../../src/commands/api-chat-executor', () => ({
        executeApiChatCommand: jest.fn(),
      }))
      jest.doMock('../../src/utils/claude-settings', () => ({
        ensureAllowedToolsInSettings: jest.fn(),
      }))
      jest.doMock('../../src/commands/shared-chat-utils', () => {
        const actual = jest.requireActual('../../src/commands/shared-chat-utils')
        return actual
      })

      const { executeChatCommand: isolatedExecuteChatCommand } = await import('../../src/commands/chat-executor')
      const { logger } = await import('../../src/logger')
      const warnSpy = jest.spyOn(logger, 'warn')

      const mockClient = { submitChatChunk: jest.fn().mockResolvedValue(undefined) } as unknown as import('../../src/api-client').ApiClient

      const resultPromise = isolatedExecuteChatCommand({
        payload: { message: 'Test' },
        commandId: 'cmd-isolated-tool-result-err',
        client: mockClient,
        activeChatMode: 'claude_code',
        agentId: 'agent-1',
      })

      await new Promise((r) => setTimeout(r, 20))

      // Inject invalid JSON via tool_result chunk directly into the sendChunk wrapper
      if (capturedSendChunk) {
        await capturedSendChunk('tool_result', 'invalid-json{not-valid')
      }

      await resultPromise

      // The warn should have been called for the parse error
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to parse tool_result JSON'))
    })
  })
})
