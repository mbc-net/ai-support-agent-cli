/**
 * Docker security utilities
 *
 * Package name validation to prevent Dockerfile injection.
 */

/** Allowlist for apt package names: letters, digits, hyphens, dots, plus signs, colons */
const APT_PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9+\-.:]*$/
/** Allowlist for npm package names: scoped (@scope/name) or plain, with version (@x.y.z) */
const NPM_PACKAGE_RE = /^(@[a-zA-Z0-9_\-.]+\/)?[a-zA-Z0-9_\-.]+(@[a-zA-Z0-9._\-^~*]+)?$/

/**
 * Validate a list of package names against an allowlist regex.
 * Throws if any name is invalid to prevent Dockerfile injection.
 */
export function validatePackageNames(packages: string[], type: 'apt' | 'npm'): void {
  const re = type === 'apt' ? APT_PACKAGE_RE : NPM_PACKAGE_RE
  for (const pkg of packages) {
    if (!re.test(pkg)) {
      throw new Error(`Invalid ${type} package name: "${pkg}"`)
    }
  }
}
