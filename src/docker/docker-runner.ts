import { execFileSync, spawn } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

import { getDockerfilePath, getDockerContextDir } from './dockerfile-path'
import { AGENT_VERSION } from '../constants'
import { getConfigDir, loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { BLOCKED_PATH_PREFIXES, getSensitiveHomePaths } from '../security'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { isNewerVersion, isValidVersion } from '../utils/version'
import { reExecProcess } from '../update-checker'

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

export function buildImage(version: string): void {
  const dockerfilePath = getDockerfilePath()
  const contextDir = getDockerContextDir()
  logger.info(t('docker.building'))
  execFileSync(
    'docker',
    ['build', '-t', `${IMAGE_NAME}:${version}`, '--build-arg', `AGENT_VERSION=${version}`, '-f', dockerfilePath, contextDir],
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

export function ensureImage(): string {
  const installedVersion = getInstalledVersion()
  // Use the installed version if it is newer than the compile-time version
  const version = isNewerVersion(AGENT_VERSION, installedVersion) ? installedVersion : AGENT_VERSION
  if (!imageExists(version)) {
    buildImage(version)
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

export function runInDocker(opts: DockerRunOptions): void {
  if (!checkDockerAvailable()) {
    logger.error(t('docker.notAvailable'))
    process.exit(1)
    return
  }

  const version = ensureImage()

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

  child.on('close', (code) => {
    // Exit code 0 means the container shut down cleanly (e.g. after an update).
    // Re-exec the host process so ensureImage() runs again and rebuilds the
    // Docker image for the newly installed agent version before restarting.
    if (code === 0) {
      logger.info('[docker] Container exited cleanly. Restarting to apply updates...')
      reExecProcess()
      return
    }
    process.exit(code ?? 1)
  })
}
