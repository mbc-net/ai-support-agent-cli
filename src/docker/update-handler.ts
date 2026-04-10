/**
 * Docker update and restart handler
 *
 * Called when a container exits with DOCKER_UPDATE_EXIT_CODE.
 * Installs the new version on the host and re-execs the process.
 */

import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { logger } from '../logger'
import { isValidVersion } from '../utils/version'
import { performUpdate, reExecProcess } from '../update-checker'
import { resetInstalledVersionCache } from './version-manager'

/**
 * Called on the host after a container exits with DOCKER_UPDATE_EXIT_CODE.
 * Reads the new version from a project-specific config dir (written by the container),
 * installs it on the host with npm, then re-execs the process so ensureImage()
 * picks up the newly installed version and rebuilds the Docker image.
 */
export async function installUpdateAndRestart(projectConfigDir?: string): Promise<void> {
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
      resetInstalledVersionCache()
    }
  }

  reExecProcess()
}
