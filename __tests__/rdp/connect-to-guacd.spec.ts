import { EventEmitter } from 'events'
import * as net from 'net'

import {
  connectToGuacd,
  DEFAULT_GUACD_PORT,
  GUACD_CONNECT_TIMEOUT_MS,
} from '../../src/rdp/guacd-tcp-socket'

jest.mock('net', () => ({
  createConnection: jest.fn(),
}))

/**
 * Opening the guacd connection.
 *
 * The connect-time error listener must be removed once the socket is handed to
 * the relay: leaving it attached means a mid-session `error` would reject an
 * already-resolved promise (a no-op) instead of reaching the relay's own error
 * handling, so the session would hang until something else noticed.
 */

class FakeNetSocket extends EventEmitter {
  destroyed = false
  setEncoding(): this {
    return this
  }
  write(): boolean {
    return true
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
}

const createConnection = net.createConnection as unknown as jest.Mock

function arrange(): FakeNetSocket {
  const socket = new FakeNetSocket()
  createConnection.mockReturnValue(socket)
  return socket
}

beforeEach(() => {
  createConnection.mockReset()
})

describe('connectToGuacd', () => {
  it('connects to the given host and port', async () => {
    const socket = arrange()
    const promise = connectToGuacd('guacd', 4822)
    socket.emit('connect')
    await promise
    expect(createConnection).toHaveBeenCalledWith({
      host: 'guacd',
      port: 4822,
    })
  })

  it('defaults to the guacd port', async () => {
    const socket = arrange()
    const promise = connectToGuacd('guacd')
    socket.emit('connect')
    await promise
    expect(createConnection).toHaveBeenCalledWith({
      host: 'guacd',
      port: DEFAULT_GUACD_PORT,
    })
  })

  it('resolves with a usable GuacdSocket', async () => {
    const socket = arrange()
    const promise = connectToGuacd('guacd')
    socket.emit('connect')
    const guacd = await promise
    expect(typeof guacd.write).toBe('function')
    expect(typeof guacd.destroy).toBe('function')
  })

  it('rejects when the connection fails, and destroys the socket', async () => {
    const socket = arrange()
    const promise = connectToGuacd('guacd', 4822)
    socket.emit('error', new Error('ECONNREFUSED'))
    await expect(promise).rejects.toThrow(/guacd at guacd:4822/)
    expect(socket.destroyed).toBe(true)
  })

  it('★ gives up on a blackholed address instead of waiting for the OS', async () => {
    // guacd はループバックかサイドカーに居るので接続はミリ秒で終わる。SYN に
    // 応答が返らない相手だと Node は OS の TCP タイムアウト（Linux で数分）まで
    // 待つ。上限が無いと、ブラウザが諦めたあとも raw socket と保留中の open が
    // 残り続ける（RdpSession は connect() が決着してからしか closed を見られない）。
    jest.useFakeTimers()
    try {
      const socket = arrange()
      const promise = connectToGuacd('blackhole', 4822, 50)
      const settled = promise.catch((error: unknown) => (error as Error).message)

      jest.advanceTimersByTime(50)

      await expect(settled).resolves.toMatch(/timed out after 50ms/)
      expect(socket.destroyed).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('接続が成立したらタイムアウトは発火しない', async () => {
    jest.useFakeTimers()
    try {
      const socket = arrange()
      const promise = connectToGuacd('guacd', 4822, 50)
      socket.emit('connect')
      await promise

      jest.advanceTimersByTime(1000)
      expect(socket.destroyed).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('既定のタイムアウトを持つ（上限なしにしない）', () => {
    expect(GUACD_CONNECT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GUACD_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('★ stops treating errors as connect failures once connected', async () => {
    const socket = arrange()
    const promise = connectToGuacd('guacd')
    socket.emit('connect')
    const guacd = await promise

    const errors: Error[] = []
    guacd.onError((error) => errors.push(error))
    socket.emit('error', new Error('ECONNRESET'))

    // Reaches the relay's handler, and the socket is not destroyed behind its back.
    expect(errors.map((e) => e.message)).toEqual(['ECONNRESET'])
    expect(socket.destroyed).toBe(false)
  })
})
