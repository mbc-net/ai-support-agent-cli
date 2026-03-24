import WebSocket from 'ws'

import { VsCodeTunnelWebSocket, VsCodeAgentMessage } from '../../src/vscode/vscode-tunnel-websocket'

// Mock dependencies
jest.mock('ws')
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))
jest.mock('../../src/vscode/vscode-server')
jest.mock('../../src/vscode/vscode-http-proxy')
jest.mock('../../src/vscode/vscode-ws-proxy')
jest.mock('../../src/mcp/tools/browser/browser-security', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}))

describe('VsCodeTunnelWebSocket', () => {
  let tunnel: VsCodeTunnelWebSocket
  let sentMessages: VsCodeAgentMessage[]
  let mockWs: { send: jest.Mock; readyState: number; on: jest.Mock; close: jest.Mock; terminate: jest.Mock }
  beforeEach(() => {
    jest.clearAllMocks()
    sentMessages = []

    mockWs = {
      send: jest.fn((data: string) => {
        sentMessages.push(JSON.parse(data) as VsCodeAgentMessage)
      }),
      readyState: WebSocket.OPEN,
      on: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
    }

    // Capture message handler from ws.on('message', ...)
    ;(WebSocket as unknown as jest.Mock).mockImplementation(() => {
      return mockWs
    })

    tunnel = new VsCodeTunnelWebSocket(
      'https://api.example.com',
      'test-token',
      'agent-123',
      '/test/project',
    )

    // Access internal ws and set up message handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(tunnel as any).ws = mockWs

    // Find the message handler registered via on('message', ...)
    const onCalls = mockWs.on.mock.calls
    const messageCb = onCalls.find((c: [string, (...args: unknown[]) => void]) => c[0] === 'message')
    if (messageCb) {
      // messageHandler captured but not used in current tests
      void messageCb[1]
    }
  })

  describe('constructor', () => {
    it('should convert API URL to WebSocket URL', () => {
      const t = new VsCodeTunnelWebSocket(
        'https://api.example.com',
        'token',
        'agent-1',
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((t as any).wsUrl).toBe('wss://api.example.com/ws/agent-vscode')
    })

    it('should handle http URL', () => {
      const t = new VsCodeTunnelWebSocket(
        'http://localhost:3000',
        'token',
        'agent-1',
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((t as any).wsUrl).toBe('ws://localhost:3000/ws/agent-vscode')
    })

    it('should strip trailing slash from URL', () => {
      const t = new VsCodeTunnelWebSocket(
        'https://api.example.com/',
        'token',
        'agent-1',
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((t as any).wsUrl).toBe('wss://api.example.com/ws/agent-vscode')
    })
  })

  describe('onParsedMessage', () => {
    it('should handle auth_success silently', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'auth_success' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should log error messages from server', () => {
      const { logger } = require('../../src/logger')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'error', message: 'test error', sessionId: 'sess-1' })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('test error'))
    })

    it('should log unknown message types', () => {
      const { logger } = require('../../src/logger')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'unknown_type' as any })
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('unknown_type'))
    })

    it('should dispatch vscode_open to handleVsCodeOpen', () => {
      // vscode_open without sessionId should trigger error send
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'vscode_open' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toBe('Missing sessionId')
    })

    it('should dispatch vscode_close to handleVsCodeClose', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'vscode_close', sessionId: 'sess-1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'vscode_stopped', sessionId: 'sess-1' })
    })

    it('should dispatch http_request to handleHttpRequest', () => {
      // Without running server, should send error
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'http_request', requestId: 'req-1' })
      // handleHttpRequest is async, but the error send is synchronous for the not-running case
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
    })

    it('should dispatch ws_frame to handleWsFrame', () => {
      // Without running server, handleWsFrame returns early silently
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'ws_frame', subSocketId: 'sub-1' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should handle error with no message', () => {
      const { logger } = require('../../src/logger')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'error' })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown'))
    })
  })

  describe('handleVsCodeOpen', () => {
    it('should send error if sessionId is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleVsCodeOpen({ type: 'vscode_open' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'error', message: 'Missing sessionId' })
    })

    it('should send error if no project directory', async () => {
      const t = new VsCodeTunnelWebSocket('https://api.example.com', 'token', 'agent-1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(t as any).ws = mockWs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'error', sessionId: 'sess-1', message: 'No project directory' })
    })

    it('should send error with message field (not error field) on failure', async () => {
      const { VsCodeServer } = require('../../src/vscode/vscode-server')
      VsCodeServer.mockImplementation(() => ({
        start: jest.fn().mockRejectedValue(new Error('spawn code-server ENOENT')),
        isRunning: false,
      }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-1', projectDir: '/test' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].sessionId).toBe('sess-1')
      // Verify message field is used (not error field)
      expect(sentMessages[0].message).toContain('Failed to start code-server')
      expect(sentMessages[0]).not.toHaveProperty('error')
    })
  })

  describe('handleVsCodeClose', () => {
    it('should send vscode_stopped', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleVsCodeClose({ type: 'vscode_close', sessionId: 'sess-1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'vscode_stopped', sessionId: 'sess-1' })
    })
  })

  describe('handleHttpRequest', () => {
    it('should send error with message field when code-server is not running', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({ type: 'http_request', requestId: 'req-1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'error',
        requestId: 'req-1',
        message: 'code-server is not running',
      })
    })
  })

  describe('closeWebSocket', () => {
    it('should close if OPEN', () => {
      const ws = { readyState: WebSocket.OPEN, close: jest.fn(), terminate: jest.fn() } as unknown as WebSocket
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).closeWebSocket(ws)
      expect((ws as any).close).toHaveBeenCalled()
    })

    it('should terminate if not OPEN/CLOSING', () => {
      const ws = { readyState: WebSocket.CLOSED, close: jest.fn(), terminate: jest.fn() } as unknown as WebSocket
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).closeWebSocket(ws)
      expect((ws as any).terminate).toHaveBeenCalled()
    })
  })

  describe('handleVsCodeOpen - success path', () => {
    it('should reuse existing running server', async () => {
      const mockServer = { isRunning: true, touch: jest.fn(), getPort: jest.fn().mockReturnValue(8443) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-1' })

      expect(mockServer.touch).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'vscode_ready', sessionId: 'sess-1', port: 8443, projectDir: '/test/project' })
    })

    it('should start new server and send vscode_ready', async () => {
      const { VsCodeServer } = require('../../src/vscode/vscode-server')
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')

      const mockServerInstance = { start: jest.fn().mockResolvedValue(undefined), getPort: jest.fn().mockReturnValue(8443), isRunning: false }
      VsCodeServer.mockImplementation(() => mockServerInstance)
      VsCodeWsProxy.mockImplementation(() => ({}))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-1' })

      expect(mockServerInstance.start).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'vscode_ready', sessionId: 'sess-1', port: 8443, projectDir: '/test/project' })
    })

    it('should use projectDir from message if provided', async () => {
      const { VsCodeServer } = require('../../src/vscode/vscode-server')
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')

      VsCodeServer.mockImplementation(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        getPort: jest.fn().mockReturnValue(8443),
        isRunning: false,
      }))
      VsCodeWsProxy.mockImplementation(() => ({}))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-1', projectDir: '/custom/dir' })

      expect(VsCodeServer).toHaveBeenCalledWith({ projectDir: '/custom/dir' })
    })
  })

  describe('handleVsCodeClose', () => {
    it('should not send if no sessionId', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleVsCodeClose({ type: 'vscode_close' })
      expect(sentMessages).toHaveLength(0)
    })
  })

  describe('handleHttpRequest - success path', () => {
    it('should proxy request and send response', async () => {
      const { proxyHttpRequest } = require('../../src/vscode/vscode-http-proxy')
      const mockServer = { isRunning: true, touch: jest.fn(), getPort: jest.fn().mockReturnValue(8443) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer

      proxyHttpRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: 'short',
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({
        type: 'http_request',
        requestId: 'req-1',
        sessionId: 'sess-1',
        method: 'GET',
        path: '/',
        headers: {},
      })

      expect(mockServer.touch).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'http_response',
        requestId: 'req-1',
        statusCode: 200,
      })
    })

    it('should chunk large responses', async () => {
      const { proxyHttpRequest } = require('../../src/vscode/vscode-http-proxy')
      const mockServer = { isRunning: true, touch: jest.fn(), getPort: jest.fn().mockReturnValue(8443) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer

      // Create a body larger than HTTP_RESPONSE_CHUNK_SIZE (512KB)
      const largeBody = 'x'.repeat(600000)
      proxyHttpRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: largeBody,
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({
        type: 'http_request',
        requestId: 'req-1',
        sessionId: 'sess-1',
        method: 'GET',
        path: '/',
      })

      expect(sentMessages.length).toBeGreaterThan(1)
      expect(sentMessages[0].bodyChunkIndex).toBe(0)
      expect(sentMessages[0].headers).toBeDefined()
      // Second chunk should not have headers
      expect(sentMessages[1].headers).toBeUndefined()
    })

    it('should send error on proxy failure', async () => {
      const { proxyHttpRequest } = require('../../src/vscode/vscode-http-proxy')
      const mockServer = { isRunning: true, touch: jest.fn(), getPort: jest.fn().mockReturnValue(8443) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer

      proxyHttpRequest.mockRejectedValue(new Error('connection refused'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({
        type: 'http_request',
        requestId: 'req-1',
        sessionId: 'sess-1',
      })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('HTTP proxy error')
    })
  })

  describe('handleWsFrame', () => {
    it('should do nothing if server not running', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({ type: 'ws_frame', subSocketId: 'sub-1', data: 'test' })
      // No error should occur
    })

    it('should do nothing if no subSocketId', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({ type: 'ws_frame' })
      expect(mockProxy.openConnection).not.toHaveBeenCalled()
    })

    it('should open connection when isOpen and path are provided', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        subSocketId: 'sub-1',
        isOpen: true,
        path: '/ws/path',
        sessionId: 'sess-1',
      })

      expect(mockProxy.openConnection).toHaveBeenCalledWith(
        'sub-1',
        '/ws/path',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      )
    })

    it('should close connection when isClosed is set', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        subSocketId: 'sub-1',
        isClosed: true,
      })

      expect(mockProxy.closeConnection).toHaveBeenCalledWith('sub-1')
    })

    it('should send frame when data is provided', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        subSocketId: 'sub-1',
        data: 'test-data',
      })

      expect(mockProxy.sendFrame).toHaveBeenCalledWith('sub-1', 'test-data')
    })

    it('should relay ws data and close callbacks via openConnection', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        subSocketId: 'sub-1',
        isOpen: true,
        path: '/ws',
        sessionId: 'sess-1',
      })

      // Get the onOpen, onData and onClose callbacks
      const onOpen = mockProxy.openConnection.mock.calls[0][2]
      const onData = mockProxy.openConnection.mock.calls[0][3]
      const onClose = mockProxy.openConnection.mock.calls[0][4]

      // Invoke onOpen callback
      onOpen()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'ws_frame',
        sessionId: 'sess-1',
        subSocketId: 'sub-1',
        isOpen: true,
      })

      // Invoke onData callback
      onData('encoded-data')
      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[1]).toMatchObject({
        type: 'ws_frame',
        sessionId: 'sess-1',
        subSocketId: 'sub-1',
        data: 'encoded-data',
      })

      // Invoke onClose callback
      onClose()
      expect(sentMessages).toHaveLength(3)
      expect(sentMessages[2]).toMatchObject({
        type: 'ws_frame',
        sessionId: 'sess-1',
        subSocketId: 'sub-1',
        isClosed: true,
      })
    })
  })

  describe('send', () => {
    it('should not send if ws is not set', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).ws = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).send({ type: 'error', message: 'test' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should not send if ws is not OPEN', () => {
      mockWs.readyState = WebSocket.CLOSED
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).send({ type: 'error', message: 'test' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should catch send errors', () => {
      mockWs.send.mockImplementation(() => { throw new Error('send failed') })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (tunnel as any).send({ type: 'error', message: 'test' })).not.toThrow()
    })
  })

  describe('onDisconnect', () => {
    it('should call cleanup', () => {
      const mockServer = { stop: jest.fn() }
      const mockProxy = { closeAll: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onDisconnect()

      expect(mockServer.stop).toHaveBeenCalled()
      expect(mockProxy.closeAll).toHaveBeenCalled()
    })
  })

  describe('createWebSocket', () => {
    it('should create WebSocket with auth headers', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = (tunnel as any).createWebSocket()
      expect(WebSocket).toHaveBeenCalledWith(
        'wss://api.example.com/ws/agent-vscode',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            'X-Agent-Id': 'agent-123',
          },
        }),
      )
      expect(ws).toBeDefined()
    })
  })

  describe('onOpen', () => {
    it('should reset reconnect attempts and resolve', () => {
      const resolve = jest.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).reconnectAttemptsRef = { current: 3 }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).reconnectAttemptsRef.current).toBe(0)
      expect(resolve).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('should stop server and close proxy', () => {
      const mockServer = { stop: jest.fn() }
      const mockProxy = { closeAll: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).cleanup()

      expect(mockServer.stop).toHaveBeenCalled()
      expect(mockProxy.closeAll).toHaveBeenCalled()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).vsCodeServer).toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).wsProxy).toBeNull()
    })
  })

  // --- Browser handler tests ---

  describe('handleBrowserOpen', () => {
    it('should send error if sessionId is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'error', message: 'Missing sessionId' })
    })

    it('should create session, start live view and send browser_ready', async () => {
      const mockPage = {
        goto: jest.fn().mockResolvedValue(undefined),
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('fake')),
      }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-b1' })

      expect(tunnel.browserSessionManager.getOrCreate).toHaveBeenCalledWith('sess-b1')
      expect(mockSession.startLiveView).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'browser_ready',
        sessionId: 'sess-b1',
        currentUrl: 'about:blank',
      })
    })

    it('should navigate to URL if provided', async () => {
      const mockPage = {
        goto: jest.fn().mockResolvedValue(undefined),
        url: jest.fn().mockReturnValue('https://example.com'),
        title: jest.fn().mockResolvedValue('Example'),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('fake')),
      }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('https://example.com'),
        getPageTitle: jest.fn().mockResolvedValue('Example'),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-b2',
        url: 'https://example.com',
      })

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object))
    })

    it('should link conversation if conversationId provided', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('fake')),
      }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)
      tunnel.browserSessionManager.linkConversation = jest.fn()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-b3',
        conversationId: 'conv-1',
      })

      expect(tunnel.browserSessionManager.linkConversation).toHaveBeenCalledWith('conv-1', 'sess-b3')
    })

    it('should send browser_stopped on error', async () => {
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockRejectedValue(new Error('max reached'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-b4' })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('browser_stopped')
      expect(sentMessages[0].sessionId).toBe('sess-b4')
      expect(sentMessages[0].reason).toContain('max reached')
    })
  })

  describe('handleBrowserClose', () => {
    it('should return early if no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserClose({ type: 'browser_close' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should close session and send browser_stopped', async () => {
      const mockSession = { stopLiveView: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      tunnel.browserSessionManager.close = jest.fn().mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserClose({ type: 'browser_close', sessionId: 'sess-b5' })

      expect(mockSession.stopLiveView).toHaveBeenCalled()
      expect(tunnel.browserSessionManager.close).toHaveBeenCalledWith('sess-b5')
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'browser_stopped', sessionId: 'sess-b5', reason: 'closed' })
    })
  })

  describe('handleBrowserNavigate', () => {
    it('should do nothing if no sessionId or url', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({ type: 'browser_navigate' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should send error if session not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b6',
        url: 'https://example.com',
      })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'error', sessionId: 'sess-b6', message: 'Browser session not found' })
    })

    it('should send error for invalid URL', async () => {
      const mockSession = { getPage: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      const { validateUrl } = require('../../src/mcp/tools/browser/browser-security')
      validateUrl.mockReturnValueOnce({ valid: false, reason: 'Blocked protocol' })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b7',
        url: 'file:///etc/passwd',
      })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'error', sessionId: 'sess-b7' })
    })

    it('should navigate to URL', async () => {
      const mockPage = { goto: jest.fn().mockResolvedValue(undefined) }
      const mockSession = { getPage: jest.fn().mockResolvedValue(mockPage) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b8',
        url: 'https://example.com',
      })

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object))
    })

    it('should send error on navigation failure', async () => {
      const mockPage = { goto: jest.fn().mockRejectedValue(new Error('timeout')) }
      const mockSession = { getPage: jest.fn().mockResolvedValue(mockPage) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b9',
        url: 'https://example.com',
      })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('Navigation failed')
    })
  })

  describe('handleBrowserGoBack', () => {
    it('should do nothing if session not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoBack({ type: 'browser_go_back', sessionId: 'no-sess' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should call goBack on session', async () => {
      const mockSession = { goBack: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoBack({ type: 'browser_go_back', sessionId: 'sess-b10' })
      expect(mockSession.goBack).toHaveBeenCalled()
    })
  })

  describe('handleBrowserGoForward', () => {
    it('should call goForward on session', async () => {
      const mockSession = { goForward: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoForward({ type: 'browser_go_forward', sessionId: 'sess-b11' })
      expect(mockSession.goForward).toHaveBeenCalled()
    })
  })

  describe('handleBrowserReload', () => {
    it('should call reload on session', async () => {
      const mockSession = { reload: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserReload({ type: 'browser_reload', sessionId: 'sess-b12' })
      expect(mockSession.reload).toHaveBeenCalled()
    })
  })

  describe('handleBrowserMouseClick', () => {
    it('should do nothing if missing coordinates', async () => {
      const mockSession = { executeMouseClick: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseClick({ type: 'browser_mouse_click', sessionId: 'sess-b13' })
      expect(mockSession.executeMouseClick).not.toHaveBeenCalled()
    })

    it('should call executeMouseClick with coordinates', async () => {
      const mockSession = { executeMouseClick: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseClick({
        type: 'browser_mouse_click',
        sessionId: 'sess-b14',
        x: 100,
        y: 200,
        button: 'left',
        clickCount: 2,
      })
      expect(mockSession.executeMouseClick).toHaveBeenCalledWith(100, 200, 'left', 2)
    })
  })

  describe('handleBrowserMouseWheel', () => {
    it('should do nothing if missing delta', async () => {
      const mockSession = { executeMouseWheel: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseWheel({ type: 'browser_mouse_wheel', sessionId: 'sess-b15' })
      expect(mockSession.executeMouseWheel).not.toHaveBeenCalled()
    })

    it('should call executeMouseWheel', async () => {
      const mockSession = { executeMouseWheel: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseWheel({
        type: 'browser_mouse_wheel',
        sessionId: 'sess-b16',
        deltaX: 0,
        deltaY: 100,
      })
      expect(mockSession.executeMouseWheel).toHaveBeenCalledWith(0, 100)
    })
  })

  describe('handleBrowserKeyboardType', () => {
    it('should do nothing if no text', async () => {
      const mockSession = { executeKeyboardType: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardType({ type: 'browser_keyboard_type', sessionId: 'sess-b17' })
      expect(mockSession.executeKeyboardType).not.toHaveBeenCalled()
    })

    it('should call executeKeyboardType', async () => {
      const mockSession = { executeKeyboardType: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardType({
        type: 'browser_keyboard_type',
        sessionId: 'sess-b18',
        text: 'hello',
      })
      expect(mockSession.executeKeyboardType).toHaveBeenCalledWith('hello')
    })
  })

  describe('handleBrowserKeyboardPress', () => {
    it('should do nothing if no key', async () => {
      const mockSession = { executeKeyboardPress: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardPress({ type: 'browser_keyboard_press', sessionId: 'sess-b19' })
      expect(mockSession.executeKeyboardPress).not.toHaveBeenCalled()
    })

    it('should call executeKeyboardPress with modifiers', async () => {
      const mockSession = { executeKeyboardPress: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardPress({
        type: 'browser_keyboard_press',
        sessionId: 'sess-b20',
        key: 'Enter',
        modifiers: ['Control'],
      })
      expect(mockSession.executeKeyboardPress).toHaveBeenCalledWith('Enter', ['Control'])
    })
  })

  describe('handleBrowserScreenshot', () => {
    it('should do nothing if no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserScreenshot({ type: 'browser_screenshot' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should send error if session not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserScreenshot({ type: 'browser_screenshot', sessionId: 'sess-b21' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'error', sessionId: 'sess-b21' })
    })

    it('should take screenshot and send result', async () => {
      const mockSession = {
        screenshot: jest.fn().mockResolvedValue(Buffer.from('screenshot-data')),
        getCurrentUrl: jest.fn().mockReturnValue('https://example.com'),
        getPageTitle: jest.fn().mockResolvedValue('Example'),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserScreenshot({ type: 'browser_screenshot', sessionId: 'sess-b22' })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'browser_screenshot_result',
        sessionId: 'sess-b22',
        body: Buffer.from('screenshot-data').toString('base64'),
        currentUrl: 'https://example.com',
        pageTitle: 'Example',
      })
    })

    it('should send error on screenshot failure', async () => {
      const mockSession = {
        screenshot: jest.fn().mockRejectedValue(new Error('no page')),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserScreenshot({ type: 'browser_screenshot', sessionId: 'sess-b23' })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('Screenshot failed')
    })
  })

  describe('handleBrowserViewport', () => {
    it('should do nothing if missing dimensions', async () => {
      const mockSession = { setViewport: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({ type: 'browser_viewport', sessionId: 'sess-b24' })
      expect(mockSession.setViewport).not.toHaveBeenCalled()
    })

    it('should call setViewport', async () => {
      const mockSession = { setViewport: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({
        type: 'browser_viewport',
        sessionId: 'sess-b25',
        width: 1920,
        height: 1080,
      })
      expect(mockSession.setViewport).toHaveBeenCalledWith(1920, 1080, undefined)
    })

    it('should pass deviceId to setViewport', async () => {
      const mockSession = { setViewport: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({
        type: 'browser_viewport',
        sessionId: 'sess-b26',
        width: 375,
        height: 667,
        deviceId: 'iphone-se',
      })
      expect(mockSession.setViewport).toHaveBeenCalledWith(375, 667, 'iphone-se')
    })

    it('should pass empty string deviceId to clear emulation', async () => {
      const mockSession = { setViewport: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({
        type: 'browser_viewport',
        sessionId: 'sess-b27',
        width: 1280,
        height: 720,
        deviceId: '',
      })
      expect(mockSession.setViewport).toHaveBeenCalledWith(1280, 720, '')
    })
  })

  describe('handleBrowserExecuteScript', () => {
    it('should send error if no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({ type: 'browser_execute_script' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
    })

    it('should send error if no script', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({ type: 'browser_execute_script', sessionId: 'sess-es1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
    })

    it('should send error if session not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({
        type: 'browser_execute_script',
        sessionId: 'sess-es2',
        script: "await page.click('#btn');",
      })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('Browser session not found')
    })

    it('should execute script and return result', async () => {
      const mockPage = {
        click: jest.fn().mockResolvedValue(undefined),
      }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        variables: new Map(),
        actionLog: { add: jest.fn() },
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({
        type: 'browser_execute_script',
        sessionId: 'sess-es3',
        script: "await page.click('#btn');",
      })

      // Should have progress + result messages
      const resultMsg = sentMessages.find(m => m.type === 'browser_script_result')
      expect(resultMsg).toBeDefined()
      expect(resultMsg!.success).toBe(true)
    })

    it('should return fallbackToChat for unparseable script', async () => {
      const mockSession = {
        getPage: jest.fn().mockResolvedValue({}),
        variables: new Map(),
        actionLog: { add: jest.fn() },
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({
        type: 'browser_execute_script',
        sessionId: 'sess-es4',
        script: 'some unknown command',
      })

      const resultMsg = sentMessages.find(m => m.type === 'browser_script_result')
      expect(resultMsg).toBeDefined()
      expect(resultMsg!.fallbackToChat).toBe(true)
    })
  })

  describe('onParsedMessage - browser routing', () => {
    it('should dispatch browser_open to handleBrowserOpen', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_open' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages.length).toBeGreaterThanOrEqual(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toBe('Missing sessionId')
    })

    it('should dispatch browser_close to handleBrowserClose', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_close', sessionId: 'sess-x' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'browser_stopped', sessionId: 'sess-x' })
    })

    it('should dispatch browser_navigate', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_navigate', sessionId: 'sess-y', url: 'https://test.com' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages.length).toBeGreaterThanOrEqual(1)
    })

    it('should dispatch browser_go_back', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_go_back', sessionId: 'sess-z' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0) // no session, early return
    })

    it('should dispatch browser_go_forward', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_go_forward', sessionId: 'sess-z' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_reload', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_reload', sessionId: 'sess-z' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_mouse_click', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_mouse_click', sessionId: 'sess-z', x: 10, y: 20 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_mouse_wheel', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_mouse_wheel', sessionId: 'sess-z', deltaX: 0, deltaY: 10 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_keyboard_type', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_keyboard_type', sessionId: 'sess-z', text: 'hi' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_keyboard_press', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_keyboard_press', sessionId: 'sess-z', key: 'Enter' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_screenshot', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_screenshot', sessionId: 'sess-z' })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages.length).toBeGreaterThanOrEqual(1) // error: session not found
    })

    it('should dispatch browser_viewport', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_viewport', sessionId: 'sess-z', width: 1024, height: 768 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0) // no session, early return
    })

    it('should dispatch browser_execute_script', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_execute_script', sessionId: 'sess-z', script: "await page.click('#btn');" })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages.length).toBeGreaterThanOrEqual(1)
      expect(sentMessages[0].type).toBe('error')
    })
  })

  describe('onParsedMessage - port forward routing', () => {
    it('should dispatch port_forward_open', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'port_forward_open', sessionId: 'pf-1', targetPort: 8080 })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'port_forward_ready', sessionId: 'pf-1', targetPort: 8080 })
    })

    it('should dispatch port_forward_close', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'port_forward_close', sessionId: 'pf-2' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'port_forward_stopped', sessionId: 'pf-2' })
    })
  })
})
