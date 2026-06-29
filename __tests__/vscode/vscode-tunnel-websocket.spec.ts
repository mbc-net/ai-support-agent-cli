import { existsSync } from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

    it('should re-report focus after goto so an autofocused field shows its caret', async () => {
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
        reportFocusNow: jest.fn().mockResolvedValue(undefined),
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-b2f',
        url: 'https://example.com',
      })

      // The initial focus report must run after the navigation so a page that
      // autofocuses an input surfaces browser_focus_changed without user action.
      expect(mockSession.reportFocusNow).toHaveBeenCalled()
      const gotoOrder = mockPage.goto.mock.invocationCallOrder[0]
      const reportOrder = mockSession.reportFocusNow.mock.invocationCallOrder[0]
      expect(gotoOrder).toBeLessThan(reportOrder)
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

    // --- resume branch ---

    it('should reuse an existing live session on resume and re-send ready/frame without navigating', async () => {
      const mockPage = {
        goto: jest.fn().mockResolvedValue(undefined),
        url: jest.fn().mockReturnValue('https://example.com/page'),
        title: jest.fn().mockResolvedValue('Existing'),
      }
      const mockSession = {
        isAlive: true,
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('https://example.com/page'),
        getPageTitle: jest.fn().mockResolvedValue('Existing'),
        reportFocusNow: jest.fn().mockResolvedValue(undefined),
        actionLog: { onChange: null },
      }
      // get() returns the existing live session; getOrCreate() must also return it
      // (resume reuses — never creates).
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-resume',
        resume: true,
        // A URL is present but must be ignored on resume (state is preserved).
        url: 'https://example.com/other',
      })

      // Existing session reused via getOrCreate.
      expect(tunnel.browserSessionManager.getOrCreate).toHaveBeenCalledWith('sess-resume')
      // No navigation on resume — current page state is preserved.
      expect(mockPage.goto).not.toHaveBeenCalled()
      // Live view re-started (re-stream current frame) and ready re-sent.
      expect(mockSession.startLiveView).toHaveBeenCalled()
      expect(mockSession.reportFocusNow).toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({
        type: 'browser_ready',
        sessionId: 'sess-resume',
        currentUrl: 'https://example.com/page',
      })
      // resume_failed must NOT be sent on a successful resume.
      expect(sentMessages.some((m) => m.type === 'resume_failed')).toBe(false)
    })

    it('should send resume_failed (not_found) when resume requested but no session exists', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      tunnel.browserSessionManager.getOrCreate = jest.fn()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-missing',
        resume: true,
      })

      // A failed resume must NEVER create a new session.
      expect(tunnel.browserSessionManager.getOrCreate).not.toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'resume_failed',
        sessionId: 'sess-missing',
        reason: 'not_found',
      })
    })

    it('should send resume_failed (dead) when the existing session is no longer alive', async () => {
      const deadSession = { isAlive: false }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(deadSession)
      tunnel.browserSessionManager.getOrCreate = jest.fn()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-dead',
        resume: true,
      })

      expect(tunnel.browserSessionManager.getOrCreate).not.toHaveBeenCalled()
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'resume_failed',
        sessionId: 'sess-dead',
        reason: 'dead',
      })
    })

    it('should send resume_failed (dead) and not launch a new browser when the session dies during the getOrCreate await (TOCTOU race)', async () => {
      // Simulate the idle-timeout close() completing in the await microtask
      // window between the live pre-check (get) and getOrCreate resolving:
      // get() observes a live session, but by the time getOrCreate resolves the
      // session has been closed (isAlive flipped to false) while still lingering
      // in the manager's Map. Without a post-await re-check, getPage() would
      // launch a fresh browser and we'd falsely report browser_ready.
      const racedSession = {
        isAlive: true,
        getPage: jest.fn().mockResolvedValue({}),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('https://example.com'),
        getPageTitle: jest.fn().mockResolvedValue('Existing'),
        reportFocusNow: jest.fn().mockResolvedValue(undefined),
        actionLog: { onChange: null },
      }
      // Live at pre-check time.
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(racedSession)
      // getOrCreate resolves the same session, but the idle-close has by now
      // flipped isAlive to false (the race we must detect).
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockImplementation(async () => {
        racedSession.isAlive = false
        return racedSession
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({
        type: 'browser_open',
        sessionId: 'sess-raced',
        resume: true,
      })

      // The race must be detected: resume_failed(dead) and NO new browser.
      expect(racedSession.getPage).not.toHaveBeenCalled()
      expect(racedSession.startLiveView).not.toHaveBeenCalled()
      expect(sentMessages.some((m) => m.type === 'browser_ready')).toBe(false)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'resume_failed',
        sessionId: 'sess-raced',
        reason: 'dead',
      })
    })

    it('should fall through to a normal new-session open when resume is absent (backward compatible)', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
      }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
      }
      const getSpy = jest.fn()
      tunnel.browserSessionManager.get = getSpy
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-new' })

      // Without resume, the liveness pre-check (get) is never consulted.
      expect(getSpy).not.toHaveBeenCalled()
      expect(tunnel.browserSessionManager.getOrCreate).toHaveBeenCalledWith('sess-new')
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('browser_ready')
      expect(sentMessages.some((m) => m.type === 'resume_failed')).toBe(false)
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

    it('should re-report focus after navigate so an autofocused field shows its caret', async () => {
      const mockPage = { goto: jest.fn().mockResolvedValue(undefined) }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        actionLog: { add: jest.fn() },
        reportFocusNow: jest.fn().mockResolvedValue(undefined),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b8f',
        url: 'https://example.com',
      })

      expect(mockSession.reportFocusNow).toHaveBeenCalled()
      const gotoOrder = mockPage.goto.mock.invocationCallOrder[0]
      const reportOrder = mockSession.reportFocusNow.mock.invocationCallOrder[0]
      expect(gotoOrder).toBeLessThan(reportOrder)
      // The navigation must be recorded BEFORE the focus re-report so the
      // action-log entry never depends on reportFocusNow.
      expect(mockSession.actionLog.add).toHaveBeenCalledWith('direct', 'navigate', 'https://example.com')
      const addOrder = mockSession.actionLog.add.mock.invocationCallOrder[0]
      expect(addOrder).toBeLessThan(reportOrder)
    })

    it('should record the navigate action even if reportFocusNow throws', async () => {
      const mockPage = { goto: jest.fn().mockResolvedValue(undefined) }
      const mockSession = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        actionLog: { add: jest.fn() },
        // reportFocusNow normally swallows its own errors, but assert that even a
        // (hypothetical) throw cannot drop the navigation record because the log
        // entry is added first.
        reportFocusNow: jest.fn().mockRejectedValue(new Error('focus boom')),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserNavigate({
        type: 'browser_navigate',
        sessionId: 'sess-b8fe',
        url: 'https://example.com',
      })

      // The navigate entry is recorded despite the focus re-report rejecting.
      expect(mockSession.actionLog.add).toHaveBeenCalledWith('direct', 'navigate', 'https://example.com')
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

  describe('handleBrowserMouseMove - cursor update', () => {
    it('should do nothing if missing coordinates', async () => {
      const mockSession = { executeMouseMove: jest.fn(), getCursorAt: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm0' })
      expect(mockSession.executeMouseMove).not.toHaveBeenCalled()
      expect(mockSession.getCursorAt).not.toHaveBeenCalled()
    })

    it('should move then send browser_cursor_update on first move', async () => {
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockResolvedValue('pointer'),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm1', x: 30, y: 40 })
      expect(mockSession.executeMouseMove).toHaveBeenCalledWith(30, 40)
      expect(mockSession.getCursorAt).toHaveBeenCalledWith(30, 40)
      expect(sentMessages).toEqual([{ type: 'browser_cursor_update', sessionId: 'sess-mm1', cursor: 'pointer' }])
    })

    it('should not resend when cursor is unchanged between moves', async () => {
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockResolvedValue('text'),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm2', x: 1, y: 1 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm2', x: 2, y: 2 })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({ type: 'browser_cursor_update', sessionId: 'sess-mm2', cursor: 'text' })
    })

    it('should resend when cursor changes between moves', async () => {
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockResolvedValueOnce('default').mockResolvedValueOnce('pointer'),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm3', x: 1, y: 1 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm3', x: 2, y: 2 })
      expect(sentMessages).toEqual([
        { type: 'browser_cursor_update', sessionId: 'sess-mm3', cursor: 'default' },
        { type: 'browser_cursor_update', sessionId: 'sess-mm3', cursor: 'pointer' },
      ])
    })

    it('should warn and skip cursor update when executeMouseMove fails (no error send)', async () => {
      const { logger } = require('../../src/logger')
      const mockSession = {
        executeMouseMove: jest.fn().mockRejectedValue(new Error('mid-drag nav')),
        getCursorAt: jest.fn(),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm4', x: 5, y: 5 })
      expect(mockSession.getCursorAt).not.toHaveBeenCalled()
      expect(sentMessages).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mouseMove failed'))
    })

    it('should warn and skip update when getCursorAt rejects (no error send)', async () => {
      const { logger } = require('../../src/logger')
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockRejectedValue(new Error('eval failed')),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm5', x: 5, y: 5 })
      expect(mockSession.executeMouseMove).toHaveBeenCalledWith(5, 5)
      expect(sentMessages).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('getCursorAt failed'))
    })

    it('should clear lastSentCursor on browser close so the next move resends', async () => {
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockResolvedValue('pointer'),
        stopLiveView: jest.fn(),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      tunnel.browserSessionManager.close = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm6', x: 1, y: 1 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserClose({ type: 'browser_close', sessionId: 'sess-mm6' })
      sentMessages.length = 0
      // After close, lastSentCursor was cleared, so the same cursor value is resent.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm6', x: 1, y: 1 })
      expect(sentMessages).toEqual([{ type: 'browser_cursor_update', sessionId: 'sess-mm6', cursor: 'pointer' }])
    })

    it('should clear stale lastSentCursor on re-open so the next move resends after an idle auto-close', async () => {
      const mockSession = {
        executeMouseMove: jest.fn().mockResolvedValue(undefined),
        getCursorAt: jest.fn().mockResolvedValue('pointer'),
        getPage: jest.fn().mockResolvedValue(undefined),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // First move records the cursor for this sessionId.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm7', x: 1, y: 1 })

      // Simulate an idle-timeout auto-close that bypasses handleBrowserClose/cleanup:
      // lastSentCursor retains the previous session's value (no delete happens here).

      // Re-opening the same sessionId must clear the stale cursor entry.
      sentMessages.length = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-mm7' })

      // The first move after re-open must resend even though the cursor value is
      // identical to the previous session's last value.
      sentMessages.length = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mm7', x: 1, y: 1 })
      expect(sentMessages).toEqual([{ type: 'browser_cursor_update', sessionId: 'sess-mm7', cursor: 'pointer' }])
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

    it('should dispatch browser_mouse_move', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_mouse_move', sessionId: 'sess-z', x: 10, y: 20 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_mouse_down', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_mouse_down', sessionId: 'sess-z', x: 10, y: 20 })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sentMessages).toHaveLength(0)
    })

    it('should dispatch browser_mouse_up', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_mouse_up', sessionId: 'sess-z', x: 10, y: 20 })
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
        reportFocusNow: jest.fn().mockResolvedValue(undefined),
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

    it('handleBrowserMouseMove - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', x: 10, y: 20 })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserMouseDown - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseDown({ type: 'browser_mouse_down', x: 10, y: 20 })
      expect(sentMessages).toHaveLength(0)
    })

    it('handleBrowserMouseUp - should do nothing when no sessionId', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseUp({ type: 'browser_mouse_up', x: 10, y: 20 })
      expect(sentMessages).toHaveLength(0)
    })
  })

  describe('handleBrowserMouseMove', () => {
    it('should do nothing if missing coordinates', async () => {
      const mockSession = { executeMouseMove: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mv1' })
      expect(mockSession.executeMouseMove).not.toHaveBeenCalled()
    })

    it('should call executeMouseMove with coordinates', async () => {
      const mockSession = { executeMouseMove: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseMove({ type: 'browser_mouse_move', sessionId: 'sess-mv2', x: 30, y: 40 })
      expect(mockSession.executeMouseMove).toHaveBeenCalledWith(30, 40)
    })
  })

  describe('handleBrowserMouseDown', () => {
    it('should do nothing if missing coordinates', async () => {
      const mockSession = { executeMouseDown: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseDown({ type: 'browser_mouse_down', sessionId: 'sess-md1' })
      expect(mockSession.executeMouseDown).not.toHaveBeenCalled()
    })

    it('should call executeMouseDown with coordinates and button', async () => {
      const mockSession = { executeMouseDown: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseDown({ type: 'browser_mouse_down', sessionId: 'sess-md2', x: 50, y: 60, button: 'left' })
      expect(mockSession.executeMouseDown).toHaveBeenCalledWith(50, 60, 'left')
    })
  })

  describe('handleBrowserMouseUp', () => {
    it('should do nothing if missing coordinates', async () => {
      const mockSession = { executeMouseUp: jest.fn() }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseUp({ type: 'browser_mouse_up', sessionId: 'sess-mu1' })
      expect(mockSession.executeMouseUp).not.toHaveBeenCalled()
    })

    it('should call executeMouseUp with coordinates and button', async () => {
      const mockSession = { executeMouseUp: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserMouseUp({ type: 'browser_mouse_up', sessionId: 'sess-mu2', x: 70, y: 80, button: 'left' })
      expect(mockSession.executeMouseUp).toHaveBeenCalledWith(70, 80, 'left')
    })
  })

  describe('handleBrowserSetFile', () => {
    it('should do nothing when sessionId is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((tunnel as any).handleBrowserSetFile({ type: 'browser_set_file' })).resolves.toBeUndefined()
    })

    it('should no-op (no throw) when there is no pending chooser for the session', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tunnel as any).handleBrowserSetFile({ type: 'browser_set_file', sessionId: 'no-such-sess', files: [] }),
      ).resolves.toBeUndefined()
      expect(sentMessages.some((m) => m.type === 'error')).toBe(true)
    })

    it('passes buffer objects (not temp file paths) to accept so content is available after accept resolves', async () => {
      // REGRESSION TEST: Playwright's setFiles registers a path with the browser, but the
      // browser reads the file *after* setFiles resolves. If temp files are deleted in the
      // finally block immediately after accept(), those files are gone before the browser
      // reads them, causing "A requested file or directory could not be found" errors.
      // Fix: pass {name, mimeType, buffer} objects directly to setFiles — no temp files needed.
      let capturedPayload: unknown
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accept = jest.fn().mockImplementation(async (payload: any) => {
        capturedPayload = payload
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-f1', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-f1',
        files: [
          { name: 'a.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hi').toString('base64') },
          { name: 'b.bin', mimeType: 'application/octet-stream', dataBase64: Buffer.from('world').toString('base64') },
        ],
      })

      expect(accept).toHaveBeenCalledTimes(1)
      const payload = capturedPayload as Array<{ name: string; mimeType: string; buffer: Buffer }>
      expect(payload).toHaveLength(2)

      // Must be buffer objects, NOT string paths. String paths would point to temp files
      // that are deleted before the browser reads them.
      expect(typeof payload[0]).not.toBe('string')
      expect(typeof payload[1]).not.toBe('string')

      // Buffer objects carry the original file name and MIME type.
      expect(payload[0]).toMatchObject({ name: 'a.txt', mimeType: 'text/plain' })
      expect(payload[1]).toMatchObject({ name: 'b.bin', mimeType: 'application/octet-stream' })

      // Buffer content matches the decoded base64.
      expect(Buffer.isBuffer(payload[0].buffer)).toBe(true)
      expect(Buffer.isBuffer(payload[1].buffer)).toBe(true)
      expect(payload[0].buffer.toString('utf8')).toBe('hi')
      expect(payload[1].buffer.toString('utf8')).toBe('world')

      // accept should be removed after use
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-f1')).toBe(false)
    })

    // The tunnel is constructed with projectDir '/test/project', so the
    // workspace root is '/test/project/workspace'.
    const workspaceDir = path.join('/test/project', 'workspace')

    it('should resolve relative filePaths against the workspace root before setFiles', async () => {
      let pathsAtCall: string[] = []
      const accept = jest.fn().mockImplementation((paths: string[]) => {
        pathsAtCall = paths
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-rel', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-rel',
        filePaths: ['repos/app.ts', 'docs/readme.md'],
      })

      // Each workspace-relative path is resolved to an absolute path under the
      // workspace root before being handed to Playwright's setFiles.
      expect(accept).toHaveBeenCalledTimes(1)
      expect(pathsAtCall).toEqual([
        path.join(workspaceDir, 'repos/app.ts'),
        path.join(workspaceDir, 'docs/readme.md'),
      ])
      expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-rel')).toBe(false)
    })

    it('should resolve a "." workspace-relative path to the workspace root', async () => {
      let pathsAtCall: string[] = []
      const accept = jest.fn().mockImplementation((paths: string[]) => {
        pathsAtCall = paths
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-dot', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-dot',
        filePaths: ['./repos/nested/x.txt'],
      })

      expect(pathsAtCall).toEqual([path.join(workspaceDir, 'repos/nested/x.txt')])
      expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
    })

    it('should forward absolute filePaths inside the workspace untouched (backward compat)', async () => {
      let pathsAtCall: string[] = []
      const accept = jest.fn().mockImplementation((paths: string[]) => {
        pathsAtCall = paths
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-fp', accept)

      const abs1 = path.join(workspaceDir, 'repos/report.pdf')
      const abs2 = path.join(workspaceDir, 'docs/img.png')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-fp',
        filePaths: [abs1, abs2],
      })

      expect(accept).toHaveBeenCalledWith([abs1, abs2])
      // Paths passed through untouched (not relocated into the temp dir).
      expect(pathsAtCall).toEqual([abs1, abs2])
      expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-fp')).toBe(false)
    })

    it('should reject relative filePaths that escape the workspace and cancel the chooser', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-escape', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-escape',
        filePaths: ['../../etc/passwd'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-escape')
      expect(err).toBeDefined()
      expect(err!.message).toContain('outside the workspace')
      // The escaping path must NOT be applied; chooser cancelled with [].
      expect(accept).toHaveBeenCalledWith([])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-escape')).toBe(false)
    })

    it('should reject absolute filePaths outside the workspace and cancel the chooser', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-abs-out', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-abs-out',
        filePaths: ['/etc/passwd'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-abs-out')
      expect(err).toBeDefined()
      expect(err!.message).toContain('outside the workspace')
      expect(accept).toHaveBeenCalledWith([])
    })

    it('should reject filePaths when the agent has no project directory configured', async () => {
      const noDirTunnel = new VsCodeTunnelWebSocket('https://api.example.com', 'token', 'agent-x')
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(noDirTunnel as any).ws = mockWs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(noDirTunnel as any).pendingFileChoosers.set('sess-nodir', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (noDirTunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-nodir',
        filePaths: ['repos/app.ts'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-nodir')
      expect(err).toBeDefined()
      expect(err!.message).toContain('no project directory')
      expect(accept).toHaveBeenCalledWith([])
    })

    it('should send an error when accept rejects on a (valid) filePaths upload', async () => {
      const accept = jest.fn().mockRejectedValue(new Error('chooser gone'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-fp-fail', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-fp-fail',
        filePaths: ['repos/x.txt'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-fp-fail')
      expect(err).toBeDefined()
      expect(err!.message).toContain('File upload failed')
      expect(err!.message).toContain('chooser gone')
    })

    it('should sanitize traversal file names in buffer objects so names contain no path separators', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedPayload: Array<{ name: string; mimeType: string; buffer: Buffer }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accept = jest.fn().mockImplementation((payload: any) => {
        capturedPayload = payload
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-trav', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-trav',
        files: [
          { name: '../../../etc/passwd', mimeType: 'text/plain', dataBase64: Buffer.from('x').toString('base64') },
          { name: 'a/b/c.txt', mimeType: 'text/plain', dataBase64: Buffer.from('y').toString('base64') },
        ],
      })

      expect(capturedPayload).toHaveLength(2)
      for (const entry of capturedPayload) {
        // Buffer name must not retain any traversal/separator structure.
        expect(entry.name.includes('/')).toBe(false)
        expect(entry.name.includes('\\')).toBe(false)
        expect(entry.name).not.toBe('..')
      }
    })

    it('should fall back to application/octet-stream when mimeType is missing or not a string', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedPayload: Array<{ name: string; mimeType: string; buffer: Buffer }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accept = jest.fn().mockImplementation((payload: any) => {
        capturedPayload = payload
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-mime', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-mime',
        files: [
          { name: 'no-mime.bin', dataBase64: Buffer.from('data').toString('base64') }, // mimeType missing
          { name: 'num-mime.bin', mimeType: 42 as unknown as string, dataBase64: Buffer.from('data').toString('base64') }, // mimeType not a string
        ],
      })

      expect(accept).toHaveBeenCalledTimes(1)
      expect(capturedPayload).toHaveLength(2)
      expect(capturedPayload[0].mimeType).toBe('application/octet-stream')
      expect(capturedPayload[1].mimeType).toBe('application/octet-stream')
    })

    it('should call accept with [] when files is an empty array (cancel)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-f2', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({ type: 'browser_set_file', sessionId: 'sess-f2', files: [] })

      expect(accept).toHaveBeenCalledWith([])
      expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
    })

    it('should call accept with [] when neither files nor filePaths is provided (cancel)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-f3', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({ type: 'browser_set_file', sessionId: 'sess-f3' })

      expect(accept).toHaveBeenCalledWith([])
    })

    it('should send an error and cancel the chooser when accept (setFiles) rejects (HIGH-2)', async () => {
      const accept = jest.fn().mockRejectedValue(new Error('chooser invalidated'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-fail', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-fail',
        files: [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hi').toString('base64') }],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-fail')
      expect(err).toBeDefined()
      expect(err!.message).toContain('File upload failed')
      expect(err!.message).toContain('chooser invalidated')
      // Chooser consumed — no dangling pending entry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-fail')).toBe(false)
    })

    it('should reject oversized uploads, cancel the chooser, and not apply files (HIGH-3)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-big', accept)

      // 11MB base64 string → decoded ~8.25MB; use two files to exceed 10MB total.
      const sixMbBase64 = 'A'.repeat(8 * 1024 * 1024) // ~6MB decoded each
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-big',
        files: [
          { name: 'big1.bin', mimeType: 'application/octet-stream', dataBase64: sixMbBase64 },
          { name: 'big2.bin', mimeType: 'application/octet-stream', dataBase64: sixMbBase64 },
        ],
      })

      // Files must NOT be applied; chooser cancelled with [].
      expect(accept).toHaveBeenCalledTimes(1)
      expect(accept).toHaveBeenCalledWith([])
      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-big')
      expect(err).toBeDefined()
      expect(err!.message).toContain('File too large')
      // pending chooser consumed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-big')).toBe(false)
    })

    it('should error on a non-string dataBase64 entry without crashing (HIGH-3)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-bad', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-bad',
        // dataBase64 deliberately not a string
        files: [{ name: 'x.bin', mimeType: 'application/octet-stream', dataBase64: 12345 as unknown as string }],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-bad')
      expect(err).toBeDefined()
      // Files must not be applied; chooser cancelled.
      expect(accept).toHaveBeenCalledWith([])
    })

    // --- HIGH-1: malformed payloads must not throw / wedge the chooser ---

    it('should error and cancel the chooser when a filePaths element is not a string (HIGH-1)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-nonstr', accept)

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-nonstr',
          // A non-string element (123) would previously throw inside path.isAbsolute.
          filePaths: [123 as unknown as string],
        }),
      ).resolves.toBeUndefined()

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-nonstr')
      expect(err).toBeDefined()
      expect(err!.message).toContain('filePaths must be an array of strings')
      // Chooser cancelled with [] so the remote input is not left stuck.
      expect(accept).toHaveBeenCalledWith([])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-nonstr')).toBe(false)
    })

    it('should error and cancel the chooser when filePaths is not an array (HIGH-1)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-fp-nonarr', accept)

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-fp-nonarr',
          filePaths: 'repos/app.ts' as unknown as string[],
        }),
      ).resolves.toBeUndefined()

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-fp-nonarr')
      expect(err).toBeDefined()
      expect(err!.message).toContain('filePaths must be an array of strings')
      expect(accept).toHaveBeenCalledWith([])
    })

    it('should error and cancel the chooser when files is not an array (HIGH-1)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-files-nonarr', accept)

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-files-nonarr',
          // A non-array `files` would previously throw inside files.some.
          files: { name: 'x' } as unknown as [],
        }),
      ).resolves.toBeUndefined()

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-files-nonarr')
      expect(err).toBeDefined()
      expect(err!.message).toContain('files must be an array')
      expect(accept).toHaveBeenCalledWith([])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((tunnel as any).pendingFileChoosers.has('sess-files-nonarr')).toBe(false)
    })

    it('should error and cancel the chooser when an entry in files is null (HIGH-1)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-null-entry', accept)

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-null-entry',
          // A null entry would previously throw when reading f.dataBase64.
          files: [null as unknown as { name: string; mimeType: string; dataBase64: string }],
        }),
      ).resolves.toBeUndefined()

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-null-entry')
      expect(err).toBeDefined()
      expect(err!.message).toContain('dataBase64 must be a string')
      expect(accept).toHaveBeenCalledWith([])
    })

    // --- HIGH-2: filePaths branch must cancel the chooser when accept throws ---

    it('should cancel the chooser (symmetry) when accept rejects on a filePaths upload (HIGH-2)', async () => {
      const accept = jest.fn().mockRejectedValue(new Error('chooser gone'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-fp-cancel', accept)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-fp-cancel',
        filePaths: ['repos/x.txt'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-fp-cancel')
      expect(err).toBeDefined()
      expect(err!.message).toContain('File upload failed')
      // First call applies the resolved path; second call cancels with [].
      expect(accept).toHaveBeenCalledWith([path.join(workspaceDir, 'repos/x.txt')])
      expect(accept).toHaveBeenLastCalledWith([])
    })

    it('should fall back to the outer catch when an inner handler throws unexpectedly (HIGH-1 backstop)', async () => {
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).pendingFileChoosers.set('sess-backstop', accept)
      // Force an unexpected failure inside the resolve helper so the only thing
      // that protects the chooser is the outermost try/catch in handleBrowserSetFile.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).resolveWorkspaceFilePaths = jest
        .fn()
        .mockRejectedValue(new Error('unexpected internal failure'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetFile({
        type: 'browser_set_file',
        sessionId: 'sess-backstop',
        filePaths: ['repos/app.ts'],
      })

      const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-backstop')
      expect(err).toBeDefined()
      expect(err!.message).toContain('File upload failed')
      expect(err!.message).toContain('unexpected internal failure')
      // Backstop must still cancel the chooser so it is not left stuck.
      expect(accept).toHaveBeenCalledWith([])
    })

    // --- MEDIUM: symlink-escape guard via fs.realpath ---

    it('should reject a workspace symlink that points outside the workspace (MEDIUM)', async () => {
      // Build a real on-disk workspace with a symlink escaping it.
      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sym-escape-'))
      const projectDir = path.join(root, 'project')
      const realWorkspaceDir = path.join(projectDir, 'workspace')
      await fsPromises.mkdir(realWorkspaceDir, { recursive: true })
      // A secret file OUTSIDE the workspace.
      const secret = path.join(root, 'secret.txt')
      await fsPromises.writeFile(secret, 'top secret')
      // A symlink inside the workspace pointing at the external secret.
      const link = path.join(realWorkspaceDir, 'leak')
      await fsPromises.symlink(secret, link)

      const symTunnel = new VsCodeTunnelWebSocket('https://api.example.com', 'token', 'agent-sym', projectDir)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).ws = mockWs
      const accept = jest.fn().mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).pendingFileChoosers.set('sess-sym', accept)

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (symTunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-sym',
          filePaths: ['leak'],
        })

        const err = sentMessages.find((m) => m.type === 'error' && m.sessionId === 'sess-sym')
        expect(err).toBeDefined()
        expect(err!.message).toContain('outside the workspace')
        // Escaping symlink not applied; chooser cancelled.
        expect(accept).toHaveBeenCalledWith([])
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true })
      }
    })

    it('should accept a workspace symlink whose target is inside the workspace (MEDIUM)', async () => {
      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sym-inside-'))
      const projectDir = path.join(root, 'project')
      const realWorkspaceDir = path.join(projectDir, 'workspace')
      await fsPromises.mkdir(path.join(realWorkspaceDir, 'repos'), { recursive: true })
      // A real file inside the workspace.
      const target = path.join(realWorkspaceDir, 'repos', 'real.txt')
      await fsPromises.writeFile(target, 'inside')
      // A symlink, also inside the workspace, pointing at the in-workspace file.
      const link = path.join(realWorkspaceDir, 'alias.txt')
      await fsPromises.symlink(target, link)

      const symTunnel = new VsCodeTunnelWebSocket('https://api.example.com', 'token', 'agent-sym2', projectDir)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).ws = mockWs
      let pathsAtCall: string[] = []
      const accept = jest.fn().mockImplementation((paths: string[]) => {
        pathsAtCall = paths
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).pendingFileChoosers.set('sess-sym-ok', accept)

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (symTunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-sym-ok',
          filePaths: ['alias.txt'],
        })

        expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
        // The lexically-validated absolute path is forwarded (not the resolved target).
        expect(pathsAtCall).toEqual([path.join(realWorkspaceDir, 'alias.txt')])
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true })
      }
    })

    it('should accept a real (non-symlink) file inside the workspace (MEDIUM)', async () => {
      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sym-real-'))
      const projectDir = path.join(root, 'project')
      const realWorkspaceDir = path.join(projectDir, 'workspace', 'docs')
      await fsPromises.mkdir(realWorkspaceDir, { recursive: true })
      const file = path.join(realWorkspaceDir, 'readme.md')
      await fsPromises.writeFile(file, 'hello')

      const symTunnel = new VsCodeTunnelWebSocket('https://api.example.com', 'token', 'agent-real', projectDir)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).ws = mockWs
      let pathsAtCall: string[] = []
      const accept = jest.fn().mockImplementation((paths: string[]) => {
        pathsAtCall = paths
        return Promise.resolve()
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(symTunnel as any).pendingFileChoosers.set('sess-real', accept)

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (symTunnel as any).handleBrowserSetFile({
          type: 'browser_set_file',
          sessionId: 'sess-real',
          filePaths: ['docs/readme.md'],
        })

        expect(sentMessages.some((m) => m.type === 'error')).toBe(false)
        expect(pathsAtCall).toEqual([path.join(projectDir, 'workspace', 'docs', 'readme.md')])
      } finally {
        await fsPromises.rm(root, { recursive: true, force: true })
      }
    })
  })

  describe('handleBrowserSetInputValue', () => {
    it('should route browser_set_input_value through onParsedMessage', () => {
      const mockSession = { setFocusedInputValue: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(tunnel as any).onParsedMessage({ type: 'browser_set_input_value', sessionId: 'sess-iv0', value: 'x' })
      expect(mockSession.setFocusedInputValue).toHaveBeenCalledWith('x', undefined, undefined)
    })

    it('should call setFocusedInputValue with value and selection', async () => {
      const mockSession = { setFocusedInputValue: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetInputValue({
        type: 'browser_set_input_value',
        sessionId: 'sess-iv1',
        value: 'hello',
        selectionStart: 1,
        selectionEnd: 3,
      })
      expect(mockSession.setFocusedInputValue).toHaveBeenCalledWith('hello', 1, 3)
      expect(sentMessages).toHaveLength(0)
    })

    it('should do nothing if session is not found', async () => {
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetInputValue({
        type: 'browser_set_input_value',
        sessionId: 'no-such',
        value: 'x',
      })
      expect(sentMessages).toHaveLength(0)
    })

    it('should ignore payloads with a non-string value', async () => {
      const mockSession = { setFocusedInputValue: jest.fn().mockResolvedValue(undefined) }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetInputValue({
        type: 'browser_set_input_value',
        sessionId: 'sess-iv2',
      })
      expect(mockSession.setFocusedInputValue).not.toHaveBeenCalled()
      expect(sentMessages).toHaveLength(0)
    })

    it('should send error when setFocusedInputValue rejects', async () => {
      const mockSession = {
        setFocusedInputValue: jest.fn().mockRejectedValue(new Error('boom')),
      }
      tunnel.browserSessionManager.get = jest.fn().mockReturnValue(mockSession)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserSetInputValue({
        type: 'browser_set_input_value',
        sessionId: 'sess-iv3',
        value: 'x',
      })
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0].type).toBe('error')
      expect(sentMessages[0].sessionId).toBe('sess-iv3')
      expect(sentMessages[0].message).toContain('setInputValue failed')
    })
  })

  describe('handleBrowserOpen - focus change wiring', () => {
    it('should relay session focus changes as browser_focus_changed', async () => {
      const mockPage = {
        url: jest.fn().mockReturnValue('about:blank'),
        title: jest.fn().mockResolvedValue(''),
        screenshot: jest.fn().mockResolvedValue(Buffer.from('fake')),
      }
      const mockSession: Record<string, unknown> = {
        getPage: jest.fn().mockResolvedValue(mockPage),
        startLiveView: jest.fn(),
        getCurrentUrl: jest.fn().mockReturnValue('about:blank'),
        getPageTitle: jest.fn().mockResolvedValue(''),
        actionLog: { onChange: null },
        onFileChooser: null,
        onFocusChange: null,
      }
      tunnel.browserSessionManager.getOrCreate = jest.fn().mockResolvedValue(mockSession)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tunnel as any).handleBrowserOpen({ type: 'browser_open', sessionId: 'sess-fc1' })

      // The handler must have wired a focus-change callback onto the session.
      const onFocusChange = mockSession.onFocusChange as ((p: unknown) => void) | null
      expect(typeof onFocusChange).toBe('function')

      sentMessages.length = 0
      onFocusChange!({ focused: true, value: 'abc', rect: { x: 1, y: 2, width: 3, height: 4 } })

      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toEqual({
        type: 'browser_focus_changed',
        sessionId: 'sess-fc1',
        focused: true,
        value: 'abc',
        rect: { x: 1, y: 2, width: 3, height: 4 },
      })
    })
  })
})
