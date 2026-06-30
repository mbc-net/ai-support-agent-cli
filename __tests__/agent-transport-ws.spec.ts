import { startTerminalWebSocket, startVsCodeTunnel, startHeartbeat, handleNotification, startSubscriptionMode, checkPendingCommands, stopTransport, TransportDeps, TransportState, CommandContext } from '../src/agent-transport'
import { NOTIFICATION_ACTION } from '../src/constants'

// Mock all dependencies
jest.mock('../src/terminal', () => ({
  isNodePtyAvailable: jest.fn(),
  TerminalWebSocket: jest.fn(),
}))

jest.mock('../src/pending-result-store', () => ({
  savePendingResult: jest.fn(),
  removePendingResult: jest.fn(),
}))

jest.mock('../src/vscode', () => ({
  VsCodeTunnelWebSocket: jest.fn(),
}))

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

jest.mock('../src/i18n', () => ({
  t: jest.fn((key: string) => key),
}))

jest.mock('../src/system-info', () => ({
  getSystemInfo: jest.fn(() => ({})),
  getLocalIpAddress: jest.fn(() => '127.0.0.1'),
}))

jest.mock('../src/commands', () => ({
  executeCommand: jest.fn().mockResolvedValue({ success: true, data: 'ok' }),
}))

jest.mock('../src/agent-config-sync', () => ({
  refreshChatMode: jest.fn().mockResolvedValue(undefined),
  scheduleConfigSync: jest.fn(),
}))

jest.mock('../src/utils', () => ({
  getErrorMessage: jest.fn((e: Error) => e.message),
  isAuthenticationError: jest.fn(() => false),
}))

jest.mock('../src/project-dir', () => ({
  getWorkspaceDir: jest.fn((dir: string) => `${dir}/workspace`),
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
}))

function createMockDeps(overrides?: Partial<TransportDeps>): TransportDeps {
  return {
    client: {
      heartbeat: jest.fn().mockResolvedValue({}),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
    } as unknown as TransportDeps['client'],
    agentId: 'agent-1',
    prefix: '[test]',
    apiUrl: 'https://api.example.com',
    token: 'test-token',
    projectDir: '/test/project',
    tenantCode: 'test',
    projectCode: 'TEST_PROJ',
    pollInterval: 5000,
    heartbeatInterval: 30000,
    ...overrides,
  }
}

function createMockState(): TransportState {
  return {
    heartbeatTimer: null,
    subscriber: null,
    terminalWs: null,
    vsCodeWs: null,
    processing: false,
    configSyncDebounceTimer: null,
  }
}

describe('startTerminalWebSocket', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should skip when node-pty is not available', () => {
    const { isNodePtyAvailable } = require('../src/terminal')
    const { logger } = require('../src/logger')
    isNodePtyAvailable.mockReturnValue(false)

    const deps = createMockDeps()
    const state = createMockState()

    startTerminalWebSocket(deps, state)

    expect(state.terminalWs).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('node-pty'))
  })

  it('should create TerminalWebSocket when node-pty is available', () => {
    const { isNodePtyAvailable, TerminalWebSocket } = require('../src/terminal')
    isNodePtyAvailable.mockReturnValue(true)

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    TerminalWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startTerminalWebSocket(deps, state)

    expect(TerminalWebSocket).toHaveBeenCalledWith(
      'https://api.example.com',
      'test-token',
      'agent-1',
      '/test/project/workspace',
      undefined, // envVarsProvider (configSyncState 未指定時)
    )
    expect(state.terminalWs).not.toBeNull()
    expect(mockConnect).toHaveBeenCalled()
  })

  it('should use wsUrl when provided', () => {
    const { isNodePtyAvailable, TerminalWebSocket } = require('../src/terminal')
    isNodePtyAvailable.mockReturnValue(true)

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    TerminalWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startTerminalWebSocket(deps, state, 'wss://ws.example.com')

    expect(TerminalWebSocket).toHaveBeenCalledWith(
      'wss://ws.example.com',
      'test-token',
      'agent-1',
      '/test/project/workspace',
      undefined,
    )
  })

  it('passes envVarsProvider that returns configSyncState.projectConfig.envVars', () => {
    const { isNodePtyAvailable, TerminalWebSocket } = require('../src/terminal')
    isNodePtyAvailable.mockReturnValue(true)

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    TerminalWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()
    const configSyncState = {
      currentConfigHash: 'h1',
      projectConfig: {
        configHash: 'h1',
        project: { projectCode: 'P', projectName: 'P' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        envVars: { ANTHROPIC_API_KEY: 'sk-web' },
      },
      serverConfig: null,
      availableChatModes: [],
      activeChatMode: undefined,
      mcpConfigPath: undefined,
      dockerCustomizationHash: undefined,
    }

    startTerminalWebSocket(deps, state, undefined, configSyncState as any)

    const call = TerminalWebSocket.mock.calls[0]
    const provider = call[4] as () => Record<string, string> | undefined
    expect(provider).toBeDefined()
    expect(provider()).toEqual({ ANTHROPIC_API_KEY: 'sk-web' })
  })

  it('should handle connection failure gracefully', async () => {
    const { isNodePtyAvailable, TerminalWebSocket } = require('../src/terminal')
    const { logger } = require('../src/logger')
    isNodePtyAvailable.mockReturnValue(true)

    const mockConnect = jest.fn().mockRejectedValue(new Error('connection failed'))
    TerminalWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startTerminalWebSocket(deps, state)

    // Wait for the catch to execute
    await new Promise(resolve => process.nextTick(resolve))
    await new Promise(resolve => process.nextTick(resolve))

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection failed'))
  })
})

