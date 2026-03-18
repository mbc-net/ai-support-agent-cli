import { startTerminalWebSocket, startVsCodeTunnel, startHeartbeat, TransportDeps, TransportState } from '../src/agent-transport'

// Mock all dependencies
jest.mock('../src/terminal', () => ({
  isNodePtyAvailable: jest.fn(),
  TerminalWebSocket: jest.fn(),
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
    )
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
      '/test/project/workspace/repos',
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
      '/test/project/workspace/repos',
    )
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
