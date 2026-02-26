import { EventEmitter } from 'events'

import type { ApiClient } from '../../src/api-client'
import { executeApiChatCommand } from '../../src/commands/api-chat-executor'
import type { AgentServerConfig, ChatPayload } from '../../src/types'

jest.mock('../../src/logger')

// Mock axios - the module uses `import axios from 'axios'` so we mock the default export
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}))

import axios from 'axios'

const mockedAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>

describe('api-chat-executor', () => {
  const mockClient = {
    submitChatChunk: jest.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient

  const basePayload: ChatPayload = {
    message: 'Hello, world!',
  }

  const baseConfig: AgentServerConfig = {
    agentEnabled: true,
    builtinAgentEnabled: true,
    builtinFallbackEnabled: true,
    externalAgentEnabled: true,
    chatMode: 'agent',
    claudeCodeConfig: {
      maxTokens: 2048,
      systemPrompt: 'You are a helpful assistant.',
    },
  }

  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'test-api-key' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should return error when agentId is missing', async () => {
    const result = await executeApiChatCommand(basePayload, 'cmd-0', mockClient)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('agentId is required for chat command')
    }
  })

  it('should return error when message is missing', async () => {
    const result = await executeApiChatCommand(
      { message: undefined } as ChatPayload,
      'cmd-1',
      mockClient,
      undefined,
      'agent-1',
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('message is required')
    }
  })

  it('should return error when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY

    const result = await executeApiChatCommand(basePayload, 'cmd-2', mockClient, undefined, 'agent-1')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ANTHROPIC_API_KEY')
    }
  })

  it('should truncate long messages in log output', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const longMessage = 'A'.repeat(150)
    const resultPromise = executeApiChatCommand(
      { message: longMessage }, 'cmd-long', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)

    // Verify the API was called with the full message
    expect(mockedAxiosPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        messages: [{ role: 'user', content: longMessage }],
      }),
      expect.any(Object),
    )
  })

  it('should call Anthropic API with correct parameters', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-3', mockClient, baseConfig, 'agent-1',
    )

    // Wait for axios.post to be called
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Emit SSE data
    stream.emit('data', Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n'))
    stream.emit('data', Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}\n\n'))
    stream.emit('end')

    const result = await resultPromise

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('Hello there')
    }

    // Verify API call parameters
    expect(mockedAxiosPost).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 2048,
        stream: true,
        messages: [{ role: 'user', content: 'Hello, world!' }],
        system: 'You are a helpful assistant.',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'anthropic-version': '2023-06-01',
        }),
        responseType: 'stream',
      }),
    )

    // Verify chunks were sent
    expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-3', {
      index: 0,
      type: 'delta',
      content: 'Hello',
    }, 'agent-1')
    expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-3', {
      index: 1,
      type: 'delta',
      content: ' there',
    }, 'agent-1')
    // done chunk
    expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-3', {
      index: 2,
      type: 'done',
      content: 'Hello there',
    }, 'agent-1')
  })

  it('should use default maxTokens when config is not provided', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-4', mockClient, undefined, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.emit('end')

    await resultPromise

    expect(mockedAxiosPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max_tokens: 4096,
      }),
      expect.any(Object),
    )
  })

  it('should not include system prompt when not provided', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const configWithoutSystem: AgentServerConfig = {
      ...baseConfig,
      claudeCodeConfig: { maxTokens: 1024 },
    }

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-5', mockClient, configWithoutSystem, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.emit('end')

    await resultPromise

    const callArgs = mockedAxiosPost.mock.calls[0]
    const body = callArgs[1] as Record<string, unknown>
    expect(body.system).toBeUndefined()
    expect(body.max_tokens).toBe(1024)
  })

  it('should handle stream errors', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-6', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    stream.emit('error', new Error('Stream connection lost'))

    const result = await resultPromise
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Stream connection lost')
    }
  })

  it('should handle API request failure', async () => {
    mockedAxiosPost.mockRejectedValue(new Error('Network error'))

    const result = await executeApiChatCommand(
      basePayload, 'cmd-7', mockClient, baseConfig, 'agent-1',
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Network error')
    }
  })

  it('should handle tool_use content_block_start events', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-tool', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    stream.emit('data', Buffer.from(
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"search_docs"}}\n\n',
    ))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)

    // Should have sent a delta chunk about tool use
    expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-tool', expect.objectContaining({
      type: 'delta',
      content: expect.stringContaining('search_docs'),
    }), 'agent-1')
  })

  it('should skip non-JSON SSE data lines gracefully', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-nonjson', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Non-JSON data should be skipped without error
    stream.emit('data', Buffer.from('data: not-valid-json\n\n'))
    stream.emit('data', Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n'))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('ok')
    }
  })

  it('should skip [DONE] marker', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-done', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    stream.emit('data', Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\ndata: [DONE]\n\n'))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('hi')
    }
  })

  it('should skip non-text_delta content_block_delta events', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-nontextdelta', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    // input_json_delta should be ignored
    stream.emit('data', Buffer.from('data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n'))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('')
    }
  })

  it('should send error chunk on failure', async () => {
    mockedAxiosPost.mockRejectedValue(new Error('API failure'))

    const result = await executeApiChatCommand(
      basePayload, 'cmd-err-chunk', mockClient, baseConfig, 'agent-1',
    )

    expect(result.success).toBe(false)
    expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-err-chunk', expect.objectContaining({
      type: 'error',
    }), 'agent-1')
  })

  it('should handle incomplete SSE lines across chunks', async () => {
    const stream = new EventEmitter()
    mockedAxiosPost.mockResolvedValue({ data: stream } as any)

    const resultPromise = executeApiChatCommand(
      basePayload, 'cmd-split', mockClient, baseConfig, 'agent-1',
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Split a line across two chunks
    stream.emit('data', Buffer.from('data: {"type":"content_block_del'))
    stream.emit('data', Buffer.from('ta","delta":{"type":"text_delta","text":"split"}}\n\n'))
    stream.emit('end')

    const result = await resultPromise
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBe('split')
    }
  })
})