describe('startVsCodeTunnel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should create VsCodeTunnelWebSocket', () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    VsCodeTunnelWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startVsCodeTunnel(deps, state)

    expect(VsCodeTunnelWebSocket).toHaveBeenCalledWith(
      'https://api.example.com',
      'test-token',
      'agent-1',
      '/test/project/workspace/repos', // projectDir = reposDir (VS Code launch dir)
      '/test/project/workspace', // workspaceDir = file-upload resolution root
      undefined, // envVarsProvider (configSyncState 未指定時)
    )
    expect(state.vsCodeWs).not.toBeNull()
    expect(mockConnect).toHaveBeenCalled()
  })

  it('should use wsUrl when provided', () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    VsCodeTunnelWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startVsCodeTunnel(deps, state, 'wss://ws.example.com')

    expect(VsCodeTunnelWebSocket).toHaveBeenCalledWith(
      'wss://ws.example.com',
      'test-token',
      'agent-1',
      '/test/project/workspace/repos', // projectDir = reposDir (VS Code launch dir)
      '/test/project/workspace', // workspaceDir = file-upload resolution root
      undefined,
    )
  })

  it('passes envVarsProvider to VsCodeTunnelWebSocket when configSyncState is supplied', () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    VsCodeTunnelWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()
    const configSyncState = {
      currentConfigHash: 'h1',
      projectConfig: {
        configHash: 'h1',
        project: { projectCode: 'P', projectName: 'P' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        envVars: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
      },
      serverConfig: null,
      availableChatModes: [],
      activeChatMode: undefined,
      mcpConfigPath: undefined,
      dockerCustomizationHash: undefined,
    }

    startVsCodeTunnel(deps, state, undefined, configSyncState as any)

    // envVarsProvider is now the 6th constructor arg (index 5) after workspaceDir was added.
    const provider = VsCodeTunnelWebSocket.mock.calls[0][5] as () => Record<string, string> | undefined
    expect(provider).toBeDefined()
    expect(provider()).toEqual({ ANTHROPIC_MODEL: 'claude-sonnet-4-6' })
  })

  it('should handle connection failure gracefully', async () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')
    const { logger } = require('../src/logger')

    const mockConnect = jest.fn().mockRejectedValue(new Error('ws failed'))
    VsCodeTunnelWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startVsCodeTunnel(deps, state)

    await new Promise(resolve => process.nextTick(resolve))
    await new Promise(resolve => process.nextTick(resolve))

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ws failed'))
  })

  // REGRESSION (browser file upload from Agent Docker workspace): the VS Code
  // launch dir (reposDir = <projectDir>/workspace/repos) and the file-upload
  // resolution root (workspaceDir = <projectDir>/workspace) are DIFFERENT
  // directories. Previously only reposDir was passed and resolveWorkspaceFilePaths
  // derived the root via getWorkspaceDir(reposDir) = reposDir/workspace (which does
  // not exist), so every workspace file selection resolved to a missing path and
  // setFiles silently rejected it ("nothing happens"). startVsCodeTunnel must pass
  // workspaceDir explicitly so file resolution uses the correct root.
  it('passes workspaceDir (getWorkspaceDir, not repos/workspace) for file-upload resolution', () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    VsCodeTunnelWebSocket.mockImplementation(() => ({
      connect: mockConnect,
    }))

    const deps = createMockDeps()
    const state = createMockState()

    startVsCodeTunnel(deps, state)

    expect(VsCodeTunnelWebSocket).toHaveBeenCalledWith(
      'https://api.example.com',
      'test-token',
      'agent-1',
      '/test/project/workspace/repos', // projectDir = reposDir (VS Code launch dir)
      '/test/project/workspace', // workspaceDir = file-upload resolution root
      undefined, // envVarsProvider (configSyncState 未指定時)
    )
  })
})

