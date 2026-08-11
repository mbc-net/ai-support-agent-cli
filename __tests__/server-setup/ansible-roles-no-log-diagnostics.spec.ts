import { readFileSync } from 'fs'
import { join, relative } from 'path'

import { sync as globSync } from 'glob'
import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `no_log` を付けたタスクの失敗理由が運用者に届くことを保証する回帰テスト。
 *
 * 回帰対象のバグ: `no_log: true` のタスクが失敗すると、Ansible は結果全体を
 * `{"failed": true, "censored": "the output has been hidden ..."}` に置き換える。
 * **`msg` キー自体が消える**ため、`server-setup-runner.ts` の `taskResultFrom` は
 * `${name} failed` にフォールバックし、運用者には task 名しか届かない（k3s の
 * `Validate k3s_token is set` がこれで原因不明の失敗になった実績がある）。
 *
 * 既存ロールが確立している対処は「`register` を付けてプレイを止めずに完走させ、直後の
 * **no_log でない** `fail`/`assert` が登録結果（`.rc`・`.failed` 等、秘匿値を含まない情報）を
 * 検査して失敗を表面化する」パターンである（`codex` / `gitlab_runner` / `github_runner` /
 * `tailscale` / `k3s` のインストール・認証タスクが実例）。
 *
 * 完走のさせ方はタスク種別で決まる。`shell`/`command` は `failed_when: false` にして生の
 * `.rc` を見る。`.rc` を持たない Python モジュールは **`ignore_errors: true`** を使う
 * （`failed_when: false` は成否判定を強制的に false にし、それが register にも入るため
 * `.failed` が常に False になり、診断が一度も発火しない死んだコードになる。実測で確認）。
 *
 * 固定する不変条件:
 *   1. `no_log` タスク（`set_fact` を除く）は `register` と完走指定を持ち、同ファイル内の
 *      no_log でない `fail`/`assert` が、その失敗を実際にゲートして停止すること
 *   2. `failed_when: false` のタスクを `.failed`/`.changed` で診断していないこと
 *   3. 例外は下記 KNOWN_UNSURFACED_TASKS のみ。**この一覧は増やさない**
 *      （増えた分だけ「原因の分からない失敗」が増える）
 */
const ROLES_DIR = join(__dirname, '../../ansible/roles')

interface AnsibleTask {
  name?: string
  no_log?: boolean
  register?: string
  failed_when?: unknown
  ignore_errors?: boolean
  when?: unknown
  vars?: unknown
  block?: AnsibleTask[]
  rescue?: AnsibleTask[]
  always?: AnsibleTask[]
  [key: string]: unknown
}

/**
 * まだ失敗理由を表面化していない既知のタスク（ベースライン）。
 *
 * いずれも秘匿値を 0600 の一時ファイルへ書く `copy` タスクで、失敗は権限・パス・
 * ディスク等の環境要因に限られる。実行時のリスクが低いため今回の修正対象からは
 * 外しているが、**新しい no_log タスクをここに足してはならない**。手当てを入れて
 * この一覧から消すことはよいことで、その場合は本テストがそれを検出して落ちる
 * （そのときは一覧から行を削除する）。
 */
const KNOWN_UNSURFACED_TASKS: readonly string[] = [
  'ai_support_agent : Write each token into its own temp file',
  'claude_cli : Persist ANTHROPIC_API_KEY for systemd --user services',
  'claude_cli : Persist CLAUDE_CODE_OAUTH_TOKEN for systemd --user services',
  'codex : Write the API key into its temp file',
  'codex : Write the OAuth access token into its temp file',
  'github_runner : Write the minted registration token to its temp file (PAT flow)',
  'github_runner : Write the supplied registration token to its temp file (direct flow)',
  'gitlab_runner : Write the token into its temp file',
  'k3s : Write etcd-S3 credentials drop-in (0600, secret)',
  'tailscale : Write the auth key to its 0600 temp file',
]

/** 失敗しても運用者への診断が要らないモジュール（ローカルの変数計算のみ）。 */
const DIAGNOSIS_EXEMPT_MODULES = ['ansible.builtin.set_fact']

