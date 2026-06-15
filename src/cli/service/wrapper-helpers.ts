import * as fs from 'fs'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { isProjectCodeSafe, validateBindMountPathSync } from '../../security'
import type { ProjectRegistration } from '../../types'
import { sanitizeNameSegment } from '../../utils'

// Re-export the projectCode validators that now live in `src/security.ts` so
// existing call sites (linux-service / darwin-service) can continue to import
// them from here. The actual implementations moved to avoid a layering
// inversion (the docker supervisor also needs them).
export { assertProjectCodeIsSafe, isProjectCodeSafe } from '../../security'

// Re-export toContainerApiUrl from utils so that callers (darwin-service,
// linux-service, win32-service) can continue to import it from here without
// change.  The canonical implementation lives in utils.ts so that
// volume-mount-builder.ts can share it without a cli/ → docker/ layering
// inversion.
export { toContainerApiUrl } from '../../utils'

/**
 * POSIX shell single-quote a value so it can be safely interpolated into a
 * bash script. Wraps the value in single quotes and escapes any embedded
 * single quote as `'\''`. The result is always exactly one shell argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Sanitize one tenantCode / projectCode segment for use in generated names:
 * lowercase, with every character outside `[a-z0-9-]` collapsed to `-`.
 *
 * Shared by all three platforms so naming cannot drift: systemd unit names
 * and per-project log-dir keys (linux), docker container names (all
 * platforms), and scheduled-task names (win32). `detectInstallCollisions`
 * relies on its callers deriving names through this same mapping.
 *
 * Thin service-layer alias for the canonical `sanitizeNameSegment` in
 * `utils.ts`; the name is retained so the service-installer call sites read
 * intentfully ("service name segment").
 */
export function sanitizeServiceNameSegment(s: string): string {
  return sanitizeNameSegment(s)
}

/**
 * Validate a user-supplied `project.projectDir` for use as a bind mount.
 *
 * Returns the original value when the path is acceptable, or `undefined`
 * when it should be dropped (and the wrapper / supervisor should fall back
 * to the default per-project dir). Emits a warning so the user is aware
 * that their configured projectDir was ignored.
 *
 * Rejects: empty string, non-existent paths, and paths under
 * `BLOCKED_PATH_PREFIXES` / `getSensitiveHomePaths` (e.g. `/etc`,
 * `~/.ssh`). All three reasons end up at the same fallback to keep the
 * caller code simple.
 */
export function validateProjectDirForMount(projectDir: string | undefined): string | undefined {
  if (!projectDir) return undefined
  if (!fs.existsSync(projectDir)) {
    logger.warn(t('service.projectDirMissing', { path: projectDir }))
    return undefined
  }
  const blockedError = validateBindMountPathSync(projectDir)
  if (blockedError) {
    logger.warn(t('service.projectDirBlocked', { path: projectDir, message: blockedError }))
    return undefined
  }
  return projectDir
}

export interface CollisionInfo {
  /** The conflicting unit name / plist label (already sanitized). */
  name: string
  /** Other configured `<tenantCode>/<projectCode>` tuples mapping to the same name. */
  others: string[]
  /**
   * True when this FQN appears more than once in config (literal
   * duplicate entry). The caller should surface a different message in
   * that case ("remove the duplicate row" vs. "rename one of the codes").
   * `isDuplicate` and `others.length > 0` can BOTH be true when a config
   * contains both a literal duplicate AND a sanitize-collision sibling
   * (e.g. `[mbc/MBC_01, mbc/MBC_01, mbc/MBC-01]`).
   */
  isDuplicate: boolean
}

export interface CollisionDetectionResult {
  /**
   * FQN (`<tenantCode>/<projectCode>`) → sanitized unit-name / plist-label
   * for every project that passed `isProjectCodeSafe`. Callers that need
   * the sanitized name later (orphan-protection sets, unit-file paths)
   * can read it from here instead of recomputing via `nameFn`.
   */
  names: Map<string, string>
  /**
   * FQN → CollisionInfo for projects that conflict with another
   * configured entry (sanitize-collision and/or literal duplicate).
   * Projects without conflict are absent from this map.
   */
  collisions: Map<string, CollisionInfo>
}

/**
 * Detect sanitizeServiceNameSegment() collisions across configured projects.
 *
 * `nameFn` derives the per-platform unit-name / plist-label from
 * (tenantCode, projectCode). Codes that fail `isProjectCodeSafe` are
 * skipped from collision counting (they're refused independently by
 * `writeProjectServiceFiles`, and including them here would falsely
 * collide with a valid sibling like `MBC;01` + `MBC-01`).
 *
 * The returned `names` map covers ALL projects that passed validation
 * (single source of truth — callers should not recompute via `nameFn`
 * again). The `collisions` map only includes FQNs with a conflict.
 *
 * Shared between linux-service and darwin-service to keep the two
 * platforms from drifting on collision semantics.
 */
export function detectInstallCollisions(
  projects: ProjectRegistration[],
  nameFn: (tenantCode: string, projectCode: string) => string,
): CollisionDetectionResult {
  const names = new Map<string, string>()
  // First pass: bucket FQN tuples by sanitized name, skipping unsafe codes.
  // Keep duplicate FQNs in the array so we can detect literal duplicates
  // (`fqns.length > uniqueFqns.length`) independently of sanitize-collisions.
  const nameToFqns = new Map<string, string[]>()
  for (const project of projects) {
    if (!isProjectCodeSafe(project.tenantCode) || !isProjectCodeSafe(project.projectCode)) continue
    const name = nameFn(project.tenantCode, project.projectCode)
    const fqn = `${project.tenantCode}/${project.projectCode}`
    names.set(fqn, name)
    const existing = nameToFqns.get(name)
    if (existing) existing.push(fqn)
    else nameToFqns.set(name, [fqn])
  }
  // Second pass: report a CollisionInfo entry for any FQN involved in a
  // sanitize-collision OR a literal duplicate.
  const collisions = new Map<string, CollisionInfo>()
  for (const [name, fqns] of nameToFqns) {
    const uniqueFqns = Array.from(new Set(fqns))
    // No conflict at all: one entry, listed once.
    if (fqns.length === 1) continue
    // Count occurrences per FQN to detect literal duplicates.
    const fqnCounts = new Map<string, number>()
    for (const fqn of fqns) fqnCounts.set(fqn, (fqnCounts.get(fqn) ?? 0) + 1)
    for (const fqn of uniqueFqns) {
      const others = uniqueFqns.filter((f) => f !== fqn)
      const isDuplicate = (fqnCounts.get(fqn) ?? 0) > 1
      collisions.set(fqn, { name, others, isDuplicate })
    }
  }
  return { names, collisions }
}
