import * as os from 'os'

import { type AutoUpdaterHandle, startAutoUpdater } from './auto-updater'
import { AGENT_VERSION, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL, PROJECT_CODE_CLI_DIRECT, PROJECT_CODE_ENV_DEFAULT, DOCKER_UPDATE_EXIT_CODE } from './constants'
import { getProjectList, loadConfig, saveConfig } from './config-manager'
import { t } from './i18n'
import { logger } from './logger'
import { ChildProcessManager } from './child-process-manager'
import { ProjectAgent } from './project-agent'
import { captureException, flushSentry, initSentry } from './sentry'
import { getSystemInfo } from './system-info'
import type { AgentChatMode, AutoUpdateConfig, ProjectRegistration, ReleaseChannel } from './types'
import { detectChannelFromVersion } from './update-checker'
import { validateApiUrl } from './utils'
import { ApiClient } from './api-client'
import { startConfigWatcher, startTokenWatcher } from './config-watcher'

export interface RunnerOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  updateChannel?: ReleaseChannel
  /**
   * Filter to a single project. Format: "tenantCode/projectCode"
   * When set, only the matching project is started.
   * Used by DockerSupervisor to spawn one container per project.
   */
  project?: string
}

export function startProjectAgent(
  project: ProjectRegistration,
  agentId: string,
  options: {
    pollInterval: number
    heartbeatInterval: number
    agentChatMode?: AgentChatMode
    defaultProjectDir?: string
  },
): { stop: () => void; client: import('./api-client').ApiClient; agent: ProjectAgent } {
  const agent = new ProjectAgent(project, agentId, options, options.agentChatMode, options.defaultProjectDir)
  agent.start()
  return {
    stop: () => agent.stop(),
    client: agent.getClient(),
    agent,
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

export type ShutdownTarget =
  | { kind: 'agents'; agents: { stop: () => void }[] }
  | { kind: 'processManager'; processManager: ChildProcessManager }

export function setupShutdownHandlers(
  target: ShutdownTarget,
  updater?: AutoUpdaterHandle,
): void {
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(t('runner.shuttingDown'))
    updater?.stop()
    if (target.kind === 'processManager') {
      await target.processManager.stopAll()
    } else {
      target.agents.forEach((a) => a.stop())
    }
    await flushSentry()
    logger.success(t('runner.stopped'))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function logMultiProjectStartup(
  projects: ProjectRegistration[],
  pollInterval: number,
  heartbeatInterval: number,
): void {
  logger.info(t('runner.startedMulti', { count: projects.length, pollInterval, heartbeatInterval }))
  for (const p of projects) {
    logger.info(`  - ${p.projectCode} (${p.apiUrl})`)
  }
  logger.info(t('runner.stopHint'))
}

function initAutoUpdater(
  options: RunnerOptions,
  config: { autoUpdate?: AutoUpdateConfig } | null | undefined,
  client: ApiClient,
  agentId: string,
  stopAllAgents: () => void | Promise<void>,
  isAnyAgentBusy?: () => Promise<boolean>,
): AutoUpdaterHandle | undefined {
  const autoUpdateConfig = resolveAutoUpdateConfig(options, config)
  if (!autoUpdateConfig.enabled) return undefined
  return startAutoUpdater(
    [client],
    autoUpdateConfig,
    stopAllAgents,
    (error) => {
      void client.heartbeat(agentId, getSystemInfo(), error).catch((err) => {
        logger.warn(`[auto-update] Failed to send error heartbeat: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    isAnyAgentBusy,
  )
}

export function resolveAutoUpdateConfig(options: RunnerOptions, config?: { autoUpdate?: AutoUpdateConfig } | null): AutoUpdateConfig {
  const detectedChannel = detectChannelFromVersion(AGENT_VERSION)
  return {
    enabled: options.autoUpdate !== false,
    autoRestart: true,
    channel: options.updateChannel ?? config?.autoUpdate?.channel ?? detectedChannel,
    ...config?.autoUpdate,
    // CLI flags override config
    ...(options.autoUpdate === false && { enabled: false }),
    ...(options.updateChannel && { channel: options.updateChannel }),
  }
}

function runSingleProject(
  project: ProjectRegistration,
  agentId: string,
  options: RunnerOptions,
  agentChatMode?: AgentChatMode,
  defaultProjectDir?: string,
  enableTokenWatcher = false,
): void {
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.starting'))
  const started = startProjectAgent(project, agentId, { pollInterval, heartbeatInterval, agentChatMode, defaultProjectDir })

  const updater = initAutoUpdater(options, undefined, started.client, agentId, () => started.stop(), async () => started.agent.isBusy())

  let tokenWatcher: { stop: () => void } | undefined
  if (enableTokenWatcher) {
    tokenWatcher = startTokenWatcher([project], (_projectCode, newToken) => {
      started.agent.updateToken(newToken)
    })
  }

  logger.info(t('runner.startedSingle', { pollInterval, heartbeatInterval }))
  logger.info(t('runner.stopHint'))

  const originalStop = started.stop
  const stopWithWatcher = (): void => {
    tokenWatcher?.stop()
    originalStop()
  }
  setupShutdownHandlers({ kind: 'agents', agents: [{ stop: stopWithWatcher }] }, updater)
}

export async function startAgent(options: RunnerOptions): Promise<void> {
  await initSentry()

  // グローバルエラーハンドラ（非同期エラーでの静かなクラッシュを防止）
  process.on('uncaughtException', (error) => {
    captureException(error, { handler: 'uncaughtException' })
    logger.error(`Uncaught exception: ${error.message}${error.stack ? `\n${error.stack}` : ''}`)
    void flushSentry().finally(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    captureException(reason, { handler: 'unhandledRejection' })
    logger.error(`Unhandled rejection: ${reason}`)
  })

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
      tenantCode: 'unknown',
      projectCode: PROJECT_CODE_CLI_DIRECT,
      token: options.token,
      apiUrl: options.apiUrl,
    }

    runSingleProject(project, agentId, options, config?.agentChatMode, config?.defaultProjectDir)
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
        tenantCode: 'unknown',
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

  let projects = getProjectList(config)
  if (projects.length === 0) {
    logger.error(t('runner.noProjects'))
    process.exit(1)
  }

  // Filter to a single project when --project flag is specified (e.g. "mbc/PROJ_A")
  if (options.project) {
    const slashIdx = options.project.indexOf('/')
    if (slashIdx < 0) {
      logger.error(`[runner] --project must be in "tenantCode/projectCode" format: ${options.project}`)
      process.exit(1)
    }
    const tenantCode = options.project.substring(0, slashIdx)
    const projectCode = options.project.substring(slashIdx + 1)
    projects = projects.filter(
      (p) => p.tenantCode === tenantCode && p.projectCode === projectCode,
    )
    if (projects.length === 0) {
      logger.error(`[runner] Project not found: ${options.project}`)
      process.exit(1)
    }
  }

  const agentId = config.agentId ?? os.hostname()
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.startingMulti', { count: projects.length }))

  const forkOptions = {
    pollInterval,
    heartbeatInterval,
    agentChatMode: config.agentChatMode,
    defaultProjectDir: config.defaultProjectDir,
    verbose: options.verbose,
  }

  // Always use ChildProcessManager for dynamic project management
  const processManager = new ChildProcessManager()

  // In Docker mode, when a worker completes an update, exit the runner with
  // DOCKER_UPDATE_EXIT_CODE so the host-side runInDocker() rebuilds the image.
  if (process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1') {
    processManager.onUpdateComplete = () => {
      logger.info('[docker] Worker update complete. Exiting container to rebuild image...')
      void processManager.stopAll().then(() => process.exit(DOCKER_UPDATE_EXIT_CODE))
    }
  }

  for (const project of projects) {
    processManager.forkProject(project, agentId, forkOptions)
  }

  saveConfig({ lastConnected: new Date().toISOString() })

  const client = new ApiClient(projects[0].apiUrl, projects[0].token)
  const updater = initAutoUpdater(options, config, client, agentId, () => processManager.stopAll(), () => processManager.isAnyBusy())

  const configWatcher = startConfigWatcher(projects, {
    onTokenUpdate: (projectCode, newToken) => {
      processManager.sendTokenUpdate(projectCode, newToken)
    },
    onProjectAdded: (project) => {
      logger.info(`Hot-adding project: ${project.projectCode}`)
      processManager.forkProject(project, agentId, forkOptions)
    },
    onProjectRemoved: (projectCode) => {
      logger.info(`Hot-removing project: ${projectCode}`)
      void processManager.stopProject(projectCode)
    },
  })

  logMultiProjectStartup(projects, pollInterval, heartbeatInterval)
  setupShutdownHandlers({ kind: 'processManager', processManager }, updater)

  // Clean up config watcher on shutdown
  const origStopAll = processManager.stopAll.bind(processManager)
  processManager.stopAll = async (timeoutMs?: number): Promise<void> => {
    configWatcher.stop()
    await origStopAll(timeoutMs)
  }
}