describe('startHeartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should set heartbeat timer', () => {
    const deps = createMockDeps()
    const state = createMockState()
    const configSyncState = {
      availableChatModes: ['api' as const],
      activeChatMode: 'api' as const,
      currentConfigHash: undefined,
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    expect(state.heartbeatTimer).not.toBeNull()

    // Clean up
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })

  it('should call heartbeat periodically via setInterval', async () => {
    const deps = createMockDeps({ heartbeatInterval: 5000 })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: ['api' as const],
      activeChatMode: 'api' as const,
      currentConfigHash: undefined,
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    // Initial heartbeat call
    await jest.advanceTimersByTimeAsync(100)
    expect(deps.client.heartbeat).toHaveBeenCalledTimes(1)

    // Advance past heartbeat interval to trigger setInterval callback
    await jest.advanceTimersByTimeAsync(5000)
    expect(deps.client.heartbeat).toHaveBeenCalledTimes(2)

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })

  it('should call heartbeat on auth error', async () => {
    const { isAuthenticationError } = require('../src/utils')
    const { logger } = require('../src/logger')
    isAuthenticationError.mockReturnValue(true)

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockRejectedValue(new Error('401 Unauthorized')),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: [] as ('claude_code' | 'api')[],
      activeChatMode: undefined,
      currentConfigHash: undefined,
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    // Wait for the initial heartbeat to complete
    await jest.advanceTimersByTimeAsync(100)

    expect(logger.error).toHaveBeenCalled()

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })
})

describe('processCommand processing flag', () => {
  function createMockCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should set processing=true during command execution and reset after', async () => {
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: { command: 'echo hello' } }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = createMockCtx(state)

    let processingDuringExecution = false
    executeCommand.mockImplementation(async () => {
      processingDuringExecution = state.processing
      return { success: true, data: 'ok' }
    })

    expect(state.processing).toBe(false)

    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-1',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(processingDuringExecution).toBe(true)
    expect(state.processing).toBe(false)
  })

  it('should reset processing=false even when command execution throws', async () => {
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = createMockCtx(state)

    executeCommand.mockRejectedValue(new Error('command failed'))

    await handleNotification(deps, state, ctx, {
      id: 'n2', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-2',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(state.processing).toBe(false)
  })
})

