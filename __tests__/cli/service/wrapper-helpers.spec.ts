jest.mock('fs')
jest.mock('../../../src/logger')
jest.mock('../../../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{{${k}}}`, String(v))
      }
      return result
    }
    return key
  },
}))

import * as fs from 'fs'
import {
  assertProjectCodeIsSafe,
  detectInstallCollisions,
  isProjectCodeSafe,
  sanitizeServiceNameSegment,
  shellQuote,
  toContainerApiUrl,
  validateProjectDirForMount,
} from '../../../src/cli/service/wrapper-helpers'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)

// Hoist mock reset to file scope so each test (across all describe blocks)
// starts with a clean slate. Without this, mock state set by a test in
// `validateProjectDirForMount` would leak into a future test in
// `shellQuote` or `assertProjectCodeIsSafe` if reordered.
beforeEach(() => {
  jest.clearAllMocks()
})

describe('shellQuote', () => {
  it('wraps a plain value in POSIX single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('preserves embedded $, backticks, and double quotes inside single quotes (bash does not expand them there)', () => {
    expect(shellQuote('a$b`c"d')).toBe("'a$b`c\"d'")
  })

  it('escapes embedded single quotes via \\\\\'\\\\\'', () => {
    // input contains one literal `'`; output should split the quoted region,
    // escape the apostrophe, and re-open: 'foo'\''bar'
    expect(shellQuote("foo'bar")).toBe(`'foo'\\''bar'`)
  })

  it('produces an empty quoted token for an empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('preserves whitespace inside the value', () => {
    expect(shellQuote('a b c')).toBe("'a b c'")
  })

  it('round-trips through bash with all metacharacters as literal', () => {
    // Sanity: the regex inside shellQuote escapes ONLY `'`. Verify by
    // round-tripping a value with the full POSIX metacharacter set minus
    // single-quote (which is the only one that needs escaping).
    const input = `\\$|&;<>(){}!\`"~?*[]^# `
    expect(shellQuote(input)).toBe(`'${input}'`)
  })
})

describe('assertProjectCodeIsSafe', () => {
  it('accepts lowercase alphanumeric codes', () => {
    expect(() => assertProjectCodeIsSafe('mbc')).not.toThrow()
    expect(() => assertProjectCodeIsSafe('00000005')).not.toThrow()
  })

  it('accepts UPPER_SNAKE_CASE codes', () => {
    expect(() => assertProjectCodeIsSafe('MBC_01')).not.toThrow()
    expect(() => assertProjectCodeIsSafe('SOME_PROJECT_NAME')).not.toThrow()
  })

  it('accepts hyphenated codes', () => {
    expect(() => assertProjectCodeIsSafe('mbc-net')).not.toThrow()
    expect(() => assertProjectCodeIsSafe('MBC-01')).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => assertProjectCodeIsSafe('')).toThrow(/service\.invalidProjectCode/)
  })

  it('rejects PROJECT_DIR_MAP entry separator `;`', () => {
    expect(() => assertProjectCodeIsSafe('A;B')).toThrow(/service\.invalidProjectCode/)
  })

  it('rejects PROJECT_DIR_MAP key/value separator `=`', () => {
    expect(() => assertProjectCodeIsSafe('A=B')).toThrow(/service\.invalidProjectCode/)
  })

  it('rejects path separators', () => {
    expect(() => assertProjectCodeIsSafe('a/b')).toThrow(/service\.invalidProjectCode/)
    expect(() => assertProjectCodeIsSafe('a\\b')).toThrow(/service\.invalidProjectCode/)
  })

  it('rejects shell metacharacters', () => {
    expect(() => assertProjectCodeIsSafe('a$b')).toThrow()
    expect(() => assertProjectCodeIsSafe('a`b')).toThrow()
    expect(() => assertProjectCodeIsSafe('a b')).toThrow()
  })

  it('rejects unicode and emoji', () => {
    expect(() => assertProjectCodeIsSafe('プロジェクト')).toThrow()
    expect(() => assertProjectCodeIsSafe('🚀')).toThrow()
  })
})

