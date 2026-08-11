import { readFileSync } from 'fs'
import { join, relative } from 'path'

import { sync as globSync } from 'glob'
import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * bundled role の `assert` タスクが設定ミスの案内を出せることを保証する回帰テスト。
 *
 * 回帰対象のバグ: `k3s : Validate k3s_token is set`（cluster.yml）は
 * 「k3s_token is required ... Reference an ANSIBLE# secret variable, e.g. ...」という
 * 案内を fail_msg に持つが、タスクに `no_log: true` が付いていたため、実行結果が
 *   "the output has been hidden due to the fact that 'no_log: true' was specified"
 * に置き換わり、**案内が丸ごと隠されていた**（実測で確認）。変数名を間違えた利用者は
 * 「Validate k3s_token is set failed」しか見えず、原因に辿り着けない。
 *
 * 固定する不変条件: **`loop` を持たない `assert` タスクに `no_log` を付けない。**
 * ループなしの `assert` の失敗出力に含まれるのは評価式の文字列と静的な msg だけで、変数の
 * 「値」は出力されない（`k3s_version` の assert が no_log なしで運用され値を漏らしていない
 * のが実例）。したがってこの場合の `no_log` は秘匿に寄与せず、案内を消すだけである。
 * 秘匿値を出したくない場合に正しい対処は「fail_msg / that に値を展開しないこと」であり、
 * タスクごと隠すことではない。
 *
 * `loop` を持つ `assert` は例外として `no_log` を許す。ループ付きタスクの結果には
 * `item` そのものが出力されるため（実測: トークンを含む item が平文で出力された）、
 * item が秘匿値を含む場合は `no_log` が実際に秘匿として機能している。
 */
const ROLES_DIR = join(__dirname, '../../ansible/roles')

interface AssertArgs {
  that?: unknown
  fail_msg?: string
  success_msg?: string
}

interface AnsibleTask {
  name?: string
  no_log?: boolean
  loop?: unknown
  block?: AnsibleTask[]
  rescue?: AnsibleTask[]
  always?: AnsibleTask[]
  [key: string]: unknown
}

/** assert モジュールの綴り（FQCN・短縮形・legacy）。どれで書かれても検出する。 */
const ASSERT_KEYS = ['ansible.builtin.assert', 'assert', 'ansible.legacy.assert'] as const

function assertArgsOf(task: AnsibleTask): AssertArgs | undefined {
  for (const key of ASSERT_KEYS) {
    const args = task[key]
    if (args !== undefined) return (args ?? {}) as AssertArgs
  }
  return undefined
}

/**
 * `no_log` を許す loop 付き assert の allowlist（task 名）。
 * ループ結果には `item` が出力されるため item が秘匿値を含む場合のみ `no_log` が正当化される。
 * ここに載っていない loop 付き assert が `no_log` を付けたら、それは案内を隠しているだけの
 * 可能性が高いので、追加時に「item が本当に秘匿値を含むか」を必ず判断させる。
 */
const LOOPED_NO_LOG_ALLOWLIST: ReadonlySet<string> = new Set([
  // 現在は該当なし。ai_support_agent のトークン空チェックはループをやめて project_code を
  // 集計する方式にしたため no_log 不要になった。ここに足す場合は「item が本当に秘匿値を
  // 含むか」「案内を隠してでも隠すべき値か」を必ず judge すること。
])

