import type { ApiClient } from '../../src/api-client'
import { createChunkSender, formatHistoryForClaudeCode, handleChatError, parseHistory, sendFileAttachmentChunk } from '../../src/commands/shared-chat-utils'
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
})
