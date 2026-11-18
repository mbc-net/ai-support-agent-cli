import { compileSafeGlob } from '../../src/commands/safe-glob'

describe('compileSafeGlob', () => {
  it.each([
    ['**/*.ts', 'src/index.ts', true],
    ['**/*.ts', '.hidden/file.ts', true],
    ['*.ts', '.hidden.ts', true],
    ['{a,b}.ts', 'a.ts', true],
    ['{a,b}.ts', 'c.ts', false],
    ['file[0-9].ts', 'file3.ts', true],
    ['[[:alpha:]].ts', 'a.ts', true],
    ['#*.ts', '#hello.ts', true],
    ['#*.ts', 'hello.ts', false],
    ['!*.ts', 'a.ts', false],
    ['!*.ts', 'a.js', true],
    ['!!*.ts', 'a.ts', true],
    ['!(a).ts', 'a.ts', false],
    ['!(a).ts', 'b.ts', true],
    ['!!(a).ts', 'a.ts', true],
    ['!!(a).ts', 'b.ts', false],
    ['+(a|b).ts', 'abab.ts', true],
    ['(a|b).ts', 'a.ts', true],
    ['(a|b).ts', '(a|b).ts', false],
    ['a(b).ts', 'ab.ts', true],
    ['file[!a].ts', 'file!.ts', true],
    ['file[!a].ts', 'filea.ts', true],
    ['file[!a].ts', 'fileb.ts', false],
    ['[]].ts', '].ts', true],
    ['\\[name\\].ts', '[name].ts', true],
    ['\\{name\\}.ts', '{name}.ts', true],
    ['file\\(1\\).ts', 'file(1).ts', true],
    ['[{}()].ts', '(.ts', true],
  ])('matches %s against %s as %s', (pattern, value, expected) => {
    expect(compileSafeGlob(pattern)(value)).toBe(expected)
  })

  it.each(['[', 'a{', 'foo(', 'foo)', 'file]', 'file}', '{(})'])('rejects unmatched delimiters: %s', (pattern) => {
    expect(() => compileSafeGlob(pattern)).toThrow('unmatched glob delimiter')
  })

  it('bounds pattern length before compilation', () => {
    expect(() => compileSafeGlob('a'.repeat(65_537))).toThrow('glob pattern too long')
  })

  it('bounds nesting before compilation', () => {
    expect(() => compileSafeGlob('('.repeat(65) + ')'.repeat(65))).toThrow('glob nesting limit exceeded')
  })

  it('bounds combinatorial brace expansion', () => {
    expect(() => compileSafeGlob('{a,b}'.repeat(11))).toThrow()
  })

  it('rejects capped expansion even when duplicate alternatives would hide the cap', () => {
    const pattern = '{' + [...Array(1100).fill('a'), 'b'].join(',') + '}'
    expect(() => compileSafeGlob(pattern)).toThrow('glob expansion limit exceeded')
  })

  it.each(['+(*a)', '+(*)b', '*(*a)'])('matches repeated extglob without regexp backtracking: %s', (pattern) => {
    expect(compileSafeGlob(pattern)('a'.repeat(48) + 'c')).toBe(false)
  })
})
