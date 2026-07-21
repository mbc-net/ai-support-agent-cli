/**
 * Dockerfile synchronization to config directory
 *
 * Copies the bundled Dockerfile and every asset it COPYs at image build time
 * to ~/.ai-support-agent/, so `docker build` (which uses the config dir as
 * its context once a synced Dockerfile exists there — see
 * resolveDockerfile()) can find every COPY source.
 *
 * Assets fall into two groups, handled differently:
 *   - The legacy pair (Dockerfile + entrypoint.sh): hash-protected, so a
 *     user's customisation survives future syncs (see
 *     syncDockerfileToConfigDir()'s own doc comment for the state machine).
 *   - New assets (tmux.conf, bashrc-extra.sh, nvim/init.lua, ...): simply
 *     copied whenever missing, with no hash protection — they can't be
 *     "customised" the first time they ever reach a user's config dir, and
 *     folding them into the legacy hash breaks that hash's meaning (see
 *     NEW_OPTIONAL_ASSETS' doc comment).
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

/**
 * entrypoint.sh is the original (pre-existing) optional asset: it is part of
 * the customisation-protected hash unit alongside the Dockerfile, exactly as
 * before this module gained other bundled assets.
 */
const LEGACY_OPTIONAL_ASSET = path.join('docker', 'entrypoint.sh')

/**
 * Docker build assets, beyond the Dockerfile itself, that the Dockerfile
 * COPYs from the build context. Each is optional in the bundle (older
 * published versions of this package may not have them yet), but any of
 * these present in the bundle must be synced or the next `docker build`
 * against the config-dir context breaks on a missing COPY source.
 *
 * Only LEGACY_OPTIONAL_ASSET is included in the customisation-protecting
 * hash (see NEW_OPTIONAL_ASSETS below for why the rest are deliberately
 * excluded).
 */
const OPTIONAL_DOCKER_ASSETS = [
  LEGACY_OPTIONAL_ASSET,
  path.join('docker', 'tmux.conf'),
  path.join('docker', 'bashrc-extra.sh'),
  path.join('docker', 'nvim', 'init.lua'),
]

/**
 * Assets added after the original Dockerfile+entrypoint.sh hash unit was
 * established. These are deliberately kept OUT of the combined hash: an
 * existing user's config dir can never have their dest yet (this is their
 * first sync since the asset was introduced), so treating a missing dest as
 * "hash mismatch" or lumping it into the same unconditional-overwrite check
 * as the Dockerfile would either spuriously warn forever or — worse —
 * silently overwrite a customised Dockerfile the moment any new asset here
 * is added (this happened: see dockerfile-sync.spec.ts's REGRESSION test).
 * They are simply copied whenever their dest doesn't exist yet, independent
 * of whether the Dockerfile/entrypoint.sh pair is customised.
 */
const NEW_OPTIONAL_ASSETS = OPTIONAL_DOCKER_ASSETS.filter((p) => p !== LEGACY_OPTIONAL_ASSET)

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
    const contextDir = getDockerContextDir()

    // Legacy pair: Dockerfile + entrypoint.sh (if bundled). This is the only
    // set covered by the customisation-protecting hash.
    const legacyPairs: SyncPair[] = [{ src: srcDockerfile, dest: destDockerfile }]
    const srcEntrypoint = path.join(contextDir, LEGACY_OPTIONAL_ASSET)
    if (fs.existsSync(srcEntrypoint)) {
      legacyPairs.push({ src: srcEntrypoint, dest: path.join(configDir, LEGACY_OPTIONAL_ASSET) })
    }

    // New assets: copied whenever missing, independent of the legacy hash
    // state (see NEW_OPTIONAL_ASSETS' doc comment for why).
    const newPairs: SyncPair[] = []
    for (const relPath of NEW_OPTIONAL_ASSETS) {
      const src = path.join(contextDir, relPath)
      if (fs.existsSync(src)) {
        newPairs.push({ src, dest: path.join(configDir, relPath) })
      }
    }
    const missingNewPairs = newPairs.filter((pair) => !fs.existsSync(pair.dest))
    if (missingNewPairs.length > 0) {
      copyPairs(configDir, missingNewPairs)
    }

    const legacyDestMissing = legacyPairs.some((pair) => !fs.existsSync(pair.dest))

    if (!fs.existsSync(hashFile) || legacyDestMissing) {
      // First run, existing user without hash file, or part of the legacy
      // pair was deleted — overwrite the pair unconditionally.
      // Remove the hash file before copying: if any copy fails midway, the
      // next run sees no hash file and retries this branch (self-heal)
      fs.rmSync(hashFile, { force: true })
      copyPairs(configDir, legacyPairs)
      atomicWriteFile(hashFile, combinedSha256(legacyPairs.map((pair) => pair.src)))
      logger.info(t('docker.dockerfileSynced', { path: destDockerfile }))
      return
    }

    // trim() guards against a stray trailing newline in the hash file
    const savedHash = fs.readFileSync(hashFile, 'utf-8').trim()
    const currentConfigHash = combinedSha256(legacyPairs.map((pair) => pair.dest))

    if (savedHash !== currentConfigHash) {
      // User has customised the Dockerfile or entrypoint.sh — warn and skip.
      // New assets (if any) were already copied above regardless: they
      // can't be "customised" the first time they're synced.
      logger.warn(t('docker.dockerfileCustomized', { path: destDockerfile }))
      return
    }

    // Not customised
    const bundledHash = combinedSha256(legacyPairs.map((pair) => pair.src))
    if (bundledHash === currentConfigHash) {
      // Legacy pair already up to date — no-op (new assets, if any, were
      // still copied above)
      return
    }
    // Bundled pair is newer — update. Remove the hash file first so a
    // partial copy is retried (not misjudged as customised) on the next run
    fs.rmSync(hashFile, { force: true })
    copyPairs(configDir, legacyPairs)
    atomicWriteFile(hashFile, bundledHash)
    logger.info(t('docker.dockerfileUpdated', { path: destDockerfile }))
  } catch (err: unknown) {
    logger.warn(t('docker.dockerfileSyncFailed', { message: getErrorMessage(err) }))
  }
}
