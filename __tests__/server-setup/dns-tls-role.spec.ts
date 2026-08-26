import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `dns_tls` ロールの不変条件を検証する回帰テスト。
 *
 * 検証対象は2点。
 *
 * 1. ACME 登録メール（`acme_email`）が Caddyfile へ届くこと。未設定だと
 *    Let's Encrypt からの有効期限切れ予告メールが誰にも届かず、Caddy の自動更新が
 *    継続的に失敗しても失効するまで気づけない。
 * 2. `domain` / `acme_email` の検証が `$` ではなく `\Z` で終端されていること。
 *    Python の `$` は末尾の改行の直前にもマッチするため、`"example.com\n..."` が
 *    `$` 終端のパターンを通過し、Caddyfile へ任意の行を注入できてしまう。
 *
 * ansible-playbook を実機で走らせる機能テストは特権が必要で本 CI では実行できない
 * ため、YAML とテンプレートの構造を直接検証する（k3s ロールの順序検証と同じ方針）。
 */
const ROLE_DIR = join(__dirname, '../../ansible/roles/dns_tls')

interface AnsibleTask {
  name?: string
  'ansible.builtin.assert'?: { that?: string[]; fail_msg?: string }
  when?: unknown
  [key: string]: unknown
}

function loadTasks(): AnsibleTask[] {
  const raw = readFileSync(join(ROLE_DIR, 'tasks/main.yml'), 'utf8')
  return load(raw, { schema: DEFAULT_SCHEMA }) as AnsibleTask[]
}

function loadDefaults(): Record<string, unknown> {
  const raw = readFileSync(join(ROLE_DIR, 'defaults/main.yml'), 'utf8')
  return load(raw, { schema: DEFAULT_SCHEMA }) as Record<string, unknown>
}

function loadTemplate(): string {
  return readFileSync(join(ROLE_DIR, 'templates/Caddyfile.j2'), 'utf8')
}

function assertionsOf(task: AnsibleTask): string[] {
  return task['ansible.builtin.assert']?.that ?? []
}

describe('dns_tls role: acme_email', () => {
  it('defaults に acme_email があり、既定は空である', () => {
    // 既定を空にしておくのは、既に稼働しているホストの Caddyfile を
    // このロールの更新だけで書き換えないため。
    expect(loadDefaults()).toHaveProperty('acme_email', '')
  })

  it('Caddyfile テンプレートが acme_email をグローバルオプションの email へ書く', () => {
    const template = loadTemplate()
    expect(template).toContain('email {{ acme_email }}')
  })

  it('acme_email が空のときはグローバルオプションを出力しない', () => {
    // 空の `{ }` ブロックを吐くと Caddy の起動に影響しうるため、条件で囲む。
    const template = loadTemplate()
    expect(template).toMatch(/\{%\s*if acme_email\s*%\}/)
    expect(template).toMatch(/\{%\s*endif\s*%\}/)
  })

  it('acme_email を検証するタスクがあり、空のときだけスキップする', () => {
    const task = loadTasks().find((t) =>
      t.name?.includes('Validate acme_email'),
    )
    expect(task).toBeDefined()
    expect(String(task?.when)).toContain('acme_email')
    expect(assertionsOf(task!).join(' ')).toContain('acme_email is match(')
  })
})

describe('dns_tls role: 検証パターンの終端', () => {
  /**
   * Python の `re.match` では `$` が末尾の改行の直前にもマッチする。
   * 終端が `$` のままだと `"example.com\n"` のような値が検証を通り、
   * Caddyfile へ改行以降を注入できる。
   */
  it.each([
    ['Validate domain', 'domain is match('],
    ['Validate acme_email', 'acme_email is match('],
  ])('%s のパターンは \\Z で終端している', (namePart, assertionPart) => {
    const task = loadTasks().find((t) => t.name?.includes(namePart))
    expect(task).toBeDefined()

    const assertion = assertionsOf(task!).find((a) => a.includes(assertionPart))
    expect(assertion).toBeDefined()
    expect(assertion).toContain('\\Z')
    expect(assertion).not.toContain('$')
  })
})

describe('dns_tls role: 検証パターンの実挙動', () => {
  /**
   * ロールの正規表現をそのまま JavaScript で評価して、意図した値だけを
   * 受け付けることを確かめる。`\Z` は JS に無いため `$`（JS の `$` は
   * 既定で末尾のみにマッチし、Python と異なり改行を許さない）へ読み替える。
   */
  function patternOf(namePart: string, assertionPart: string): RegExp {
    const task = loadTasks().find((t) => t.name?.includes(namePart))
    const assertion = assertionsOf(task!).find((a) => a.includes(assertionPart))!
    const source = assertion.slice(
      assertion.indexOf("match('") + "match('".length,
      assertion.lastIndexOf("')"),
    )
    return new RegExp(source.replace('\\Z', '$'))
  }

  it('domain: FQDN を受け付け、改行つきの値を拒否する', () => {
    const pattern = patternOf('Validate domain', 'domain is match(')
    expect(pattern.test('example.com')).toBe(true)
    expect(pattern.test('backup-api.ai-support-agent.com')).toBe(true)
    expect(pattern.test('example.com\n')).toBe(false)
    expect(pattern.test('example.com\nevil.com')).toBe(false)
    expect(pattern.test('localhost')).toBe(false)
    expect(pattern.test('example.com {')).toBe(false)
  })

  it('acme_email: 通常のアドレスを受け付け、改行つきの値を拒否する', () => {
    const pattern = patternOf('Validate acme_email', 'acme_email is match(')
    expect(pattern.test('ops@example.com')).toBe(true)
    expect(pattern.test('ops+tls@sub.example.co.jp')).toBe(true)
    expect(pattern.test('ops@example.com\n')).toBe(false)
    expect(pattern.test('ops@example.com\nemail evil@example.com')).toBe(false)
    expect(pattern.test('not-an-email')).toBe(false)
  })
})
