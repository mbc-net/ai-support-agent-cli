import {
  AnsibleTaskViolation,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * validateAnsibleTasks のテスト。
 *
 * レシピ本体（body = Ansible タスク列 YAML）は実行環境（agentホスト / 当社 ECS）への
 * 攻撃経路になり得るため、ここでの検証ロジックの正確性が最重要
 * （CLAUDE.md「セキュリティ上重要な変更」）。
 */
describe('validateAnsibleTasks', () => {
  const ecs = { mode: 'ecs' as const }
  const resident = { mode: 'resident' as const }

  const hasReason = (
    violations: AnsibleTaskViolation[],
    predicate: (v: AnsibleTaskViolation) => boolean,
  ): boolean => violations.some(predicate)

  describe('許可モジュールのみのタスク', () => {
    it('フルネーム（ansible.builtin.apt）のタスクは ok:true で通過する', () => {
      const body = `
- name: Install curl
  ansible.builtin.apt:
    name: curl
    state: present
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(true)
      expect(result.violations).toEqual([])
      expect(result.normalizedTasks).toBeDefined()
    })

    it('短縮形（apt）のタスクも ok:true で通過する', () => {
      const body = `
- name: Install curl
  apt:
    name: curl
    state: present
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(true)
    })
  })

  describe('危険なタスクキーの拒否（両モード）', () => {
    it.each([
      'delegate_to',
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
    ])('%s を含むタスクは ecs/resident 双方で拒否される', (forbiddenKey) => {
      const body = `
- name: Task with forbidden key
  ansible.builtin.debug:
    msg: hi
  ${forbiddenKey}: something
`
      for (const opts of [ecs, resident]) {
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        expect(
          hasReason(
            result.violations,
            (v) => v.key === forbiddenKey && v.reason === 'forbidden task key',
          ),
        ).toBe(true)
      }
    })
  })

  describe('経路別モジュール allowlist', () => {
    it('ansible.builtin.uri は ecs では拒否される', () => {
      const body = `
- name: Call an API
  ansible.builtin.uri:
    url: https://example.com
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(
          result.violations,
          (v) => v.key === 'ansible.builtin.uri' && v.reason === 'module not in allowlist',
        ),
      ).toBe(true)
    })

    it('ansible.builtin.uri は resident では許可される（allowlist 寛容化）', () => {
      const body = `
- name: Call an API
  ansible.builtin.uri:
    url: https://example.com
`
      const result = validateAnsibleTasks(body, resident)
      expect(result.ok).toBe(true)
    })

    it('resident で追加許可される短縮形（git）も通過する', () => {
      const body = `
- name: Clone repo
  git:
    repo: https://example.com/x.git
    dest: /opt/x
`
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
      expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
    })

    it('ansible.posix.authorized_key はベース allowlist に昇格済みのため ecs/resident 双方で許可される（ssh_key 組み込みステップ用）', () => {
      const body = `
- name: Add SSH public key
  ansible.posix.authorized_key:
    user: appuser
    key: "{{ SSH_PUBLIC_KEY }}"
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
    })

    it('モジュールキーが1つも無いタスク（制御キーのみ）は拒否される', () => {
      const body = `
- name: No module
  when: true
  register: result
  no_log: true
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(hasReason(result.violations, (v) => v.reason === 'no recognized module key')).toBe(
        true,
      )
    })
  })

  describe('include_role スニペットの検証', () => {
    it.each(['os_init', 'docker', 'web_server', 'database', 'dns_tls', 'ssh_key'])(
      'include_role name=%s（許可された 6 ロール）は通過する',
      (roleName) => {
        const body = `
- name: bundled step
  include_role:
    name: ${roleName}
`
        expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      },
    )

    it('許可されていないロール名は拒否される', () => {
      const body = `
- name: bundled step
  include_role:
    name: rootkit
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(
          result.violations,
          (v) =>
            v.key === 'name' &&
            v.reason === 'include_role name is not one of the allowed bundled roles',
        ),
      ).toBe(true)
    })

    it('include_role の直後の task レベル vars（ロール変数）は許可される', () => {
      // `ansible.builtin.include_role` に `vars` というモジュールパラメータは存在しない
      // （実機の ansible-playbook --syntax-check で確認済み）。ロール変数は
      // include_role: と同じインデントの task レベル vars: で渡す。
      const body = `
- name: bundled step
  include_role:
    name: web_server
  vars:
    web_server_port: 8080
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })

    it('include_role のモジュール引数内にネストした vars は拒否される（Ansible的に無効な構文のため）', () => {
      const body = `
- name: bundled step
  include_role:
    name: web_server
    vars:
      web_server_port: 8080
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(
          result.violations,
          (v) => v.key === 'vars' && v.reason === 'include_role param key is not allowed',
        ),
      ).toBe(true)
    })

    it('include_role の許可されていない param キーは拒否される', () => {
      const body = `
- name: bundled step
  include_role:
    name: web_server
    apply:
      become: true
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(
          result.violations,
          (v) => v.key === 'apply' && v.reason === 'include_role param key is not allowed',
        ),
      ).toBe(true)
    })

    it('include_role の引数がマッピングでない場合は拒否される', () => {
      const body = `
- name: bundled step
  include_role: os_init
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(result.violations, (v) => v.reason === 'include_role args must be a mapping'),
      ).toBe(true)
    })

    describe('include_role 直後の task レベル vars の予約語・マジック変数名注入拒否（両モード）', () => {
      it('vars に ansible_connection を含む include_role は ecs/resident 双方で拒否される', () => {
        // 攻撃再現: 固定 become:true の play を agent ホスト自身へリダイレクトする試み。
        const body = `
- name: bundled step
  include_role:
    name: web_server
  vars:
    ansible_connection: local
`
        for (const opts of [ecs, resident]) {
          const result = validateAnsibleTasks(body, opts)
          expect(result.ok).toBe(false)
          expect(
            hasReason(
              result.violations,
              (v) =>
                v.key === 'ansible_connection' &&
                v.reason === 'reserved or magic variable name in include_role vars',
            ),
          ).toBe(true)
        }
      })

      it.each([
        'ansible_host',
        'ansible_become',
        'ansible_python_interpreter',
        'hostvars',
        'inventory_hostname',
        'environment',
      ])(
        'vars に予約語/マジック変数名 %s を含む include_role は拒否される',
        (varName) => {
          const body = `
- name: bundled step
  include_role:
    name: docker
  vars:
    ${varName}: something
`
          for (const opts of [ecs, resident]) {
            const result = validateAnsibleTasks(body, opts)
            expect(result.ok).toBe(false)
            expect(
              hasReason(
                result.violations,
                (v) =>
                  v.key === varName &&
                  v.reason === 'reserved or magic variable name in include_role vars',
              ),
            ).toBe(true)
          }
        },
      )

      it('vars に通常のロール変数（web_server_port 等）のみを含む include_role は許可される', () => {
        const body = `
- name: bundled step
  include_role:
    name: web_server
  vars:
    web_server_port: 8080
    web_server_type: nginx
`
        expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
        expect(validateAnsibleTasks(body, resident).ok).toBe(true)
      })

      it('vars 値に lookup(...) を含む include_role は拒否される（タスク全体再帰で検出）', () => {
        const body = `
- name: bundled step
  include_role:
    name: database
  vars:
    db_password: "{{ lookup('file', '/etc/secret') }}"
`
        for (const opts of [ecs, resident]) {
          const result = validateAnsibleTasks(body, opts)
          expect(result.ok).toBe(false)
          expect(
            hasReason(
              result.violations,
              (v) => v.reason === 'lookup/query plugin reference is forbidden',
            ),
          ).toBe(true)
        }
      })
    })

    describe('include_role.tasks_from のパストラバーサル拒否（両モード）', () => {
      it.each(['../x', '../../etc/passwd', 'sub/dir', 'a/b', 'x..y/../z'])(
        'tasks_from=%s（パス区切り・.. を含む）は ecs/resident 双方で拒否される',
        (tasksFrom) => {
          const body = `
- name: bundled step
  include_role:
    name: os_init
    tasks_from: "${tasksFrom}"
`
          for (const opts of [ecs, resident]) {
            const result = validateAnsibleTasks(body, opts)
            expect(result.ok).toBe(false)
            expect(
              hasReason(
                result.violations,
                (v) =>
                  v.key === 'tasks_from' &&
                  v.reason ===
                    'include_role tasks_from must match [A-Za-z0-9_-]+ (no path separators)',
              ),
            ).toBe(true)
          }
        },
      )

      it('tasks_from が文字列でない（マッピング）場合も拒否される', () => {
        const body = `
- name: bundled step
  include_role:
    name: os_init
    tasks_from:
      evil: true
`
        const result = validateAnsibleTasks(body, ecs)
        expect(result.ok).toBe(false)
        expect(
          hasReason(result.violations, (v) => v.key === 'tasks_from'),
        ).toBe(true)
      })

      it.each(['setup', 'alt_tasks', 'tasks-2', 'main'])(
        'tasks_from=%s（英数・_・- のみ）は許可される',
        (tasksFrom) => {
          const body = `
- name: bundled step
  include_role:
    name: os_init
    tasks_from: ${tasksFrom}
`
          expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
          expect(validateAnsibleTasks(body, resident).ok).toBe(true)
        },
      )
    })
  })

  describe('copy/template モジュールのローカルファイル読み取り拒否（両モード）', () => {
    it('ansible.builtin.template は allowlist 外として拒否される（両モード）', () => {
      const body = `
- name: Render config
  ansible.builtin.template:
    src: app.conf.j2
    dest: /etc/app.conf
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
      expect(validateAnsibleTasks(body, resident).ok).toBe(false)
    })

    it('copy で src を指定したタスクは両モードで拒否される', () => {
      const body = `
- name: leak
  ansible.builtin.copy:
    src: /etc/passwd
    dest: /tmp/leak
`
      for (const opts of [ecs, resident]) {
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        expect(
          hasReason(
            result.violations,
            (v) =>
              v.key === 'src' &&
              v.reason === 'copy module must use content, not a controller-local src path',
          ),
        ).toBe(true)
      }
    })

    it('copy で content + dest のみのタスクは許可される', () => {
      const body = `
- name: write config
  ansible.builtin.copy:
    content: "hello world"
    dest: /etc/app.conf
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })
  })

  describe('lookup/query プラグイン参照の拒否（両モード）', () => {
    it("lookup('file', '/etc/passwd') を含むタスクは拒否される", () => {
      const body = `
- name: Leak a file
  ansible.builtin.debug:
    msg: "{{ lookup('file', '/etc/passwd') }}"
`
      for (const opts of [ecs, resident]) {
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        expect(
          hasReason(
            result.violations,
            (v) => v.reason === 'lookup/query plugin reference is forbidden',
          ),
        ).toBe(true)
      }
    })
  })

  describe('play形式の拒否', () => {
    it('hosts: all を持つ play 形式の YAML は拒否される', () => {
      const body = `
hosts: all
tasks:
  - name: Install curl
    ansible.builtin.apt:
      name: curl
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(
          result.violations,
          (v) =>
            v.taskIndex === -1 && v.reason === 'top-level must be a list of tasks, not a play',
        ),
      ).toBe(true)
    })

    it('配列の要素に hosts キーを持つ play 形式が混在する場合も拒否される', () => {
      const body = `
- hosts: all
  tasks: []
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
    })
  })

  describe('set_fact / register の予約語チェック', () => {
    it('set_fact で ansible_connection を設定しようとするタスクは拒否される', () => {
      const body = `
- name: Overwrite magic var
  ansible.builtin.set_fact:
    ansible_connection: local
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(result.violations, (v) => v.reason === 'reserved or magic variable name'),
      ).toBe(true)
    })

    it('register で予約語（hostvars）を使おうとするタスクは拒否される', () => {
      const body = `
- name: Register into reserved name
  ansible.builtin.command: echo hi
  register: hostvars
`
      const result = validateAnsibleTasks(body, ecs)
      expect(result.ok).toBe(false)
      expect(
        hasReason(result.violations, (v) => v.reason === 'reserved or magic variable name'),
      ).toBe(true)
    })

    it('通常の set_fact 変数名は許可される', () => {
      const body = `
- name: Set a normal fact
  ansible.builtin.set_fact:
    my_custom_var: hello
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
    })
  })

  describe('secret変数参照タスクへの no_log 付与', () => {
    it('secretVarNames を {{ }} 参照するタスクには no_log: true が付与されて返る', () => {
      const body = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ DB_PASSWORD }}"
`
      const result = validateAnsibleTasks(body, {
        mode: 'resident',
        secretVarNames: new Set(['DB_PASSWORD']),
      })
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBe(true)
    })

    it('Jinjaフィルタ付き参照（{{ SECRET_NAME | quote }}）でも no_log が付与される', () => {
      const body = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ SECRET_NAME | quote }}"
`
      const result = validateAnsibleTasks(body, {
        mode: 'ecs',
        secretVarNames: new Set(['SECRET_NAME']),
      })
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBe(true)
    })

    it('secret変数を参照しないタスクには no_log が付与されない', () => {
      const body = `
- name: Plain task
  ansible.builtin.debug:
    msg: hello
`
      const result = validateAnsibleTasks(body, {
        mode: 'ecs',
        secretVarNames: new Set(['DB_PASSWORD']),
      })
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBeUndefined()
    })

    // Regression: server-setup-runner.ts's buildInventory sets
    // ansible_ssh_pass for authType: 'password' hosts. Without this,
    // ansible.builtin.assert with fail_msg: "{{ ansible_ssh_pass }}" (or
    // ansible.builtin.debug referencing the same variable) would leak the
    // plaintext SSH password into stepResults[].message / the top-level
    // error string, since secretVarNames (tenant ANSIBLE# variables) never
    // includes it. This must be caught even with an empty/absent
    // secretVarNames (e.g. api-save-time validation).
    it.each([
      ['ansible_ssh_pass', '{{ ansible_ssh_pass }}'],
      ['ansible_ssh_private_key_file', '{{ ansible_ssh_private_key_file }}'],
      ['ansible_become_pass', '{{ ansible_become_pass }}'],
      ['ansible_password', '{{ ansible_password }}'],
    ])('forces no_log on a task referencing the reserved connection var %s, even with no secretVarNames', (_name, expr) => {
      const body = `
- name: Leak connection secret
  ansible.builtin.debug:
    msg: "${expr}"
`
      const result = validateAnsibleTasks(body, { mode: 'ecs' })
      expect(result.ok).toBe(true)
      const task = result.normalizedTasks?.[0] as Record<string, unknown>
      expect(task.no_log).toBe(true)
    })
  })

  describe('不正な入力', () => {
    it('不正なYAML構文は ok:false を返す', () => {
      const result = validateAnsibleTasks('foo: [bar', ecs)
      expect(result.ok).toBe(false)
      expect(result.violations.length).toBeGreaterThan(0)
    })

    it('タスク配列でなくスカラー値の場合は拒否される', () => {
      const result = validateAnsibleTasks('just a string', ecs)
      expect(result.ok).toBe(false)
    })

    it('空配列は拒否される', () => {
      const result = validateAnsibleTasks('[]', ecs)
      expect(result.ok).toBe(false)
      expect(hasReason(result.violations, (v) => v.reason === 'tasks list must not be empty')).toBe(
        true,
      )
    })
  })
})
