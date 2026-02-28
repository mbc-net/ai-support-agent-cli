import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ERR_NO_FILE_PATH_SPECIFIED } from './constants'
import type { CommandResult } from './types'
import { parseString } from './utils'

export const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{.*\};\s*:/,
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
      return `Blocked dangerous command pattern: ${pattern}`
    }
  }
  return null
}

export async function validateFilePath(filePath: string): Promise<string | null> {
  let resolved: string
  try {
    resolved = await fs.promises.realpath(filePath)
  } catch {
    // File does not exist yet (e.g. file_write new file) — resolve parent directory
    const parentDir = path.dirname(path.resolve(filePath))
    try {
      const realParent = await fs.promises.realpath(parentDir)
      resolved = path.join(realParent, path.basename(filePath))
    } catch {
      resolved = path.resolve(filePath)
    }
  }
  const allBlocked = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
  for (const prefix of allBlocked) {
    const prefixWithoutSlash = prefix.replace(/\/$/, '')
    if (resolved === prefixWithoutSlash || resolved.startsWith(prefix)) {
      return `Access denied: ${prefix} paths are blocked`
    }
  }
  return null
}

export async function resolveAndValidatePath(
  payload: { path?: unknown },
  defaultPath?: string,
): Promise<string | CommandResult> {
  const filePath = parseString(payload.path) ?? defaultPath ?? null
  if (!filePath) {
    return { success: false, error: ERR_NO_FILE_PATH_SPECIFIED }
  }
  const pathError = await validateFilePath(filePath)
  if (pathError) {
    return { success: false, error: pathError }
  }
  return filePath
}
