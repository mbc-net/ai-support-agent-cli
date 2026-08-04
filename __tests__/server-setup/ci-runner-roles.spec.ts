import { readFileSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * CI ランナー登録用の bundled role（gitlab_runner / github_runner）の tasks/main.yml が
 * - タスクマッピングの非空配列としてパースできること
 * - 秘密情報（トークン/PAT）を扱うため `no_log` を含むこと
 * を検証する構造テスト。ロールファイル自体の存在と最低限の健全性を担保する
 * （ガードの 1:1 dir テストと合わせて allowlist/ロールdir の非対称も塞ぐ）。
 */
describe('CI runner bundled roles (gitlab_runner / github_runner)', () => {
  const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')

  const readRole = (roleName: string): string =>
    readFileSync(path.join(rolesDir, roleName, 'tasks', 'main.yml'), 'utf8')

  it.each(['gitlab_runner', 'github_runner'])(
    '%s の tasks/main.yml はタスクマッピングの非空配列としてパースできる',
    (roleName) => {
      const content = readRole(roleName)
      const parsed = load(content, { schema: DEFAULT_SCHEMA })
      expect(Array.isArray(parsed)).toBe(true)
      const tasks = parsed as unknown[]
      expect(tasks.length).toBeGreaterThan(0)
      for (const task of tasks) {
        expect(typeof task).toBe('object')
        expect(task).not.toBeNull()
        expect(Array.isArray(task)).toBe(false)
      }
    },
  )

  it.each(['gitlab_runner', 'github_runner'])(
    '%s の tasks/main.yml は no_log を含む（秘密情報の取り扱いが実装されている）',
    (roleName) => {
      const content = readRole(roleName)
      expect(content).toContain('no_log')
    },
  )

  const shellOf = (task: Record<string, unknown>): string | undefined => {
    const val =
      (task['ansible.builtin.shell'] as unknown) ?? (task['shell'] as unknown)
    return typeof val === 'string' ? val : undefined
  }

  it.each(['gitlab_runner', 'github_runner'])(
    '%s の shell タスクはユーザー入力を Jinja でスクリプト本文へ展開しない（信頼できる tempfile パスのみ許可・シェルインジェクション防止）',
    (roleName) => {
      const tasks = load(readRole(roleName), {
        schema: DEFAULT_SCHEMA,
      }) as Record<string, unknown>[]
      const shellTasks = tasks.map(shellOf).filter((s): s is string => !!s)
      // At least one shell task exists in each runner role.
      expect(shellTasks.length).toBeGreaterThan(0)
      for (const script of shellTasks) {
        // The ONLY Jinja interpolation permitted inside a shell body is a
        // trusted, Ansible-generated tempfile path (`*_tempfile.path`). Any
        // other `{{ ... }}` would splice tenant-controlled data (URL, dir,
        // user, ...) into shell text — the guard validates var *names* only,
        // so such a value could break out of quoting and inject commands.
        const stripped = script.replace(
          /\{\{\s*[\w.]*_tempfile\.path\s*\}\}/g,
          '',
        )
        expect(stripped).not.toContain('{{')
      }
    },
  )

  it.each(['gitlab_runner', 'github_runner'])(
    '%s は failed_when:false + fail 診断で、no_log タスク失敗時も原因を通知しトークン一時ファイルを残さない',
    (roleName) => {
      const content = readRole(roleName)
      expect(content).toContain('failed_when: false')
      expect(content).toContain('ansible.builtin.fail')
      // Cleanup of the token temp file is a dedicated (non-inline) task so it
      // runs even when the preceding no_log task fails.
      expect(content).toContain('state: absent')
    },
  )

  it('gitlab_runner は auth / registration の両トークンフローを実装している', () => {
    const content = readRole('gitlab_runner')
    expect(content).toContain('CI_SERVER_TOKEN')
    expect(content).toContain('REGISTRATION_TOKEN')
  })

  it('github_runner は PAT フローを uri モジュールで実装し、shell から curl を呼ばない', () => {
    const content = readRole('github_runner')
    expect(content).toContain('ansible.builtin.uri')
    // The PAT must never reach a shell command line; the uri module carries it
    // in a no_log Authorization header. Assert on shell task bodies (not the
    // header comment, which legitimately explains "no curl").
    const tasks = load(content, {
      schema: DEFAULT_SCHEMA,
    }) as Record<string, unknown>[]
    const shellTasks = tasks.map(shellOf).filter((s): s is string => !!s)
    for (const script of shellTasks) {
      expect(script).not.toContain('curl')
    }
  })
})