/** block/rescue/always にネストしたタスクも含めて平坦化する。 */
function flatten(tasks: unknown): AnsibleTask[] {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as AnsibleTask
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

interface LocatedTask {
  file: string
  task: AnsibleTask
}

function allRoleTasks(): LocatedTask[] {
  // tasks/ 直下だけ・.yml だけに絞ると、サブディレクトリや .yaml のタスクを取りこぼす。
  const files = globSync('**/tasks/**/*.{yml,yaml}', { cwd: ROLES_DIR, absolute: true })
  expect(files.length).toBeGreaterThan(0) // ロール構成が変わって 0 件になったら気づけるように
  return files.flatMap((file) =>
    flatten(load(readFileSync(file, 'utf8'), { schema: DEFAULT_SCHEMA })).map((task) => ({
      file: relative(ROLES_DIR, file),
      task,
    })),
  )
}

/**
 * Jinja のブレースエスケープ（`{{ '{{' }}` / `{{ '}}' }}`）を取り除く。
 * これは変数展開ではなく「二重波括弧そのものを出力する」ための書き方なので、
 * 値の展開検出では無視する必要がある。
 */
function stripBraceEscapes(text: string): string {
  return text.replace(/\{\{\s*'\{\{'\s*\}\}/g, '').replace(/\{\{\s*'\}\}'\s*\}\}/g, '')
}

describe('bundled roles: assert タスクは設定ミスの案内を隠さない', () => {
  const tasks = allRoleTasks()
  const asserts = tasks
    .map(({ file, task }) => ({ file, task, args: assertArgsOf(task) }))
    .filter((t): t is { file: string; task: AnsibleTask; args: AssertArgs } => t.args !== undefined)

  it('前提: 検証対象の assert タスクが存在する（走査が空振りしていない）', () => {
    expect(asserts.length).toBeGreaterThan(0)
  })

  it('loop を持たない assert に no_log が付いていない（fail_msg が censored にならない）', () => {
    const hidden = asserts
      .filter(({ task }) => task.no_log === true && task.loop === undefined)
      .map(({ file, task }) => `${file}: ${task.name ?? '(no name)'}`)
    expect(hidden).toEqual([])
  })

  it('no_log を許すのは allowlist に載せた loop 付き assert だけ', () => {
    // 「loop なら無条件に no_log 可」にすると、item が秘匿値を含まないループ assert が
    // 不要な no_log で案内を隠しても素通りする。既知の1件だけを明示的に許す。
    const exempt = asserts
      .filter(({ task }) => task.no_log === true)
      .map(({ file, task }) => `${file}: ${task.name ?? '(no name)'}`)
    const allowed = asserts
      .filter(({ task }) => task.no_log === true && task.loop !== undefined)
      .filter(({ task }) => LOOPED_NO_LOG_ALLOWLIST.has(task.name ?? ''))
      .map(({ file, task }) => `${file}: ${task.name ?? '(no name)'}`)
    expect(exempt).toEqual(allowed)
  })

  describe.each([
    {
      taskName: 'k3s : Validate k3s_token is set',
      expectedInFailMsg: ['k3s_token is required', 'ANSIBLE#'],
    },
    {
      taskName: 'k3s : Validate etcd-S3 options when enabled',
      expectedInFailMsg: ['k3s_etcd_s3_bucket', 'ANSIBLE#'],
    },
  ])('$taskName', ({ taskName, expectedInFailMsg }) => {
    const target = asserts.find(({ task }) => (task.name ?? '') === taskName)

    it('存在し、no_log で隠されていない', () => {
      expect(target).toBeDefined()
      expect(target?.task.no_log).toBeUndefined()
    })

    it('設定方法を案内する fail_msg を持つ', () => {
      // no_log を外すだけでなく、案内文そのものが失われていないことも固定する。
      const failMsg = target?.args.fail_msg ?? ''
      for (const fragment of expectedInFailMsg) {
        expect(failMsg).toContain(fragment)
      }
    })

    it('メッセージと条件に変数の値を展開しない（no_log なしで値が漏れないこと）', () => {
      // no_log を外した以上、これらのタスクが秘匿値を出力に載せてはならない。
      // 将来 fail_msg に `{{ k3s_token }}` 等を足す変更をここで止める。
      const texts = [
        target?.args.fail_msg ?? '',
        target?.args.success_msg ?? '',
        ...(Array.isArray(target?.args.that) ? target.args.that.map(String) : []),
      ]
      for (const text of texts) {
        expect(stripBraceEscapes(text)).not.toContain('{{')
      }
    })
  })
})
