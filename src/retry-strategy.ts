import axios from 'axios'

import { logger } from './logger'
import { sleep } from './utils'

export interface BackoffOptions {
  baseDelayMs: number
  attempt: number
  jitter?: boolean
  /**
   * Upper bound (ms) applied to the exponential base delay BEFORE jitter.
   * Omit for an uncapped backoff.
   *
   * Capping before jitter (rather than after) keeps the result a true
   * fraction of the intended ceiling and, crucially, prevents
   * `baseDelayMs * 2 ** attempt` from overflowing to Infinity at high attempt
   * counts — important for callers that retry forever (e.g. ws-reconnect with
   * maxRetries = Infinity).
   */
  maxDelayMs?: number
}

export function calculateBackoff(options: BackoffOptions): number {
  const { baseDelayMs, attempt, jitter = true, maxDelayMs } = options
  let baseDelay = baseDelayMs * Math.pow(2, attempt)
  if (maxDelayMs !== undefined) {
    baseDelay = Math.min(baseDelay, maxDelayMs)
  }
  if (!jitter) {
    return baseDelay
  }
  return Math.round(baseDelay * (0.5 + Math.random() * 0.5))
}

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
}

export class RetryStrategy {
  constructor(private readonly options: RetryOptions) {}

  shouldRetry(error: unknown): boolean {
    if (!axios.isAxiosError(error) || !error.response) {
      return true // Network error — retry
    }
    const status = error.response.status
    if (status === 408 || status === 429) {
      return true // Timeout / rate-limit — retry
    }
    if (status >= 500) {
      return true // Server error — retry
    }
    return false // Other 4xx — do not retry
  }

  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { maxRetries, baseDelayMs } = this.options
    let lastError: unknown
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (!this.shouldRetry(error)) {
          throw error
        }
        if (attempt < maxRetries - 1) {
          const delay = calculateBackoff({ baseDelayMs, attempt })
          logger.debug(`Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`)
          await sleep(delay)
        }
      }
    }
    throw lastError
  }
}
