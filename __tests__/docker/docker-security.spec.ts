/**
 * Tests for src/docker/docker-security.ts
 *
 * Covers validatePackageNames for both apt and npm package name allowlists,
 * ensuring Dockerfile injection is prevented.
 */

import { validatePackageNames } from '../../src/docker/docker-security'

describe('validatePackageNames - apt', () => {
  it('should accept simple lowercase package name', () => {
    expect(() => validatePackageNames(['curl'], 'apt')).not.toThrow()
  })

  it('should accept package name starting with uppercase letter', () => {
    expect(() => validatePackageNames(['OpenJDK'], 'apt')).not.toThrow()
  })

  it('should accept package name with hyphens', () => {
    expect(() => validatePackageNames(['build-essential'], 'apt')).not.toThrow()
  })

  it('should accept package name with dots', () => {
    expect(() => validatePackageNames(['python3.11'], 'apt')).not.toThrow()
  })

  it('should accept package name with plus signs', () => {
    expect(() => validatePackageNames(['g++'], 'apt')).not.toThrow()
  })

  it('should accept package name with colon (arch qualifier)', () => {
    expect(() => validatePackageNames(['libc6:amd64'], 'apt')).not.toThrow()
  })

  it('should accept multiple valid apt packages', () => {
    expect(() => validatePackageNames(['curl', 'git', 'build-essential'], 'apt')).not.toThrow()
  })

  it('should reject package name starting with a hyphen', () => {
    expect(() => validatePackageNames(['-bad'], 'apt')).toThrow('Invalid apt package name: "-bad"')
  })

  it('should reject package name with shell injection semicolon', () => {
    expect(() => validatePackageNames(['curl; rm -rf /'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should reject package name with shell injection ampersand', () => {
    expect(() => validatePackageNames(['curl && malicious'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should reject package name with spaces', () => {
    expect(() => validatePackageNames(['curl git'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should reject empty string', () => {
    expect(() => validatePackageNames([''], 'apt')).toThrow('Invalid apt package name')
  })

  it('should reject package name with backtick injection', () => {
    expect(() => validatePackageNames(['`whoami`'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should reject package name with dollar sign', () => {
    expect(() => validatePackageNames(['$HOME'], 'apt')).toThrow('Invalid apt package name')
  })

  it('should throw for the first invalid package in a mixed list', () => {
    expect(() => validatePackageNames(['curl', 'bad pkg', 'git'], 'apt')).toThrow('Invalid apt package name: "bad pkg"')
  })

  it('should accept all packages when entire list is valid', () => {
    expect(() => validatePackageNames(['curl', 'wget', 'git', 'g++', 'python3.11'], 'apt')).not.toThrow()
  })
})

describe('validatePackageNames - npm', () => {
  it('should accept simple package name', () => {
    expect(() => validatePackageNames(['lodash'], 'npm')).not.toThrow()
  })

  it('should accept scoped package', () => {
    expect(() => validatePackageNames(['@scope/package'], 'npm')).not.toThrow()
  })

  it('should accept scoped package with version', () => {
    expect(() => validatePackageNames(['@scope/package@1.2.3'], 'npm')).not.toThrow()
  })

  it('should accept plain package with version', () => {
    expect(() => validatePackageNames(['lodash@4.17.21'], 'npm')).not.toThrow()
  })

  it('should accept package with semver range version', () => {
    expect(() => validatePackageNames(['lodash@^4.0.0'], 'npm')).not.toThrow()
  })

  it('should accept package with tilde range version', () => {
    expect(() => validatePackageNames(['lodash@~4.17.0'], 'npm')).not.toThrow()
  })

  it('should accept package with wildcard version', () => {
    expect(() => validatePackageNames(['lodash@*'], 'npm')).not.toThrow()
  })

  it('should accept package name with hyphens and dots', () => {
    expect(() => validatePackageNames(['some-package.js'], 'npm')).not.toThrow()
  })

  it('should accept package name with underscores', () => {
    expect(() => validatePackageNames(['my_package'], 'npm')).not.toThrow()
  })

  it('should accept multiple valid npm packages', () => {
    expect(() => validatePackageNames(['lodash', '@types/node', 'typescript@5.0.0'], 'npm')).not.toThrow()
  })

  it('should reject package name with semicolon injection', () => {
    expect(() => validatePackageNames(['lodash; rm -rf /'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should reject package name with shell injection ampersand', () => {
    expect(() => validatePackageNames(['lodash && malicious'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should reject package name with spaces', () => {
    expect(() => validatePackageNames(['my package'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should reject empty string', () => {
    expect(() => validatePackageNames([''], 'npm')).toThrow('Invalid npm package name')
  })

  it('should reject package name with backtick injection', () => {
    expect(() => validatePackageNames(['`whoami`'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should reject package name starting with invalid character', () => {
    expect(() => validatePackageNames(['/etc/passwd'], 'npm')).toThrow('Invalid npm package name')
  })

  it('should throw for the first invalid package in a mixed list', () => {
    expect(() => validatePackageNames(['lodash', 'bad pkg', 'typescript'], 'npm')).toThrow('Invalid npm package name: "bad pkg"')
  })

  it('should accept empty array without throwing', () => {
    expect(() => validatePackageNames([], 'npm')).not.toThrow()
  })

  it('should accept empty array for apt without throwing', () => {
    expect(() => validatePackageNames([], 'apt')).not.toThrow()
  })
})
