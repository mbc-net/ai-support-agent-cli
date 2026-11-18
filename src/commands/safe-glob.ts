import { braceExpand, Minimatch } from 'minimatch'

// Keep untrusted compilation bounded as well as matching. The Worker timeout
// remains the backstop for the complete Grep/Glob operation.
const MAX_PATTERN_LENGTH = 65_536
const MAX_NESTING = 64
const MAX_BRACE_EXPANSIONS = 1_024

/** Keep strict delimiter errors and the old Picomatch dialect without building
 * a RegExp: bare groups become @(...), and a leading ! in a class is literal. */
function normalizePattern(pattern: string): string {
  const stack: string[] = []
  let output = ''
  let classStart = -1
  let previousExtglobOperator = false
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      output += pattern.slice(i, i + 2)
      previousExtglobOperator = false
      i++
      continue
    }
    if (stack[stack.length - 1] === '[') {
      // POSIX classes, e.g. [[:alpha:]], have an inner :], .], or =].
      if (char === '[' && [':', '.', '='].includes(pattern[i + 1])) {
        const end = pattern.indexOf(pattern[i + 1] + ']', i + 2)
        if (end !== -1) {
          output += pattern.slice(i, end + 2)
          i = end + 1
          continue
        }
      }
      if (char === '!' && i === classStart + 1) output += '\\'
      // A closing bracket can be the first literal member, as in []].
      const literalClosing = i === classStart + 1 && pattern.indexOf(']', i + 1) !== -1
      if (char === ']' && !literalClosing) stack.pop()
      output += char
      continue
    }
    if (char === '[' || char === '{' || char === '(') {
      stack.push(char)
      if (stack.length > MAX_NESTING) throw new Error('glob nesting limit exceeded')
      if (char === '[') classStart = i
      if (char === '(' && !previousExtglobOperator) output += '@'
    } else if (char === ']' || char === '}' || char === ')') {
      const expected = char === ']' ? '[' : char === '}' ? '{' : '('
      if (stack.pop() !== expected) throw new Error('unmatched glob delimiter')
    }
    output += char
    previousExtglobOperator = ['!', '?', '+', '*', '@'].includes(char)
  }
  if (stack.length) throw new Error('unmatched glob delimiter')
  return output
}

/** Use Minimatch 11's non-regexp matcher, not makeRe(), for untrusted globs. */
export function compileSafeGlob(pattern: string): (value: string) => boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error('glob pattern too long')
  const normalized = normalizePattern(pattern)

  // A leading !(...) is an extglob, whereas !*.ts negates the whole glob.
  // Minimatch's built-in negation parser consumes both, unlike Picomatch.
  let start = 0
  while (normalized[start] === '!' && normalized[start + 1] !== '(') start++
  const negate = start % 2 === 1
  const body = normalized.slice(start)
  // Check the raw expansion before Minimatch deduplicates alternatives. The
  // expander truncates at its cap, so request one extra and reject overflow.
  if (braceExpand(body, { braceExpandMax: MAX_BRACE_EXPANSIONS + 1 }).length > MAX_BRACE_EXPANSIONS) {
    throw new Error('glob expansion limit exceeded')
  }
  const matcher = new Minimatch(body, {
    dot: true,
    nocomment: true,
    nonegate: true,
    braceExpandMax: MAX_BRACE_EXPANSIONS + 1,
  })
  return (value) => negate !== matcher.match(value)
}
