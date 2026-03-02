import { execFile, execFileSync, spawn } from 'child_process'
import * as path from 'path'

import { NPM_INSTALL_TIMEOUT } from './constants'
import { logger } from './logger'
import type { InstallMethod, ReleaseChannel } from './types'

let cachedGlobalPrefix: string | null = null

/**
 * Get the global npm prefix path (e.g. /usr/local).
 * Result is cached after the first call.
 */
export function getGlobalNpmPrefix(): string {
  if (cachedGlobalPrefix !== null) return cachedGlobalPrefix
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = execFileSync(npmCmd, ['prefix', '-g'], {
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim()
  cachedGlobalPrefix = result
  return result
}

/**
 * Reset the cached global npm prefix (for testing).
 */
export function resetGlobalPrefixCache(): void {
  cachedGlobalPrefix = null
}

/**
 * Detect how the CLI was installed/started.
 * Priority: dev → npx → global → local
 */
export function detectInstallMethod(): InstallMethod {
  const scriptPath = process.argv[1] ?? ''
  const execArgvStr = process.execArgv.join(' ')

  // 1. Dev: ts-node or .ts file
  if (execArgvStr.includes('ts-node') || scriptPath.endsWith('.ts')) {
    return 'dev'
  }

  // 2. npx: path contains _npx
  if (scriptPath.includes('/_npx/') || scriptPath.includes('\\_npx\\')) {
    return 'npx'
  }

  // 3. Global: under npm global prefix
  try {
    const globalPrefix = getGlobalNpmPrefix()
    if (globalPrefix && scriptPath.startsWith(globalPrefix)) {
      return 'global'
    }
  } catch {
    // npm prefix -g failed → fall through to local
  }

  // 4. Local: fallback
  return 'local'
}

/**
 * バージョン文字列からリリースチャンネルを推定する。
 * e.g. "0.0.4-beta.21" → "beta", "0.0.4-alpha.3" → "alpha", "0.0.4" → "latest"
 */
export function detectChannelFromVersion(version: string): ReleaseChannel {
  const match = version.match(/^\d+\.\d+\.\d+-(\w+)/)
  if (match) {
    const tag = match[1]
    if (tag === 'beta') return 'beta'
    if (tag === 'alpha') return 'alpha'
  }
  return 'latest'
}

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
 * Resolve the global binary script path for @ai-support-agent/cli.
 */
function resolveGlobalBinaryScript(): string {
  const globalPrefix = getGlobalNpmPrefix()
  // Windows: {prefix}/node_modules/...  macOS/Linux: {prefix}/lib/node_modules/...
  const segments = process.platform === 'win32'
    ? [globalPrefix, 'node_modules', '@ai-support-agent', 'cli', 'dist', 'index.js']
    : [globalPrefix, 'lib', 'node_modules', '@ai-support-agent', 'cli', 'dist', 'index.js']
  return path.join(...segments)
}

/**
 * Run npm install command and return result.
 */
function execNpmCommand(
  npmCmd: string,
  args: string[],
  version: string,
): Promise<{ success: boolean; error?: string }> {
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
 * Install a specific version of the CLI package.
 * Only global and npx methods are supported for automatic update.
 */
export async function performUpdate(
  version: string,
  method?: InstallMethod,
): Promise<{ success: boolean; error?: string }> {
  const installMethod = method ?? detectInstallMethod()

  if (installMethod === 'dev') {
    return { success: false, error: 'Development mode: automatic update is not supported. Please update manually.' }
  }

  if (installMethod === 'local') {
    return { success: false, error: 'Local installation: automatic update is not supported. Run npm update in your project.' }
  }

  // global & npx: npm install -g
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['install', '-g', `@ai-support-agent/cli@${version}`]
  return execNpmCommand(npmCmd, args, version)
}

/**
 * Re-exec the current process with the same arguments.
 * Preserves process.execArgv (Node.js runtime flags) and environment variables.
 * For npx installs, resolves the global binary path instead of the stale npx cache path.
 */
export function reExecProcess(method?: InstallMethod): void {
  const installMethod = method ?? detectInstallMethod()

  let args: string[]

  if (installMethod === 'npx') {
    // npx cache path points to old version → use global install path
    const globalScript = resolveGlobalBinaryScript()
    args = [...process.execArgv, globalScript, ...process.argv.slice(2)]
  } else {
    // global / local / dev: re-exec with original argv, preserving execArgv
    args = [...process.execArgv, ...process.argv.slice(1)]
  }

  logger.info(`Re-executing: ${process.execPath} ${args.join(' ')}`)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env },
  })

  child.unref()
  process.exit(0)
}
