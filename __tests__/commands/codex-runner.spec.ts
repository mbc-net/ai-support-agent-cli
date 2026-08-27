import os from 'os'
import fs from 'fs'
import path from 'path'

import { LOG_STDERR_ON_FAILURE_LIMIT } from '../../src/constants'
import { ERR_CODEX_AUTH_INVALID, _resetCodexSandboxWarning, buildCodexArgs, buildCodexMcpConfigOverrides, formatCodexExitError, isCodexAuthError, redactCodexArgs, runCodex } from '../../src/commands/codex-runner'
import { logger } from '../../src/logger'
import { createMockChildProcess } from '../helpers/mock-factory'

jest.mock('../../src/logger')

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

describe('codex-runner', () => {
  describe('buildCodexArgs', () => {
    const originalDockerValue = process.env.AI_SUPPORT_AGENT_IN_DOCKER
    const originalSandboxValue = process.env.CODEX_SANDBOX_MODE
    const originalK8sValue = process.env.KUBERNETES_SERVICE_HOST

    beforeEach(() => {
      delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
      delete process.env.CODEX_SANDBOX_MODE
      delete process.env.KUBERNETES_SERVICE_HOST
      // サンドボックス無効の警告はプロセス寿命で1回しか出ないため、リセット
      // しないと「先に走ったテストが1回目を消費して次のテストでは出ない」
      // というテスト間汚染が起きる。
      _resetCodexSandboxWarning()
    })

    afterEach(() => {
      if (originalDockerValue === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
      else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerValue
      if (originalSandboxValue === undefined) delete process.env.CODEX_SANDBOX_MODE
      else process.env.CODEX_SANDBOX_MODE = originalSandboxValue
      if (originalK8sValue === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = originalK8sValue
    })

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

    it('uses danger-full-access sandbox when running inside Docker', () => {
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    })

    it('allows CODEX_SANDBOX_MODE to override the Docker default', () => {
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
      process.env.CODEX_SANDBOX_MODE = 'workspace-write'

      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    })

    // Kubernetes の Pod は AI_SUPPORT_AGENT_IN_DOCKER を立てないため、以前は
    // 「コンテナではない」と判定されて workspace-write（bwrap 必須）になり、
    // CAP_SYS_ADMIN の無い Pod で `bwrap: Creating new namespace failed:
    // Operation not permitted` になっていた。Docker と同じくコンテナ境界が
    // あるので、同じ扱いにする。
    it('uses danger-full-access sandbox when running on Kubernetes', () => {
      process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    })

    it('treats an empty KUBERNETES_SERVICE_HOST as not Kubernetes', () => {
      process.env.KUBERNETES_SERVICE_HOST = ''

      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    })

    it('keeps the sandbox enabled when neither Docker nor Kubernetes is detected', () => {
      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    })

    it('allows CODEX_SANDBOX_MODE to override the Kubernetes default', () => {
      process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'
      process.env.CODEX_SANDBOX_MODE = 'workspace-write'

      const args = buildCodexArgs('hello')

      expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    })

    it('allows the sandboxMode option to override the Kubernetes default', () => {
      process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

      const args = buildCodexArgs('hello', { sandboxMode: 'read-only' })

      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    })

    it('prefers the sandboxMode option over CODEX_SANDBOX_MODE', () => {
      process.env.CODEX_SANDBOX_MODE = 'danger-full-access'

      const args = buildCodexArgs('hello', { sandboxMode: 'read-only' })

      expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    })

    it('falls back to the environment default when the configured value is invalid', () => {
      process.env.CODEX_SANDBOX_MODE = 'bogus-mode'

      expect(buildCodexArgs('hello')[buildCodexArgs('hello').indexOf('--sandbox') + 1]).toBe('workspace-write')

      process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

      const k8sArgs = buildCodexArgs('hello')

      expect(k8sArgs[k8sArgs.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    })

    it('falls back to the environment default when sandboxMode is blank or invalid', () => {
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      expect(buildCodexArgs('hello', { sandboxMode: '   ' })[4]).toBe('danger-full-access')
      expect(buildCodexArgs('hello', { sandboxMode: 'nope' })[4]).toBe('danger-full-access')
    })

    // codex の OS サンドボックスが外れた状態（danger-full-access）は、
    // ワークスペース外書き込みとネットワーク制限がすべて無効になる。spawn ログは
    // logger.debug のため --verbose 無しでは抑制され、運用者からは見えなかった。
    describe('sandbox disable warning', () => {
      const sandboxWarnings = (): string[] =>
        (logger.warn as jest.Mock).mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes('danger-full-access'))

      beforeEach(() => {
        jest.clearAllMocks()
      })

      it('warns with the Kubernetes detection basis when the sandbox is disabled', () => {
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

        buildCodexArgs('hello')

        const warnings = sandboxWarnings()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('[chat]')
        expect(warnings[0]).toContain('Kubernetes')
        expect(warnings[0]).toContain('KUBERNETES_SERVICE_HOST')
      })

      it('warns with the Docker detection basis when the sandbox is disabled', () => {
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

        buildCodexArgs('hello')

        const warnings = sandboxWarnings()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('Docker')
        expect(warnings[0]).toContain('AI_SUPPORT_AGENT_IN_DOCKER')
      })

      it('reports both runtimes when Docker and Kubernetes are detected together', () => {
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

        buildCodexArgs('hello')

        const warnings = sandboxWarnings()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('Docker')
        expect(warnings[0]).toContain('Kubernetes')
      })

      it('warns only once per process even when codex runs repeatedly', () => {
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

        buildCodexArgs('hello')
        buildCodexArgs('hello again')
        buildCodexArgs('hello once more')

        expect(sandboxWarnings()).toHaveLength(1)
      })

      it('does not warn while the sandbox stays enabled', () => {
        buildCodexArgs('hello')

        expect(sandboxWarnings()).toHaveLength(0)
        expect(buildCodexArgs('hello')[4]).toBe('workspace-write')
      })

      it('does not warn for an explicit sandbox mode that keeps the sandbox on', () => {
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'
        process.env.CODEX_SANDBOX_MODE = 'read-only'

        buildCodexArgs('hello')

        expect(sandboxWarnings()).toHaveLength(0)
      })

      // 意図的な指定と環境による自動フォールバックは、運用者が「設定を直すべきか
      // 環境の制約か」を切り分けられるよう文言で区別する。
      it('distinguishes an explicit CODEX_SANDBOX_MODE from the container fallback', () => {
        process.env.CODEX_SANDBOX_MODE = 'danger-full-access'

        buildCodexArgs('hello')

        const warnings = sandboxWarnings()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('CODEX_SANDBOX_MODE')
        expect(warnings[0]).not.toContain('detected')
      })

      it('distinguishes an explicit sandboxMode option from the container fallback', () => {
        buildCodexArgs('hello', { sandboxMode: 'danger-full-access' })

        const warnings = sandboxWarnings()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain('sandboxMode')
        expect(warnings[0]).not.toContain('detected')
      })

      it('warns again after _resetCodexSandboxWarning', () => {
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'

        buildCodexArgs('hello')
        buildCodexArgs('hello')
        expect(sandboxWarnings()).toHaveLength(1)

        _resetCodexSandboxWarning()
        buildCodexArgs('hello')

        expect(sandboxWarnings()).toHaveLength(2)
      })
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

  describe('runCodex', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('should resolve with text on success (code 0)', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      mockProcess.emitStdout('data', Buffer.from(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'response text' },
      }) + '\n'))
      mockProcess.emit('close', 0)

      const result = await handle.result
      expect(result.metadata.exitCode).toBe(0)
    })

    it('should reject when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      mockProcess.emit('close', 1)

      await expect(handle.result).rejects.toThrow('コード 1')
    })

    it('should reject with an actionable auth error when stderr indicates an invalidated session', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      mockProcess.emitStderr('data', Buffer.from('Your session has ended. Please log in again.\n'))
      mockProcess.emit('close', 1)

      await expect(handle.result).rejects.toThrow(ERR_CODEX_AUTH_INVALID)
    })

    it('should reject with ENOENT error when codex CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      const enoentError = new Error('spawn codex ENOENT') as NodeJS.ErrnoException
      enoentError.code = 'ENOENT'
      mockProcess.emit('error', enoentError)

      await expect(handle.result).rejects.toThrow()
    })

    it('should log the captured stderr at warn level when the CLI exits non-zero (so it is visible without --verbose)', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      mockProcess.emitStderr('data', Buffer.from('Error: some internal codex CLI failure detail\n'))
      mockProcess.emit('close', 1)

      await expect(handle.result).rejects.toThrow()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('some internal codex CLI failure detail'),
      )
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/pid=12345/),
      )
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/code=1/),
      )
    })

    it('should not log a stderr warning when the CLI exits with code 0 (success)', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      mockProcess.emitStderr('data', Buffer.from('some informational noise\n'))
      mockProcess.emit('close', 0)

      await handle.result

      const stderrWarnCalls = (logger.warn as jest.Mock).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('codex CLI'),
      )
      expect(stderrWarnCalls).toHaveLength(0)
    })

    it('should redact known secret env values from the stderr before logging at warn level', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const secretValue = 'sk-codex-super-secret-abc123'

      const handle = runCodex({
        message: 'hello',
        sendChunk,
        envVarsOverride: { CODEX_API_KEY: secretValue },
      })

      mockProcess.emitStderr('data', Buffer.from(`Error: invalid key ${secretValue} rejected\n`))
      mockProcess.emit('close', 1)

      await expect(handle.result).rejects.toThrow()

      const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('codex CLI failed'),
      )
      expect(warnCalls).toHaveLength(1)
      const [loggedMessage] = warnCalls[0]
      expect(loggedMessage).not.toContain(secretValue)
      expect(loggedMessage).toContain('***')
    })

    it('should keep the most recent (tail) portion of long stderr, not the head, when truncating for the warn log', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const handle = runCodex({ message: 'hello', sendChunk })

      const headMarker = 'HEAD_MARKER_SHOULD_BE_DROPPED'
      const tailMarker = 'TAIL_MARKER_FATAL_ERROR'
      const filler = 'x'.repeat(LOG_STDERR_ON_FAILURE_LIMIT + 100)
      mockProcess.emitStderr('data', Buffer.from(`${headMarker}${filler}${tailMarker}`))
      mockProcess.emit('close', 1)

      await expect(handle.result).rejects.toThrow()

      const warnCalls = (logger.warn as jest.Mock).mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('codex CLI failed'),
      )
      expect(warnCalls).toHaveLength(1)
      const [loggedMessage] = warnCalls[0]
      expect(loggedMessage).toContain(tailMarker)
      expect(loggedMessage).not.toContain(headMarker)
    })
  })
})

