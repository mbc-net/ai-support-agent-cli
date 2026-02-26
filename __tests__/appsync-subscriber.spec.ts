import { EventEmitter } from 'events'

import { AppSyncSubscriber } from '../src/appsync-subscriber'

jest.mock('../src/logger')

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  send = jest.fn()
  close = jest.fn()

  constructor(public url: string, public protocols?: string[]) {
    super()
  }

  // Simulate open event
  simulateOpen(): void {
    this.emit('open')
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(data))
  }

  simulateError(error: Error): void {
    this.emit('error', error)
  }

  simulateClose(): void {
    this.emit('close')
  }
}

let mockWsInstance: MockWebSocket | null = null
jest.mock('ws', () => {
  const MockWS = function (url: string, protocols?: string[]) {
    mockWsInstance = new MockWebSocket(url, protocols)
    return mockWsInstance
  }
  Object.defineProperty(MockWS, 'OPEN', { value: 1 })
  Object.defineProperty(MockWS, 'CLOSED', { value: 3 })
  return { __esModule: true, default: MockWS }
})

describe('AppSyncSubscriber', () => {
  const appsyncUrl = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql'
  const apiKey = 'da2-testkey123'

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockWsInstance = null
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('connection URL derivation', () => {
    it('should convert https to wss and append /realtime', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      const connectPromise = subscriber.connect()

      // Wait for WebSocket creation
      expect(mockWsInstance).not.toBeNull()
      expect(mockWsInstance!.url).toMatch(/^wss:\/\//)
      expect(mockWsInstance!.url).toContain('/graphql/realtime')

      // Complete connection
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })

      await connectPromise
      subscriber.disconnect()
    })

    it('should include base64-encoded header and payload in URL', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      const connectPromise = subscriber.connect()

      const url = mockWsInstance!.url
      const headerMatch = url.match(/header=([^&]+)/)
      const payloadMatch = url.match(/payload=([^&]+)/)

      expect(headerMatch).not.toBeNull()
      expect(payloadMatch).not.toBeNull()

      const header = JSON.parse(Buffer.from(headerMatch![1], 'base64').toString())
      expect(header).toHaveProperty('host')
      expect(header).toHaveProperty('x-api-key', apiKey)
      expect(header).toHaveProperty('content-type', 'application/json')

      const payload = JSON.parse(Buffer.from(payloadMatch![1], 'base64').toString())
      expect(payload).toEqual({})

      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })

      await connectPromise
      subscriber.disconnect()
    })
  })

  describe('message flow', () => {
    it('should send connection_init on open', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      const connectPromise = subscriber.connect()

      mockWsInstance!.simulateOpen()

      expect(mockWsInstance!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'connection_init' }),
      )

      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise
      subscriber.disconnect()
    })

    it('should send start message with subscription after connection_ack', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)

      // Set up subscription before connect
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()

      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })

      await connectPromise

      // Should have sent connection_init and start
      expect(mockWsInstance!.send).toHaveBeenCalledTimes(2)

      const startCall = JSON.parse(mockWsInstance!.send.mock.calls[1][0])
      expect(startCall.type).toBe('start')
      expect(startCall.id).toBeDefined()

      const data = JSON.parse(startCall.payload.data)
      expect(data.variables.tenantCode).toBe('test-tenant')
      expect(data.query).toContain('subscription OnMessage')

      subscriber.disconnect()
    })

    it('should dispatch data messages to handler', async () => {
      const handler = jest.fn()
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', handler)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      const notification = {
        id: 'notif-1',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-1', type: 'execute_command' },
      }

      mockWsInstance!.simulateMessage({
        type: 'data',
        id: 'sub-123',
        payload: {
          data: { onMessage: notification },
        },
      })

      expect(handler).toHaveBeenCalledWith(notification)

      subscriber.disconnect()
    })
  })

  describe('keep-alive handling', () => {
    it('should silently consume ka messages', async () => {
      const handler = jest.fn()
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', handler)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // ka message should not trigger handler
      mockWsInstance!.simulateMessage({ type: 'ka' })
      expect(handler).not.toHaveBeenCalled()

      subscriber.disconnect()
    })
  })

  describe('auto-reconnect', () => {
    it('should attempt reconnect on unexpected close', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      const reconnectCallback = jest.fn()
      subscriber.onReconnect(reconnectCallback)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Simulate unexpected close
      const firstWs = mockWsInstance!
      firstWs.simulateClose()

      // Advance past reconnect delay (1s for first attempt)
      await jest.advanceTimersByTimeAsync(1000)

      // New WebSocket should be created
      expect(mockWsInstance).not.toBe(firstWs)

      // Complete reconnection
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })

      // Wait for reconnect promise to settle
      await jest.advanceTimersByTimeAsync(100)

      expect(reconnectCallback).toHaveBeenCalled()

      subscriber.disconnect()
    })

    it('should use exponential backoff for reconnect', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // First close: should reconnect after 1s
      mockWsInstance!.simulateClose()
      await jest.advanceTimersByTimeAsync(1000)

      // Fail the reconnect
      mockWsInstance!.simulateError(new Error('Connection refused'))
      mockWsInstance!.simulateClose()

      // Second attempt: should reconnect after 2s
      await jest.advanceTimersByTimeAsync(2000)

      // Fail again
      mockWsInstance!.simulateError(new Error('Connection refused'))
      mockWsInstance!.simulateClose()

      // Third attempt: should reconnect after 4s
      await jest.advanceTimersByTimeAsync(4000)

      // This time, succeed
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })

      await jest.advanceTimersByTimeAsync(100)

      subscriber.disconnect()
    })

    it('should not reconnect after disconnect() is called', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      const wsBeforeDisconnect = mockWsInstance!
      subscriber.disconnect()

      // Simulate close after disconnect
      wsBeforeDisconnect.simulateClose()

      await jest.advanceTimersByTimeAsync(5000)

      // No new WebSocket should be created
      expect(mockWsInstance).toBe(wsBeforeDisconnect)
    })
  })

  describe('disconnect', () => {
    it('should send stop message and close WebSocket', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      const ws = mockWsInstance!
      subscriber.disconnect()

      // Should have sent a stop message
      const stopCall = JSON.parse(ws.send.mock.calls[ws.send.mock.calls.length - 1][0])
      expect(stopCall.type).toBe('stop')
      expect(ws.close).toHaveBeenCalled()
    })
  })

  describe('error message handling', () => {
    it('should handle error messages without crashing', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Should not throw
      mockWsInstance!.simulateMessage({ type: 'error', payload: { errorCode: 'unauthorized' } })

      subscriber.disconnect()
    })
  })

  describe('complete message handling', () => {
    it('should handle complete messages and reset subscriptionId', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      mockWsInstance!.simulateMessage({ type: 'complete', id: 'sub-123' })

      // After complete, disconnect should not send stop (no subscriptionId)
      const sendCallsBefore = mockWsInstance!.send.mock.calls.length
      subscriber.disconnect()

      // No additional stop message should be sent since subscriptionId was reset
      const sendCallsAfter = mockWsInstance!.send.mock.calls.length
      expect(sendCallsAfter).toBe(sendCallsBefore)
    })
  })

  describe('start_ack message handling', () => {
    it('should handle start_ack messages silently', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Should not throw
      mockWsInstance!.simulateMessage({ type: 'start_ack', id: 'sub-123' })

      subscriber.disconnect()
    })
  })

  describe('JSON parse error handling', () => {
    it('should handle invalid JSON messages gracefully', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Send raw invalid JSON
      mockWsInstance!.emit('message', 'not-valid-json')

      // Should not crash
      subscriber.disconnect()
    })
  })

  describe('max reconnect attempts', () => {
    it('should stop reconnecting after max retries', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Simulate unexpected close and fail reconnections 5 times (MAX_RECONNECT_RETRIES)
      for (let i = 0; i < 5; i++) {
        mockWsInstance!.simulateClose()
        const delay = 1000 * Math.pow(2, i)
        await jest.advanceTimersByTimeAsync(delay)
        // Fail the reconnect
        mockWsInstance!.simulateError(new Error('Connection refused'))
      }

      // After 5 failures, the last close should not trigger another reconnect
      const wsAfterMaxRetries = mockWsInstance
      mockWsInstance!.simulateClose()
      await jest.advanceTimersByTimeAsync(100000)

      // No new WebSocket should be created
      expect(mockWsInstance).toBe(wsAfterMaxRetries)
    })
  })

  describe('keep-alive timeout', () => {
    it('should close WebSocket when keep-alive times out', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 5000 } })
      await connectPromise

      const ws = mockWsInstance!

      // Advance past the keep-alive timeout
      await jest.advanceTimersByTimeAsync(5000)

      expect(ws.close).toHaveBeenCalled()

      subscriber.disconnect()
    })

    it('should reset keep-alive timer on data messages', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)
      subscriber.subscribe('test-tenant', jest.fn())

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 5000 } })
      await connectPromise

      const ws = mockWsInstance!

      // Advance almost to timeout
      await jest.advanceTimersByTimeAsync(4000)

      // Send ka to reset timer
      mockWsInstance!.simulateMessage({ type: 'ka' })

      // Advance another 4s (would have timed out without ka)
      await jest.advanceTimersByTimeAsync(4000)
      expect(ws.close).not.toHaveBeenCalled()

      // Now advance past the new timeout
      await jest.advanceTimersByTimeAsync(1000)
      expect(ws.close).toHaveBeenCalled()

      subscriber.disconnect()
    })
  })

  describe('data messages without handler', () => {
    it('should not crash when data arrives without a handler', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Data message without subscribe() being called
      mockWsInstance!.simulateMessage({
        type: 'data',
        payload: { data: { onMessage: { id: '1', tenantCode: 't', table: 't', pk: 'p', sk: 's', action: 'a', content: {} } } },
      })

      // Should not throw
      subscriber.disconnect()
    })
  })

  describe('subscribe after connect', () => {
    it('should send subscription immediately if already connected', async () => {
      const subscriber = new AppSyncSubscriber(appsyncUrl, apiKey)

      const connectPromise = subscriber.connect()
      mockWsInstance!.simulateOpen()
      mockWsInstance!.simulateMessage({ type: 'connection_ack', payload: { connectionTimeoutMs: 300000 } })
      await connectPromise

      // Subscribe after connection is established
      subscriber.subscribe('test-tenant', jest.fn())

      // Should have sent connection_init + start
      expect(mockWsInstance!.send).toHaveBeenCalledTimes(2)

      const startCall = JSON.parse(mockWsInstance!.send.mock.calls[1][0])
      expect(startCall.type).toBe('start')

      subscriber.disconnect()
    })
  })
})
