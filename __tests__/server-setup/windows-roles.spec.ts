import { existsSync, readFileSync, readdirSync } from 'fs'
import * as path from 'path'

import { dump, load } from 'js-yaml'

import {
  AnsibleTaskRouteMode,
  INCLUDE_ROLE_ALLOWED_ROLES,
  INCLUDE_ROLE_ALLOWED_VARS,
  ROLE_TARGET_OS,
  WINDOWS_MODULE_ALLOWLIST,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * Windows 用 bundled role（win_ssh_key / win_os_init / win_updates）の静的検証。
 *
 * 設計: admin-docs/docs/specifications/server-setup-windows-openssh.md §7
 *
 * ロール内のタスクは同梱の信頼済みコードなので `validateAnsibleTasks`（レシピ本文のガード）の
 * 対象外である。その代わり、ここでロールごとの不変条件を固定する:
 *
 * - win_ssh_key: 公開鍵は**追記のみ**（接続中の鍵を消すとロックアウトする）。ACL は
 *   Administrators / SYSTEM の **SID** だけにする（日本語版でもグループ名に依存しない）。
 *   鍵の形式を検証し、改行の混入や `command="..."` 等のオプション注入を拒否する。
 * - win_os_init: 各項目は既定オフのトグルで個別に有効化する。ファイアウォールを触るときは
 *   いま使っている SSH ポートの許可規則を**必ず先に**入れ、レシピからは許可規則しか足せない。
 *   ローカルユーザーの作成は MVP に入れない。
 * - win_updates: カテゴリと再起動の可否だけを公開する。
 *
 * Windows の実機挙動は jest では検証できない。`ansible-playbook --syntax-check` と
 * EC2 の Windows Server での手動検証（ansible/DEVELOPING.md）に委ねる。
 */

const ROLES_DIR = path.join(__dirname, '..', '..', 'ansible', 'roles')
const WINDOWS_ROLES = ['win_ssh_key', 'win_os_init', 'win_updates'] as const
type WindowsRole = (typeof WINDOWS_ROLES)[number]
const MODES: AnsibleTaskRouteMode[] = ['ecs', 'resident']

/**
 * レシピ本文からは使えないが、ロールの内部でだけ使うモジュール。
 * `ansible.windows.win_updates` はガードがレシピからの直接使用を拒否する（実行時間の上限の
 * 判定をロール名 `win_updates` に限るため。設計書 §5.5）。
 */
const ROLE_INTERNAL_ONLY_MODULES: Readonly<Record<WindowsRole, readonly string[]>> = {
  win_ssh_key: [],
  win_os_init: [],
  win_updates: ['ansible.windows.win_updates'],
}

/** タスクのキーのうちモジュールではないもの（Ansible のタスクキーワード）。 */
const TASK_KEYWORDS = new Set([
  'name', 'when', 'register', 'loop', 'loop_control', 'block', 'rescue', 'always', 'vars',
  'no_log', 'changed_when', 'failed_when', 'ignore_errors', 'tags', 'notify', 'until',
  'retries', 'delay', 'check_mode', 'diff', 'any_errors_fatal', 'throttle', 'timeout',
])

type Task = Record<string, unknown>

function readRaw(role: WindowsRole, ...segments: string[]): string {
  return readFileSync(path.join(ROLES_DIR, role, ...segments), 'utf8')
}

function loadYaml(role: WindowsRole, ...segments: string[]): unknown {
  return load(readRaw(role, ...segments))
}

/** block / rescue / always を含めて平坦化する（親の block タスク自体も含む）。 */
function flatten(tasks: unknown): Task[] {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as Task
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

const parsedTasks = new Map<WindowsRole, Task[]>()

/** 1回だけパースして同じオブジェクトを返す（タスクの前後関係を indexOf で比べるため）。 */
function tasksOf(role: WindowsRole): Task[] {
  let tasks = parsedTasks.get(role)
  if (!tasks) {
    tasks = flatten(loadYaml(role, 'tasks', 'main.yml'))
    parsedTasks.set(role, tasks)
  }
  return tasks
}

/** block を持たない（＝モジュールを呼ぶ）タスク。 */
function moduleTasksOf(role: WindowsRole): Task[] {
  return tasksOf(role).filter((t) => !('block' in t))
}

function moduleOf(task: Task): string {
  const keys = Object.keys(task).filter((k) => !TASK_KEYWORDS.has(k))
  expect(keys).toHaveLength(1)
  return keys[0]
}

function tasksUsing(role: WindowsRole, moduleName: string): Task[] {
  return moduleTasksOf(role).filter((t) => moduleOf(t) === moduleName)
}

function argsOf(task: Task): Record<string, unknown> {
  return (task[moduleOf(task)] ?? {}) as Record<string, unknown>
}

function whenOf(task: Task): string {
  const when = task.when
  if (when === undefined) return ''
  return Array.isArray(when) ? when.join(' and ') : String(when)
}

function defaultsOf(role: WindowsRole): Record<string, unknown> {
  return (loadYaml(role, 'defaults', 'main.yml') ?? {}) as Record<string, unknown>
}

describe('Windows bundled role の共通の不変条件', () => {
  it.each(WINDOWS_ROLES)('%s: tasks/main.yml と defaults/main.yml がある', (role) => {
    expect(existsSync(path.join(ROLES_DIR, role, 'tasks', 'main.yml'))).toBe(true)
    expect(existsSync(path.join(ROLES_DIR, role, 'defaults', 'main.yml'))).toBe(true)
    expect(moduleTasksOf(role).length).toBeGreaterThan(0)
  })

  it.each(WINDOWS_ROLES)('%s: ロールと OS の対応表で windows になっている', (role) => {
    expect(ROLE_TARGET_OS[role]).toBe('windows')
    expect(INCLUDE_ROLE_ALLOWED_ROLES.has(role)).toBe(true)
  })

  it('対応表で windows のロールはこの3つだけ（Linux ロールの取り違えを防ぐ）', () => {
    const windowsRoles = Object.entries(ROLE_TARGET_OS)
      .filter(([, os]) => os === 'windows')
      .map(([role]) => role)
      .sort()
    expect(windowsRoles).toEqual([...WINDOWS_ROLES].sort())
  })

  it.each(WINDOWS_ROLES)('%s: タスク名はすべて "<role> : ..." の形', (role) => {
    for (const task of tasksOf(role)) {
      expect(String(task.name)).toMatch(new RegExp(`^${role} : \\S`))
    }
  })

  it.each(WINDOWS_ROLES)(
    '%s: 使うモジュールはすべて FQCN で、Windows の許可一覧かロール内専用のもの',
    (role) => {
      const used = moduleTasksOf(role).map(moduleOf)
      expect(used.length).toBeGreaterThan(0)
      for (const moduleName of used) {
        expect(moduleName).toMatch(/^(ansible\.windows|community\.windows|ansible\.builtin)\.[a-z0-9_]+$/)
        const allowed =
          WINDOWS_MODULE_ALLOWLIST.has(moduleName) ||
          ROLE_INTERNAL_ONLY_MODULES[role].includes(moduleName)
        expect({ role, moduleName, allowed }).toEqual({ role, moduleName, allowed: true })
      }
    },
  )

  it('ロール内専用のモジュールは、実際にそのロールで使われている（一覧が腐らない）', () => {
    for (const role of WINDOWS_ROLES) {
      const used = new Set(moduleTasksOf(role).map(moduleOf))
      for (const moduleName of ROLE_INTERNAL_ONLY_MODULES[role]) {
        expect(used.has(moduleName)).toBe(true)
        // ロール内専用＝レシピからは使えない。許可一覧に入っていたら設計と食い違う。
        expect(WINDOWS_MODULE_ALLOWLIST.has(moduleName)).toBe(false)
      }
    }
  })

  it.each(WINDOWS_ROLES)('%s: become 系のキーを使わない（鍵ログインで昇格済み。設計書 §5.4）', (role) => {
    for (const task of tasksOf(role)) {
      for (const key of Object.keys(task)) {
        expect(key.startsWith('become')).toBe(false)
      }
    }
  })

  it.each(WINDOWS_ROLES)('%s: 秘匿値を扱わないので no_log を付けない（失敗理由を隠さない）', (role) => {
    for (const task of tasksOf(role)) {
      expect(task.no_log).toBeUndefined()
    }
  })

  it.each(WINDOWS_ROLES)('%s: defaults のキーはすべてロール名の接頭辞を持つ', (role) => {
    const keys = Object.keys(defaultsOf(role))
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key.startsWith(`${role}_`)).toBe(true)
  })
})

describe('win_ssh_key', () => {
  const role = 'win_ssh_key' as const
  const KEYS_FILE = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'

  /** assert の that 式から鍵の形式チェックの正規表現（Python の fullmatch）を取り出す。 */
  function keyPattern(): RegExp {
    const asserts = tasksUsing(role, 'ansible.builtin.assert')
    const that = asserts.flatMap((t) => (argsOf(t).that as string[]) ?? [])
    const matches = that
      .map((expr) => /(?:regex\(|'regex',\s*)'([^']+)',\s*match_type='fullmatch'\)/.exec(expr))
      .filter((m): m is RegExpExecArray => m !== null)
    expect(matches).toHaveLength(1)
    // fullmatch と同じ意味にするため両端を固定する（JS の `$` は m フラグ無しなら末尾のみ）。
    return new RegExp(`^(?:${matches[0][1]})$`)
  }

  it('公開変数は追加する鍵のリスト（既定は空＝必ず呼び出し側が渡す）', () => {
    expect(defaultsOf(role)).toEqual({ win_ssh_key_public_keys: [] })
  })

  it('鍵は administrators_authorized_keys に追記する（行の追加だけで、置換・削除をしない）', () => {
    const appends = tasksUsing(role, 'community.windows.win_lineinfile')
    expect(appends).toHaveLength(1)
    const args = argsOf(appends[0])
    expect(args.path).toBe(KEYS_FILE)
    expect(args.state).toBe('present')
    expect(args.create).toBe(true)
    // regex / backrefs / insertbefore があると既存行の置換・並べ替えになる。
    for (const key of ['regex', 'regexp', 'backrefs', 'insertbefore', 'validate']) {
      expect(args).not.toHaveProperty(key)
    }
    expect(appends[0].loop).toBe('{{ win_ssh_key_public_keys }}')
  })

  it('鍵ファイルを削除・置換するタスクを持たない', () => {
    for (const task of moduleTasksOf(role)) {
      const moduleName = moduleOf(task)
      const args = argsOf(task)
      expect(args.state).not.toBe('absent')
      // win_copy / win_file / win_template で鍵ファイルを書き換えるとロックアウトし得る。
      expect([
        'ansible.windows.win_copy',
        'ansible.windows.win_file',
        'ansible.windows.win_template',
      ]).not.toContain(moduleName)
    }
  })

  it('ACL は継承を切り、Administrators（S-1-5-32-544）と SYSTEM（S-1-5-18）の SID だけにする', () => {
    // 追記の前と always の2箇所で、同じ ACL 再構築を行う。
    const acl = tasksUsing(role, 'ansible.windows.win_powershell')
    expect(acl).toHaveLength(2)
    for (const task of acl) {
      const args = argsOf(task)
      expect(args.parameters).toEqual({ Path: KEYS_FILE })
      const script = String(args.script)
      expect(script).toContain("'S-1-5-32-544'")
      expect(script).toContain("'S-1-5-18'")
      expect(script).toContain('SetAccessRuleProtection($true, $false)')
      expect(script).toContain('SecurityIdentifier')
      // グループ名（日本語版では表記が変わる）で指定しない。
      expect(script).not.toMatch(/BUILTIN\\|NT AUTHORITY|'Administrators'|"Administrators"/)
      // 冪等: 既に望む ACL なら変更なしと報告する。
      expect(script).toContain('$Ansible.Changed = $false')
    }
  })

  // 実機（Windows Server 2022 日本語版）: ACL が SYSTEM だけのファイル（sshd は SYSTEM で読むので
  // 鍵ログインはできる）では、管理者自身がファイルを読めず追記が失敗した。追記の前にも同じ ACL
  // 再構築を行い、1回の実行で成功させる。
  describe('追記の前の ACL 再構築', () => {
    const top = () => loadYaml(role, 'tasks', 'main.yml') as Task[]
    const block = () => top().find((t) => 'block' in t) as Task
    const acl = () => tasksUsing(role, 'ansible.windows.win_powershell')

    it('順序は「追記前の ACL 再構築 → 追記 → always の ACL 再構築」', () => {
      const inner = flatten(block().block)
      const always = flatten(block().always)
      expect(inner.map(moduleOf)).toEqual(['ansible.windows.win_powershell', 'community.windows.win_lineinfile'])
      expect(always.map(moduleOf)).toEqual(['ansible.windows.win_powershell'])
      const order = moduleTasksOf(role)
      const append = tasksUsing(role, 'community.windows.win_lineinfile')[0]
      expect(order.indexOf(acl()[0])).toBeLessThan(order.indexOf(append))
      expect(order.indexOf(append)).toBeLessThan(order.indexOf(acl()[1]))
    })

    it('追記前と always のスクリプトは同一の固定文字列（Jinja もレシピ変数も含まない）', () => {
      const [before, after] = acl().map((t) => String(argsOf(t).script))
      expect(before).toBe(after)
      for (const marker of ['{{', '{%', '{#']) expect(before).not.toContain(marker)
      // パスは parameters の固定値で渡す。
      for (const task of acl()) expect(argsOf(task).parameters).toEqual({ Path: KEYS_FILE })
    })

    it('ファイルが無いときは何もしない（作成は追記の create: true に任せる）', () => {
      const script = String(argsOf(acl()[0]).script)
      expect(script).toMatch(/\$item = Get-Item -LiteralPath \$Path -Force -ErrorAction SilentlyContinue/)
      expect(script).toMatch(/if \(\$null -eq \$item\) \{[^}]*\$Ansible\.Changed = \$false\s*return\s*\}/)
      // 失敗を握り潰さない。
      for (const task of acl()) {
        expect(task).not.toHaveProperty('ignore_errors')
        expect(task).not.toHaveProperty('failed_when')
      }
    })

    it('新しい register を持たない（ガードの内部変数の一覧を増やさない）', () => {
      const registers = moduleTasksOf(role).map((t) => t.register).filter((r) => r !== undefined)
      expect(registers).toEqual(['win_ssh_key_dir_stat'])
    })
  })

  it('ACL の是正は追記の always で必ず走る（追記の途中で失敗しても ACL を広いまま残さない）', () => {
    const top = loadYaml(role, 'tasks', 'main.yml') as Task[]
    const block = top.find((t) => 'block' in t)
    expect(block).toBeDefined()
    const inner = flatten(block?.block)
    const always = flatten(block?.always)
    expect(inner.map(moduleOf)).toContain('community.windows.win_lineinfile')
    expect(always.map(moduleOf)).toEqual(['ansible.windows.win_powershell'])
  })

  it('鍵の検証は書き込みより前に行う', () => {
    const order = moduleTasksOf(role).map(moduleOf)
    expect(order.indexOf('ansible.builtin.assert')).toBe(0)
    expect(order.indexOf('ansible.builtin.assert')).toBeLessThan(
      order.indexOf('community.windows.win_lineinfile'),
    )
  })

  it('鍵の検証は空・文字列以外・リスト以外を拒否する', () => {
    const that = tasksUsing(role, 'ansible.builtin.assert').flatMap(
      (t) => (argsOf(t).that as string[]) ?? [],
    )
    const joined = that.join('\n')
    expect(joined).toContain('win_ssh_key_public_keys is sequence')
    expect(joined).toContain('win_ssh_key_public_keys is not string')
    expect(joined).toContain('win_ssh_key_public_keys is not mapping')
    expect(joined).toContain("select('string')")
    expect(joined).toMatch(/length\s*>\s*0/)
  })

  describe('鍵の形式（assert の正規表現を実際に評価する）', () => {
    const ed25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICBZs7Dy8xisLP89ECdjYP3Z3wuMqamU0VSmNr9lo24E'

    it.each([
      ed25519,
      `${ed25519} windows-ssh-poc`,
      `${ed25519} user@host (laptop) 2026-10`,
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 rsa-key',
      'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= ecdsa',
      'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ=',
      'ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE=',
      'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t yubikey',
      'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20= yubikey',
    ])('受け付ける: %s', (key) => {
      expect(keyPattern().test(key)).toBe(true)
    })

    it.each([
      ['空文字', ''],
      ['種別だけ', 'ssh-ed25519'],
      ['オプション注入（command=）', `command="powershell -c evil" ${ed25519}`],
      ['オプション注入（from=）', `from="*" ${ed25519}`],
      ['先頭の空白', ` ${ed25519}`],
      ['末尾の改行', `${ed25519}\n`],
      ['途中の改行で2行目を注入', `${ed25519} a\ncommand="x" ${ed25519}`],
      ['CR の混入', `${ed25519} a\rb`],
      ['タブの混入', `${ed25519}\tcomment`],
      ['未知の種別', 'ssh-dss AAAAB3NzaC1kc3MAAACBAP'],
      ['base64 でない本体', 'ssh-ed25519 not-base64!'],
      ['秘密鍵', '-----BEGIN OPENSSH PRIVATE KEY-----'],
      ['非 ASCII のコメント', `${ed25519} 日本語`],
    ])('拒否する: %s', (_label, key) => {
      expect(keyPattern().test(key)).toBe(false)
    })
  })

  it('assert の失敗メッセージに値を展開しない（設定方法だけを案内する）', () => {
    for (const task of tasksUsing(role, 'ansible.builtin.assert')) {
      expect(String(argsOf(task).fail_msg)).not.toContain('{{')
      expect(String(argsOf(task).fail_msg).length).toBeGreaterThan(0)
    }
  })
})

