/**
 * Basic Docker utilities
 *
 * Availability checks, image operations, container naming.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { resolveDockerfile } from './dockerfile-path'
import { AGENT_VERSION } from '../constants'
import { t } from '../i18n'
import { logger } from '../logger'

export const IMAGE_NAME = 'ai-support-agent'

/**
 * Resolve the docker binary path, searching common locations when `docker` is
 * not on the current PATH (e.g. when launched from a launchd service or a
 * non-interactive SSH session that does not load the user shell profile).
 */
function resolveDockerPath(): string {
  // Check well-known locations when docker is not on PATH
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    path.join(os.homedir(), '.docker', 'bin', 'docker'),
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  // Fall back to PATH lookup — works when shell profile is sourced
  return 'docker'
}

/**
 * Set DOCKER_HOST to the user's Docker Desktop socket when not already set,
 * so that docker commands work even in environments without the default
 * /var/run/docker.sock (e.g. Docker Desktop on macOS).
 */
function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) return
  const macSocket = path.join(os.homedir(), '.docker', 'run', 'docker.sock')
  if (fs.existsSync(macSocket)) {
    process.env.DOCKER_HOST = `unix://${macSocket}`
  }
}

let _dockerPath: string | undefined

export function getDockerPath(): string {
  if (!_dockerPath) {
    ensureDockerHost()
    _dockerPath = resolveDockerPath()
  }
  return _dockerPath
}

/** Reset the cached docker path and DOCKER_HOST — for use in tests only. */
export function resetDockerPathCache(): void {
  _dockerPath = undefined
  delete process.env.DOCKER_HOST
}

export function checkDockerAvailable(): boolean {
  try {
    execFileSync(getDockerPath(), ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function imageExists(version: string): boolean {
  try {
    execFileSync(getDockerPath(), ['image', 'inspect', `${IMAGE_NAME}:${version}`], { stdio: 'ignore' })
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
    getDockerPath(),
    ['build', '-t', `${IMAGE_NAME}:${version}`, '--pull=false', '--build-arg', `AGENT_VERSION=${version}`, '-f', dockerfilePath, contextDir],
    { stdio: 'inherit' },
  )
  logger.success(t('docker.buildComplete'))
}

/**
 * Build a deterministic container name for a project.
 * Format: ai-{tenantCode}-{projectCode}-{agentId}
 * All components are lowercased and non-alphanumeric chars (except hyphens) are replaced with hyphens.
 */
export function buildContainerName(tenantCode: string, projectCode: string, agentId?: string): string {
  const sanitize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const parts = ['ai', sanitize(tenantCode), sanitize(projectCode)]
  if (agentId) parts.push(sanitize(agentId))
  return parts.join('-')
}

/**
 * Remove a stale container with the given name if it exists.
 * This handles the case where a previous run crashed and left a container behind,
 * which would prevent `docker run --name` from succeeding.
 */
export function removeStaleContainer(containerName: string): void {
  try {
    execFileSync(getDockerPath(), ['rm', '-f', containerName], { stdio: 'ignore' })
  } catch {
    // Container does not exist or docker rm failed — ignore
  }
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

/** Convert a path.relative() result to POSIX format for container use */
export function toPosixRelative(relativePath: string): string {
  return relativePath.split(require('path').sep).join('/')
}

/**
 * Returns true when running via ts-node (i.e. `npm run dev`).
 * In this case, local dist/ should be mounted into containers instead of
 * relying on the npm-installed package inside the image.
 */
export function isRunningViaTsNode(): boolean {
  const sym = Symbol.for('ts-node.register.instance')
  return !!(process as unknown as { [key: symbol]: unknown })[sym]
}

/**
 * Returns extra volume mount args to overlay the local dist/ into the container
 * when running in dev mode (ts-node), so the container uses local source code.
 * Returns an empty array when not in dev mode.
 */
export function buildDevMounts(): string[] {
  if (!isRunningViaTsNode()) return []
  // __dirname is agent/src/docker — walk up two levels to get agent/
  const path = require('path')
  const agentRoot = path.resolve(__dirname, '..', '..')
  const distDir = path.join(agentRoot, 'dist')
  const localesDir = path.join(agentRoot, 'src', 'locales')
  const containerBase = '/usr/local/lib/node_modules/@ai-support-agent/cli'
  return [
    '-v', `${distDir}:${containerBase}/dist:ro`,
    '-v', `${localesDir}:${containerBase}/dist/locales:ro`,
  ]
}

/**
 * Generate a session ID from the current timestamp.
 * Format: YYYYMMDDHHmmss
 */
export function makeSessionId(): string {
  const d = new Date()
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

/** Check if a project-specific image tag exists; fall back to base image tag. */
export function resolveImageTag(projectTag: string, baseTag: string): string {
  try {
    execFileSync(getDockerPath(), ['image', 'inspect', projectTag], { stdio: 'ignore' })
    return projectTag
  } catch /* istanbul ignore next */ {
    return baseTag
  }
}

export { AGENT_VERSION }
