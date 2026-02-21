import { execFile, spawn } from 'child_process'

import { NPM_INSTALL_TIMEOUT } from './constants'
import { logger } from './logger'

/**
 * Compare two semver strings.
 * Returns true if `latest` is newer than `current`.
 * Supports pre-release tags (e.g. 1.0.0-beta.1 < 1.0.0).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parseVersion = (v: string) => {
    const [main, pre] = v.split('-', 2)
    const parts = main.split('.').map(Number)
    return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0, pre }
  }

  const c = parseVersion(current)
  const l = parseVersion(latest)

  // Compare major.minor.patch
  if (l.major !== c.major) return l.major > c.major
  if (l.minor !== c.minor) return l.minor > c.minor
  if (l.patch !== c.patch) return l.patch > c.patch

  // Same major.minor.patch — pre-release vs release
  // Release (no pre) > pre-release
  if (c.pre && !l.pre) return true  // current is pre-release, latest is release
  if (!c.pre && l.pre) return false // current is release, latest is pre-release

  // Both have pre-release or both don't — same version
  if (!c.pre && !l.pre) return false

  // Both have pre-release — compare lexicographically
  return l.pre! > c.pre!
}

/**
 * Validate that a version string looks like semver.
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version)
}

/**
 * Install a specific version of the CLI package globally via npm.
 * Returns true on success, false on failure.
 */
export async function performUpdate(version: string): Promise<{ success: boolean; error?: string }> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['install', '-g', `@ai-support-agent/cli@${version}`]

  return new Promise((resolve) => {
    execFile(npmCmd, args, { timeout: NPM_INSTALL_TIMEOUT }, (error, _stdout, stderr) => {
      if (error) {
        const message = error.message || stderr || 'Unknown error'
        const isPermissionError = message.includes('EACCES') || message.includes('permission denied')

        if (isPermissionError) {
          resolve({
            success: false,
            error: `Permission denied. Try: sudo npm install -g @ai-support-agent/cli@${version}`,
          })
        } else {
          resolve({ success: false, error: message })
        }
        return
      }
      resolve({ success: true })
    })
  })
}

/**
 * Re-exec the current process with the same arguments.
 * Spawns a detached child and exits the current process.
 */
export function reExecProcess(): void {
  const args = process.argv.slice(1)

  logger.info(`Re-executing: ${process.execPath} ${args.join(' ')}`)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'inherit',
  })

  child.unref()
  process.exit(0)
}
