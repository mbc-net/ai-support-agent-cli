/**
 * Version management for Docker images
 *
 * Manages installed version caching and image availability.
 */

import { execFileSync } from 'child_process'

import { AGENT_VERSION, NPM_COMMAND } from '../constants'
import { isValidVersion, isNewerVersion } from '../utils/version'
import { imageExists, buildImage, pruneOldImages } from './docker-utils'
import { isDockerfileCustomized } from './dockerfile-sync'
import { pullRegistryImage } from './image-registry'
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

/**
 * Whether the registry image is equivalent to what a local build would produce.
 *
 * Any customisation — an explicit Dockerfile (`--dockerfile` /
 * config.dockerfilePath) or an edited ~/.ai-support-agent/Dockerfile — means it
 * is not, so the image has to be built locally. `allowPull` carries the user's
 * opt-out (`--no-image-pull` / config.dockerImagePull === 'never').
 *
 * Every rejection is logged: otherwise "why did this take another 40 minutes?"
 * has no answer anywhere in the output.
 */
function canUseRegistryImage(customDockerfile: string | undefined, allowPull: boolean): boolean {
  if (!allowPull) {
    logger.info(t('docker.pullDisabled'))
    return false
  }
  if (customDockerfile) {
    logger.info(t('docker.pullSkippedCustomDockerfile', { path: customDockerfile }))
    return false
  }
  if (isDockerfileCustomized()) {
    logger.info(t('docker.pullSkippedCustomized'))
    return false
  }
  return true
}

export function ensureImage(customDockerfile?: string, allowPull = true): string {
  const installedVersion = getInstalledVersion()
  // Use the installed version if it is newer than the compile-time version
  const version = isNewerVersion(AGENT_VERSION, installedVersion) ? installedVersion : AGENT_VERSION
  if (imageExists(version)) {
    logger.info(t('docker.imageFound', { version }))
    return version
  }
  // Pull first when nothing is customised: the registry image is what this very
  // Dockerfile builds, obtained in minutes instead of the better part of an
  // hour. pullRegistryImage() warns and returns false when the tag is not (yet)
  // there — npm publish precedes the image job, and versions before
  // 0.5.0-beta.2 have no image at all — or the host is offline, and we fall
  // through to a local build rather than failing to start.
  if (!(canUseRegistryImage(customDockerfile, allowPull) && pullRegistryImage(version))) {
    buildImage(version, customDockerfile)
  }
  // Only the version just obtained is still needed locally — remove older tags
  // now so disk usage doesn't grow unbounded across version bumps.
  pruneOldImages(version)
  return version
}
