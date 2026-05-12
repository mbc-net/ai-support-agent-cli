import { logger } from './logger'
import { calculateBackoff } from './retry-strategy'
import { getErrorMessage } from './utils'

export interface ReconnectOptions {
  maxRetries: number
  baseDelayMs: number
  /** Backoff delay 上限 (ms)。省略時は cap なし。 */
  maxDelayMs?: number
  logPrefix: string
  connectFn: () => Promise<void>
  onReconnectedFn?: () => void
  isClosedFn: () => boolean
  /** Max retries 到達時の処理。デフォルト: process.exit(1) */
  onMaxRetriesExceeded?: () => void
}

export async function attemptReconnect(
  attemptsRef: { current: number },
  options: ReconnectOptions,
): Promise<void> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    logPrefix,
    connectFn,
    onReconnectedFn,
    isClosedFn,
    onMaxRetriesExceeded = () => process.exit(1),
  } = options

  if (isClosedFn()) return

  if (attemptsRef.current >= maxRetries) {
    logger.error(`${logPrefix} Max reconnect attempts reached. Exiting for process restart...`)
    onMaxRetriesExceeded()
    return
  }

  attemptsRef.current++
  let delay = calculateBackoff({ baseDelayMs, attempt: attemptsRef.current - 1, jitter: true })
  if (maxDelayMs !== undefined) {
    delay = Math.min(delay, maxDelayMs)
  }
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
