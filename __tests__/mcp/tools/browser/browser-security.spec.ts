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

    describe('SSRF prevention', () => {
      it('should reject localhost', () => {
        const result = validateUrl('http://localhost/admin')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should reject 127.0.0.1', () => {
        const result = validateUrl('http://127.0.0.1/')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should reject 10.x.x.x (RFC1918)', () => {
        const result = validateUrl('http://10.0.0.1/secret')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should reject 192.168.x.x (RFC1918)', () => {
        const result = validateUrl('http://192.168.1.1/')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should reject 172.16.x.x (RFC1918)', () => {
        const result = validateUrl('http://172.16.0.1/')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should reject 169.254.x.x (AWS metadata link-local)', () => {
        const result = validateUrl('http://169.254.169.254/latest/meta-data/')
        expect(result.valid).toBe(false)
        expect(result.reason).toContain('internal/private')
      })

      it('should allow public IP addresses', () => {
        expect(validateUrl('http://8.8.8.8/')).toEqual({ valid: true })
        expect(validateUrl('https://1.1.1.1/')).toEqual({ valid: true })
      })

      it('should allow public domain names', () => {
        expect(validateUrl('https://example.com/')).toEqual({ valid: true })
        expect(validateUrl('https://api.github.com/')).toEqual({ valid: true })
      })
    })
  })
})
