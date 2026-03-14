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
      expect(sentMessages[0]).toEqual({ type: 'vscode_ready', sessionId: 'sess-1', port: 8443 })
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
      expect(sentMessages[0]).toEqual({ type: 'vscode_ready', sessionId: 'sess-1', port: 8443 })
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

      // Get the onData and onClose callbacks
      const onData = mockProxy.openConnection.mock.calls[0][2]
      const onClose = mockProxy.openConnection.mock.calls[0][3]

      // Invoke onData callback
      onData('encoded-data')
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'ws_frame',
        sessionId: 'sess-1',
        subSocketId: 'sub-1',
        data: 'encoded-data',
      })

      // Invoke onClose callback
      onClose()
      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[1]).toMatchObject({
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
})