describe('win_os_init', () => {
  const role = 'win_os_init' as const
  const SSH_RULE_NAME_LITERAL = 'ai-support-agent OpenSSH Server (sshd)'

  it('各項目のトグルは既定でオフ（レシピが明示した項目だけを変更する）', () => {
    const defaults = defaultsOf(role)
    expect(defaults.win_os_init_timezone_enabled).toBe(false)
    expect(defaults.win_os_init_hostname_enabled).toBe(false)
    expect(defaults.win_os_init_firewall_enabled).toBe(false)
    expect(defaults.win_os_init_firewall_rules).toEqual([])
    expect(defaults.win_os_init_hostname).toBe('')
  })

  it('ローカルユーザーを作らない（MVP 外。設計書 §7）', () => {
    const used = moduleTasksOf(role).map(moduleOf)
    expect(used).not.toContain('ansible.windows.win_user')
    expect(used).not.toContain('ansible.windows.win_group_membership')
    expect(Object.keys(defaultsOf(role)).some((k) => /user|password/.test(k))).toBe(false)
  })

  it('対象ホストを変更するタスクはすべて対応するトグルで守られている', () => {
    const toggles: Record<string, string> = {
      'ansible.windows.win_timezone': 'win_os_init_timezone_enabled',
      'ansible.windows.win_hostname': 'win_os_init_hostname_enabled',
      'ansible.windows.win_reboot': 'win_os_init_hostname_enabled',
      'community.windows.win_firewall_rule': 'win_os_init_firewall_enabled',
      'ansible.windows.win_firewall': 'win_os_init_firewall_enabled',
      // 読み取りだけ（sshd の待受ポートの取得）。ファイアウォールを触るときだけ走らせる。
      'ansible.windows.win_powershell': 'win_os_init_firewall_enabled',
    }
    const changing = moduleTasksOf(role).filter((t) => moduleOf(t) in toggles)
    expect(changing.length).toBeGreaterThanOrEqual(Object.keys(toggles).length)
    for (const task of changing) {
      expect(whenOf(task)).toContain(toggles[moduleOf(task)])
    }
    // それ以外のモジュールは検証（assert）だけ。
    for (const task of moduleTasksOf(role)) {
      expect([...Object.keys(toggles), 'ansible.builtin.assert']).toContain(moduleOf(task))
    }
  })

  it('タイムゾーンは ansible.windows.win_timezone（community.windows の旧名は非推奨の転送名）', () => {
    const tasks = tasksUsing(role, 'ansible.windows.win_timezone')
    expect(tasks).toHaveLength(1)
    expect(argsOf(tasks[0])).toEqual({ timezone: '{{ win_os_init_timezone }}' })
  })

  describe('ファイアウォール', () => {
    const rules = () => tasksUsing(role, 'community.windows.win_firewall_rule')
    const sshRule = () => rules().find((t) => !('loop' in t))
    const userRule = () => rules().find((t) => 'loop' in t)

    it('いま接続に使っている SSH ポートの受信許可規則を入れる', () => {
      const task = sshRule()
      expect(task).toBeDefined()
      const args = argsOf(task as Task)
      expect(args).toEqual(
        expect.objectContaining({
          name: SSH_RULE_NAME_LITERAL,
          direction: 'in',
          action: 'allow',
          protocol: 'tcp',
          enabled: true,
          state: 'present',
        }),
      )
      // 公開変数ではなく接続そのもののポート（インベントリの ansible_port）を使う。
      // レシピがポートを取り違えて自分の接続を断つことを防ぐ。
      expect(String(args.localport)).toContain('ansible_port')
      expect(args).not.toHaveProperty('remoteip')
      expect(whenOf(task as Task)).toBe('win_os_init_firewall_enabled | bool')
    })

    // NAT・ポート転送の先では、agent の接続ポート（ansible_port）とホスト上で sshd が待ち受ける
    // ポートが違う。既定の OpenSSH-Server-In-TCP 規則が無い・無効なホストでは、ansible_port
    // だけを開けると直後の inbound=block で切断され得るので、両方を開ける。
    describe('sshd の待受ポート', () => {
      const SSHD_PORTS_VAR = 'win_os_init_sshd_listen_ports'
      const probe = () => tasksUsing(role, 'ansible.windows.win_powershell')
      const portAssert = () =>
        tasksUsing(role, 'ansible.builtin.assert').find((t) =>
          ((argsOf(t).that as string[] | undefined) ?? []).some((line) => line.includes(SSHD_PORTS_VAR)),
        )

      it('ホスト上で sshd が待ち受けている TCP ポートを読み取りだけで取得する', () => {
        expect(probe()).toHaveLength(1)
        const task = probe()[0]
        expect(task.register).toBe(SSHD_PORTS_VAR)
        expect(task.changed_when).toBe(false)
        expect(whenOf(task)).toBe('win_os_init_firewall_enabled | bool')
        const args = argsOf(task)
        expect(Object.keys(args)).toEqual(['script'])
        const script = String(args.script)
        expect(script).toContain("$ErrorActionPreference = 'Stop'")
        // OpenSSH 9.8 未満では接続ごとの子プロセスも sshd.exe なので、プロセス名で拾うと運用者の
        // リモートフォワード（ssh -R）の待受ポートまで入る。sshd サービス本体の PID に限る。
        expect(script).toContain(`(Get-CimInstance -ClassName Win32_Service -Filter "Name='sshd'").ProcessId`)
        expect(script).not.toMatch(/Get-Process/)
        expect(script).toMatch(/\$servicePid -eq \$null -or \$servicePid -eq 0/)
        expect(script).toContain('$_.OwningProcess -eq $servicePid')
        expect(script).toContain('Get-NetTCPConnection -State Listen')
        expect(script).toContain('OwningProcess')
        // IPv4 / IPv6・複数プロセスで同じポートが重複しても1つにまとめる。
        expect(script).toContain('Sort-Object -Unique')
        expect(script).toContain('$Ansible.Changed = $false')
        // 何も取れなければ例外（fail-closed）。
        expect(script).toMatch(/throw/)
      })

      it('スクリプトにレシピ変数（Jinja）を埋め込まない', () => {
        const script = String(argsOf(probe()[0]).script)
        for (const marker of ['{{', '{%', '{#']) expect(script).not.toContain(marker)
      })

      it('取得したポートの形（数字のカンマ区切り）を検証してから規則・有効化に進む（fail-closed）', () => {
        const task = portAssert()
        expect(task).toBeDefined()
        const that = (argsOf(task as Task).that as string[]).join('\n')
        expect(that).toContain(`${SSHD_PORTS_VAR}.result is string`)
        // Python の `$` は末尾の改行の前にも一致するので、`^...$` ではなく fullmatch で判定する。
        const m = new RegExp(`${SSHD_PORTS_VAR}\\.result is regex\\('([^']+)', match_type='fullmatch'\\)`).exec(that)
        expect(m).not.toBeNull()
        const re = new RegExp(`^(?:${(m as RegExpExecArray)[1]})$`)
        for (const ok of ['22', '22,2222', '65535']) expect(re.test(ok)).toBe(true)
        for (const ng of ['', ',', '22,', 'a', '22 ,2222', '22\n']) expect(re.test(ng)).toBe(false)
        expect(whenOf(task as Task)).toBe('win_os_init_firewall_enabled | bool')

        const order = moduleTasksOf(role)
        const enable = tasksUsing(role, 'ansible.windows.win_firewall')[0]
        expect(order.indexOf(probe()[0])).toBeLessThan(order.indexOf(task as Task))
        expect(order.indexOf(task as Task)).toBeLessThan(order.indexOf(sshRule() as Task))
        expect(order.indexOf(task as Task)).toBeLessThan(order.indexOf(enable))
        // 取得・検証の失敗を握り潰さない。
        for (const t of [probe()[0], task as Task]) {
          expect(t).not.toHaveProperty('ignore_errors')
          expect(t).not.toHaveProperty('failed_when')
        }
      })

      it('SSH の許可規則のポートは sshd の待受ポートと ansible_port の両方から作る', () => {
        expect(argsOf(sshRule() as Task).localport).toBe(
          // 重複を除いて数値の昇順に並べる（Windows が LocalPorts を正規化して返しても毎回 changed にしない）。
          `{{ ([ansible_port | default(22)] + ${SSHD_PORTS_VAR}.result.split(',')) | map('int') | unique | sort | map('string') | join(',') }}`,
        )
      })
    })

    it('SSH の許可規則は、利用者の規則・ファイアウォールの有効化より前に入れる', () => {
      const order = moduleTasksOf(role)
      const sshIndex = order.indexOf(sshRule() as Task)
      const userIndex = order.indexOf(userRule() as Task)
      const enable = tasksUsing(role, 'ansible.windows.win_firewall')
      expect(enable).toHaveLength(1)
      expect(sshIndex).toBeGreaterThanOrEqual(0)
      expect(sshIndex).toBeLessThan(userIndex)
      expect(sshIndex).toBeLessThan(order.indexOf(enable[0]))
    })

    it('利用者の規則は許可（allow）だけ。action を項目から読まない（SSH をブロックさせない）', () => {
      const task = userRule()
      expect(task).toBeDefined()
      const args = argsOf(task as Task)
      expect(args.action).toBe('allow')
      expect(args.state).toBe('present')
      expect(task?.loop).toBe('{{ win_os_init_firewall_rules }}')
      // 項目から渡すのは許可規則の属性だけ。
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && value.includes('item')) {
          expect(['name', 'description', 'direction', 'protocol', 'localport', 'remoteport', 'localip', 'remoteip']).toContain(key)
        }
      }
    })

    it('規則・ファイアウォールを無効化・削除するタスクを持たない', () => {
      for (const task of rules()) {
        expect(argsOf(task).state).toBe('present')
        expect(argsOf(task).enabled).toBe(true)
      }
      for (const task of tasksUsing(role, 'ansible.windows.win_firewall')) {
        expect(argsOf(task).state).toBe('enabled')
        expect(argsOf(task).inbound_action).toBe('block')
        expect(argsOf(task).outbound_action).toBe('allow')
      }
    })

    it('利用者の規則の検証: 許可するキー・SSH 規則と同名の拒否・action の拒否', () => {
      const asserts = tasksUsing(role, 'ansible.builtin.assert')
      const ruleAssert = asserts.find((t) => t.loop === '{{ win_os_init_firewall_rules }}')
      expect(ruleAssert).toBeDefined()
      const that = (argsOf(ruleAssert as Task).that as string[]).join('\n')
      expect(that).toContain('item is mapping')
      expect(that).toContain(`'${SSH_RULE_NAME_LITERAL}'`)
      expect(that).toContain('difference(')
      // 許可するキーの一覧に action / state / enabled / program / service は入れない。
      const allowedKeys = /item\.keys\(\) \| list \| difference\((\[[^\]]*\])\)/.exec(that)
      expect(allowedKeys).not.toBeNull()
      const keys = JSON.parse((allowedKeys as RegExpExecArray)[1].replace(/'/g, '"')) as string[]
      expect(keys.sort()).toEqual(
        ['description', 'direction', 'localip', 'localport', 'name', 'protocol', 'remoteip', 'remoteport'],
      )
    })

    // community.windows.win_firewall_rule は既存規則を `$_.Name -eq $name`（PowerShell の
    // -eq は大文字小文字を区別しない）で探して更新する。予約名の比較が大文字小文字を区別すると
    // "AI-Support-Agent OpenSSH Server (SSHD)" が通り、SSH の許可規則の localport が書き換わった
    // 直後のファイアウォール有効化（inbound block）で SSH が塞がれる。
    describe('SSH 規則の予約名は前後の空白と大文字小文字を無視して拒否する（assert の式を評価する）', () => {
      const RESERVED_NAME_EXPRESSIONS = [
        `(item.name | trim | lower) != ('${SSH_RULE_NAME_LITERAL}' | lower)`,
        `(item.name | trim | upper) != ('${SSH_RULE_NAME_LITERAL}' | upper)`,
      ]

      function reservedNameLines(): string[] {
        const ruleAssert = tasksUsing(role, 'ansible.builtin.assert')
          .find((t) => t.loop === '{{ win_os_init_firewall_rules }}') as Task
        return (argsOf(ruleAssert).that as string[]).filter((line) => line.includes(SSH_RULE_NAME_LITERAL))
      }

      /**
       * 予約名の式を Jinja と同じ意味で評価する（`trim` = str.strip、`lower` / `upper` =
       * str.lower / str.upper）。式の形が上の定型から外れたら例外にする（評価の空振りを防ぐ）。
       */
      function evaluate(line: string, name: string): boolean {
        const m = /^\(item\.name \| trim \| (lower|upper)\) != \('([^']+)' \| \1\)$/.exec(line)
        if (!m) throw new Error(`unexpected reserved-name expression: ${line}`)
        const fold = (s: string): string => (m[1] === 'lower' ? s.toLowerCase() : s.toUpperCase())
        return fold(name.trim()) !== fold(m[2])
      }

      const passes = (name: string): boolean => reservedNameLines().every((line) => evaluate(line, name))

      it('予約名の判定は大文字小文字を区別しない比較だけで、区別する素の比較を残さない', () => {
        expect(reservedNameLines()).toEqual(RESERVED_NAME_EXPRESSIONS)
      })

      it.each([
        ['そのまま', SSH_RULE_NAME_LITERAL],
        ['大文字小文字違い', 'AI-Support-Agent OpenSSH Server (SSHD)'],
        ['すべて大文字', SSH_RULE_NAME_LITERAL.toUpperCase()],
        ['すべて小文字', SSH_RULE_NAME_LITERAL.toLowerCase()],
        ['前後の空白', `  ${SSH_RULE_NAME_LITERAL} `],
        ['前後の空白＋大文字小文字違い', `\t${SSH_RULE_NAME_LITERAL.toUpperCase()}\n`],
        // 長い s（U+017F）は upper で S になる。lower だけの比較では一致しない。
        ['長い s（ſ）', SSH_RULE_NAME_LITERAL.replace('sshd', 'ſshd')],
      ])('拒否する: %s', (_label, name) => {
        expect(passes(name)).toBe(false)
      })

      // ファイアウォールを有効化すると受信の既定がブロックになり、SSH 以外（RDP 3389 等）は
      // 組み込みの許可規則が無ければ塞がれる。説明に書いた「RDP を使い続けるなら足す規則」の例が、
      // defaults と tasks の両方に同じ形で書かれていて、実際に検証の assert を通ることを確かめる。
      it('説明に書いた RDP の許可規則の例は、許可キーと予約名の検査を通る', () => {
        const example = '{name: rdp, localport: "3389"}'
        expect(readRaw(role, 'defaults', 'main.yml')).toContain(example)
        expect(readRaw(role, 'tasks', 'main.yml')).toContain(example)

        const rule = load(example) as Record<string, unknown>
        expect(rule).toEqual({ name: 'rdp', localport: '3389' })
        const ruleAssert = tasksUsing(role, 'ansible.builtin.assert')
          .find((t) => t.loop === '{{ win_os_init_firewall_rules }}') as Task
        const that = (argsOf(ruleAssert).that as string[]).join('\n')
        const allowedKeys = JSON.parse(
          (/item\.keys\(\) \| list \| difference\((\[[^\]]*\])\)/.exec(that) as RegExpExecArray)[1].replace(/'/g, '"'),
        ) as string[]
        expect(Object.keys(rule).filter((k) => !allowedKeys.includes(k))).toEqual([])
        expect(typeof rule.name === 'string' && rule.name.trim().length > 0).toBe(true)
        expect(passes(rule.name as string)).toBe(true)
        // direction / protocol は省略時の既定（in / tcp）で検査を通る。
        expect(that).toContain("item.direction | default('in') in ['in', 'out']")
        expect(that).toContain("item.protocol | default('tcp') in ['tcp', 'udp']")
      })

      it.each([
        'Allow HTTPS',
        'ai-support-agent OpenSSH Server',
        `${SSH_RULE_NAME_LITERAL} 2`,
        'ai-support-agent OpenSSH Server (sshd2)',
      ])('通す: %s', (name) => {
        expect(passes(name)).toBe(true)
      })
    })

    // ポート無しの規則は tcp / udp でも受信をすべて許可し、inbound=block を無意味にする。
    // protocol: any は Windows ではポートを持てない（ポートは TCP / UDP の規則だけ）ので選択肢から外す。
    describe('protocol は tcp / udp だけ、localport は必須（assert の式を評価する）', () => {
      const PROTOCOL_EXPRESSION = "item.protocol | default('tcp') in ['tcp', 'udp']"
      const LOCALPORT_DEFINED = 'item.localport is defined and item.localport is not none'
      const LOCALPORT_RE = /\(item\.localport \| string\) is regex\('([^']+)', match_type='fullmatch'\)/

      function ruleThat(): string[] {
        const ruleAssert = tasksUsing(role, 'ansible.builtin.assert')
          .find((t) => t.loop === '{{ win_os_init_firewall_rules }}') as Task
        return argsOf(ruleAssert).that as string[]
      }

      /** 規則の assert のうち protocol / localport の部分を Jinja と同じ意味で評価する。 */
      function rulePasses(rule: Record<string, unknown>): boolean {
        const m = LOCALPORT_RE.exec(ruleThat().join('\n')) as RegExpExecArray
        const fullmatch = new RegExp(`^(?:${m[1]})$`)
        const protocol = 'protocol' in rule ? rule.protocol : 'tcp'
        if (protocol !== 'tcp' && protocol !== 'udp') return false
        if (rule.localport === undefined || rule.localport === null) return false
        // Jinja の `| string` は数値をそのまま文字列にする（真偽値は True / False）。
        const text = typeof rule.localport === 'boolean' ? (rule.localport ? 'True' : 'False') : String(rule.localport)
        if (!fullmatch.test(text)) return false
        // 数値の検査（PORT_RANGE_EXPRESSIONS と同じ意味）: 各要素は 1〜65535、範囲 a-b は a <= b。
        const pairs = text.split(',').map((part) => (part.includes('-') ? part : `${part}-${part}`).split('-').map(Number))
        const flat = pairs.flat()
        return Math.min(...flat) >= 1 && Math.max(...flat) <= 65535 && pairs.every(([a, b]) => a <= b)
      }

      // fullmatch で形式（数字・範囲・カンマ）を確かめた後に評価される（assert は最初の偽で止まる）。
      // 範囲でない要素は a-a に揃え、[a, b] の組にしてから検査する。
      const PORT_PAIRS =
        "((item.localport | string).split(',') | map('regex_replace', '^([0-9]+)$', '\\\\1-\\\\1') | map('split', '-') | map('map', 'int') | map('list') | list)"
      const PORT_RANGE_EXPRESSIONS = [
        `(${PORT_PAIRS} | flatten | min) >= 1`,
        `(${PORT_PAIRS} | flatten | max) <= 65535`,
        `(${PORT_PAIRS} | map('sort') | list) == ${PORT_PAIRS}`,
      ]

      it('localport の数値の検査（1〜65535・範囲は a <= b）は形式の fullmatch より後にある', () => {
        const that = ruleThat()
        const formatIndex = that.findIndex((line) => LOCALPORT_RE.test(line))
        expect(formatIndex).toBeGreaterThanOrEqual(0)
        for (const expression of PORT_RANGE_EXPRESSIONS) {
          expect(that.indexOf(expression)).toBeGreaterThan(formatIndex)
        }
      })

      it('規則の検証に式が含まれ、any 用の個別の式は残っていない', () => {
        const that = ruleThat()
        expect(that).toContain(PROTOCOL_EXPRESSION)
        expect(that.join('\n')).toContain(LOCALPORT_DEFINED)
        expect(LOCALPORT_RE.exec(that.join('\n'))).not.toBeNull()
        expect(that.join('\n')).not.toContain("'any'")
      })

      it.each([
        ['protocol: any・localport なし', { name: 'all', protocol: 'any' }],
        ['protocol: any・localport あり', { name: 'web', protocol: 'any', localport: '80' }],
        ['localport なし（tcp 既定）', { name: 'tcpall' }],
        ['localport なし（udp）', { name: 'udpall', protocol: 'udp' }],
        ['localport が空文字', { name: 'x', localport: '' }],
        ['localport が空白', { name: 'x', localport: '  ' }],
        ['localport が null', { name: 'x', localport: null }],
        ['remoteip だけ指定', { name: 'x', remoteip: '10.0.0.0/8' }],
        ['区切りがセミコロン', { name: 'x', localport: '80;rm' }],
        ['前後の空白', { name: 'x', localport: ' 3389' }],
        ['末尾のカンマ', { name: 'x', localport: '80,' }],
        ['開いた範囲', { name: 'x', localport: '8000-' }],
        ['キーワード', { name: 'x', localport: 'RPC' }],
        ['真偽値', { name: 'x', localport: true }],
        ['大文字の TCP', { name: 'x', protocol: 'TCP', localport: '80' }],
        ['0 番', { name: 'x', localport: '0' }],
        ['65535 超', { name: 'x', localport: '70000' }],
        ['逆順の範囲', { name: 'x', localport: '9000-8000' }],
        ['範囲の上限が 65535 超', { name: 'x', localport: '1-65536' }],
        ['リストの一部が 0', { name: 'x', localport: '80,0' }],
      ])('拒否する: %s', (_label, rule) => {
        expect(rulePasses(rule)).toBe(false)
      })

      it.each([
        ['tcp の既定', { name: 'rdp', localport: '3389' }],
        ['数値の localport', { name: 'rdp', localport: 3389 }],
        ['udp', { name: 'dns', protocol: 'udp', localport: '53' }],
        ['範囲とカンマ区切り', { name: 'web', localport: '8000-8010,9000' }],
        ['全範囲', { name: 'x', localport: '1-65535' }],
        ['上限', { name: 'x', localport: '65535' }],
        ['同じ値の範囲', { name: 'x', localport: '8000-8000' }],
      ])('通す: %s', (_label, rule) => {
        expect(rulePasses(rule)).toBe(true)
      })
    })

    // defaults と tasks の説明が食い違わないよう、同じ文言で書かれていることを確かめる。
    it.each([
      'both ansible_port and every TCP port the sshd service listens on (de-duplicated, in ascending numeric order)',
      'ICMP (ping) cannot be re-allowed by this role; configure it manually if needed',
      'protocol is tcp or udp only (any cannot carry ports on Windows) and localport is required: a rule without ports allows all inbound traffic',
    ])('defaults と tasks の説明に同じ文言がある: %s', (phrase) => {
      const normalize = (text: string): string =>
        text.split('\n').map((line) => line.replace(/^\s*#\s?/, '').trim()).join(' ').replace(/\s+/g, ' ')
      expect(normalize(readRaw(role, 'defaults', 'main.yml'))).toContain(phrase)
      expect(normalize(readRaw(role, 'tasks', 'main.yml'))).toContain(phrase)
    })
  })

  describe('ホスト名', () => {
    it('変更したときだけ再起動する', () => {
      const hostname = tasksUsing(role, 'ansible.windows.win_hostname')
      expect(hostname).toHaveLength(1)
      expect(argsOf(hostname[0])).toEqual({ name: '{{ win_os_init_hostname }}' })
      expect(hostname[0].register).toBe('win_os_init_hostname_result')

      const reboot = tasksUsing(role, 'ansible.windows.win_reboot')
      expect(reboot).toHaveLength(1)
      expect(whenOf(reboot[0])).toContain('win_os_init_hostname_result.reboot_required')
      const order = moduleTasksOf(role)
      expect(order.indexOf(hostname[0])).toBeLessThan(order.indexOf(reboot[0]))
    })

    it('ホスト名の再起動はロールの最後（他の項目を適用してから再起動する）', () => {
      const order = moduleTasksOf(role)
      const reboot = tasksUsing(role, 'ansible.windows.win_reboot')[0]
      expect(order.indexOf(reboot)).toBe(order.length - 1)
    })

    it('NetBIOS 名として有効な形（15 文字以内・英数字とハイフン・数字だけは不可）を検証する', () => {
      const that = tasksUsing(role, 'ansible.builtin.assert')
        .flatMap((t) => (argsOf(t).that as string[]) ?? [])
        .join('\n')
      const m = /win_os_init_hostname is regex\('([^']+)', match_type='fullmatch'\)/.exec(that)
      expect(m).not.toBeNull()
      const re = new RegExp(`^(?:${(m as RegExpExecArray)[1]})$`)
      for (const ok of ['WIN-SRV01', 'web1', 'A', 'abcdefghijklmno']) expect(re.test(ok)).toBe(true)
      for (const ng of ['', '-srv', 'srv-', 'abcdefghijklmnop', 'srv_01', 'srv.local', 'srv 01', 'srv\n']) {
        expect(re.test(ng)).toBe(false)
      }
      expect(that).toContain("win_os_init_hostname is not regex('^[0-9]+$')")
    })
  })
})

