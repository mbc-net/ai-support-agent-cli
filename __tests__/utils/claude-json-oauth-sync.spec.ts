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
})
