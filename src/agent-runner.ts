import * as os from 'os'

import { ApiClient } from './api-client'
import { DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL, PROJECT_CODE_CLI_DIRECT, PROJECT_CODE_ENV_DEFAULT } from './constants'
import { executeCommand } from './command-executor'
import { getProjectList, loadConfig, saveConfig } from './config-manager'
import { t } from './i18n'
import { logger } from './logger'
import type { ProjectRegistration, SystemInfo } from './types'
import { getErrorMessage, validateApiUrl } from './utils'

export interface RunnerOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
}

export function getSystemInfo(): SystemInfo {
  const cpus = os.cpus()
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuUsage: cpus.length > 0 ? (os.loadavg()[0] / cpus.length) * 100 : 0,
    memoryUsage: (1 - os.freemem() / os.totalmem()) * 100,
    uptime: os.uptime(),
  }
}

export function getLocalIpAddress(): string | undefined {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return undefined
}

export function startProjectAgent(
  project: ProjectRegistration,
  agentId: string,
  options: {
    pollInterval: number
    heartbeatInterval: number
  },
): { stop: () => void } {
  const client = new ApiClient(project.apiUrl, project.token)
  const prefix = `[${project.projectCode}]`
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let processing = false

  // 1. Register
  const registerAndStart = async (): Promise<void> => {
    try {
      const result = await client.register({
        agentId,
        hostname: os.hostname(),
        os: os.platform(),
        arch: os.arch(),
        ipAddress: getLocalIpAddress(),
      })
      logger.success(t('runner.registered', { prefix, agentId: result.agentId }))
    } catch (error) {
      logger.error(t('runner.registerFailed', { prefix, message: getErrorMessage(error) }))
      return
    }

    // 2. Heartbeat loop
    const sendHeartbeat = async (): Promise<void> => {
      try {
        await client.heartbeat(agentId, getSystemInfo())
        logger.debug(`${prefix} Heartbeat sent`)
      } catch (error) {
        logger.warn(t('runner.heartbeatFailed', { prefix, message: getErrorMessage(error) }))
      }
    }

    heartbeatTimer = setInterval(() => {
      void sendHeartbeat()
    }, options.heartbeatInterval)

    void sendHeartbeat()

    // 3. Command polling loop
    const pollCommands = async (): Promise<void> => {
      if (processing) return
      processing = true

      try {
        const pending = await client.getPendingCommands()

        for (const cmd of pending) {
          logger.info(t('runner.commandReceived', { prefix, type: cmd.type, commandId: cmd.commandId }))

          try {
            const detail = await client.getCommand(cmd.commandId)
            const result = await executeCommand(detail.type, detail.payload)
            await client.submitResult(cmd.commandId, result)
            logger.info(
              t('runner.commandDone', {
                prefix,
                commandId: cmd.commandId,
                result: result.success ? 'success' : 'failed',
              }),
            )
          } catch (error) {
            const message = getErrorMessage(error)
            logger.error(
              t('runner.commandError', { prefix, commandId: cmd.commandId, message }),
            )

            try {
              await client.submitResult(cmd.commandId, {
                success: false,
                error: message,
              })
            } catch {
              logger.error(t('runner.resultSendFailed', { prefix }))
            }
          }
        }
      } catch (error) {
        logger.debug(`${prefix} Polling error: ${getErrorMessage(error)}`)
      } finally {
        processing = false
      }
    }

    pollTimer = setInterval(() => {
      void pollCommands()
    }, options.pollInterval)
  }

  registerAndStart().catch((error) => {
    logger.error(t('runner.unexpectedError', { message: getErrorMessage(error) }))
  })

  return {
    stop: () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (pollTimer) clearInterval(pollTimer)
    },
  }
}

function resolveIntervals(options: RunnerOptions): {
  pollInterval: number
  heartbeatInterval: number
} {
  return {
    pollInterval: options.pollInterval ?? DEFAULT_POLL_INTERVAL,
    heartbeatInterval: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
  }
}

export function setupShutdownHandlers(agents: { stop: () => void }[]): void {
  const shutdown = (): void => {
    logger.info(t('runner.shuttingDown'))
    agents.forEach((a) => a.stop())
    logger.success(t('runner.stopped'))
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function runSingleProject(
  project: ProjectRegistration,
  agentId: string,
  options: RunnerOptions,
): void {
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.starting'))
  const agent = startProjectAgent(project, agentId, { pollInterval, heartbeatInterval })

  logger.info(t('runner.startedSingle', { pollInterval, heartbeatInterval }))
  logger.info(t('runner.stopHint'))
  setupShutdownHandlers([agent])
}

export async function startAgent(options: RunnerOptions): Promise<void> {
  if (options.verbose) {
    logger.setVerbose(true)
  }

  const config = loadConfig()

  // Environment variable support (lowest priority)
  const envToken = process.env.AI_SUPPORT_AGENT_TOKEN
  const envApiUrl = process.env.AI_SUPPORT_AGENT_API_URL

  // CLI args > config > env vars
  if (options.token && options.apiUrl) {
    const urlError = validateApiUrl(options.apiUrl)
    if (urlError) {
      logger.error(urlError)
      process.exit(1)
    }
    logger.warn(t('runner.cliTokenWarning'))
    const agentId = config?.agentId ?? os.hostname()
    const project: ProjectRegistration = {
      projectCode: PROJECT_CODE_CLI_DIRECT,
      token: options.token,
      apiUrl: options.apiUrl,
    }

    runSingleProject(project, agentId, options)
    saveConfig({ lastConnected: new Date().toISOString() })
    return
  }

  // Multi-project config
  if (!config) {
    // Fall back to env vars if no config
    if (envToken && envApiUrl) {
      const envUrlError = validateApiUrl(envApiUrl)
      if (envUrlError) {
        logger.error(envUrlError)
        process.exit(1)
      }
      logger.info(t('runner.envTokenWarning'))
      const project: ProjectRegistration = {
        projectCode: PROJECT_CODE_ENV_DEFAULT,
        token: envToken,
        apiUrl: envApiUrl,
      }

      runSingleProject(project, os.hostname(), options)
      return
    }

    logger.error(t('runner.noToken'))
    process.exit(1)
  }

  const projects = getProjectList(config)
  if (projects.length === 0) {
    logger.error(t('runner.noProjects'))
    process.exit(1)
  }

  const agentId = config.agentId ?? os.hostname()
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.startingMulti', { count: projects.length }))

  const agents = projects.map((project) =>
    startProjectAgent(project, agentId, { pollInterval, heartbeatInterval }),
  )

  saveConfig({ lastConnected: new Date().toISOString() })

  logger.info(
    t('runner.startedMulti', { count: projects.length, pollInterval, heartbeatInterval }),
  )
  for (const p of projects) {
    logger.info(`  - ${p.projectCode} (${p.apiUrl})`)
  }
  logger.info(t('runner.stopHint'))
  setupShutdownHandlers(agents)
}
