import {
  AnsibleTaskViolation,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * モジュール引数を「マッピング以外の形」で渡す経路の検証。
 *
 * ガードの一部の検査（`copy` の `src` 拒否、`debug.var` / `assert.that` の素の式に対する
 * 秘匿値の no_log 付与など）は、モジュール引数がマッピングで書かれていることを前提に
 * している。一方で ansible-core 2.17 の `ModuleArgsParser` / `parse_kv` は
 *   module: key=value key2=value2
 * という文字列形式や、文字列全体がテンプレートの形（`_variable_params` 経由）も受理し、
 * 実行時にはマッピングと同じ引数へ展開する（本リポジトリの PoC playbook で実測）。
 * そのためマッピング前提の検査はこれらの形式を素通りさせる。
 *
 * ここでのテストは推奨修正案に依存しない形で書く——
 * 「拒否される（ok:false）」か、no_log 系は「拒否されるか no_log が付く」のどちらか。
 */
describe('モジュール引数の文字列（free-form）形式の検証', () => {
  const ecs = { mode: 'ecs' as const, targetOs: 'linux' as const }
  const resident = { mode: 'resident' as const, targetOs: 'linux' as const }

  const hasReason = (
    violations: AnsibleTaskViolation[],
    predicate: (v: AnsibleTaskViolation) => boolean,
  ): boolean => violations.some(predicate)

  describe('copy の src（コントローラ側ファイル読み取り）は文字列形式でも拒否されるべき', () => {
    // マッピング形式（`copy: { src: ... }`）は既存テストで拒否される。
    // 文字列形式は `isPlainObject(moduleArgs)` ガードを満たさず、src 検査が一度も走らない。
    const bodies: Array<[string, string, { mode: 'ecs' | 'resident'; targetOs: 'linux' }]> = [
      [
        'FQCN k=v 形式・ecs',
        `- name: copy via kv\n  ansible.builtin.copy: src=/some/controller/path dest=/tmp/x`,
        ecs,
      ],
      [
        'FQCN k=v 形式・resident',
        `- name: copy via kv\n  ansible.builtin.copy: src=/some/controller/path dest=/tmp/x`,
        resident,
      ],
      [
        '短縮形 k=v 形式・ecs',
        `- name: copy via kv short\n  copy: src=/some/controller/path dest=/tmp/x`,
        ecs,
      ],
      [
        '短縮形 k=v 形式・resident',
        `- name: copy via kv short\n  copy: src=/some/controller/path dest=/tmp/x`,
        resident,
      ],
      [
        '文字列全体がテンプレート（_variable_params 経由）・ecs',
        `- name: copy via whole template\n  ansible.builtin.copy: "{{ copy_args }}"`,
        ecs,
      ],
    ]
    it.each(bodies)('%s は拒否される', (_label, body, opts) => {
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(false)
      // 理由は src / free-form / 文字列形式 のいずれかに言及していること（修正案非依存）。
      expect(
        hasReason(
          result.violations,
          (v) =>
            v.key === 'src' ||
            /src|free-form|mapping|string|controller/i.test(v.reason),
        ),
      ).toBe(true)
    })
  })

  describe('debug.var / assert.that を素の式として文字列形式で書くと秘匿値が漏れる', () => {
    // マッピング形式なら `var` / `that` は BARE_JINJA_KEYS として走査され、no_log が付く。
    // 文字列形式（`debug: var=SECRET`）では走査されず、秘匿値が no_log なしで実行ログへ出る。
    it('debug: var=SECRET（文字列形式）は拒否されるか no_log が付く', () => {
      const body = `- name: dump secret\n  ansible.builtin.debug: var=DB_PASSWORD`
      const result = validateAnsibleTasks(body, {
        mode: 'ecs',
        targetOs: 'linux',
        secretVarNames: new Set(['DB_PASSWORD']),
      })
      const task = (result.normalizedTasks ?? [])[0] as
        | Record<string, unknown>
        | undefined
      expect(result.ok === false || task?.no_log === true).toBe(true)
    })

    it('assert: that="SECRET is match(...)"（文字列形式）は拒否されるか no_log が付く', () => {
      const body = `- name: oracle\n  ansible.builtin.assert: that="DB_PASSWORD is match('^a')"`
      const result = validateAnsibleTasks(body, {
        mode: 'ecs',
        targetOs: 'linux',
        secretVarNames: new Set(['DB_PASSWORD']),
      })
      const task = (result.normalizedTasks ?? [])[0] as
        | Record<string, unknown>
        | undefined
      expect(result.ok === false || task?.no_log === true).toBe(true)
    })
  })

  describe('修正後も通るべき正常系（現行でも緑であること）', () => {
    it('command の文字列形式（本物の free-form）は許可される', () => {
      const body = `- name: run cmd\n  ansible.builtin.command: cat /etc/hostname`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })

    it('shell の文字列形式（本物の free-form）は許可される', () => {
      const body = `- name: run shell\n  ansible.builtin.shell: echo hello > /tmp/x`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })

    it('copy の content + dest（マッピング形式）は許可される', () => {
      const body = `- name: write config\n  ansible.builtin.copy:\n    content: "hello world"\n    dest: /etc/app.conf`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })
  })
})
