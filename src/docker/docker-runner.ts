import { execFileSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getDockerfilePath, getDockerContextDir, resolveDockerfile } from './dockerfile-path'
import { AGENT_VERSION, DOCKER_UPDATE_EXIT_CODE } from '../constants'
import { getConfigDir, loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { BLOCKED_PATH_PREFIXES, getSensitiveHomePaths } from '../security'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { isNewerVersion, isValidVersion } from '../utils/version'
import { performUpdate, reExecProcess } from '../update-checker'

/** Convert a path.relative() result to POSIX format for container use */
function toPosixRelative(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

const IMAGE_NAME = 'ai-support-agent'
const PASSTHROUGH_ENV_VARS = [
  'AI_SUPPORT_AGENT_TOKEN',
  'AI_SUPPORT_AGENT_API_URL',
  'AI_SUPPORT_AGENT_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

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
}

export function checkDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function imageExists(version: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', `${IMAGE_NAME}:${version}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function buildImage(version: string, customDockerfile?: string): void {
  const { dockerfilePath, contextDir } = resolveDockerfile(customDockerfile)
  logger.info(t('docker.building'))
  if (customDockerfile) {
    logger.info(t('docker.usingCustomDockerfile', { path: dockerfilePath }))
  }
  execFileSync(
    'docker',
    ['build', '-t', `${IMAGE_NAME}:${version}`, '--pull=false', '--build-arg', `AGENT_VERSION=${version}`, '-f', dockerfilePath, contextDir],
    { stdio: 'inherit' },
  )
  logger.success(t('docker.buildComplete'))
}

/** Container-internal base path for project directories */
const CONTAINER_PROJECTS_BASE = '/workspace/projects'
/** Container-internal home directory */
const CONTAINER_HOME = '/home/node'

export interface ProjectDirMapping {
  hostDir: string
  containerDir: string
  projectCode: string
}

export function buildVolumeMounts(): { mounts: string[]; projectMappings: ProjectDirMapping[] } {
  const home = os.homedir()
  const mounts: string[] = []
  const projectMappings: ProjectDirMapping[] = []

  // Claude Code OAuth tokens and config — mount to container home
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    mounts.push('-v', `${claudeDir}:${path.posix.join(CONTAINER_HOME, '.claude')}:rw`)
  }
  const claudeJson = path.join(home, '.claude.json')
  if (fs.existsSync(claudeJson)) {
    mounts.push('-v', `${claudeJson}:${path.posix.join(CONTAINER_HOME, '.claude.json')}:rw`)
  }

  // Agent config — mount to container home
  const agentConfigDir = getConfigDir()
  if (fs.existsSync(agentConfigDir)) {
    const relativeToHome = path.relative(home, agentConfigDir)
    const isUnderHome = !relativeToHome.startsWith('..')
    const containerConfigDir = isUnderHome
      ? path.posix.join(CONTAINER_HOME, toPosixRelative(relativeToHome))
      : `/workspace/.config/ai-support-agent`
    mounts.push('-v', `${agentConfigDir}:${containerConfigDir}:rw`)
  }

  // AWS credentials — mount to container home
  const awsDir = path.join(home, '.aws')
  if (fs.existsSync(awsDir)) {
    mounts.push('-v', `${awsDir}:${path.posix.join(CONTAINER_HOME, '.aws')}:ro`)
  }

  // Custom project directories — mount to /workspace/projects/{projectCode}
  const config = loadConfig()
  if (config?.projects) {
    const mounted = new Set<string>()
    const blockedPrefixes = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
    for (const project of config.projects) {
      if (project.projectDir && !mounted.has(project.projectDir) && fs.existsSync(project.projectDir)) {
        let resolved: string
        try {
          resolved = fs.realpathSync(project.projectDir)
        } catch {
          logger.warn(`[docker] Cannot resolve path, skipping: ${project.projectDir}`)
          continue
        }
        const isBlocked = blockedPrefixes.some((prefix) => {
          const prefixWithoutSlash = prefix.replace(/\/$/, '')
          return resolved === prefixWithoutSlash || resolved.startsWith(prefix)
        })
        if (isBlocked) {
          logger.warn(`[docker] Skipping blocked path for volume mount: ${project.projectDir}`)
          continue
        }
        const containerDir = `${CONTAINER_PROJECTS_BASE}/${project.projectCode}`
        mounts.push('-v', `${project.projectDir}:${containerDir}:rw`)
        projectMappings.push({
          hostDir: project.projectDir,
          containerDir,
          projectCode: project.projectCode,
        })
        mounted.add(project.projectDir)
      }
    }
  }

  return { mounts, projectMappings }
}

export function buildEnvArgs(projectMappings: ProjectDirMapping[]): string[] {
  const args: string[] = []

  // Mark process as running inside a Docker container
  args.push('-e', 'AI_SUPPORT_AGENT_IN_DOCKER=1')

  // Set HOME to container-internal path (not host path)
  args.push('-e', `HOME=${CONTAINER_HOME}`)

  // Map config dir to container-internal path
  const hostConfigDir = getConfigDir()
  const home = os.homedir()
  const relativeToHome = path.relative(home, hostConfigDir)
  const isUnderHome = !relativeToHome.startsWith('..')
  const containerConfigDir = isUnderHome
    ? path.posix.join(CONTAINER_HOME, toPosixRelative(relativeToHome))
    : `/workspace/.config/ai-support-agent`

  for (const key of PASSTHROUGH_ENV_VARS) {
    if (process.env[key]) {
      if (key === 'AI_SUPPORT_AGENT_CONFIG_DIR') {
        args.push('-e', `${key}=${containerConfigDir}`)
      } else {
        args.push('-e', `${key}=${process.env[key]}`)
      }
    }
  }

  // Pass project directory mappings so agent uses container-internal paths
  if (projectMappings.length > 0) {
    // Format: projectCode=containerDir;projectCode2=containerDir2
    const mapping = projectMappings
      .map((m) => `${m.projectCode}=${m.containerDir}`)
      .join(';')
    args.push('-e', `AI_SUPPORT_AGENT_PROJECT_DIR_MAP=${mapping}`)
  }

  return args
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

  return args
}

let cachedInstalledVersion: string | null = null

/**
 * Get the currently installed version of @ai-support-agent/cli from npm global.
 * Falls back to AGENT_VERSION if npm query fails.
 * Result is cached after the first call.
 *
 * NOTE: Must only be called from host-side code (i.e. runInDocker).
 * Inside a Docker container the process runs with --no-docker, so
 * ensureImage() / getInstalledVersion() are never reached.
 */
export function getInstalledVersion(): string {
  if (cachedInstalledVersion !== null) return cachedInstalledVersion
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const output = execFileSync(npmCmd, ['list', '-g', '--json', '--depth=0'], {
      encoding: 'utf-8',
      timeout: 10_000,
    })
    const parsed = JSON.parse(output) as {
      dependencies?: Record<string, { version?: string }>
    }
    const version = parsed.dependencies?.['@ai-support-agent/cli']?.version
    if (version && isValidVersion(version)) {
      cachedInstalledVersion = version
      return version
    }
  } catch {
    // npm list failed — fall back to compile-time version
  }
  cachedInstalledVersion = AGENT_VERSION
  return AGENT_VERSION
}

