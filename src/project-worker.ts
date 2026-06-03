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
  )

  agent.start()
  sendToParent({ type: 'started', tenantCode: project.tenantCode, projectCode: project.projectCode })
  logger.info(`Worker started for [${project.tenantCode}/${project.projectCode}] agentId=${agentId} (pid=${process.pid})`)
}

async function handleGracefulExit(tenantCode: string, projectCode: string, reason: 'shutdown' | 'update'): Promise<void> {
  const action = reason === 'shutdown' ? 'shutting down' : 'stopping for update'
  logger.info(`Worker ${tenantCode}/${projectCode} ${action}`)
  agent?.stop()
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
        void handleGracefulExit(currentTenantCode, currentProjectCode, 'shutdown')
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

function setupDisconnectHandler(): void {
  process.on('disconnect', () => {
    logger.warn(`Parent disconnected, worker ${currentProjectCode} exiting`)
    agent?.stop()
    process.exit(1)
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
