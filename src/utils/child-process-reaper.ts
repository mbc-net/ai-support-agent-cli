import type { ChildProcess } from 'child_process'

/**
 * Keep helper subprocesses (tailscaled, `tailscale nc`, the SSM
 * session-manager-plugin) from outliving the agent.
 *
 * They are spawned without `detached`, so they share the agent's process
 * group — but that alone does not end them when the agent exits: they are
 * re-parented and keep running (and keep a tailnet node or an SSM session
 * open). On process `exit` every tracked child still alive gets SIGKILL.
 *
 * Limits: nothing in-process runs when the agent itself is SIGKILLed. In the
 * container forms that case is covered by the container ending (every process
 * in it goes with it); on a host install a supervisor that signals the whole
 * process group covers it.
 */

const live = new Set<ChildProcess>()
let hookRegistered = false

/** Track `child` until it exits. Returns `child` for chaining. */
export function trackChildProcess<T extends ChildProcess>(child: T): T {
  // A spawn failure has no pid and never runs: nothing to reap.
  if (child.pid === undefined) return child
  live.add(child)
  child.once('exit', () => live.delete(child))
  if (!hookRegistered) {
    hookRegistered = true
    process.once('exit', killTrackedChildProcesses)
  }
  return child
}

/** SIGKILL every tracked child. Synchronous, so it can run in an `exit` handler. */
export function killTrackedChildProcesses(): void {
  for (const child of [...live]) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone; keep going for the others.
    }
  }
}

/** Number of tracked children still running. */
export function trackedChildProcessCount(): number {
  return live.size
}
