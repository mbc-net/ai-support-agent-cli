/**
 * Registry image pull
 *
 * The image published by .github/workflows/ci-cd.yml (publish_image) is built
 * from this repository's docker/Dockerfile with the same AGENT_VERSION build-arg
 * that buildImage() passes, so for an unmodified Dockerfile a local build only
 * reproduces what CI already produced — at the cost of compiling neovim from
 * source, installing a rust toolchain and Playwright's dependencies on the
 * user's machine (CI budgets 120 minutes for that job).
 *
 * Pulling is therefore the fast path; buildImage() remains the fallback, and the
 * only path whenever the Dockerfile is customised (see canUseRegistryImage() in
 * version-manager.ts).
 */

import { execFileSync } from 'child_process'

import { IMAGE_NAME, execErrorMessage, getDockerPath } from './docker-utils'
import { t } from '../i18n'
import { logger } from '../logger'

/**
 * Public multi-arch (linux/amd64 + linux/arm64) image published by the release
 * workflow — the same repository manifest-generator.ts points at with
 * DEFAULT_AGENT_IMAGE.
 */
export const REGISTRY_IMAGE = 'ghcr.io/mbc-net/ai-support-agent-cli'

/**
 * Upper bound for `docker pull`. Deliberately generous: the image is ~2.6 GB
 * compressed, so a slow link legitimately needs a long time, and expiring early
 * trades a working pull for an hour-long local build. It exists only so a
 * connection that stalls forever (one-way network loss, a proxy that accepts
 * the connection and never answers) cannot block agent startup indefinitely —
 * without it there is nothing to fall back from, since the fallback only
 * triggers on a *failed* pull, never on a hung one.
 */
export const PULL_TIMEOUT_MS = 30 * 60_000

/** Upper bound for the local-only `docker tag` / `docker rmi` calls. */
export const TAG_TIMEOUT_MS = 60_000

/**
 * Pull `REGISTRY_IMAGE:<version>` and tag it as `IMAGE_NAME:<version>` so every
 * downstream consumer (DockerSupervisor, the per-project `FROM
 * ai-support-agent:<version>` images, the service wrapper scripts) keeps
 * referring to the local name it always has.
 *
 * Returns false — with a warning, never silently — on any failure so the caller
 * can fall back to a local build. Not every version is on the registry: image
 * publishing only started at 0.5.0-beta.2, npm publishes minutes before the
 * image job finishes (so a just-released version is briefly npm-only), an image
 * job can fail outright, and the host may simply be offline.
 */
export function pullRegistryImage(version: string): boolean {
  const remoteRef = `${REGISTRY_IMAGE}:${version}`
  try {
    logger.info(t('docker.pulling', { ref: remoteRef }))
    execFileSync(getDockerPath(), ['pull', remoteRef], { stdio: 'inherit', timeout: PULL_TIMEOUT_MS })
  } catch (err: unknown) {
    logger.warn(t('docker.pullFailed', { ref: remoteRef, message: execErrorMessage(err) }))
    return false
  }

  // From here the layers are on disk under `remoteRef`, so every exit path must
  // drop that reference — see the cleanup below.
  let tagged = false
  try {
    execFileSync(getDockerPath(), ['tag', remoteRef, `${IMAGE_NAME}:${version}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: TAG_TIMEOUT_MS,
    })
    tagged = true
  } catch (err: unknown) {
    // Distinct from docker.pullFailed: the pull itself succeeded here, and
    // reporting it as a pull failure sends troubleshooting the wrong way.
    logger.warn(t('docker.tagFailed', { ref: remoteRef, message: execErrorMessage(err) }))
  }

  // Drop the registry reference whether or not tagging worked.
  //  - Tagged: this only removes the extra name. Leaving it would keep a
  //    superseded version alive after pruneOldImages() removed
  //    `ai-support-agent:<old>` — pruning only sweeps the IMAGE_NAME repository
  //    — so the disk would never be reclaimed.
  //  - Not tagged: this is the only reference, so removing it reclaims the
  //    multi-GB download instead of leaking it (nothing else ever collects it).
  // Best-effort either way: a failure here must not turn a successful pull into
  // a full rebuild.
  try {
    execFileSync(getDockerPath(), ['rmi', remoteRef], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: TAG_TIMEOUT_MS,
    })
  } catch (err: unknown) {
    logger.warn(t('docker.registryTagRemoveFailed', { ref: remoteRef, message: execErrorMessage(err) }))
  }

  if (!tagged) return false

  logger.success(t('docker.pullComplete', { version }))
  return true
}
