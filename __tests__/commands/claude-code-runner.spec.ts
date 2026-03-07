import os from 'os'

import { ERR_CLAUDE_CLI_NOT_FOUND } from '../../src/constants'
import { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache, parseFileUploadResult, processStreamJsonLine, runClaudeCode } from '../../src/commands/claude-code-runner'
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

function makeToolUseLine(name: string, id: string, input?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
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
      _resetCleanEnvCache()
    })

    afterEach(() => {
      process.env = originalEnv
      _resetCleanEnvCache()
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

    it('should return cached result on subsequent calls', () => {
      process.env = { HOME: '/home/user' }
      const first = buildCleanEnv()
      // Modify process.env — cached result should still be returned
      process.env = { HOME: '/home/other', NEW_VAR: 'new' }
      const second = buildCleanEnv()
      expect(second).toEqual(first)
      expect(second).not.toHaveProperty('NEW_VAR')
    })

    it('should return a copy, not the cached object itself', () => {
      process.env = { HOME: '/home/user' }
      const first = buildCleanEnv()
      first.INJECTED = 'value'
      const second = buildCleanEnv()
      expect(second).not.toHaveProperty('INJECTED')
    })

    it('should refresh after _resetCleanEnvCache', () => {
      process.env = { HOME: '/home/user' }
      buildCleanEnv()
      _resetCleanEnvCache()
      process.env = { HOME: '/home/other' }
      const result = buildCleanEnv()
      expect(result).toHaveProperty('HOME', '/home/other')
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

    it('should send tool_call chunk with toolName and input for tool_use blocks', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeToolUseLine('Write', 'tool-123', { file_path: '/tmp/test.ts', content: 'hello' })

      processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(sendChunk).toHaveBeenCalledWith('tool_call', JSON.stringify({
        toolName: 'Write',
        name: 'Write',
        id: 'tool-123',
        input: { file_path: '/tmp/test.ts', content: 'hello' },
      }))
    })

    it('should send tool_call chunk with empty input when input is undefined', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const line = makeToolUseLine('Read', 'tool-456')

      processStreamJsonLine(line, sendChunk, 123, { sentTextLength: 0 })

      expect(sendChunk).toHaveBeenCalledWith('tool_call', JSON.stringify({
        toolName: 'Read',
        name: 'Read',
        id: 'tool-456',
        input: {},
      }))
    })

    it('should track tool_use_id to tool name mapping in pendingToolNames', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = { sentTextLength: 0 }
      const line = makeToolUseLine('Bash', 'tool-789')

      processStreamJsonLine(line, sendChunk, 123, state)

      expect(state.pendingToolNames).toBeDefined()
      expect(state.pendingToolNames!.get('tool-789')).toBe('Bash')
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
      expect(sendChunk).toHaveBeenCalledWith('tool_call', JSON.stringify({ toolName: 'Write', name: 'Write', id: 'tool-1', input: {} }))
      expect(result.newSentTextLength).toBe(16)
    })

    it('should send tool_result chunk for all tool_results in user messages', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['tool-1', 'Bash']]),
      }

      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'command output here' },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'Bash',
        success: true,
        output: { text: 'command output here' },
      }))
      // pendingToolNames should be cleaned up
      expect(state.pendingToolNames!.has('tool-1')).toBe(false)
    })

    it('should reset sentTextLength after user message so next assistant text is not skipped', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map(),
      }

      // 1. First assistant message with text (20 chars)
      const assistant1 = JSON.stringify({
        type: 'assistant',
        message: { content: [
          { type: 'text', text: 'Sentryを確認します。' },
          { type: 'tool_use', name: 'Bash', id: 'tool-1', input: {} },
        ] },
      })
      const r1 = processStreamJsonLine(assistant1, sendChunk, 123, state)
      expect(r1.newSentTextLength).toBeGreaterThan(0)
      expect(sendChunk).toHaveBeenCalledWith('delta', 'Sentryを確認します。')
      state.sentTextLength = r1.newSentTextLength

      // 2. User message with tool_result → should reset sentTextLength
      const toolResult = JSON.stringify({
        type: 'user',
        message: { content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'result data' },
        ] },
      })
      const r2 = processStreamJsonLine(toolResult, sendChunk, 123, state)
      expect(r2.newSentTextLength).toBe(0) // Reset!
      state.sentTextLength = r2.newSentTextLength

      // 3. Next assistant message with shorter text — should still be sent
      sendChunk.mockClear()
      const assistant2 = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ログを確認' }] },
      })
      const r3 = processStreamJsonLine(assistant2, sendChunk, 123, state)
      expect(sendChunk).toHaveBeenCalledWith('delta', 'ログを確認')
      expect(r3.newSentTextLength).toBeGreaterThan(0)
    })

    it('should send tool_result chunk with JSON output when content is valid JSON', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['tool-2', 'Read']]),
      }

      const jsonOutput = JSON.stringify({ rows: [{ id: 1, name: 'test' }] })
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-2', content: jsonOutput },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'Read',
        success: true,
        output: { rows: [{ id: 1, name: 'test' }] },
      }))
    })

    it('should mark tool_result as error when content starts with Error:', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['tool-3', 'Bash']]),
      }

      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-3', content: 'Error: command not found' },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'Bash',
        success: false,
        output: { text: 'Error: command not found' },
      }))
    })

    it('should use "unknown" as toolName when tool_use_id is not tracked', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = { sentTextLength: 0 }

      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'untracked-id', content: 'some result' },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'unknown',
        success: true,
        output: { text: 'some result' },
      }))
    })

    it('should handle MCP array content in tool_result', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['tool-4', 'mcp__ai-support-agent__db_query']]),
      }

      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-4',
              content: [
                { type: 'text', text: JSON.stringify({ columns: ['id'], rows: [[1]] }) },
              ],
            },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'mcp__ai-support-agent__db_query',
        success: true,
        output: { columns: ['id'], rows: [[1]] },
      }))
    })

    it('should skip tool_reference blocks and not send tool_result for them', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['tool-5', 'mcp__ai-support-agent__db_query']]),
      }

      const toolRefLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-5',
              content: [{ type: 'tool_reference', tool_name: 'mcp__ai-support-agent__db_query' }],
            },
          ],
        },
      })
      processStreamJsonLine(toolRefLine, sendChunk, 123, state)

      expect(sendChunk).not.toHaveBeenCalledWith('tool_result', expect.anything())
      // pendingToolNames should still have the entry (waiting for actual result)
      expect(state.pendingToolNames!.has('tool-5')).toBe(true)
    })

    it('should track file_upload tool_use and send both tool_result and file_attachment on tool_result', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> } = { sentTextLength: 0 }

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
      const fileResult = { success: true, fileId: 'f1', s3Key: 'tenant/proj/conv/msg/f1_logo.svg', filename: 'logo.svg', contentType: 'image/svg+xml' }
      const toolResultLine = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'upload-1',
              content: JSON.stringify(fileResult),
            },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      // Should send tool_result chunk
      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'mcp__ai-support-agent__file_upload',
        success: true,
        output: fileResult,
      }))
      // Should also send file_attachment chunk
      expect(sendChunk).toHaveBeenCalledWith('file_attachment', JSON.stringify({
        fileId: 'f1',
        s3Key: 'tenant/proj/conv/msg/f1_logo.svg',
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
        fileSize: 0,
      }))
      expect(state.pendingFileUploadIds!.has('upload-1')).toBe(false)
    })

    it('should handle MCP tool_result with array content format for file_upload', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const fileResult = { success: true, fileId: 'f2', s3Key: 'tenant/proj/conv/msg/f2_logo.svg', filename: 'mbc-logo.svg', contentType: 'image/svg+xml' }
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-2']),
        pendingToolNames: new Map([['upload-2', 'mcp__ai-support-agent__file_upload']]),
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
                { type: 'text', text: JSON.stringify(fileResult) },
              ],
            },
          ],
        },
      })
      processStreamJsonLine(toolResultLine, sendChunk, 123, state)

      // Should send tool_result chunk
      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'mcp__ai-support-agent__file_upload',
        success: true,
        output: fileResult,
      }))
      // Should also send file_attachment chunk
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
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-3']),
        pendingToolNames: new Map([['upload-3', 'mcp__ai-support-agent__file_upload']]),
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

      // tool_reference should be skipped entirely
      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.anything())
      expect(sendChunk).not.toHaveBeenCalledWith('tool_result', expect.anything())
      // ID should still be tracked for the actual result that comes later
      expect(state.pendingFileUploadIds!.has('upload-3')).toBe(true)
      expect(state.pendingToolNames!.has('upload-3')).toBe(true)
    })

    it('should send tool_result but not file_attachment for non-file_upload tool_results', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingToolNames: new Map([['other-tool-1', 'Bash']]),
      }

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

      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'Bash',
        success: true,
        output: { text: 'some result' },
      }))
      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.anything())
    })

    it('should handle file_upload tool_result with failed result gracefully', () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const state: { sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> } = {
        sentTextLength: 0,
        pendingFileUploadIds: new Set(['upload-1']),
        pendingToolNames: new Map([['upload-1', 'mcp__ai-support-agent__file_upload']]),
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

      // Should send tool_result with error status
      expect(sendChunk).toHaveBeenCalledWith('tool_result', JSON.stringify({
        toolName: 'mcp__ai-support-agent__file_upload',
        success: false,
        output: { text: 'Error: File extension not allowed: .exe' },
      }))
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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

      mockProcess.emit('close', 1)

      await expect(resultPromise).rejects.toThrow('コード 1')
    })

    it('should reject with ENOENT error when claude CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

      mockProcess.emit('error', new Error('Permission denied'))

      await expect(resultPromise).rejects.toThrow('Permission denied')
    })

    it('should pass awsEnv to spawn environment', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const awsEnv = { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk, awsEnv })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk, cwd: '/tmp/project' })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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

      const resultPromise = runClaudeCode({ message: 'hello', sendChunk })

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
