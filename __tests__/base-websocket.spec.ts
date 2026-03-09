import { EventEmitter } from 'events'
import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../src/base-websocket'

jest.mock('../src/logger')

class MockWebSocket extends EventEmitter {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  send = jest.fn()
  close = jest.fn()

  simulateOpen(): void {
    this.emit('open')
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(data))
  }

  simulateClose(): void {
    this.emit('close')
  }
}

let mockWsInstance: MockWebSocket | null = null
jest.mock('ws', () => {
  const MockWS = function () {
    mockWsInstance = new MockWebSocket()
    return mockWsInstance
  }
  Object.defineProperty(MockWS, 'OPEN', { value: 1 })
  Object.defineProperty(MockWS, 'CLOSED', { value: 3 })
  return { __esModule: true, default: MockWS }
})

interface TestMessage {
  type: string
  data?: string
}

/**
 * BaseWebSocketConnection のデフォルト no-op メソッドをテストするための
 * 最小限の具象クラス。onDisconnect, onWebSocketClose, onReconnected を
 * オーバーライドしない。
 */
class TestWebSocketConnection extends BaseWebSocketConnection<TestMessage> {
  public receivedMessages: TestMessage[] = []

  constructor() {
    super({
      maxReconnectRetries: 3,
      reconnectBaseDelayMs: 100,
      logPrefix: 'Test:',
    })
  }

  protected createWebSocket(): WebSocket {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const WS = require('ws').default
    return new WS() as WebSocket
  }

  protected onOpen(_ws: unknown, resolve: (value: void) => void): void {
    resolve()
  }

  protected onParsedMessage(msg: TestMessage): void {
    this.receivedMessages.push(msg)
  }
}

describe('BaseWebSocketConnection default methods', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockWsInstance = null
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should connect and disconnect using default no-op hooks', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    // disconnect calls default onDisconnect (no-op) and closeWebSocket
    conn.disconnect()
    expect(mockWsInstance!.close).toHaveBeenCalled()
  })

  it('should call default onWebSocketClose on close event', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    // Simulate unexpected close — triggers default onWebSocketClose (no-op)
    const firstWs = mockWsInstance!
    firstWs.simulateClose()

    // Advance past reconnect delay
    await jest.advanceTimersByTimeAsync(100)

    // New WebSocket should be created for reconnect
    expect(mockWsInstance).not.toBe(firstWs)

    // Complete reconnection — triggers default onReconnected (no-op)
    mockWsInstance!.simulateOpen()
    await jest.advanceTimersByTimeAsync(100)

    conn.disconnect()
  })

  it('should parse and deliver messages', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.simulateMessage({ type: 'test', data: 'hello' })
    expect(conn.receivedMessages).toEqual([{ type: 'test', data: 'hello' }])

    conn.disconnect()
  })
})
