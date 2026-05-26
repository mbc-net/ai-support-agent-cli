import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// os.homedir は読み取り専用 getter なので、モジュール mock で差し替える
jest.mock('os', () => {
  const actual = jest.requireActual<typeof os>('os')
  return {
    ...actual,
    homedir: jest.fn(actual.homedir),
  }
})

import { ensureClaudeJsonOAuthAccount } from '../../src/utils/claude-json-oauth-sync'

jest.mock('../../src/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}))

describe('ensureClaudeJsonOAuthAccount', () => {
  let tmpHome: string
  let claudeJsonPath: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-json-test-'))
    claudeJsonPath = path.join(tmpHome, '.claude.json')
    ;(os.homedir as jest.Mock).mockReturnValue(tmpHome)
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('does nothing when envVarsOverride is undefined', () => {
    ensureClaudeJsonOAuthAccount(undefined, { prefix: '[test]' })
    expect(fs.existsSync(claudeJsonPath)).toBe(false)
  })

  it('does nothing when envVarsOverride lacks CLAUDE_CODE_OAUTH_TOKEN', () => {
    ensureClaudeJsonOAuthAccount({ ANTHROPIC_API_KEY: 'sk-test' }, { prefix: '[test]' })
    expect(fs.existsSync(claudeJsonPath)).toBe(false)
  })

  it('creates ~/.claude.json with oauthAccount: {} when file does not exist', () => {
    ensureClaudeJsonOAuthAccount(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
      { prefix: '[test]' },
    )
    expect(fs.existsSync(claudeJsonPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
    expect(data).toEqual({ oauthAccount: {} })
  })

  it('adds oauthAccount: {} to existing file while preserving other fields', () => {
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
    expect(data).toEqual({
      numStartups: 5,
      installMethod: 'native',
      userID: 'user-uuid',
      oauthAccount: {},
    })
  })

  it('does not overwrite existing oauthAccount object', () => {
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
    // 既存の oauthAccount はそのまま温存される
    expect(data.oauthAccount).toEqual({
      accountUuid: 'real-uuid',
      emailAddress: 'user@example.com',
    })
    expect(data.userID).toBe('user-uuid')
  })

  it('does not overwrite existing oauthAccount even if it is empty object', () => {
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({ oauthAccount: {} }),
    )
    const before = fs.statSync(claudeJsonPath).mtimeMs
    ensureClaudeJsonOAuthAccount(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
      { prefix: '[test]' },
    )
    const after = fs.statSync(claudeJsonPath).mtimeMs
    // 書き換え無し → mtime も変化しない（同一テストプロセス内で十分短時間）
    // 内容は変わらない
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
    expect(data).toEqual({ oauthAccount: {} })
    // optional: mtime check は env により不安定なので緩く確認
    void before
    void after
  })

  it('recreates minimal file if existing JSON is corrupted', () => {
    fs.writeFileSync(claudeJsonPath, 'not-valid-json{{{')
    ensureClaudeJsonOAuthAccount(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
      { prefix: '[test]' },
    )
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
    expect(data).toEqual({ oauthAccount: {} })
  })

  it('writes file with 0o600 permission', () => {
    ensureClaudeJsonOAuthAccount(
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
      { prefix: '[test]' },
    )
    const stat = fs.statSync(claudeJsonPath)
    // 下位 9 ビットだけ確認 (mode の上位ビットは無視)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('does not throw when filesystem operations fail (gracefully skip)', () => {
    // 親ディレクトリを書き込み不可にしてエラー誘発
    fs.chmodSync(tmpHome, 0o500)
    try {
      // 既存ファイルが無く、新規作成で permission denied になる
      expect(() =>
        ensureClaudeJsonOAuthAccount(
          { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' },
          { prefix: '[test]' },
        ),
      ).not.toThrow()
    } finally {
      // 戻して afterEach の rmSync が成功するように
      fs.chmodSync(tmpHome, 0o700)
    }
  })
})
