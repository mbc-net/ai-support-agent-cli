import * as fs from 'fs'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { validateBindMountPathSync } from '../../security'

// Re-export the projectCode validator that now lives in `src/security.ts` so
// existing call sites (linux-service / darwin-service) can continue to import
// it from here. The actual implementation moved to avoid a layering
// inversion (the docker supervisor also needs it).
export { assertProjectCodeIsSafe } from '../../security'

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
