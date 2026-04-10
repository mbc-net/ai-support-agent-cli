/**
 * Docker volume mount builders
 *
 * Handles both legacy shared-mount mode and per-project isolated mount mode.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getConfigDir, loadConfig } from '../config-manager'
import { logger } from '../logger'
import { BLOCKED_PATH_PREFIXES, getSensitiveHomePaths } from '../security'
import type { ProjectRegistration } from '../types'
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
]

export interface ProjectDirMapping {
  hostDir: string
  containerDir: string
  projectCode: string
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

/**
 * Build environment variable args for the legacy single-container mode.
 */
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

/**
 * Build volume mounts and env args for a single per-project container.
 * Each project gets its own isolated config dir.
 */
export function buildProjectVolumeMounts(
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

  // Pass host timezone so container clocks match the host by default.
  const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  envArgs.push('-e', `TZ=${hostTz}`)

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
