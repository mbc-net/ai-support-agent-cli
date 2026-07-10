import type { ApiClient } from '../../src/api-client'
import { createChunkSender, formatHistoryForClaudeCode, handleChatError, parseHistory, resolveChunkBatchConfig, sendFileAttachmentChunk } from '../../src/commands/shared-chat-utils'
import type { ChatFileInfo } from '../../src/types'

jest.mock('../../src/logger')

describe('shared-chat-utils', () => {
  const mockClient = {
    submitChatChunk: jest.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createChunkSender', () => {
    it('should return sendChunk and getChunkIndex', () => {
      const { sendChunk, getChunkIndex } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
      )
      expect(typeof sendChunk).toBe('function')
      expect(typeof getChunkIndex).toBe('function')
      expect(getChunkIndex()).toBe(0)
    })

    it('should send chunks with incrementing index', async () => {
      const { sendChunk, getChunkIndex } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
      )

      await sendChunk('delta', 'Hello')
      await sendChunk('delta', ' world')
      await sendChunk('done', 'Hello world')

      expect(getChunkIndex()).toBe(3)
      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(3)
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(1, 'cmd-1', {
        index: 0, type: 'delta', content: 'Hello',
      }, 'agent-1')
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(2, 'cmd-1', {
        index: 1, type: 'delta', content: ' world',
      }, 'agent-1')
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(3, 'cmd-1', {
        index: 2, type: 'done', content: 'Hello world',
      }, 'agent-1')
    })

    it('should handle submitChatChunk errors gracefully', async () => {
      const failClient = {
        submitChatChunk: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      const { sendChunk, getChunkIndex } = createChunkSender(
        'cmd-1', failClient, 'agent-1', 'test',
      )

      // Should not throw
      await sendChunk('delta', 'Hello')
      expect(getChunkIndex()).toBe(1)
    })

    it('should log debug messages when debugLog is true', async () => {
      const { logger } = require('../../src/logger')

      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { debugLog: true },
      )

      await sendChunk('delta', 'Hello')

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('[test] Sending chunk #0 (delta) [cmd-1]'),
      )
    })

    it('should not log debug messages when debugLog is false or undefined', async () => {
      const { logger } = require('../../src/logger')

      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
      )

      await sendChunk('delta', 'Hello')

      expect(logger.debug).not.toHaveBeenCalled()
    })

    it('should truncate long content in debug logs', async () => {
      const { logger } = require('../../src/logger')

      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { debugLog: true },
      )

      const longContent = 'x'.repeat(200)
      await sendChunk('delta', longContent)

      const debugCall = (logger.debug as jest.Mock).mock.calls[0][0] as string
      expect(debugCall).toContain('...')
      expect(debugCall).not.toContain('x'.repeat(200))
    })
  })

  describe('parseHistory', () => {
    it('should return empty array for non-array input', () => {
      expect(parseHistory(undefined)).toEqual([])
      expect(parseHistory(null)).toEqual([])
      expect(parseHistory('string')).toEqual([])
      expect(parseHistory(42)).toEqual([])
      expect(parseHistory({})).toEqual([])
    })

    it('should return empty array for empty array', () => {
      expect(parseHistory([])).toEqual([])
    })

    it('should parse valid history messages', () => {
      const input = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]
      expect(parseHistory(input)).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ])
    })

    it('should filter out invalid items', () => {
      const input = [
        { role: 'user', content: 'valid' },
        { role: 123, content: 'invalid role' },
        { role: 'user', content: 456 },
        null,
        'string',
        { role: 'assistant' }, // missing content
        { content: 'missing role' }, // missing role
        { role: 'user', content: 'also valid' },
      ]
      expect(parseHistory(input)).toEqual([
        { role: 'user', content: 'valid' },
        { role: 'user', content: 'also valid' },
      ])
    })
  })

  describe('formatHistoryForClaudeCode', () => {
    it('should return currentMessage when history is empty', () => {
      expect(formatHistoryForClaudeCode([], 'Hello')).toBe('Hello')
    })

    it('should format history with current message', () => {
      const history = [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ]
      const result = formatHistoryForClaudeCode(history, 'Follow up question')
      expect(result).toBe(
        '<conversation_history>\n' +
        '[user]: First question\n\n' +
        '[assistant]: First answer\n' +
        '</conversation_history>\n\n' +
        'Follow up question',
      )
    })

    it('should handle single history message', () => {
      const history = [{ role: 'user', content: 'Previous' }]
      const result = formatHistoryForClaudeCode(history, 'Current')
      expect(result).toContain('<conversation_history>')
      expect(result).toContain('[user]: Previous')
      expect(result).toContain('</conversation_history>')
      expect(result).toContain('Current')
    })
  })

  describe('handleChatError', () => {
    it('should log error, send error chunk, and return failure result', async () => {
      const { logger } = require('../../src/logger')
      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const result = await handleChatError(
        new Error('Something went wrong'),
        'cmd-err',
        'test-tag',
        sendChunk,
      )

      expect(logger.error).toHaveBeenCalledWith(
        '[test-tag] Chat command failed [cmd-err]: Something went wrong',
      )
      expect(sendChunk).toHaveBeenCalledWith('error', 'Something went wrong')
      expect(result).toEqual({ success: false, error: 'Something went wrong' })
    })

    it('should handle non-Error objects', async () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const result = await handleChatError(
        'string error',
        'cmd-str',
        'tag',
        sendChunk,
      )

      expect(result).toEqual({ success: false, error: 'string error' })
      expect(sendChunk).toHaveBeenCalledWith('error', 'string error')
    })

    it('should still return failure even if sendChunk throws', async () => {
      const sendChunk = jest.fn().mockRejectedValue(new Error('Network error'))

      await expect(
        handleChatError(new Error('original'), 'cmd-net', 'tag', sendChunk),
      ).rejects.toThrow('Network error')
    })
  })

  describe('sendFileAttachmentChunk', () => {
    it('should send a file_attachment chunk with file info', async () => {
      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const file: ChatFileInfo = {
        fileId: 'f1',
        s3Key: 'uploads/f1.txt',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 1024,
      }

      await sendFileAttachmentChunk(sendChunk, file)

      expect(sendChunk).toHaveBeenCalledWith('file_attachment', JSON.stringify({
        fileId: 'f1',
        s3Key: 'uploads/f1.txt',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 1024,
      }))
    })
  })

  describe('createChunkSender (batching)', () => {
    const BATCH = { enabled: true, windowMs: 80, maxBytes: 8192 }

    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.clearAllTimers()
      jest.useRealTimers()
    })

    it('coalesces consecutive delta chunks into a single POST when the time window elapses', async () => {
      const { sendChunk, getChunkIndex } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { batch: BATCH },
      )

      await sendChunk('delta', 'Hello')
      await sendChunk('delta', ' world')
      await sendChunk('delta', '!')

      // Nothing sent yet: still buffered inside the window.
      expect(mockClient.submitChatChunk).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(BATCH.windowMs)

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(1)
      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-1', {
        index: 0, type: 'delta', content: 'Hello world!',
      }, 'agent-1')
      expect(getChunkIndex()).toBe(1)
    })

    it('flushes immediately when the buffered byte threshold is reached', async () => {
      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
        { batch: { enabled: true, windowMs: 80, maxBytes: 10 } },
      )

      await sendChunk('delta', 'abcde')      // 5 bytes, buffered
      expect(mockClient.submitChatChunk).not.toHaveBeenCalled()
      await sendChunk('delta', 'fghijk')     // 6 more -> 11 >= 10, flush now

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(1)
      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-1', {
        index: 0, type: 'delta', content: 'abcdefghijk',
      }, 'agent-1')
    })

    it('flushes pending deltas before a non-delta chunk, preserving order', async () => {
      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { batch: BATCH },
      )

      await sendChunk('delta', 'before tool')
      await sendChunk('tool_call', '{"name":"read"}')

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(2)
      // delta must be sent first (index 0), then the tool_call (index 1).
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(1, 'cmd-1', {
        index: 0, type: 'delta', content: 'before tool',
      }, 'agent-1')
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(2, 'cmd-1', {
        index: 1, type: 'tool_call', content: '{"name":"read"}',
      }, 'agent-1')
    })

    it('flush() sends any remaining buffered deltas', async () => {
      const { sendChunk, flush } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { batch: BATCH },
      )

      await sendChunk('delta', 'tail text')
      expect(mockClient.submitChatChunk).not.toHaveBeenCalled()

      await flush()

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(1)
      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-1', {
        index: 0, type: 'delta', content: 'tail text',
      }, 'agent-1')
    })

    it('flush() is a no-op when there is nothing buffered', async () => {
      const { flush } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { batch: BATCH },
      )
      await flush()
      expect(mockClient.submitChatChunk).not.toHaveBeenCalled()
    })

    it('a done chunk auto-flushes pending deltas before being sent', async () => {
      const { sendChunk } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test', { batch: BATCH },
      )

      await sendChunk('delta', 'partial ')
      await sendChunk('delta', 'answer')
      await sendChunk('done', '{"text":"partial answer"}')

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(2)
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(1, 'cmd-1', {
        index: 0, type: 'delta', content: 'partial answer',
      }, 'agent-1')
      expect(mockClient.submitChatChunk).toHaveBeenNthCalledWith(2, 'cmd-1', {
        index: 1, type: 'done', content: '{"text":"partial answer"}',
      }, 'agent-1')
    })

    it('behaves as a 1:1 pass-through when batching is disabled', async () => {
      const { sendChunk, getChunkIndex, flush } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
        { batch: { enabled: false, windowMs: 80, maxBytes: 8192 } },
      )

      await sendChunk('delta', 'a')
      await sendChunk('delta', 'b')

      // No timer needed: each delta is sent immediately.
      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(2)
      expect(getChunkIndex()).toBe(2)

      // flush() is a harmless no-op when batching is disabled (nothing buffered).
      await expect(flush()).resolves.toBeUndefined()
      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(2)
    })

    it('does not double-send when the byte threshold and the timer both fire', async () => {
      const { sendChunk, getChunkIndex } = createChunkSender(
        'cmd-1', mockClient, 'agent-1', 'test',
        { batch: { enabled: true, windowMs: 80, maxBytes: 6 } },
      )

      await sendChunk('delta', 'abcdef')     // 6 bytes -> threshold flush
      // Advancing the timer must not resend the already-flushed buffer.
      await jest.advanceTimersByTimeAsync(BATCH.windowMs)

      expect(mockClient.submitChatChunk).toHaveBeenCalledTimes(1)
      expect(getChunkIndex()).toBe(1)
    })

    it('does not throw when a batched submit fails (logs a warning)', async () => {
      const failClient = {
        submitChatChunk: jest.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient

      const { sendChunk, flush } = createChunkSender(
        'cmd-1', failClient, 'agent-1', 'test', { batch: BATCH },
      )

      await sendChunk('delta', 'boom')
      await expect(flush()).resolves.toBeUndefined()
    })
  })

  describe('resolveChunkBatchConfig', () => {
    const KEY_ENABLED = 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_ENABLED'
    const KEY_WINDOW = 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_WINDOW_MS'
    const KEY_BYTES = 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_MAX_BYTES'
    const saved: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const k of [KEY_ENABLED, KEY_WINDOW, KEY_BYTES]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
    })

    afterEach(() => {
      for (const k of [KEY_ENABLED, KEY_WINDOW, KEY_BYTES]) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    })

    it('defaults to enabled with the standard window and byte limits', () => {
      const cfg = resolveChunkBatchConfig()
      expect(cfg.enabled).toBe(true)
      expect(cfg.windowMs).toBe(80)
      expect(cfg.maxBytes).toBe(8192)
    })

    it('disables batching when the env var is exactly "false"', () => {
      process.env[KEY_ENABLED] = 'false'
      expect(resolveChunkBatchConfig().enabled).toBe(false)
    })

    it('overrides window and byte limits from valid env values', () => {
      process.env[KEY_WINDOW] = '150'
      process.env[KEY_BYTES] = '4096'
      const cfg = resolveChunkBatchConfig()
      expect(cfg.windowMs).toBe(150)
      expect(cfg.maxBytes).toBe(4096)
    })

    it('falls back to defaults for invalid (non-positive / NaN) env values', () => {
      process.env[KEY_WINDOW] = '0'
      process.env[KEY_BYTES] = 'not-a-number'
      const cfg = resolveChunkBatchConfig()
      expect(cfg.windowMs).toBe(80)
      expect(cfg.maxBytes).toBe(8192)
    })
  })
})
