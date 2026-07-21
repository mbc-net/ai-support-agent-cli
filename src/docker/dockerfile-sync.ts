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
 *   - New assets (tmux.conf, bashrc-extra.sh, nvim/init.lua, ...): kept in
 *     sync with the bundle on every run (copied whenever the config-dir
 *     copy is missing OR its content differs from the bundled version), with
 *     no customisation protection — they can't be "customised" the first
 *     time they ever reach a user's config dir, and folding them into the
 *     legacy hash breaks that hash's meaning (see NEW_OPTIONAL_ASSETS' doc
 *     comment). Comparing content (not just existence) is required: a user
 *     who already synced an older version of one of these files must still
 *     receive later bundle updates on their next sync, or the fix in that
 *     later bundle version never reaches them no matter how many times they
 *     upgrade the CLI (see the REGRESSION test in dockerfile-sync.spec.ts).
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
export const OPTIONAL_DOCKER_ASSETS = [
  LEGACY_OPTIONAL_ASSET,
  path.join('docker', 'tmux.conf'),
  path.join('docker', 'bashrc-extra.sh'),
  path.join('docker', 'nvim', 'init.lua'),
  path.join('docker', 'starship.toml'),
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
 * They are kept in sync with the bundle whenever their dest is missing OR
 * its content differs from the bundled version (see isOutOfDate), no matter
 * how many times the CLI has been upgraded since the dest was first synced —
 * "copy only if the dest doesn't exist yet" left later bundle fixes to these
 * files permanently unreachable for anyone who had already synced an older
 * copy (this also happened: see the "already-synced ... IS re-copied"
 * REGRESSION test). This is all independent of whether the
 * Dockerfile/entrypoint.sh pair is customised.
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
 * True when `pair.dest` is missing or its content differs from `pair.src`.
 * Used for the no-customisation-protection asset group: these are meant to
 * always mirror the bundle, so a stale (but present) config-dir copy from an
 * older CLI version must still be treated as needing a re-copy.
 */
function isOutOfDate(pair: SyncPair): boolean {
  if (!fs.existsSync(pair.dest)) return true
  return !fs.readFileSync(pair.src).equals(fs.readFileSync(pair.dest))
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

    // New assets: kept in sync with the bundle whenever missing OR stale,
    // independent of the legacy hash state (see NEW_OPTIONAL_ASSETS' doc
    // comment for why). Each asset's staleness check now reads both its
    // bundled and config-dir content (isOutOfDate), which — unlike the old
    // fs.existsSync-only check — can throw (unreadable dest, permissions,
    // a symlink race, ...). That must not take down the legacy
    // Dockerfile+entrypoint.sh sync below, which is unrelated and more
    // important, so each asset is isolated in its own try/catch rather than
    // letting one bad file abort the whole function via the outer catch.
    for (const relPath of NEW_OPTIONAL_ASSETS) {
      const src = path.join(contextDir, relPath)
      if (!fs.existsSync(src)) continue
      const pair: SyncPair = { src, dest: path.join(configDir, relPath) }
      try {
        if (isOutOfDate(pair)) {
          copyPairs(configDir, [pair])
          logger.info(t('docker.dockerAssetSynced', { path: pair.dest }))
        }
      } catch (err: unknown) {
        logger.warn(t('docker.dockerAssetSyncFailed', { path: pair.dest, message: getErrorMessage(err) }))
      }
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