// ---------------------------------------------------------------------------
// chat 経路の env 上書きで Codex サンドボックスを外せないこと（A3）
//
// 従来 runCodex は「マージ済み env」から sandboxMode を読み戻していたため、
// ENV#CODEX_SANDBOX_MODE=danger-full-access を設定するだけで、コンテナ境界の
// 無いベアメタルホスト上でも Codex のサンドボックスが外れていた。
// ---------------------------------------------------------------------------
describe('runCodex sandbox mode is not attacker-controllable', () => {
  const originalDockerValue = process.env.AI_SUPPORT_AGENT_IN_DOCKER
  const originalSandboxValue = process.env.CODEX_SANDBOX_MODE
  const originalK8sValue = process.env.KUBERNETES_SERVICE_HOST

  const spawnArgs = (): string[] => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process') as { spawn: jest.Mock }
    return spawn.mock.calls[0][1] as string[]
  }

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
    delete process.env.CODEX_SANDBOX_MODE
    delete process.env.KUBERNETES_SERVICE_HOST
    _resetCodexSandboxWarning()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _resetCleanEnvCache } = require('../../src/commands/claude-code-args') as {
      _resetCleanEnvCache: () => void
    }
    _resetCleanEnvCache()
  })

  afterEach(() => {
    if (originalDockerValue === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
    else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerValue
    if (originalSandboxValue === undefined) delete process.env.CODEX_SANDBOX_MODE
    else process.env.CODEX_SANDBOX_MODE = originalSandboxValue
    if (originalK8sValue === undefined) delete process.env.KUBERNETES_SERVICE_HOST
    else process.env.KUBERNETES_SERVICE_HOST = originalK8sValue
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { _resetCleanEnvCache } = require('../../src/commands/claude-code-args') as {
      _resetCleanEnvCache: () => void
    }
    _resetCleanEnvCache()
  })

  it('ignores CODEX_SANDBOX_MODE supplied through envVarsOverride', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process')
    const mockProcess = createMockChildProcess()
    spawn.mockReturnValue(mockProcess)

    const sendChunk = jest.fn().mockResolvedValue(undefined)
    const handle = runCodex({
      message: 'hello',
      sendChunk,
      envVarsOverride: { CODEX_SANDBOX_MODE: 'danger-full-access' },
    })
    mockProcess.emit('close', 0)
    await handle.result

    const args = spawnArgs()
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    // 値そのものが子プロセスの env にも渡らないこと
    const spawnEnv = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env
    expect(spawnEnv.CODEX_SANDBOX_MODE).toBeUndefined()
  })

  it('still honours the real process CODEX_SANDBOX_MODE (operator-set)', async () => {
    process.env.CODEX_SANDBOX_MODE = 'read-only'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process')
    const mockProcess = createMockChildProcess()
    spawn.mockReturnValue(mockProcess)

    const sendChunk = jest.fn().mockResolvedValue(undefined)
    const handle = runCodex({ message: 'hello', sendChunk })
    mockProcess.emit('close', 0)
    await handle.result

    const args = spawnArgs()
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  it('still disables the sandbox inside Docker (container boundary provides isolation)', async () => {
    process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process')
    const mockProcess = createMockChildProcess()
    spawn.mockReturnValue(mockProcess)

    const sendChunk = jest.fn().mockResolvedValue(undefined)
    const handle = runCodex({ message: 'hello', sendChunk })
    mockProcess.emit('close', 0)
    await handle.result

    const args = spawnArgs()
    expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
  })

  it('still disables the sandbox on Kubernetes', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process')
    const mockProcess = createMockChildProcess()
    spawn.mockReturnValue(mockProcess)

    const sendChunk = jest.fn().mockResolvedValue(undefined)
    const handle = runCodex({ message: 'hello', sendChunk })
    mockProcess.emit('close', 0)
    await handle.result

    const args = spawnArgs()
    expect(args[args.indexOf('--sandbox') + 1]).toBe('danger-full-access')
  })

  it('still applies non-denylisted envVarsOverride entries to the child env', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('child_process')
    const mockProcess = createMockChildProcess()
    spawn.mockReturnValue(mockProcess)

    const sendChunk = jest.fn().mockResolvedValue(undefined)
    const handle = runCodex({
      message: 'hello',
      sendChunk,
      envVarsOverride: { OPENAI_MODEL: 'gpt-x', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
    })
    mockProcess.emit('close', 0)
    await handle.result

    const spawnEnv = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env
    expect(spawnEnv.OPENAI_MODEL).toBe('gpt-x')
    expect(spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-xxx')
  })
})
