import { validateUrl } from '../../../../src/mcp/tools/browser/browser-security'

describe('browser-security', () => {
  describe('validateUrl', () => {
    it('should accept http URLs', () => {
      expect(validateUrl('http://example.com')).toEqual({ valid: true })
    })

    it('should accept https URLs', () => {
      expect(validateUrl('https://example.com/path?q=1')).toEqual({ valid: true })
    })

    it('should reject file:// URLs', () => {
      const result = validateUrl('file:///etc/passwd')
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Blocked protocol')
      expect(result.reason).toContain('file:')
    })

    it('should reject javascript: URLs', () => {
      const result = validateUrl('javascript:alert(1)')
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Blocked protocol')
      expect(result.reason).toContain('javascript:')
    })

    it('should reject data: URLs', () => {
      const result = validateUrl('data:text/html,<h1>test</h1>')
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Blocked protocol')
      expect(result.reason).toContain('data:')
    })

    it('should reject invalid URLs', () => {
      const result = validateUrl('not-a-url')
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Invalid URL')
    })

    it('should reject empty URLs', () => {
      const result = validateUrl('')
      expect(result.valid).toBe(false)
      expect(result.reason).toContain('Invalid URL')
    })
  })
})
