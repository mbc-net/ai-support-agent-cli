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
 *
 * Every read and write of a config-dir copy goes through utils/marker-file:
 * a symlink there is never followed (design §7.7). Reading one throws, which
 * the callers below turn into a warning and a skipped sync; writing replaces
 * the symlink itself instead of writing through it.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { getDockerfilePath, getDockerContextDir } from './dockerfile-path'
import { t } from '../i18n'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'
import {
  DOCKER_ASSET_MAX_BYTES,
  MARKER_FILE_MAX_BYTES,
  copyBundledFileNoFollow,
  ensureRealDirectoryChain,
  isRegularFileNoFollow,
  pathExistsNoFollow,
  readRegularFileNoFollow,
  writeFileNoFollow,
} from '../utils/marker-file'

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

/** Read a config-dir build asset without following a symlink; missing is an error. */
function readConfigAsset(filePath: string): Buffer {
  const content = readRegularFileNoFollow(filePath, DOCKER_ASSET_MAX_BYTES)
  if (content === undefined) throw new Error(`File not found: ${filePath}`)
  return content
}

/**
 * Read a bundled build asset (inside the installed npm package). No container
 * can write there, so it is read normally: package layouts that symlink
 * individual files (Nix, Bazel rules_js, ...) keep working.
 */
function readBundledAsset(filePath: string): Buffer {
  return fs.readFileSync(filePath)
}

/** Combined SHA-256 over the given files, hashed in order. */
function combinedSha256(filePaths: string[], read: (filePath: string) => Buffer): string {
  const hash = crypto.createHash('sha256')
  for (const filePath of filePaths) {
    const content = read(filePath)
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
    // The no-follow write covers the file name only; refuse a symlinked
    // directory below the config dir too (e.g. configDir/docker pointing
    // somewhere else). The config dir itself is the host user's choice.
    // Created one level at a time, each checked before anything is created
    // inside it: a recursive mkdir would follow a symlinked parent.
    const destDir = path.dirname(pair.dest)
    if (destDir !== configDir) ensureRealDirectoryChain(configDir, destDir)
    // The bundled source is read normally; only the config-dir destination
    // is written without following a symlink.
    copyBundledFileNoFollow(pair.src, pair.dest)
  }
}

/**
 * True when nothing is at `dest`, or only a dangling symlink. `stat` follows a
 * symlink only to see whether its target exists; the target is never read.
 */
function destIsMissing(dest: string): boolean {
  if (!pathExistsNoFollow(dest)) return true
  if (isRegularFileNoFollow(dest)) return false
  try {
    fs.statSync(dest)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true
    throw error
  }
}

/**
 * True when `pair.dest` is missing or its content differs from `pair.src`.
 * Used for the no-customisation-protection asset group: these are meant to
 * always mirror the bundle, so a stale (but present) config-dir copy from an
 * older CLI version must still be treated as needing a re-copy.
 */
function isOutOfDate(pair: SyncPair): boolean {
  // Missing (a dangling symlink included): replaced by a regular copy (the
  // write replaces the link itself). Any other non-regular file, such as a
  // live symlink the user placed, is refused by the read below and left as is.
  if (destIsMissing(pair.dest)) return true
  const dest = readRegularFileNoFollow(pair.dest, DOCKER_ASSET_MAX_BYTES)
  if (dest === undefined) return true // vanished since the check above
  return !readBundledAsset(pair.src).equals(dest)
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

    // A dangling symlink counts as missing (self-heal: the copy replaces the
    // link). A live symlink is present, and is refused when it is read (never
    // followed) rather than silently replaced.
    const legacyDestMissing = legacyPairs.some((pair) => destIsMissing(pair.dest))
    // undefined when there is no hash file (also when it vanished between
    // checks); a symlink or other non-regular file there throws (refused).
    const savedHashContent = readRegularFileNoFollow(hashFile, MARKER_FILE_MAX_BYTES)

    if (savedHashContent === undefined || legacyDestMissing) {
      // First run, existing user without hash file, or part of the legacy
      // pair was deleted — overwrite the pair unconditionally.
      // Remove the hash file before copying: if any copy fails midway, the
      // next run sees no hash file and retries this branch (self-heal)
      fs.rmSync(hashFile, { force: true })
      copyPairs(configDir, legacyPairs)
      writeFileNoFollow(hashFile, combinedSha256(legacyPairs.map((pair) => pair.src), readBundledAsset))
      logger.info(t('docker.dockerfileSynced', { path: destDockerfile }))
      return
    }

    // trim() guards against a stray trailing newline in the hash file
    const savedHash = savedHashContent.toString('utf-8').trim()
    const currentConfigHash = combinedSha256(legacyPairs.map((pair) => pair.dest), readConfigAsset)

    if (savedHash !== currentConfigHash) {
      // User has customised the Dockerfile or entrypoint.sh — warn and skip.
      // New assets (if any) were already copied above regardless: they
      // can't be "customised" the first time they're synced.
      logger.warn(t('docker.dockerfileCustomized', { path: destDockerfile }))
      return
    }

    // Not customised
    const bundledHash = combinedSha256(legacyPairs.map((pair) => pair.src), readBundledAsset)
    if (bundledHash === currentConfigHash) {
      // Legacy pair already up to date — no-op (new assets, if any, were
      // still copied above)
      return
    }
    // Bundled pair is newer — update. Remove the hash file first so a
    // partial copy is retried (not misjudged as customised) on the next run
    fs.rmSync(hashFile, { force: true })
    copyPairs(configDir, legacyPairs)
    writeFileNoFollow(hashFile, bundledHash)
    logger.info(t('docker.dockerfileUpdated', { path: destDockerfile }))
  } catch (err: unknown) {
    logger.warn(t('docker.dockerfileSyncFailed', { message: getErrorMessage(err) }))
  }
}

