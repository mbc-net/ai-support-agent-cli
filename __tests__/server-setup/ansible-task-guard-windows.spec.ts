import { readdirSync, readFileSync } from 'fs'
import * as path from 'path'

import { dump } from 'js-yaml'

import {
  AnsibleTaskRouteMode,
  AnsibleTargetOs,
  INCLUDE_ROLE_ALLOWED_ROLES,
  MODULE_ALLOWLIST,
  RESIDENT_EXTRA_MODULE_ALLOWLIST,
  ROLE_TARGET_OS,
  WINDOWS_COLLECTION_VERSIONS,
  WINDOWS_MODULE_ALLOWLIST,
  WINDOWS_MODULE_RULES,
  parseWindowsGuardData,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * ansible-task-guard の OS 次元（`targetOs`）のテスト。
 *
 * 設計: admin-docs/docs/specifications/server-setup-windows-openssh.md §6
 *
 * Windows のモジュールは「モジュールの allowlist」に加えて「モジュールごとの引数の
 * allowlist」で検査する。コントローラ（agent ホスト / 当社 ECS）側のファイルを扱う
 * 引数と資格情報の引数を拒否することが、このガードの守る対象である。
 */

const MODES: AnsibleTaskRouteMode[] = ['ecs', 'resident']
const ROLES_DIR = path.join(__dirname, '..', '..', 'ansible', 'roles')
const GUARD_JSON_PATH = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'server-setup',
  'windows-guard.json',
)

const run = (
  tasks: unknown[],
  targetOs: AnsibleTargetOs,
  mode: AnsibleTaskRouteMode = 'ecs',
  secretVarNames?: ReadonlySet<string>,
) => validateAnsibleTasks(dump(tasks), { mode, targetOs, secretVarNames })

const win = (tasks: unknown[], mode: AnsibleTaskRouteMode = 'ecs') =>
  run(tasks, 'windows', mode)

describe('targetOs の必須化', () => {
  it.each([undefined, '', 'Windows', 'darwin'])(
    'targetOs が linux / windows 以外（%p）なら全体を拒否する（既定値へ倒さない）',
    (targetOs) => {
      const result = validateAnsibleTasks('- ansible.builtin.debug: { msg: hi }\n', {
        mode: 'ecs',
        targetOs: targetOs as unknown as AnsibleTargetOs,
      })
      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        expect.objectContaining({ taskIndex: -1, key: 'targetOs' }),
      ])
    },
  )
})

describe('Windows: 許可モジュール', () => {
  // 各モジュールの典型的な使い方。設計書 §6.2 の表と 1:1。
  const typical: Array<[string, unknown]> = [
    ['ansible.windows.win_command', { cmd: 'whoami /all', chdir: 'C:\\Windows' }],
    ['ansible.windows.win_shell', { cmd: 'Get-Service sshd', no_profile: true }],
    ['ansible.windows.win_powershell', { script: 'Get-Date', parameters: { a: 1 } }],
    ['ansible.windows.win_copy', { content: 'hello', dest: 'C:\\temp\\a.txt', force: true, backup: true }],
    ['ansible.windows.win_file', { path: 'C:\\temp', state: 'directory' }],
    ['ansible.windows.win_stat', { path: 'C:\\temp\\a.txt', get_checksum: false }],
    ['ansible.windows.win_get_url', { url: 'https://example.com/a.msi', dest: 'C:\\temp\\a.msi' }],
    ['ansible.windows.win_acl', { path: 'C:\\temp', user: 'Users', rights: 'Read', type: 'allow', state: 'present' }],
    ['ansible.windows.win_acl_inheritance', { path: 'C:\\temp', state: 'absent', reorganize: true }],
    ['ansible.windows.win_owner', { path: 'C:\\temp', user: 'Administrators', recurse: true }],
    ['ansible.windows.win_service', { name: 'sshd', start_mode: 'auto', state: 'started', username: 'LocalSystem' }],
    ['ansible.windows.win_regedit', { path: 'HKLM:\\SOFTWARE\\X', name: 'v', data: 1, type: 'dword' }],
    ['ansible.windows.win_reg_stat', { path: 'HKLM:\\SOFTWARE\\X', name: 'v' }],
    ['ansible.windows.win_user', { name: 'svc', state: 'present', groups: ['Users'], account_disabled: false }],
    ['ansible.windows.win_group', { name: 'ops', state: 'present', description: 'ops' }],
    ['ansible.windows.win_group_membership', { name: 'Administrators', members: ['svc'], state: 'present' }],
    ['ansible.windows.win_feature', { name: ['Web-Server'], state: 'present', include_management_tools: true }],
    ['ansible.windows.win_optional_feature', { name: 'TelnetClient', state: 'present' }],
    ['ansible.windows.win_package', { path: 'C:\\temp\\a.msi', state: 'present', arguments: '/quiet' }],
    ['ansible.windows.win_reboot', { reboot_timeout: 600, msg: 'Rebooting' }],
    ['ansible.windows.win_path', { elements: ['C:\\tools'], state: 'present' }],
    ['ansible.windows.win_environment', { name: 'APP_ENV', value: 'prod', level: 'machine', state: 'present' }],
    ['ansible.windows.win_hostname', { name: 'web01' }],
    ['ansible.windows.win_whoami', null],
    ['ansible.windows.win_wait_for', { port: 22, timeout: 30 }],
    ['ansible.windows.win_timezone', { timezone: 'Tokyo Standard Time' }],
    ['ansible.windows.win_firewall', { profiles: ['Domain'], state: 'enabled' }],
    ['community.windows.win_firewall_rule', { name: 'ssh', localport: '22', protocol: 'tcp', action: 'allow', direction: 'in' }],
    ['community.windows.win_lineinfile', { path: 'C:\\temp\\a.ini', line: 'x=1', regex: '^x=' }],
  ]

  it('典型例の表が Windows のモジュール一覧（引数ルールを持つもの）と一致する', () => {
    expect(typical.map(([m]) => m).sort()).toEqual(Object.keys(WINDOWS_MODULE_RULES).sort())
  })

  describe.each(MODES)('mode=%s', (mode) => {
    it.each(typical)('%s の典型例は通る', (moduleName, args) => {
      const result = win([{ name: 't', [moduleName]: args }], mode)
      expect(result.violations).toEqual([])
      expect(result.ok).toBe(true)
    })

    it.each([
      ['ansible.builtin.debug', { msg: 'hi' }],
      ['ansible.builtin.assert', { that: ['1 == 1'] }],
      ['ansible.builtin.set_fact', { app_dir: 'C:\\app' }],
      ['ansible.builtin.fail', { msg: 'stop' }],
    ])('コントローラだけで動く %s は通る', (moduleName, args) => {
      const result = win([{ [moduleName]: args }], mode)
      expect(result.violations).toEqual([])
    })
  })

  it('各モジュールの許可引数をすべて同時に指定しても通る（一覧と検査の整合）', () => {
    for (const [moduleName, rule] of Object.entries(WINDOWS_MODULE_RULES)) {
      if (rule.args.size === 0) continue
      const args: Record<string, unknown> = {}
      for (const arg of rule.args) {
        args[arg] = rule.argConstraints.has(arg) ? 'https://example.com/x' : 'x'
      }
      // win_package.path はホスト上の絶対パスも可だが、URL も可なので上の値で通る。
      const result = win([{ [moduleName]: args }])
      expect({ moduleName, violations: result.violations }).toEqual({
        moduleName,
        violations: [],
      })
    }
  })

  it('引数なし（null）のタスクは通る', () => {
    expect(win([{ 'ansible.windows.win_whoami': null }]).ok).toBe(true)
  })
})