describe('handleNotification: agent-log and unknown actions', () => {
  const { logger } = require('../src/logger')

  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
    } as unknown as CommandContext
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should silently return on agent-log action without any log output (infinite loop prevention)', async () => {
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_LOG,
      content: { agentId: 'agent-1', logType: 'container', seq: 1, text: 'some log' },
    })

    // agent-log受信時はdebugログも含め一切ログ出力しない（無限ループ防止）
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('should log "Ignoring notification" for truly unknown actions', async () => {
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n2', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: 'some-unknown-action',
      content: {},
    })

    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring notification with action: some-unknown-action'))).toBe(true)
  })

  describe('alert-created action', () => {
    const createAlertClient = () => ({
      heartbeat: jest.fn().mockResolvedValue({}),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn(),
      getPendingAlerts: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getAlert: jest.fn().mockResolvedValue(null),
      updateAlertStatus: jest.fn().mockResolvedValue(undefined),
      findActiveIssueByAlarmName: jest.fn().mockResolvedValue(null),
      createIssueFromAlert: jest.fn().mockResolvedValue({ id: 'AI_SU000001' }),
    } as unknown as TransportDeps['client'])

    it('should process alert for matching projectCode', async () => {
      const deps = createMockDeps({ client: createAlertClient() })
      const state = createMockState()
      const ctx = makeCtx(state)

      await handleNotification(deps, state, ctx, {
        id: 'n3', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
        action: NOTIFICATION_ACTION.ALERT_CREATED,
        content: {
          projectCode: 'TEST_PROJ',
          alertNumber: 'AL000001',
          alarmName: 'CPUHigh',
        },
      })

      // updateAlertStatus called with 'processing' (alert processing started)
      expect((deps.client as Record<string, jest.Mock>).updateAlertStatus).toHaveBeenCalledWith(
        'test', 'TEST_PROJ', 'AL000001', { status: 'processing' },
      )
    })

    it('should ignore alert for different projectCode', async () => {
      const deps = createMockDeps({ client: createAlertClient() })
      const state = createMockState()
      const ctx = makeCtx(state)

      await handleNotification(deps, state, ctx, {
        id: 'n4', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
        action: NOTIFICATION_ACTION.ALERT_CREATED,
        content: {
          projectCode: 'OTHER_PROJ',
          alertNumber: 'AL000001',
          alarmName: 'CPUHigh',
        },
      })

      expect((deps.client as Record<string, jest.Mock>).updateAlertStatus).not.toHaveBeenCalled()
    })

    it('should ignore alert when alertNumber is missing', async () => {
      const deps = createMockDeps({ client: createAlertClient() })
      const state = createMockState()
      const ctx = makeCtx(state)

      await handleNotification(deps, state, ctx, {
        id: 'n5', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
        action: NOTIFICATION_ACTION.ALERT_CREATED,
        content: {
          projectCode: 'TEST_PROJ',
          // alertNumber is missing
        },
      })

      expect((deps.client as Record<string, jest.Mock>).updateAlertStatus).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Additional tests for uncovered branches
// ---------------------------------------------------------------------------

describe('startSubscriptionMode', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  it('should connect and subscribe successfully', async () => {
    const { logger } = require('../src/logger')

    const mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
      onReconnect: jest.fn(),
      disconnect: jest.fn(),
    }
    const MockSubscriberClass = jest.fn().mockImplementation(() => mockSubscriber)

    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await startSubscriptionMode(deps, state, ctx, MockSubscriberClass, 'wss://appsync.example.com', 'api-key-123')

    expect(MockSubscriberClass).toHaveBeenCalledWith('wss://appsync.example.com', 'api-key-123')
    expect(mockSubscriber.connect).toHaveBeenCalled()
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith(deps.tenantCode, expect.any(Function))
    expect(mockSubscriber.onReconnect).toHaveBeenCalledWith(expect.any(Function))
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Connected via AppSync WebSocket'))
    expect(state.subscriber).toBe(mockSubscriber)
  })

  it('should throw when connection fails', async () => {
    const { logger } = require('../src/logger')

    const mockSubscriber = {
      connect: jest.fn().mockRejectedValue(new Error('connection error')),
      subscribe: jest.fn(),
      onReconnect: jest.fn(),
      disconnect: jest.fn(),
    }
    const MockSubscriberClass = jest.fn().mockImplementation(() => mockSubscriber)

    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await expect(
      startSubscriptionMode(deps, state, ctx, MockSubscriberClass, 'wss://appsync.example.com', 'api-key-123')
    ).rejects.toThrow('connection error')

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('connection error'))
  })

  it('should trigger checkPendingCommands and checkPendingAlerts on reconnect', async () => {
    const AlertProcessorModule = require('../src/alert-processor')

    let reconnectCallback: (() => void) | undefined
    const mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
      onReconnect: jest.fn((cb: () => void) => { reconnectCallback = cb }),
      disconnect: jest.fn(),
    }
    const MockSubscriberClass = jest.fn().mockImplementation(() => mockSubscriber)

    const mockCheckPendingAlerts = jest.fn().mockResolvedValue(undefined)
    const originalClass = AlertProcessorModule.AlertProcessor
    const MockAlertProcessorClass = jest.fn().mockImplementation(() => ({
      checkPendingAlerts: mockCheckPendingAlerts,
      processAlert: jest.fn().mockResolvedValue(undefined),
    }))
    AlertProcessorModule.AlertProcessor = MockAlertProcessorClass

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    try {
      await startSubscriptionMode(deps, state, ctx, MockSubscriberClass, 'wss://appsync.example.com', 'api-key')

      expect(reconnectCallback).toBeDefined()
      reconnectCallback!()

      // Wait for async calls inside reconnectCallback
      await new Promise(resolve => process.nextTick(resolve))
      await new Promise(resolve => process.nextTick(resolve))

      expect(deps.client.getPendingCommands).toHaveBeenCalledWith(deps.agentId)
      expect(mockCheckPendingAlerts).toHaveBeenCalled()
    } finally {
      AlertProcessorModule.AlertProcessor = originalClass
    }
  })

  it('should pass notifications to handleNotification via subscribe callback', async () => {
    const { executeCommand } = require('../src/commands')
    executeCommand.mockResolvedValue({ success: true, data: 'ok' })

    let subscribeCallback: ((n: any) => void) | undefined
    const mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn((_tenant: string, cb: (n: any) => void) => { subscribeCallback = cb }),
      onReconnect: jest.fn(),
      disconnect: jest.fn(),
    }
    const MockSubscriberClass = jest.fn().mockImplementation(() => mockSubscriber)

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await startSubscriptionMode(deps, state, ctx, MockSubscriberClass, 'wss://appsync.example.com', 'api-key')

    expect(subscribeCallback).toBeDefined()

    // Trigger with an agent-log notification (early return, no side effects)
    subscribeCallback!({
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_LOG,
      content: {},
    })

    await new Promise(resolve => process.nextTick(resolve))
    // No commands processed for agent-log
    expect(executeCommand).not.toHaveBeenCalled()
  })
})

