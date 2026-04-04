import { execFileSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getDockerfilePath, getDockerContextDir, resolveDockerfile, getProjectDockerfilePath, getProjectImageTag } from './dockerfile-path'
import { AGENT_VERSION, DOCKER_UPDATE_EXIT_CODE, DOCKER_RESTART_EXIT_CODE } from '../constants'
import { getConfigDir, getProjectList, loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { BLOCKED_PATH_PREFIXES, getSensitiveHomePaths } from '../security'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { isNewerVersion, isValidVersion } from '../utils/version'
import { performUpdate, reExecProcess } from '../update-checker'
import type { ProjectRegistration } from '../types'

/** Convert a path.relative() result to POSIX format for container use */
function toPosixRelative(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

/**
 * Returns true when running via ts-node (i.e. `npm run dev`).
 * In this case, local dist/ should be mounted into containers instead of
 * relying on the npm-installed package inside the image.
 */
function isRunningViaTsNode(): boolean {
  const sym = Symbol.for('ts-node.register.instance')
  return !!(process as unknown as { [key: symbol]: unknown })[sym]
}

/**
 * Returns extra volume mount args to overlay the local dist/ into the container
 * when running in dev mode (ts-node), so the container uses local source code.
 * Returns an empty array when not in dev mode.
 */
function buildDevMounts(): string[] {
  if (!isRunningViaTsNode()) return []
  // __dirname is agent/src/docker — walk up two levels to get agent/
  const agentRoot = path.resolve(__dirname, '..', '..')
  const distDir = path.join(agentRoot, 'dist')
  const localesDir = path.join(agentRoot, 'src', 'locales')
  const containerBase = '/usr/local/lib/node_modules/@ai-support-agent/cli'
  return [
    '-v', `${distDir}:${containerBase}/dist:ro`,
    '-v', `${localesDir}:${containerBase}/dist/locales:ro`,
  ]
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
  /**
   * Filter to a single project. Format: "tenantCode/projectCode"
   * When set, only the matching project is started.
   */
  project?: string
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

/** Allowlist for apt package names: letters, digits, hyphens, dots, plus signs, colons */
const APT_PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9+\-.:]*$/
/** Allowlist for npm package names: scoped (@scope/name) or plain, with version (@x.y.z) */
const NPM_PACKAGE_RE = /^(@[a-zA-Z0-9_\-.]+\/)?[a-zA-Z0-9_\-.]+(@[a-zA-Z0-9._\-^~*]+)?$/

/**
 * Validate a list of package names against an allowlist regex.
 * Throws if any name is invalid to prevent Dockerfile injection.
 */
export function validatePackageNames(packages: string[], type: 'apt' | 'npm'): void {
  const re = type === 'apt' ? APT_PACKAGE_RE : NPM_PACKAGE_RE
  for (const pkg of packages) {
    if (!re.test(pkg)) {
      throw new Error(`Invalid ${type} package name: "${pkg}"`)
    }
  }
}

/**
 * Generate a per-project Dockerfile that extends the base agent image.
 */
export function generateProjectDockerfile(
  baseVersion: string,
  aptPackages: string[],
  npmPackages: string[],
): string {
  validatePackageNames(aptPackages, 'apt')
  validatePackageNames(npmPackages, 'npm')

  const lines = [`FROM ${IMAGE_NAME}:${baseVersion}`]
  if (aptPackages.length > 0) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends \\`,
      `    ${aptPackages.join(' \\\n    ')} \\`,
      `    && rm -rf /var/lib/apt/lists/*`,
    )
  }
  if (npmPackages.length > 0) {
    lines.push(
      `RUN npm install -g ${npmPackages.join(' ')} && npm cache clean --force`,
    )
  }
  return lines.join('\n') + '\n'
}

/**
 * Build a per-project Docker image using the given Dockerfile.
 */
export function buildProjectImage(tenantCode: string, projectCode: string, baseVersion: string, dockerfilePath: string): void {
  const imageTag = getProjectImageTag(tenantCode, projectCode, baseVersion)
  const contextDir = getDockerContextDir()
  logger.info(`[docker] Building project image: ${imageTag}`)
  execFileSync(
    'docker',
    ['build', '-t', imageTag, '--pull=false', '--build-arg', `AGENT_VERSION=${baseVersion}`, '-f', dockerfilePath, contextDir],
    { stdio: 'inherit' },
  )
  logger.success(`[docker] Project image built: ${imageTag}`)
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
  if (opts.project) {
    args.push('--project', opts.project)
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
 * Called on the host after a container exits with DOCKER_UPDATE_EXIT_CODE.
 * Reads the new version from a project-specific config dir (written by the container),
 * installs it on the host with npm, then re-execs the process so ensureImage()
 * picks up the newly installed version and rebuilds the Docker image.
 */
async function installUpdateAndRestart(projectConfigDir?: string): Promise<void> {
  let newVersion: string | undefined
  // First try project-specific config dir, fall back to global config dir
  const searchDirs = projectConfigDir
    ? [projectConfigDir, getConfigDir()]
    : [getConfigDir()]

  for (const dir of searchDirs) {
    try {
      const versionFile = path.join(dir, 'update-version.json')
      const raw = fs.readFileSync(versionFile, 'utf-8')
      const parsed = JSON.parse(raw) as { version?: string }
      if (parsed.version && isValidVersion(parsed.version)) {
        newVersion = parsed.version
      }
      fs.unlinkSync(versionFile)
      break
    } catch {
      // File does not exist in this dir — try next
    }
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

// ---------------------------------------------------------------------------
// Per-project volume mount helpers
// ---------------------------------------------------------------------------

/**
 * Build volume mounts and env args for a single project container.
 * Each project gets its own isolated config dir under ~/.ai-support-agent/projects/{tenantCode}/{projectCode}/.ai-support-agent/
 */
function buildProjectVolumeMounts(
  project: ProjectRegistration,
  projectConfigHostDir: string,
): { mounts: string[]; envArgs: string[] } {
  const home = os.homedir()
  const mounts: string[] = []
  const envArgs: string[] = []

  // Claude Code OAuth tokens and config — mount to container home
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    mounts.push('-v', `${claudeDir}:${path.posix.join(CONTAINER_HOME, '.claude')}:rw`)
  }
  const claudeJson = path.join(home, '.claude.json')
  if (fs.existsSync(claudeJson)) {
    mounts.push('-v', `${claudeJson}:${path.posix.join(CONTAINER_HOME, '.claude.json')}:rw`)
  }

  // Per-project isolated config dir — mounts to /home/node/.ai-support-agent inside container
  const containerConfigDir = path.posix.join(CONTAINER_HOME, '.ai-support-agent')
  fs.mkdirSync(projectConfigHostDir, { recursive: true, mode: 0o700 })
  mounts.push('-v', `${projectConfigHostDir}:${containerConfigDir}:rw`)

  // Standard env vars for per-project container
  envArgs.push('-e', 'AI_SUPPORT_AGENT_IN_DOCKER=1')
  envArgs.push('-e', `HOME=${CONTAINER_HOME}`)
  envArgs.push('-e', `AI_SUPPORT_AGENT_CONFIG_DIR=${containerConfigDir}`)

  // Pass token and apiUrl per-project
  if (project.token) {
    envArgs.push('-e', `AI_SUPPORT_AGENT_TOKEN=${project.token}`)
  }
  if (project.apiUrl) {
    // Replace localhost/127.0.0.1 with host.docker.internal so the container can reach the host
    const containerApiUrl = project.apiUrl.replace(
      /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?/,
      (_, scheme, _host, port) => `${scheme}host.docker.internal${port ?? ''}`,
    )
    envArgs.push('-e', `AI_SUPPORT_AGENT_API_URL=${containerApiUrl}`)
  }

  // Pass ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN if set
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    if (process.env[key]) {
      envArgs.push('-e', `${key}=${process.env[key]}`)
    }
  }

  // Project dir mapping: single project only
  const containerProjectDir = `${CONTAINER_PROJECTS_BASE}/${project.projectCode}`
  const blockedPrefixes = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
  if (project.projectDir && fs.existsSync(project.projectDir)) {
    let resolved: string
    try {
      resolved = fs.realpathSync(project.projectDir)
      const isBlocked = blockedPrefixes.some((prefix) => {
        const prefixWithoutSlash = prefix.replace(/\/$/, '')
        return resolved === prefixWithoutSlash || resolved.startsWith(prefix)
      })
      if (!isBlocked) {
        mounts.push('-v', `${project.projectDir}:${containerProjectDir}:rw`)
        envArgs.push('-e', `AI_SUPPORT_AGENT_PROJECT_DIR_MAP=${project.projectCode}=${containerProjectDir}`)
      } else {
        logger.warn(`[docker] Skipping blocked path for volume mount: ${project.projectDir}`)
      }
    } catch {
      logger.warn(`[docker] Cannot resolve path, skipping: ${project.projectDir}`)
    }
  }

  return { mounts, envArgs }
}

/**
 * Get the host-side per-project config directory.
 * Located at: ~/.ai-support-agent/projects/{tenantCode}/{projectCode}/.ai-support-agent/
 */
function getProjectConfigHostDir(project: ProjectRegistration): string {
  return path.join(getConfigDir(), 'projects', project.tenantCode, project.projectCode, '.ai-support-agent')
}

// ---------------------------------------------------------------------------
// DockerSupervisor: one container per project
// ---------------------------------------------------------------------------

interface DockerContainerHandle {
  project: ProjectRegistration
  child: ChildProcess
  version: string
  closeHandled: boolean
}

/**
 * Manages one Docker container per project.
 * Spawned from runInDocker() when multiple projects are configured.
 */
class DockerSupervisor {
  private handles = new Map<string, DockerContainerHandle>()
  private updating = false
  private opts: DockerRunOptions
  private version: string
  private onAllStopped: (() => void) | undefined

  constructor(version: string, opts: DockerRunOptions) {
    this.version = version
    this.opts = opts
  }

  private projectKey(project: ProjectRegistration): string {
    return `${project.tenantCode}/${project.projectCode}`
  }

  start(projects: ProjectRegistration[], onStop?: () => void): void {
    this.onAllStopped = onStop

    for (const project of projects) {
      this.spawnProject(project)
    }

    // Setup shutdown handlers
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      // Set updating flag so the close handler does not call process.exit again
      this.updating = true
      logger.info(t('runner.shuttingDown'))
      this.stopAll()
      onStop?.()
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown())
    process.on('SIGTERM', () => shutdown())
  }

  private getImageTag(project: ProjectRegistration): string {
    const projectTag = getProjectImageTag(project.tenantCode, project.projectCode, this.version)
    try {
      execFileSync('docker', ['image', 'inspect', projectTag], { stdio: 'ignore' })
      return projectTag
    } catch {
      return `${IMAGE_NAME}:${this.version}`
    }
  }

  private async rebuildAndRestart(project: ProjectRegistration, projectConfigHostDir: string): Promise<void> {
    const rebuildMarker = path.join(projectConfigHostDir, 'docker-rebuild-needed')
    if (fs.existsSync(rebuildMarker)) {
      fs.unlinkSync(rebuildMarker)
      const projectDockerfile = getProjectDockerfilePath(project.tenantCode, project.projectCode)
      if (fs.existsSync(projectDockerfile)) {
        try {
          buildProjectImage(project.tenantCode, project.projectCode, this.version, projectDockerfile)
        } catch (err) {
          logger.error(`[docker] Image build failed: ${err instanceof Error ? err.message : String(err)}`)
          logger.error(`[docker] Container ${this.projectKey(project)} will not be restarted due to build failure.`)
          return
        }
      }
    }
    this.spawnProject(project)
  }

  private spawnProject(project: ProjectRegistration): void {
    const key = this.projectKey(project)
    const projectConfigHostDir = getProjectConfigHostDir(project)

    const { mounts, envArgs } = buildProjectVolumeMounts(project, projectConfigHostDir)

    const containerArgs = [
      'ai-support-agent', 'start', '--no-docker',
      '--project', key,
    ]
    if (this.opts.pollInterval !== undefined) {
      containerArgs.push('--poll-interval', String(this.opts.pollInterval))
    }
    if (this.opts.heartbeatInterval !== undefined) {
      containerArgs.push('--heartbeat-interval', String(this.opts.heartbeatInterval))
    }
    if (this.opts.verbose) {
      containerArgs.push('--verbose')
    }
    if (this.opts.autoUpdate === false) {
      containerArgs.push('--no-auto-update')
    }
    if (this.opts.updateChannel) {
      containerArgs.push('--update-channel', this.opts.updateChannel)
    }

    const interactive = process.stdin.isTTY ? ['-it'] : ['-i']
    const imageTag = this.getImageTag(project)
    const dockerArgs = [
      'run', '--rm', ...interactive,
      ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []),
      ...mounts,
      ...buildDevMounts(),
      ...envArgs,
      imageTag,
      ...containerArgs,
    ]

    logger.info(`[docker] Starting container for project: ${key}`)
    const child = spawn('docker', dockerArgs, { stdio: 'inherit' })

    const handle: DockerContainerHandle = {
      project,
      child,
      version: this.version,
      closeHandled: false,
    }
    this.handles.set(key, handle)

    child.on('error', (err) => {
      logger.error(`[docker] Container error for ${key}: ${err.message}`)
    })

    child.on('close', (code) => {
      if (handle.closeHandled) return
      handle.closeHandled = true
      this.handles.delete(key)

      if (code === DOCKER_UPDATE_EXIT_CODE && !this.updating) {
        this.updating = true
        logger.info(`[docker] Container ${key} exited for update. Stopping all containers and rebuilding...`)
        this.stopAll()
        void installUpdateAndRestart(projectConfigHostDir).catch((err) => {
          logger.error(`[docker] Update failed: ${err instanceof Error ? err.message : String(err)}`)
          process.exit(1)
        })
        return
      }

      if (code === DOCKER_RESTART_EXIT_CODE && !this.updating) {
        logger.info(`[docker] Container ${key} requested restart. Rebuilding image if needed...`)
        void this.rebuildAndRestart(project, projectConfigHostDir).catch((err) => {
          logger.error(`[docker] Restart failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        return
      }

      if (this.handles.size === 0 && !this.updating) {
        // All containers have exited cleanly
        this.onAllStopped?.()
        process.exit(code ?? 0)
      }
    })
  }

  stopAll(): void {
    for (const [key, handle] of this.handles) {
      if (!handle.closeHandled) {
        logger.info(`[docker] Stopping container for project: ${key}`)
        handle.child.kill('SIGTERM')
      }
    }
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

  // Determine projects to run (skip entries without tenantCode)
  const allProjects = config ? getProjectList(config) : []
  let projects: ProjectRegistration[]

  if (opts.project) {
    // Single-project mode (e.g. for testing or external invocation)
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
        // Fallback: create a temporary project from env/CLI args
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
    // Multi-project supervisor mode: one container per project
    projects = allProjects
  } else {
    // No config: run single container with legacy volume mount approach
    projects = []
  }

  ensureClaudeJsonIntegrity()

  if (projects.length > 0) {
    // Per-project container mode (new architecture)
    logger.info(`[docker] Starting ${projects.length} project container(s)...`)
    const supervisor = new DockerSupervisor(version, opts)
    supervisor.start(projects, () => { isDockerRunning = false })
    return
  }

  // Legacy fallback: single container handling all projects via shared volume mount
  // (used when no projects are registered in config — e.g. token/apiUrl passed via CLI)
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