/**
 * True when `configDir/Dockerfile` exists but was never produced by
 * syncDockerfileToConfigDir() (no `.dockerfile-sync-hash` alongside it) — i.e.
 * a file the user placed there by hand.
 *
 * syncDockerfileToConfigDir() treats a missing hash file as "first run" and
 * overwrites the pair unconditionally, which is fine on the `start` path (it
 * has always done that) but would silently destroy a hand-placed Dockerfile
 * the first time a caller that never synced before starts syncing. Callers use
 * this to skip the sync entirely; isDockerfileCustomized() then reports the
 * file as customised, so the image is built from it rather than pulled.
 */
export function hasUnmanagedConfigDockerfile(): boolean {
  const configDir = getConfigDir()
  try {
    return (
      pathExistsNoFollow(path.join(configDir, 'Dockerfile')) &&
      !pathExistsNoFollow(path.join(configDir, '.dockerfile-sync-hash'))
    )
  } catch {
    // Unreadable config dir — assume unmanaged so nothing gets overwritten.
    return true
  }
}

/**
 * True when the image a local `docker build` would produce differs from the one
 * the release workflow published to the registry — i.e. pulling it is not
 * equivalent, because the user customised something in the build context.
 *
 * Covers the Dockerfile and every asset it COPYs (OPTIONAL_DOCKER_ASSETS:
 * entrypoint.sh, tmux.conf, bashrc-extra.sh, nvim/init.lua, starship.toml), not
 * just the Dockerfile: with `dockerfileSync: false` the sync that normally
 * keeps those assets identical to the bundle never runs, so a customised
 * tmux.conf survives and a pulled image would silently ignore it.
 *
 * An asset counts as customised only when its config-dir copy EXISTS and
 * differs. A missing copy is not a customisation — there is no user content to
 * preserve, and a local build would fail on the missing COPY source anyway, so
 * treating it as customised would trade a working pull for a broken build.
 *
 * Compares bytes against the CURRENT bundle rather than consulting
 * .dockerfile-sync-hash: with `--no-dockerfile-sync` (or after a failed sync)
 * the stored hash can still match a config-dir copy taken from an older CLI
 * version, and "stale" must not be mistaken for "identical to what CI built".
 * Anything unreadable counts as customised, so the fallback is always the safe
 * one — build locally rather than silently ignore a user's edits.
 *
 * This covers the config-dir copies only. An explicitly passed Dockerfile
 * (`--dockerfile` / config.dockerfilePath) is customised by definition and is
 * checked by the caller.
 */
export function isDockerfileCustomized(): boolean {
  const configDir = getConfigDir()
  try {
    const contextDir = getDockerContextDir()
    // getDockerfilePath() throws when the bundle has no Dockerfile, so this
    // pair always has a comparable source.
    const dockerfilePair: SyncPair = { src: getDockerfilePath(), dest: path.join(configDir, 'Dockerfile') }
    const assetPairs: SyncPair[] = OPTIONAL_DOCKER_ASSETS.map((relPath) => ({
      src: path.join(contextDir, relPath),
      dest: path.join(configDir, relPath),
    })).filter((pair) => fs.existsSync(pair.src)) // absent from this bundle — nothing to compare against

    // An absent config-dir copy carries no user content (see doc comment).
    return [dockerfilePair, ...assetPairs].some(
      (pair) => pathExistsNoFollow(pair.dest) && isOutOfDate(pair),
    )
  } catch (error) {
    // Counted as customised (a local build is the safe side), but say why:
    // a refused symlink or an I/O error must not look like a user edit.
    logger.warn(`[docker] Could not compare the config-dir Docker files with the bundle: ${getErrorMessage(error)}`)
    return true
  }
}
