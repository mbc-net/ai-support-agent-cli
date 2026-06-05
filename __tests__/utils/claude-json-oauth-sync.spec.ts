import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// os.homedir / fs.renameSync は ESM の getter 由来で書き換え不可なので
// モジュール mock で差し替える
jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os')
  return {
    ...actual,
    homedir: jest.fn(actual.homedir),
  }
})

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof fs>('fs')
  return {
    ...actual,
    renameSync: jest.fn(actual.renameSync),
  }
})

jest.mock('../../src/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}))

import { ensureClaudeJsonOAuthAccount } from '../../src/utils/claude-json-oauth-sync'

describe('ensureClaudeJsonOAuthAccount', () => {
  let tmpHome: string
  let claudeJsonPath: string
  let lockPath: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-json-test-'))
    claudeJsonPath = path.join(tmpHome, '.claude.json')
    lockPath = path.join(tmpHome, '.claude.json.lock')
    ;(os.homedir as jest.Mock).mockReturnValue(tmpHome)
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('token validation (gating)', () => {
    it('does nothing when envVarsOverride is undefined', () => {
      ensureClaudeJsonOAuthAccount(undefined, { prefix: '[test]' })
      expect(fs.existsSync(claudeJsonPath)).toBe(false)
    })

    it('does nothing when envVarsOverride lacks CLAUDE_CODE_OAUTH_TOKEN', () => {
      ensureClaudeJsonOAuthAccount({ ANTHROPIC_API_KEY: 'sk-test' }, { prefix: '[test]' })
      expect(fs.existsSync(claudeJsonPath)).toBe(false)
    })

    it('does nothing when token is empty string', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: '' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(claudeJsonPath)).toBe(false)
    })

    it('does nothing when token is whitespace-only', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: '   \t\n' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(claudeJsonPath)).toBe(false)
    })

    it("does nothing when token is the literal string 'undefined' or 'null'", () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'undefined' },
        { prefix: '[test]' },
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'null' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(claudeJsonPath)).toBe(false)
    })
  })

  describe('new file creation', () => {
    it('creates ~/.claude.json with oauthAccount + onboarding flags when file does not exist', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(claudeJsonPath)).toBe(true)
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(typeof data.lastOnboardingVersion).toBe('string')
      expect(data.lastOnboardingVersion.length).toBeGreaterThan(0)
    })

    it('writes file with 0o600 permission (new file)', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const stat = fs.statSync(claudeJsonPath)
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('enforces 0o600 on existing file even if it was 0o644 (explicit chmod)', () => {
      fs.writeFileSync(claudeJsonPath, JSON.stringify({}), { mode: 0o644 })
      fs.chmodSync(claudeJsonPath, 0o644) // 明示的に loose mode を設定
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const stat = fs.statSync(claudeJsonPath)
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('uses minified JSON (no pretty-print) to match claude CLI conventions', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const raw = fs.readFileSync(claudeJsonPath, 'utf-8')
      // 改行・インデント無しの minified JSON であること
      expect(raw).not.toContain('\n')
      expect(raw).not.toMatch(/^\{\s/)
    })
  })

  describe('merge with existing file', () => {
    it('adds oauthAccount + onboarding flags while preserving other top-level fields', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          numStartups: 5,
          installMethod: 'native',
          userID: 'user-uuid',
        }),
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.numStartups).toBe(5)
      expect(data.installMethod).toBe('native')
      expect(data.userID).toBe('user-uuid')
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(typeof data.lastOnboardingVersion).toBe('string')
    })

    it('does not overwrite a valid oauthAccount object with metadata but still adds onboarding flags', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: {
            accountUuid: 'real-uuid',
            emailAddress: 'user@example.com',
          },
          userID: 'user-uuid',
        }),
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      // 既存 oauthAccount は温存
      expect(data.oauthAccount).toEqual({
        accountUuid: 'real-uuid',
        emailAddress: 'user@example.com',
      })
      expect(data.userID).toBe('user-uuid')
      // onboarding flags は不足していたので追加される
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(typeof data.lastOnboardingVersion).toBe('string')
    })

    it('does not touch file when oauthAccount + onboarding flags are all valid (no write)', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: {},
          hasCompletedOnboarding: true,
          lastOnboardingVersion: '2.1.150',
        }),
      )
      const beforeMtime = fs.statSync(claudeJsonPath).mtimeMs
      const start = Date.now()
      while (Date.now() - start < 20) { /* spin */ }
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const afterMtime = fs.statSync(claudeJsonPath).mtimeMs
      expect(afterMtime).toBe(beforeMtime)
    })

    it('adds only onboarding flags when oauthAccount is already valid but flags are missing', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: { accountUuid: 'real-uuid' },
          // hasCompletedOnboarding と lastOnboardingVersion なし
        }),
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({ accountUuid: 'real-uuid' })
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(typeof data.lastOnboardingVersion).toBe('string')
    })

    it('replaces hasCompletedOnboarding=false with true', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: {},
          hasCompletedOnboarding: false,
        }),
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(typeof data.lastOnboardingVersion).toBe('string')
    })

    it('preserves existing lastOnboardingVersion if it is a non-empty string', () => {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: {},
          hasCompletedOnboarding: false,
          lastOnboardingVersion: '2.0.99',
        }),
      )
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      // hasCompletedOnboarding は false → true に修正される
      expect(data.hasCompletedOnboarding).toBe(true)
      // lastOnboardingVersion は既存値が温存される (上書きしない)
      expect(data.lastOnboardingVersion).toBe('2.0.99')
    })

    it('replaces invalid oauthAccount values (false / "" / 0 / [] / null) with empty object', () => {
      const invalidValues: unknown[] = [false, '', 0, [], null, 'not-an-object']
      for (const invalid of invalidValues) {
        fs.writeFileSync(
          claudeJsonPath,
          JSON.stringify({ oauthAccount: invalid, userID: 'x' }),
        )
        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        )
        const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
        expect(data.oauthAccount).toEqual({})
        expect(data.userID).toBe('x')
      }
    })
  })

  describe('corrupted / non-object handling', () => {
    it('recreates minimal file and dumps backup if JSON is malformed', () => {
      fs.writeFileSync(claudeJsonPath, 'not-valid-json{{{')
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
      // backup ファイル（.claude.json.broken-*）が作られている
      const files = fs.readdirSync(tmpHome).filter((f) => f.startsWith('.claude.json.broken-'))
      expect(files.length).toBeGreaterThanOrEqual(1)
      const backupContent = fs.readFileSync(path.join(tmpHome, files[0]), 'utf-8')
      expect(backupContent).toBe('not-valid-json{{{')
    })

    it('treats top-level array as corrupted and recreates', () => {
      fs.writeFileSync(claudeJsonPath, JSON.stringify([1, 2, 3]))
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
    })

    it('treats top-level string as corrupted and recreates', () => {
      fs.writeFileSync(claudeJsonPath, JSON.stringify('some string'))
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
    })

    it('treats top-level number as corrupted and recreates', () => {
      fs.writeFileSync(claudeJsonPath, JSON.stringify(42))
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
    })

    it('handles top-level JSON null by recreating (without dumping backup since null parses)', () => {
      fs.writeFileSync(claudeJsonPath, 'null')
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
    })
  })

  describe('locking / concurrency', () => {
    it('removes stale lock file (older than threshold) and proceeds', () => {
      // ロックファイルを作って mtime を古くする
      fs.writeFileSync(lockPath, '', { mode: 0o600 })
      const oldTime = Date.now() / 1000 - 60 // 60s 前
      fs.utimesSync(lockPath, oldTime, oldTime)

      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      // stale lock が削除され、~/.claude.json が作られている
      expect(fs.existsSync(claudeJsonPath)).toBe(true)
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.oauthAccount).toEqual({})
      expect(data.hasCompletedOnboarding).toBe(true)
      // ロックも解放されている
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    it('releases lock after successful sync (no leftover lockfile)', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    it('returns null from withLock and logs warn when lock cannot be acquired (non-stale lock held)', () => {
      // Keep a fresh lock file (not stale) so acquireLock always returns null.
      // Set mtime to "now" so the stale check (Date.now() - mtime > 30000) is false.
      fs.writeFileSync(lockPath, '', { mode: 0o600 })
      // Explicitly set mtime to current time (already the case, but be explicit)
      const nowSec = Date.now() / 1000
      fs.utimesSync(lockPath, nowSec, nowSec)

      // Speed up the spin loop: make Date.now() always advance by > LOCK_RETRY_INTERVAL_MS (50)
      // so the inner spin exits immediately on each iteration.
      // Use a monotonically increasing counter (increments of 100ms per call) starting at a
      // high value so stale check (Date.now() - mtime > 30000) remains false:
      // mtime is real-time (e.g., 1748000000000), so even Date.now()=1748000000100 won't be stale.
      const baseTime = Date.now()
      let callCount = 0
      const originalDateNow = Date.now
      Date.now = jest.fn().mockImplementation(() => {
        callCount++
        // Monotonically increase by 100ms per call — spin exits immediately (100 > 50)
        // Starting at baseTime ensures stale check (value - mtime) stays below LOCK_STALE_MS (30s)
        return baseTime + callCount * 100
      })

      try {
        const { logger: mockLogger } = require('../../src/logger') as { logger: { warn: jest.Mock } }
        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        )
        // withLock exhausted retries → returned null → logger.warn called
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Could not acquire lock'),
        )
        // claude.json should NOT have been created since lock was never acquired
        expect(fs.existsSync(claudeJsonPath)).toBe(false)
      } finally {
        Date.now = originalDateNow
      }
    })

    it('returns null from acquireLock when fs.statSync throws while checking stale lock', () => {
      // When fs.statSync throws for the lock file, the catch at line 82 runs and returns null.
      // We simulate by holding a fresh lock file and making the stale-check throw.
      // Since fs is partially mocked (only renameSync), we mock openSync to simulate EEXIST
      // and statSync to throw, triggering the catch-returns-null path.
      const actualFs = jest.requireActual<typeof fs>('fs')

      // Write a real lock file so actual openSync EEXIST happens
      fs.writeFileSync(lockPath, '', { mode: 0o600 })

      // Override fs.statSync (the actual module) to throw for the lock path
      const origStatSync = actualFs.statSync
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(actualFs as any).statSync = (p: fs.PathLike, ...args: unknown[]) => {
        if (String(p) === lockPath) {
          throw new Error('EACCES: permission denied, stat')
        }
        return origStatSync(p, ...args)
      }

      // Speed up the spin loop with monotonically increasing time
      const baseTime = Date.now()
      let callCount = 0
      const originalDateNow = Date.now
      Date.now = jest.fn().mockImplementation(() => {
        callCount++
        return baseTime + callCount * 100
      })

      try {
        const { logger: mockLogger } = require('../../src/logger') as { logger: { warn: jest.Mock } }
        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        )
        // acquireLock's statSync threw → returned null → withLock exhausted → returned null
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Could not acquire lock'),
        )
      } finally {
        Date.now = originalDateNow
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(actualFs as any).statSync = origStatSync
      }
    })
  })

  describe('atomic write', () => {
    it('does not leave tmp files after successful write', () => {
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const tmpFiles = fs.readdirSync(tmpHome).filter((f) => f.startsWith('.claude.json.tmp.'))
      expect(tmpFiles).toHaveLength(0)
    })

    describe('fallback to direct write when rename fails (docker bind-mount)', () => {
      const actualFs = jest.requireActual<typeof fs>('fs')

      afterEach(() => {
        // 各テスト後に実装に戻す
        ;(fs.renameSync as jest.Mock).mockImplementation(actualFs.renameSync)
      })

      function patchRenameToThrow(code: string) {
        ;(fs.renameSync as jest.Mock).mockImplementation(() => {
          const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException
          err.code = code
          throw err
        })
      }

      it('falls back when EBUSY (the actual docker bind-mount case on mbc-ai-01)', () => {
        fs.writeFileSync(claudeJsonPath, JSON.stringify({ existing: true }))
        patchRenameToThrow('EBUSY')

        expect(() =>
          ensureClaudeJsonOAuthAccount(
            { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
            { prefix: '[test]' },
          ),
        ).not.toThrow()

        const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
        expect(data.existing).toBe(true)
        expect(data.oauthAccount).toEqual({})
        // tmp 残骸も掃除されている
        const tmpFiles = fs
          .readdirSync(tmpHome)
          .filter((f) => f.startsWith('.claude.json.tmp.'))
        expect(tmpFiles).toHaveLength(0)
      })

      it('falls back on EXDEV (cross-device rename)', () => {
        fs.writeFileSync(claudeJsonPath, JSON.stringify({ a: 1 }))
        patchRenameToThrow('EXDEV')

        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        )

        const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
        expect(data.a).toBe(1)
        expect(data.oauthAccount).toEqual({})
      })

      it('falls back on EPERM', () => {
        fs.writeFileSync(claudeJsonPath, JSON.stringify({ a: 1 }))
        patchRenameToThrow('EPERM')

        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        )

        const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
        expect(data.a).toBe(1)
        expect(data.oauthAccount).toEqual({})
      })

      it('propagates non-recoverable rename errors (e.g. ENOSPC) without fallback', () => {
        fs.writeFileSync(claudeJsonPath, JSON.stringify({ a: 1 }))
        patchRenameToThrow('ENOSPC')

        // 上位の try/catch で warn にだけ変換され、throw はしない
        expect(() =>
          ensureClaudeJsonOAuthAccount(
            { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
            { prefix: '[test]' },
          ),
        ).not.toThrow()
        // fallback 経路が走らないので oauthAccount は追加されていない
        const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
        expect(data.oauthAccount).toBeUndefined()
      })
    })
  })

  describe('failure handling', () => {
    it('does not throw when filesystem operations fail (gracefully skip)', () => {
      // 親ディレクトリを書き込み不可にしてエラー誘発
      fs.chmodSync(tmpHome, 0o500)
      try {
        expect(() =>
          ensureClaudeJsonOAuthAccount(
            { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
            { prefix: '[test]' },
          ),
        ).not.toThrow()
      } finally {
        fs.chmodSync(tmpHome, 0o700)
      }
    })
  })

  describe('container HOME env', () => {
    it('respects os.homedir() which Node resolves from process.env.HOME', () => {
      // os.homedir が mock 経由で tmpHome を返す → そこに書き込まれる
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(true)
    })
  })

  describe('detectClaudeVersion (via lastOnboardingVersion)', () => {
    it('uses version string from claude-code package.json when found in npm-global path', () => {
      // Create a fake claude-code package.json in the npm-global path under tmpHome
      const npmGlobalPkgDir = path.join(
        tmpHome,
        '.npm-global/lib/node_modules/@anthropic-ai/claude-code',
      )
      fs.mkdirSync(npmGlobalPkgDir, { recursive: true })
      fs.writeFileSync(
        path.join(npmGlobalPkgDir, 'package.json'),
        JSON.stringify({ version: '2.5.0', name: '@anthropic-ai/claude-code' }),
        { mode: 0o644 },
      )

      // Point homedir to tmpHome so detectClaudeVersion finds the fake package.json
      ;(os.homedir as jest.Mock).mockReturnValue(tmpHome)

      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )

      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      expect(data.lastOnboardingVersion).toBe('2.5.0')
    })

    it('falls back to "unknown" when no claude-code package.json candidates exist', () => {
      // tmpHome has no npm-global or system node_modules with claude-code
      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      // Either a real version (if claude-code is actually installed) or 'unknown'
      expect(typeof data.lastOnboardingVersion).toBe('string')
      expect(data.lastOnboardingVersion.length).toBeGreaterThan(0)
    })

    it('skips candidate when package.json exists but version is not a string (falls through to unknown)', () => {
      // Create a fake claude-code package.json where version is NOT a string
      const npmGlobalPkgDir = path.join(
        tmpHome,
        '.npm-global/lib/node_modules/@anthropic-ai/claude-code',
      )
      fs.mkdirSync(npmGlobalPkgDir, { recursive: true })
      // version is a number, not a string — so the condition `typeof pkg.version === 'string'` is false
      fs.writeFileSync(
        path.join(npmGlobalPkgDir, 'package.json'),
        JSON.stringify({ version: 123, name: '@anthropic-ai/claude-code' }),
        { mode: 0o644 },
      )

      ;(os.homedir as jest.Mock).mockReturnValue(tmpHome)

      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )

      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      // Falls through to 'unknown' since version is not a valid string
      // (unless a real claude-code is installed at a system path)
      expect(typeof data.lastOnboardingVersion).toBe('string')
      expect(data.lastOnboardingVersion.length).toBeGreaterThan(0)
    })
  })

  describe('oauthAccount invalid with valid onboarding flags', () => {
    it('replaces invalid oauthAccount and skips updating already-valid onboarding flags', () => {
      // oauthAccount is invalid (array), but hasCompletedOnboarding + lastOnboardingVersion are valid
      // This tests the branch where !oauthAccountValid=true, !onboardingValid=false
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify({
          oauthAccount: [1, 2, 3], // invalid: array
          hasCompletedOnboarding: true,
          lastOnboardingVersion: '2.1.150', // valid
          userID: 'user-uuid',
        }),
      )

      ensureClaudeJsonOAuthAccount(
        { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
        { prefix: '[test]' },
      )

      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      // oauthAccount replaced with {}
      expect(data.oauthAccount).toEqual({})
      // onboarding flags preserved (not changed)
      expect(data.hasCompletedOnboarding).toBe(true)
      expect(data.lastOnboardingVersion).toBe('2.1.150')
      // other fields preserved
      expect(data.userID).toBe('user-uuid')
    })
  })

  describe('corrupted file backup dump failure', () => {
    it('logs "backup dump failed" warning when writing broken backup throws', () => {
      // Write malformed JSON so needBackup=true in syncOauthAccount
      fs.writeFileSync(claudeJsonPath, 'not-valid-json{{{')

      // To reach the backup dump failure path, we need:
      // 1. Lock acquisition to succeed (tmpHome writable for lock file)
      // 2. claudeJsonPath readable (contains corrupted content)
      // 3. The broken dump write (path.join(tmpHome, '.claude.json.broken-{ts}')) to FAIL
      //
      // Strategy: write the lock file first, make tmpHome chmod 0o711 so
      // the directory is executable+writable-for-owner, but use a sub-path that fails.
      // Actually we need tmpHome non-writable for the dump but writable for the lock.
      // This is not easily achievable with plain chmod.
      //
      // Alternative: use a second tmpHome for the broken dump path by having a subdirectory
      // that is read-only. We point os.homedir to a directory where a read-only subdir
      // holds the broken dump path.
      //
      // Simplest approach that works: create a file (not directory) at the path where
      // getBrokenDumpPath would try to write, but since the timestamp is dynamic we can't
      // predict the exact path.
      //
      // Most reliable approach: use a dedicated tmpHome where:
      // 1. We grant write permission for the lock (tmpHome is writable)
      // 2. We pre-create a read-only file or directory that conflicts with the dump path
      //
      // Since getBrokenDumpPath() uses Date.now() timestamp, we can't predict the exact name.
      // Instead, we mock getenv to use a different home dir where dump writes fail.
      //
      // Given the complexity, we test via the lock-held + chmod approach:
      // - Pre-create lock file (so lock acquisition hits EEXIST path)
      // - Make tmpHome non-writable (so the dump fails IF we get to it)
      // - But then the lock creation itself fails with EACCES...
      //
      // The cleanest solution: use a separate tmpdir for this test, make it so:
      //   - The lock file is pre-created (already there, causing EEXIST)
      //   - LOCK_STALE_MS is effectively bypassed by setting old mtime
      //   - Wait, but then the stale path runs and tries to unlink + re-acquire...
      //
      // After careful analysis, the most viable approach is:
      // Create a fresh tmpHome, chmod it to 0o500 AFTER creating the lock file,
      // then rely on the lock EEXIST+stat check to fail (since we can't stat in 0o500?).
      // Actually stat works in 0o500 (read+execute). So statSync succeeds, mtime is recent,
      // lock is not stale → returns null → withLock exhausts → returns null → warn "Could not acquire lock".
      // This is the "withLock timeout" path, not the "backup dump" path.
      //
      // For practical coverage, we test a simpler variant: use jest.resetModules() +
      // a complete mock of fs where writeFileSync throws only for broken dump paths.

      // Create a separate module registry for this test
      jest.resetModules()
      jest.doMock('../../src/logger', () => ({
        logger: {
          warn: jest.fn(),
          info: jest.fn(),
          debug: jest.fn(),
          error: jest.fn(),
        },
      }))

      const actualFsMod = jest.requireActual<typeof fs>('fs')
      let writeCalls = 0

      // Mock fs entirely for this subtest, making broken dump writes fail
      jest.doMock('fs', () => {
        const mod = { ...actualFsMod }
        // Override writeFileSync to fail for .broken- paths
        mod.writeFileSync = (
          filePath: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          options?: fs.WriteFileOptions,
        ) => {
          writeCalls++
          const pathStr = String(filePath)
          if (pathStr.includes('.claude.json.broken-')) {
            throw new Error('ENOSPC: no space left on device')
          }
          actualFsMod.writeFileSync(filePath, data, options as fs.WriteFileOptions)
        }
        return mod
      })

      jest.doMock('os', () => {
        const actual = jest.requireActual<typeof os>('os')
        return { ...actual, homedir: jest.fn(() => tmpHome) }
      })

      try {
        const { ensureClaudeJsonOAuthAccount: freshFn } = require('../../src/utils/claude-json-oauth-sync') as typeof import('../../src/utils/claude-json-oauth-sync')
        const { logger: mockLogger } = require('../../src/logger') as { logger: { warn: jest.Mock } }

        expect(() =>
          freshFn({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' }, { prefix: '[test]' }),
        ).not.toThrow()

        const warnCalls = mockLogger.warn.mock.calls as string[][]
        const hasDumpFailed = warnCalls.some(
          (args) => typeof args[0] === 'string' && args[0].includes('backup dump failed'),
        )
        expect(hasDumpFailed).toBe(true)
      } finally {
        jest.dontMock('fs')
        jest.dontMock('os')
        jest.dontMock('../../src/logger')
      }
    })
  })
})
