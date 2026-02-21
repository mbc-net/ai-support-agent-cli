import { getErrorMessage, parseString, parseNumber, validateApiUrl } from '../src/utils'

describe('getErrorMessage', () => {
  it('should return message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error')
  })

  it('should return string as-is', () => {
    expect(getErrorMessage('string error')).toBe('string error')
  })

  it('should convert number to string', () => {
    expect(getErrorMessage(42)).toBe('42')
  })

  it('should convert null to string', () => {
    expect(getErrorMessage(null)).toBe('null')
  })

  it('should convert undefined to string', () => {
    expect(getErrorMessage(undefined)).toBe('undefined')
  })

  it('should handle TypeError', () => {
    expect(getErrorMessage(new TypeError('type error'))).toBe('type error')
  })
})

describe('parseString', () => {
  it('should return non-empty string as-is', () => {
    expect(parseString('hello')).toBe('hello')
  })

  it('should return null for empty string', () => {
    expect(parseString('')).toBeNull()
  })

  it('should return null for non-string types', () => {
    expect(parseString(123)).toBeNull()
    expect(parseString(null)).toBeNull()
    expect(parseString(undefined)).toBeNull()
  })

  it('should return null for boolean', () => {
    expect(parseString(true)).toBeNull()
  })
})

describe('parseNumber', () => {
  it('should return valid number as-is', () => {
    expect(parseNumber(42)).toBe(42)
    expect(parseNumber(0)).toBe(0)
  })

  it('should return null for NaN', () => {
    expect(parseNumber(NaN)).toBeNull()
  })

  it('should return null for non-number types', () => {
    expect(parseNumber('123')).toBeNull()
    expect(parseNumber(null)).toBeNull()
    expect(parseNumber(undefined)).toBeNull()
  })

  it('should return negative numbers', () => {
    expect(parseNumber(-5)).toBe(-5)
  })
})

describe('validateApiUrl', () => {
  it('should accept https URL', () => {
    expect(validateApiUrl('https://api.example.com')).toBeNull()
  })

  it('should accept http URL', () => {
    expect(validateApiUrl('http://localhost:3030')).toBeNull()
  })

  it('should reject file:// URL', () => {
    const result = validateApiUrl('file:///etc/passwd')
    expect(result).toContain('Invalid protocol')
    expect(result).toContain('file:')
  })

  it('should reject javascript: URL', () => {
    const result = validateApiUrl('javascript:alert(1)')
    expect(result).toContain('Invalid protocol')
  })

  it('should reject invalid URL string', () => {
    const result = validateApiUrl('not-a-url')
    expect(result).toContain('Invalid URL')
  })

  it('should reject empty string', () => {
    const result = validateApiUrl('')
    expect(result).toContain('Invalid URL')
  })
})
