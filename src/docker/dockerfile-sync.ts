/**
 * Dockerfile synchronization to config directory
 *
 * Copies the bundled Dockerfile and entrypoint.sh as one snapshot to
 * ~/.ai-support-agent/ using hash-based comparison so user customisations
 * are preserved across updates. The Dockerfile COPYs docker/entrypoint.sh
 * at image build time, so both files must always be updated together —
 * a stale entrypoint.sh would otherwise be baked into the next image build.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { getDockerfilePath, getDockerContextDir } from './dockerfile-path'
import { t } from '../i18n'
import { logger } from '../logger'
import { atomicWriteFile, getErrorMessage } from '../utils'

/** A bundled source file and its destination in the config directory. */
interface SyncPair {
  src: string
  dest: string
}

/** Combined SHA-256 over the given files, hashed in order. */
function combinedSha256(filePaths: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const filePath of filePaths) {
    const content = fs.readFileSync(filePath)
    // Length prefix keeps file boundaries distinct so different splits of the
    // same concatenated bytes cannot collide
    hash.update(`${content.length}\n`)
    hash.update(content)
  }
  return hash.digest('hex')
}

/** Copy every pair, creating the destination directories as needed. */
function copyPairs(configDir: string, pairs: SyncPair[]): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  for (const pair of pairs) {
    fs.mkdirSync(path.dirname(pair.dest), { recursive: true })
    fs.copyFileSync(pair.src, pair.dest)
  }
}

/**
 * Copy the bundled Dockerfile + entrypoint.sh pair to the config directory.
 * The pair is treated as one sync unit: a combined hash over both files is
 * stored in .dockerfile-sync-hash to detect user customisations:
 *   - No hash file or any destination file missing → overwrite the pair
 *     unconditionally and record the bundled combined hash
 *   - Hash matches current config pair → update if the bundled pair differs
 *   - Hash mismatch → user has customised either file, warn and skip
 * entrypoint.sh may be absent from the bundle, in which case the Dockerfile
 * alone forms the sync unit.
 */
export function syncDockerfileToConfigDir(): void {
  const configDir = getConfigDir()
  const destDockerfile = path.join(configDir, 'Dockerfile')
  const hashFile = path.join(configDir, '.dockerfile-sync-hash')

  try {
    // getDockerfilePath throws when the bundled Dockerfile is missing —
    // keep it inside the try so a broken bundle degrades to a warning
    const srcDockerfile = getDockerfilePath()
    const srcEntrypoint = path.join(getDockerContextDir(), 'docker', 'entrypoint.sh')

    const pairs: SyncPair[] = [{ src: srcDockerfile, dest: destDockerfile }]
    if (fs.existsSync(srcEntrypoint)) {
      pairs.push({ src: srcEntrypoint, dest: path.join(configDir, 'docker', 'entrypoint.sh') })
    }

    const destMissing = pairs.some((pair) => !fs.existsSync(pair.dest))

    if (!fs.existsSync(hashFile) || destMissing) {
      // First run, existing user without hash file, or part of the config
      // pair was deleted — overwrite the pair unconditionally.
      // Remove the hash file before copying: if any copy fails midway, the
      // next run sees no hash file and retries this branch (self-heal)
      fs.rmSync(hashFile, { force: true })
      copyPairs(configDir, pairs)
      atomicWriteFile(hashFile, combinedSha256(pairs.map((pair) => pair.src)))
      logger.info(t('docker.dockerfileSynced', { path: destDockerfile }))
      return
    }

    // trim() guards against a stray trailing newline in the hash file
    const savedHash = fs.readFileSync(hashFile, 'utf-8').trim()
    const currentConfigHash = combinedSha256(pairs.map((pair) => pair.dest))

    if (savedHash !== currentConfigHash) {
      // User has customised the Dockerfile or entrypoint.sh — warn and skip
      // (no need to hash the bundled pair on this path)
      logger.warn(t('docker.dockerfileCustomized', { path: destDockerfile }))
      return
    }

    // Not customised
    const bundledHash = combinedSha256(pairs.map((pair) => pair.src))
    if (bundledHash === currentConfigHash) {
      // Already up to date — no-op
      return
    }
    // Bundled pair is newer — update. Remove the hash file first so a
    // partial copy is retried (not misjudged as customised) on the next run
    fs.rmSync(hashFile, { force: true })
    copyPairs(configDir, pairs)
    atomicWriteFile(hashFile, bundledHash)
    logger.info(t('docker.dockerfileUpdated', { path: destDockerfile }))
  } catch (err: unknown) {
    logger.warn(t('docker.dockerfileSyncFailed', { message: getErrorMessage(err) }))
  }
}
