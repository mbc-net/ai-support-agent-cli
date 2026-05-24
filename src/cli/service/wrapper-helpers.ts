import * as fs from 'fs'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { validateBindMountPathSync } from '../../security'

/**
 * POSIX shell single-quote a value so it can be safely interpolated into a
 * bash script. Wraps the value in single quotes and escapes any embedded
 * single quote as `'\''`. The result is always exactly one shell argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Reject projectCodes whose characters would break the
 * `AI_SUPPORT_AGENT_PROJECT_DIR_MAP` env format.
 *
 * The env value uses `;` as entry separator and `=` as key/value separator;
 * a projectCode containing either would silently truncate the map and let
 * `resolveProjectDir()` fall back to the default template, silently
 * re-introducing the doubly-nested layout that the recent PRs are trying
 * to prevent. Allow `[A-Za-z0-9_-]` only — matching the configured naming
 * convention (UPPER_SNAKE_CASE for project, lower_snake_case for tenant).
 *
 * Also used by the supervisor path (`buildProjectVolumeMounts`) so the
 * fail-open isn't reintroduced via interactive mode.
 */
export function assertProjectCodeIsSafe(projectCode: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(projectCode)) {
    throw new Error(t('service.invalidProjectCode', { projectCode }))
  }
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