describe('isProjectCodeSafe (pure predicate)', () => {
  it('returns true for the same set assertProjectCodeIsSafe accepts', () => {
    expect(isProjectCodeSafe('mbc')).toBe(true)
    expect(isProjectCodeSafe('MBC_01')).toBe(true)
    expect(isProjectCodeSafe('MBC-01')).toBe(true)
    expect(isProjectCodeSafe('00000005')).toBe(true)
  })

  it('returns false for the same set assertProjectCodeIsSafe rejects', () => {
    expect(isProjectCodeSafe('')).toBe(false)
    expect(isProjectCodeSafe('A;B')).toBe(false)
    expect(isProjectCodeSafe('A=B')).toBe(false)
    expect(isProjectCodeSafe('a/b')).toBe(false)
    expect(isProjectCodeSafe('プロジェクト')).toBe(false)
  })

  it('does NOT throw on rejected input (unlike the assert variant)', () => {
    // The pure predicate is meant for fast pre-pass filters where the
    // i18n + Error construction overhead would be wasted.
    expect(() => isProjectCodeSafe('A;B')).not.toThrow()
  })
})

describe('validateProjectDirForMount', () => {
  // (Mocks are reset at file scope; no per-describe beforeEach needed.)

  it('returns undefined and does not warn when projectDir is undefined', () => {
    expect(validateProjectDirForMount(undefined)).toBeUndefined()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns undefined for empty string without warning', () => {
    expect(validateProjectDirForMount('')).toBeUndefined()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns and returns undefined when the path does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false)

    const result = validateProjectDirForMount('/nonexistent/path')

    expect(result).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('service.projectDirMissing'))
  })

  it('warns and returns undefined when the path is blocked', () => {
    mockedFs.existsSync.mockReturnValue(true)
    // realpathSync mock returns the path unchanged
    mockedFs.realpathSync.mockReturnValue('/etc/passwd' as never)

    const result = validateProjectDirForMount('/etc/passwd')

    expect(result).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('service.projectDirBlocked'))
  })

  it('returns the original path when it exists and is not blocked', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedFs.realpathSync.mockReturnValue('/home/user/work' as never)

    const result = validateProjectDirForMount('/home/user/work')

    expect(result).toBe('/home/user/work')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('toContainerApiUrl', () => {
  it('converts http://localhost to host.docker.internal', () => {
    expect(toContainerApiUrl('http://localhost')).toBe('http://host.docker.internal')
  })

  it('converts http://127.0.0.1 to host.docker.internal', () => {
    expect(toContainerApiUrl('http://127.0.0.1')).toBe('http://host.docker.internal')
  })

  it('preserves the port when converting', () => {
    expect(toContainerApiUrl('http://localhost:4030')).toBe('http://host.docker.internal:4030')
    expect(toContainerApiUrl('http://127.0.0.1:4030/api')).toBe('http://host.docker.internal:4030/api')
  })

  it('preserves a path that follows the host directly (no port)', () => {
    expect(toContainerApiUrl('http://localhost/api')).toBe('http://host.docker.internal/api')
  })

  it('does NOT replace localhost when it is a prefix of a longer hostname', () => {
    // Without the boundary lookahead, `http://localhost.example.com` would
    // partially match and become `http://host.docker.internal.example.com`
    // — a different host.
    expect(toContainerApiUrl('http://localhost.example.com/api')).toBe('http://localhost.example.com/api')
    expect(toContainerApiUrl('http://127.0.0.1.example.com')).toBe('http://127.0.0.1.example.com')
  })

  it('converts https URLs too', () => {
    expect(toContainerApiUrl('https://localhost:8443')).toBe('https://host.docker.internal:8443')
  })

  it('leaves non-localhost URLs unchanged', () => {
    expect(toContainerApiUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(toContainerApiUrl('http://192.168.1.10:4030')).toBe('http://192.168.1.10:4030')
  })
})

describe('sanitizeServiceNameSegment', () => {
  it('lowercases the input', () => {
    expect(sanitizeServiceNameSegment('MBC')).toBe('mbc')
  })

  it('collapses characters outside [a-z0-9-] to hyphens', () => {
    expect(sanitizeServiceNameSegment('MBC_01')).toBe('mbc-01')
    expect(sanitizeServiceNameSegment('MY.PROJECT')).toBe('my-project')
    expect(sanitizeServiceNameSegment('a b;c=d/e\\f')).toBe('a-b-c-d-e-f')
  })

  it('keeps already-valid segments unchanged', () => {
    expect(sanitizeServiceNameSegment('mbc-01')).toBe('mbc-01')
  })

  it('returns an empty string for an empty input', () => {
    expect(sanitizeServiceNameSegment('')).toBe('')
  })
})

describe('detectInstallCollisions', () => {
  const proj = (tenantCode: string, projectCode: string) => ({
    tenantCode,
    projectCode,
    token: 't',
    apiUrl: 'https://api',
  })
  const naiveName = (t: string, p: string) => `${t.toLowerCase()}-${p.toLowerCase().replace(/_/g, '-')}`

  it('returns an empty collisions map and a names map covering every safe project when none collide', () => {
    const { names, collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC_01'), proj('mbc', 'MBC_02')],
      naiveName,
    )
    expect(collisions.size).toBe(0)
    // names map is the canonical fqn → sanitized-name source of truth.
    expect(names.get('mbc/MBC_01')).toBe('mbc-mbc-01')
    expect(names.get('mbc/MBC_02')).toBe('mbc-mbc-02')
  })

  it('detects sanitize collisions across distinct projects (others is non-empty, isDuplicate false)', () => {
    const { collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC_01'), proj('mbc', 'MBC-01')],
      naiveName,
    )
    expect(collisions.size).toBe(2)
    const a = collisions.get('mbc/MBC_01')!
    expect(a.name).toBe('mbc-mbc-01')
    expect(a.others).toEqual(['mbc/MBC-01'])
    expect(a.isDuplicate).toBe(false)
    const b = collisions.get('mbc/MBC-01')!
    expect(b.others).toEqual(['mbc/MBC_01'])
    expect(b.isDuplicate).toBe(false)
  })

  it('flags isDuplicate=true (and others=[]) for literal duplicates (same tenant+project pair listed twice)', () => {
    const { collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC_01'), proj('mbc', 'MBC_01')],
      naiveName,
    )
    expect(collisions.size).toBe(1)
    const info = collisions.get('mbc/MBC_01')!
    expect(info.others).toEqual([])
    expect(info.isDuplicate).toBe(true)
  })

  it('flags BOTH isDuplicate=true AND others=non-empty when the same fqn is doubled alongside a sanitize-colliding sibling', () => {
    // Regression for AA1: [mbc/MBC_01, mbc/MBC_01, mbc/MBC-01].
    // Previously the helper only exposed `others.length === 0` as the
    // duplicate signal, so this mixed case routed to the generic
    // collision message and silently swallowed the duplicate-row hint.
    // The new isDuplicate flag surfaces it cleanly.
    const { collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC_01'), proj('mbc', 'MBC_01'), proj('mbc', 'MBC-01')],
      naiveName,
    )
    const dup = collisions.get('mbc/MBC_01')!
    expect(dup.isDuplicate).toBe(true)
    expect(dup.others).toEqual(['mbc/MBC-01'])
    const other = collisions.get('mbc/MBC-01')!
    expect(other.isDuplicate).toBe(false)
    expect(other.others).toEqual(['mbc/MBC_01'])
  })

  it('skips entries with invalid (non-safe) tenant or project codes', () => {
    // `MBC;01` would sanitize-collide with `MBC-01` if naively counted.
    // The helper must skip the invalid sibling so the valid one is NOT
    // refused for a fake collision.
    const { names, collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC;01'), proj('mbc', 'MBC-01')],
      naiveName,
    )
    expect(collisions.size).toBe(0)
    // names map also excludes the invalid entry — caller can use it as a
    // safe-only iteration set.
    expect(names.has('mbc/MBC;01')).toBe(false)
    expect(names.get('mbc/MBC-01')).toBe('mbc-mbc-01')
  })

  it('handles 3+ distinct entries on the same sanitized name', () => {
    const { collisions } = detectInstallCollisions(
      [proj('mbc', 'MBC_01'), proj('mbc', 'MBC-01'), proj('mbc', 'mbc-01')],
      naiveName,
    )
    expect(collisions.size).toBe(3)
    // Each entry's `others` contains the other two FQNs (sorted not guaranteed).
    const a = collisions.get('mbc/MBC_01')!
    expect(new Set(a.others)).toEqual(new Set(['mbc/MBC-01', 'mbc/mbc-01']))
    expect(a.isDuplicate).toBe(false)
  })
})
