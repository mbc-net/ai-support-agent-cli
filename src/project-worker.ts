import { FORK_SHUTDOWN_DRAIN_TIMEOUT_MS } from './constants'
import type { ChildToParentMessage, IpcStartMessage } from './ipc-types'
import { isParentToChildMessage } from './ipc-types'
import { logger } from './logger'
import { ProjectAgent } from './project-agent'
import { captureException, flushSentry, initSentry } from './sentry'
import { toError } from './utils'

let agent: ProjectAgent | null = null
let currentTenantCode = 'unknown'
let currentProjectCode = 'unknown'

function sendToParent(msg: ChildToParentMessage): void {
  if (process.send) {
    process.send(msg)
  }
}

async function handleStart(msg: IpcStartMessage): Promise<void> {
  await initSentry()

  const { project, agentId, options } = msg

  if (options.verbose) {
    logger.setVerbose(true)
  }

  agent = new ProjectAgent(
    project,
    agentId,
    options,
    options.agentChatMode,
    options.defaultProjectDir,
    (transport) => {
      sendToParent({
        type: 'auth_rejected',
        tenantCode: project.tenantCode,
        projectCode: project.projectCode,
        transport,
      })
    },
  )

  agent.start()
  sendToParent({ type: 'started', tenantCode: project.tenantCode, projectCode: project.projectCode })
  logger.info(`Worker started for [${project.tenantCode}/${project.projectCode}] agentId=${agentId} (pid=${process.pid})`)
}

/**
 * Graceful exit requested by the parent process (a 'shutdown' or 'update' IPC
 * message). Drains any in-flight command before exiting — see
 * `ProjectAgent.shutdown` — so the parent's own force-kill timeout
 * (`CHILD_PROCESS_STOP_TIMEOUT_MS`) is the only hard deadline, and a command
 * that is still running is not abandoned mid-flight (which would let the
 * server re-assign and re-execute it elsewhere).
 *
 * `drainTimeoutMs` comes from the parent's `IpcShutdownMessage` (sent as
 * `FORK_SHUTDOWN_DRAIN_TIMEOUT_MS`, see `ChildProcessManager`); falls back to
 * that same constant here so a directly-sent message without the field (older
 * sender, or the `update` message which does not carry one) still uses a
 * budget that fits under the parent's force-kill timeout.
 */
async function handleGracefulExit(
  tenantCode: string,
  projectCode: string,
  reason: 'shutdown' | 'update',
  drainTimeoutMs?: number,
): Promise<void> {
  const action = reason === 'shutdown' ? 'shutting down' : 'stopping for update'
  logger.info(`Worker ${tenantCode}/${projectCode} ${action}`)
  await agent?.shutdown({ drainTimeoutMs: drainTimeoutMs ?? FORK_SHUTDOWN_DRAIN_TIMEOUT_MS })
  sendToParent({ type: 'stopped', tenantCode, projectCode })
  await flushSentry()
  process.exit(0)
}

// ─── Message handler ─────────────────────────────────────────────

function setupMessageHandler(): void {
  process.on('message', (msg: unknown) => {
    if (!isParentToChildMessage(msg)) return

    switch (msg.type) {
      case 'start':
        currentTenantCode = msg.project.tenantCode
        currentProjectCode = msg.project.projectCode
        handleStart(msg).catch((err) => {
          const error = toError(err)
          captureException(error)
          sendToParent({ type: 'error', tenantCode: currentTenantCode, projectCode: currentProjectCode, message: error.message })
        })
        break
      case 'shutdown':
        void handleGracefulExit(currentTenantCode, currentProjectCode, 'shutdown', msg.drainTimeoutMs)
        break
      case 'update':
        void handleGracefulExit(currentTenantCode, currentProjectCode, 'update')
        break
      case 'busy_query':
        sendToParent({
          type: 'busy_response',
          tenantCode: currentTenantCode,
          projectCode: currentProjectCode,
          busy: agent?.isBusy() ?? false,
        })
        break
      case 'token_update':
        if (agent) {
          agent.updateToken(msg.token)
        }
        break
    }
  })
}

