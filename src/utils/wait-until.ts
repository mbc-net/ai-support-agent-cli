/** Poll-and-deadline helpers shared by the tunnel code. */

export interface WaitUntilOptions {
  timeoutMs: number
  intervalMs: number
  /** Stop early (and fail) once this returns false — the awaited process died. */
  isAlive?: () => boolean
  deadMessage?: string
  timeoutMessage: string
}

/** Poll `check` until it returns true; fail when the process dies or time runs out. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  options: WaitUntilOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error(options.deadMessage ?? 'the process exited before it was ready')
    }
    if (await check()) return
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage)
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
}

/**
 * Reject with `message` if `promise` has not settled within `ms`.
 *
 * The underlying work cannot be cancelled, so a result that arrives after the
 * deadline is handed to `onLate` for cleanup (a stream to destroy, a tunnel to
 * close) instead of leaking; a late failure is swallowed.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new Error(message))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        if (timedOut) {
          onLate?.(value)
          return
        }
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (timedOut) return
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
