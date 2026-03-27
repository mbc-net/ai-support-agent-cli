import { isNewerVersion, isValidVersion } from '../../src/utils/version'

describe('isNewerVersion', () => {
  it('should return true when latest has higher major version', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
  })

  it('should return true when latest has higher minor version', () => {
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
  })

  it('should return true when latest has higher patch version', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
  })

  it('should return false when versions are identical', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('should return false when current is newer', () => {
    expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
  })

  it('should return true when current is pre-release and latest is release', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(true)
  })

  it('should return false when current is release and latest is pre-release', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).toBe(false)
  })

  it('should compare pre-release versions lexicographically', () => {
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(true)
  })

  it('should return false when pre-release versions are identical', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false)
  })

  it('should handle major version difference regardless of pre-release', () => {
    expect(isNewerVersion('1.0.0-beta.1', '2.0.0-alpha.1')).toBe(true)
  })

  it('should handle incomplete version strings with missing parts', () => {
    expect(isNewerVersion('1', '2')).toBe(true)
    expect(isNewerVersion('1.0', '1.1')).toBe(true)
  })
})

describe('isValidVersion', () => {
  it('should accept valid semver', () => {
    expect(isValidVersion('1.0.0')).toBe(true)
    expect(isValidVersion('1.2.3')).toBe(true)
    expect(isValidVersion('0.0.1')).toBe(true)
  })

  it('should accept semver with pre-release', () => {
    expect(isValidVersion('1.0.0-beta.1')).toBe(true)
    expect(isValidVersion('1.0.0-alpha.3')).toBe(true)
  })

  it('should reject invalid versions', () => {
    expect(isValidVersion('invalid')).toBe(false)
    expect(isValidVersion('1.0')).toBe(false)
    expect(isValidVersion('')).toBe(false)
  })

  it('should reject versions with trailing arbitrary content', () => {
    expect(isValidVersion('1.0.0; rm -rf /')).toBe(false)
    expect(isValidVersion('1.0.0<script>')).toBe(false)
    expect(isValidVersion('1.0.0 malicious')).toBe(false)
    expect(isValidVersion('1.0.0-')).toBe(false)
  })
})
