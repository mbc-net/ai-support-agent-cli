import { logger } from '../logger'
import { getErrorMessage } from '../utils'

/**
 * "Closes once, and tells every listener — including one registered after the
 * fact."
 *
 * Tunnels, relays and subprocess wrappers all need this, and getting the late
 * registration wrong is not cosmetic: a tunnel that dropped before its owner
 * subscribed would never end the RDP session, leaving it half-open with its
 * relay port still listening.
 */

export interface ClosedSignal {
  readonly isClosed: boolean
  /** The reason given to the first `close()`, or `null` while open. */
  readonly reason: string | null
  /** Close with `reason`. Returns `true` only for the call that closed it. */
  close(reason: string): boolean
  /**
   * Called once with the reason. A listener registered after closing is
   * called on a microtask — never synchronously, so the registering caller's
   * own state is settled before it runs.
   */
  onClosed(listener: (reason: string) => void): void
}

/**
 * Call one listener, containing whatever it throws: one bad listener must not
 * keep the others (e.g. the one that ends the RDP session) from running.
 */
function notify(listener: (reason: string) => void, reason: string): void {
  try {
    listener(reason)
  } catch (error) {
    logger.warn(`[closed-signal] A close listener threw: ${getErrorMessage(error)}`)
  }
}

export function createClosedSignal(): ClosedSignal {
  let reason: string | null = null
  const listeners: ((reason: string) => void)[] = []

  return {
    get isClosed() {
      return reason !== null
    },
    get reason() {
      return reason
    },
    close(value: string): boolean {
      if (reason !== null) return false
      reason = value
      for (const listener of listeners.splice(0)) notify(listener, value)
      return true
    },
    onClosed(listener: (reason: string) => void): void {
      if (reason !== null) {
        const value = reason
        queueMicrotask(() => notify(listener, value))
        return
      }
      listeners.push(listener)
    },
  }
}
