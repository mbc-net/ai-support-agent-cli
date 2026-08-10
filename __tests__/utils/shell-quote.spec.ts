import { shellQuote } from '../../src/utils/shell-quote'

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
    expect(shellQuote('')).toBe("''")
  })

  it('preserves spaces as a single argument', () => {
    expect(shellQuote('a b c')).toBe("'a b c'")
  })

  it("escapes embedded single quotes as '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    // Each embedded quote becomes the 4-char sequence '\'' , then the whole
    // thing is wrapped in quotes.
    expect(shellQuote("'")).toBe("''\\'''")
  })

  it('leaves other shell metacharacters untouched inside the quotes', () => {
    expect(shellQuote('$HOME & `x` | y')).toBe("'$HOME & `x` | y'")
  })
})
