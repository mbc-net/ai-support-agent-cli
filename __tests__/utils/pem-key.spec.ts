import { normalizePemKey } from '../../src/utils/pem-key'

describe('normalizePemKey', () => {
  it('should return key as-is if it already contains newlines', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n'
    expect(normalizePemKey(key)).toBe(key)
  })

  it('should add trailing newline if missing', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'
    expect(normalizePemKey(key)).toBe(key + '\n')
  })

  it('should return key as-is if no PEM header/footer', () => {
    const key = 'not-a-pem-key'
    expect(normalizePemKey(key)).toBe(key)
  })

  it('should wrap single-line PEM key at 64 characters', () => {
    const body = 'A'.repeat(128)
    const key = `-----BEGIN RSA PRIVATE KEY-----${body}-----END RSA PRIVATE KEY-----`
    const result = normalizePemKey(key)
    const lines = result.split('\n')
    expect(lines[0]).toBe('-----BEGIN RSA PRIVATE KEY-----')
    expect(lines[1]).toBe('A'.repeat(64))
    expect(lines[2]).toBe('A'.repeat(64))
    expect(lines[3]).toBe('-----END RSA PRIVATE KEY-----')
  })

  it('should handle empty body between header and footer', () => {
    const key = '-----BEGIN RSA PRIVATE KEY----------END RSA PRIVATE KEY-----'
    const result = normalizePemKey(key)
    expect(result).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(result).toContain('-----END RSA PRIVATE KEY-----')
  })
})