function flatten(tasks: unknown): AnsibleTask[] {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as AnsibleTask
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

interface RoleFile {
  file: string
  tasks: AnsibleTask[]
}

function roleFiles(): RoleFile[] {
  const files = globSync('**/tasks/**/*.{yml,yaml}', { cwd: ROLES_DIR, absolute: true })
  expect(files.length).toBeGreaterThan(0)
  return files.map((file) => ({
    file: relative(ROLES_DIR, file),
    tasks: flatten(load(readFileSync(file, 'utf8'), { schema: DEFAULT_SCHEMA })),
  }))
}

/** register を参照している、同ファイル内の no_log でないタスク。 */
function consumersOf(task: AnsibleTask, siblings: AnsibleTask[]): AnsibleTask[] {
  if (!task.register) return []
  return siblings.filter(
    (other) =>
      other !== task &&
      other.no_log !== true &&
      JSON.stringify(other).includes(task.register as string),
  )
}

/**
 * `failed_when: false` を付けたタスクの register は `.failed` / `.changed` が信用できない。
 *
 * `failed_when: false` は「このタスクの成否判定を常に false にする」機能で、その判定結果が
 * そのまま register にも入る。実測: 失敗するモジュールを `failed_when: false` で登録すると
 * `.failed` は **False**（`ignore_errors: true` なら True）。したがって `failed_when: false`
 * のタスクに対して `when: <reg>.failed` で診断する実装は**一度も発火しない死んだコード**になる。
 * 既存の shell タスクはこれを避けて生の `.rc` を見ている。
 */
function usesUnreliableVerdict(task: AnsibleTask, consumers: AnsibleTask[]): boolean {
  if (task.failed_when !== false) return false
  const reg = task.register as string
  return consumers.some((c) => {
    const cond = JSON.stringify(c.when ?? '')
    return cond.includes(`${reg}.failed`) || cond.includes(`${reg}.changed`)
  })
}

/** 失敗を表す result のフィールド。ロールによって使うものが違う。 */
const FAILURE_INDICATORS = ['rc', 'failed', 'changed', 'status']

/** プレイを止められるモジュール（「診断した」と言えるのはこれらだけ）。 */
const HALTING_MODULES = ['ansible.builtin.fail', 'ansible.builtin.assert', 'fail', 'assert']

/**
 * register から派生した変数名。診断が register を直接見ず、いったん集約した中間変数で
 * ゲートする実装があるため（`gitlab_runner_register_rc` は診断タスク自身の `vars:` で、
 * `ai_support_agent_failed_items` も同様に `vars:` で `.results` を畳んでいる）、
 * `set_fact` と **タスクの `vars:`** の両方から 1 ホップを追う。
 */
function derivedVarsOf(register: string, siblings: AnsibleTask[]): string[] {
  const fromMapping = (mapping: unknown): string[] =>
    typeof mapping === 'object' && mapping !== null
      ? Object.entries(mapping as Record<string, unknown>)
          .filter(([, value]) => JSON.stringify(value).includes(register))
          .map(([name]) => name)
      : []
  return siblings.flatMap((t) => [
    ...fromMapping(t['ansible.builtin.set_fact']),
    ...fromMapping(t.vars),
  ])
}

/**
 * 失敗理由が表面化されるか。
 *
 * register があるだけでは足りない。「プレイを止めずに診断へ進む指定」があり、かつ
 * **失敗をゲートしてプレイを止める**タスクが存在することまで要求する。register 名に
 * 触れているだけのタスク（無条件の debug など）を「診断」と数えてしまうと、今回混入した
 * 「発火しない診断」と同種の退行をこのテストが素通しにしてしまう。
 */
function isSurfaced(task: AnsibleTask, siblings: AnsibleTask[]): boolean {
  if (!task.register) return false
  const continues = task.failed_when === false || task.ignore_errors === true
  if (!continues) return false
  const consumers = consumersOf(task, siblings)
  if (consumers.length === 0) return false
  if (usesUnreliableVerdict(task, consumers)) return false

  const register = task.register
  const derived = derivedVarsOf(register, siblings)
  return consumers.some((c) => {
    if (!HALTING_MODULES.some((m) => c[m] !== undefined)) return false
    const cond = JSON.stringify(c.when ?? '')
    if (cond === '""') return false
    const gatesOnRegister =
      cond.includes(register) && FAILURE_INDICATORS.some((f) => cond.includes(f))
    const gatesOnDerived = derived.some((name) => cond.includes(name))
    return gatesOnRegister || gatesOnDerived
  })
}

function moduleKeyOf(task: AnsibleTask): string {
  return (
    Object.keys(task).find((k) => k.startsWith('ansible.') || k.startsWith('community.')) ?? '?'
  )
}

describe('bundled roles: no_log タスクの失敗理由が表面化される', () => {
  const files = roleFiles()
  const noLogTasks = files.flatMap(({ file, tasks }) =>
    tasks
      .filter((t) => t.no_log === true)
      .map((task) => ({ file, task, siblings: tasks, name: task.name ?? '(no name)' })),
  )

  it('前提: no_log タスクが検出されている（走査が空振りしていない）', () => {
    expect(noLogTasks.length).toBeGreaterThan(0)
  })

  it('no_log タスクは失敗理由を表面化する（既知の未対応分を除く）', () => {
    const unsurfaced = noLogTasks
      .filter(({ task }) => !DIAGNOSIS_EXEMPT_MODULES.includes(moduleKeyOf(task)))
      .filter(({ task, siblings }) => !isSurfaced(task, siblings))
      .map(({ name }) => name)
      .filter((name) => !KNOWN_UNSURFACED_TASKS.includes(name))
    expect(unsurfaced).toEqual([])
  })

  it('既知の未対応一覧は増えていない（載せたまま放置しないための歯止め）', () => {
    // 一覧に載っているタスクが手当て済みになった／消えた場合もここで気づけるように、
    // 「一覧の各行が実在し、かつ今なお未対応であること」を要求する。
    const stillUnsurfaced = noLogTasks
      .filter(({ task, siblings }) => !isSurfaced(task, siblings))
      .map(({ name }) => name)
    expect([...KNOWN_UNSURFACED_TASKS].sort()).toEqual(
      KNOWN_UNSURFACED_TASKS.filter((n) => stillUnsurfaced.includes(n)).sort(),
    )
  })

  describe.each([
    'database : Set MySQL root password',
    'database : Set PostgreSQL postgres user password',
  ])('%s', (taskName) => {
    it('register + ignore_errors を持ち、no_log でないタスクが失敗を表面化する', () => {
      const found = noLogTasks.find(({ name }) => name === taskName)
      expect(found).toBeDefined()
      expect(found?.task.register).toBeTruthy()
      // Python モジュールには `.rc` が無いので、判定は register の `.failed` に頼る。
      // `failed_when: false` だと `.failed` が常に false になり診断が死ぬため、
      // ここは必ず `ignore_errors: true` でなければならない。
      expect(found?.task.ignore_errors).toBe(true)
      expect(found?.task.failed_when).toBeUndefined()
      expect(isSurfaced(found!.task, found!.siblings)).toBe(true)
    })

    it('診断タスクの when が register の .failed を見ている', () => {
      const found = noLogTasks.find(({ name }) => name === taskName)
      const consumers = consumersOf(found!.task, found!.siblings)
      expect(consumers.length).toBeGreaterThan(0)
      const conds = consumers.map((c) => JSON.stringify(c.when ?? ''))
      expect(conds.some((c) => c.includes(`${found!.task.register}.failed`))).toBe(true)
    })
  })

  it('failed_when: false のタスクを .failed / .changed で診断していない（死んだ診断の防止）', () => {
    // 実測: `failed_when: false` を付けた失敗タスクの register は `.failed == False`。
    // この組み合わせは「診断タスクが一度も発火せず、失敗が成功として完走する」退行を生む。
    const dead = noLogTasks
      .filter(({ task, siblings }) => usesUnreliableVerdict(task, consumersOf(task, siblings)))
      .map(({ name }) => name)
    expect(dead).toEqual([])
  })

  it('ai_support_agent のトークン検証は no_log なしで案内を出せる', () => {
    // ループ付き assert は item（＝トークン）を出力するため no_log が必要だったが、
    // no_log を付けると案内ごと消える。ループをやめて集計判定にすることで、
    // トークンを出力せずに「どの project_code が空か」を案内できる。
    const validate = files
      .flatMap(({ tasks }) => tasks)
      .find((t) => (t.name ?? '').includes('Validate every token list entry has a non-empty token'))
    expect(validate).toBeDefined()
    expect(validate?.no_log).toBeUndefined()
    expect(validate?.loop).toBeUndefined()
    const failMsg = String(
      (validate?.['ansible.builtin.assert'] as { fail_msg?: string } | undefined)?.fail_msg ?? '',
    )
    // 空トークンのエントリを project_code で名指しする（token 自体は出さない）
    expect(failMsg).toContain('project_code')
    expect(failMsg).not.toContain('.token')
  })
})
