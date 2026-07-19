/**
 * Docker volume mount builders
 *
 * Handles both legacy shared-mount mode and per-project isolated mount mode.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getConfigDir, loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import {
  assertProjectCodeIsSafe,
  BLOCKED_PATH_PREFIXES,
  getSensitiveHomePaths,
} from '../security'
import type { ProjectRegistration } from '../types'
import { getErrorMessage, toContainerApiUrl, stripTrailingSlash } from '../utils'
import { toPosixRelative } from './docker-utils'

/** Container-internal base path for project directories */
export const CONTAINER_PROJECTS_BASE = '/workspace/projects'
/** Container-internal home directory */
export const CONTAINER_HOME = '/home/node'

/** Passthrough environment variables from host to container */
export const PASSTHROUGH_ENV_VARS = [
  'AI_SUPPORT_AGENT_TOKEN',
  'AI_SUPPORT_AGENT_API_URL',
  'AI_SUPPORT_AGENT_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
]

/**
 * Subset of PASSTHROUGH_ENV_VARS that carry Claude / Anthropic credentials.
 * Used by per-project containers where the other agent-specific vars are
 * handled explicitly (token, apiUrl, configDir) rather than via passthrough.
 */
export const CLAUDE_CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

/**
 * Codex credentials/config. Codex stores config, auth, logs, sessions, and
 * app-server state under CODEX_HOME; mount it when available and always point
 * CODEX_HOME at the writable container home path.
 */
