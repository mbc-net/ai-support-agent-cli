import type { ApiClient } from '../../src/api-client'
import { createChunkSender } from '../../src/commands/shared-chat-utils'

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
})
