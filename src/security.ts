import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ERR_NO_FILE_PATH_SPECIFIED } from './constants'
import { t } from './i18n'
import type { CommandResult } from './types'
import { parseString, stripTrailingSlash } from './utils'

export const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!\w)/,  // rm -f /, rm / etc.
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /\bdd\s+.*if=\/dev\/sd/,                         // dd if=/dev/sda (data exfiltration)
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bchmod\s+.*\s+\/(?!\w)/,                       // chmod on root
  /\bchown\s+.*\s+\/(?!\w)/,                       // chown on root
  // curl/wget data exfiltration and remote code execution
  /\bcurl\b.*\s(-d|--data|--data-raw|--data-binary|--upload-file|-T|-F|--form)\b/i,
  /\bwget\b.*\s(--post-data|--post-file|--body-data|--body-file)\b/i,
  /\bcurl\b.*\s-[A-Za-z]*d[A-Za-z]*\s+@/i,        // curl -d @file (file content upload)
  /\bcurl\b[^|]*\|\s*(ba?sh|sh|zsh|python\d*|ruby|perl|node)\b/i,  // curl | sh (remote execution)
  /\bwget\b[^|]*\|\s*(ba?sh|sh|zsh|python\d*|ruby|perl|node)\b/i,  // wget | sh (remote execution)
]

export const BLOCKED_PATH_PREFIXES = [
  '/etc/', '/proc/', '/sys/', '/dev/',
  // macOS: /etc → /private/etc, etc.
  '/private/etc/', '/private/var/db/',
]

export const ALLOWED_SIGNALS: ReadonlySet<string> = new Set([
  'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGINT', 'SIGHUP',
])

export const SAFE_ENV_KEYS: readonly string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_MESSAGES',
  'TERM', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV',
  // Windows
  'SystemRoot', 'USERPROFILE', 'APPDATA', 'PATHEXT', 'COMSPEC',
  // ECS oneshot: the API injects inbound-webhook context via containerEnv so an
  // `execute_command` shell can read it. WEBHOOK_TRIGGERED=true marks a webhook
  // start (even with no body), WEBHOOK_BODY carries the serialized request body
  // (size-capped), and WEBHOOK_BODY_TRUNCATED=true signals the body was trimmed.
  // These are only ever set inside the oneshot container; absent for resident
  // agents, so exposing them here is safe (untrusted external data — the executed
  // command decides how to use it).
  'WEBHOOK_TRIGGERED',
  'WEBHOOK_BODY',
  'WEBHOOK_BODY_TRUNCATED',
  // Dockerfile sets these for interactive terminal tooling (starship prompt
  // config, default editor), but they were missing from this allowlist so
  // buildSafeEnv() silently dropped them — real terminal sessions never saw
  // the Docker-configured starship/editor setup.
  //
  // XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME are
  // deliberately NOT included here (nor are they a Dockerfile-level ENV
  // anymore): they only matter for nvim, which now gets them from a wrapper
  // script scoped to its own process (see docker/Dockerfile's
  // /opt/nvim/bin/nvim wrapper). Passing them through to the whole shell
  // would redirect every other XDG-Base-Directory-compliant CLI (e.g. `gh`,
  // `glab`) to these nvim-specific, world-writable directories — e.g. `gh
  // auth login` would write its auth token to a world-writable directory
  // instead of $HOME/.config/gh.
  'STARSHIP_CONFIG',
  'EDITOR',
  'VISUAL',
]

export function getSensitiveHomePaths(): string[] {
  const home = os.homedir()
  return ['.ssh', '.aws', '.gnupg', '.config/gcloud'].map(
    (dir) => path.join(home, dir) + '/',
  )
}

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  return env
}

export function validateCommand(command: string): string | null {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return 'Command blocked: contains a prohibited pattern'
    }
  }
  return null
}

/**
 * Pure predicate variant of `assertProjectCodeIsSafe`. Use this when you
 * only need a yes/no answer (e.g. pre-pass filters) without paying the
 * i18n + Error construction cost the assert variant incurs on every
 * rejected input.
 */
export function isProjectCodeSafe(projectCode: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(projectCode)
}

