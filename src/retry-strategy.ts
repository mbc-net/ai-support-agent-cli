import axios from 'axios'

import { logger } from './logger'

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
          const baseDelay = baseDelayMs * Math.pow(2, attempt)
          const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5))
          logger.debug(`Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }
    throw lastError
  }
}
