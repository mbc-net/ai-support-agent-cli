import * as os from 'os'

import { type AutoUpdaterHandle, startAutoUpdater } from './auto-updater'
import { AGENT_VERSION, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL, PROJECT_CODE_CLI_DIRECT, PROJECT_CODE_ENV_DEFAULT } from './constants'
import { getProjectList, loadConfig, saveConfig } from './config-manager'
import { t } from './i18n'
import { logger } from './logger'
import { ProjectAgent } from './project-agent'
import { getSystemInfo } from './system-info'
import type { AgentChatMode, AutoUpdateConfig, ProjectRegistration, ReleaseChannel } from './types'
import { detectChannelFromVersion } from './update-checker'
import { validateApiUrl } from './utils'

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
): { stop: () => void; client: import('./api-client').ApiClient } {
  const agent = new ProjectAgent(project, agentId, options, undefined, options.agentChatMode, options.defaultProjectDir)
  agent.start()
  return {
    stop: () => agent.stop(),
    client: agent.getClient(),
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

export function setupShutdownHandlers(
  agents: { stop: () => void }[],
  updater?: AutoUpdaterHandle,
): void {
  const shutdown = (): void => {
    logger.info(t('runner.shuttingDown'))
    updater?.stop()
    agents.forEach((a) => a.stop())
    logger.success(t('runner.stopped'))
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
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
): void {
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.starting'))
  const agent = startProjectAgent(project, agentId, { pollInterval, heartbeatInterval, agentChatMode, defaultProjectDir })

  const autoUpdateConfig = resolveAutoUpdateConfig(options)
  let updater: AutoUpdaterHandle | undefined
  if (autoUpdateConfig.enabled) {
    updater = startAutoUpdater(
      [agent.client],
      autoUpdateConfig,
      () => agent.stop(),
      (error) => {
        void agent.client.heartbeat(agentId, getSystemInfo(), error).catch(() => {})
      },
    )
  }

  logger.info(t('runner.startedSingle', { pollInterval, heartbeatInterval }))
  logger.info(t('runner.stopHint'))
  setupShutdownHandlers([agent], updater)
}

export async function startAgent(options: RunnerOptions): Promise<void> {
  // グローバルエラーハンドラ（非同期エラーでの静かなクラッシュを防止）
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}${error.stack ? `\n${error.stack}` : ''}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
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

  const agents = projects.map((project) =>
    startProjectAgent(project, agentId, { pollInterval, heartbeatInterval, agentChatMode: config.agentChatMode, defaultProjectDir: config.defaultProjectDir }),
  )

  saveConfig({ lastConnected: new Date().toISOString() })

  const autoUpdateConfig = resolveAutoUpdateConfig(options, config)
  let updater: AutoUpdaterHandle | undefined
  if (autoUpdateConfig.enabled) {
    const clients = agents.map((a) => a.client)
    updater = startAutoUpdater(
      clients,
      autoUpdateConfig,
      () => agents.forEach((a) => a.stop()),
      (error) => {
        void agents[0]?.client.heartbeat(agentId, getSystemInfo(), error).catch(() => {})
      },
    )
  }

  logger.info(
    t('runner.startedMulti', { count: projects.length, pollInterval, heartbeatInterval }),
  )
  for (const p of projects) {
    logger.info(`  - ${p.projectCode} (${p.apiUrl})`)
  }
  logger.info(t('runner.stopHint'))
  setupShutdownHandlers(agents, updater)
}
