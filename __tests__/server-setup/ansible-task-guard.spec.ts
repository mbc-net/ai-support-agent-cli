/**
 * Tests for src/server-setup/ansible-task-guard.ts
 *
 * カスタムAnsibleタスクは実行環境（agentホスト）への攻撃経路になり得るため、
 * ここでの検証ロジックの正確性が最重要（CLAUDE.md「セキュリティ上重要な変更」）。
 *
 * このテストは api/src/server-setup/__tests__/ansible-task-guard.spec.ts と
 * ロジックを完全に同期させたテストケース一覧を移植したもの（agent側の
 * validateCustomTasksYaml は api 側の実装と一字一句同一のロジック）。
 */

import { validateCustomTasksYaml } from '../../src/server-setup/ansible-task-guard'

describe('validateCustomTasksYaml', () => {
  const noSecrets = new Set<string>()

  describe('許可モジュールのみのタスク', () => {
    it('フルネーム（ansible.builtin.apt）のタスクは ok:true で通過する', () => {
      const yaml = `
- name: Install curl
  ansible.builtin.apt:
    name: curl
    state: present
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(true)
      expect(result.violations).toEqual([])
      expect(result.normalizedTasks).toBeDefined()
    })

    it('短縮形（apt）のタスクも ok:true で通過する（ansible.builtin. を省略した名前として正規化）', () => {
      const yaml = `
- name: Install curl
  apt:
    name: curl
    state: present
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(true)
      expect(result.violations).toEqual([])
    })

    it('複数タスクがすべて許可モジュールであれば ok:true', () => {
      const yaml = `
- name: Install curl
  apt:
    name: curl
    state: present
- name: Copy config
  ansible.builtin.copy:
    content: "hello"
    dest: b
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(true)
    })
  })

  describe('危険なタスクキーの拒否', () => {
    it('delegate_to を含むタスクは拒否される', () => {
      const yaml = `
- name: Run somewhere else
  ansible.builtin.debug:
    msg: hi
  delegate_to: localhost
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.key === 'delegate_to' && v.reason === 'forbidden task key',
        ),
      ).toBe(true)
    })

    it.each([
      'delegate_facts',
      'local_action',
      'connection',
      'become_method',
      'become_exe',
      'become_flags',
      'become_user',
      'vars',
      'environment',
      'notify',
      'listen',
      'import_playbook',
    ])('%s を含むタスクは拒否される', (forbiddenKey) => {
      const yaml = `
- name: Task with forbidden key
  ansible.builtin.debug:
    msg: hi
  ${forbiddenKey}: something
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.key === forbiddenKey && v.reason === 'forbidden task key',
        ),
      ).toBe(true)
    })
  })

  describe('allowlist外モジュールの拒否', () => {
    it('ansible.builtin.uri は allowlist 外のため拒否される', () => {
      const yaml = `
- name: Call an API
  ansible.builtin.uri:
    url: https://example.com
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) =>
            v.key === 'ansible.builtin.uri' &&
            v.reason === 'module not in allowlist',
        ),
      ).toBe(true)
    })

    it('モジュールキーが1つも無いタスク（制御キーのみ）は拒否される', () => {
      const yaml = `
- name: No module
  tags: foo
  when: true
  register: result
  no_log: true
  ignore_errors: true
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some((v) => v.reason === 'no recognized module key'),
      ).toBe(true)
    })
  })

  describe('lookup/query プラグイン参照の拒否', () => {
    it("lookup('file', '/etc/passwd') を含むタスクは拒否される", () => {
      const yaml = `
- name: Leak a file
  ansible.builtin.debug:
    msg: "{{ lookup('file', '/etc/passwd') }}"
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.reason === 'lookup/query plugin reference is forbidden',
        ),
      ).toBe(true)
    })

    it('query(...) 形式も拒否される', () => {
      const yaml = `
- name: Leak via query
  ansible.builtin.debug:
    msg: "{{ query('file', '/etc/passwd') }}"
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.reason === 'lookup/query plugin reference is forbidden',
        ),
      ).toBe(true)
    })
  })

  describe('play形式の拒否', () => {
    it('hosts: all を持つ play 形式の YAML は拒否される', () => {
      const yaml = `
hosts: all
tasks:
  - name: Install curl
    ansible.builtin.apt:
      name: curl
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) =>
            v.taskIndex === -1 &&
            v.reason === 'top-level must be a list of tasks, not a play',
        ),
      ).toBe(true)
    })

    it('配列の要素に hosts キーを持つ play 形式が混在する場合も拒否される', () => {
      const yaml = `
- hosts: all
  tasks: []
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.reason === 'top-level must be a list of tasks, not a play',
        ),
      ).toBe(true)
    })
  })

  describe('set_fact / register の予約語チェック', () => {
    it('set_fact で ansible_connection を設定しようとするタスクは拒否される', () => {
      const yaml = `
- name: Overwrite magic var
  ansible.builtin.set_fact:
    ansible_connection: local
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.reason === 'reserved or magic variable name',
        ),
      ).toBe(true)
    })

    it('register で予約語（hostvars）を使おうとするタスクは拒否される', () => {
      const yaml = `
- name: Register into reserved name
  ansible.builtin.command: echo hi
  register: hostvars
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) => v.reason === 'reserved or magic variable name',
        ),
      ).toBe(true)
    })

    it('通常の set_fact 変数名は許可される', () => {
      const yaml = `
- name: Set a normal fact
  ansible.builtin.set_fact:
    my_custom_var: hello
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(true)
    })
  })

  describe('secret変数参照タスクへの no_log 付与', () => {
    it('secretVarNames を {{ }} 参照するタスクには no_log: true が付与されて返る', () => {
      const yaml = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ DB_PASSWORD }}"
`
      const result = validateCustomTasksYaml(
        yaml,
        'database',
        new Set(['DB_PASSWORD']),
      )
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBe(true)
    })

    it('secret参照が前後の空白を含む場合（{{  DB_PASSWORD  }}）も検出する', () => {
      const yaml = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{  DB_PASSWORD  }}"
`
      const result = validateCustomTasksYaml(
        yaml,
        'database',
        new Set(['DB_PASSWORD']),
      )
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBe(true)
    })

    it('secret変数を参照しないタスクには no_log が付与されない', () => {
      const yaml = `
- name: Plain task
  ansible.builtin.debug:
    msg: hello
`
      const result = validateCustomTasksYaml(
        yaml,
        'database',
        new Set(['DB_PASSWORD']),
      )
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBeUndefined()
    })

    describe('Jinjaフィルタ付き・複数変数混在のsecret参照検出（no_log見落とし防止）', () => {
      it('{{ SECRET_NAME | quote }} を含むタスクにも no_log: true が付与される', () => {
        const yaml = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ SECRET_NAME | quote }}"
`
        const result = validateCustomTasksYaml(
          yaml,
          'database',
          new Set(['SECRET_NAME']),
        )
        expect(result.ok).toBe(true)
        const task = result.normalizedTasks?.[0] as Record<string, unknown>
        expect(task.no_log).toBe(true)
      })

      it("{{ SECRET_NAME | default('x') }} を含むタスクにも no_log: true が付与される", () => {
        const yaml = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ SECRET_NAME | default('x') }}"
`
        const result = validateCustomTasksYaml(
          yaml,
          'database',
          new Set(['SECRET_NAME']),
        )
        expect(result.ok).toBe(true)
        const task = result.normalizedTasks?.[0] as Record<string, unknown>
        expect(task.no_log).toBe(true)
      })

      it('複数変数が混在する式（"{{ A }}-{{ SECRET_NAME }}"）でも検出される', () => {
        const yaml = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ A }}-{{ SECRET_NAME }}"
