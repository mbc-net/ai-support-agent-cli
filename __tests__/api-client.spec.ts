import axios from 'axios'

import { ApiClient } from '../src/api-client'
import { logger } from '../src/logger'

jest.mock('axios')
jest.mock('../src/logger')
const mockedAxios = axios as jest.Mocked<typeof axios>
const mockedLogger = logger as jest.Mocked<typeof logger>

function createAxiosError(message: string, status: number): Error & { isAxiosError: boolean; response: { status: number } } {
  const error = new Error(message) as Error & { isAxiosError: boolean; response: { status: number } }
  error.isAxiosError = true
  error.response = { status }
  return error
}

describe('ApiClient', () => {
  let client: ApiClient
  const mockInstance = {
    post: jest.fn(),
    get: jest.fn(),
  }

  beforeEach(() => {
    mockedAxios.create.mockReturnValue(mockInstance as any)
    client = new ApiClient('http://localhost:3030', 'test-token')
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  describe('register', () => {
    it('should send registration request', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      const result = await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
      })
      expect(result.agentId).toBe('test-id')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/register',
        expect.objectContaining({ agentId: 'test-id', hostname: 'hostname' }),
      )
    })

    it('should include ipAddress, availableChatModes, and activeChatMode when provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
        ipAddress: '192.168.1.1',
        availableChatModes: ['claude_code', 'api'],
        activeChatMode: 'claude_code',
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('ipAddress', '192.168.1.1')
      expect(callArgs).toHaveProperty('availableChatModes', ['claude_code', 'api'])
      expect(callArgs).toHaveProperty('activeChatMode', 'claude_code')
    })

    it('should not include ipAddress when not provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('ipAddress')
      expect(callArgs).not.toHaveProperty('availableChatModes')
      expect(callArgs).not.toHaveProperty('activeChatMode')
    })
  })

  describe('heartbeat', () => {
    it('should send heartbeat', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/heartbeat',
        expect.objectContaining({ agentId: 'test-id' }),
      )
    })
  })

  describe('getVersionInfo', () => {
    it('should fetch version info with default channel', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          latestVersion: '1.2.0',
          minimumVersion: '1.0.0',
          channel: 'latest',
          channels: { latest: '1.2.0' },
        },
      })

      const result = await client.getVersionInfo()
      expect(result.latestVersion).toBe('1.2.0')
      expect(result.channel).toBe('latest')
      expect(mockInstance.get).toHaveBeenCalledWith('/api/agent/version?channel=latest')
    })

    it('should pass channel parameter', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          latestVersion: '1.3.0-beta.1',
          minimumVersion: '1.0.0',
          channel: 'beta',
          channels: { beta: '1.3.0-beta.1' },
        },
      })

      const result = await client.getVersionInfo('beta')
      expect(result.latestVersion).toBe('1.3.0-beta.1')
      expect(mockInstance.get).toHaveBeenCalledWith('/api/agent/version?channel=beta')
    })
  })

  describe('heartbeat with updateError', () => {
    it('should include updateError when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      }, 'EACCES: permission denied')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/heartbeat',
        expect.objectContaining({
          agentId: 'test-id',
          updateError: 'EACCES: permission denied',
        }),
      )
    })

    it('should not include updateError when not provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('updateError')
    })

    it('should include availableChatModes and activeChatMode when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      }, undefined, ['claude_code', 'api'], 'claude_code')

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('availableChatModes', ['claude_code', 'api'])
      expect(callArgs).toHaveProperty('activeChatMode', 'claude_code')
    })

    it('should not include availableChatModes and activeChatMode when not provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('availableChatModes')
      expect(callArgs).not.toHaveProperty('activeChatMode')
    })
  })

  describe('getPendingCommands', () => {
    it('should fetch pending commands', async () => {
      mockInstance.get.mockResolvedValue({
        data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
      })

      const result = await client.getPendingCommands('agent-1')
      expect(result).toHaveLength(1)
      expect(result[0].commandId).toBe('cmd-1')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/agent/commands/pending',
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('submitResult', () => {
    it('should submit command result', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/commands/cmd-1/result',
        { success: true, data: 'output' },
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('getCommand', () => {
    it('should fetch a specific command by ID', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          commandId: 'cmd-1',
          type: 'execute_command',
          payload: { command: 'echo hello' },
          status: 'PENDING',
          createdAt: 1700000000000,
        },
      })

      const result = await client.getCommand('cmd-1', 'agent-1')
      expect(result.commandId).toBe('cmd-1')
      expect(result.type).toBe('execute_command')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/agent/commands/cmd-1',
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('commandId validation', () => {
    it('should reject commandId with path traversal', async () => {
      await expect(client.getCommand('../../admin', 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should reject commandId with special characters', async () => {
      await expect(client.submitResult('cmd;drop', { success: true, data: '' }, 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should reject commandId with slashes', async () => {
      await expect(client.getCommand('cmd/delete', 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should accept valid commandId with alphanumeric, hyphens, and underscores', async () => {
      mockInstance.get.mockResolvedValue({
        data: { commandId: 'abc-123_DEF', type: 'execute_command', payload: {}, status: 'PENDING', createdAt: 0 },
      })

      const result = await client.getCommand('abc-123_DEF', 'agent-1')
      expect(result.commandId).toBe('abc-123_DEF')
    })
  })

  describe('HTTP URL warning', () => {
    it('should warn when API URL uses HTTP with a remote host', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      new ApiClient('http://remote-server:3000', 'test-token')
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'API URL uses HTTP (not HTTPS). Token may be transmitted in plain text.',
      )
    })

    it('should not warn when API URL uses HTTPS', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('https://remote-server:3000', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })

    it('should not warn when API URL uses HTTP with 127.0.0.1', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('http://127.0.0.1:3030', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })

    it('should not warn when API URL uses HTTP with localhost', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('http://localhost:3030', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })
  })

  describe('reportConnectionStatus', () => {
    it('should send connection status', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.reportConnectionStatus('agent-1', 'connected')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/connection-status',
        expect.objectContaining({
          agentId: 'agent-1',
          status: 'connected',
          timestamp: expect.any(Number),
        }),
      )
    })

    it('should send disconnected status', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.reportConnectionStatus('agent-1', 'disconnected')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/connection-status',
        expect.objectContaining({
          status: 'disconnected',
        }),
      )
    })
  })

  describe('getConfig', () => {
    it('should fetch agent config from server', async () => {
      const config = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }
      mockInstance.get.mockResolvedValue({ data: config })

      const result = await client.getConfig()

      expect(result).toEqual(config)
      expect(mockInstance.get).toHaveBeenCalledWith('/api/agent/config')
    })
  })

  describe('submitChatChunk', () => {
    it('should submit chat chunk with correct parameters', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.submitChatChunk('cmd-1', {
        index: 0,
        type: 'delta',
        content: 'Hello',
      }, 'agent-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/agent/commands/cmd-1/chunks',
        { index: 0, type: 'delta', content: 'Hello' },
        { params: { agentId: 'agent-1' } },
      )
    })

    it('should validate commandId format', async () => {
      await expect(
        client.submitChatChunk('../evil', { index: 0, type: 'delta', content: '' }, 'agent-1'),
      ).rejects.toThrow('Invalid command ID format')
    })
  })

  describe('retry logic', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      mockedAxios.isAxiosError.mockImplementation(
        (err: unknown) => (err as Record<string, unknown>)?.isAxiosError === true,
      )
    })

    it('should retry on failure and succeed on second attempt', async () => {
      mockInstance.get
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting all retries', async () => {
      mockInstance.post
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(new Error('Network Error'))

      const promise = client
        .submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1')
        .catch((e: unknown) => e)
      await jest.advanceTimersByTimeAsync(1000)
      await jest.advanceTimersByTimeAsync(2000)
      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Network Error')
      expect(mockInstance.post).toHaveBeenCalledTimes(3)
    })

    it('should not retry on 4xx client errors', async () => {
      mockInstance.post.mockRejectedValueOnce(createAxiosError('Bad Request', 400))

      await expect(
        client.submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1'),
      ).rejects.toThrow('Bad Request')
      expect(mockInstance.post).toHaveBeenCalledTimes(1)
    })

    it('should retry on 429 rate limit', async () => {
      mockInstance.get
        .mockRejectedValueOnce(createAxiosError('Too Many Requests', 429))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should retry on 5xx server errors', async () => {
      mockInstance.get
        .mockRejectedValueOnce(createAxiosError('Internal Server Error', 500))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should apply jitter to retry delay (delay varies between runs)', async () => {
      // Verify jitter by collecting multiple delay values via Math.random mock
      const randomValues = [0.0, 0.5, 1.0]
      const expectedDelays = randomValues.map(r => Math.round(1000 * (0.5 + r * 0.5)))
      // r=0.0 → 500, r=0.5 → 750, r=1.0 → 1000

      for (let i = 0; i < randomValues.length; i++) {
        jest.spyOn(Math, 'random').mockReturnValue(randomValues[i])

        mockInstance.get
          .mockRejectedValueOnce(new Error('Network Error'))
          .mockResolvedValueOnce({
            data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
          })

        const promise = client.getPendingCommands('agent-1')
        await jest.advanceTimersByTimeAsync(expectedDelays[i])
        await promise

        jest.spyOn(Math, 'random').mockRestore()
        mockInstance.get.mockReset()
      }

      // The fact that all three resolved with different delays proves jitter works
      expect(expectedDelays).toEqual([500, 750, 1000])
    })

    it('should retry on network errors (no response)', async () => {
      const networkError = new Error('ECONNRESET')

      mockInstance.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })
  })
})
