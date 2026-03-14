import WebSocket from 'ws'
import { EventEmitter } from 'events'

import { VsCodeWsProxy } from '../../src/vscode/vscode-ws-proxy'

jest.mock('ws')

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('VsCodeWsProxy', () => {
  let proxy: VsCodeWsProxy
  let mockWs: EventEmitter & {
    send: jest.Mock
    close: jest.Mock
    readyState: number
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockWs = Object.assign(new EventEmitter(), {
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
    })

    ;(WebSocket as unknown as jest.Mock).mockImplementation(() => mockWs)

    proxy = new VsCodeWsProxy(8443)
  })

  describe('openConnection', () => {
    it('should create a WebSocket connection to code-server', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)

      expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:8443/ws')
    })

    it('should add connection to map on open', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      // Verify connection is tracked by attempting to send
      proxy.sendFrame('sub-1', Buffer.from('hello').toString('base64'))
      expect(mockWs.send).toHaveBeenCalled()
    })

    it('should forward messages as base64 via onData callback', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      // Send buffer data
      mockWs.emit('message', Buffer.from('test data'))
      expect(onData).toHaveBeenCalledWith(Buffer.from('test data').toString('base64'))
    })

    it('should forward string messages as base64', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      mockWs.emit('message', 'string data')
      expect(onData).toHaveBeenCalledWith(Buffer.from('string data').toString('base64'))
    })

    it('should call onClose and remove connection on close', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')
      mockWs.emit('close')

      expect(onClose).toHaveBeenCalled()

      // Verify connection is removed
      proxy.sendFrame('sub-1', Buffer.from('hello').toString('base64'))
      expect(mockWs.send).not.toHaveBeenCalled()
    })

    it('should handle error events without throwing', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)

      expect(() => {
        mockWs.emit('error', new Error('connection refused'))
      }).not.toThrow()
    })
  })

  describe('sendFrame', () => {
    it('should send base64-decoded data to WebSocket', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      const data = Buffer.from('test').toString('base64')
      proxy.sendFrame('sub-1', data)

      expect(mockWs.send).toHaveBeenCalledWith(Buffer.from(data, 'base64'))
    })

    it('should not send if connection not found', () => {
      proxy.sendFrame('nonexistent', Buffer.from('test').toString('base64'))
      expect(mockWs.send).not.toHaveBeenCalled()
    })

    it('should not send if WebSocket is not OPEN', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      mockWs.readyState = WebSocket.CLOSED
      proxy.sendFrame('sub-1', Buffer.from('test').toString('base64'))

      expect(mockWs.send).not.toHaveBeenCalled()
    })

    it('should catch send errors', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      mockWs.send.mockImplementation(() => { throw new Error('send failed') })

      expect(() => {
        proxy.sendFrame('sub-1', Buffer.from('test').toString('base64'))
      }).not.toThrow()
    })
  })

  describe('closeConnection', () => {
    it('should close and remove a specific connection', () => {
      const onData = jest.fn()
      const onClose = jest.fn()

      proxy.openConnection('sub-1', '/ws', onData, onClose)
      mockWs.emit('open')

      proxy.closeConnection('sub-1')

      expect(mockWs.close).toHaveBeenCalled()

      // Verify removed
      proxy.sendFrame('sub-1', Buffer.from('test').toString('base64'))
      expect(mockWs.send).not.toHaveBeenCalled()
    })

    it('should do nothing if connection not found', () => {
      expect(() => proxy.closeConnection('nonexistent')).not.toThrow()
    })
  })

  describe('closeAll', () => {
    it('should close all connections', () => {
      const mockWs2 = Object.assign(new EventEmitter(), {
        send: jest.fn(),
        close: jest.fn(),
        readyState: WebSocket.OPEN,
      })

      let callCount = 0
      ;(WebSocket as unknown as jest.Mock).mockImplementation(() => {
        return callCount++ === 0 ? mockWs : mockWs2
      })

      proxy.openConnection('sub-1', '/ws', jest.fn(), jest.fn())
      mockWs.emit('open')

      proxy.openConnection('sub-2', '/ws', jest.fn(), jest.fn())
      mockWs2.emit('open')

      proxy.closeAll()

      expect(mockWs.close).toHaveBeenCalled()
      expect(mockWs2.close).toHaveBeenCalled()
    })
  })
})