describe('startHeartbeat: configHash mismatch triggers sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should schedule config sync when heartbeat response has different configHash', async () => {
    const { scheduleConfigSync } = require('../src/agent-config-sync')
    scheduleConfigSync.mockReturnValue('mock-timer')

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({ configHash: 'new-hash-xyz' }),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: ['api' as const],
      activeChatMode: 'api' as const,
      currentConfigHash: 'old-hash-abc',
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    await jest.advanceTimersByTimeAsync(100)

    expect(scheduleConfigSync).toHaveBeenCalled()
    expect(state.configSyncDebounceTimer).toBe('mock-timer')

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })

  it('should NOT schedule config sync when configHash matches', async () => {
    const { scheduleConfigSync } = require('../src/agent-config-sync')

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({ configHash: 'same-hash' }),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: ['api' as const],
      activeChatMode: 'api' as const,
      currentConfigHash: 'same-hash',
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    await jest.advanceTimersByTimeAsync(100)

    expect(scheduleConfigSync).not.toHaveBeenCalled()

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })

  it('should log warn for non-auth heartbeat errors', async () => {
    const { isAuthenticationError } = require('../src/utils')
    const { logger } = require('../src/logger')
    isAuthenticationError.mockReturnValue(false)

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockRejectedValue(new Error('network error')),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: [] as ('claude_code' | 'api')[],
      activeChatMode: undefined,
      currentConfigHash: undefined,
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    await jest.advanceTimersByTimeAsync(100)

    expect(logger.warn).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })
})

