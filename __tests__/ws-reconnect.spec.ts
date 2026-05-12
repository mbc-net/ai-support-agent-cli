import { attemptReconnect, ReconnectOptions } from '../src/ws-reconnect'

jest.mock('../src/logger')

describe('attemptReconnect', () => {
  let randomSpy: jest.SpyInstance<number, []>

  beforeEach(() => {
    jest.useFakeTimers()
    // Lock jitter (±50% factor) to 1.0 so delays remain equal to base * 2^attempt.
    randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    jest.useRealTimers()
    randomSpy.mockRestore()
  })

  function buildOptions(overrides: Partial<ReconnectOptions> = {}): ReconnectOptions {
    return {
      maxRetries: 3,
      baseDelayMs: 1000,
      logPrefix: '[test]',
      connectFn: jest.fn().mockResolvedValue(undefined),
      isClosedFn: jest.fn().mockReturnValue(false),
      onMaxRetriesExceeded: jest.fn(),
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
    const onMaxRetriesExceeded = jest.fn()
    const attemptsRef = { current: 0 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: 2,
      onMaxRetriesExceeded,
    }))

    // First attempt: delay = 1000ms
    await jest.advanceTimersByTimeAsync(1000)
    // Second attempt: delay = 2000ms
    await jest.advanceTimersByTimeAsync(2000)

    await promise

    expect(connectFn).toHaveBeenCalledTimes(2)
    expect(attemptsRef.current).toBe(2)
    expect(onMaxRetriesExceeded).toHaveBeenCalledTimes(1)
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
    const onMaxRetriesExceeded = jest.fn()
    const attemptsRef = { current: 3 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: 3,
      onMaxRetriesExceeded,
    }))

    await promise

    expect(connectFn).not.toHaveBeenCalled()
    expect(onMaxRetriesExceeded).toHaveBeenCalledTimes(1)
  })

  it('should call process.exit(1) by default when max retries exceeded', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const connectFn = jest.fn()
    const attemptsRef = { current: 3 }

    const options: ReconnectOptions = {
      maxRetries: 3,
      baseDelayMs: 1000,
      logPrefix: '[test]',
      connectFn,
      isClosedFn: jest.fn().mockReturnValue(false),
    }

    await attemptReconnect(attemptsRef, options)

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
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

    // With Math.random pinned to 0.5, jitter factor is (0.5 + 0.5*0.5) = 0.75
    // so attempt=0 with baseDelayMs=500 yields a 375ms delay.
    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      baseDelayMs: 500,
    }))

    // Not yet at 300ms.
    await jest.advanceTimersByTimeAsync(300)
    expect(connectFn).not.toHaveBeenCalled()

    // Connects by 400ms (jittered to 375ms).
    await jest.advanceTimersByTimeAsync(100)
    await promise

    expect(connectFn).toHaveBeenCalledTimes(1)
  })

  it('should respect maxDelayMs cap', async () => {
    const connectFn = jest.fn().mockResolvedValue(undefined)
    // attempt=10 would normally back off 1024s, but the cap should clamp it to 60s.
    const attemptsRef = { current: 10 }

    const promise = attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      maxRetries: 20,
    }))

    await jest.advanceTimersByTimeAsync(59_000)
    expect(connectFn).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(1_000)
    await promise
    expect(connectFn).toHaveBeenCalledTimes(1)
  })

  it('should retry indefinitely when maxRetries is Infinity', async () => {
    const connectFn = jest.fn().mockRejectedValue(new Error('fail'))
    const onMaxRetriesExceeded = jest.fn()
    const attemptsRef = { current: 0 }

    void attemptReconnect(attemptsRef, buildOptions({
      connectFn,
      maxRetries: Number.POSITIVE_INFINITY,
      maxDelayMs: 60_000,
      onMaxRetriesExceeded,
    }))

    // Drive enough wall-clock to exceed the original 5-attempt limit.
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(60_000)
    }
    expect(onMaxRetriesExceeded).not.toHaveBeenCalled()
    expect(connectFn.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})
