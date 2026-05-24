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
  shellQuote,
  validateProjectDirForMount,
} from '../../../src/cli/service/wrapper-helpers'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)

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

describe('validateProjectDirForMount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

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