describe('handleNotification: agent-command filtering branches', () => {
  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should skip command targeted at a different agentId', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-x',
        agentId: 'other-agent-999',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring command for agent other-agent-999'))).toBe(true)
  })

  it('should skip command when tenantCode is missing', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n2', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-x',
        agentId: 'agent-1',
        // tenantCode is missing
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring command for tenant'))).toBe(true)
  })

  it('should skip command when tenantCode does not match', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n3', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-x',
        agentId: 'agent-1',
        tenantCode: 'other-tenant',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring command for tenant other-tenant'))).toBe(true)
  })

  it('should skip command when projectCode is missing', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n4', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-x',
        agentId: 'agent-1',
        tenantCode: 'test',
        // projectCode is missing
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring command for project'))).toBe(true)
  })

  it('should skip command when projectCode does not match', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n5', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-x',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'WRONG_PROJ',
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring command for project WRONG_PROJ'))).toBe(true)
  })

  it('should warn when commandId is missing', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n6', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        // commandId is missing
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    expect(executeCommand).not.toHaveBeenCalled()
    expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('missing commandId')
    )
  })

  it('should handle config-update notification and schedule sync', async () => {
    const { logger } = require('../src/logger')
    const { scheduleConfigSync } = require('../src/agent-config-sync')
    scheduleConfigSync.mockReturnValue('debounce-timer')

    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n7', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.CONFIG_UPDATE,
      content: {},
    })

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config update notification received'))
    expect(ctx.configSyncState.currentConfigHash).toBeUndefined()
    expect(scheduleConfigSync).toHaveBeenCalled()
    expect(state.configSyncDebounceTimer).toBe('debounce-timer')
  })

  it('should handle string content by JSON.parse', async () => {
    const { executeCommand } = require('../src/commands')
    executeCommand.mockResolvedValue({ success: true, data: 'ok' })

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    // content as JSON string (AppSync AWSJSON format)
    const contentObj = {
      commandId: 'cmd-json',
      agentId: 'agent-1',
      tenantCode: 'test',
      projectCode: 'TEST_PROJ',
      type: 'shell',
    }

    await handleNotification(deps, state, ctx, {
      id: 'n8', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: JSON.stringify(contentObj) as any,
    })

    expect(executeCommand).toHaveBeenCalled()
  })
})

describe('checkPendingCommands', () => {
  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should process each pending command', async () => {
    const { executeCommand } = require('../src/commands')
    executeCommand.mockResolvedValue({ success: true, data: 'ok' })

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([
          { commandId: 'pending-1', type: 'shell' },
          { commandId: 'pending-2', type: 'setup' },
        ]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await checkPendingCommands(deps, ctx)

    expect(deps.client.getPendingCommands).toHaveBeenCalledWith(deps.agentId)
    expect(deps.client.getCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand).toHaveBeenCalledTimes(2)
  })

  it('should handle cmd.type being undefined (use "unknown")', async () => {
    const { executeCommand } = require('../src/commands')
    const { logger } = require('../src/logger')
    executeCommand.mockResolvedValue({ success: true, data: 'ok' })

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([
          { commandId: 'pending-no-type' },
        ]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await checkPendingCommands(deps, ctx)

    // The info log should be called with 'unknown' type
    const infoCalls = (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(infoCalls.some((m: string) => m.includes('runner.commandReceived'))).toBe(true)
  })

  it('should warn when getPendingCommands fails', async () => {
    const { logger } = require('../src/logger')

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockRejectedValue(new Error('network failure')),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    // Should not throw
    await expect(checkPendingCommands(deps, ctx)).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to check pending commands')
    )
  })
})

describe('processCommand: submitResult failure in error handler (line 343)', () => {
  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should log resultSendFailed when submitResult also throws in error handler', async () => {
    const { executeCommand } = require('../src/commands')
    const { logger } = require('../src/logger')
    executeCommand.mockRejectedValue(new Error('execution failed'))

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockRejectedValue(new Error('submit also failed')),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-fail',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    // Both logger.error calls: commandError + resultSendFailed
    const errorCalls = (logger.error as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(errorCalls.some((m: string) => m.includes('runner.resultSendFailed'))).toBe(true)
    expect(state.processing).toBe(false)
  })
})

