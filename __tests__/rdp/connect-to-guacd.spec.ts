import { EventEmitter } from 'events'
import * as net from 'net'

import {
  connectToGuacd,
  DEFAULT_GUACD_PORT,
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
