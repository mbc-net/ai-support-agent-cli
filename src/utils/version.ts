/**
 * Semver utility functions shared between update-checker and docker-runner.
 * Kept in utils/ to avoid circular imports between those two modules.
 */

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
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(version)
}
