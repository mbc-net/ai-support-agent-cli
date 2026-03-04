import os from 'os'

import { ERR_CLAUDE_CLI_NOT_FOUND } from '../../src/constants'
import { buildClaudeArgs, buildCleanEnv, parseFileUploadResult, processStreamJsonLine, runClaudeCode } from '../../src/commands/claude-code-runner'
import { createMockChildProcess } from '../helpers/mock-factory'

jest.mock('../../src/logger')

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

/** NDJSON行を作るヘルパー */
function makeAssistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })
}

function makeToolUseLine(name: string, id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id }] },
  })
}

function makeResultLine(result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result,
  })
}

function makeInitLine(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    tools: ['Read', 'Write'],
    mcp_servers: [],
  })
}

describe('claude-code-runner', () => {
  describe('buildCleanEnv', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = process.env
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should exclude CLAUDECODE', () => {
      process.env = { CLAUDECODE: '1', HOME: '/home/user' }
      const result = buildCleanEnv()
      expect(result).not.toHaveProperty('CLAUDECODE')
      expect(result).toHaveProperty('HOME', '/home/user')
    })

    it('should exclude CLAUDE_CODE_* variables', () => {
      process.env = { CLAUDE_CODE_SSE_PORT: '1234', CLAUDE_CODE_FOO: 'bar', PATH: '/usr/bin' }
      const result = buildCleanEnv()
      expect(result).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(result).not.toHaveProperty('CLAUDE_CODE_FOO')
      expect(result).toHaveProperty('PATH', '/usr/bin')
    })

    it('should keep CLAUDE_CODE_OAUTH_TOKEN', () => {
      process.env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-xxx', CLAUDE_CODE_SSE_PORT: '1234', PATH: '/usr/bin' }
      const result = buildCleanEnv()
      expect(result).toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-xxx')
      expect(result).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(result).toHaveProperty('PATH', '/usr/bin')
    })

    it('should keep other environment variables', () => {
      process.env = { NODE_ENV: 'test', HOME: '/home/user', LANG: 'en_US.UTF-8' }
      const result = buildCleanEnv()
      expect(result).toEqual({ NODE_ENV: 'test', HOME: '/home/user', LANG: 'en_US.UTF-8' })
    })

    it('should exclude undefined values', () => {
      process.env = { DEFINED: 'yes' }
      const result = buildCleanEnv()
      expect(result).toHaveProperty('DEFINED', 'yes')
      for (const value of Object.values(result)) {
        expect(value).toBeDefined()
      }
    })
  })

  describe('buildClaudeArgs', () => {
    const BASE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose']

    it('should return base args + message for basic message', () => {
      const result = buildClaudeArgs('hello')
      expect(result).toEqual([...BASE_ARGS, 'hello'])
    })

    it('should add --allowedTools for each tool', () => {
      const result = buildClaudeArgs('hello', { allowedTools: ['WebFetch', 'WebSearch'] })
      expect(result).toEqual([...BASE_ARGS, '--allowedTools', 'WebFetch', '--allowedTools', 'WebSearch', 'hello'])
    })

    it('should add --add-dir for each directory', () => {
      const result = buildClaudeArgs('hello', { addDirs: ['/tmp/project'] })
      expect(result).toEqual([...BASE_ARGS, '--add-dir', '/tmp/project', 'hello'])
    })

    it('should resolve ~ to homedir in addDirs', () => {
      const result = buildClaudeArgs('hello', { addDirs: ['~/projects/MBC_01'] })
      expect(result).toContain('--add-dir')
      const addDirIdx = result.indexOf('--add-dir')
      expect(result[addDirIdx + 1]).toBe(`${os.homedir()}/projects/MBC_01`)
      expect(result[addDirIdx + 1]).not.toContain('~')
    })

    it('should add --append-system-prompt with Japanese prompt for locale "ja"', () => {
      const result = buildClaudeArgs('hello', { locale: 'ja' })
      expect(result).toContain('--append-system-prompt')
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(result[promptIdx + 1]).toContain('Japanese')
    })

    it('should add --append-system-prompt with English prompt for locale "en"', () => {
      const result = buildClaudeArgs('hello', { locale: 'en' })
      expect(result).toContain('--append-system-prompt')
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(result[promptIdx + 1]).toContain('English')
    })

    it('should not add --append-system-prompt when locale is not provided', () => {
      const result = buildClaudeArgs('hello')
      expect(result).not.toContain('--append-system-prompt')
    })

    it('should not add --allowedTools when array is empty', () => {
      const result = buildClaudeArgs('hello', { allowedTools: [] })
      expect(result).toEqual([...BASE_ARGS, 'hello'])
    })

    it('should not add --add-dir when array is empty', () => {
      const result = buildClaudeArgs('hello', { addDirs: [] })
      expect(result).toEqual([...BASE_ARGS, 'hello'])
    })

    it('should include systemPrompt in --append-system-prompt', () => {
      const result = buildClaudeArgs('hello', { systemPrompt: 'Custom instructions' })
      expect(result).toContain('--append-system-prompt')
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(result[promptIdx + 1]).toContain('Custom instructions')
    })

    it('should combine locale and systemPrompt in single --append-system-prompt', () => {
      const result = buildClaudeArgs('hello', { locale: 'ja', systemPrompt: 'Custom instructions' })
      const promptIdx = result.indexOf('--append-system-prompt')
      const prompt = result[promptIdx + 1]
      expect(prompt).toContain('Japanese')
      expect(prompt).toContain('Custom instructions')
    })

    it('should include file_upload instruction when mcpConfigPath is provided', () => {
      const result = buildClaudeArgs('hello', { mcpConfigPath: '/tmp/mcp.json', locale: 'ja' })
      const promptIdx = result.indexOf('--append-system-prompt')
      const prompt = result[promptIdx + 1]
      expect(prompt).toContain('file_upload')
    })

    it('should add --mcp-config when mcpConfigPath is provided', () => {
      const result = buildClaudeArgs('hello', { mcpConfigPath: '/tmp/mcp.json' })
      expect(result).toContain('--mcp-config')
      const mcpIdx = result.indexOf('--mcp-config')
      expect(result[mcpIdx + 1]).toBe('/tmp/mcp.json')
    })

    it('should handle all options combined', () => {
      const result = buildClaudeArgs('hello', {
        allowedTools: ['WebFetch'],
        addDirs: ['/tmp/dir'],
        locale: 'ja',
      })
      expect(result).toContain('--allowedTools')
      expect(result).toContain('WebFetch')
      expect(result).toContain('--add-dir')
      expect(result).toContain('/tmp/dir')
      expect(result).toContain('--append-system-prompt')
      expect(result[result.length - 1]).toBe('hello')
    })
  })

  describe('processStreamJsonLine', () => {
    it('should extract text from assistant message and send as delta', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeAssistantLine('Hello world')

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(sendChunk).toHaveBeenCalledWith('delta', 'Hello world')
      expect(result.newSentTextLength).toBe(11)
      expect(result.text).toBeUndefined()
    })

    it('should only send new text portion (avoid duplicates)', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeAssistantLine('Hello world, extended text')

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 11 })

      expect(sendChunk).toHaveBeenCalledWith('delta', ', extended text')
      expect(result.newSentTextLength).toBe(26)
    })

    it('should not send delta when no new text', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeAssistantLine('Hello')

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 5 })

      expect(sendChunk).not.toHaveBeenCalledWith('delta', expect.anything())
      expect(result.newSentTextLength).toBe(5)
    })

    it('should send tool_call chunk for tool_use blocks', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeToolUseLine('Write', 'tool-123')

      processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(sendChunk).toHaveBeenCalledWith('tool_call', JSON.stringify({
        name: 'Write',
        id: 'tool-123',
      }))
    })

    it('should extract result text from result event', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeResultLine('Final answer')

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.text).toBe('Final answer')
    })

    it('should handle init event without error', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeInitLine()

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(result.text).toBeUndefined()
    })

    it('should log MCP server connection status from init event', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write', 'mcp__ai-support-agent__file_upload', 'mcp__ai-support-agent__db_query'],
        mcp_servers: [
          { name: 'ai-support-agent', status: 'connected' },
        ],
      })

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(result.text).toBeUndefined()
    })

    it('should log MCP server error from init event', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write'],
        mcp_servers: [
          { name: 'ai-support-agent', status: 'failed', error: 'Connection refused' },
        ],
      })

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(result.text).toBeUndefined()
    })

    it('should handle init event with no tools listed', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
      })

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(result.text).toBeUndefined()
    })

    it('should handle invalid JSON gracefully', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const result = processStreamJsonLine('not json', sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(sendChunk).not.toHaveBeenCalled()
    })

    it('should handle unknown event types gracefully', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = JSON.stringify({ type: 'rate_limit_event' })

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(result.newSentTextLength).toBe(0)
      expect(sendChunk).not.toHaveBeenCalled()
    })

    it('should handle assistant message with mixed text and tool_use blocks', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Creating file...' },
            { type: 'tool_use', name: 'Write', id: 'tool-1' },
          ],
        },
      })

      const result = processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(sendChunk).toHaveBeenCalledWith('delta', 'Creating file...')
      expect(sendChunk).toHaveBeenCalledWith('tool_call', JSON.stringify({ name: 'Write', id: 'tool-1' }))
      expect(result.newSentTextLength).toBe(16)
    })

    it('should track file_upload tool_use and send file_attachment on tool_result', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string> } = { sentTextLength: 0 }

      // Step 1: assistant message with file_upload tool_use
      const toolUseLine = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__ai-support-agent__file_upload', id: 'upload-1' },
          ],
        },
      })
      processStreamJsonLine(toolUseLine, sendChunk, 123, state)

      expect(state.pendingFileUploadIds).toBeDefined()
      expect(state.pendingFileUploadIds!.has('upload-1')).toBe(true)

      // Step 2: user message with tool_result containing file upload result
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'upload-1',
              content: JSON.stringify({ success: true, fileId: 'f1', s3Key: 'tenant/proj/conv/msg/f1_logo.svg', filename: 'logo.svg', contentType: 'image/svg+xml' }),
            },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('file_attachment', JSON.stringify({
        fileId: 'f1',
        s3Key: 'tenant/proj/conv/msg/f1_logo.svg',
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
        fileSize: 0,
      }))
      expect(state.pendingFileUploadIds!.has('upload-1')).toBe(false)
    })

    it('should handle MCP tool_result with array content format', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-2']),
      }

      // MCP tool_result has array content: [{type: "text", text: "..."}]
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'upload-2',
              content: [
                { type: 'text', text: JSON.stringify({ success: true, fileId: 'f2', s3Key: 'tenant/proj/conv/msg/f2_logo.svg', filename: 'mbc-logo.svg', contentType: 'image/svg+xml' }) },
              ],
            },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('file_attachment', JSON.stringify({
        fileId: 'f2',
        s3Key: 'tenant/proj/conv/msg/f2_logo.svg',
        filename: 'mbc-logo.svg',
        contentType: 'image/svg+xml',
        fileSize: 0,
      }))
    })

    it('should skip tool_reference content in MCP tool_result and keep tracking', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-3']),
      }

      // tool_reference block (appears before actual result for MCP tools)
      const toolRefLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'upload-3',
              content: [{ type: 'tool_reference', tool_name: 'mcp__ai-support-agent__file_upload' }],
            },
          ],
        },
      })
      processStreamJsonLine(toolRefLine, sendChunk, 123, state)

      // tool_reference doesn't contain text, so no file_attachment should be sent
      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.anything())
      // ID should still be tracked for the actual result that comes later
      expect(state.pendingFileUploadIds!.has('upload-3')).toBe(true)
    })

    it('should not send file_attachment for non-file_upload tool_results', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string> } = { sentTextLength: 0 }

      // user message with tool_result for a different tool
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'other-tool-1', content: 'some result' },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.anything())
    })

    it('should handle file_upload tool_result with failed result gracefully', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-1']),
      }

      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'upload-1', content: 'Error: File extension not allowed: .exe' },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      // Should not send file_attachment for error results
      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.anything())
    })
  })

  describe('parseFileUploadResult', () => {
    it('should parse valid file upload result', () => {
      const content = JSON.stringify({ success: true, fileId: 'f1', s3Key: 'key', filename: 'test.svg', contentType: 'image/svg+xml', fileSize: 1234 })
      const result = parseFileUploadResult(content)
      expect(result).toEqual({ fileId: 'f1', s3Key: 'key', filename: 'test.svg', contentType: 'image/svg+xml', fileSize: 1234 })
    })

    it('should return null for undefined content', () => {
      expect(parseFileUploadResult(undefined)).toBeNull()
    })

    it('should return null for non-JSON content', () => {
      expect(parseFileUploadResult('Error: something went wrong')).toBeNull()
    })

    it('should return null for non-success result', () => {
      const content = JSON.stringify({ success: false, error: 'failed' })
      expect(parseFileUploadResult(content)).toBeNull()
    })

    it('should return null for missing required fields', () => {
      const content = JSON.stringify({ success: true, fileId: 'f1' })
      expect(parseFileUploadResult(content)).toBeNull()
    })

    it('should default contentType to application/octet-stream', () => {
      const content = JSON.stringify({ success: true, fileId: 'f1', s3Key: 'key', filename: 'test.bin' })
      const result = parseFileUploadResult(content)
      expect(result).toEqual({ fileId: 'f1', s3Key: 'key', filename: 'test.bin', contentType: 'application/octet-stream', fileSize: 0 })
    })

    it('should parse array content format (MCP tool result)', () => {
      const content = [{ type: 'text', text: JSON.stringify({ success: true, fileId: 'f1', s3Key: 'key', filename: 'test.svg', contentType: 'image/svg+xml', fileSize: 5678 }) }]
      const result = parseFileUploadResult(content)
      expect(result).toEqual({ fileId: 'f1', s3Key: 'key', filename: 'test.svg', contentType: 'image/svg+xml', fileSize: 5678 })
    })

    it('should return null for array content without text block', () => {
      const content = [{ type: 'tool_reference', tool_name: 'mcp__ai-support-agent__file_upload' }]
      expect(parseFileUploadResult(content as Array<{ type: string; text?: string }>)).toBeNull()
    })

    it('should return null for empty array content', () => {
      expect(parseFileUploadResult([])).toBeNull()
    })
  })

  describe('runClaudeCode', () => {
    beforeEach(() => {
      jest.clearAllMocks()
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should resolve with text from result event on success', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      // Send NDJSON lines
      mockProcess.emitStdout('data', Buffer.from(makeAssistantLine('response text') + '\n'))
      mockProcess.emitStdout('data', Buffer.from(makeResultLine('response text') + '\n'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.text).toBe('response text')
      expect(result.metadata.exitCode).toBe(0)
      expect(result.metadata.hasStderr).toBe(false)
      expect(typeof result.metadata.durationMs).toBe('number')
    })

    it('should send delta chunks for text in assistant messages', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emitStdout('data', Buffer.from(makeAssistantLine('chunk1') + '\n'))
      mockProcess.emitStdout('data', Buffer.from(makeResultLine('chunk1') + '\n'))
      mockProcess.emit('close', 0)

      await resultPromise
      expect(sendChunk).toHaveBeenCalledWith('delta', 'chunk1')
    })

    it('should reject when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('close', 1)

      await expect(resultPromise).rejects.toThrow('コード 1')
    })

    it('should reject with ENOENT error when claude CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      const enoentError = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      enoentError.code = 'ENOENT'
      mockProcess.emit('error', enoentError)

      await expect(resultPromise).rejects.toThrow(ERR_CLAUDE_CLI_NOT_FOUND)
    })

    it('should reject with original error for non-ENOENT errors', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('error', new Error('Permission denied'))

      await expect(resultPromise).rejects.toThrow('Permission denied')
    })

    it('should pass awsEnv to spawn environment', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const awsEnv = { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }

      const resultPromise = runClaudeCode('hello', sendChunk, undefined, undefined, undefined, awsEnv)

      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[0]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIA')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secret')
    })

    it('should pass cwd to spawn when provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk, undefined, undefined, undefined, undefined, undefined, '/tmp/project')

      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[0]
      expect(spawnCall[2].cwd).toBe('/tmp/project')
    })

    it('should not set cwd when not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[0]
      expect(spawnCall[2].cwd).toBeUndefined()
    })

    it('should send SIGTERM on timeout and SIGKILL if still running', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      // Advance past CHAT_TIMEOUT to trigger SIGTERM
      jest.advanceTimersByTime(300_000)
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')

      // Advance past SIGKILL delay — process not killed yet
      mockProcess.killed = false
      jest.advanceTimersByTime(5_000)
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL')

      // Complete the process to resolve the promise
      mockProcess.emit('close', 1)
      await expect(resultPromise).rejects.toThrow()
    })

    it('should include --output-format stream-json --verbose in args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[0]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--output-format')
      expect(args).toContain('stream-json')
      expect(args).toContain('--verbose')
    })

    it('should handle NDJSON lines split across multiple data events', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      // Split a NDJSON line across two data events
      const fullLine = makeResultLine('split result')
      const half1 = fullLine.substring(0, 10)
      const half2 = fullLine.substring(10) + '\n'

      mockProcess.emitStdout('data', Buffer.from(half1))
      mockProcess.emitStdout('data', Buffer.from(half2))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.text).toBe('split result')
    })
  })
})
