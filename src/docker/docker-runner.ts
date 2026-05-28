/**
 * Docker runner — main entry point for Docker-based execution
 *
 * Orchestrates Docker availability check, image build, and container supervision.
 * Supports both legacy single-container mode and per-project supervisor mode.
 */

import { spawn } from 'child_process'
import * as os from 'os'

import { ApiClient } from '../api-client'
import { type AutoUpdaterHandle, startAutoUpdater } from '../auto-updater'
import { validateUpdateChannel } from '../cli/validators'
import { AGENT_VERSION, DOCKER_UPDATE_EXIT_CODE } from '../constants'
import { getProjectList, loadConfig } from '../config-manager'
import { getSystemInfo } from '../system-info'
import type { AutoUpdateConfig, ReleaseChannel } from '../types'
import { detectChannelFromVersion } from '../update-checker'
import { writePidFile, isAlreadyRunning, readPidFile } from '../pid-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { getErrorMessage } from '../utils'
import { IMAGE_NAME, checkDockerAvailable, getDockerPath } from './docker-utils'
import { ensureImage } from './version-manager'
import { syncDockerfileToConfigDir } from './dockerfile-sync'
import { buildVolumeMounts, buildEnvArgs } from './volume-mount-builder'
import { DockerSupervisor } from './docker-supervisor'
import { installUpdateAndRestart } from './update-handler'

export interface DockerRunOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  updateChannel?: string
  dockerfile?: string
  dockerfileSync?: boolean
  /**
   * Filter to a single project. Format: "tenantCode/projectCode"
   * When set, only the matching project is started.
   */
  project?: string
  /** Agent ID for log streaming */
  agentId?: string
  /** Timeout in ms before forcing exit during shutdown (default 10000). Used for testing. */
  shutdownTimeoutMs?: number
}

export function buildContainerArgs(opts: DockerRunOptions): string[] {
  const args: string[] = ['ai-support-agent', 'start', '--no-docker']

  if (opts.token) {
    args.push('--token', opts.token)
  }
  if (opts.apiUrl) {
    args.push('--api-url', opts.apiUrl)
  }
  if (opts.pollInterval !== undefined) {
    args.push('--poll-interval', String(opts.pollInterval))
  }
  if (opts.heartbeatInterval !== undefined) {
    args.push('--heartbeat-interval', String(opts.heartbeatInterval))
  }
  if (opts.verbose) {
    args.push('--verbose')
  }
  if (opts.autoUpdate === false) {
    args.push('--no-auto-update')
  }
  if (opts.updateChannel) {
    args.push('--update-channel', opts.updateChannel)
  }
  if (opts.project) {
    args.push('--project', opts.project)
  }

  return args
}

let isDockerRunning = false

/** Reset the running flag (for testing). */
export function resetIsDockerRunning(): void {
  isDockerRunning = false
}

/**
 * Start the auto-updater on the host process (outside the Docker container).
 *
 * Returns the handle so callers can stop it during shutdown. Returns undefined
 * when auto-update is disabled or no project is available to provide an API
 * client.
 */
/**
 * Resolve the effective auto-update config for the host-side updater.
 *
 * Mirrors resolveAutoUpdateConfig() from agent-runner.ts but is duplicated
 * here intentionally: importing it from agent-runner would pull in
 * project-agent → repo-sync at module load time, which breaks existing tests
 * that don't mock those dependencies.
 */
function resolveHostAutoUpdateConfig(
  opts: DockerRunOptions,
  config: ReturnType<typeof loadConfig>,
): AutoUpdateConfig {
  // DockerRunOptions.updateChannel is a free-form string; coerce it to the
  // typed ReleaseChannel before evaluating defaults.
  const cliChannel = opts.updateChannel
    ? (validateUpdateChannel(opts.updateChannel) as ReleaseChannel | undefined)
    : undefined
  const detectedChannel = detectChannelFromVersion(AGENT_VERSION)
  return {
    enabled: opts.autoUpdate !== false,
    autoRestart: true,
    channel: cliChannel ?? config?.autoUpdate?.channel ?? detectedChannel,
    ...config?.autoUpdate,
    // CLI flags override config
    ...(opts.autoUpdate === false && { enabled: false }),
    ...(cliChannel && { channel: cliChannel }),
  }
}

export function startHostAutoUpdater(
  opts: DockerRunOptions,
  config: ReturnType<typeof loadConfig>,
  projects: ReturnType<typeof getProjectList>,
  supervisor: Pick<DockerSupervisor, 'stopAll'>,
  agentId: string | undefined,
): AutoUpdaterHandle | undefined {
  const autoUpdateConfig = resolveHostAutoUpdateConfig(opts, config)
  if (!autoUpdateConfig.enabled) return undefined
  if (projects.length === 0) return undefined

  const apiUrl = projects[0].apiUrl
  const token = projects[0].token
  if (!apiUrl || !token) return undefined

  const client = new ApiClient(apiUrl, token)
  const resolvedAgentId = agentId ?? config?.agentId ?? os.hostname()

  return startAutoUpdater(
    [client],
    autoUpdateConfig,
    () => supervisor.stopAll(),
    (error) => {
      void client.heartbeat(resolvedAgentId, getSystemInfo(), error).catch((err) => {
        logger.warn(`[auto-update] Failed to send error heartbeat: ${getErrorMessage(err)}`)
      })
    },
  )
}

