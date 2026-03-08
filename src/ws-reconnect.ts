import { logger } from './logger'
import { calculateBackoff } from './retry-strategy'
import { getErrorMessage } from './utils'

export interface ReconnectOptions {
  maxRetries: number
  baseDelayMs: number
  logPrefix: string
  connectFn: () => Promise<void>
  onReconnectedFn?: () => void
  isClosedFn: () => boolean
}

export async function attemptReconnect(
  attemptsRef: { current: number },
  options: ReconnectOptions,
): Promise<void> {
  const { maxRetries, baseDelayMs, logPrefix, connectFn, onReconnectedFn, isClosedFn } = options

  if (isClosedFn() || attemptsRef.current >= maxRetries) {
    if (attemptsRef.current >= maxRetries) {
      logger.error(`${logPrefix} Max reconnect attempts reached`)
    }
    return
  }

  attemptsRef.current++
  const delay = calculateBackoff({ baseDelayMs, attempt: attemptsRef.current - 1, jitter: false })
  logger.info(`${logPrefix} Reconnecting in ${delay}ms (attempt ${attemptsRef.current}/${maxRetries})`)

  await new Promise<void>((resolve) => setTimeout(resolve, delay))
  if (isClosedFn()) return

  try {
    await connectFn()
    logger.info(`${logPrefix} Reconnected successfully`)
    attemptsRef.current = 0
    onReconnectedFn?.()
  } catch (error) {
    logger.warn(`${logPrefix} Reconnect failed: ${getErrorMessage(error)}`)
    void attemptReconnect(attemptsRef, options)
  }
}