export const CODEX_CREDENTIAL_ENV_VARS = [
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const

export interface ProjectDirMapping {
  hostDir: string
  containerDir: string
  projectCode: string
}

/**
 * Combined blocked-path prefixes (built-in + host-sensitive) used to reject
 * project directories from being bind-mounted into containers.
 */
function getBlockedMountPrefixes(): string[] {
  return [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
}

/**
 * True when `resolvedPath` exactly matches, or is nested under, any of
 * `blockedPrefixes`. Single source of truth for the blocked-prefix check
 * that was duplicated between `buildVolumeMounts` and
 * `buildProjectVolumeMounts`.
 */
function isPathBlocked(resolvedPath: string, blockedPrefixes: readonly string[]): boolean {
  return blockedPrefixes.some((prefix) => {
    const prefixWithoutSlash = stripTrailingSlash(prefix)
    return resolvedPath === prefixWithoutSlash || resolvedPath.startsWith(prefix)
  })
}

/** Mount the Claude Code config files (.claude dir and .claude.json) into the container */
function mountClaudeConfig(mounts: string[], home: string): void {
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    mounts.push('-v', `${claudeDir}:${path.posix.join(CONTAINER_HOME, '.claude')}:rw`)
  }
  const claudeJson = path.join(home, '.claude.json')
  if (fs.existsSync(claudeJson)) {
    mounts.push('-v', `${claudeJson}:${path.posix.join(CONTAINER_HOME, '.claude.json')}:rw`)
  }
}

function mountCodexConfig(mounts: string[], home: string): void {
  const codexDir = path.join(home, '.codex')
  if (fs.existsSync(codexDir)) {
    mounts.push('-v', `${codexDir}:${path.posix.join(CONTAINER_HOME, '.codex')}:rw`)
  }
}

/** Compute the container-internal path for the agent config dir */
function getContainerConfigDir(hostConfigDir: string, home: string): string {
  const relativeToHome = path.relative(home, hostConfigDir)
  const isUnderHome = !relativeToHome.startsWith('..')
  return isUnderHome
    ? path.posix.join(CONTAINER_HOME, toPosixRelative(relativeToHome))
    : '/workspace/.config/ai-support-agent'
}

/**
 * Build volume mounts for the legacy single-container mode.
 * Mounts home dirs, agent config, AWS credentials, and all project directories.
 */
export function buildVolumeMounts(): { mounts: string[]; projectMappings: ProjectDirMapping[] } {
  const home = os.homedir()
  const mounts: string[] = []
  const projectMappings: ProjectDirMapping[] = []

  // Claude Code OAuth tokens and config — mount to container home
  mountClaudeConfig(mounts, home)
  mountCodexConfig(mounts, home)

  // Agent config — mount to container home
  const agentConfigDir = getConfigDir()
  if (fs.existsSync(agentConfigDir)) {
    const containerConfigDir = getContainerConfigDir(agentConfigDir, home)
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
    const blockedPrefixes = getBlockedMountPrefixes()
    for (const project of config.projects) {
      if (project.projectDir && !mounted.has(project.projectDir) && fs.existsSync(project.projectDir)) {
        let resolved: string
        try {
          resolved = fs.realpathSync(project.projectDir)
        } catch {
          logger.warn(`[docker] Cannot resolve path, skipping: ${project.projectDir}`)
          continue
        }
        if (isPathBlocked(resolved, blockedPrefixes)) {
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

/**
 * Build environment variable args for the legacy single-container mode.
 */
export function buildEnvArgs(projectMappings: ProjectDirMapping[]): string[] {
  const args: string[] = []

  // Mark process as running inside a Docker container
  args.push('-e', 'AI_SUPPORT_AGENT_IN_DOCKER=1')

  // Set HOME to container-internal path (not host path)
  args.push('-e', `HOME=${CONTAINER_HOME}`)
  args.push('-e', `CODEX_HOME=${path.posix.join(CONTAINER_HOME, '.codex')}`)

  // Map config dir to container-internal path
  const hostConfigDir = getConfigDir()
  const home = os.homedir()
  const containerConfigDir = getContainerConfigDir(hostConfigDir, home)

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

/**
 * Build volume mounts and env args for a single per-project container.
 * Each project gets its own isolated config dir.
 */
export function buildProjectVolumeMounts(
  project: ProjectRegistration,
  projectConfigHostDir: string,
): { mounts: string[]; envArgs: string[] } {
  // Match the service-wrapper path: reject project/tenant codes whose
  // characters would break the AI_SUPPORT_AGENT_PROJECT_DIR_MAP env format
  // (semicolon = entry separator, equals = key/value separator). Without
  // this, the supervisor would emit a corrupt env and `resolveProjectDir()`
  // inside the container would silently fall back to the default template
  // — re-introducing the doubly-nested layout the recent fix addresses.
  assertProjectCodeIsSafe(project.projectCode)
  assertProjectCodeIsSafe(project.tenantCode)

  const home = os.homedir()
  const mounts: string[] = []
  const envArgs: string[] = []

  // Claude Code OAuth tokens and config — mount to container home
  mountClaudeConfig(mounts, home)
  mountCodexConfig(mounts, home)

  // Per-project isolated config dir — mounts to /home/node/.ai-support-agent inside container
  const containerConfigDir = path.posix.join(CONTAINER_HOME, '.ai-support-agent')
  fs.mkdirSync(projectConfigHostDir, { recursive: true, mode: 0o700 })
  mounts.push('-v', `${projectConfigHostDir}:${containerConfigDir}:rw`)

  // Standard env vars for per-project container
  envArgs.push('-e', 'AI_SUPPORT_AGENT_IN_DOCKER=1')
  envArgs.push('-e', `HOME=${CONTAINER_HOME}`)
  envArgs.push('-e', `CODEX_HOME=${path.posix.join(CONTAINER_HOME, '.codex')}`)
  envArgs.push('-e', `AI_SUPPORT_AGENT_CONFIG_DIR=${containerConfigDir}`)

  // Pass token and apiUrl per-project
  if (project.token) {
    envArgs.push('-e', `AI_SUPPORT_AGENT_TOKEN=${project.token}`)
  }
  if (project.apiUrl) {
    // Replace localhost/127.0.0.1 with host.docker.internal so the container can reach the host.
    // toContainerApiUrl uses a boundary lookahead to avoid false matches on
    // hosts like `localhost.example.com`.
    const containerApiUrl = toContainerApiUrl(project.apiUrl)
    envArgs.push('-e', `AI_SUPPORT_AGENT_API_URL=${containerApiUrl}`)
  }

  // Pass Claude / Anthropic credential env vars if set
  for (const key of CLAUDE_CREDENTIAL_ENV_VARS) {
    if (process.env[key]) {
      envArgs.push('-e', `${key}=${process.env[key]}`)
    }
  }
  for (const key of CODEX_CREDENTIAL_ENV_VARS) {
    if (process.env[key]) {
      envArgs.push('-e', `${key}=${process.env[key]}`)
    }
  }

  // Pass host timezone so container clocks match the host by default.
  const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  envArgs.push('-e', `TZ=${hostTz}`)

  // Project dir mounting.
  //
  // Two cases:
  //   (a) `project.projectDir` is set, exists, and is NOT in BLOCKED_PATH_PREFIXES
  //       → mount that explicit dir at /workspace/projects/<code>.
  //   (b) Otherwise → mount the parent of projectConfigHostDir
  //       (i.e. ~/.ai-support-agent/projects/<t>/<p>) at the same path.
  //
  // Always emit AI_SUPPORT_AGENT_PROJECT_DIR_MAP for /workspace/projects/<code>
  // so the in-container `resolveProjectDir()` does NOT fall back to
  // `${CONFIG_DIR}/projects/<t>/<p>`, which lives INSIDE the metadata
  // mount and produces a doubly nested workspace tree on disk.
  const containerProjectDir = `${CONTAINER_PROJECTS_BASE}/${project.projectCode}`
  const blockedPrefixes = getBlockedMountPrefixes()
  let projectDirMounted = false
  if (project.projectDir && fs.existsSync(project.projectDir)) {
    try {
      const resolved = fs.realpathSync(project.projectDir)
      if (!isPathBlocked(resolved, blockedPrefixes)) {
        mounts.push('-v', `${project.projectDir}:${containerProjectDir}:rw`)
        projectDirMounted = true
      } else {
        logger.warn(`[docker] Skipping blocked path for volume mount: ${project.projectDir}`)
      }
    } catch {
      logger.warn(`[docker] Cannot resolve path, skipping: ${project.projectDir}`)
    }
  }
  if (!projectDirMounted) {
    // Fallback: mount the parent of projectConfigHostDir so the in-container
    // agent has a valid /workspace/projects/<code> to write workspace/,
    // uploads/, etc. into. Without this, ensureProjectDirs would mkdir
    // inside the metadata bind-mount and produce the doubly nested layout.
    const defaultHostProjectDir = path.dirname(projectConfigHostDir)
    // The `mode` option on fs.mkdirSync only applies to newly-created leaves.
    // When the parent (`<configDir>/projects/<t>/<p>`) already exists — as it
    // does after the line-177 recursive mkdir of projectConfigHostDir
    // populated it via umask (typically 0o755) — the mode option is silently
    // ignored. Follow up with chmodSync so the project dir is actually 0o700
    // and not world-listable on multi-user hosts.
    fs.mkdirSync(defaultHostProjectDir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(defaultHostProjectDir, 0o700)
    } catch (error) {
      // Don't fail the install — but DO surface the warning so multi-user
      // hosts aren't silently left with a 0o755 bind-mount source.
      const message = getErrorMessage(error)
      logger.warn(t('docker.projectDirChmodFailed', { path: defaultHostProjectDir, message }))
    }
    mounts.push('-v', `${defaultHostProjectDir}:${containerProjectDir}:rw`)
  }
  envArgs.push('-e', `AI_SUPPORT_AGENT_PROJECT_DIR_MAP=${project.projectCode}=${containerProjectDir}`)

  return { mounts, envArgs }
}