/**
 * Reject projectCodes / tenantCodes whose characters would break the
 * `AI_SUPPORT_AGENT_PROJECT_DIR_MAP` env format.
 *
 * The env value uses `;` as entry separator and `=` as key/value separator;
 * a code containing either would silently truncate the map and let
 * `resolveProjectDir()` fall back to the default template, silently
 * re-introducing the doubly-nested layout the recent fixes prevent.
 * Allow `[A-Za-z0-9_-]` only — matching the naming convention
 * (UPPER_SNAKE_CASE for project, lower_snake_case for tenant).
 *
 * Lives in `security.ts` (not `cli/service/wrapper-helpers.ts`) because
 * it's called by both the install path (cli/service/*) AND the docker
 * supervisor path (docker/volume-mount-builder.ts). Keeping it here
 * avoids a layering inversion where `docker/*` reaches into `cli/*`.
 */
export function assertProjectCodeIsSafe(projectCode: string): void {
  if (!isProjectCodeSafe(projectCode)) {
    throw new Error(t('service.invalidProjectCode', { projectCode }))
  }
}

/**
 * Synchronous variant of `validateFilePath`'s blocked-prefix check, for use
 * at script-generation / install time where async fs APIs aren't available.
 * Resolves the path via `realpathSync` when possible (falls back to the raw
 * path) and reports a blocking prefix if any. Returns `null` when the path
 * is OK to bind-mount into a container.
 */
export function validateBindMountPathSync(hostPath: string): string | null {
  // Empty / falsy / whitespace-only path: reject up front. `fs.realpathSync('')`
  // returns the process cwd (and `realpathSync(' ')` throws → falls back to
  // `path.resolve(' ')` = `<cwd>/ `) which then likely passes the
  // blocked-prefix check, making the function answer "safe" for what is
  // clearly a misconfigured value.
  if (!hostPath || !hostPath.trim()) {
    return 'Access denied: empty path'
  }
  let resolved: string
  try {
    const real = fs.realpathSync(hostPath)
    resolved = typeof real === 'string' && real.length > 0 ? real : path.resolve(hostPath)
  } catch {
    resolved = path.resolve(hostPath)
  }
  const allBlocked = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
  for (const prefix of allBlocked) {
    const prefixWithoutSlash = stripTrailingSlash(prefix)
    if (resolved === prefixWithoutSlash || resolved.startsWith(prefix)) {
      return `Access denied: ${prefix} paths are blocked`
    }
  }
  return null
}

export async function validateFilePath(filePath: string, baseDir?: string): Promise<string | null> {
  // Resolve relative paths against baseDir (project directory) when provided
  const toResolve = baseDir && !path.isAbsolute(filePath) ? path.resolve(baseDir, filePath) : filePath
  let resolved: string
  try {
    resolved = await fs.promises.realpath(toResolve)
  } catch {
    // File does not exist yet (e.g. file_write new file) — resolve parent directory
    const parentDir = path.dirname(path.resolve(baseDir ?? '', toResolve))
    try {
      const realParent = await fs.promises.realpath(parentDir)
      resolved = path.join(realParent, path.basename(toResolve))
    } catch {
      resolved = path.resolve(baseDir ?? '', toResolve)
    }
  }
  const allBlocked = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
  for (const prefix of allBlocked) {
    const prefixWithoutSlash = stripTrailingSlash(prefix)
    if (resolved === prefixWithoutSlash || resolved.startsWith(prefix)) {
      return `Access denied: ${prefix} paths are blocked`
    }
  }
  return null
}

export async function resolveAndValidatePath(
  payload: { path?: unknown },
  defaultPath?: string,
  baseDir?: string,
): Promise<string | CommandResult> {
  const filePath = parseString(payload.path) ?? defaultPath ?? null
  if (!filePath) {
    return { success: false, error: ERR_NO_FILE_PATH_SPECIFIED }
  }
  const pathError = await validateFilePath(filePath, baseDir)
  if (pathError) {
    return { success: false, error: pathError }
  }
  // Return the resolved absolute path when baseDir is used
  if (baseDir && !path.isAbsolute(filePath)) {
    return path.resolve(baseDir, filePath)
  }
  return filePath
}
