import * as os from 'os'

import { type AutoUpdaterHandle, startAutoUpdater } from './auto-updater'
import { AGENT_VERSION, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL, PROJECT_CODE_CLI_DIRECT, PROJECT_CODE_ENV_DEFAULT } from './constants'
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
import { startTokenWatcher } from './token-watcher'

export interface RunnerOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  updateChannel?: ReleaseChannel
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
  stopAllAgents: () => void,
): AutoUpdaterHandle | undefined {
  const autoUpdateConfig = resolveAutoUpdateConfig(options, config)
  if (!autoUpdateConfig.enabled) return undefined
  return startAutoUpdater(
    [client],
    autoUpdateConfig,
    stopAllAgents,
    (error) => {
      void client.heartbeat(agentId, getSystemInfo(), error).catch(() => {})
    },
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

  const updater = initAutoUpdater(options, undefined, started.client, agentId, () => started.stop())

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

  if (projects.length === 1) {
    // Single project: run in-process (no fork overhead)
    const started = startProjectAgent(projects[0], agentId, { pollInterval, heartbeatInterval, agentChatMode: config.agentChatMode, defaultProjectDir: config.defaultProjectDir })
    saveConfig({ lastConnected: new Date().toISOString() })

    const updater = initAutoUpdater(options, config, started.client, agentId, () => started.stop())

    const tokenWatcher = startTokenWatcher(projects, (_projectCode, newToken) => {
      started.agent.updateToken(newToken)
    })

    logMultiProjectStartup(projects, pollInterval, heartbeatInterval)
    const originalStop = started.stop
    const stopWithWatcher = (): void => {
      tokenWatcher.stop()
      originalStop()
    }
    setupShutdownHandlers({ kind: 'agents', agents: [{ stop: stopWithWatcher }] }, updater)
    return
  }

  // Multiple projects: fork child processes for isolation
  const processManager = new ChildProcessManager()
  for (const project of projects) {
    processManager.forkProject(project, agentId, {
      pollInterval,
      heartbeatInterval,
      agentChatMode: config.agentChatMode,
      defaultProjectDir: config.defaultProjectDir,
    })
  }

  saveConfig({ lastConnected: new Date().toISOString() })

  const client = new ApiClient(projects[0].apiUrl, projects[0].token)
  const updater = initAutoUpdater(options, config, client, agentId, () => processManager.sendUpdateToAll())

  const tokenWatcher = startTokenWatcher(projects, (projectCode, newToken) => {
    processManager.sendTokenUpdate(projectCode, newToken)
  })

  logMultiProjectStartup(projects, pollInterval, heartbeatInterval)
  setupShutdownHandlers({ kind: 'processManager', processManager }, updater)

  // Clean up token watcher on shutdown
  const origStopAll = processManager.stopAll.bind(processManager)
  processManager.stopAll = async (timeoutMs?: number): Promise<void> => {
    tokenWatcher.stop()
    await origStopAll(timeoutMs)
  }
}
