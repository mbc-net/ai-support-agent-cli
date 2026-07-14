import { EventEmitter } from 'events'
import WebSocket from 'ws'

import { BaseWebSocketConnection } from '../src/base-websocket'
import { WS_CLOSE_CODE_AUTH_REJECTED, WS_HEARTBEAT_INTERVAL_MS, WS_PONG_MAX_MISSED } from '../src/constants'
import { logger } from '../src/logger'

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

  simulateClose(code?: number, reason?: string): void {
    this.emit('close', code, reason)
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

  constructor(authRejectedCloseCode?: number) {
    super({
      maxReconnectRetries: 3,
      reconnectBaseDelayMs: 100,
      logPrefix: 'Test:',
      authRejectedCloseCode,
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

  it('should NOT reconnect and should log an error when closed with the configured auth-rejected code (regression: infinite retry against a permanently rejected Agent ID)', async () => {
    const conn = new TestWebSocketConnection(WS_CLOSE_CODE_AUTH_REJECTED)
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    const firstWs = mockWsInstance!
    firstWs.simulateClose(WS_CLOSE_CODE_AUTH_REJECTED, 'agent_id_mismatch')

    // Give any (incorrect) reconnect logic a chance to run.
    await jest.advanceTimersByTimeAsync(5000)

    // No new WebSocket should have been created — the server permanently rejected
    // this connection's credentials, so retrying with the same token/agentId would
    // just repeat the same rejection forever.
    expect(mockWsInstance).toBe(firstWs)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('authentication'))
  })

  it('should reconnect as usual when closed with an ordinary (non-auth-rejected) code', async () => {
    const conn = new TestWebSocketConnection(WS_CLOSE_CODE_AUTH_REJECTED)
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    const firstWs = mockWsInstance!
    firstWs.simulateClose(1006, 'abnormal closure')

    await jest.advanceTimersByTimeAsync(100)

    expect(mockWsInstance).not.toBe(firstWs)
    conn.disconnect()
  })

  it('should keep reconnecting even on the shared close-code value when the connection opted out of auth-rejected handling (e.g. AppSyncSubscriber, whose close codes carry unrelated AWS-side meaning)', async () => {
    // No authRejectedCloseCode passed — this connection never interprets any
    // close code as a permanent auth rejection.
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()

    mockWsInstance!.simulateOpen()
    await connectPromise

    const firstWs = mockWsInstance!
    firstWs.simulateClose(WS_CLOSE_CODE_AUTH_REJECTED, 'unrelated meaning on this server')

    await jest.advanceTimersByTimeAsync(100)

    expect(mockWsInstance).not.toBe(firstWs)
    expect(logger.error).not.toHaveBeenCalled()
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
 * Concrete subclass used to drive the heartbeat (ping/pong) logic in tests.
 * Only the ping interval is configurable; dead-detection uses the shared
 * isAlive / missed-pong-count method (no per-ping setTimeout pong timer).
 */
class HeartbeatTestConnection extends BaseWebSocketConnection<TestMessage> {
  constructor(heartbeatIntervalMs: number) {
    super({
      maxReconnectRetries: 3,
      reconnectBaseDelayMs: 100,
      logPrefix: 'HB:',
      heartbeatIntervalMs,
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

describe('BaseWebSocketConnection heartbeat (isAlive / missed-pong method)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockWsInstance = null
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should send ping at the configured interval', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    expect(mockWsInstance!.ping).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    // A pong before the next tick keeps the connection healthy.
    mockWsInstance!.simulatePong()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(2)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should NOT terminate after a single missed pong', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // First tick: sends the initial ping (alive starts false, so missed -> 1,
    // but 1 < WS_PONG_MAX_MISSED so it must not terminate).
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    // Second tick with no pong in between: one more missed, still below the cap.
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should terminate only after WS_PONG_MAX_MISSED consecutive missed pongs', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // The first tick sends the initial ping without evaluating a miss (the peer
    // had no prior opportunity to pong). From there, each subsequent silent tick
    // is one real missed pong; termination happens on the WS_PONG_MAX_MISSED-th.
    jest.advanceTimersByTime(1000) // tick 1: ping only
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    for (let i = 1; i < WS_PONG_MAX_MISSED; i++) {
      jest.advanceTimersByTime(1000)
      expect(mockWsInstance!.terminate).not.toHaveBeenCalled()
    }
    // The WS_PONG_MAX_MISSED-th consecutive miss terminates the socket.
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.terminate).toHaveBeenCalledTimes(1)

    conn.disconnect()
  })

  it('routes a heartbeat-induced terminate through onWebSocketClose (transient path)', async () => {
    // A heartbeat false-positive terminate calls ws.terminate(), which (in the
    // real ws library) fires the 'close' event -> onWebSocketClose(). This is
    // the same hook a transient ALB/network drop uses, so a misdetected drop
    // also lands in the grace path rather than the explicit-shutdown path.
    let onCloseCalls = 0
    let onDisconnectCalls = 0
    class HookCapture extends BaseWebSocketConnection<TestMessage> {
      constructor() {
        super({ maxReconnectRetries: 0, reconnectBaseDelayMs: 100, logPrefix: 'HC:', heartbeatIntervalMs: 1000 })
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
        /* no-op */
      }
      protected onWebSocketClose(): void {
        onCloseCalls++
      }
      protected onDisconnect(): void {
        onDisconnectCalls++
      }
    }

    // maxReconnectRetries: 0 makes the post-close reconnect give up; guard the
    // process.exit it would call.
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    const conn = new HookCapture()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // Drive the heartbeat to a terminate (no pongs): first tick pings, then
    // WS_PONG_MAX_MISSED real misses -> terminate.
    for (let i = 0; i <= WS_PONG_MAX_MISSED; i++) {
      jest.advanceTimersByTime(1000)
    }
    expect(mockWsInstance!.terminate).toHaveBeenCalledTimes(1)

    // The real library fires 'close' after terminate; simulate that step.
    mockWsInstance!.simulateClose()

    // The transient close hook fired; the explicit-disconnect hook did NOT.
    expect(onCloseCalls).toBe(1)
    expect(onDisconnectCalls).toBe(0)

    conn.disconnect()
    exitSpy.mockRestore()
  })

  it('should not count a phantom miss on the first tick (finding #6)', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // The peer never pongs. The first tick only SENDS the initial ping (the peer
    // had no prior chance to pong), so it must not count as a miss. Termination
    // must therefore take (1 initial-ping tick + WS_PONG_MAX_MISSED real misses)
    // ticks. RED before the fix: the phantom first-tick miss shortened this to
    // WS_PONG_MAX_MISSED ticks, terminating one full interval too early.
    let ticksUntilTerminate = 0
    while (!mockWsInstance!.terminate.mock.calls.length) {
      jest.advanceTimersByTime(1000)
      ticksUntilTerminate++
      if (ticksUntilTerminate > 10) break // safety against an infinite loop
    }

    expect(ticksUntilTerminate).toBe(WS_PONG_MAX_MISSED + 1)

    conn.disconnect()
  })

  it('should reset the missed counter when a healthy pong arrives', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // Accumulate misses just short of the cap.
    for (let i = 0; i < WS_PONG_MAX_MISSED - 1; i++) {
      jest.advanceTimersByTime(1000)
    }
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    // A pong resets the counter; the connection must survive many more ticks.
    mockWsInstance!.simulatePong()
    for (let i = 0; i < WS_PONG_MAX_MISSED - 1; i++) {
      jest.advanceTimersByTime(1000)
    }
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should not ping when readyState is not OPEN', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.readyState = MockWebSocket.CLOSED
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should catch ping errors', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    mockWsInstance!.ping.mockImplementation(() => { throw new Error('ping failed') })
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow()

    conn.disconnect()
  })

  it('should stop heartbeat after close (no ping after terminate)', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    const firstWs = mockWsInstance!
    firstWs.simulateClose()
    // close stops the heartbeat: advancing time must not ping the stale socket.
    firstWs.ping.mockClear()
    jest.advanceTimersByTime(5000)
    expect(firstWs.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should be disabled when heartbeatIntervalMs <= 0', async () => {
    const conn = new HeartbeatTestConnection(0)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    jest.advanceTimersByTime(60_000)
    expect(mockWsInstance!.ping).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should accept a pong even before the first ping is sent', async () => {
    const conn = new HeartbeatTestConnection(1000)
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    // A pong before any ping is harmless and marks the connection alive.
    expect(() => mockWsInstance!.simulatePong()).not.toThrow()
    jest.advanceTimersByTime(1000)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })

  it('should use the default ping interval when the option is omitted', async () => {
    // Covers the default WS_HEARTBEAT_INTERVAL_MS path (no heartbeatIntervalMs option).
    const conn = new TestWebSocketConnection()
    const connectPromise = conn.connect()
    mockWsInstance!.simulateOpen()
    await connectPromise

    jest.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS)
    expect(mockWsInstance!.ping).toHaveBeenCalledTimes(1)
    // A single missed pong must not terminate at the default cap (>1).
    jest.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS)
    expect(mockWsInstance!.terminate).not.toHaveBeenCalled()

    conn.disconnect()
  })
})