/**
 * Reset the cached installed version (for testing).
 */
export function resetInstalledVersionCache(): void {
  cachedInstalledVersion = null
}

export function ensureImage(customDockerfile?: string): string {
  const installedVersion = getInstalledVersion()
  // Use the installed version if it is newer than the compile-time version
  const version = isNewerVersion(AGENT_VERSION, installedVersion) ? installedVersion : AGENT_VERSION
  if (!imageExists(version)) {
    buildImage(version, customDockerfile)
  } else {
    logger.info(t('docker.imageFound', { version }))
  }
  return version
}

export function dockerLogin(): void {
  logger.info(t('docker.loginStep1'))
  console.log('')
  console.log('  claude setup-token')
  console.log('')
  logger.info(t('docker.loginStep2'))
  console.log('')
  console.log('  export CLAUDE_CODE_OAUTH_TOKEN=<token>')
  console.log('  ai-support-agent start')
  console.log('')
  logger.info(t('docker.loginStep3'))
}

/**
 * Called on the host after the container exits with DOCKER_UPDATE_EXIT_CODE.
 * Reads the new version from the config-dir volume (written by the container),
 * installs it on the host with npm, then re-execs the process so ensureImage()
 * picks up the newly installed version and rebuilds the Docker image.
 */
async function installUpdateAndRestart(): Promise<void> {
  let newVersion: string | undefined
  try {
    const versionFile = path.join(getConfigDir(), 'update-version.json')
    const raw = fs.readFileSync(versionFile, 'utf-8')
    const parsed = JSON.parse(raw) as { version?: string }
    if (parsed.version && isValidVersion(parsed.version)) {
      newVersion = parsed.version
    }
    fs.unlinkSync(versionFile)
  } catch {
    // File may not exist (e.g. auto-updater path) — proceed without it
  }

  if (newVersion) {
    logger.info(`[docker] Installing @ai-support-agent/cli@${newVersion} on host...`)
    // Always use 'global' install method on the host side regardless of how the
    // host process was originally launched (it may be detected as 'local' in
    // service/systemd environments where the script path is under node_modules).
    const result = await performUpdate(newVersion, 'global')
    if (!result.success) {
      logger.warn(`[docker] Host npm install failed: ${result.error ?? 'unknown'}. Proceeding with existing version.`)
    } else {
      // Invalidate the cached installed version so ensureImage() re-reads it
      resetInstalledVersionCache()  // defined in this file
    }
  }

  reExecProcess()
}

