/**
 * Dockerfile synchronization to config directory
 *
 * Copies the bundled Dockerfile to ~/.ai-support-agent/ on first run
 * so users can customise it without modifying the package.
 */

import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { getDockerfilePath, getDockerContextDir } from './dockerfile-path'
import { t } from '../i18n'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'

/**
 * Copy the bundled Dockerfile (and entrypoint.sh) to the config directory
 * on first run so users can customise it.
 * Does NOT overwrite an existing file — user edits are preserved.
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
  } catch (err: unknown) {
    logger.warn(t('docker.dockerfileSyncFailed', { message: getErrorMessage(err) }))
  }
}
