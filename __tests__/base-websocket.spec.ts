import { EventEmitter } from 'events'
import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../src/base-websocket'
import { WS_HEARTBEAT_INTERVAL_MS, WS_HEARTBEAT_TIMEOUT_MS } from '../src/constants'

jest.mock('../src/logger')

class MockWebSocket extends EventEmitter {
  static OPEN = 1
  static CLOSED = 3
  readyState = MockWebSocket.OPEN
  send = jest.fn()
  close = jest.fn()
  terminate = jest.fn()
  ping = jest.fn()

  simulateOpen(): void {
    this.emit('open')
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.emit('message', JSON.stringify(data))
  }

  simulatePong(): void {
    this.emit('pong')
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

  it('should terminate when readyState is not OPEN or CLOSING', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.readyState = MockWebSocket.CLOSED
    conn.disconnect()
    expect(mockWsInstance!.terminate).toHaveBeenCalled()
    expect(mockWsInstance!.close).not.toHaveBeenCalled()
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

  it('should ignore unparsable messages without throwing', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // 不正な JSON を流してもクラッシュせず、メッセージは配信されない
    expect(() => mockWsInstance!.emit('message', 'not-json{')).not.toThrow()
    expect(conn.receivedMessages).toEqual([])

    conn.disconnect()
  })

  it('should log and not throw on a WebSocket error after connect', async () => {
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // 接続確立後（this.ws 設定済み）の error はログのみで reject しない
    expect(() => mockWsInstance!.emit('error', new Error('boom'))).not.toThrow()

    conn.disconnect()
  })

  describe('sendMessage', () => {
    it('should send JSON message when ws is OPEN', async () => {
      const conn = new TestWebSocketConnection()
      const connectPromise = conn.connect()
      mockWsInstance!.simulateOpen()
      await connectPromise

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(conn as any).sendMessage({ type: 'test', data: 'hello' })
      expect(mockWsInstance!.send).toHaveBeenCalledWith('{"type":"test","data":"hello"}')
    })

    it('should not send when ws is null', () => {
      const conn = new TestWebSocketConnection()
      // ws is null before connect
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(conn as any).sendMessage({ type: 'test' })
      // No error thrown
    })

    it('should not send when ws is not OPEN', async () => {
      const conn = new TestWebSocketConnection()
      const connectPromise = conn.connect()
      mockWsInstance!.simulateOpen()
      await connectPromise

      mockWsInstance!.readyState = MockWebSocket.CLOSED
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(conn as any).sendMessage({ type: 'test' })
      expect(mockWsInstance!.send).not.toHaveBeenCalled()
    })

    it('should catch send errors', async () => {
      const conn = new TestWebSocketConnection()
      const connectPromise = conn.connect()
      mockWsInstance!.simulateOpen()
      await connectPromise

      mockWsInstance!.send.mockImplementation(() => { throw new Error('send failed') })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (conn as any).sendMessage({ type: 'test' })).not.toThrow()
    })
  })
})

/**
 * ハートビート (ping/pong) 設定をテストで制御するための具象クラス。
 */
class HeartbeatTestConnection extends BaseWebSocketConnection<TestMessage> {
  constructor(heartbeatIntervalMs: number, heartbeatTimeoutMs: number) {
    super({
      maxReconnectRetries: 3,
      reconnectBaseDelayMs: 100,
      logPrefix: 'HB:',
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
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

  protected onParsedMessage(): void {
    // no-op
  }
}

describe('BaseWebSocketConnection heartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockWsInstance = null
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should send ping at the configured interval', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    expect(mockWsInstance!.ping).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    // pong が返れば次の間隔でも terminate されない
    mockWsInstance!.simulatePong()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(2)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should terminate the socket when no pong is received within timeout', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    jest.advanceTimersByTime(1000) // ping 送信、pong 待ち開始
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    jest.advanceTimersByTime(500) // pong タイムアウト
    expect(mockWsInstance!.terminate).toHaveBeenCalledTimes(1)

    conn.disconnect()
  })

  it('should not ping when readyState is not OPEN', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.readyState = MockWebSocket.CLOSED
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should catch ping errors', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.ping.mockImplementation(() => { throw new Error('ping failed') })
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow()

    conn.disconnect()
  })

  it('should stop heartbeat after close (no ping after terminate)', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    const firstWs = mockWsInstance!
    firstWs.simulateClose()
    // close でハートビート停止。reconnect 前に時間を進めても旧 ws に ping は飛ばない
    firstWs.ping.mockClear()
    jest.advanceTimersByTime(2000)
    expect(firstWs.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should be disabled when heartbeatIntervalMs <= 0', async () => {
    const conn = new HeartbeatTestConnection(0, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    jest.advanceTimersByTime(60_000)
    expect(mockWsInstance!.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should ignore an unexpected pong with no pending timeout', async () => {
    const conn = new HeartbeatTestConnection(1000, 500)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // ping 前（pong 待ちタイマー未設定）の pong を受けても安全
    expect(() => mockWsInstance!.simulatePong()).not.toThrow()
    // その後も正常に ping が動く
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)

    conn.disconnect()
  })

  it('should use default heartbeat constants when options are omitted', async () => {
    // heartbeatIntervalMs / heartbeatTimeoutMs を渡さない既定経路をカバー
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    jest.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(WS_HEARTBEAT_TIMEOUT_MS)
    expect(mockWsInstance!.terminate).toHaveBeenCalled()

    conn.disconnect()
  })
})