/**
 * Copy the bundled Dockerfile (and entrypoint.sh) to the config directory
 * on first run so users can customise it.
 * Does NOT overwrite an existing file — user edits are preserved.
 * Exported for testing.
 */
export function syncDockerfileToConfigDir(): void {
  const configDir = getConfigDir()
  const destDockerfile = path.join(configDir, 'Dockerfile')

  if (fs.existsSync(destDockerfile)) return // preserve existing file

  try {
    const srcDockerfile = getDockerfilePath()
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
    fs.copyFileSync(srcDockerfile, destDockerfile)

    // Also copy entrypoint.sh which the bundled Dockerfile references via COPY
    const srcEntrypoint = path.join(getDockerContextDir(), 'docker', 'entrypoint.sh')
    const destEntrypoint = path.join(configDir, 'docker', 'entrypoint.sh')
    if (fs.existsSync(srcEntrypoint)) {
      fs.mkdirSync(path.dirname(destEntrypoint), { recursive: true })
      fs.copyFileSync(srcEntrypoint, destEntrypoint)
    }

    logger.info(t('docker.dockerfileSynced', { path: destDockerfile }))
  } catch (err) {
    logger.warn(t('docker.dockerfileSyncFailed', { message: err instanceof Error ? err.message : String(err) }))
  }
}

let isDockerRunning = false

/** Reset the running flag (for testing). */
export function resetIsDockerRunning(): void {
  isDockerRunning = false
}

export function runInDocker(opts: DockerRunOptions): void {
  // Guard against multiple concurrent invocations (e.g. auto-updater and
  // server-triggered update firing at the same time).
  if (isDockerRunning) {
    logger.warn('[docker] runInDocker called while already running — ignoring duplicate call')
    return
  }
  isDockerRunning = true

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

  ensureClaudeJsonIntegrity()

  const child = spawn('docker', dockerArgs, {
    stdio: 'inherit',
  })

  // Forward signals to container
  const forwardSignal = (signal: NodeJS.Signals): void => {
    child.kill(signal)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))

  child.on('error', (err) => {
    logger.error(t('docker.runFailed', { message: err.message }))
    process.exit(1)
  })

  let closeHandled = false
  child.on('close', (code) => {
    // Guard against duplicate close events
    if (closeHandled) return
    closeHandled = true
    isDockerRunning = false

    // DOCKER_UPDATE_EXIT_CODE signals "update installed, rebuild image and restart".
    // Any other exit (including 0 from SIGINT) exits the host process as-is.
    if (code === DOCKER_UPDATE_EXIT_CODE) {
      logger.info('[docker] Container exited for update. Rebuilding image and restarting...')
      void installUpdateAndRestart()
      return
    }
    process.exit(code ?? 0)
  })
}
