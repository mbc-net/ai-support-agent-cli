import { ApiClient } from '../src/api-client'
import { AppSyncSubscriber } from '../src/appsync-subscriber'
import { executeCommand } from '../src/command-executor'
import { logger } from '../src/logger'
import { ProjectAgent } from '../src/project-agent'

jest.mock('../src/api-client')
jest.mock('../src/appsync-subscriber')
jest.mock('../src/command-executor')
jest.mock('../src/logger')
jest.mock('../src/chat-mode-detector', () => ({
  detectAvailableChatModes: jest.fn().mockResolvedValue([]),
  resolveActiveChatMode: jest.fn().mockReturnValue(undefined),
}))

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>
const MockAppSyncSubscriber = AppSyncSubscriber as jest.MockedClass<typeof AppSyncSubscriber>
const mockedExecuteCommand = executeCommand as jest.MockedFunction<typeof executeCommand>

describe('ProjectAgent', () => {
  let mockClient: {
    register: jest.Mock
    heartbeat: jest.Mock
    getPendingCommands: jest.Mock
    getCommand: jest.Mock
    submitResult: jest.Mock
    getVersionInfo: jest.Mock
    reportConnectionStatus: jest.Mock
    getConfig: jest.Mock
  }

  let mockSubscriber: {
    connect: jest.Mock
    subscribe: jest.Mock
    onReconnect: jest.Mock
    disconnect: jest.Mock
  }

  const project = { projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' }
  const options = { pollInterval: 5000, heartbeatInterval: 30000 }

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '', transportMode: 'polling' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn().mockResolvedValue(undefined),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      reportConnectionStatus: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
    }
    MockApiClient.mockImplementation(() => mockClient as unknown as ApiClient)

    mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
      onReconnect: jest.fn(),
      disconnect: jest.fn(),
    }
    MockAppSyncSubscriber.mockImplementation(() => mockSubscriber as unknown as AppSyncSubscriber)

    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('polling mode', () => {
    it('should register on start and begin heartbeat/polling', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.register).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalled()

      // Heartbeat should have fired
      expect(mockClient.heartbeat).toHaveBeenCalled()

      agent.stop()
    })

    it('should log error and not start timers when registration fails', async () => {
      mockClient.register.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith('runner.registerFailed')

      // Timers should not fire
      mockClient.heartbeat.mockClear()
      mockClient.getPendingCommands.mockClear()
      await jest.advanceTimersByTimeAsync(60000)

      expect(mockClient.heartbeat).not.toHaveBeenCalled()
      expect(mockClient.getPendingCommands).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should log warning when heartbeat fails', async () => {
      mockClient.heartbeat.mockRejectedValue(new Error('Heartbeat timeout'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith('runner.heartbeatFailed')

      agent.stop()
    })

    it('should poll, execute commands, and submit results', async () => {
      mockClient.getPendingCommands.mockResolvedValue([
        { commandId: 'cmd-1', type: 'execute_command' },
      ])
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-1',
        type: 'execute_command',
        payload: { command: 'echo hi' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'hi' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Trigger poll interval
      await jest.advanceTimersByTimeAsync(options.pollInterval)

      expect(mockClient.getPendingCommands).toHaveBeenCalledWith('agent-1')
      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-1', 'agent-1')
      expect(mockedExecuteCommand).toHaveBeenCalledWith('execute_command', { command: 'echo hi' }, { commandId: 'cmd-1', client: mockClient, serverConfig: expect.any(Object), activeChatMode: undefined, agentId: 'agent-1' })
      expect(mockClient.submitResult).toHaveBeenCalledWith('cmd-1', { success: true, data: 'hi' }, 'agent-1')

      agent.stop()
    })

    it('should handle command execution error', async () => {
      mockClient.getPendingCommands.mockResolvedValue([
        { commandId: 'cmd-2', type: 'execute_command' },
      ])
      mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
      mockClient.submitResult.mockRejectedValue(new Error('Submit failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(options.pollInterval)

      expect(logger.error).toHaveBeenCalledWith('runner.commandError')
      expect(logger.error).toHaveBeenCalledWith('runner.resultSendFailed')

      agent.stop()
    })

    it('should clear timers on stop()', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      agent.stop()

      mockClient.heartbeat.mockClear()
      mockClient.getPendingCommands.mockClear()

      await jest.advanceTimersByTimeAsync(60000)

      expect(mockClient.heartbeat).not.toHaveBeenCalled()
      expect(mockClient.getPendingCommands).not.toHaveBeenCalled()
    })

    it('should expose the ApiClient via getClient()', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent.getClient()).toBeDefined()
    })

    it('should handle polling error gracefully', async () => {
      mockClient.getPendingCommands.mockRejectedValue(new Error('Network failure'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(options.pollInterval)

      // Should continue running despite polling error
      agent.stop()
    })
  })

  describe('subscription mode', () => {
    beforeEach(() => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })
    })

    it('should activate subscription mode when transportMode is realtime', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
        'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        'da2-testkey123',
      )
      expect(mockSubscriber.connect).toHaveBeenCalled()
      expect(mockSubscriber.subscribe).toHaveBeenCalled()
      expect(mockSubscriber.onReconnect).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('AppSync WebSocket'))

      agent.stop()
    })

    it('should fall back to polling when WebSocket connection fails', async () => {
      mockSubscriber.connect.mockRejectedValue(new Error('WebSocket connection failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('falling back to polling'),
      )

      // Polling should be active
      mockClient.getPendingCommands.mockResolvedValue([])
      await jest.advanceTimersByTimeAsync(options.pollInterval)
      expect(mockClient.getPendingCommands).toHaveBeenCalled()

      agent.stop()
    })

    it('should handle notification from subscription', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-1',
        type: 'execute_command',
        payload: { command: 'echo hi' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'hi' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Get the subscribe callback
      const subscribeCall = mockSubscriber.subscribe.mock.calls[0]
      const onMessage = subscribeCall[1] as (notification: Record<string, unknown>) => void

      // Simulate notification
      onMessage({
        id: 'notif-1',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-1', type: 'execute_command' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-1', 'agent-1')
      expect(mockedExecuteCommand).toHaveBeenCalled()
      expect(mockClient.submitResult).toHaveBeenCalledWith('cmd-1', { success: true, data: 'hi' }, 'agent-1')

      agent.stop()
    })

    it('should ignore notifications with missing commandId', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-no-cmdid',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { type: 'execute_command' }, // no commandId
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing commandId'))
      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore notifications with non-agent-command action', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-1',
        table: 'other',
        pk: '',
        sk: '',
        tenantCode: 'test-tenant',
        action: 'other-action',
        content: {},
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should check pending commands on reconnect', async () => {
      mockClient.getPendingCommands.mockResolvedValue([
        { commandId: 'cmd-pending', type: 'execute_command', createdAt: 123 },
      ])
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-pending',
        type: 'execute_command',
        payload: { command: 'echo pending' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'pending output' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Get the reconnect callback
      const reconnectCallback = mockSubscriber.onReconnect.mock.calls[0][0] as () => void
      reconnectCallback()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getPendingCommands).toHaveBeenCalledWith('agent-1')
      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-pending', 'agent-1')
      expect(mockedExecuteCommand).toHaveBeenCalled()

      agent.stop()
    })

    it('should disconnect subscriber on stop()', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      agent.stop()

      expect(mockSubscriber.disconnect).toHaveBeenCalled()
    })

    it('should still run heartbeat in subscription mode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.heartbeat).toHaveBeenCalled()

      agent.stop()
    })

    it('should use polling when transportMode is polling', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'polling',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(MockAppSyncSubscriber).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should handle command error in subscription mode and submit error result', async () => {
      mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
      mockClient.submitResult.mockResolvedValue(undefined)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-err',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-err', type: 'execute_command' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.commandError'))
      expect(mockClient.submitResult).toHaveBeenCalledWith(
        'cmd-err',
        expect.objectContaining({ success: false, error: expect.any(String) }),
        'agent-1',
      )

      agent.stop()
    })

    it('should log resultSendFailed when submitResult fails after command error in subscription mode', async () => {
      mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
      mockClient.submitResult.mockRejectedValue(new Error('Submit failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-err2',
        table: 'commands',
        pk: 'CMD#456',
        sk: 'CMD#456',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-err2', type: 'execute_command' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.commandError'))
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.resultSendFailed'))

      agent.stop()
    })

    it('should handle checkPendingCommands error gracefully', async () => {
      mockClient.getPendingCommands.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const reconnectCallback = mockSubscriber.onReconnect.mock.calls[0][0] as () => void
      reconnectCallback()

      await jest.advanceTimersByTimeAsync(100)

      // Should log warning and not crash
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to check pending commands'))

      agent.stop()
    })
  })

  describe('config loading', () => {
    it('should continue when getConfig fails', async () => {
      mockClient.getConfig.mockRejectedValue(new Error('Config fetch failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load server config'))
      // Should still register and start
      expect(mockClient.register).toHaveBeenCalled()

      agent.stop()
    })
  })
})
