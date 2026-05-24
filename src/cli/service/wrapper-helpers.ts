import * as fs from 'fs'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { isProjectCodeSafe, validateBindMountPathSync } from '../../security'
import type { ProjectRegistration } from '../../types'

// Re-export the projectCode validators that now live in `src/security.ts` so
// existing call sites (linux-service / darwin-service) can continue to import
// them from here. The actual implementations moved to avoid a layering
// inversion (the docker supervisor also needs them).
export { assertProjectCodeIsSafe, isProjectCodeSafe } from '../../security'

/**
 * POSIX shell single-quote a value so it can be safely interpolated into a
 * bash script. Wraps the value in single quotes and escapes any embedded
 * single quote as `'\''`. The result is always exactly one shell argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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
}

/**
 * Detect sanitize() collisions across configured projects.
 *
 * `nameFn` derives the per-platform unit-name / plist-label from
 * (tenantCode, projectCode). Codes that fail `isProjectCodeSafe` are
 * skipped (they're refused independently by writeProjectServiceFiles, and
 * including them here would falsely collide with a valid sibling like
 * `MBC;01` + `MBC-01`).
 *
 * Returns a Map keyed by FQN (`<tenant>/<project>`) where each value is
 * `CollisionInfo` describing the conflict. Projects without a collision
 * are absent from the map (caller iterates `projects` and probes by FQN).
 *
 * Shared between linux-service and darwin-service to keep the two
 * platforms from drifting on collision semantics.
 */
export function detectInstallCollisions(
  projects: ProjectRegistration[],
  nameFn: (tenantCode: string, projectCode: string) => string,
): Map<string, CollisionInfo> {
  // First pass: bucket FQN tuples by sanitized name, skipping unsafe codes.
  const nameToFqns = new Map<string, string[]>()
  for (const project of projects) {
    if (!isProjectCodeSafe(project.tenantCode) || !isProjectCodeSafe(project.projectCode)) continue
    const name = nameFn(project.tenantCode, project.projectCode)
    const fqn = `${project.tenantCode}/${project.projectCode}`
    const existing = nameToFqns.get(name)
    if (existing) existing.push(fqn)
    else nameToFqns.set(name, [fqn])
  }
  // Second pass: project FQN → CollisionInfo for entries with >1 mapping.
  const collisions = new Map<string, CollisionInfo>()
  for (const [name, fqns] of nameToFqns) {
    if (fqns.length <= 1) continue
    // Deduplicate per-fqn: each unique FQN gets one CollisionInfo entry.
    const uniqueFqns = Array.from(new Set(fqns))
    for (const fqn of uniqueFqns) {
      const others = uniqueFqns.filter((f) => f !== fqn)
      collisions.set(fqn, { name, others })
    }
  }
  return collisions
}
