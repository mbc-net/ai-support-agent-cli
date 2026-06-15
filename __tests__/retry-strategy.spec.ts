/**
 * Tests for src/retry-strategy.ts
 *
 * Covers calculateBackoff and RetryStrategy directly, including the jitter=false
 * branch (line 15) and all shouldRetry/withRetry paths.
 */

jest.mock('../src/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import axios from 'axios'

import { calculateBackoff, RetryStrategy } from '../src/retry-strategy'

describe('calculateBackoff', () => {
  it('returns base delay without jitter when jitter=false, attempt=0', () => {
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 0, jitter: false })
    expect(result).toBe(100)
  })

  it('returns exponentially scaled delay without jitter, attempt=1', () => {
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 1, jitter: false })
    expect(result).toBe(200)
  })

  it('returns exponentially scaled delay without jitter, attempt=2', () => {
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 2, jitter: false })
    expect(result).toBe(400)
  })

  it('returns delay without jitter for large attempt', () => {
    const result = calculateBackoff({ baseDelayMs: 50, attempt: 5, jitter: false })
    expect(result).toBe(50 * Math.pow(2, 5))
  })

  it('returns jittered delay when jitter=true (default)', () => {
    // jitter introduces randomness; result should be in range [0.5 * base, 1.0 * base]
    const baseDelay = 200 // attempt=1 → baseDelay = 200 * 2^1 = 400
    const attempt = 1
    const result = calculateBackoff({ baseDelayMs: baseDelay, attempt, jitter: true })
    const expectedBase = baseDelay * Math.pow(2, attempt) // 400
    expect(result).toBeGreaterThanOrEqual(Math.round(expectedBase * 0.5))
    expect(result).toBeLessThanOrEqual(Math.round(expectedBase * 1.0))
  })

  it('applies jitter by default (omit jitter param)', () => {
    // Default is jitter=true; result should be rounded integer
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 0 })
    // base = 100 * 2^0 = 100; range [50, 100]
    expect(result).toBeGreaterThanOrEqual(50)
    expect(result).toBeLessThanOrEqual(100)
    expect(Number.isInteger(result)).toBe(true)
  })

  it('returns deterministic value when Math.random is mocked', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5
    // base = 100 * 2^0 = 100; jitter = round(100 * (0.5 + 0.5*0.5)) = round(100 * 0.75) = 75
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 0, jitter: true })
    expect(result).toBe(75)
    Math.random = originalRandom
  })

  it('returns deterministic max when Math.random returns 1', () => {
    const originalRandom = Math.random
    Math.random = () => 1
    // base = 100; jitter = round(100 * (0.5 + 1*0.5)) = round(100 * 1.0) = 100
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 0, jitter: true })
    expect(result).toBe(100)
    Math.random = originalRandom
  })

  it('returns deterministic min when Math.random returns 0', () => {
    const originalRandom = Math.random
    Math.random = () => 0
    // base = 100; jitter = round(100 * 0.5) = 50
    const result = calculateBackoff({ baseDelayMs: 100, attempt: 0, jitter: true })
    expect(result).toBe(50)
    Math.random = originalRandom
  })

  describe('maxDelayMs cap', () => {
    it('caps the base delay before jitter when jitter=false', () => {
      // base = 100 * 2^5 = 3200, capped to 500
      const result = calculateBackoff({ baseDelayMs: 100, attempt: 5, jitter: false, maxDelayMs: 500 })
      expect(result).toBe(500)
    })

    it('does not cap when base delay is below maxDelayMs (jitter=false)', () => {
      // base = 100 * 2^1 = 200, below cap of 500
      const result = calculateBackoff({ baseDelayMs: 100, attempt: 1, jitter: false, maxDelayMs: 500 })
      expect(result).toBe(200)
    })

    it('applies cap before jitter, so jittered result stays within [0.5*cap, cap]', () => {
      const originalRandom = Math.random
      Math.random = () => 1
      // base = 100 * 2^10 = 102400, capped to 1000; jitter = round(1000 * 1.0) = 1000
      const result = calculateBackoff({ baseDelayMs: 100, attempt: 10, jitter: true, maxDelayMs: 1000 })
      expect(result).toBe(1000)
      Math.random = originalRandom
    })

    it('jittered floor is half the cap when Math.random returns 0', () => {
      const originalRandom = Math.random
      Math.random = () => 0
      // base capped to 1000; jitter = round(1000 * 0.5) = 500
      const result = calculateBackoff({ baseDelayMs: 100, attempt: 10, jitter: true, maxDelayMs: 1000 })
      expect(result).toBe(500)
      Math.random = originalRandom
    })

    it('prevents Infinity overflow for very large attempt counts', () => {
      // base = 1000 * 2^2000 overflows to Infinity; cap keeps it finite
      const result = calculateBackoff({ baseDelayMs: 1000, attempt: 2000, jitter: false, maxDelayMs: 60_000 })
      expect(result).toBe(60_000)
      expect(Number.isFinite(result)).toBe(true)
    })
  })
})

