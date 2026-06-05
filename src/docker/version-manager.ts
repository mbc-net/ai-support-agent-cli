/**
 * Version management for Docker images
 *
 * Manages installed version caching and image availability.
 */

import { execFileSync } from 'child_process'

import { AGENT_VERSION, NPM_COMMAND } from '../constants'
import { isValidVersion, isNewerVersion } from '../utils/version'
import { imageExists, buildImage } from './docker-utils'
import { t } from '../i18n'
import { logger } from '../logger'

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
    const output = execFileSync(NPM_COMMAND, ['list', '-g', '--json', '--depth=0'], {
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
