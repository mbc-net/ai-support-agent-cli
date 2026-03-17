import { ApiClient } from '../src/api-client'
import { AppSyncSubscriber } from '../src/appsync-subscriber'
import { writeAwsConfig } from '../src/aws-profile'
import { executeCommand } from '../src/commands'
import { logger } from '../src/logger'
import { syncProjectConfig } from '../src/project-config-sync'
import { ProjectAgent } from '../src/project-agent'
import { syncRepositories } from '../src/repo-sync'
import { detectInstallMethod, performUpdate, reExecProcess } from '../src/update-checker'

jest.mock('../src/api-client')
jest.mock('../src/appsync-subscriber')
jest.mock('../src/commands')
jest.mock('../src/logger')
jest.mock('../src/chat-mode-detector', () => ({
  detectAvailableChatModes: jest.fn().mockResolvedValue([]),
  resolveActiveChatMode: jest.fn().mockReturnValue(undefined),
}))
jest.mock('../src/project-config-sync', () => ({
  syncProjectConfig: jest.fn().mockResolvedValue({
    configHash: 'default-hash',
    project: { projectCode: 'test-proj', projectName: 'Test' },
    agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
  }),
}))
jest.mock('../src/project-dir', () => ({
  initProjectDir: jest.fn().mockReturnValue('/tmp/test-project'),
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
}))
jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))
jest.mock('../src/repo-sync', () => ({
  syncRepositories: jest.fn().mockResolvedValue([]),
}))
jest.mock('../src/update-checker', () => ({
  detectInstallMethod: jest.fn().mockReturnValue('global'),
  performUpdate: jest.fn().mockResolvedValue({ success: true }),
  reExecProcess: jest.fn(),
}))

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>
const MockAppSyncSubscriber = AppSyncSubscriber as jest.MockedClass<typeof AppSyncSubscriber>
const mockedExecuteCommand = executeCommand as jest.MockedFunction<typeof executeCommand>
const mockedSyncProjectConfig = syncProjectConfig as jest.MockedFunction<typeof syncProjectConfig>
const mockedWriteAwsConfig = writeAwsConfig as jest.MockedFunction<typeof writeAwsConfig>
const mockedSyncRepositories = syncRepositories as jest.MockedFunction<typeof syncRepositories>
const mockedDetectInstallMethod = detectInstallMethod as jest.MockedFunction<typeof detectInstallMethod>
const mockedPerformUpdate = performUpdate as jest.MockedFunction<typeof performUpdate>
const mockedReExecProcess = reExecProcess as jest.MockedFunction<typeof reExecProcess>

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
    getProjectConfig: jest.Mock
    updateToken: jest.Mock
    setTenantCode: jest.Mock
    setProjectCode: jest.Mock
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
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn().mockResolvedValue(undefined),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.1', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      reportConnectionStatus: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      getProjectConfig: jest.fn().mockResolvedValue({ configHash: 'abc123', project: { projectCode: 'test-proj' }, agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] } }),
      updateToken: jest.fn(),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
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

  describe('registration and lifecycle', () => {
    it('should register on start and begin heartbeat/subscription', async () => {
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

    it('should log error and not start when AppSync credentials are missing', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: '',
        appsyncApiKey: '',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('AppSync credentials missing'))

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

    it('should clear timers on stop()', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      agent.stop()

      mockClient.heartbeat.mockClear()
      mockClient.getPendingCommands.mockClear()

      await jest.advanceTimersByTimeAsync(60000)

      expect(mockClient.heartbeat).not.toHaveBeenCalled()
    })

    it('should expose the ApiClient via getClient()', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent.getClient()).toBeDefined()
    })
  })

  describe('subscription mode', () => {
    it('should activate subscription mode when transportMode is realtime', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
        'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        'da2-testkey123',
      )
      expect(mockSubscriber.connect).toHaveBeenCalled()
      expect(mockSubscriber.subscribe).toHaveBeenCalledWith('test-tenant', expect.any(Function))
      expect(mockSubscriber.onReconnect).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('AppSync WebSocket'))

      agent.stop()
    })

    it('should handle WebSocket connection failure', async () => {
      mockSubscriber.connect.mockRejectedValue(new Error('WebSocket connection failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket connection failed'),
      )

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
        content: { commandId: 'cmd-1', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
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
        content: { type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' }, // no commandId
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

    it('should ignore commands for different agentId', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other', type: 'execute_command', agentId: 'agent-2', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands for different projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other-proj',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other-proj', type: 'execute_command', agentId: 'agent-1', tenantCode: 'test-tenant', projectCode: 'OTHER_PROJ' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands for different tenantCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other-tenant',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other-tenant', type: 'execute_command', agentId: 'agent-1', tenantCode: 'other-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should process commands with matching tenantCode and projectCode', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-match-proj',
        type: 'execute_command',
        payload: { command: 'echo match' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'match' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-match-proj',
        table: 'commands',
        pk: 'CMD#101',
        sk: 'CMD#101',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-match-proj', type: 'execute_command', agentId: 'agent-1', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-match-proj', 'agent-1')

      agent.stop()
    })

    it('should ignore commands with missing tenantCode/projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      // tenantCode/projectCodeが未指定の通知は無視される
      onMessage({
        id: 'notif-no-tenant',
        table: 'commands',
        pk: 'CMD#200',
        sk: 'CMD#200',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-no-tenant', type: 'execute_command' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands with matching tenantCode but missing projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-no-proj',
        table: 'commands',
        pk: 'CMD#201',
        sk: 'CMD#201',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-no-proj', type: 'execute_command', tenantCode: 'test-tenant' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should process commands for matching agentId', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-match',
        type: 'execute_command',
        payload: { command: 'echo match' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'match output' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-match',
        table: 'commands',
        pk: 'CMD#101',
        sk: 'CMD#101',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-match', type: 'execute_command', agentId: 'agent-1', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-match', 'agent-1')

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
        content: { commandId: 'cmd-err', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
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
        content: { commandId: 'cmd-err2', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
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

  describe('chat_cancel via subscription', () => {
    it('should process chat_cancel command via subscription notification', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-cancel',
        type: 'chat_cancel',
        payload: { targetCommandId: 'some-cmd' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'ok' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-cancel',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-cancel', type: 'chat_cancel', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'chat_cancel',
        { targetCommandId: 'some-cmd' },
        expect.any(Object),
      )

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

  describe('project config sync', () => {
    it('should perform initial config sync after registration', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalled()

      agent.stop()
    })

    it('should apply project config when sync returns config', async () => {
      const mockConfig = {
        configHash: 'new-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: false,
          builtinFallbackEnabled: false,
          externalAgentEnabled: true,
          allowedTools: ['WebFetch'],
          claudeCodeConfig: { additionalDirs: ['/extra'], appendSystemPrompt: 'Be helpful' },
        },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce(mockConfig)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config applied'))

      agent.stop()
    })

    it('should write AWS config when project config has AWS accounts and projectDir', async () => {
      const projectWithDir = { projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api', projectDir: '/tmp/proj' }
      const mockConfig = {
        configHash: 'aws-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        aws: {
          accounts: [
            { id: '1', name: 'dev', region: 'ap-northeast-1', accountId: '123456', auth: { method: 'access_key' as const }, isDefault: true },
          ],
        },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce(mockConfig)

      const agent = new ProjectAgent(projectWithDir, 'agent-1', options, undefined, undefined)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedWriteAwsConfig).toHaveBeenCalledWith(
        '/tmp/test-project', // resolved by mocked initProjectDir
        'test-proj',
        mockConfig.aws.accounts,
      )

      agent.stop()
    })

    it('should schedule config sync when heartbeat response has different configHash', async () => {
      mockClient.heartbeat.mockResolvedValue({ success: true, configHash: 'changed-hash' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config hash changed'))

      // Wait for debounce timer
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig should be called again (initial + debounced)
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should handle config-update notification', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'config-1',
        table: 'support-agent',
        pk: 'AGENT#test-proj',
        sk: 'CONFIG#test-proj',
        tenantCode: 'test-proj',
        action: 'config-update',
        content: { configHash: 'new-hash-123', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config update detected'))

      // Wait for debounce
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig: 1 initial + 1 debounced
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should debounce multiple config-update notifications', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      // Send multiple config-update notifications rapidly
      onMessage({ id: '1', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-1' } })
      onMessage({ id: '2', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-2' } })
      onMessage({ id: '3', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-3' } })

      // Wait for debounce (only last should trigger)
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig: 1 initial + 1 debounced (not 3)
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should retry initial config sync and succeed on second attempt', async () => {
      // First attempt returns null (fail), second returns config (success)
      mockedSyncProjectConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          configHash: 'retry-hash',
          project: { projectCode: 'test-proj', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Let registration complete + first sync attempt
      await jest.advanceTimersByTimeAsync(100)
      // Advance past retry delay (2000ms * 1)
      await jest.advanceTimersByTimeAsync(2000)
      // Let second sync attempt complete
      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 1 failed'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config applied'))

      agent.stop()
    })

    it('should log warning after all initial config sync retries fail', async () => {
      // All attempts return null
      mockedSyncProjectConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Let registration + all retries complete
      // attempt 1 + delay 2000ms + attempt 2 + delay 4000ms + attempt 3
      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(2000)
      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(4000)
      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(3)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 1 failed'))
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 2 failed'))
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync failed after all retries'))

      agent.stop()
    })

    it('should not schedule config sync when configHash is same in heartbeat', async () => {
      // First sync returns a config with hash
      mockedSyncProjectConfig.mockResolvedValueOnce({
        configHash: 'same-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
      })
      // Heartbeat returns same hash
      mockClient.heartbeat.mockResolvedValue({ success: true, configHash: 'same-hash' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Should NOT log "Config hash changed"
      const hashChangedCalls = (logger.info as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('Config hash changed'),
      )
      expect(hashChangedCalls).toHaveLength(0)

      agent.stop()
    })

    it('should pass projectConfig to executeCommand options', async () => {
      const mockConfig = {
        configHash: 'cfg-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce(mockConfig)

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-cfg',
        type: 'chat',
        payload: { message: 'hello' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'ok' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Send command via subscription notification
      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-cfg',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-cfg', type: 'chat', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'chat',
        { message: 'hello' },
        expect.objectContaining({ projectConfig: mockConfig }),
      )

      agent.stop()
    })

    it('should clear configSyncDebounceTimer on stop()', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Allow registration, config sync, and subscription setup to complete
      await jest.advanceTimersByTimeAsync(500)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({ id: '1', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'pending-hash' } })

      // Stop before debounce fires
      agent.stop()

      mockedSyncProjectConfig.mockClear()
      await jest.advanceTimersByTimeAsync(5000)

      // Debounced sync should NOT have fired
      expect(mockedSyncProjectConfig).not.toHaveBeenCalled()
    })
  })

  describe('performSetup', () => {
    it('should call performConfigSync and log completion', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      // performConfigSync is called once during registration and once during setup
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting setup'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Setup completed'))

      agent.stop()
    })

    it('should sync repositories when project config has repositories', async () => {
      const mockConfig = {
        configHash: 'repo-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        repositories: [
          { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', repositoryUrl: 'https://github.com/org/repo.git', provider: 'github', branch: 'main', authMethod: 'token' },
        ],
      }
      mockedSyncProjectConfig.mockResolvedValue(mockConfig)
      mockedSyncRepositories.mockResolvedValue([
        { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', status: 'cloned' },
      ])

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(mockedSyncRepositories).toHaveBeenCalledWith(
        expect.anything(), // client
        mockConfig.repositories,
        expect.stringContaining('repos'),
        expect.stringContaining('test-proj'),
      )
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Repository sync: 1 cloned, 0 updated, 0 skipped'))

      agent.stop()
    })

    it('should handle repository sync failure gracefully', async () => {
      const mockConfig = {
        configHash: 'repo-fail-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        repositories: [
          { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', repositoryUrl: 'https://github.com/org/repo.git', provider: 'github', branch: 'main', authMethod: 'token' },
        ],
      }
      mockedSyncProjectConfig.mockResolvedValue(mockConfig)
      mockedSyncRepositories.mockRejectedValue(new Error('Sync failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Repository sync failed'))
      // Setup should still complete
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Setup completed'))

      agent.stop()
    })

    it('should log documentation sources when present in project config', async () => {
      const mockConfig = {
        configHash: 'setup-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        documentation: {
          sources: [
            { url: 'https://example.com/docs', type: 'url' as const },
          ],
        },
      }
      mockedSyncProjectConfig.mockResolvedValue(mockConfig)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Documentation sources found'))

      agent.stop()
    })
  })

  describe('onSetup and onConfigSync callbacks', () => {
    it('should pass onSetup callback that calls performSetup', async () => {
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onSetup) {
          await opts.onSetup()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-setup',
        type: 'setup',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-setup',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-setup', type: 'setup', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'setup',
        {},
        expect.objectContaining({
          onSetup: expect.any(Function),
          onConfigSync: expect.any(Function),
        }),
      )
      // performSetup calls performConfigSync internally
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting setup'))

      agent.stop()
    })

    it('should pass onConfigSync callback that calls performConfigSync', async () => {
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onConfigSync) {
          await opts.onConfigSync()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-sync',
        type: 'config_sync',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-sync',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-sync', type: 'config_sync', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'config_sync',
        {},
        expect.objectContaining({
          onConfigSync: expect.any(Function),
        }),
      )
      // performConfigSync is called: initial + callback
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })
  })

  describe('performReboot', () => {
    it('should stop transport and schedule reExecProcess', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performReboot()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reboot requested'))
      expect(mockSubscriber.disconnect).toHaveBeenCalled()

      // Advance past setTimeout(1000)
      await jest.advanceTimersByTimeAsync(1000)

      expect(mockedReExecProcess).toHaveBeenCalledWith()
    })
  })

  describe('performUpdate', () => {
    it('should update to latest version and schedule reExecProcess', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performUpdate()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Update requested'))
      expect(mockClient.getVersionInfo).toHaveBeenCalled()
      expect(mockedDetectInstallMethod).toHaveBeenCalled()
      expect(mockedPerformUpdate).toHaveBeenCalledWith('0.0.1', 'global')
      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Update to 0.0.1 successful'))
      expect(mockSubscriber.disconnect).toHaveBeenCalled()

      // Advance past setTimeout(1000)
      await jest.advanceTimersByTimeAsync(1000)

      expect(mockedReExecProcess).toHaveBeenCalledWith('global')
    })

    it('should throw error when update fails', async () => {
      mockedPerformUpdate.mockResolvedValueOnce({ success: false, error: 'Permission denied' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await expect(agent.performUpdate()).rejects.toThrow('Update failed: Permission denied')

      agent.stop()
    })
  })

  describe('updateToken', () => {
    it('should update token on ApiClient and log message', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.updateToken('new-token-123')

      expect(mockClient.updateToken).toBeDefined()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('runner.tokenUpdated'))
    })
  })

  describe('register 401 error', () => {
    it('should log authError when registration returns 401', async () => {
      const { AxiosError, AxiosHeaders } = require('axios')
      const error401 = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        data: { message: 'Invalid token' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      mockClient.register.mockRejectedValue(error401)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith('runner.authError')

      agent.stop()
    })
  })

  describe('project directory', () => {
    it('should initialize project directory when projectDir is set', () => {
      const projectWithDir = { projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api', projectDir: '/tmp/proj' }
      const agent = new ProjectAgent(projectWithDir, 'agent-1', options)
      expect(agent).toBeDefined()
    })

    it('should initialize project directory when defaultProjectDir is set', () => {
      const agent = new ProjectAgent(project, 'agent-1', options, undefined, '~/projects/{projectCode}')
      expect(agent).toBeDefined()
    })

    it('should always initialize project directory even without explicit config', () => {
      const { initProjectDir } = require('../src/project-dir')
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent).toBeDefined()
      expect(initProjectDir).toHaveBeenCalledWith(project, undefined)
    })
  })
})
