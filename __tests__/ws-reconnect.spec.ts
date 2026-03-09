import { attemptReconnect, ReconnectOptions } from '../src/ws-reconnect'

jest.mock('../src/logger')

describe('attemptReconnect', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function buildOptions(overrides: Partial<ReconnectOptions> = {}): ReconnectOptions {
    return {
      maxRetries: 3,
      baseDelayMs: 1000,
      logPrefix: '[test]',
      connectFn: jest.fn().mockResolvedValue(undefined),
      isClosedFn: jest.fn().mockReturnValue(false),
      ...overrides,
    }
  }

  it('should reconnect successfully on first attempt', async () => {
    const connectFn = jest.fn().mockResolvedValue(undefined)
    const onReconnectedFn = jest.fn()
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({ connectFn, onReconnectedFn }))

    // Advance past first delay (1000ms * 2^0 = 1000ms)
    await jest.advanceTimersByTimeAsync(1000)

    await promise

    expect(connectFn).toHaveBeenCalledTimes(1)
    expect(onReconnectedFn).toHaveBeenCalledTimes(1)
    expect(attemptsRef.current).toBe(0)
  })

  it('should retry with exponential backoff on failure', async () => {
    const connectFn = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined)
    const onReconnectedFn = jest.fn()
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({ connectFn, onReconnectedFn }))

    // First attempt: delay = 1000ms * 2^0 = 1000ms
    await jest.advanceTimersByTimeAsync(1000)
    // connectFn fails, recursive call: delay = 1000ms * 2^1 = 2000ms
    await jest.advanceTimersByTimeAsync(2000)
    // connectFn fails again, recursive call: delay = 1000ms * 2^2 = 4000ms
    await jest.advanceTimersByTimeAsync(4000)

    await promise

    expect(connectFn).toHaveBeenCalledTimes(3)
    expect(onReconnectedFn).toHaveBeenCalledTimes(1)
    expect(attemptsRef.current).toBe(0)
  })

  it('should stop after max retries', async () => {
    const connectFn = jest.fn().mockRejectedValue(new Error('fail'))
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: 2,
    }))

    // First attempt: delay = 1000ms
    await jest.advanceTimersByTimeAsync(1000)
    // Second attempt: delay = 2000ms
    await jest.advanceTimersByTimeAsync(2000)

    await promise

    expect(connectFn).toHaveBeenCalledTimes(2)
    expect(attemptsRef.current).toBe(2)
  })

  it('should not reconnect when already closed', async () => {
    const connectFn = jest.fn()
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      isClosedFn: () => true,
    }))

    await promise

    expect(connectFn).not.toHaveBeenCalled()
  })

  it('should not reconnect when max retries already reached', async () => {
    const connectFn = jest.fn()
    const attemptsRef = { current: 3 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: 3,
    }))

    await promise

    expect(connectFn).not.toHaveBeenCalled()
  })

  it('should abort if closed during delay', async () => {
    const connectFn = jest.fn()
    let closed = false
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      isClosedFn: () => closed,
    }))

    // Close during the delay
    closed = true
    await jest.advanceTimersByTimeAsync(1000)

    await promise

    expect(connectFn).not.toHaveBeenCalled()
  })

  it('should work without onReconnectedFn', async () => {
    const connectFn = jest.fn().mockResolvedValue(undefined)
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      onReconnectedFn: undefined,
    }))

    await jest.advanceTimersByTimeAsync(1000)

    await promise

    expect(connectFn).toHaveBeenCalledTimes(1)
    expect(attemptsRef.current).toBe(0)
  })

  it('should increment attempts correctly', async () => {
    const connectFn = jest.fn().mockRejectedValue(new Error('fail'))
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: 1,
    }))

    await jest.advanceTimersByTimeAsync(1000)

    await promise

    expect(attemptsRef.current).toBe(1)
  })

  it('should use custom baseDelayMs', async () => {
    const connectFn = jest.fn().mockResolvedValue(undefined)
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      baseDelayMs: 500,
    }))

    // Should not have connected yet at 400ms
    await jest.advanceTimersByTimeAsync(400)
    expect(connectFn).not.toHaveBeenCalled()

    // Should connect at 500ms
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(connectFn).toHaveBeenCalledTimes(1)
  })
})