describe('Windows: 引数の allowlist', () => {
  it('一覧に無い引数は拒否する', () => {
    const result = win([{ 'ansible.windows.win_file': { path: 'C:\\temp', state: 'directory', unknown_opt: 1 } }])
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      expect.objectContaining({ taskIndex: 0, key: 'unknown_opt' }),
    ])
  })

  it.each([
    ['ansible.windows.win_powershell', 'path', { path: 'C:\\x.ps1' }],
    ['ansible.windows.win_powershell', 'remote_src', { script: 'x', remote_src: true }],
    ['ansible.windows.win_copy', 'src', { src: '/etc/passwd', dest: 'C:\\x' }],
    ['ansible.windows.win_copy', 'remote_src', { content: 'x', dest: 'C:\\x', remote_src: true }],
    ['ansible.windows.win_copy', 'local_follow', { content: 'x', dest: 'C:\\x', local_follow: true }],
    ['ansible.windows.win_copy', 'decrypt', { content: 'x', dest: 'C:\\x', decrypt: true }],
  ])('コントローラ側のパスを扱う %s.%s は拒否する', (moduleName, arg, args) => {
    for (const mode of MODES) {
      const result = win([{ [moduleName]: args }], mode)
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: arg, reason: expect.stringContaining('controller') }),
      )
    }
  })

  it.each([
    ['ansible.windows.win_get_url', 'url_username'],
    ['ansible.windows.win_get_url', 'url_password'],
    ['ansible.windows.win_get_url', 'client_cert'],
    ['ansible.windows.win_get_url', 'client_cert_password'],
    ['ansible.windows.win_get_url', 'proxy_username'],
    ['ansible.windows.win_get_url', 'proxy_password'],
    ['ansible.windows.win_get_url', 'use_default_credential'],
    ['ansible.windows.win_get_url', 'proxy_use_default_credential'],
    ['ansible.windows.win_get_url', 'force_basic_auth'],
    ['ansible.windows.win_package', 'url_username'],
    ['ansible.windows.win_package', 'url_password'],
    ['ansible.windows.win_package', 'client_cert'],
    ['ansible.windows.win_package', 'client_cert_password'],
    ['ansible.windows.win_package', 'proxy_username'],
    ['ansible.windows.win_package', 'proxy_password'],
    ['ansible.windows.win_package', 'use_default_credential'],
    ['ansible.windows.win_package', 'proxy_use_default_credential'],
    ['ansible.windows.win_package', 'force_basic_auth'],
    ['ansible.windows.win_user', 'password'],
    ['ansible.windows.win_user', 'update_password'],
    ['ansible.windows.win_service', 'password'],
    ['ansible.windows.win_service', 'update_password'],
    ['ansible.windows.win_powershell', 'sensitive_parameters'],
  ])('資格情報の引数 %s.%s は MVP では拒否する（値が秘匿変数の参照でも）', (moduleName, arg) => {
    const result = win([{ [moduleName]: { [arg]: '{{ SECRET_PASSWORD }}' } }])
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ key: arg, reason: expect.stringContaining('credential') }),
    )
  })

  it('引数を task の args: キーワードで渡す迂回は拒否する', () => {
    const result = win([
      { 'ansible.windows.win_powershell': { script: 'x' }, args: { path: 'C:\\x.ps1' } },
    ])
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ key: 'args' }))
  })

  it.each(['a list', 42, true])('引数がマッピングでも文字列でも null でもない（%p）なら拒否する', (args) => {
    const value = args === 'a list' ? ['x'] : args
    const result = win([{ 'ansible.windows.win_file': value }])
    expect(result.ok).toBe(false)
  })
})

