/**
 * Tests for src/commands/claude-code-stream.ts
 *
 * Exercises processStreamJsonLine() and parseFileUploadResult().
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

jest.mock('../../src/constants', () => ({
  LOG_DEBUG_LIMIT: 200,
}))

import { processStreamJsonLine, parseFileUploadResult } from '../../src/commands/claude-code-stream'
import { logger } from '../../src/logger'

const mockLogger = logger as jest.Mocked<typeof logger>

// Helper: create a basic sendChunk spy that resolves immediately
function makeSendChunk() {
  return jest.fn().mockResolvedValue(undefined) as jest.Mock<Promise<void>, [string, string]>
}

// Default minimal state
function makeState(overrides?: Partial<{ sentTextLength: number; pendingFileUploadIds?: Set<string>; pendingToolNames?: Map<string, string> }>) {
  return {
    sentTextLength: 0,
    ...overrides,
  }
}

describe('processStreamJsonLine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ------------------------------------------------------------------ helpers
  describe('invalid / non-JSON input', () => {
    it('returns unchanged sentTextLength when line is not valid JSON', () => {
      const sendChunk = makeSendChunk()
      const result = processStreamJsonLine('not-json', sendChunk, 42, makeState({ sentTextLength: 5 }))
      expect(result.newSentTextLength).toBe(5)
      expect(result.text).toBeUndefined()
      expect(result.toolExecutionChange).toBeUndefined()
      expect(result.usage).toBeUndefined()
    })

    it('logs a debug message on parse failure', () => {
      const sendChunk = makeSendChunk()
      processStreamJsonLine('bad-json', sendChunk, 99, makeState())
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('pid=99'),
      )
    })

    it('returns unchanged sentTextLength for an empty string', () => {
      const sendChunk = makeSendChunk()
      const result = processStreamJsonLine('', sendChunk, 1, makeState({ sentTextLength: 3 }))
      expect(result.newSentTextLength).toBe(3)
    })
  })

  // ------------------------------------------------------------------ assistant messages
  describe('type: assistant', () => {
    it('sends a delta chunk for new text content', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.newSentTextLength).toBe(11)
      expect(sendChunk).toHaveBeenCalledWith('delta', 'Hello world')
    })

    it('only sends the NEW portion of text (deduplication)', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      })
      // sentTextLength already at 5 — only " world" (6 chars from index 5) should be new
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 5 }))
      expect(result.newSentTextLength).toBe(11)
      expect(sendChunk).toHaveBeenCalledWith('delta', ' world')
    })

    it('does not send a delta when text is not longer than already sent', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi' }] },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 10 }))
      expect(sendChunk).not.toHaveBeenCalledWith('delta', expect.any(String))
    })

    it('accumulates text across multiple text blocks', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.newSentTextLength).toBe(11)
      expect(sendChunk).toHaveBeenCalledWith('delta', 'Hello world')
    })

    it('sends a tool_call chunk for tool_use blocks', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'bash',
              id: 'tool-1',
              input: { command: 'ls' },
            },
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.toolExecutionChange).toBe('started')
      expect(sendChunk).toHaveBeenCalledWith(
        'tool_call',
        expect.stringContaining('"toolName":"bash"'),
      )
      expect(sendChunk).toHaveBeenCalledWith(
        'tool_call',
        expect.stringContaining('"id":"tool-1"'),
      )
    })

    it('stores tool id→name mapping for later tool_result lookup', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file', id: 'tid-42', input: {} },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(state.pendingToolNames?.get('tid-42')).toBe('read_file')
    })

    it('tracks file_upload tool id in pendingFileUploadIds', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'mcp__ai-support-agent__file_upload',
              id: 'fid-1',
              input: {},
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(state.pendingFileUploadIds?.has('fid-1')).toBe(true)
    })

    it('returns toolExecutionChange=undefined when no tool_use block is present', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.toolExecutionChange).toBeUndefined()
    })

    it('handles tool_use with no id gracefully (skips id tracking)', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'some_tool', input: {} }, // no id
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, state)
      expect(result.toolExecutionChange).toBe('started')
    })

    it('returns unchanged sentTextLength for assistant with empty content array', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [] },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 5 }))
      // no text was accumulated — sentTextLength stays the same (user block resets it)
      expect(result.newSentTextLength).toBe(5)
    })

    it('logs tool_use name at info level', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'write_file', id: 'x', input: {} }],
        },
      })
      processStreamJsonLine(line, sendChunk, 7, makeState())
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('write_file'),
      )
    })

    it('uses empty input object when tool_use input is missing', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'no_input_tool', id: 'z' }],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_call')
      expect(call).toBeDefined()
      const payload = JSON.parse(call![1])
      expect(payload.input).toEqual({})
    })

    it('initializes pendingToolNames when state has none', () => {
      const sendChunk = makeSendChunk()
      const state = makeState() // no pendingToolNames
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'tool_x', id: 'new-id', input: {} }],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(state.pendingToolNames).toBeDefined()
      expect(state.pendingToolNames?.get('new-id')).toBe('tool_x')
    })

    it('initializes pendingFileUploadIds when state has none', () => {
      const sendChunk = makeSendChunk()
      const state = makeState() // no pendingFileUploadIds
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'mcp__ai-support-agent__file_upload',
              id: 'new-fid',
              input: {},
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(state.pendingFileUploadIds).toBeDefined()
      expect(state.pendingFileUploadIds?.has('new-fid')).toBe(true)
    })
  })

  // ------------------------------------------------------------------ user messages (tool_result)
  describe('type: user', () => {
    it('resets sentTextLength to 0 after an actual tool_result', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-1', content: 'ok' },
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 10 }))
      expect(result.newSentTextLength).toBe(0)
    })

    it('returns toolExecutionChange=finished when there is an actual tool_result', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-1', content: 'done' },
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.toolExecutionChange).toBe('finished')
    })

    it('sends a tool_result chunk with toolName resolved from pendingToolNames', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      state.pendingToolNames = new Map([['tid-2', 'bash']])
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-2', content: 'output text' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(sendChunk).toHaveBeenCalledWith(
        'tool_result',
        expect.stringContaining('"toolName":"bash"'),
      )
    })

    it('uses "unknown" toolName when pendingToolNames does not have the id', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'missing-id', content: 'output' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(sendChunk).toHaveBeenCalledWith(
        'tool_result',
        expect.stringContaining('"toolName":"unknown"'),
      )
    })

    it('marks tool_result as error when content starts with "Error:"', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-3', content: 'Error: something went wrong' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_result')
      expect(call).toBeDefined()
      const payload = JSON.parse(call![1])
      expect(payload.success).toBe(false)
    })

    it('marks tool_result as error when content starts with "error:"', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-err2', content: 'error: lowercase error' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_result')
      const payload = JSON.parse(call![1])
      expect(payload.success).toBe(false)
    })

    it('marks tool_result as success when content does not start with error keyword', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-4', content: 'done' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_result')
      const payload = JSON.parse(call![1])
      expect(payload.success).toBe(true)
    })

    it('handles array content in tool_result (extracts first text block)', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tid-5',
              content: [{ type: 'text', text: 'array result' }],
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(sendChunk).toHaveBeenCalledWith('tool_result', expect.any(String))
    })

    it('handles array content with no text block (empty resultText)', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tid-notxt',
              content: [{ type: 'image', data: 'base64' }],
            },
          ],
        },
      })
      expect(() => processStreamJsonLine(line, sendChunk, 1, makeState())).not.toThrow()
    })

    it('handles missing content field in tool_result block', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-6' }, // no content field
          ],
        },
      })
      expect(() => processStreamJsonLine(line, sendChunk, 1, makeState())).not.toThrow()
    })

    it('skips tool_reference blocks (MCP first pass)', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tid-7',
              content: [{ type: 'tool_reference' }],
            },
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 5 }))
      // tool_reference only → toolExecutionChange should be undefined, sentTextLength reset to 0
      expect(result.toolExecutionChange).toBeUndefined()
      expect(result.newSentTextLength).toBe(0)
      // tool_result chunk should NOT be sent for tool_reference
      expect(sendChunk).not.toHaveBeenCalled()
    })

    it('skips non-tool_result content blocks in user message', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'some user message' }, // not tool_result
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.toolExecutionChange).toBeUndefined()
      expect(sendChunk).not.toHaveBeenCalled()
    })

    it('skips tool_result blocks without tool_use_id', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: 'some result' }, // no tool_use_id
          ],
        },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.toolExecutionChange).toBeUndefined()
      expect(sendChunk).not.toHaveBeenCalled()
    })

    it('sends file_attachment chunk when tool_result is from a file_upload tool', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      state.pendingFileUploadIds = new Set(['fid-upload'])
      state.pendingToolNames = new Map([['fid-upload', 'mcp__ai-support-agent__file_upload']])

      const filePayload = {
        success: true,
        fileId: 'f-123',
        s3Key: 'uploads/f-123',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 42,
      }
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fid-upload',
              content: [{ type: 'text', text: JSON.stringify(filePayload) }],
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(sendChunk).toHaveBeenCalledWith(
        'file_attachment',
        expect.stringContaining('"fileId":"f-123"'),
      )
      // id should be removed from pendingFileUploadIds after processing
      expect(state.pendingFileUploadIds?.has('fid-upload')).toBe(false)
    })

    it('does not send file_attachment when parseFileUploadResult returns null', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      state.pendingFileUploadIds = new Set(['fid-bad'])
      state.pendingToolNames = new Map([['fid-bad', 'mcp__ai-support-agent__file_upload']])

      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fid-bad',
              content: [{ type: 'text', text: 'not-valid-json' }],
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(sendChunk).not.toHaveBeenCalledWith('file_attachment', expect.any(String))
    })

    it('cleans up pendingToolNames mapping after processing', () => {
      const sendChunk = makeSendChunk()
      const state = makeState()
      state.pendingToolNames = new Map([['tid-clean', 'bash']])
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-clean', content: 'done' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, state)
      expect(state.pendingToolNames?.has('tid-clean')).toBe(false)
    })

    it('parses valid JSON string tool result into output object', () => {
      const sendChunk = makeSendChunk()
      const outputData = { files: ['a.ts', 'b.ts'] }
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tid-json',
              content: JSON.stringify(outputData),
            },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_result')
      const payload = JSON.parse(call![1])
      expect(payload.output).toEqual(outputData)
    })

    it('wraps non-JSON tool result in {text} object', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tid-plain', content: 'plain text result' },
          ],
        },
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      const call = sendChunk.mock.calls.find(([type]) => type === 'tool_result')
      const payload = JSON.parse(call![1])
      expect(payload.output).toEqual({ text: 'plain text result' })
    })
  })

  // ------------------------------------------------------------------ result event
  describe('type: result', () => {
    it('returns text from the result event', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'result',
        result: 'Final answer',
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 3 }))
      expect(result.text).toBe('Final answer')
      expect(result.newSentTextLength).toBe(3) // unchanged
    })

    it('returns empty string result', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({ type: 'result', result: '' })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.text).toBe('')
    })

    it('attaches usage when usage field is present', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        total_cost_usd: 0.001,
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        total_cost_usd: 0.001,
      })
    })

    it('attaches usage without total_cost_usd when not present', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_cost_usd: undefined })
    })

    it('returns undefined usage when no usage field', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({ type: 'result', result: 'ok' })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.usage).toBeUndefined()
    })

    it('does not return text for result event without result field', () => {
      const sendChunk = makeSendChunk()
      // type=result but result field is undefined
      const line = JSON.stringify({ type: 'result' })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(result.text).toBeUndefined()
    })
  })

  // ------------------------------------------------------------------ system/init event
  describe('type: system / subtype: init', () => {
    it('logs connected MCP servers at info level', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'my-mcp', status: 'connected' }],
        tools: [],
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('my-mcp'),
      )
    })

    it('warns for non-connected MCP servers', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'bad-mcp', status: 'error', error: 'timeout' }],
        tools: [],
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('bad-mcp'),
      )
    })

    it('includes MCP server error message in warning', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'fail-mcp', status: 'disconnected', error: 'connection refused' }],
        tools: [],
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('connection refused'),
      )
    })

    it('logs MCP server status even without error field', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'mcp-no-err', status: 'pending' }],
        tools: [],
      })
      expect(() => processStreamJsonLine(line, sendChunk, 1, makeState())).not.toThrow()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('logs tool count and MCP tools when tools are present', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: ['bash', 'mcp__ai-support-agent__file_upload', 'read_file'],
        mcp_servers: [],
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('mcp__ai-support-agent__file_upload'),
      )
    })

    it('logs "no tools listed" when tools array is empty', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: [],
      })
      processStreamJsonLine(line, sendChunk, 1, makeState())
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('no tools listed'),
      )
    })

    it('handles missing mcp_servers gracefully', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: ['bash'],
      })
      expect(() => processStreamJsonLine(line, sendChunk, 1, makeState())).not.toThrow()
    })

    it('returns unchanged sentTextLength for system/init', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({ type: 'system', subtype: 'init', tools: [] })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 7 }))
      expect(result.newSentTextLength).toBe(7)
    })

    it('ignores system events that are not subtype=init', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({ type: 'system', subtype: 'other' })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 2 }))
      expect(result.newSentTextLength).toBe(2)
    })
  })

  // ------------------------------------------------------------------ unknown event types
  describe('unknown event types', () => {
    it('returns unchanged state for an unknown type', () => {
      const sendChunk = makeSendChunk()
      const line = JSON.stringify({ type: 'unknown_event', data: 'foo' })
      const result = processStreamJsonLine(line, sendChunk, 1, makeState({ sentTextLength: 3 }))
      expect(result.newSentTextLength).toBe(3)
      expect(result.text).toBeUndefined()
      expect(result.toolExecutionChange).toBeUndefined()
      expect(sendChunk).not.toHaveBeenCalled()
    })
  })
})

// ====================================================================
// parseFileUploadResult
// ====================================================================
describe('parseFileUploadResult', () => {
  it('returns null for undefined content', () => {
    expect(parseFileUploadResult(undefined)).toBeNull()
  })

  it('returns null for empty string content', () => {
    expect(parseFileUploadResult('')).toBeNull()
  })

  it('parses a valid JSON string result', () => {
    const payload = {
      success: true,
      fileId: 'f-001',
      s3Key: 'uploads/f-001.txt',
      filename: 'hello.txt',
      contentType: 'text/plain',
      fileSize: 123,
    }
    const result = parseFileUploadResult(JSON.stringify(payload))
    expect(result).toEqual({
      fileId: 'f-001',
      s3Key: 'uploads/f-001.txt',
      filename: 'hello.txt',
      contentType: 'text/plain',
      fileSize: 123,
    })
  })

  it('defaults contentType to application/octet-stream when missing', () => {
    const payload = {
      success: true,
      fileId: 'f-002',
      s3Key: 'uploads/f-002',
      filename: 'data.bin',
      fileSize: 512,
    }
    const result = parseFileUploadResult(JSON.stringify(payload))
    expect(result?.contentType).toBe('application/octet-stream')
  })

  it('defaults fileSize to 0 when missing', () => {
    const payload = {
      success: true,
      fileId: 'f-003',
      s3Key: 'uploads/f-003',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
    }
    const result = parseFileUploadResult(JSON.stringify(payload))
    expect(result?.fileSize).toBe(0)
  })

  it('returns null when success is false', () => {
    const payload = { success: false, fileId: 'f-x', s3Key: 'k', filename: 'f' }
    expect(parseFileUploadResult(JSON.stringify(payload))).toBeNull()
  })

  it('returns null when fileId is missing', () => {
    const payload = { success: true, s3Key: 'k', filename: 'f' }
    expect(parseFileUploadResult(JSON.stringify(payload))).toBeNull()
  })

  it('returns null when s3Key is missing', () => {
    const payload = { success: true, fileId: 'f-id', filename: 'f' }
    expect(parseFileUploadResult(JSON.stringify(payload))).toBeNull()
  })

  it('returns null when filename is missing', () => {
    const payload = { success: true, fileId: 'f-id', s3Key: 'k' }
    expect(parseFileUploadResult(JSON.stringify(payload))).toBeNull()
  })

  it('returns null for non-JSON string', () => {
    expect(parseFileUploadResult('not-json')).toBeNull()
  })

  it('parses array content format (MCP tool)', () => {
    const payload = {
      success: true,
      fileId: 'f-mcp',
      s3Key: 'uploads/f-mcp',
      filename: 'mcp-file.txt',
      contentType: 'text/plain',
      fileSize: 99,
    }
    const arrayContent = [{ type: 'text', text: JSON.stringify(payload) }]
    const result = parseFileUploadResult(arrayContent)
    expect(result?.fileId).toBe('f-mcp')
  })

  it('returns null for empty array content', () => {
    expect(parseFileUploadResult([])).toBeNull()
  })

  it('returns null when array content has no text block', () => {
    const content = [{ type: 'image', data: 'base64data' }]
    expect(parseFileUploadResult(content)).toBeNull()
  })

  it('returns null when array content text block has invalid JSON', () => {
    const content = [{ type: 'text', text: 'not-json' }]
    expect(parseFileUploadResult(content)).toBeNull()
  })

  it('returns null when array content text block text field is missing', () => {
    const content = [{ type: 'text' }] // no text property
    expect(parseFileUploadResult(content)).toBeNull()
  })
})
