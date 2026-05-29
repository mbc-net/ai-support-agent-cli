/**
 * Tests for __tests__/helpers/mock-factory.ts
 *
 * Validates that createMockChildProcess, createFakeChildProcess,
 * waitForSpawn, and createAxiosError work correctly, including the
 * fallback `|| []` branches in emit/emitStdout/emitStderr.
 */

import { EventEmitter } from 'events'
import {
  createMockChildProcess,
  createFakeChildProcess,
  createAxiosError,
  waitForSpawn,
} from './mock-factory'

describe('createMockChildProcess', () => {
  describe('emit() with no registered handlers', () => {
    it('does not throw when emitting an event with no handlers (|| [] fallback)', () => {
      const proc = createMockChildProcess()

      // No handler registered for 'close' — should use || [] fallback and not throw
      expect(() => proc.emit('close', 0)).not.toThrow()
    })

    it('does not throw when emitting stdout event with no handlers', () => {
      const proc = createMockChildProcess()

      // No handler registered for 'data' on stdout — || [] fallback
      expect(() => proc.emitStdout('data', Buffer.from('hello'))).not.toThrow()
    })

    it('does not throw when emitting stderr event with no handlers', () => {
      const proc = createMockChildProcess()

      // No handler registered for 'error' on stderr — || [] fallback
      expect(() => proc.emitStderr('error', new Error('stderr error'))).not.toThrow()
    })
  })

  describe('emit() with registered handlers', () => {
    it('calls all registered handlers for an event', () => {
      const proc = createMockChildProcess()
      const handler1 = jest.fn()
      const handler2 = jest.fn()

      proc.on('close', handler1)
      proc.on('close', handler2)
      proc.emit('close', 42)

      expect(handler1).toHaveBeenCalledWith(42)
      expect(handler2).toHaveBeenCalledWith(42)
    })

    it('calls stdout data handlers registered via stdout.on', () => {
      const proc = createMockChildProcess()
      const handler = jest.fn()

      proc.stdout.on('data', handler)
      proc.emitStdout('data', Buffer.from('chunk'))

      expect(handler).toHaveBeenCalledWith(Buffer.from('chunk'))
    })

    it('calls stderr data handlers registered via stderr.on', () => {
      const proc = createMockChildProcess()
      const handler = jest.fn()

      proc.stderr.on('data', handler)
      proc.emitStderr('data', Buffer.from('err chunk'))

      expect(handler).toHaveBeenCalledWith(Buffer.from('err chunk'))
    })
  })

  describe('basic properties', () => {
    it('has expected pid, killed, and kill mock', () => {
      const proc = createMockChildProcess()

      expect(proc.pid).toBe(12345)
      expect(proc.killed).toBe(false)
      expect(typeof proc.kill).toBe('function')
    })

    it('kill is a jest.fn()', () => {
      const proc = createMockChildProcess()
      proc.kill()
      expect(proc.kill).toHaveBeenCalled()
    })
  })

  describe('emitStdout() and emitStderr() with multiple handlers', () => {
    it('calls all stdout handlers in order', () => {
      const proc = createMockChildProcess()
      const order: number[] = []

      proc.stdout.on('data', () => order.push(1))
      proc.stdout.on('data', () => order.push(2))
      proc.emitStdout('data', 'x')

      expect(order).toEqual([1, 2])
    })

    it('calls all stderr handlers in order', () => {
      const proc = createMockChildProcess()
      const order: number[] = []

      proc.stderr.on('data', () => order.push(1))
      proc.stderr.on('data', () => order.push(2))
      proc.emitStderr('data', 'y')

      expect(order).toEqual([1, 2])
    })
  })
})

describe('createFakeChildProcess', () => {
  it('returns an EventEmitter with stdout, stderr, and kill', () => {
    const proc = createFakeChildProcess()

    expect(proc).toBeInstanceOf(EventEmitter)
    expect(proc.stdout).toBeInstanceOf(EventEmitter)
    expect(proc.stderr).toBeInstanceOf(EventEmitter)
    expect(typeof proc.kill).toBe('function')
  })

  it('can emit events through the EventEmitter', () => {
    const proc = createFakeChildProcess()
    const handler = jest.fn()

    proc.on('close', handler)
    proc.emit('close', 0)

    expect(handler).toHaveBeenCalledWith(0)
  })

  it('kill is a jest.fn()', () => {
    const proc = createFakeChildProcess()
    proc.kill()
    expect(proc.kill).toHaveBeenCalled()
  })
})

describe('waitForSpawn', () => {
  it('resolves once the spy has been called', async () => {
    const mockSpawn = jest.fn()

    // Simulate spawn being called asynchronously
    const spawnPromise = waitForSpawn(mockSpawn as unknown as jest.SpiedFunction<typeof import('child_process').spawn>)

    // Call spawn after a short delay
    setTimeout(() => mockSpawn(), 10)

    await expect(spawnPromise).resolves.toBeUndefined()
  })

  it('resolves immediately if spawn was already called', async () => {
    const mockSpawn = jest.fn()
    mockSpawn() // already called

    await expect(
      waitForSpawn(mockSpawn as unknown as jest.SpiedFunction<typeof import('child_process').spawn>),
    ).resolves.toBeUndefined()
  })
})

describe('createAxiosError', () => {
  it('creates an error with isAxiosError=true and the given status', () => {
    const err = createAxiosError('Not Found', 404)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Not Found')
    expect(err.isAxiosError).toBe(true)
    expect(err.response.status).toBe(404)
  })

  it('creates errors with different status codes', () => {
    const err500 = createAxiosError('Server Error', 500)
    expect(err500.response.status).toBe(500)

    const err401 = createAxiosError('Unauthorized', 401)
    expect(err401.response.status).toBe(401)
  })
})
