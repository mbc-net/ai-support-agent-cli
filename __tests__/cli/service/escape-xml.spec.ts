import { escapeXml } from '../../../src/cli/service/escape-xml'

describe('escapeXml', () => {
  it('should escape ampersand', () => {
    expect(escapeXml('a&b')).toBe('a&amp;b')
  })

  it('should escape less-than', () => {
    expect(escapeXml('a<b')).toBe('a&lt;b')
  })

  it('should escape greater-than', () => {
    expect(escapeXml('a>b')).toBe('a&gt;b')
  })

  it('should escape double quotes', () => {
    expect(escapeXml('a"b')).toBe('a&quot;b')
  })

  it('should escape single quotes', () => {
    expect(escapeXml("a'b")).toBe('a&apos;b')
  })

  it('should pass through normal strings unchanged', () => {
    expect(escapeXml('/usr/local/bin/node')).toBe('/usr/local/bin/node')
  })

  it('should handle multiple special characters', () => {
    expect(escapeXml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;')
  })

  it('should handle empty string', () => {
    expect(escapeXml('')).toBe('')
  })
})