describe('win_updates', () => {
  const role = 'win_updates' as const

  it('公開変数はカテゴリと再起動の可否（既定は更新の主要カテゴリ・再起動しない）', () => {
    expect(defaultsOf(role)).toEqual({
      win_updates_category_names: ['CriticalUpdates', 'SecurityUpdates', 'UpdateRollups'],
      win_updates_reboot: false,
    })
  })

  it('ansible.windows.win_updates に公開変数だけを渡す', () => {
    const tasks = tasksUsing(role, 'ansible.windows.win_updates')
    expect(tasks).toHaveLength(1)
    expect(argsOf(tasks[0])).toEqual({
      category_names: '{{ win_updates_category_names }}',
      reboot: '{{ win_updates_reboot | bool }}',
      state: 'installed',
    })
    expect(tasks[0].register).toBe('win_updates_result')
  })

  it('入力の検証は更新より前で、カテゴリ（空・文字列以外）と再起動の真偽値を見る', () => {
    const order = moduleTasksOf(role).map(moduleOf)
    expect(order[0]).toBe('ansible.builtin.assert')
    const that = (argsOf(moduleTasksOf(role)[0]).that as string[]).join('\n')
    expect(that).toContain('win_updates_category_names is sequence')
    expect(that).toContain('win_updates_category_names is not string')
    expect(that).toContain("select('string')")
    expect(that).toContain('win_updates_reboot is boolean')
  })

  it('インストールに失敗した更新があれば失敗にする', () => {
    const that = tasksUsing(role, 'ansible.builtin.assert')
      .flatMap((t) => (argsOf(t).that as string[]) ?? [])
      .join('\n')
    expect(that).toContain('win_updates_result.failed_update_count')
  })

  it('カテゴリ名の形式（英字と空白、または *）を検証する', () => {
    const that = (argsOf(moduleTasksOf(role)[0]).that as string[]).join('\n')
    const m = /(?:regex\(|'regex',\s*)'([^']+)',\s*match_type='fullmatch'\)/.exec(that)
    expect(m).not.toBeNull()
    const re = new RegExp(`^(?:${(m as RegExpExecArray)[1]})$`)
    for (const ok of ['CriticalUpdates', 'Security Updates', 'Definition Updates', '*']) expect(re.test(ok)).toBe(true)
    for (const ng of ['', ' ', 'Updates;rm', 'a\nb', '**', "x'"]) expect(re.test(ng)).toBe(false)
  })

  it('ansible.windows.win_updates を使うロールは win_updates だけ（実行時間の上限の判定をロール名に限る）', () => {
    for (const dir of readdirSync(ROLES_DIR)) {
      if (dir === 'win_updates') continue
      const tasksFile = path.join(ROLES_DIR, dir, 'tasks', 'main.yml')
      if (!existsSync(tasksFile)) continue
      expect(readFileSync(tasksFile, 'utf8')).not.toContain('win_updates:')
    }
  })
})

