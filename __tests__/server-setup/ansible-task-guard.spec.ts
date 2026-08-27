import { readdirSync } from 'fs'
import * as path from 'path'

import {
  AnsibleTaskViolation,
  INCLUDE_ROLE_ALLOWED_ROLES,
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
    it.each([
      'os_init',
      'docker',
      'web_server',
      'database',
      'dns_tls',
      'ssh_key',
      'nvm',
      'claude_cli',
      'codex',
      'ai_support_agent',
      'k3s',
      'tailscale',
    ])(
      'include_role name=%s（許可された 12 ロール）は通過する',
      (roleName) => {
        const body = `
- name: bundled step
  include_role:
    name: ${roleName}
`
        expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      },
    )

    it('INCLUDE_ROLE_ALLOWED_ROLES と ansible/roles/ 配下の実ディレクトリが1:1で対応する（allowlist追加漏れ・ロールdir追加漏れの非対称を検出）', () => {
      const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')
      const actualRoleDirs = readdirSync(rolesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()

      expect([...INCLUDE_ROLE_ALLOWED_ROLES].sort()).toEqual(actualRoleDirs)
    })

    describe('shared_file ロール（共有ファイルの配布）', () => {
      const sharedFileBody = (vars: string): string => `
- name: copy shared file
  ansible.builtin.include_role:
    name: shared_file
  vars:
${vars}
`

      it('リテラルの src / dest を持つタスクは ecs/resident 双方で通過する', () => {
        const body = sharedFileBody(
          "    shared_file_src: certs/server.pem\n" +
            "    shared_file_dest: /etc/ssl/app/server.pem\n" +
            "    shared_file_mode: '0600'",
        )
        expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
        expect(validateAnsibleTasks(body, resident).ok).toBe(true)
      })

      it('フォルダ指定（末尾スラッシュなし）も通過する', () => {
        const body = sharedFileBody(
          '    shared_file_src: certs\n    shared_file_dest: /etc/ssl/app/',
        )
        expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      })

      it('shared_file_src に Jinja テンプレートを含むと拒否する', () => {
        // エージェントは実行前に body を走査して取り寄せるファイルを決める。
        // テンプレートを許すと、実行時まで何を取り寄せるべきか決定できない。
        const body = sharedFileBody(
          '    shared_file_src: "{{ some_var }}"\n    shared_file_dest: /etc/app/',
        )
        const result = validateAnsibleTasks(body, ecs)
        expect(result.ok).toBe(false)
        expect(
          hasReason(result.violations, (v) => v.key === 'shared_file_src'),
        ).toBe(true)
      })

      it('shared_file_src が絶対パスなら拒否する', () => {
        const body = sharedFileBody(
          '    shared_file_src: /etc/passwd\n    shared_file_dest: /tmp/x',
        )
        expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
      })

      it('shared_file_src に .. を含むと拒否する（ステージング外への脱出）', () => {
        const body = sharedFileBody(
          '    shared_file_src: ../../etc/passwd\n    shared_file_dest: /tmp/x',
        )
        const result = validateAnsibleTasks(body, ecs)
        expect(result.ok).toBe(false)
        expect(
          hasReason(result.violations, (v) => v.key === 'shared_file_src'),
        ).toBe(true)
      })

      it('セグメント単体が .. のパスも拒否する', () => {
        const body = sharedFileBody(
          '    shared_file_src: certs/../../secret\n    shared_file_dest: /tmp/x',
        )
        expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
      })

      it('shared_file_src が無いと拒否する', () => {
        const body = sharedFileBody('    shared_file_dest: /etc/app/')
        const result = validateAnsibleTasks(body, ecs)
        expect(result.ok).toBe(false)
        expect(
          hasReason(result.violations, (v) => v.key === 'shared_file_src'),
        ).toBe(true)
      })

      it('shared_file_src が文字列でないと拒否する', () => {
        const body = sharedFileBody(
          '    shared_file_src: 123\n    shared_file_dest: /etc/app/',
        )
        expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
      })

      it('src の制約は shared_file 以外のロールには適用しないが、allowlist が別の理由で拒否する', () => {
        // 元々の意図は「shared_file 固有の src 検証が他ロールへ波及しないこと」で、それは
        // 今も成り立つ（reason に shared_file が現れない）。一方 INCLUDE_ROLE_ALLOWED_VARS
        // 導入後は、docker ロールの公開変数ではない名前を渡すこと自体が拒否される。
        const body = `
- name: unrelated role
  ansible.builtin.include_role:
    name: docker
  vars:
    shared_file_src: "{{ anything }}"
`
        const result = validateAnsibleTasks(body, ecs)
        expect(result.ok).toBe(false)
        const reasons = result.violations.map((v) => v.reason)
        expect(reasons).toContain("variable is not a public parameter of role 'docker'")
        expect(reasons.some((r) => r.includes('shared_file'))).toBe(false)
      })
    })

    it('include_role name=gitlab_runner（task レベル vars 付き）は ecs/resident 双方で通過する', () => {
      const body = `
- name: register gitlab runner
  include_role:
    name: gitlab_runner
  vars:
    gitlab_runner_url: https://gitlab.com
    gitlab_runner_auth_token: "{{ GITLAB_RUNNER_AUTH_TOKEN }}"
    gitlab_runner_executor: shell
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
    })

    it('include_role name=github_runner（task レベル vars 付き）は ecs/resident 双方で通過する', () => {
      const body = `
- name: register github runner
  include_role:
    name: github_runner
  vars:
    github_runner_url: https://github.com/OWNER/REPO
    github_runner_scope: repo
    github_runner_pat: "{{ GITHUB_RUNNER_PAT }}"
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
    })

    it('include_role name=k3s は task レベル vars（k3s_version / k3s_bootstrap / k3s_token）付きで ecs/resident 双方で通過する', () => {
      const body = `
- name: k3s クラスタ構築
  include_role:
    name: k3s
  vars:
    k3s_version: v1.33.4+k3s1
    k3s_bootstrap: init
    k3s_token: "{{ K3S_TOKEN }}"
    k3s_setup_disk: false
    gvisor_enabled: true
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
    })

    it('include_role name=tailscale は task レベル vars 付きで ecs/resident 双方で通過する', () => {
      const body = `
- name: Tailscale VPN参加
  include_role:
    name: tailscale
  vars:
    tailscale_authkey: "{{ MY_TAILSCALE_AUTHKEY }}"
    tailscale_ssh: true
    tailscale_advertise_routes: "192.168.0.0/24"
`
      expect(validateAnsibleTasks(body, ecs).ok).toBe(true)
      expect(validateAnsibleTasks(body, resident).ok).toBe(true)
    })

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
    web_server_type: nginx
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

      it('vars にそのロールの公開変数のみを含む include_role は許可される', () => {
        // 変数名は INCLUDE_ROLE_ALLOWED_VARS に載っている実在の公開変数であること。
        // 架空の名前（かつて web_server_port を使っていた）は allowlist 導入後は
        // 「そのロールの公開パラメータではない」として正しく拒否される。
        const body = `
- name: bundled step
  include_role:
    name: web_server
  vars:
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
        'tasks_from=%s（パス区切り・.. を含む）は ecs/resident 双方で拒否される（パラメータキー allowlist による）',
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
                  // `tasks_from` は文字種に関わらずパラメータキーの allowlist
                  // （`name` のみ）で拒否される。パストラバーサルはその部分集合であり、
                  // 専用の文字種チェックはもう存在しない。
                  v.key === 'tasks_from' &&
                  v.reason === 'include_role param key is not allowed',
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
        'tasks_from=%s は文字種が妥当でも拒否される（レシピからは tasks_from 自体を使えない）',
        (tasksFrom) => {
          // かつては「パス区切り・.. を含まなければ許可」だったが、tasks_from は
          // ロール内部のタスクファイルを直接呼べる＝main.yml の入力検証を迂回できる
          // 入口だったため、レシピからは一切使えないようにした。
          // 例: {name: zabbix_agent, tasks_from: ufw} は CIDR 検証を飛ばして ufw.yml を実行できた。
          const body = `
- name: bundled step
  include_role:
    name: os_init
    tasks_from: ${tasksFrom}
`
          expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
          expect(validateAnsibleTasks(body, resident).ok).toBe(false)
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

  describe('set_fact / register からロール内部へ書き込む迂回路の拒否', () => {
    // ここに並ぶ 3 つのペイロードは、いずれも実際にガードへ流して `ok=true`
    // （＝素通り）を確認したうえで塞いだもの。塞いだ理由を残すだけでは、将来
    // 検査を緩めたときに気づけないので、ペイロードそのものを固定する。
    //
    // 根っこは「`set_fact` は**変数名（キー）も**実行時に Jinja 展開する」こと。
    // 静的な文字列としては予約名にもロール接頭辞にも一致しない名前が、実行時には
    // 一致する名前になる。

    it.each([
      ['ecs' as const],
      ['resident' as const],
    ])('%s: Jinja で組み立てたキーによる予約変数の書き込みを拒否する', (mode) => {
      // ansible_connection を書ければ、以降の command/shell を対象ホストではなく
      // agent 側で実行させられる——ガードが塞ぐべき接続すり替えそのもの。
      const body = `
- name: t
  ansible.builtin.set_fact:
    "{{ 'ansible_' ~ 'connection' }}": local
`
      const result = validateAnsibleTasks(body, { mode })
      expect(result.ok).toBe(false)
      expect(result.violations.map((v) => v.reason)).toContain(
        'set_fact variable name must be a static identifier',
      )
    })

    it.each([['ecs' as const], ['resident' as const]])(
      '%s: Jinja で組み立てたキーによるロール名前空間への書き込みを拒否する',
      (mode) => {
        // rsyslog_forward の二重 include 検出フラグを戻す経路。
        const body = `
- name: t
  ansible.builtin.set_fact:
    "{{ 'rsyslog_forward_' ~ 'already_configured' }}": false
`
        const result = validateAnsibleTasks(body, { mode })
        expect(result.ok).toBe(false)
        expect(result.violations.map((v) => v.reason)).toContain(
          'set_fact variable name must be a static identifier',
        )
      },
    )

    it.each([['ecs' as const], ['resident' as const]])(
      '%s: free-form 文字列形式の set_fact を拒否する',
      (mode) => {
        // マッピングでないためキー検査が一度も走らず、予約名もロール名前空間も
        // そのまま書けていた。形式ごと拒否する。
        const body = `
- name: t
  ansible.builtin.set_fact: rsyslog_forward_already_configured=false
`
        const result = validateAnsibleTasks(body, { mode })
        expect(result.ok).toBe(false)
        expect(result.violations.map((v) => v.reason)).toContain(
          'set_fact args must be a mapping (free-form form is not allowed)',
        )
      },
    )

    it.each([['ecs' as const], ['resident' as const]])(
      '%s: 静的な名前でもロール名前空間への set_fact は拒否する',
      (mode) => {
        const body = `
- name: t
  ansible.builtin.set_fact:
    rsyslog_forward_already_configured: false
`
        const result = validateAnsibleTasks(body, { mode })
        expect(result.ok).toBe(false)
        expect(result.violations.map((v) => v.reason)).toContain(
          'set_fact must not write into a bundled role namespace',
        )
      },
    )

    it.each([['ecs' as const], ['resident' as const]])(
      '%s: register でロール名前空間へ書き込むことも拒否する',
      (mode) => {
        // register の結果も include params と同じく参照側から見える名前なので、
        // ロールが持つ名前を上書きできてしまう。
        const body = `
- name: t
  ansible.builtin.command:
    argv: [echo, x]
  register: rsyslog_forward_already_configured
`
        const result = validateAnsibleTasks(body, { mode })
        expect(result.ok).toBe(false)
        expect(result.violations.map((v) => v.reason)).toContain(
          'register must not write into a bundled role namespace',
        )
      },
    )

    it.each([['ecs' as const], ['resident' as const]])(
      '%s: ロール名前空間に属さない静的な set_fact は許可する',
      (mode) => {
        // 絞りすぎて正当なレシピを壊していないことの確認。
        const body = `
- name: t
  ansible.builtin.set_fact:
    my_local_value: 1
`
        expect(validateAnsibleTasks(body, { mode }).ok).toBe(true)
      },
    )
  })

describe('ロール内部変数の参照と、秘匿値の派生', () => {
  const bothModes: Array<['ecs' | 'resident', { mode: 'ecs' | 'resident' }]> = [
    ['ecs', { mode: 'ecs' }],
    ['resident', { mode: 'resident' }],
  ]

  // `include_role` の `public` を禁止しても、ロール内部の値はレシピから読める。
  // register / set_fact はロールスコープではなくホストの変数だからで、
  // ansible-core 2.21 で「ロール内で no_log 付きで register した値を、include の
  // あとの debug がそのまま出力する」ことを実測している。
  // `github_runner` は runner 登録トークンをこの形で register する。
  it.each(bothModes)(
    '[%s] ロールが register した秘匿値をレシピから参照できない',
    (_label, opts) => {
      const body = `
- name: Register a runner
  ansible.builtin.include_role:
    name: github_runner
- name: Leak the registration token
  ansible.builtin.debug:
    msg: "{{ github_runner_regtoken_resp.json.token }}"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(false)
      expect(
        hasReason(result.violations, (v) =>
          v.reason.includes("bundled role's internal variable"),
        ),
      ).toBe(true)
    },
  )

  it.each(bothModes)(
    '[%s] 波括弧を使わない参照経路も塞ぐ（{%% %%} / debug var / when）',
    (_label, opts) => {
      // `{{ }}` の中だけを走査していた時点では、この 3 つがすべて素通りしていた。
      // Jinja が値を評価する場所を数え上げる方針だと、数え漏らした場所がそのまま
      // 穴になるため、タスク全体を走査している。
      const bodies = [
        `
- name: leak via a Jinja statement
  ansible.builtin.debug:
    msg: "{%% set x = github_runner_regtoken_resp %%}{{ x.json.token }}"
`,
        `
- name: leak via debug var (takes a bare variable name)
  ansible.builtin.debug:
    var: github_runner_regtoken_resp
`,
        `
- name: leak via a when expression (bare Jinja, no braces)
  ansible.builtin.debug:
    msg: "probe"
  when: github_runner_regtoken_resp.json.token is match('^A')
`,
      ]
      for (const body of bodies) {
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        expect(
          hasReason(result.violations, (v) =>
            v.reason.includes("bundled role's internal variable"),
          ),
        ).toBe(true)
      }
    },
  )

  it.each(bothModes)(
    '[%s] ロール名で始まるだけのテナント変数は巻き添えにしない',
    (_label, opts) => {
      // `database_url` は `database` ロールの名前空間に見えるが、ロールが内部で
      // 使う名前ではない。接頭辞で参照禁止にすると、こういう既存レシピが
      // 一斉に動かなくなる。禁止は内部変数の実名リストで行う。
      const body = `
- name: Use a tenant variable
  ansible.builtin.debug:
    msg: "{{ database_url }}"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(true)
    },
  )

  it.each(bothModes)(
    '[%s] ロール名接頭辞を持たない内部変数（db_*）への書き込みも拒否する',
    (_label, opts) => {
      // `database` ロールだけは内部計算に `db_*` を使う。接頭辞ルールだけでは
      // 素通りするため、内部変数の実名リストでも照合する。
      const body = `
- name: Overwrite the role's computed password result
  ansible.builtin.set_fact:
    db_mysql_root_password_result: "faked"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(false)
      expect(
        hasReason(result.violations, (v) =>
          v.reason.includes('must not write into a bundled role namespace'),
        ),
      ).toBe(true)
    },
  )

  it.each(bothModes)(
    '[%s] 秘匿値を set_fact で移し替えても、以降の参照に no_log が付く',
    (_label, opts) => {
      const body = `
- name: Copy the secret under another name
  ansible.builtin.set_fact:
    copied: "{{ ansible_ssh_pass }}"
- name: Print the copy
  ansible.builtin.debug:
    msg: "{{ copied }}"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(true)
      // 1つ目だけでなく2つ目にも付くこと。付かないと接続パスワードが
      // 実行ログと stepResults[].message に平文で残る。
      expect(result.normalizedTasks?.[0]).toMatchObject({ no_log: true })
      expect(result.normalizedTasks?.[1]).toMatchObject({ no_log: true })
    },
  )

  it.each(bothModes)(
    '[%s] 秘匿値を参照したタスクの register 結果も秘匿として扱う',
    (_label, opts) => {
      const body = `
- name: Run a command with the secret
  ansible.builtin.command: "echo {{ ansible_become_pass }}"
  register: probe
- name: Print the captured output
  ansible.builtin.debug:
    msg: "{{ probe.stdout }}"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(true)
      expect(result.normalizedTasks?.[1]).toMatchObject({ no_log: true })
    },
  )

  it.each(bothModes)(
    '[%s] 秘匿値に触れないタスクには no_log を付けない',
    (_label, opts) => {
      // 伝播が広がりすぎていないことの対照。すべてに no_log が付くと
      // このテストは通るが、実行ログが何も読めなくなる。
      const body = `
- name: Harmless
  ansible.builtin.debug:
    msg: "{{ some_plain_var }}"
`
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(true)
      expect(result.normalizedTasks?.[0]).not.toMatchObject({ no_log: true })
    },
  )
})


describe('秘匿値の no_log は波括弧の有無に依存しない', () => {
  // 内部変数の参照禁止側だけを「タスク全体の走査」に直し、no_log 判定である
  // referencesSecretVar を `{{ }}` 限定のまま残していた。同じ穴が片方にだけ残る
  // という、このプロジェクトで繰り返し起きている「兄弟経路の非対称」である。
  // 判定は 1 つの関数に寄せたうえで、両方向にテストを置く。
  const modes: Array<['ecs' | 'resident', { mode: 'ecs' | 'resident' }]> = [
    ['ecs', { mode: 'ecs' }],
    ['resident', { mode: 'resident' }],
  ]

  const bodies: Array<[string, string]> = [
    [
      'debug の var は変数名そのものを取る（波括弧なし）',
      `
- name: t
  ansible.builtin.debug:
    var: ansible_ssh_pass
`,
    ],
    [
      'when は素の Jinja 式（正規表現で 1 文字ずつ読み出せる）',
      `
- name: t
  ansible.builtin.debug:
    msg: "probe"
  when: ansible_ssh_pass is match('^x')
`,
    ],
    [
      'Jinja ステートメントは {{ }} ではない',
      `
- name: t
  ansible.builtin.debug:
    msg: "{% set x = ansible_become_pass %}{{ x | b64encode }}"
`,
    ],
  ]

  it.each(modes)('[%s] 接続用の秘匿変数はどの書き方でも no_log が付く', (_label, opts) => {
    for (const [, body] of bodies) {
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(true)
      expect(result.normalizedTasks?.[0]).toMatchObject({ no_log: true })
    }
  })
})

describe('変数名を実行時に組み立てる参照', () => {
  const modes: Array<['ecs' | 'resident', { mode: 'ecs' | 'resident' }]> = [
    ['ecs', { mode: 'ecs' }],
    ['resident', { mode: 'resident' }],
  ]

  it.each(modes)('[%s] vars[...] の連結でロール内部変数へ辿れない', (_label, opts) => {
    // 静的な識別子で照合しているため、名前を分割して連結されると素通りする。
    // `set_fact` のキー側は既に静的識別子を要求しているのに、参照側だけ
    // 動的な組み立てを許していた。
    const body = `
- name: t
  ansible.builtin.debug:
    msg: "{{ vars['github_runner_' ~ 'regtoken_resp'].json.token }}"
`
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) => v.reason.includes('dynamic variable lookup')),
    ).toBe(true)
  })

  it.each(modes)('[%s] hostvars を丸ごと出力できない', (_label, opts) => {
    const body = `
- name: t
  ansible.builtin.debug:
    var: hostvars[inventory_hostname]
`
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) => v.reason.includes('dynamic variable lookup')),
    ).toBe(true)
  })

  // `vars` は添字アクセスに限らない。かつては `vars[` だけを見ていたため、下の 3 つは
  // すべて素通りしていた。いずれも実機（ansible-core 2.21）で、ロールが register した
  // 内部変数の値が実行ログへ出ることを確認している。
  it.each([
    ['bare', '{{ vars }}'],
    ['dict2items', '{{ vars | dict2items }}'],
    ['get', "{{ vars.get('github_runner_' ~ 'regtoken_resp') }}"],
  ])('[ecs] 添字を使わない vars 参照も拒否される（%s）', (_label, expression) => {
    const body = `
- name: t
  ansible.builtin.debug:
    msg: "${expression}"
`
    const result = validateAnsibleTasks(body, { mode: 'ecs' })
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) => v.reason.includes('dynamic variable lookup')),
    ).toBe(true)
  })

  it.each(modes)('[%s] 英単語としての vars は巻き添えにしない', (_label, opts) => {
    // Jinja 式の内側に限って判定しないと、この程度の記述で全滅する。
    const body = `
- name: Set some vars for the web server
  ansible.builtin.debug:
    msg: "configuring vars now"
`
    expect(validateAnsibleTasks(body, opts).ok).toBe(true)
  })

  it.each(modes)('[%s] 英単語としての hostvars も巻き添えにしない', (_label, opts) => {
    // `hostvars` / `getattr(` はタスク全体で見ていたため、値へ到達し得ない
    // ただの文章が `root` を key とする不可解な違反で拒否されていた。
    const body = `
- name: Print the hostvars summary
  ansible.builtin.debug:
    msg: hello
`
    expect(validateAnsibleTasks(body, opts).ok).toBe(true)
  })

  it.each(modes)('[%s] 散文にロール内部変数名が現れても拒否しない', (_label, opts) => {
    const body = `
- name: Document how k3s_ephemeral_device is chosen
  ansible.builtin.debug:
    msg: hello
`
    expect(validateAnsibleTasks(body, opts).ok).toBe(true)
  })

  it.each(modes)('[%s] 秘匿値の汚染が散文へ広がらない', (_label, opts) => {
    // `register` 名は `config` / `result` のような普通の英単語になりがちで、
    // タスク全体を字句解析していたときは、汚染名と同じ語を含むだけの無関係な
    // タスクにも `no_log` が付いた。`no_log` はモジュールの出力も失敗理由も
    // 消すので、サーバーセットアップの failure を追う手段そのものが失われる。
    const body = `
- name: Fetch app config
  ansible.builtin.shell: "curl -H 'X-Token: {{ API_TOKEN }}' https://example.com"
  register: config
- name: Restart the service to pick up the new config
  ansible.builtin.service:
    name: app
    state: restarted
`
    const result = validateAnsibleTasks(body, {
      ...opts,
      secretVarNames: new Set(['API_TOKEN']),
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0].no_log).toBe(true)
    expect(result.normalizedTasks?.[1].no_log).toBeUndefined()
  })

  // `assert` の `that` は素の Jinja 式のリストである。BARE_JINJA_KEYS から落ちていたため、
  // 秘匿値の 1 文字オラクル・内部変数の参照・`vars[...]` の 3 つがまとめて素通りしていた。
  it.each(modes)('[%s] assert の that から秘匿値を読むと no_log が付く', (_label, opts) => {
    const body = `
- name: oracle
  ansible.builtin.assert:
    that:
      - "DB_PASSWORD is match('^a')"
  ignore_errors: true
`
    const result = validateAnsibleTasks(body, {
      ...opts,
      secretVarNames: new Set(['DB_PASSWORD']),
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0].no_log).toBe(true)
  })

  it.each(modes)('[%s] assert の that からロール内部変数は参照できない', (_label, opts) => {
    const body = `
- name: probe
  ansible.builtin.assert:
    that:
      - "github_runner_regtoken_resp.json.token is defined"
`
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) =>
        v.reason.includes("must not reference a bundled role's internal variable"),
      ),
    ).toBe(true)
  })

  it.each(modes)('[%s] assert の that から vars で辿ることもできない', (_label, opts) => {
    const body = `
- name: probe
  ansible.builtin.assert:
    that:
      - "vars['github_runner_' ~ 'regtoken_resp'] is defined"
`
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) => v.reason.includes('dynamic variable lookup')),
    ).toBe(true)
  })

  it.each(modes)('[%s] 素の式を取るキーを列挙し漏らしても秘匿値は取りこぼさない', (_label, opts) => {
    // 未知のモジュール引数が素の式だった場合の保険。文章が入るキー（name / msg 等）を
    // 除いた文字列値は、波括弧が無くても識別子として走査する。
    const body = `
- name: unknown module parameter shape
  ansible.builtin.command:
    argv:
      - echo
      - DB_PASSWORD
`
    const result = validateAnsibleTasks(body, {
      ...opts,
      secretVarNames: new Set(['DB_PASSWORD']),
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0].no_log).toBe(true)
  })

  it.each(modes)('[%s] 汚染された名前を実際に参照すれば no_log は付く', (_label, opts) => {
    const body = `
- name: Fetch app config
  ansible.builtin.shell: "curl -H 'X-Token: {{ API_TOKEN }}' https://example.com"
  register: config
- name: Show it
  ansible.builtin.debug:
    var: config
`
    const result = validateAnsibleTasks(body, {
      ...opts,
      secretVarNames: new Set(['API_TOKEN']),
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[1].no_log).toBe(true)
  })

  // JSON エスケープが識別子の直前に来ると、`JSON.stringify` した文字列を字句解析する
  // 実装では先頭文字と癒着して別の名前になり、照合をすり抜けた（`\tNAME` → `tNAME`）。
  // Jinja は `{{ }}` 内側の空白を無視するので実機ではそのまま解決される。
  it.each(modes)('[%s] タブを前置してもロール内部変数の参照は拒否される', (_label, opts) => {
    const body = [
      '- name: t',
      '  ansible.builtin.debug:',
      '    var: "\\tgithub_runner_regtoken_resp"',
    ].join('\n')
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(
      hasReason(result.violations, (v) =>
        v.reason.includes("must not reference a bundled role's internal variable"),
      ),
    ).toBe(true)
  })

  it.each(modes)('[%s] タブを前置しても秘匿変数の参照には no_log が付く', (_label, opts) => {
    const body = [
      '- name: oracle',
      '  ansible.builtin.debug:',
      '    msg: hit',
      "  when: \"\\tDB_PASSWORD is match('^x')\"",
    ].join('\n')
    const result = validateAnsibleTasks(body, {
      ...opts,
      secretVarNames: new Set(['DB_PASSWORD']),
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0].no_log).toBe(true)
  })

  it.each(modes)('[%s] include_role の task レベル vars: は巻き添えにしない', (_label, opts) => {
    // 判定を雑に「vars という語を含む」にすると、正当な include_role が全滅する。
    const body = `
- name: Forward syslog
  ansible.builtin.include_role:
    name: rsyslog_forward
  vars:
    rsyslog_forward_target_host: "10.0.0.1"
`
    expect(validateAnsibleTasks(body, opts).ok).toBe(true)
  })
})

})