// ─── Disconnect handler (parent crash) ───────────────────────────

/**
 * Handle an unexpected disconnect of the parent `ChildProcessManager`
 * process (e.g. it crashed).
 *
 * This is deliberately made consistent with `handleGracefulExit`'s drained
 * exit, not left as a synchronous `agent?.stop()`. The parent being gone does
 * NOT mean draining is pointless here — `ProjectAgent.shutdown()`'s two real
 * dependencies are both independent of the parent process:
 *   - `ApiClient.releaseSelf()` is a direct HTTP POST from this worker
 *     process straight to the backend API — it never routes through the
 *     parent or its IPC channel.
 *   - In-flight command execution and result submission go through this
 *     `ProjectAgent`'s own independent AppSync/WebSocket subscription,
 *     established directly by this process — not proxied through the parent.
 * The only things that genuinely need the parent to still be alive are the
 * `{type:'stopped',...}` IPC message back (harmless no-op via
 * `sendToParent()`'s existing `if (process.send)` guard when the channel is
 * already gone) and the `drainTimeoutMs` normally supplied by the parent's
 * `shutdown` message — unavailable here since there is no such message, so
 * fall back to `FORK_SHUTDOWN_DRAIN_TIMEOUT_MS`, same as `handleGracefulExit`
 * does when the field is absent. Skipping the drain here would abandon an
 * in-flight command (letting the server re-assign and re-execute it
 * elsewhere) and leave the replica slot unreleased until the slow ~90s
 * heartbeat-timeout server-side reclaim, for no actual benefit — the
 * synchronous `stop()` this replaced was based on a mistaken assumption that
 * draining depends on the parent being reachable, which it does not.
 *
 * Exit code stays 1 (this is still an abnormal/unexpected termination path —
 * only the quality of the shutdown changes, not the exit code semantics).
 */
async function handleParentDisconnect(): Promise<void> {
  logger.warn(`Parent disconnected, worker ${currentProjectCode} exiting`)
  await agent?.shutdown({ drainTimeoutMs: FORK_SHUTDOWN_DRAIN_TIMEOUT_MS })
  // Matches handleGracefulExit()'s pattern: flush any Sentry event captured
  // during this worker's lifetime (e.g. via captureException elsewhere in the
  // drain/shutdown path) before exiting, so it is not silently dropped.
  await flushSentry()
  process.exit(1)
}

function setupDisconnectHandler(): void {
  process.on('disconnect', () => {
    // `process.on('disconnect', ...)` callbacks are not natively awaited by
    // Node's event loop in a way that blocks process exit; dispatch the async
    // work the same way `setupMessageHandler()` dispatches
    // `handleGracefulExit()` (`void handleGracefulExit(...)`) so the drain
    // actually gets a chance to run to completion — the pending promise chain
    // keeps the event loop alive until `process.exit(1)` above is reached.
    void handleParentDisconnect()
  })
}

// ─── Global error handlers ──────────────────────────────────────

function setupErrorHandlers(): void {
  process.on('uncaughtException', (error) => {
    captureException(error, { handler: 'worker:uncaughtException' })
    logger.error(`Worker uncaught exception: ${error.message}`)
    void flushSentry().finally(() => process.exit(1))
  })

  process.on('unhandledRejection', (reason) => {
    captureException(reason, { handler: 'worker:unhandledRejection' })
    logger.error(`Worker unhandled rejection: ${reason}`)
  })
}

// ─── Entry point ─────────────────────────────────────────────────

export function startWorker(): void {
  setupMessageHandler()
  setupDisconnectHandler()
  setupErrorHandlers()
}

// Auto-start when loaded as a child process (not during testing)
/* istanbul ignore next */
if (require.main === module) {
  startWorker()
}