describe('stopTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should clear all resources when all state is populated', () => {
    const mockClearInterval = jest.spyOn(global, 'clearInterval')
    const mockClearTimeout = jest.spyOn(global, 'clearTimeout')

    const mockSubscriber = { disconnect: jest.fn() }
    const mockTerminalWs = { disconnect: jest.fn() }
    const mockVsCodeWs = { disconnect: jest.fn() }

    const state: TransportState = {
      heartbeatTimer: setInterval(() => {}, 99999),
      configSyncDebounceTimer: setTimeout(() => {}, 99999),
      subscriber: mockSubscriber as any,
      terminalWs: mockTerminalWs as any,
      vsCodeWs: mockVsCodeWs as any,
      processing: false,
    }

    stopTransport(state)

    expect(mockClearInterval).toHaveBeenCalledWith(state.heartbeatTimer)
    expect(mockClearTimeout).toHaveBeenCalledWith(state.configSyncDebounceTimer)
    expect(mockSubscriber.disconnect).toHaveBeenCalled()
    expect(mockTerminalWs.disconnect).toHaveBeenCalled()
    expect(mockVsCodeWs.disconnect).toHaveBeenCalled()

    mockClearInterval.mockRestore()
    mockClearTimeout.mockRestore()
  })

  it('should not throw when all state is null', () => {
    const state = {
      heartbeatTimer: null,
      configSyncDebounceTimer: null,
      subscriber: null,
      terminalWs: null,
      vsCodeWs: null,
      processing: false,
    }

    expect(() => stopTransport(state)).not.toThrow()
  })
})

describe('startTerminalWebSocket: no projectDir', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should pass undefined terminalDir when projectDir is not set', () => {
    const { isNodePtyAvailable, TerminalWebSocket } = require('../src/terminal')
    isNodePtyAvailable.mockReturnValue(true)

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    TerminalWebSocket.mockImplementation(() => ({ connect: mockConnect }))

    const deps = createMockDeps({ projectDir: undefined })
    const state = createMockState()

    startTerminalWebSocket(deps, state)

    expect(TerminalWebSocket).toHaveBeenCalledWith(
      deps.apiUrl,
      deps.token,
      deps.agentId,
      undefined,
      undefined,
    )
  })
})

describe('startVsCodeTunnel: no projectDir', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should pass undefined reposDir and workspaceDir when projectDir is not set', () => {
    const { VsCodeTunnelWebSocket } = require('../src/vscode')

    const mockConnect = jest.fn().mockResolvedValue(undefined)
    VsCodeTunnelWebSocket.mockImplementation(() => ({ connect: mockConnect }))

    const deps = createMockDeps({ projectDir: undefined })
    const state = createMockState()

    startVsCodeTunnel(deps, state)

    expect(VsCodeTunnelWebSocket).toHaveBeenCalledWith(
      deps.apiUrl,
      deps.token,
      deps.agentId,
      undefined, // reposDir (projectDir 未設定)
      undefined, // workspaceDir (projectDir 未設定)
      undefined, // envVarsProvider
    )
  })
})

// ---------------------------------------------------------------------------
// Branch coverage: nullish/ternary paths
// ---------------------------------------------------------------------------

describe('startHeartbeat: activeChatMode undefined branch (line 119)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should log "none" when activeChatMode is undefined', async () => {
    const { logger } = require('../src/logger')

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn(),
        submitResult: jest.fn(),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const configSyncState = {
      availableChatModes: [] as ('claude_code' | 'api')[],
      activeChatMode: undefined,  // undefined → falls to 'none'
      currentConfigHash: undefined,
      serverConfig: null,
      projectConfig: undefined,
      mcpConfigPath: undefined,
    }
    const configSyncDeps = {
      client: deps.client,
      agentId: deps.agentId,
      prefix: deps.prefix,
      projectDir: deps.projectDir,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    startHeartbeat(deps, state, configSyncState as any, configSyncDeps as any)

    await jest.advanceTimersByTimeAsync(100)

    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('activeChatMode=none'))).toBe(true)

    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
  })
})