`
        const result = validateCustomTasksYaml(
          yaml,
          'database',
          new Set(['SECRET_NAME']),
        )
        expect(result.ok).toBe(true)
        const task = result.normalizedTasks?.[0] as Record<string, unknown>
        expect(task.no_log).toBe(true)
      })
    })
  })

  describe('copy/template モジュールのローカルファイル読み取り拒否', () => {
    it('ansible.builtin.template は allowlist 外として拒否される（フルネーム）', () => {
      const yaml = `
- name: Render config
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/app.conf
`
      const result = validateCustomTasksYaml(yaml, 'web_server', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) =>
            v.key === 'ansible.builtin.template' &&
            v.reason === 'module not in allowlist',
        ),
      ).toBe(true)
    })

    it('template（短縮形）も allowlist 外として拒否される', () => {
      const yaml = `
- name: Render config
  template:
    src: app.conf.j2
    dest: /etc/app.conf
`
      const result = validateCustomTasksYaml(yaml, 'web_server', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some((v) => v.reason === 'module not in allowlist'),
      ).toBe(true)
    })

    it('ansible.builtin.copy で src を指定したタスクは拒否される（agentホストのローカルファイル読み取り防止）', () => {
      const yaml = `
- name: leak
  ansible.builtin.copy:
    src: /etc/passwd
    dest: /tmp/leak
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) =>
            v.key === 'src' &&
            v.reason ===
              'copy module must use content, not a controller-local src path',
        ),
      ).toBe(true)
    })

    it('ansible.builtin.copy で content + dest のみのタスクは引き続き許可される', () => {
      const yaml = `
- name: write config
  ansible.builtin.copy:
    content: "hello world"
    dest: /etc/app.conf
`
      const result = validateCustomTasksYaml(yaml, 'os_init', noSecrets)
      expect(result.ok).toBe(true)
    })
  })

  describe('正規化（name 前置）', () => {
    it("正規化後、name に '<stepType> : ' が前置される", () => {
      const yaml = `
- name: Install nginx
  apt:
    name: nginx
`
      const result = validateCustomTasksYaml(yaml, 'web_server', noSecrets)
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.name).toBe('web_server : Install nginx')
    })

    it('name が無い場合はモジュールキーの要約を使って前置する', () => {
      const yaml = `
- apt:
    name: nginx
`
      const result = validateCustomTasksYaml(yaml, 'web_server', noSecrets)
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.name).toMatch(/^web_server : /)
    })
  })

  describe('パース不能なYAML', () => {
    it('不正なYAML構文は ok:false を返す', () => {
      const result = validateCustomTasksYaml('foo: [bar', 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
    })

    it('タスク配列でなくスカラー値の場合は拒否される', () => {
      const result = validateCustomTasksYaml('just a string', 'os_init', noSecrets)
      expect(result.ok).toBe(false)
    })

    it('タスク配列の要素がオブジェクトでない場合は拒否される', () => {
      const result = validateCustomTasksYaml('- just a string', 'os_init', noSecrets)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some((v) => v.reason === 'each task must be a mapping'),
      ).toBe(true)
    })
  })
})