describe('ガード: Windows ロールの include_role', () => {
  const include = (role: string, vars?: Record<string, unknown>) =>
    dump([{ name: 't', 'ansible.builtin.include_role': { name: role }, ...(vars ? { vars } : {}) }])

  const typicalVars: Record<WindowsRole, Record<string, unknown>> = {
    win_ssh_key: { win_ssh_key_public_keys: ['{{ OPS_SSH_PUBLIC_KEY }}'] },
    win_os_init: {
      win_os_init_timezone_enabled: true,
      win_os_init_timezone: 'Tokyo Standard Time',
      win_os_init_hostname_enabled: true,
      win_os_init_hostname: 'WIN-SRV01',
      win_os_init_firewall_enabled: true,
      win_os_init_firewall_rules: [{ name: 'https', direction: 'in', protocol: 'tcp', localport: '443' }],
    },
    win_updates: {
      win_updates_category_names: ['SecurityUpdates'],
      win_updates_reboot: true,
    },
  }

  describe.each(MODES)('mode=%s', (mode) => {
    it.each(WINDOWS_ROLES)('targetOs=windows で %s を公開変数付きで include_role できる', (role) => {
      const result = validateAnsibleTasks(include(role, typicalVars[role]), { mode, targetOs: 'windows' })
      expect(result.violations).toEqual([])
      expect(result.ok).toBe(true)
    })

    it.each(WINDOWS_ROLES)('targetOs=linux では %s を拒否する', (role) => {
      const result = validateAnsibleTasks(include(role), { mode, targetOs: 'linux' })
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'name', reason: expect.stringContaining("'linux'") }),
      )
    })
  })

  it.each([
    ['win_ssh_key', 'win_ssh_key_dir_stat'],
    ['win_os_init', 'win_os_init_hostname_result'],
    ['win_updates', 'win_updates_result'],
  ] as const)('%s の内部変数（%s）はレシピから渡せない', (role, internal) => {
    const result = validateAnsibleTasks(include(role, { [internal]: { faked: true } }), {
      mode: 'ecs',
      targetOs: 'windows',
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((v) => v.key)).toContain(internal)
  })

  it('公開変数の allowlist は defaults のキーと一致する', () => {
    for (const role of WINDOWS_ROLES) {
      expect([...INCLUDE_ROLE_ALLOWED_VARS[role]].sort()).toEqual(Object.keys(defaultsOf(role)).sort())
    }
  })
})
