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
jest.mock('../../src/browser/browser-local-server', () => ({
  BrowserLocalServer: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(0),
    stop: jest.fn().mockResolvedValue(undefined),
    onActionLog: null,
  })),
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

    it('should dispatch browser_get_selection to handleBrowserGetSelection', () => {
      const mockSession = { getSelectedText: jest.fn().mockResolvedValue('sel') }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_get_selection', sessionId: 'sess-route' })
      expect(mockSession.getSelectedText).toHaveBeenCalled()
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

    it('should warn when envVarsProvider is set but returns falsy', async () => {
      const { logger } = require('../../src/logger')
      const { VsCodeServer } = require('../../src/vscode/vscode-server')
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')

      VsCodeServer.mockImplementation(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        getPort: jest.fn().mockReturnValue(8443),
        isRunning: false,
      }))
      VsCodeWsProxy.mockImplementation(() => ({}))

      // Create a tunnel with envVarsProvider that returns undefined (not ready yet)
      const tunnelWithProvider = new (VsCodeTunnelWebSocket as unknown as new (
        apiUrl: string,
        token: string,
        agentId: string,
        projectDir: string,
        envVarsProvider: () => Record<string, string> | undefined,
      ) => { handleVsCodeOpen: (msg: unknown) => Promise<void> })(
        'https://api.example.com',
        'test-token',
        'agent-123',
        '/test/project',
        () => undefined, // envVarsProvider returns undefined → triggers warning
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnelWithProvider as any).ws = mockWs

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnelWithProvider as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-env-warn', projectDir: '/test' })

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('before envVars are available'),
      )
    })

    it('should restart running server when envVars signature changes', async () => {
      const { logger } = require('../../src/logger')
      const { VsCodeServer } = require('../../src/vscode/vscode-server')
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')

      const mockStop = jest.fn().mockResolvedValue(undefined)
      const mockStart = jest.fn().mockResolvedValue(undefined)
      const mockGetPort = jest.fn().mockReturnValue(8444)

      const runningServer = { isRunning: true, touch: jest.fn(), getPort: mockGetPort, stop: mockStop }
      VsCodeServer.mockImplementation(() => ({
        start: mockStart,
        getPort: mockGetPort,
        isRunning: false,
      }))
      VsCodeWsProxy.mockImplementation(() => ({}))

      // Set an existing running server with a different env signature
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = runningServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServerEnvSignature = 'OLD_KEY=old_value'

      // Create a tunnel with envVarsProvider returning new envVars (different signature)
      const tunnelWithProvider = new (VsCodeTunnelWebSocket as unknown as new (
        apiUrl: string,
        token: string,
        agentId: string,
        projectDir: string,
        envVarsProvider: () => Record<string, string>,
      ) => object)(
        'https://api.example.com',
        'test-token',
        'agent-123',
        '/test/project',
        () => ({ NEW_KEY: 'new_value' }),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnelWithProvider as any).ws = mockWs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnelWithProvider as any).vsCodeServer = runningServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnelWithProvider as any).vsCodeServerEnvSignature = 'OLD_KEY=old_value'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnelWithProvider as any).handleVsCodeOpen({ type: 'vscode_open', sessionId: 'sess-restart', projectDir: '/test' })

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('envVars changed since last code-server start'),
      )
      expect(mockStop).toHaveBeenCalled()
      expect(mockStart).toHaveBeenCalled()
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

  describe('sendHttpResponse', () => {
    it('should send a single message when body is within chunk size', () => {
      const msg = { requestId: 'req-s1', sessionId: 'sess-s1' }
      const response = { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'small body' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendHttpResponse(msg, response)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'http_response',
        requestId: 'req-s1',
        sessionId: 'sess-s1',
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'small body',
      })
    })

    it('should delegate to sendChunkedHttpResponse when body exceeds chunk size', () => {
      const largeBody = 'x'.repeat(600000)
      const msg = { requestId: 'req-s2', sessionId: 'sess-s2' }
      const response = { statusCode: 200, headers: { 'content-type': 'text/html' }, body: largeBody }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendHttpResponse(msg, response)
      // Multiple chunks expected
      expect(sentMessages.length).toBeGreaterThan(1)
      expect(sentMessages[0].bodyChunkIndex).toBe(0)
    })
  })

  describe('sendChunkedHttpResponse', () => {
    it('should split response body into multiple chunks', () => {
      const largeBody = 'a'.repeat(600000)
      const msg = { requestId: 'req-c1', sessionId: 'sess-c1' }
      const response = { statusCode: 200, headers: { 'x-custom': 'yes' }, body: largeBody }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendChunkedHttpResponse(msg, response)
      expect(sentMessages.length).toBeGreaterThan(1)
      // First chunk carries headers
      expect(sentMessages[0].headers).toEqual({ 'x-custom': 'yes' })
      // Subsequent chunks do not carry headers
      for (let i = 1; i < sentMessages.length; i++) {
        expect(sentMessages[i].headers).toBeUndefined()
      }
    })

    it('should set bodyChunkIndex and bodyChunkTotal correctly', () => {
      const body = 'b'.repeat(600000)
      const msg = { requestId: 'req-c2', sessionId: 'sess-c2' }
      const response = { statusCode: 200, headers: {}, body }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendChunkedHttpResponse(msg, response)
      const total = sentMessages[0].bodyChunkTotal!
      expect(total).toBeGreaterThan(1)
      sentMessages.forEach((m, idx) => {
        expect(m.bodyChunkIndex).toBe(idx)
        expect(m.bodyChunkTotal).toBe(total)
      })
    })

    it('should reconstruct original body from chunks', () => {
      const body = 'c'.repeat(700000)
      const msg = { requestId: 'req-c3', sessionId: 'sess-c3' }
      const response = { statusCode: 200, headers: {}, body }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendChunkedHttpResponse(msg, response)
      const reconstructed = sentMessages.map(m => m.body ?? '').join('')
      expect(reconstructed).toBe(body)
    })

    it('should forward requestId and sessionId to every chunk', () => {
      const body = 'd'.repeat(600000)
      const msg = { requestId: 'req-c4', sessionId: 'sess-c4' }
      const response = { statusCode: 302, headers: {}, body }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).sendChunkedHttpResponse(msg, response)
      for (const m of sentMessages) {
        expect(m.requestId).toBe('req-c4')
        expect(m.sessionId).toBe('sess-c4')
        expect(m.statusCode).toBe(302)
      }
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

    it('should include the ALB sticky cookie header when one was captured', () => {
      // Simulate a previously captured handshake Set-Cookie via the same
      // capture path the base class uses (avoids poking the private Map).
      ;(
        tunnel as unknown as {
          captureStickyCookies(res: { headers: Record<string, string[] | undefined> }): void
        }
      ).captureStickyCookies({ headers: { 'set-cookie': ['AWSALB=vscode-sticky; Path=/'] } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = (tunnel as any).createWebSocket()
      expect(WebSocket).toHaveBeenCalledWith(
        'wss://api.example.com/ws/agent-vscode',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            'X-Agent-Id': 'agent-123',
            Cookie: 'AWSALB=vscode-sticky',
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

  describe('handleBrowserGetSelection', () => {
    it('should do nothing if no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGetSelection({ type: 'browser_get_selection' })
      expect(sentMessages).toHaveLength(0)
    })

    it('should send error if session not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGetSelection({ type: 'browser_get_selection', sessionId: 'sess-sel1' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'error', sessionId: 'sess-sel1' })
    })

    it('should return selected text via browser_selection_result', async () => {
      const mockSession = { getSelectedText: jest.fn().mockResolvedValue('hello world') }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGetSelection({ type: 'browser_get_selection', sessionId: 'sess-sel2' })
      expect(mockSession.getSelectedText).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'browser_selection_result',
        sessionId: 'sess-sel2',
        text: 'hello world',
      })
    })

    it('should send error on getSelectedText failure', async () => {
      const mockSession = { getSelectedText: jest.fn().mockRejectedValue(new Error('no page')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGetSelection({ type: 'browser_get_selection', sessionId: 'sess-sel3' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('getSelection failed')
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
      // eslint-disable-next-line @typescript-eslint/no-reflect-any
      ;(tunnel as any).onParsedMessage({ type: 'port_forward_close', sessionId: 'pf-2' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'port_forward_stopped', sessionId: 'pf-2' })
    })
  })

  describe('getBrowserLocalPort', () => {
    it('should return 0 when browser local server has not started', () => {
      expect(tunnel.getBrowserLocalPort()).toBe(0)
    })

    it('should return port after it has been set', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).browserLocalPort = 54321
      expect(tunnel.getBrowserLocalPort()).toBe(54321)
    })
  })

  describe('waitForBrowserLocalPort', () => {
    it('should return 0 when no start promise exists', async () => {
      const port = await tunnel.waitForBrowserLocalPort()
      expect(port).toBe(0)
    })

    it('should await start promise and return port', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).browserLocalPort = 12345
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).browserLocalServerStartPromise = Promise.resolve()
      const port = await tunnel.waitForBrowserLocalPort()
      expect(port).toBe(12345)
    })
  })

  describe('onOpen - BrowserLocalServer', () => {
    it('should start browser local server and set port on success', async () => {
      const { BrowserLocalServer } = require('../../src/browser/browser-local-server')
      const mockStart = jest.fn().mockResolvedValue(8888)
      const mockBls = { start: mockStart, onActionLog: null }
      BrowserLocalServer.mockImplementation(() => mockBls)

      const resolve = jest.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)

      // Wait for the promise chain to settle
      await mockBls.start.mock.results[0]?.value
      await Promise.resolve()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).browserLocalPort).toBe(8888)
      expect(resolve).toHaveBeenCalled()
    })

    it('should log error and not throw when browser local server fails to start', async () => {
      const { logger } = require('../../src/logger')
      const { BrowserLocalServer } = require('../../src/browser/browser-local-server')
      const mockStart = jest.fn().mockRejectedValue(new Error('EADDRINUSE'))
      const mockBls = { start: mockStart, onActionLog: null }
      BrowserLocalServer.mockImplementation(() => mockBls)

      const resolve = jest.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)

      // Await promise (even rejecting one)
      await mockBls.start.mock.results[0]?.value.catch(() => {})
      await Promise.resolve()

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to start browser local server'))
      expect(resolve).toHaveBeenCalled()
    })

    it('should relay action log from browser local server via send', async () => {
      const { BrowserLocalServer } = require('../../src/browser/browser-local-server')
      let capturedActionLog: ((n: unknown) => void) | null = null
      const mockBls = {
        start: jest.fn().mockResolvedValue(9999),
        onActionLog: null as ((n: unknown) => void) | null,
      }
      Object.defineProperty(mockBls, 'onActionLog', {
        set(fn: (n: unknown) => void) { capturedActionLog = fn },
        get() { return capturedActionLog },
      })
      BrowserLocalServer.mockImplementation(() => mockBls)

      const resolve = jest.fn()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)

      // Wait for start
      await mockBls.start.mock.results[0]?.value.catch(() => {})
      await Promise.resolve()

      // Invoke the onActionLog callback
      if (capturedActionLog) {
        capturedActionLog({
          sessionId: 'sess-al',
          entry: { timestamp: 1, source: 'chat', action: 'click', details: '#btn' },
        })
      }

      const actionLogMsg = sentMessages.find(m => m.type === 'browser_action_log')
      expect(actionLogMsg).toBeDefined()
      expect(actionLogMsg!.sessionId).toBe('sess-al')
    })

    it('should not create a second browser local server on repeated onOpen calls', () => {
      const { BrowserLocalServer } = require('../../src/browser/browser-local-server')
      const mockBls = { start: jest.fn().mockResolvedValue(1234), onActionLog: null }
      BrowserLocalServer.mockImplementation(() => mockBls)

      const resolve = jest.fn()
      // First onOpen
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)
      const firstInstance = (tunnel as any).browserLocalServer

      // Second onOpen (reconnect scenario) — should not create a new instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onOpen(mockWs, resolve)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).browserLocalServer).toBe(firstInstance)
    })
  })

  describe('handlePortForwardOpen - error cases', () => {
    it('should send error when sessionId is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardOpen({ type: 'port_forward_open' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'error', message: 'Missing sessionId' })
    })

    it('should send error when targetPort is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardOpen({ type: 'port_forward_open', sessionId: 'pf-err' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'error', sessionId: 'pf-err', message: 'Missing targetPort' })
    })
  })

  describe('handlePortForwardClose - session cleanup', () => {
    it('should close wsProxy and delete session when session exists', () => {
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')
      const mockPfWsProxy = { closeAll: jest.fn(), openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      VsCodeWsProxy.mockImplementation(() => mockPfWsProxy)

      // First open a port forward session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardOpen({ type: 'port_forward_open', sessionId: 'pf-close-1', targetPort: 9000 })
      sentMessages.length = 0 // clear sent messages

      // Now close it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardClose({ type: 'port_forward_close', sessionId: 'pf-close-1' })

      expect(mockPfWsProxy.closeAll).toHaveBeenCalled()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).portForwardSessions.has('pf-close-1')).toBe(false)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'port_forward_stopped', sessionId: 'pf-close-1' })
    })
  })

  describe('handleBrowserOpen - action log and live view callbacks', () => {
    it('should invoke action log callback set on session and send browser_action_log', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
      }
      let capturedActionLogCb: ((entry: unknown) => void) | null = null
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: {
          get onChange() { return capturedActionLogCb },
          set onChange(fn: ((entry: unknown) => void) | null) { capturedActionLogCb = fn },
        },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-al1' })

      // Trigger the action log callback
      expect(capturedActionLogCb).not.toBeNull()
      const fakeEntry = { timestamp: 1, source: 'direct', action: 'click', details: '#btn' }
      capturedActionLogCb!(fakeEntry)

      const alMsg = sentMessages.find(m => m.type === 'browser_action_log')
      expect(alMsg).toBeDefined()
      expect(alMsg!.sessionId).toBe('sess-al1')
      expect(alMsg!.entries).toEqual([fakeEntry])
    })

    it('should invoke live view callback and send browser_frame', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('https://live.example.com'),
        title: jest.fn().mockResolvedValue('Live'),
      }
      let capturedLiveViewCb: ((base64: string) => void) | null = null
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn((_, cb: (base64: string) => void) => { capturedLiveViewCb = cb }),
        getCurrentUrl: jest.fn().mockReturnValue('https://live.example.com'),
        getPageTitle: jest.fn().mockResolvedValue('Live'),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-lv1' })

      // Trigger the live view callback
      expect(capturedLiveViewCb).not.toBeNull()
      capturedLiveViewCb!('base64framedata')

      const frameMsg = sentMessages.find(m => m.type === 'browser_frame')
      expect(frameMsg).toBeDefined()
      expect(frameMsg!.sessionId).toBe('sess-lv1')
      expect(frameMsg!.body).toBe('base64framedata')
      expect(frameMsg!.currentUrl).toBe('https://live.example.com')
    })

    it('should skip navigation when URL is invalid', async () => {
      const { validateUrl } = require('../../src/mcp/tools/browser/browser-security')
      validateUrl.mockReturnValueOnce({ valid: false, reason: 'Blocked' })

      const mockPage = { goto: jest.fn().mockResolvedValue(undefined) }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-inv-url', url: 'file:///etc/passwd' })

      // goto should NOT have been called (invalid URL)
      expect(mockPage.goto).not.toHaveBeenCalled()
      // But browser_ready should still be sent
      const readyMsg = sentMessages.find(m => m.type === 'browser_ready')
      expect(readyMsg).toBeDefined()
    })
  })

  describe('error paths for browser handlers', () => {
    it('handleBrowserGoBack - should send error on failure', async () => {
      const mockSession = { goBack: jest.fn().mockRejectedValue(new Error('history empty')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoBack({ type: 'browser_go_back', sessionId: 'sess-gob' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('goBack failed')
    })

    it('handleBrowserGoForward - should send error on failure', async () => {
      const mockSession = { goForward: jest.fn().mockRejectedValue(new Error('history empty')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoForward({ type: 'browser_go_forward', sessionId: 'sess-gof' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('goForward failed')
    })

    it('handleBrowserReload - should send error on failure', async () => {
      const mockSession = { reload: jest.fn().mockRejectedValue(new Error('page crashed')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserReload({ type: 'browser_reload', sessionId: 'sess-rel' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('reload failed')
    })

    it('handleBrowserMouseClick - should send error on failure', async () => {
      const mockSession = { executeMouseClick: jest.fn().mockRejectedValue(new Error('element not found')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseClick({ type: 'browser_mouse_click', sessionId: 'sess-clk', x: 10, y: 20 })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('mouseClick failed')
    })

    it('handleBrowserMouseWheel - should warn on failure (no error send)', async () => {
      const { logger } = require('../../src/logger')
      const mockSession = { executeMouseWheel: jest.fn().mockRejectedValue(new Error('scroll failed')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseWheel({ type: 'browser_mouse_wheel', sessionId: 'sess-mw', deltaX: 0, deltaY: 50 })
      // mouseWheel only warns, no error send
      expect(sentMessages).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mouseWheel failed'))
    })

    it('handleBrowserKeyboardType - should send error on failure', async () => {
      const mockSession = { executeKeyboardType: jest.fn().mockRejectedValue(new Error('not focused')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardType({ type: 'browser_keyboard_type', sessionId: 'sess-kt', text: 'hello' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('keyboardType failed')
    })

    it('handleBrowserKeyboardPress - should send error on failure', async () => {
      const mockSession = { executeKeyboardPress: jest.fn().mockRejectedValue(new Error('key error')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardPress({ type: 'browser_keyboard_press', sessionId: 'sess-kp', key: 'Tab' })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].message).toContain('keyboardPress failed')
    })

    it('handleBrowserViewport - should warn on failure (no error send)', async () => {
      const { logger } = require('../../src/logger')
      const mockSession = { setViewport: jest.fn().mockRejectedValue(new Error('viewport error')) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({ type: 'browser_viewport', sessionId: 'sess-vp', width: 800, height: 600 })
      expect(sentMessages).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('setViewport failed'))
    })

    it('handleBrowserExecuteScript - should send error on unexpected exception', async () => {
      const mockSession = {
        getPage: jest.fn().mockRejectedValue(new Error('page unavailable')),
        variables: new Map(),
        actionLog: { add: jest.fn() },
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // Mock executePlaywrightScript to throw
      jest.mock('../../src/browser/browser-script-executor', () => ({
        executePlaywrightScript: jest.fn().mockRejectedValue(new Error('executor crash')),
      }))

      // We need to reload with the mock... instead let's access the underlying function
      // The import is already done at module level so we override it directly
      const browserScriptExecutorModule = require('../../src/browser/browser-script-executor')
      const origFn = browserScriptExecutorModule.executePlaywrightScript
      browserScriptExecutorModule.executePlaywrightScript = jest.fn().mockRejectedValue(new Error('executor crash'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserExecuteScript({
        type: 'browser_execute_script',
        sessionId: 'sess-exc',
        script: "await page.click('#x');",
      })

      const errMsg = sentMessages.find(m => m.type === 'error')
      expect(errMsg).toBeDefined()
      expect(errMsg!.message).toContain('Script execution failed')

      // Restore
      browserScriptExecutorModule.executePlaywrightScript = origFn
    })
  })

  describe('cleanup - browserLocalServer and portForwardSessions', () => {
    it('should stop browser local server when it exists', () => {
      const mockBls = { stop: jest.fn().mockResolvedValue(undefined) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).browserLocalServer = mockBls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).browserLocalPort = 5678

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).cleanup()

      expect(mockBls.stop).toHaveBeenCalled()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).browserLocalServer).toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).browserLocalPort).toBe(0)
    })

    it('should call closeAll on all portForwardSessions during cleanup', () => {
      const mockPfWsProxy1 = { closeAll: jest.fn() }
      const mockPfWsProxy2 = { closeAll: jest.fn() }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).portForwardSessions.set('pf-1', { targetPort: 9001, wsProxy: mockPfWsProxy1 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).portForwardSessions.set('pf-2', { targetPort: 9002, wsProxy: mockPfWsProxy2 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).cleanup()

      expect(mockPfWsProxy1.closeAll).toHaveBeenCalled()
      expect(mockPfWsProxy2.closeAll).toHaveBeenCalled()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).portForwardSessions.size).toBe(0)
    })
  })

  describe('handleWsFrame - port forward session path', () => {
    it('should use portForward wsProxy when sessionId matches a portForward session', () => {
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')
      const mockPfWsProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn(), closeAll: jest.fn() }
      VsCodeWsProxy.mockImplementation(() => mockPfWsProxy)

      // Open a port forward session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardOpen({ type: 'port_forward_open', sessionId: 'pf-ws-1', targetPort: 7777 })
      sentMessages.length = 0

      // Send a ws_frame for that session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        sessionId: 'pf-ws-1',
        subSocketId: 'sub-pf',
        data: 'pf-data',
      })

      expect(mockPfWsProxy.sendFrame).toHaveBeenCalledWith('sub-pf', 'pf-data')
    })

    it('should close connection on isClosed for port forward session', () => {
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')
      const mockPfWsProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn(), closeAll: jest.fn() }
      VsCodeWsProxy.mockImplementation(() => mockPfWsProxy)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardOpen({ type: 'port_forward_open', sessionId: 'pf-ws-2', targetPort: 7778 })
      sentMessages.length = 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        sessionId: 'pf-ws-2',
        subSocketId: 'sub-pf2',
        isClosed: true,
      })

      expect(mockPfWsProxy.closeConnection).toHaveBeenCalledWith('sub-pf2')
    })

    it('should handle ws_frame with no proxy when pfSession exists but proxy is null', () => {
      // Manually insert a port forward session with null wsProxy (edge case)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).portForwardSessions.set('pf-null', { targetPort: 8888, wsProxy: null })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (tunnel as any).handleWsFrame({
        type: 'ws_frame',
        sessionId: 'pf-null',
        subSocketId: 'sub-x',
        data: 'some-data',
      })).not.toThrow()
    })
  })

  describe('handlePortForwardClose - no sessionId', () => {
    it('should do nothing when sessionId is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handlePortForwardClose({ type: 'port_forward_close' })
      // No port_forward_stopped should be sent without sessionId
      expect(sentMessages).toHaveLength(0)
    })
  })

  describe('handleHttpRequest - port forward path', () => {
    it('should touch server when targetPort is falsy and server is running', async () => {
      const { proxyHttpRequest } = require('../../src/vscode/vscode-http-proxy')
      const mockServer = { isRunning: true, touch: jest.fn(), getPort: jest.fn().mockReturnValue(8443) }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer

      proxyHttpRequest.mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: 'ok',
      })

      // No sessionId so no portForward session lookup; targetPort will be falsy → touches server
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({
        type: 'http_request',
        requestId: 'req-touch',
        method: 'GET',
        path: '/',
      })

      expect(mockServer.touch).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('http_response')
    })

    it('should use targetPort from port forward session (skips touch)', async () => {
      const { proxyHttpRequest } = require('../../src/vscode/vscode-http-proxy')
      const { VsCodeWsProxy } = require('../../src/vscode/vscode-ws-proxy')
      const mockPfWsProxy = { closeAll: jest.fn() }
      VsCodeWsProxy.mockImplementation(() => mockPfWsProxy)

      // Set up a port forward session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).portForwardSessions.set('pf-http', { targetPort: 3000, wsProxy: mockPfWsProxy })

      proxyHttpRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleHttpRequest({
        type: 'http_request',
        requestId: 'req-pf',
        sessionId: 'pf-http',
        method: 'GET',
        path: '/api',
      })

      // proxyHttpRequest called with port 3000 (port forward port, not code-server port)
      expect(proxyHttpRequest).toHaveBeenCalledWith(3000, expect.any(Object))
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('http_response')
    })
  })

  describe('handleWsFrame - no-op frame (no isOpen/isClosed/data)', () => {
    it('should do nothing when ws_frame has no isOpen, isClosed, or data', () => {
      const mockServer = { isRunning: true, touch: jest.fn() }
      const mockProxy = { openConnection: jest.fn(), closeConnection: jest.fn(), sendFrame: jest.fn() }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).vsCodeServer = mockServer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).wsProxy = mockProxy

      // ws_frame with subSocketId but no isOpen/isClosed/data
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).handleWsFrame({
        type: 'ws_frame',
        subSocketId: 'sub-noop',
        sessionId: 'sess-noop',
      })

      expect(mockProxy.openConnection).not.toHaveBeenCalled()
      expect(mockProxy.closeConnection).not.toHaveBeenCalled()
      expect(mockProxy.sendFrame).not.toHaveBeenCalled()
    })
  })

  describe('handleBrowserNavigate - missing validation.reason', () => {
    it('should send "Invalid URL" when validation.reason is undefined', async () => {
      const { validateUrl } = require('../../src/mcp/tools/browser/browser-security')
      validateUrl.mockReturnValueOnce({ valid: false })  // no reason property

      const mockSession = { getPage: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-nav-reason',
        url: 'file:///etc/passwd',
      })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ type: 'error', sessionId: 'sess-nav-reason', message: 'Invalid URL' })
    })

    it('should add action log on successful navigation', async () => {
      const mockPage = { goto: jest.fn().mockResolvedValue(undefined) }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        actionLog: { add: jest.fn() },
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-nav-log',
        url: 'https://example.com',
      })

      expect(mockSession.actionLog.add).toHaveBeenCalledWith('direct', 'navigate', 'https://example.com')
    })
  })

  describe('handleBrowserSetFile', () => {
    it('should error when no pending file chooser', async () => {
      // pendingFileChoosers が空のとき、errorメッセージを送信
      await (tunnel as any).handleBrowserSetFile({ type: 'browser_set_file', sessionId: 'no-pending-sess' })
      expect(sentMessages).toContainEqual(expect.objectContaining({
        type: 'error',
        sessionId: 'no-pending-sess',
        message: expect.stringContaining('No pending file chooser'),
      }))
    })

    it('should handle filePaths and accept them', async () => {
      // pendingFileChoosers にエントリがある場合、filePaths を accept に渡す
      const acceptMock = jest.fn()
      ;(tunnel as any).pendingFileChoosers.set('sess-paths', acceptMock)
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-paths',
        filePaths: ['/workspace/test.txt'],
      })
      expect(acceptMock).toHaveBeenCalledWith(['/workspace/test.txt'])
      expect((tunnel as any).pendingFileChoosers.has('sess-paths')).toBe(false)
    })

    it('should handle base64 files by writing to temp and calling accept with paths', async () => {
      // filesが base64 で送られた場合、一時ファイルに書き込んでから accept に渡す
      // fs.promises と setTimeout をモックして実際の I/O と待機をスキップする
      const fsModule = require('fs') as typeof import('fs')
      const writeFileSpy = jest.spyOn(fsModule.promises, 'writeFile').mockResolvedValue(undefined)
      const unlinkSpy = jest.spyOn(fsModule.promises, 'unlink').mockResolvedValue(undefined)
      // setTimeout をすぐに解決するモックに差し替える
      const origSetTimeout = global.setTimeout
      global.setTimeout = ((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout }) as unknown as typeof setTimeout

      try {
        const acceptMock = jest.fn()
        ;(tunnel as any).pendingFileChoosers.set('sess-b64', acceptMock)
        await (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-b64',
          files: [
            { name: 'test.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') },
          ],
        })
        expect(acceptMock).toHaveBeenCalledTimes(1)
        const calledPaths: string[] = acceptMock.mock.calls[0][0]
        expect(calledPaths).toHaveLength(1)
        expect(calledPaths[0]).toMatch(/test\.txt$/)
        expect(writeFileSpy).toHaveBeenCalledTimes(1)
        // unlink は finally ブロックで呼ばれる
        expect(unlinkSpy).toHaveBeenCalledTimes(1)
        // 一時ファイルが書き込まれたことを確認（ファイルが存在するかまたは既にクリーンアップ済み）
        expect((tunnel as any).pendingFileChoosers.has('sess-b64')).toBe(false)
      } finally {
        global.setTimeout = origSetTimeout
        writeFileSpy.mockRestore()
        unlinkSpy.mockRestore()
      }
    })

    it('should call accept with empty array when files is empty', async () => {
      const acceptMock = jest.fn()
      ;(tunnel as any).pendingFileChoosers.set('sess-empty', acceptMock)
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-empty',
        files: [],
      })
      expect(acceptMock).toHaveBeenCalledWith([])
    })

    it('should generate distinct tmpPaths when multiple files have the same name (HIGH-1)', async () => {
      // 同名ファイルを複数選択した場合、index が含まれるため衝突しない
      const fsModule = require('fs') as typeof import('fs')
      const writtenPaths: string[] = []
      const writeFileSpy = jest.spyOn(fsModule.promises, 'writeFile').mockImplementation(async (filePath) => {
        writtenPaths.push(String(filePath))
      })
      const unlinkSpy = jest.spyOn(fsModule.promises, 'unlink').mockResolvedValue(undefined)
      const origSetTimeout = global.setTimeout
      global.setTimeout = ((fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout }) as unknown as typeof setTimeout

      try {
        const acceptMock = jest.fn()
        ;(tunnel as any).pendingFileChoosers.set('sess-dup', acceptMock)
        await (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-dup',
          files: [
            { name: 'photo.jpg', mimeType: 'image/jpeg', dataBase64: Buffer.from('data1').toString('base64') },
            { name: 'photo.jpg', mimeType: 'image/jpeg', dataBase64: Buffer.from('data2').toString('base64') },
          ],
        })
        expect(acceptMock).toHaveBeenCalledTimes(1)
        const calledPaths: string[] = acceptMock.mock.calls[0][0]
        expect(calledPaths).toHaveLength(2)
        // パスが互いに異なることを確認（インデックスで区別される）
        expect(calledPaths[0]).not.toBe(calledPaths[1])
        // 両方のパスに index が含まれていることを確認
        expect(calledPaths[0]).toMatch(/-0-photo\.jpg$/)
        expect(calledPaths[1]).toMatch(/-1-photo\.jpg$/)
        expect(writeFileSpy).toHaveBeenCalledTimes(2)
      } finally {
        global.setTimeout = origSetTimeout
        writeFileSpy.mockRestore()
        unlinkSpy.mockRestore()
      }
    })

    it('should call accept([]) and send error when writeFile fails (HIGH-2)', async () => {
      // writeFile が例外を投げた場合、accept([]) が呼ばれ、エラーメッセージが送信される
      const fsModule = require('fs') as typeof import('fs')
      const writeFileSpy = jest.spyOn(fsModule.promises, 'writeFile').mockRejectedValue(new Error('ENOSPC: no space left on device'))
      const unlinkSpy = jest.spyOn(fsModule.promises, 'unlink').mockResolvedValue(undefined)

      try {
        const acceptMock = jest.fn()
        ;(tunnel as any).pendingFileChoosers.set('sess-writefail', acceptMock)
        await (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-writefail',
          files: [
            { name: 'test.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hello').toString('base64') },
          ],
        })
        // accept([]) が呼ばれ、fileChooser がハングしないことを確認
        expect(acceptMock).toHaveBeenCalledWith([])
        // エラーメッセージが送信されることを確認
        const errMsg = sentMessages.find(m => m.type === 'error')
        expect(errMsg).toBeDefined()
        expect(errMsg!.sessionId).toBe('sess-writefail')
        expect(errMsg!.message).toContain('File upload failed')
        expect(errMsg!.message).toContain('ENOSPC')
      } finally {
        writeFileSpy.mockRestore()
        unlinkSpy.mockRestore()
      }
    })
  })

  describe('browser handlers - no sessionId (ternary false branch)', () => {
    it('handleBrowserGoBack - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoBack({ type: 'browser_go_back' })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserGoForward - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserGoForward({ type: 'browser_go_forward' })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserReload - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserReload({ type: 'browser_reload' })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserMouseClick - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseClick({ type: 'browser_mouse_click', x: 10, y: 20 })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserMouseWheel - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseWheel({ type: 'browser_mouse_wheel', deltaX: 0, deltaY: 10 })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserKeyboardType - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardType({ type: 'browser_keyboard_type', text: 'hello' })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserKeyboardPress - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserKeyboardPress({ type: 'browser_keyboard_press', key: 'Enter' })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserViewport - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserViewport({ type: 'browser_viewport', width: 800, height: 600 })
      expect(sentMessages).toHaveLength(0)
    })
  })
})