describe('handleNotification: null content branch (line 201)', () => {
  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should treat null content as empty object', async () => {
    const { logger } = require('../src/logger')
    const deps = createMockDeps()
    const state = createMockState()
    const ctx = makeCtx(state)

    // content is null (not a string, not an object) → falls to {}
    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: 'some-unknown-action',
      content: null as any,
    })

    // Should not throw; falls to default case
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('Ignoring notification with action: some-unknown-action'))).toBe(true)
  })

  it('should use "unknown" as commandType when type is missing (line 237)', async () => {
    const { logger } = require('../src/logger')
    const { executeCommand } = require('../src/commands')
    executeCommand.mockResolvedValue({ success: true, data: 'ok' })

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n2', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-no-type',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        // type is missing → falls to 'unknown'
      },
    })

    // Should have processed the command (info log with 'runner.commandReceived')
    const infoCalls = (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(infoCalls.some((m: string) => m.includes('runner.commandReceived'))).toBe(true)
  })

  it('should log "unknown" alarm name when alarmName is missing in alert-created (line 260)', async () => {
    const { logger } = require('../src/logger')
    const AlertProcessorModule = require('../src/alert-processor')
    const originalClass = AlertProcessorModule.AlertProcessor
    const mockProcessAlert = jest.fn().mockResolvedValue(undefined)
    AlertProcessorModule.AlertProcessor = jest.fn().mockImplementation(() => ({
      processAlert: mockProcessAlert,
      checkPendingAlerts: jest.fn().mockResolvedValue(undefined),
    }))

    try {
      const deps = createMockDeps()
      const state = createMockState()
      const ctx = makeCtx(state)

      await handleNotification(deps, state, ctx, {
        id: 'n3', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
        action: NOTIFICATION_ACTION.ALERT_CREATED,
        content: {
          projectCode: 'TEST_PROJ',
          alertNumber: 'AL000999',
          // alarmName is missing → falls to 'unknown'
        },
      })

      const infoCalls = (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
      expect(infoCalls.some((m: string) => m.includes('alarm: unknown'))).toBe(true)
      expect(mockProcessAlert).toHaveBeenCalledWith('AL000999')
    } finally {
      AlertProcessorModule.AlertProcessor = originalClass
    }
  })
})

describe('processCommand: failed result branches (lines 322-329)', () => {
  function makeCtx(state: TransportState): CommandContext {
    return {
      configSyncState: {
        currentConfigHash: undefined,
        projectConfig: undefined,
        serverConfig: null,
        availableChatModes: [],
        activeChatMode: undefined,
        mcpConfigPath: undefined,
        dockerCustomizationHash: undefined,
      },
      configSyncDeps: {} as any,
      transportState: state,
      onSetup: jest.fn(),
      onConfigSync: jest.fn(),
      onReboot: jest.fn(),
      onUpdate: jest.fn(),
      onSyncRepository: jest.fn(),
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should log failed result when command returns success=false', async () => {
    const { executeCommand } = require('../src/commands')
    const { logger } = require('../src/logger')
    // Return a failed result (not an error throw)
    executeCommand.mockResolvedValue({ success: false, error: 'command failed reason' })

    const deps = createMockDeps({
      client: {
        heartbeat: jest.fn().mockResolvedValue({}),
        getPendingCommands: jest.fn().mockResolvedValue([]),
        getCommand: jest.fn().mockResolvedValue({ type: 'shell', payload: {} }),
        submitResult: jest.fn().mockResolvedValue(undefined),
      } as unknown as TransportDeps['client'],
    })
    const state = createMockState()
    const ctx = makeCtx(state)

    await handleNotification(deps, state, ctx, {
      id: 'n1', table: 't', pk: 'pk', sk: 'sk', tenantCode: 'test',
      action: NOTIFICATION_ACTION.AGENT_COMMAND,
      content: {
        commandId: 'cmd-fail-result',
        agentId: 'agent-1',
        tenantCode: 'test',
        projectCode: 'TEST_PROJ',
        type: 'shell',
      },
    })

    // logger.debug should have logged with result.error (not result.data)
    const debugCalls = (logger.debug as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(debugCalls.some((m: string) => m.includes('command failed reason'))).toBe(true)

    // logger.info should contain 'failed'
    const infoCalls = (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(infoCalls.some((m: string) => m.includes('runner.commandDone'))).toBe(true)

    // submitResult was called with the failed result
    expect(deps.client.submitResult).toHaveBeenCalledWith(
      'cmd-fail-result',
      { success: false, error: 'command failed reason' },
      'agent-1',
    )

    expect(state.processing).toBe(false)
  })
})