export function runInDocker(opts: DockerRunOptions): void {
  // Guard against multiple concurrent invocations
  if (isDockerRunning) {
    logger.warn('[docker] runInDocker called while already running — ignoring duplicate call')
    return
  }
  isDockerRunning = true

  // 二重起動防止チェック
  if (isAlreadyRunning()) {
    logger.error(`Agent is already running (PID: ${readPidFile()}). Use "ai-support-agent stop" to stop it first.`)
    process.exit(1)
    return
  }

  if (!checkDockerAvailable()) {
    logger.error(t('docker.notAvailable'))
    process.exit(1)
    return
  }

  const config = loadConfig()

  // Sync bundled Dockerfile to config dir on first run (unless disabled)
  const shouldSync = opts.dockerfileSync !== false && config?.dockerfileSync !== false
  if (shouldSync) {
    syncDockerfileToConfigDir()
  }

  // Resolve Dockerfile: CLI flag > config.dockerfilePath > configDir/Dockerfile > bundled default
  const customDockerfile = opts.dockerfile ?? config?.dockerfilePath

  const version = ensureImage(customDockerfile)

  // Determine projects to run (skip entries without tenantCode)
  const allProjects = config ? getProjectList(config) : []
  let projects: ReturnType<typeof getProjectList>

  if (opts.project) {
    const slashIdx = opts.project.indexOf('/')
    if (slashIdx < 0) {
      logger.error(`[docker] --project must be in "tenantCode/projectCode" format: ${opts.project}`)
      process.exit(1)
      return
    }
    const tenantCode = opts.project.substring(0, slashIdx)
    const projectCode = opts.project.substring(slashIdx + 1)
    projects = allProjects.filter(
      (p) => p.tenantCode === tenantCode && p.projectCode === projectCode,
    )
    if (projects.length === 0) {
      if (opts.token || process.env.AI_SUPPORT_AGENT_TOKEN) {
        projects = [{
          tenantCode,
          projectCode,
          token: opts.token ?? process.env.AI_SUPPORT_AGENT_TOKEN ?? '',
          apiUrl: opts.apiUrl ?? process.env.AI_SUPPORT_AGENT_API_URL ?? '',
        }]
      } else {
        logger.error(`[docker] Project not found: ${opts.project}`)
        process.exit(1)
        return
      }
    }
  } else if (allProjects.length > 0) {
    projects = allProjects
  } else {
    projects = []
  }

  ensureClaudeJsonIntegrity()

  if (projects.length > 0) {
    logger.info(`[docker] Starting ${projects.length} project container(s)...`)

    const agentId = config?.agentId ?? os.hostname()
    const enrichedOpts: DockerRunOptions = {
      ...opts,
      agentId: opts.agentId ?? agentId,
    }

    writePidFile()
    const supervisor = new DockerSupervisor(version, enrichedOpts)
    supervisor.start(projects, () => { isDockerRunning = false })

    // Host-side auto-updater. The auto-updater inside each container is
    // intentionally skipped (see auto-updater.ts AI_SUPPORT_AGENT_IN_DOCKER
    // guard), so we run it on the host instead. When a new version is found,
    // performUpdate() upgrades the host CLI via npm install, then
    // reExecProcess() restarts this process so ensureImage() rebuilds the
    // container image at the new version.
    startHostAutoUpdater(opts, config, projects, supervisor, enrichedOpts.agentId)
    return
  }

  // Legacy fallback: single container handling all projects via shared volume mount
  logger.info(t('docker.starting'))

  const { mounts, projectMappings } = buildVolumeMounts()
  const envArgs = buildEnvArgs(projectMappings)
  const containerArgs = buildContainerArgs(opts)

  const interactive = process.stdin.isTTY ? ['-it'] : ['-i']

  const dockerArgs = [
    'run', '--rm', ...interactive,
    ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []),
    ...mounts,
    ...envArgs,
    `${IMAGE_NAME}:${version}`,
    ...containerArgs,
  ]

  const child = spawn(getDockerPath(), dockerArgs, {
    stdio: 'inherit',
  })

  // Forward signals to container
  const forwardSignal = (signal: NodeJS.Signals): void => {
    child.kill(signal)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))

  child.on('error', (err) => {
    logger.error(t('docker.runFailed', { message: getErrorMessage(err) }))
    process.exit(1)
  })

  let closeHandled = false
  child.on('close', (code) => {
    if (closeHandled) return
    closeHandled = true
    isDockerRunning = false

    if (code === DOCKER_UPDATE_EXIT_CODE) {
      logger.info('[docker] Container exited for update. Rebuilding image and restarting...')
      void installUpdateAndRestart()
      return
    }
    process.exit(code ?? 0)
  })
}

// Re-exports for backward compatibility
export {
  checkDockerAvailable,
  imageExists,
  buildImage,
  buildContainerName,
  removeStaleContainer,
  dockerLogin,
} from './docker-utils'
export { validatePackageNames } from './docker-security'
export { generateProjectDockerfile } from './dockerfile-generator'
export { syncDockerfileToConfigDir } from './dockerfile-sync'
export { buildProjectImage } from './project-image-builder'
export { buildVolumeMounts, buildEnvArgs, buildProjectVolumeMounts } from './volume-mount-builder'
export type { ProjectDirMapping } from './volume-mount-builder'
export { getInstalledVersion, resetInstalledVersionCache, ensureImage } from './version-manager'
export { migrateProjectConfigDir } from './project-config'
export { DockerSupervisor } from './docker-supervisor'