describe('RetryStrategy.shouldRetry', () => {
  let strategy: RetryStrategy

  beforeEach(() => {
    strategy = new RetryStrategy({ maxRetries: 3, baseDelayMs: 10 })
  })

  it('returns true for non-Axios errors (network errors)', () => {
    expect(strategy.shouldRetry(new Error('network error'))).toBe(true)
  })

  it('returns true for plain objects (non-Axios)', () => {
    expect(strategy.shouldRetry({ message: 'some error' })).toBe(true)
  })

  it('returns true for undefined', () => {
    expect(strategy.shouldRetry(undefined)).toBe(true)
  })

  it('returns true for Axios error without response (network failure)', () => {
    const error = new Error('Network Error')
    Object.assign(error, { isAxiosError: true })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    // no .response property → retry
    expect(strategy.shouldRetry(error)).toBe(true)
  })

  it('returns true for HTTP 408 (Request Timeout)', () => {
    const error = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      response: { status: 408 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(true)
  })

  it('returns true for HTTP 429 (Too Many Requests)', () => {
    const error = Object.assign(new Error('rate limit'), {
      isAxiosError: true,
      response: { status: 429 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(true)
  })

  it('returns true for HTTP 500 (Internal Server Error)', () => {
    const error = Object.assign(new Error('server error'), {
      isAxiosError: true,
      response: { status: 500 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(true)
  })

  it('returns true for HTTP 503 (Service Unavailable)', () => {
    const error = Object.assign(new Error('service unavailable'), {
      isAxiosError: true,
      response: { status: 503 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(true)
  })

  it('returns false for HTTP 400 (Bad Request)', () => {
    const error = Object.assign(new Error('bad request'), {
      isAxiosError: true,
      response: { status: 400 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(false)
  })

  it('returns false for HTTP 401 (Unauthorized)', () => {
    const error = Object.assign(new Error('unauthorized'), {
      isAxiosError: true,
      response: { status: 401 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(false)
  })

  it('returns false for HTTP 404 (Not Found)', () => {
    const error = Object.assign(new Error('not found'), {
      isAxiosError: true,
      response: { status: 404 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(false)
  })

  it('returns false for HTTP 422 (Unprocessable Entity)', () => {
    const error = Object.assign(new Error('unprocessable'), {
      isAxiosError: true,
      response: { status: 422 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValueOnce(true)
    expect(strategy.shouldRetry(error)).toBe(false)
  })
})

describe('RetryStrategy.withRetry', () => {
  let strategy: RetryStrategy

  beforeEach(() => {
    strategy = new RetryStrategy({ maxRetries: 3, baseDelayMs: 1 })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns result on first successful call', async () => {
    const fn = jest.fn().mockResolvedValue('success')
    const result = await strategy.withRetry(fn)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries and succeeds on second attempt after network error', async () => {
    const networkError = new Error('Network Error')
    const fn = jest.fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce('success')

    const result = await strategy.withRetry(fn)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries up to maxRetries times before throwing', async () => {
    const networkError = new Error('persistent network error')
    const fn = jest.fn().mockRejectedValue(networkError)

    await expect(strategy.withRetry(fn)).rejects.toThrow('persistent network error')
    expect(fn).toHaveBeenCalledTimes(3) // maxRetries = 3
  }, 10000)

  it('does not retry on non-retryable 4xx error', async () => {
    const badRequest = Object.assign(new Error('bad request'), {
      isAxiosError: true,
      response: { status: 400 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    const fn = jest.fn().mockRejectedValue(badRequest)

    await expect(strategy.withRetry(fn)).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 500 server error and eventually throws', async () => {
    const serverError = Object.assign(new Error('server error'), {
      isAxiosError: true,
      response: { status: 500 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    const fn = jest.fn().mockRejectedValue(serverError)

    await expect(strategy.withRetry(fn)).rejects.toThrow('server error')
    expect(fn).toHaveBeenCalledTimes(3)
  }, 10000)

  it('retries on 429 rate limit error and succeeds', async () => {
    const rateLimitError = Object.assign(new Error('rate limited'), {
      isAxiosError: true,
      response: { status: 429 },
    })
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true)
    const fn = jest.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce('ok after rate limit')

    const result = await strategy.withRetry(fn)
    expect(result).toBe('ok after rate limit')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('logs debug message on retry', async () => {
    const { logger } = require('../src/logger')
    const networkError = new Error('flaky')
    const fn = jest.fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce('done')

    await strategy.withRetry(fn)
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('retrying in'))
  })

  it('does not schedule a delay after the last attempt', async () => {
    // maxRetries=2: attempt 0 delays, attempt 1 does not
    const twoTryStrategy = new RetryStrategy({ maxRetries: 2, baseDelayMs: 1 })
    const delays: number[] = []
    const origSetTimeout = global.setTimeout
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: unknown, delay?: number) => {
      if (typeof delay === 'number' && delay > 0) {
        delays.push(delay)
      }
      return origSetTimeout(fn as () => void, 0)
    })

    const networkError = new Error('two-attempt failure')
    const mockFn = jest.fn().mockRejectedValue(networkError)

    await expect(twoTryStrategy.withRetry(mockFn)).rejects.toThrow('two-attempt failure')
    // maxRetries=2: delay only between attempt 0 and 1 (not after attempt 1)
    expect(delays.length).toBe(1)
    expect(mockFn).toHaveBeenCalledTimes(2)
  })

  it('uses maxRetries=1 (no retries after first failure)', async () => {
    const singleTryStrategy = new RetryStrategy({ maxRetries: 1, baseDelayMs: 1 })
    const fn = jest.fn().mockRejectedValue(new Error('fail immediately'))

    await expect(singleTryStrategy.withRetry(fn)).rejects.toThrow('fail immediately')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
