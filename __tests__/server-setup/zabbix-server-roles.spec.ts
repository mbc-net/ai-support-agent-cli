import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { load, dump } from 'js-yaml'
import { validateAnsibleTasks as validate, INCLUDE_ROLE_ALLOWED_VARS } from '../../src/server-setup/ansible-task-guard'

const roleDir = path.join(__dirname, '../../ansible/roles')

const validateAnsibleTasks = (tasks: unknown[], options: { mode: 'resident', targetOs: 'linux' }) => validate(dump(tasks), options)

describe('Zabbix server and web roles', () => {
  it.each(['zabbix_server', 'zabbix_web'])('%s accepts its public configuration and rejects private overrides', (role) => {
    expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: role }, vars: { [`${role}_db_password`]: '{{ ZABBIX_DB_PASSWORD }}' } }], { mode: 'resident', targetOs: 'linux' }).ok).toBe(true)
    expect(INCLUDE_ROLE_ALLOWED_VARS[role]).toBeDefined()
    expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: role }, vars: { [`${role}_repo_pkg`]: { changed: false } } }], { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
    expect(existsSync(path.join(roleDir, role, 'tasks/main.yml'))).toBe(true)
  })

  it.each(['zabbix_server_db_result', 'zabbix_web_health', 'zabbix_server_db_credentials'])('rejects reading or overwriting %s from recipe tasks', (name) => {
    expect(validateAnsibleTasks([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }], { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
    expect(validateAnsibleTasks([{ 'ansible.builtin.set_fact': { [name]: 'fake' } }], { mode: 'resident', targetOs: 'linux' }).ok).toBe(false)
  })

  it('requires local/external database validation before provisioning', () => {
    const tasks = load(readFileSync(path.join(roleDir, 'zabbix_server/tasks/main.yml'), 'utf8')) as Array<Record<string, any>>
    expect(tasks[0]['ansible.builtin.assert']).toBeDefined()
    expect(tasks[0].when).toBeUndefined()
    expect(JSON.stringify(tasks[0])).toContain("['local', 'external']")
  })

  describe('ufw 許可元（設計書 §3.6.1）', () => {
    type Task = Record<string, any>
    const opts = { mode: 'resident', targetOs: 'linux' } as const
    const loadTasks = (role: string, file = 'main.yml'): Task[] =>
      load(readFileSync(path.join(roleDir, role, 'tasks', file), 'utf8')) as Task[]
    const loadDefaults = (role: string): Record<string, unknown> =>
      load(readFileSync(path.join(roleDir, role, 'defaults/main.yml'), 'utf8')) as Record<string, unknown>
    const flatten = (tasks: Task[]): Task[] =>
      tasks.flatMap((t) => [t, ...['block', 'rescue', 'always'].flatMap((k) => (Array.isArray(t[k]) ? flatten(t[k]) : []))])
    const internalNames = (role: string): string[] => [
      ...['add', 'added', 'after_add', 'delete', 'desired', 'desired_patterns', 'stale'].map((n) => `${role}_ufw_${n}`),
      `${role}_ufw_host_bit_sources`,
    ]

    it.each(['zabbix_server', 'zabbix_web'])('%s: 新しい公開変数 3 つをレシピの include_role で渡せる', (role) => {
      const result = validateAnsibleTasks(
        [{
          'ansible.builtin.include_role': { name: role },
          vars: {
            [`${role}_db_password`]: '{{ ZABBIX_DB_PASSWORD }}',
            [`${role}_allowed_sources`]: ['192.168.0.20/32', '10.0.0.0/24'],
            [`${role}_ufw_manage`]: true,
            [`${role}_allow_no_sources`]: false,
          },
        }],
        opts,
      )
      expect(result.ok).toBe(true)
      for (const name of ['allowed_sources', 'ufw_manage', 'allow_no_sources']) {
        expect(INCLUDE_ROLE_ALLOWED_VARS[role].has(`${role}_${name}`)).toBe(true)
      }
    })

    it.each(['zabbix_server', 'zabbix_web'].flatMap(internalNames))(
      '%s はレシピから上書き・参照・書き込みできない',
      (name) => {
        const role = name.startsWith('zabbix_server') ? 'zabbix_server' : 'zabbix_web'
        // stale は root の `ufw --force delete` の対象、host_bit_sources は検証結果そのもの。
        // include params は role 内の set_fact / task vars に勝つため、名前で拒否するしかない。
        expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: role }, vars: { [name]: [] } }], opts).ok).toBe(false)
        expect(validateAnsibleTasks([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }], opts).ok).toBe(false)
        expect(validateAnsibleTasks([{ 'ansible.builtin.set_fact': { [name]: 'fake' } }], opts).ok).toBe(false)
      },
    )

    it.each(['zabbix_server', 'zabbix_web'])('%s: ロール内で実際に使う内部名がテストの一覧と一致する', (role) => {
      // 上の拒否テストが実在しない名前を検査して空振りしないよう、ロール側の名前を確認する。
      const names = new Set<string>()
      for (const file of ['main.yml', 'ufw.yml']) {
        for (const t of flatten(loadTasks(role, file))) {
          if (typeof t.register === 'string' && t.register.startsWith(`${role}_ufw_`)) names.add(t.register)
          for (const k of Object.keys(t['ansible.builtin.set_fact'] ?? {})) if (k.startsWith(`${role}_ufw_`)) names.add(k)
          for (const k of Object.keys(t.vars ?? {})) if (k.startsWith(`${role}_ufw_`) && !t['ansible.builtin.include_role']) names.add(k)
        }
      }
      expect([...names].sort()).toEqual(internalNames(role).sort())
    })

    it('defaults: server / web は allow_no_sources: true（既存レシピ互換）、agent は false', () => {
      for (const role of ['zabbix_server', 'zabbix_web']) {
        const d = loadDefaults(role)
        expect(d[`${role}_allowed_sources`]).toEqual([])
        expect(d[`${role}_ufw_manage`]).toBe(true)
        expect(d[`${role}_allow_no_sources`]).toBe(true)
      }
      const agent = loadDefaults('zabbix_agent')
      expect(agent.zabbix_agent_allowed_sources).toEqual([])
      expect(agent.zabbix_agent_ufw_manage).toBe(true)
      expect(agent.zabbix_agent_allow_no_sources).toBe(false)
    })

    it.each(['zabbix_server', 'zabbix_web'])('%s: 先頭の Validate branch and required variables assert に許可元の検証が統合されている', (role) => {
      const first = loadTasks(role)[0]
      expect(first.name).toBe(`${role} : Validate branch and required variables`)
      expect(first.when).toBeUndefined()
      const args = first['ansible.builtin.assert'] as { that: string[]; fail_msg: string }
      const that = args.that.join('\n')
      expect(that).toContain(`${role}_ufw_manage is boolean`)
      expect(that).toContain(`${role}_allow_no_sources is boolean`)
      expect(that).toContain(`${role}_allowed_sources is sequence and ${role}_allowed_sources is not string`)
      expect(that).toContain(`${role}_allowed_sources | reject('string') | list | length == 0`)
      expect(that).toContain('(/([1-9]|[12][0-9]|3[0-2]))?')
      expect(that).toContain(`${role}_ufw_host_bit_sources | trim | length == 0`)
      expect(that).toContain(`not ${role}_ufw_manage or (${role}_allowed_sources | length) > 0 or ${role}_allow_no_sources`)
      // ホストビットの計算は task vars で行い、形式検証より後に参照される（形式検証を通った値だけが届く）。
      const hostBitIdx = args.that.findIndex((c) => c.includes('_ufw_host_bit_sources'))
      const formatIdx = args.that.findIndex((c) => c.includes("reject('match'"))
      expect(formatIdx).toBeGreaterThanOrEqual(0)
      expect(hostBitIdx).toBeGreaterThan(formatIdx)
      expect(String(first.vars[`${role}_ufw_host_bit_sources`])).toContain('% (2 ** (32 - ')
      // fail_msg に値を展開しない（{{ }} を書かない）。
      expect(args.fail_msg).not.toContain('{{')
    })

    it('zabbix_server: ufw 収束は readiness 確認（統計リクエスト応答待ち）の後', () => {
      const tasks = loadTasks('zabbix_server')
      const readyIdx = tasks.findIndex((t) => /Wait for the selected server to answer a statistics request/.test(t.name))
      const ufwIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'ufw.yml')
      expect(readyIdx).toBeGreaterThanOrEqual(0)
      expect(ufwIdx).toBeGreaterThan(readyIdx)
      expect(tasks[ufwIdx].when).toBe('zabbix_server_ufw_manage | bool')
    })

    it('zabbix_web: ufw 収束はロールバック block の外・後（main.yml の末尾）', () => {
      const tasks = loadTasks('zabbix_web')
      const blockIdx = tasks.findIndex((t) => Array.isArray(t.block) && Array.isArray(t.rescue))
      const ufwIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'ufw.yml')
      expect(blockIdx).toBeGreaterThanOrEqual(0)
      expect(ufwIdx).toBeGreaterThan(blockIdx)
      expect(ufwIdx).toBe(tasks.length - 1)
      expect(tasks[ufwIdx].when).toBe('zabbix_web_ufw_manage | bool')
      // ロールバック対象（block / rescue / always の中）に ufw を含めない。
      const inner = flatten([tasks[blockIdx]]).slice(1)
      expect(inner.some((t) => JSON.stringify(t).includes('ufw'))).toBe(false)
    })

    it.each(['zabbix_server', 'zabbix_web'])('%s: 空リスト＋管理 ON のとき、ポートを開けていない旨を debug で警告する', (role) => {
      const tasks = loadTasks(role)
      const ufwIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'ufw.yml')
      const warn = tasks.find((t) => t['ansible.builtin.debug'] && /not opened by this role/.test(t.name))
      expect(warn).toBeDefined()
      expect(tasks.indexOf(warn as Task)).toBeLessThan(ufwIdx)
      expect(warn?.when).toEqual([`${role}_ufw_manage | bool`, `${role}_allowed_sources | length == 0`])
      expect(String(warn?.['ansible.builtin.debug'].msg)).toContain(`{{ ${role}_listen_port }}/tcp`)
      expect(String(warn?.['ansible.builtin.debug'].msg)).toContain('NOT opened by this role')
    })
  })

  describe('管理者パスワード・ハウスキーピング（設計書 §4.2）', () => {
    type Task = Record<string, any>
    const opts = { mode: 'resident', targetOs: 'linux' } as const
    const loadTasks = (file = 'main.yml'): Task[] =>
      load(readFileSync(path.join(roleDir, 'zabbix_web/tasks', file), 'utf8')) as Task[]
    const flatten = (tasks: Task[]): Task[] =>
      tasks.flatMap((t) => [t, ...['block', 'rescue', 'always'].flatMap((k) => (Array.isArray(t[k]) ? flatten(t[k]) : []))])
    const apiTasks = flatten(loadTasks('api.yml'))
    const internalNames = ['zabbix_web_api_credentials', 'zabbix_web_api_result', 'zabbix_web_housekeeping_invalid']
    const housekeepingKeys = [
      'hk_events_mode', 'hk_events_trigger', 'hk_events_service', 'hk_events_internal', 'hk_events_discovery',
      'hk_events_autoreg', 'hk_services_mode', 'hk_services', 'hk_audit_mode', 'hk_audit', 'hk_sessions_mode',
      'hk_sessions', 'hk_history_mode', 'hk_history_global', 'hk_history', 'hk_trends_mode', 'hk_trends_global',
      'hk_trends', 'compression_status', 'compress_older',
    ]

    it('新しい公開変数 3 つをレシピの include_role で渡せる', () => {
      const result = validateAnsibleTasks(
        [{
          'ansible.builtin.include_role': { name: 'zabbix_web' },
          vars: {
            zabbix_web_db_password: '{{ ZABBIX_DB_PASSWORD }}',
            zabbix_web_admin_password: '{{ ZABBIX_ADMIN_PASSWORD }}',
            zabbix_web_admin_previous_password: '{{ ZABBIX_ADMIN_PREVIOUS_PASSWORD }}',
            zabbix_web_housekeeping: { hk_history_global: 1, hk_history: '90d' },
          },
        }],
        opts,
      )
      expect(result.ok).toBe(true)
      for (const name of ['zabbix_web_admin_password', 'zabbix_web_admin_previous_password', 'zabbix_web_housekeeping']) {
        expect(INCLUDE_ROLE_ALLOWED_VARS.zabbix_web.has(name)).toBe(true)
      }
    })

    it('管理者パスワードの変数名は常に秘匿扱いで、参照したレシピのタスクに no_log が付く', () => {
      for (const name of ['zabbix_web_admin_password', 'zabbix_web_admin_previous_password']) {
        const result = validate(dump([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }]), opts)
        expect(result.ok).toBe(true)
        expect((result.normalizedTasks?.[0] as Task).no_log).toBe(true)
      }
      // 変数名を vars のキーに書くだけ（値はリテラル）の include_role には no_log を付けない
      // （ロールの実行ログ・失敗理由まで消さないため）。
      const include = validate(
        dump([{ 'ansible.builtin.include_role': { name: 'zabbix_web' }, vars: { zabbix_web_housekeeping: { hk_audit: '31d' } } }]),
        opts,
      )
      expect(include.ok).toBe(true)
      expect((include.normalizedTasks?.[0] as Task).no_log).toBeUndefined()
    })

    it.each(internalNames)('%s はレシピから上書き・参照・書き込みできない', (name) => {
      expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: 'zabbix_web' }, vars: { [name]: 'x' } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.set_fact': { [name]: 'fake' } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.command': 'true', register: name }], opts).ok).toBe(false)
    })

    it('ロール内で実際に使う内部名がテストの一覧と一致する', () => {
      const names = new Set<string>()
      for (const file of ['main.yml', 'api.yml']) {
        for (const t of flatten(loadTasks(file))) {
          if (typeof t.register === 'string' && /^zabbix_web_(api_|housekeeping)/.test(t.register)) names.add(t.register)
          for (const k of Object.keys(t['ansible.builtin.set_fact'] ?? {})) if (/^zabbix_web_(api_|housekeeping)/.test(k)) names.add(k)
          for (const k of Object.keys(t.vars ?? {})) if (/^zabbix_web_(api_|housekeeping)/.test(k)) names.add(k)
        }
      }
      expect([...names].sort()).toEqual([...internalNames].sort())
    })

    it('defaults: パスワードは空・ハウスキーピングは空辞書で、Admin / 初期値 zabbix を変数にしない', () => {
      const text = readFileSync(path.join(roleDir, 'zabbix_web/defaults/main.yml'), 'utf8')
      const d = load(text) as Record<string, unknown>
      expect(d.zabbix_web_admin_password).toBe('')
      expect(d.zabbix_web_admin_previous_password).toBe('')
      expect(d.zabbix_web_housekeeping).toEqual({})
      // 'zabbix' は DB 名・DB ユーザーの既定値として正当に現れるため、値ではなく名前で見る。
      expect(Object.values(d)).not.toContain('Admin')
      expect(Object.keys(d).some((k) => /admin_user|admin_name|initial_password/.test(k))).toBe(false)
      const vars = load(readFileSync(path.join(roleDir, 'zabbix_web/vars/main.yml'), 'utf8')) as Record<string, unknown>
      expect(JSON.stringify(vars)).not.toMatch(/Admin|hk_|housekeeping/)
      // ユーザー名と初期値はヘルパー内のリテラル。
      const helper = readFileSync(path.join(roleDir, 'zabbix_web/files/zabbix_api.py'), 'utf8')
      expect(helper).toContain("USERNAME = 'Admin'")
      expect(helper).toContain("INITIAL_PASSWORD = 'zabbix'")
    })

    it('先頭の Validate assert に管理者パスワード・ハウスキーピングの検証が統合されている', () => {
      const first = loadTasks()[0]
      const args = first['ansible.builtin.assert'] as { that: string[]; fail_msg: string }
      const that = args.that.join('\n')
      expect(that).toContain('zabbix_web_admin_password is string')
      expect(that).toContain("zabbix_web_admin_password is match('^[\\x20-\\x7e]{8,72}\\Z')")
      expect(that).toContain('zabbix_web_admin_password == zabbix_web_admin_password | trim')
      expect(that).toContain("zabbix_web_admin_password != 'zabbix'")
      expect(that).toContain('zabbix_web_admin_previous_password is string')
      expect(that).toContain("zabbix_web_admin_previous_password is match('^[\\x20-\\x7e]{0,72}\\Z')")
      expect(that).toContain('zabbix_web_housekeeping is mapping')
      expect(that).toContain('zabbix_web_housekeeping | length == 0 or zabbix_web_admin_password | length > 0')
      // 値の検証（task vars）は is mapping の後に参照される。
      const mappingIdx = args.that.findIndex((c) => c.includes('zabbix_web_housekeeping is mapping'))
      const invalidIdx = args.that.findIndex((c) => c.includes('zabbix_web_housekeeping_invalid'))
      expect(invalidIdx).toBeGreaterThan(mappingIdx)
      // allowlist（20 キー）はロール内リテラル。読み取り専用キーは含めない。
      const rules = String(first.vars.zabbix_web_housekeeping_invalid)
      for (const key of housekeepingKeys) expect(rules).toContain(`'${key}'`)
      expect(rules).not.toContain('db_extension')
      expect(rules).not.toContain('compression_availability')
      expect(rules).toContain("is match('^[0-9]{1,10}[smhdw]?\\Z')")
      expect(rules).toContain('788400000')
      expect(rules).toContain('value is boolean')
      expect(args.fail_msg).not.toContain('{{')
      // ヘルパー側にも同じ 20 キーがリテラルである。
      const helper = readFileSync(path.join(roleDir, 'zabbix_web/files/zabbix_api.py'), 'utf8')
      for (const key of housekeepingKeys) expect(helper).toContain(`'${key}'`)
    })

    it('api.yml はロールバック block の外・後、かつ ufw と警告より前で、値があるときだけ include する', () => {
      const tasks = loadTasks()
      const blockIdx = tasks.findIndex((t) => Array.isArray(t.block) && Array.isArray(t.rescue))
      const apiIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'api.yml')
      const ufwIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'ufw.yml')
      const warnIdx = tasks.findIndex((t) => t['ansible.builtin.debug'] && /not opened by this role/.test(t.name))
      expect(apiIdx).toBeGreaterThan(blockIdx)
      expect(apiIdx).toBeLessThan(warnIdx)
      expect(apiIdx).toBeLessThan(ufwIdx)
      expect(tasks[apiIdx].when).toBe('zabbix_web_admin_password | length > 0 or zabbix_web_housekeeping | length > 0')
      expect(flatten([tasks[blockIdx]]).some((t) => JSON.stringify(t).includes('api.yml'))).toBe(false)
    })

    it('パスワード空で許可元ありなら、初期パスワードのまま公開の可能性を debug で警告する', () => {
      const tasks = loadTasks()
      const warn = tasks.find((t) => t['ansible.builtin.debug'] && /initial admin password/.test(t.name))
      expect(warn).toBeDefined()
      expect(warn?.when).toEqual(['zabbix_web_admin_password | length == 0', 'zabbix_web_allowed_sources | length > 0'])
      expect(tasks.indexOf(warn as Task)).toBeLessThan(tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'ufw.yml'))
      expect(JSON.stringify(warn)).not.toContain('{{')
    })

    it('ヘルパーは root 0700 で配置し、接続情報は 0600 の一時ファイル経由で渡して always で削除する', () => {
      const install = apiTasks.find((t) => t['ansible.builtin.copy']?.src === 'zabbix_api.py')
      expect(install?.['ansible.builtin.copy']).toMatchObject({ dest: '/usr/local/lib/ai-support-zabbix-api.py', owner: 'root', group: 'root', mode: '0700' })
      const block = loadTasks('api.yml').find((t) => Array.isArray(t.block)) as Task
      const tempfile = block.block.find((t: Task) => t['ansible.builtin.tempfile'])
      expect(tempfile.register).toBe('zabbix_web_api_credentials')
      const write = block.block.find((t: Task) => t['ansible.builtin.copy']?.dest === '{{ zabbix_web_api_credentials.path }}')
      expect(write['ansible.builtin.copy'].mode).toBe('0600')
      expect(write.diff).toBe(false)
      expect(write.no_log).toBeUndefined()
      expect(write['ansible.builtin.copy'].content).toContain('zabbix_web_admin_password')
      const cleanup = block.always.find((t: Task) => t['ansible.builtin.file'])
      expect(cleanup['ansible.builtin.file']).toEqual({ path: '{{ zabbix_web_api_credentials.path }}', state: 'absent' })
      expect(cleanup.when).toBe('zabbix_web_api_credentials.path is defined')
    })

    it('ヘルパー実行は no_log + ignore_errors で、直後の fail が rc を見てパスワードを含まない診断を出す', () => {
      const block = loadTasks('api.yml').find((t) => Array.isArray(t.block)) as Task
      const runIdx = block.block.findIndex((t: Task) => t.register === 'zabbix_web_api_result')
      const run = block.block[runIdx]
      expect(run['ansible.builtin.command'].argv).toEqual(['/usr/bin/python3', '/usr/local/lib/ai-support-zabbix-api.py', '{{ zabbix_web_api_credentials.path }}'])
      expect(run.no_log).toBe(true)
      expect(run.ignore_errors).toBe(true)
      expect(run.failed_when).toBeUndefined()
      expect(run.changed_when).toBe(`'"changed": true' in zabbix_web_api_result.stdout`)
      const diag = block.block[runIdx + 1]
      expect(diag['ansible.builtin.fail']).toBeDefined()
      expect(diag.no_log).toBeUndefined()
      expect(diag.when).toBe('zabbix_web_api_result.rc | default(1) != 0')
      const msg = String(diag['ansible.builtin.fail'].msg)
      expect(msg).toContain('zabbix_web_api_result.stderr')
      expect(msg).toContain('zabbix_web_admin_previous_password')
      expect(msg).not.toMatch(/\{\{[^}]*zabbix_web_admin_(previous_)?password/)
      expect(msg).not.toMatch(/\{\{[^}]*zabbix_web_api_credentials/)
      // パスワードは argv・環境変数に載せない。
      expect(JSON.stringify(run)).not.toContain('admin_password')
      expect(run.environment).toBeUndefined()
    })
  })

  describe('TimescaleDB（設計書 §4.1）', () => {
    type Task = Record<string, any>
    const opts = { mode: 'resident', targetOs: 'linux' } as const
    const loadTasks = (file = 'main.yml'): Task[] =>
      load(readFileSync(path.join(roleDir, 'zabbix_server/tasks', file), 'utf8')) as Task[]
    const flatten = (tasks: Task[]): Task[] =>
      tasks.flatMap((t) => [t, ...['block', 'rescue', 'always'].flatMap((k) => (Array.isArray(t[k]) ? flatten(t[k]) : []))])
    const main = flatten(loadTasks())
    const ts = flatten(loadTasks('timescaledb.yml'))
    const internalNames = [
      'zabbix_server_db_plan',
      'zabbix_server_pg_major',
      'zabbix_server_pg_ready',
      'zabbix_server_ts_candidates',
      'zabbix_server_ts_installed',
      'zabbix_server_ts_key',
      'zabbix_server_ts_pending',
      'zabbix_server_ts_preload',
      'zabbix_server_ts_version',
    ]
    const RANGE = "'^2\\.(1[3-9]|2[0-8])\\.'"

    it('公開変数 zabbix_server_db_timescaledb をレシピの include_role で渡せ、既定は false', () => {
      const result = validateAnsibleTasks(
        [{
          'ansible.builtin.include_role': { name: 'zabbix_server' },
          vars: { zabbix_server_db_password: '{{ ZABBIX_DB_PASSWORD }}', zabbix_server_db_timescaledb: true },
        }],
        opts,
      )
      expect(result.ok).toBe(true)
      expect(INCLUDE_ROLE_ALLOWED_VARS.zabbix_server.has('zabbix_server_db_timescaledb')).toBe(true)
      const d = load(readFileSync(path.join(roleDir, 'zabbix_server/defaults/main.yml'), 'utf8')) as Record<string, unknown>
      expect(d.zabbix_server_db_timescaledb).toBe(false)
    })

    it('先頭の Validate assert に boolean・PostgreSQL 限定の検証が統合されている（fail_msg に {{ }} なし）', () => {
      const first = loadTasks()[0]
      expect(first.when).toBeUndefined()
      const args = first['ansible.builtin.assert'] as { that: string[]; fail_msg: string }
      expect(args.that).toContain('zabbix_server_db_timescaledb is boolean')
      expect(args.that).toContain("not zabbix_server_db_timescaledb or zabbix_server_db_type == 'postgresql'")
      expect(args.fail_msg).toContain('zabbix_server_db_timescaledb')
      expect(args.fail_msg).not.toContain('{{')
    })

    it.each(internalNames)('%s はレシピから上書き・参照・書き込みできない', (name) => {
      expect(validateAnsibleTasks([{ 'ansible.builtin.include_role': { name: 'zabbix_server' }, vars: { [name]: 'x' } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.debug': { msg: `{{ ${name} }}` } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.set_fact': { [name]: 'fake' } }], opts).ok).toBe(false)
      expect(validateAnsibleTasks([{ 'ansible.builtin.command': 'true', register: name }], opts).ok).toBe(false)
    })

    it('ロール内で実際に使う内部名がテストの一覧と一致する', () => {
      const names = new Set<string>()
      for (const t of [...main, ...ts]) {
        const candidates = [
          ...(typeof t.register === 'string' ? [t.register] : []),
          ...Object.keys(t['ansible.builtin.set_fact'] ?? {}),
        ]
        for (const n of candidates) if (/^zabbix_server_(db_plan|pg_|ts_)/.test(n)) names.add(n)
      }
      // timescaledb.yml の register / set_fact はすべてこの一覧に載っていること（取りこぼし防止）。
      for (const t of ts) {
        if (typeof t.register === 'string') expect(internalNames).toContain(t.register)
        for (const k of Object.keys(t['ansible.builtin.set_fact'] ?? {})) expect(internalNames).toContain(k)
      }
      expect([...names].sort()).toEqual([...internalNames].sort())
    })

    it('`database.py --plan` は no_log + ignore_errors で、直後の fail が rc を見て診断し、include_tasks: timescaledb.yml より前にある', () => {
      const block = loadTasks().find((t) => Array.isArray(t.block) && /Initialize and verify the database/.test(t.name)) as Task
      const tasks = block.block as Task[]
      const planIdx = tasks.findIndex((t) => t.register === 'zabbix_server_db_plan')
      const includeIdx = tasks.findIndex((t) => t['ansible.builtin.include_tasks'] === 'timescaledb.yml')
      const importIdx = tasks.findIndex((t) => t.register === 'zabbix_server_db_result')
      expect(planIdx).toBeGreaterThanOrEqual(0)
      expect(includeIdx).toBeGreaterThan(planIdx)
      expect(importIdx).toBeGreaterThan(includeIdx)
      const plan = tasks[planIdx]
      expect(plan['ansible.builtin.command'].argv).toEqual([
        '/usr/bin/python3', '/usr/local/lib/ai-support-zabbix-database.py', '{{ zabbix_server_db_credentials.path }}', '--plan',
      ])
      expect(plan.no_log).toBe(true)
      expect(plan.ignore_errors).toBe(true)
      expect(plan.changed_when).toBe(false)
      const diag = tasks[planIdx + 1]
      expect(diag['ansible.builtin.fail']).toBeDefined()
      expect(diag.no_log).toBeUndefined()
      expect(diag.when).toEqual(["zabbix_server_db_type == 'postgresql'", 'zabbix_server_db_plan.rc | default(1) != 0'])
      expect(tasks[includeIdx].when).toEqual(["zabbix_server_db_mode == 'local'", 'zabbix_server_db_timescaledb'])
      // include_tasks は local のときだけ。external では DB サーバーに触れない。
      const write = tasks.find((t) => t['ansible.builtin.copy']?.dest === '{{ zabbix_server_db_credentials.path }}') as Task
      expect(write['ansible.builtin.copy'].content).toContain("'timescaledb': zabbix_server_db_timescaledb")
    })

    it('Timescale リポジトリの URL と鍵指紋はタスク内リテラルで、鍵指紋を assert で照合してからリポジトリを追加する', () => {
      const getUrl = ts.find((t) => t['ansible.builtin.get_url']) as Task
      expect(getUrl['ansible.builtin.get_url']).toMatchObject({
        url: 'https://packagecloud.io/timescale/timescaledb/gpgkey',
        dest: '/etc/apt/keyrings/timescaledb.asc',
      })
      const keyCheck = ts.find((t) => t.name === 'zabbix_server : Require the pinned Timescale repository key') as Task
      const that = (keyCheck['ansible.builtin.assert'].that as string[]).join('\n')
      expect(that).toContain('1005FB68604CE9B8F6879CF759F18EDF47F24417')
      expect(that).toContain('0641009A8366FDE4444A7B62E7391C94080429FF')
      expect(that).toContain('zabbix_server_ts_key.stdout_lines')
      expect(that).not.toMatch(/\{\{/)
      const repo = ts.find((t) => t['ansible.builtin.copy']?.dest === '/etc/apt/sources.list.d/timescaledb.sources') as Task
      const content = String(repo['ansible.builtin.copy'].content)
      expect(content).toContain('URIs: https://packagecloud.io/timescale/timescaledb/ubuntu/\n')
      expect(content).toContain('Signed-By: /etc/apt/keyrings/timescaledb.asc')
      // URL・指紋に変数を使わない（レシピの task vars で差し替えられないように）。
      expect(content.split('\n').find((l) => l.startsWith('URIs:'))).not.toContain('{{')
      expect(ts.indexOf(keyCheck)).toBeLessThan(ts.indexOf(repo))
      expect(ts.indexOf(getUrl)).toBeLessThan(ts.indexOf(keyCheck))
    })

    it('版の範囲はロール内リテラルで、導入済みの版を優先し、選んだ版を apt pin（1001）で固定する', () => {
      const select = ts.find((t) => t['ansible.builtin.set_fact']?.zabbix_server_ts_version) as Task
      const expr = String(select['ansible.builtin.set_fact'].zabbix_server_ts_version)
      expect(expr).toContain(RANGE)
      expect(expr).toContain('zabbix_server_ts_installed.stdout')
      expect(expr).toContain("'~ubuntu' ~ (ansible_distribution_version | regex_escape)")
      const check = ts.find((t) => /Require a TimescaleDB version/.test(t.name)) as Task
      expect(check['ansible.builtin.assert'].that).toEqual([`zabbix_server_ts_version is match(${RANGE})`])
      const pin = ts.find((t) => t['ansible.builtin.copy']?.dest === '/etc/apt/preferences.d/ai-support-timescaledb') as Task
      const pinText = String(pin['ansible.builtin.copy'].content)
      expect(pinText).toContain('Pin: version {{ zabbix_server_ts_version }}')
      expect(pinText).toContain('Pin-Priority: 1001')
      expect(pinText).toMatch(/^Package: timescaledb-2-postgresql-.+ timescaledb-2-loader-postgresql-.+$/m)
      const install = ts.find((t) => Array.isArray(t['ansible.builtin.apt']?.name)) as Task
      expect(install['ansible.builtin.apt'].name.every((n: string) => n.endsWith('={{ zabbix_server_ts_version }}'))).toBe(true)
      expect(ts.indexOf(pin)).toBeLessThan(ts.indexOf(install))
      // 版はロール変数にしない。
      const defaults = readFileSync(path.join(roleDir, 'zabbix_server/defaults/main.yml'), 'utf8')
      expect(defaults).not.toMatch(/^zabbix_server_.*(timescaledb_version|ts_version)/m)
    })

    it('shared_preload_libraries は postgresql_set で既存値と合流し、conf.d への copy / lineinfile を使わない', () => {
      const preload = ts.find((t) => t['community.postgresql.postgresql_set']?.name === 'shared_preload_libraries') as Task
      expect(preload).toBeDefined()
      expect(preload.become_user).toBe('postgres')
      expect(preload.register).toBe('zabbix_server_ts_pending')
      const value = String(preload['community.postgresql.postgresql_set'].value)
      expect(value).toContain('zabbix_server_ts_preload.stdout')
      expect(value).toContain("+ ['timescaledb']")
      expect(value).toContain("join(', ')")
      expect(JSON.stringify(ts)).not.toMatch(/conf\.d|postgresql\.conf"|lineinfile/)
      const telemetry = ts.find((t) => t['community.postgresql.postgresql_set']?.name === 'timescaledb.telemetry_level') as Task
      expect(telemetry['community.postgresql.postgresql_set'].value).toBe('off')
      // GUC は拡張のある DB でしか存在しないため、Zabbix DB に接続して設定する。
      expect(telemetry['community.postgresql.postgresql_set'].login_db).toBe('{{ zabbix_server_db_name }}')
      // 再起動は preload の変更があったときだけ、その場で行い、pg_isready で待つ。
      const restart = ts.find((t) => t['ansible.builtin.service']?.state === 'restarted') as Task
      expect(restart.when).toBe('zabbix_server_ts_pending.changed')
      const ready = ts.find((t) => t.register === 'zabbix_server_pg_ready') as Task
      expect(ready['ansible.builtin.command'].argv).toEqual(['pg_isready', '-q'])
      expect(ready.until).toBe('zabbix_server_pg_ready.rc == 0')
      const readyFail = ts.find((t) => t['ansible.builtin.fail'] && JSON.stringify(t.when ?? '').includes('zabbix_server_pg_ready.rc')) as Task
      expect(readyFail).toBeDefined()
      // 再起動 → 待機 → 拡張の作成 → telemetry off の順（telemetry の GUC は拡張の作成後にしか無い）。
      const ext = ts.find((t) => t['community.postgresql.postgresql_ext']) as Task
      expect(ts.indexOf(preload)).toBeLessThan(ts.indexOf(restart))
      expect(ts.indexOf(restart)).toBeLessThan(ts.indexOf(ready))
      expect(ts.indexOf(ready)).toBeLessThan(ts.indexOf(ext))
      expect(ts.indexOf(ext)).toBeLessThan(ts.indexOf(telemetry))
    })

    it('postgresql_ext は become_user: postgres で、空 DB（と TimescaleDB 投入だけ失敗した DB）のときだけ作る', () => {
      const ext = ts.find((t) => t['community.postgresql.postgresql_ext']) as Task
      expect(ext.become_user).toBe('postgres')
      expect(ext['community.postgresql.postgresql_ext']).toEqual({
        name: 'timescaledb', login_db: '{{ zabbix_server_db_name }}', schema: 'public', cascade: true,
      })
      expect(ext.when).toBe("(zabbix_server_db_plan.stdout | from_json).state in ['empty', 'timescaledb_pending']")
    })

    it('PostgreSQL メジャーを Ubuntu 同梱版（22.04→14 / 24.04→16）と照合する', () => {
      const check = ts.find((t) => /Require the PostgreSQL major version/.test(t.name)) as Task
      const that = (check['ansible.builtin.assert'].that as string[]).join('\n')
      expect(that).toContain("(14 if ansible_distribution_version == '22.04' else 16)")
      expect(ts.indexOf(check)).toBeLessThan(ts.findIndex((t) => t['ansible.builtin.get_url']))
    })

    it('AllowUnsupportedDBVersions を設定せず、ready.py の診断で TimescaleDB の版を案内する', () => {
      const server = loadTasks().find((t) => t['ansible.builtin.copy']?.dest === '/etc/zabbix/zabbix_server.conf') as Task
      expect(String(server['ansible.builtin.copy'].content)).not.toContain('AllowUnsupportedDBVersions')
      const ready = readFileSync(path.join(roleDir, 'zabbix_server/files/ready.py'), 'utf8')
      expect(ready).toContain('unsupported TimescaleDB version')
      const helper = readFileSync(path.join(roleDir, 'zabbix_server/files/database.py'), 'utf8')
      expect(helper).toContain("'--plan' in sys.argv[2:]")
      expect(helper).toContain("TIMESCALE_MARKER = '_ai_support_zabbix_timescaledb_pending'")
    })
  })
})