describe('Windows: 引数の値の制約', () => {
  describe('win_get_url の url / checksum_url / proxy_url は http(s):// だけ', () => {
    it.each(['https://example.com/a.msi', 'http://example.com/a.msi', 'HTTPS://EXAMPLE.COM/A.MSI', 'https://{{ mirror_host }}/a.msi'])(
      'url=%s は通る',
      (url) => {
        expect(win([{ 'ansible.windows.win_get_url': { url, dest: 'C:\\a' } }]).ok).toBe(true)
      },
    )

    it.each([
      'file:///C:/Windows/win.ini',
      'file://server/share/a.msi',
      'ftp://example.com/a.msi',
      '\\\\server\\share\\a.msi',
      'C:\\a.msi',
      '{{ installer_url }}',
      ' https://example.com/a',
    ])('url=%s は拒否する', (url) => {
      const result = win([{ 'ansible.windows.win_get_url': { url, dest: 'C:\\a' } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(expect.objectContaining({ key: 'url' }))
    })

    it('url が文字列でなければ拒否する', () => {
      const result = win([{ 'ansible.windows.win_get_url': { url: ['https://a'], dest: 'C:\\a' } }])
      expect(result.ok).toBe(false)
    })

    it.each(['checksum_url', 'proxy_url'])('%s の file:// は拒否する', (arg) => {
      const result = win([
        { 'ansible.windows.win_get_url': { url: 'https://a/b', dest: 'C:\\a', [arg]: 'file:///C:/x' } },
      ])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(expect.objectContaining({ key: arg }))
    })
  })

  describe('win_package の path は http(s):// かホスト上の絶対パスだけ（UNC は拒否）', () => {
    it.each(['C:\\temp\\a.msi', 'd:\\pkgs\\a.exe', 'https://example.com/a.msi', 'http://example.com/a.msi'])(
      'path=%s は通る',
      (p) => {
        expect(win([{ 'ansible.windows.win_package': { path: p, state: 'present' } }]).ok).toBe(true)
      },
    )

    it.each([
      '\\\\server\\share\\a.msi',
      '\\\\?\\UNC\\server\\share\\a.msi',
      '//server/share/a.msi',
      'file://server/share/a.msi',
      'a.msi',
      '{{ pkg_path }}',
    ])('path=%s は拒否する', (p) => {
      const result = win([{ 'ansible.windows.win_package': { path: p, state: 'present' } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(expect.objectContaining({ key: 'path' }))
    })

    // Ansible の is_possibly_template は `{{` / `{%` / `{#` の3種を見る。値の制約は「Jinja を
    // 含むか」を判定せず接頭辞の正規表現で決めるので、どの開始記号で始まる値も接頭辞に一致せず
    // 拒否される（`{#` だけ見落とすような判定の漏れが構造上起きないことを固定する）。
    describe.each([
      ['ansible.windows.win_get_url', 'url', { dest: 'C:\\a' }],
      ['ansible.windows.win_get_url', 'checksum_url', { url: 'https://a/b', dest: 'C:\\a' }],
      ['ansible.windows.win_get_url', 'proxy_url', { url: 'https://a/b', dest: 'C:\\a' }],
      ['ansible.windows.win_package', 'path', { state: 'present' }],
      ['ansible.windows.win_package', 'proxy_url', { path: 'C:\\a.msi', state: 'present' }],
    ])('%s の %s は Jinja の3種の開始記号で始まる値を拒否する', (moduleName, arg, rest) => {
      it.each([
        '{{ installer_url }}',
        '{%- if true %}file:///C:/x{% endif %}',
        '{# c #}file:///C:/x',
        '{#- c -#}\\\\server\\share\\a.msi',
      ])('%s', (value) => {
        const result = win([{ [moduleName]: { ...rest, [arg]: value } }])
        expect(result.ok).toBe(false)
        expect(result.violations).toContainEqual(expect.objectContaining({ key: arg }))
      })
    })

    it('値の制約の正規表現はすべて先頭（^）に固定されている（Jinja を前置して迂回させない）', () => {
      const constrained = Object.entries(WINDOWS_MODULE_RULES).flatMap(([, rule]) => [...rule.argConstraints.values()])
      expect(constrained.length).toBeGreaterThan(0)
      for (const { regex } of constrained) expect(regex.source.startsWith('^')).toBe(true)
    })

    it('path を省略した product_id 指定のアンインストールは通る', () => {
      expect(
        win([{ 'ansible.windows.win_package': { product_id: '{ABC}', state: 'absent' } }]).ok,
      ).toBe(true)
    })
  })
})

describe('Windows: フリーフォーム引数', () => {
  it('win_command の文字列形式は通る', () => {
    const body = '- ansible.windows.win_command: cmd.exe /c echo hello\n'
    const result = validateAnsibleTasks(body, { mode: 'ecs', targetOs: 'windows' })
    expect(result.violations).toEqual([])
  })

  it('win_shell の複数行ブロック形式は通る', () => {
    const body = [
      '- name: multi-line',
      '  ansible.windows.win_shell: |',
      '    $x = Get-Service sshd',
      '    if ($x.Status -ne "Running") { Start-Service sshd }',
      '',
    ].join('\n')
    const result = validateAnsibleTasks(body, { mode: 'resident', targetOs: 'windows' })
    expect(result.violations).toEqual([])
  })

  it('フリーフォームでも lookup は拒否する', () => {
    const body = "- ansible.windows.win_shell: echo {{ lookup('file', '/etc/passwd') }}\n"
    expect(validateAnsibleTasks(body, { mode: 'ecs', targetOs: 'windows' }).ok).toBe(false)
  })

  it.each([
    ['ansible.windows.win_copy', 'src=/etc/shadow dest=C:\\x'],
    ['ansible.windows.win_powershell', 'path=C:\\x.ps1'],
    ['ansible.windows.win_get_url', 'url=file:///C:/x dest=C:\\y'],
    ['ansible.windows.win_file', 'path=C:\\x state=absent'],
  ])('フリーフォームでない %s の文字列形式（k=v）は拒否する', (moduleName, args) => {
    const result = win([{ [moduleName]: args }])
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(expect.objectContaining({ key: moduleName }))
  })
})

describe('両経路で拒否する（設計書 §6.3）', () => {
  const denied = [
    'community.windows.win_psexec',
    'ansible.windows.win_template',
    'ansible.builtin.fetch',
    'fetch',
    'ansible.builtin.slurp',
    'slurp',
    'ansible.builtin.script',
    'script',
    'ansible.builtin.raw',
    'raw',
    'ansible.windows.win_credential',
    'community.windows.win_credential',
    'ansible.windows.win_dsc',
    'community.windows.win_scheduled_task',
    'ansible.windows.win_share',
    'ansible.windows.win_uri',
    'microsoft.ad.user',
    'microsoft.ad.domain',
    'microsoft.ad.membership',
    'ansible.windows.win_domain',
    'ansible.windows.win_domain_membership',
    'community.windows.win_domain_user',
    'ansible.windows.win_updates',
    'win_updates',
  ]

  for (const targetOs of ['linux', 'windows'] as const) {
    for (const mode of MODES) {
      it.each(denied)(`targetOs=${targetOs} mode=${mode}: %s は拒否する`, (moduleName) => {
        const result = run([{ [moduleName]: { name: 'x' } }], targetOs, mode)
        expect(result.ok).toBe(false)
        expect(result.violations).toContainEqual(
          expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
        )
      })
    }
  }

  it('§6.3 の拒否対象は Windows の allowlist に1つも含まれない', () => {
    for (const moduleName of denied) {
      expect(WINDOWS_MODULE_ALLOWLIST.has(moduleName)).toBe(false)
    }
  })
})

describe('Windows: Linux のモジュール・短縮形・旧名の拒否', () => {
  const linuxModules = [...MODULE_ALLOWLIST].filter(
    (m) => !WINDOWS_MODULE_ALLOWLIST.has(m),
  )

  it('Linux 用の allowlist から Windows でも使えるのはコントローラだけで動く3つだけ', () => {
    expect([...MODULE_ALLOWLIST].filter((m) => WINDOWS_MODULE_ALLOWLIST.has(m)).sort()).toEqual([
      'ansible.builtin.assert',
      'ansible.builtin.debug',
      'ansible.builtin.set_fact',
    ])
  })

  describe.each(MODES)('mode=%s', (mode) => {
    it.each([...linuxModules, 'apt', 'systemd', 'command', 'shell', 'copy', 'file'])(
      'Linux のモジュール %s は拒否する',
      (moduleName) => {
        const result = win([{ [moduleName]: { name: 'x' } }], mode)
        expect(result.ok).toBe(false)
        expect(result.violations).toContainEqual(
          expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
        )
      },
    )
  })

  it.each([...RESIDENT_EXTRA_MODULE_ALLOWLIST, 'uri', 'git', 'cron'])(
    'resident 限定の追加モジュール %s も Windows では拒否する',
    (moduleName) => {
      expect(win([{ [moduleName]: { name: 'x' } }], 'resident').ok).toBe(false)
    },
  )

  it.each(['win_shell', 'win_command', 'win_copy', 'win_file', 'win_reboot', 'win_whoami'])(
    '短縮形 %s は拒否する（FQCN だけを認める）',
    (moduleName) => {
      const result = win([{ [moduleName]: { cmd: 'x' } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
      )
    },
  )

  it.each([
    'community.windows.win_timezone',
    'community.windows.win_firewall',
  ])('非推奨の転送名 %s は拒否する（正規の ansible.windows 名だけを認める）', (moduleName) => {
    expect(win([{ [moduleName]: { state: 'enabled' } }]).ok).toBe(false)
  })
})

describe('include_role と OS の対応表', () => {
  const linuxRoles = Object.entries(ROLE_TARGET_OS)
    .filter(([, os]) => os === 'linux')
    .map(([role]) => role)

  it('Linux のロールは1つ以上ある（以下のテストが空振りしない）', () => {
    expect(linuxRoles.length).toBeGreaterThan(0)
  })

  it.each(linuxRoles)('Windows では Linux のロール %s を include_role できない', (role) => {
    for (const mode of MODES) {
      const result = win([{ 'ansible.builtin.include_role': { name: role } }], mode)
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'name', reason: expect.stringContaining('windows') }),
      )
    }
  })

  it('短縮形 include_role でも同じく拒否する', () => {
    expect(win([{ include_role: { name: 'docker' } }]).ok).toBe(false)
  })

  it.each(linuxRoles)('Linux では %s を従来どおり include_role できる（ロール名で拒否されない）', (role) => {
    // shared_file のように必須変数を持つロールは vars 無しだと別の理由で拒否されるので、
    // ロール名（OS の対応）に関する違反が無いことだけを見る。
    const result = run([{ 'ansible.builtin.include_role': { name: role } }], 'linux')
    expect(result.violations.filter((v) => v.key === 'name')).toEqual([])
  })

  it('対応表に無いロールは両 OS で拒否する（fail-closed）', () => {
    for (const targetOs of ['linux', 'windows'] as const) {
      expect(run([{ 'ansible.builtin.include_role': { name: 'no_such_role' } }], targetOs).ok).toBe(false)
    }
  })
})

describe('Windows でも OS に関係なく維持する検査', () => {
  it.each(['delegate_to', 'connection', 'become_user', 'become_method', 'environment', 'local_action'])(
    'denylist のタスクキー %s は拒否する',
    (key) => {
      const result = win([{ 'ansible.windows.win_shell': 'whoami', [key]: 'x' }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key, reason: 'forbidden task key' }),
      )
    },
  )

  it('become はモジュールキーとして扱われ拒否する', () => {
    const result = win([{ 'ansible.windows.win_shell': 'whoami', become: true }])
    expect(result.violations).toContainEqual(expect.objectContaining({ key: 'become' }))
  })

  it('引数の値の中の lookup は拒否する', () => {
    const result = win([
      { 'ansible.windows.win_copy': { content: "{{ lookup('file', '/root/.ssh/id_rsa') }}", dest: 'C:\\x' } },
    ])
    expect(result.ok).toBe(false)
    expect(result.violations).toContainEqual(
      expect.objectContaining({ reason: 'lookup/query plugin reference is forbidden' }),
    )
  })

  it('ansible_* の set_fact と register は拒否する', () => {
    expect(win([{ 'ansible.builtin.set_fact': { ansible_connection: 'local' } }]).ok).toBe(false)
    expect(win([{ 'ansible.windows.win_whoami': null, register: 'ansible_facts' }]).ok).toBe(false)
  })

  it('秘匿変数を参照する Windows のタスクには no_log が付く', () => {
    const result = run(
      [{ 'ansible.windows.win_shell': 'echo {{ API_TOKEN }} | Out-File C:\\t.txt' }],
      'windows',
      'ecs',
      new Set(['API_TOKEN']),
    )
    expect(result.ok).toBe(true)
    expect(result.normalizedTasks?.[0]).toEqual(expect.objectContaining({ no_log: true }))
  })

  it('ecs と resident で結果が変わらない', () => {
    const tasks = [
      { 'ansible.windows.win_shell': 'whoami' },
      { 'ansible.windows.win_powershell': { path: 'C:\\x.ps1' } },
      { 'ansible.builtin.uri': { url: 'https://a' } },
    ]
    expect(win(tasks, 'resident')).toEqual(win(tasks, 'ecs'))
  })
})

describe('Linux: Windows のモジュールは拒否する', () => {
  describe.each(MODES)('mode=%s', (mode) => {
    it.each(Object.keys(WINDOWS_MODULE_RULES))('%s は拒否する', (moduleName) => {
      const result = run([{ [moduleName]: { name: 'x' } }], 'linux', mode)
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
      )
    })
  })

  it('Linux で ansible.builtin.fail は従来どおり拒否する（Windows だけで許可）', () => {
    expect(run([{ 'ansible.builtin.fail': { msg: 'x' } }], 'linux').ok).toBe(false)
  })
})

describe('windows-guard.json の構造', () => {
  it('ロールと OS の対応表のキー = ansible/roles/ のディレクトリ = INCLUDE_ROLE_ALLOWED_ROLES（1:1）', () => {
    const dirs = readdirSync(ROLES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(Object.keys(ROLE_TARGET_OS).sort()).toEqual(dirs)
    expect([...INCLUDE_ROLE_ALLOWED_ROLES].sort()).toEqual(dirs)
  })

  it('対応表の値は linux / windows のいずれか', () => {
    for (const os of Object.values(ROLE_TARGET_OS)) {
      expect(['linux', 'windows']).toContain(os)
    }
  })

  it('Windows のモジュールはすべて ansible.windows. / community.windows. / ansible.builtin. の FQCN', () => {
    expect(WINDOWS_MODULE_ALLOWLIST.size).toBeGreaterThan(0)
    for (const moduleName of WINDOWS_MODULE_ALLOWLIST) {
      expect(moduleName).toMatch(/^(ansible\.windows|community\.windows|ansible\.builtin)\.[a-z0-9_]+$/)
    }
  })

  it('引数ルールを持つモジュールは ansible.windows. / community.windows. のものだけ', () => {
    for (const moduleName of Object.keys(WINDOWS_MODULE_RULES)) {
      expect(moduleName).toMatch(/^(ansible\.windows|community\.windows)\.win_[a-z0-9_]+$/)
    }
  })

  it('許可引数と拒否引数が重ならず、値の制約は許可引数にだけ付く', () => {
    for (const [moduleName, rule] of Object.entries(WINDOWS_MODULE_RULES)) {
      for (const arg of rule.deniedArgs.keys()) {
        expect({ moduleName, arg, allowed: rule.args.has(arg) }).toEqual({ moduleName, arg, allowed: false })
      }
      for (const arg of rule.argConstraints.keys()) {
        expect({ moduleName, arg, allowed: rule.args.has(arg) }).toEqual({ moduleName, arg, allowed: true })
      }
    }
  })

  it('フリーフォームを認めるのは win_command / win_shell だけ', () => {
    const freeForm = Object.entries(WINDOWS_MODULE_RULES)
      .filter(([, rule]) => rule.freeForm)
      .map(([m]) => m)
      .sort()
    expect(freeForm).toEqual(['ansible.windows.win_command', 'ansible.windows.win_shell'])
  })

  it('コレクションの版は ansible.windows 3.8.0 / community.windows 3.3.0 に固定', () => {
    expect(WINDOWS_COLLECTION_VERSIONS).toEqual({
      'ansible.windows': '3.8.0',
      'community.windows': '3.3.0',
    })
  })

  it('JSON ファイルの実体がエクスポートと一致する（コードで値を上書きしていない）', () => {
    const raw = JSON.parse(readFileSync(GUARD_JSON_PATH, 'utf8')) as {
      roleTargetOs: Record<string, string>
      modules: Record<string, unknown>
    }
    expect(raw.roleTargetOs).toEqual(ROLE_TARGET_OS)
    expect(Object.keys(raw.modules).sort()).toEqual(Object.keys(WINDOWS_MODULE_RULES).sort())
  })
})

describe('parseWindowsGuardData（JSON の形の検査。壊れていたら読み込み時に失敗させる）', () => {
  const valid = () => ({
    collections: { 'ansible.windows': '3.8.0', 'community.windows': '3.3.0' },
    controllerOnlyModules: ['ansible.builtin.debug'],
    modules: {
      'ansible.windows.win_get_url': {
        freeForm: false,
        args: ['url', 'dest'],
        deniedArgs: { url_password: 'credential' },
        argConstraints: {
          url: { pattern: '^https?://', flags: 'i', description: 'http(s) only' },
        },
      },
      'ansible.windows.win_whoami': { args: [] },
    },
    roleTargetOs: { docker: 'linux' },
  })

  it('正しい形なら読み込める', () => {
    const parsed = parseWindowsGuardData(valid())
    expect(parsed.moduleAllowlist.has('ansible.windows.win_get_url')).toBe(true)
    expect(parsed.moduleAllowlist.has('ansible.builtin.debug')).toBe(true)
    expect(parsed.modules['ansible.windows.win_whoami'].freeForm).toBe(false)
    expect(parsed.modules['ansible.windows.win_get_url'].argConstraints.get('url')?.regex.test('HTTPS://a')).toBe(true)
    expect(parsed.roleTargetOs).toEqual({ docker: 'linux' })
  })

  const broken: Array<[string, (d: Record<string, any>) => void]> = [
    ['ルートがオブジェクトでない', (d) => { Object.keys(d).forEach((k) => delete d[k]); d.__array = true }],
    ['collections が無い', (d) => { delete d.collections }],
    ['collections の値が文字列でない', (d) => { d.collections['ansible.windows'] = 3 }],
    ['controllerOnlyModules が配列でない', (d) => { d.controllerOnlyModules = 'ansible.builtin.debug' }],
    ['controllerOnlyModules の要素が文字列でない', (d) => { d.controllerOnlyModules = [1] }],
    ['modules が無い', (d) => { delete d.modules }],
    ['モジュールのルールがオブジェクトでない', (d) => { d.modules['ansible.windows.win_whoami'] = [] }],
    ['args が無い', (d) => { delete d.modules['ansible.windows.win_whoami'].args }],
    ['args の要素が文字列でない', (d) => { d.modules['ansible.windows.win_whoami'].args = [1] }],
    ['freeForm が真偽値でない', (d) => { d.modules['ansible.windows.win_whoami'].freeForm = 'yes' }],
    ['deniedArgs がオブジェクトでない', (d) => { d.modules['ansible.windows.win_whoami'].deniedArgs = ['x'] }],
    ['deniedArgs の理由が文字列でない', (d) => { d.modules['ansible.windows.win_whoami'].deniedArgs = { x: 1 } }],
    ['deniedArgs が許可引数と重なる', (d) => { d.modules['ansible.windows.win_get_url'].deniedArgs = { url: 'x' } }],
    ['argConstraints がオブジェクトでない', (d) => { d.modules['ansible.windows.win_whoami'].argConstraints = 'x' }],
    ['制約がオブジェクトでない', (d) => { d.modules['ansible.windows.win_get_url'].argConstraints.url = 'x' }],
    ['制約の pattern が文字列でない', (d) => { d.modules['ansible.windows.win_get_url'].argConstraints.url.pattern = 1 }],
    ['制約の flags が文字列でない', (d) => { d.modules['ansible.windows.win_get_url'].argConstraints.url.flags = 1 }],
    ['制約の description が文字列でない', (d) => { delete d.modules['ansible.windows.win_get_url'].argConstraints.url.description }],
    ['制約の pattern が正規表現として不正', (d) => { d.modules['ansible.windows.win_get_url'].argConstraints.url.pattern = '(' }],
    ['制約が許可引数に無い引数に付いている', (d) => { d.modules['ansible.windows.win_get_url'].argConstraints.other = { pattern: 'x', description: 'x' } }],
    ['roleTargetOs が無い', (d) => { delete d.roleTargetOs }],
    ['roleTargetOs の値が linux / windows でない', (d) => { d.roleTargetOs.docker = 'macos' }],
  ]

  it.each(broken)('%s なら例外を投げる', (_label, mutate) => {
    const data = valid() as Record<string, any>
    mutate(data)
    const input = data.__array ? [] : data
    expect(() => parseWindowsGuardData(input)).toThrow(/windows-guard\.json/)
  })
})

/**
 * Linux 側の共通の検査（agent#856: 文字列形式の制限・`_` で始まる引数キーの拒否・
 * 引数キーの Jinja 拒否・Jinja 判定の `{#` / raw / `#jinja2:`）が Windows 経路にも効くこと。
 * 文字列形式を許可するモジュールは OS ごとに選ぶ（Linux: command / shell、
 * Windows: win_command / win_shell）。`_raw_params` は文字列形式を許可するモジュールだけで認める
 * （win_command / win_shell は windows-guard.json の引数 allowlist にも `_raw_params` を持つ）。
 */
describe('Windows: 共通の検査（文字列形式・内部引数キー・キーの Jinja・Jinja 判定）', () => {
  const INTERNAL_REASON = expect.stringContaining('internal module arguments')
  const KEY_JINJA_REASON = 'module argument names must not contain Jinja templates'
  const FREE_FORM_MODULES = ['ansible.windows.win_command', 'ansible.windows.win_shell']
  const NON_FREE_FORM_RULE_MODULES = Object.keys(WINDOWS_MODULE_RULES).filter(
    (m) => !FREE_FORM_MODULES.includes(m),
  )

  describe('文字列形式を許可するモジュールは OS ごとに選ばれる', () => {
    it('文字列形式を許可する Windows のモジュールは win_command / win_shell だけ（前提の固定）', () => {
      expect(
        Object.entries(WINDOWS_MODULE_RULES)
          .filter(([, rule]) => rule.freeForm)
          .map(([m]) => m)
          .sort(),
      ).toEqual(FREE_FORM_MODULES)
    })

    describe.each(MODES)('mode=%s', (mode) => {
      it.each(['ansible.builtin.command', 'ansible.builtin.shell', 'command', 'shell'])(
        'Windows で %s（Linux の文字列形式モジュール）は文字列形式でもマッピングでも通らない',
        (moduleName) => {
          for (const args of ['whoami', { cmd: 'whoami' }]) {
            const result = win([{ [moduleName]: args }], mode)
            expect(result.ok).toBe(false)
            expect(result.violations).toContainEqual(
              expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
            )
          }
        },
      )

      it.each(FREE_FORM_MODULES)(
        'Linux で %s（Windows の文字列形式モジュール）は文字列形式でも通らない',
        (moduleName) => {
          const result = run([{ [moduleName]: 'whoami' }], 'linux', mode)
          expect(result.ok).toBe(false)
          expect(result.violations).toContainEqual(
            expect.objectContaining({ key: moduleName, reason: 'module not in allowlist' }),
          )
        },
      )

      it.each([
        ['ansible.builtin.debug', 'var=SOME_VAR'],
        ['ansible.builtin.assert', 'that="1 == 1"'],
        ['ansible.builtin.fail', 'msg=stop'],
      ])(
        'Windows でもコントローラだけで動く %s の文字列形式（k=v）は拒否する',
        (moduleName, args) => {
          const result = win([{ [moduleName]: args }], mode)
          expect(result.ok).toBe(false)
          expect(result.violations).toEqual([
            expect.objectContaining({
              key: moduleName,
              reason: expect.stringContaining('only allowed for win_command / win_shell'),
            }),
          ])
        },
      )

      it('Windows でコントローラだけで動くモジュールの引数がリストなら拒否する', () => {
        const result = win([{ 'ansible.builtin.debug': ['x'] }], mode)
        expect(result.ok).toBe(false)
        expect(result.violations).toContainEqual(
          expect.objectContaining({ key: 'ansible.builtin.debug' }),
        )
      })

      it('文字列形式を拒否した理由は 1 件だけ（重ねて報告しない）', () => {
        const result = win([{ 'ansible.windows.win_file': 'path=C:\\fake state=absent' }], mode)
        expect(result.violations).toEqual([
          expect.objectContaining({
            key: 'ansible.windows.win_file',
            reason: expect.stringContaining('only allowed for win_command / win_shell'),
          }),
        ])
      })
    })
  })

  describe('`_` で始まる引数キー', () => {
    it.each(FREE_FORM_MODULES)('%s のマッピングに書いた _raw_params は通る（Linux の command / shell と同じ扱い）', (moduleName) => {
      const result = win([{ [moduleName]: { _raw_params: 'whoami', chdir: 'C:\\fake' } }])
      expect(result.violations).toEqual([])
      expect(result.ok).toBe(true)
    })

    it.each(
      FREE_FORM_MODULES.flatMap((m) =>
        ['_variable_params', '_uses_shell', '_ansible_check_mode', '_anything'].map((k) => [m, k]),
      ),
    )('%s の %s は内部引数として拒否する（1 件だけ報告）', (moduleName, argKey) => {
      const result = win([{ [moduleName]: { cmd: 'whoami', [argKey]: "{{ {'chdir': 'C:\\\\fake'} }}" } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        expect.objectContaining({ key: argKey, reason: INTERNAL_REASON }),
      ])
    })

    it.each(
      NON_FREE_FORM_RULE_MODULES.flatMap((m) => ['_raw_params', '_variable_params'].map((k) => [m, k])),
    )('%s の %s は内部引数として拒否する（引数 allowlist と重ねて報告しない）', (moduleName, argKey) => {
      const result = win([{ [moduleName]: { [argKey]: "{{ {'src': '/fake/controller/path'} }}" } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        expect.objectContaining({ key: argKey, reason: INTERNAL_REASON }),
      ])
    })

    it.each([
      ['ansible.builtin.debug', '_raw_params'],
      ['ansible.builtin.debug', '_variable_params'],
      ['ansible.builtin.assert', '_raw_params'],
      ['ansible.builtin.fail', '_variable_params'],
    ])('Windows でもコントローラだけで動く %s の %s は拒否する', (moduleName, argKey) => {
      const result = win([{ [moduleName]: { [argKey]: "{{ {'msg': 'x'} }}" } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: argKey, reason: INTERNAL_REASON }),
      )
    })

    it('Windows でも set_fact の _variable_params は拒否する', () => {
      const result = win([{ 'ansible.builtin.set_fact': { _variable_params: "{{ {'a': 1} }}" } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: '_variable_params' }),
      )
    })
  })

  describe('引数キーの Jinja', () => {
    it.each([
      ['ansible.windows.win_file', "{{ 'path' }}"],
      ['ansible.windows.win_file', 'pa{# c #}th'],
      ['ansible.windows.win_file', '{% if true %}path{% endif %}'],
      ['ansible.windows.win_command', "{{ 'cmd' }}"],
      ['ansible.windows.win_get_url', "{{ 'url' }}"],
      ['ansible.builtin.debug', "{{ 'msg' }}"],
    ])('%s のキー %s は拒否する（1 件だけ報告）', (moduleName, argKey) => {
      const result = win([{ [moduleName]: { [argKey]: 'C:\\fake' } }])
      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        expect.objectContaining({ key: argKey, reason: KEY_JINJA_REASON }),
      ])
    })
  })

  describe('Jinja 判定（{# / raw / #jinja2:）と値の制約の整合', () => {
    it('接頭辞のあとに置いた Jinja コメントは接頭辞の制約を変えないので通る', () => {
      const result = win([
        { 'ansible.windows.win_get_url': { url: 'https://example.invalid/{# c #}a.msi', dest: 'C:\\fake' } },
      ])
      expect(result.violations).toEqual([])
    })

    it('接頭辞に一致しても閉じない {# は検証できないので拒否する', () => {
      const result = win([
        { 'ansible.windows.win_get_url': { url: 'https://example.invalid/a{#', dest: 'C:\\fake' } },
      ])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'root', reason: expect.stringContaining('unterminated') }),
      )
    })

    it('接頭辞に一致しても raw ブロックは拒否する', () => {
      const result = win([
        {
          'ansible.windows.win_package': {
            path: 'C:\\fake\\{% raw %}{{ x }}{% endraw %}.msi',
            state: 'present',
          },
        },
      ])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'root', reason: expect.stringContaining('raw') }),
      )
    })

    it('win_shell の文字列形式でも #jinja2: ヘッダは拒否する', () => {
      const body = [
        '- ansible.windows.win_shell: |',
        "    #jinja2:variable_start_string:'[[', variable_end_string:']]'",
        '    echo [[ SOME_VAR ]]',
        '',
      ].join('\n')
      const result = validateAnsibleTasks(body, { mode: 'ecs', targetOs: 'windows' })
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'root', reason: expect.stringContaining('#jinja2:') }),
      )
    })

    it('win_command の文字列形式でも閉じない {# は拒否する', () => {
      const result = win([{ 'ansible.windows.win_command': 'cmd.exe /c echo {# x' }])
      expect(result.ok).toBe(false)
      expect(result.violations).toContainEqual(
        expect.objectContaining({ key: 'root', reason: expect.stringContaining('unterminated') }),
      )
    })
  })
})
