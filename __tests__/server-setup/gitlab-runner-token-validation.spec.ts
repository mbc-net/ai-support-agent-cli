import { readFileSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * GitLab Runner 系 bundled role（`gitlab_runner` / `gitlab_runner_k8s`）が、
 * **トークンの形式を実行前に検証する**ことを固定する回帰テスト。
 *
 * 回帰対象のバグ: 両ロールは URL・オブジェクト名・チャートバージョン・レプリカ数・
 * ジョブイメージ・各種パスをすべてアンカー付き正規表現の assert で検証しているのに、
 * **トークンの値だけは一切検証していなかった**。トークンは検証されないまま Secret /
 * register コマンドへ渡るため、任意の文字列が通過し、GitLab の API が 403 を返して
 * 初めて誤りが判明する。それは Helm 適用と Pod 起動の後であり、原因の分かりにくい
 * 失敗になる。
 *
 * 実際に発生した誤設定（いずれも実環境で観測）:
 *   1. `glpat-…` — アクセストークン（個人用/プロジェクト用）を Runner 認証トークンと
 *      取り違えた。GitLab はどちらも `glpat-` 接頭辞のため混同しやすい。
 *   2. `gitlab-runner register  --url https://gitlab.com  --token glrt-…` — Runner 作成
 *      画面に表示される登録コマンド全文をそのまま貼り付けた。
 * どちらも 403 Forbidden → 30回の登録試行 → CrashLoopBackOff となり、判明までに
 * 14時間・188回の再起動を要した。
 *
 * 固定する不変条件:
 *   1. 認証トークンは `^glrt-` のアンカー付き正規表現で検証される
 *   2. 検証は `| trim` 後の値に対して行う（末尾改行だけで落とさないため。ロール自身も
 *      trim 後の値を書き出す）
 *   3. 旧登録トークンは空白を含まないことを検証する（接頭辞は世代により異なるため
 *      強制できないが、コマンド全文の貼り付けは空白で捕捉できる）
 *   4. `fail_msg` / `success_msg` にトークン変数を展開しない（失敗出力への値の漏洩防止）
 *   5. トークン検証は副作用を持つどのタスクよりも先に実行される（fail fast。パッケージ
 *      導入やクラスタへの適用を始める前に落とす）
 */
const ROLES = [
  { role: 'gitlab_runner', prefix: 'gitlab_runner' },
  { role: 'gitlab_runner_k8s', prefix: 'gitlab_runner_k8s' },
] as const

const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')

interface AnsibleTask {
  name?: string
  block?: AnsibleTask[]
  rescue?: AnsibleTask[]
  always?: AnsibleTask[]
  [key: string]: unknown
}

const readTasks = (role: string): string =>
  readFileSync(path.join(rolesDir, role, 'tasks', 'main.yml'), 'utf8')

/** block/rescue/always を展開してタスクを平坦化する（記述順を保つ）。 */
const flatten = (tasks: unknown): AnsibleTask[] => {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as AnsibleTask
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

const parseTasks = (role: string): AnsibleTask[] =>
  flatten(load(readTasks(role), { schema: DEFAULT_SCHEMA }))

const moduleArgs = (task: AnsibleTask, module: string): unknown =>
  task[`ansible.builtin.${module}`] ?? task[module]

interface AssertArgs {
  that?: unknown
  fail_msg?: unknown
  success_msg?: unknown
}

const assertArgs = (task: AnsibleTask): AssertArgs | undefined => {
  const args = moduleArgs(task, 'assert')
  if (typeof args !== 'object' || args === null) return undefined
  return args as AssertArgs
}

/** assert の `that` を1本の文字列に連結する（配列・単一文字列の両形式に対応）。 */
const thatText = (args: AssertArgs): string => {
  const that = args.that
  if (typeof that === 'string') return that
  if (Array.isArray(that)) return that.map((t) => String(t)).join('\n')
  return ''
}

/**
 * 副作用を持つ（＝トークン検証より後に実行されなければならない）モジュール。
 * 読み取りのみの probe（`stat` / `command -v`）も含める。検証は「何かを始める前」に
 * 終わっているべきで、そこを緩めると fail fast の意味が薄れるため。
 */
const SIDE_EFFECT_MODULES = [
  'shell',
  'command',
  'stat',
  'file',
  'tempfile',
  'copy',
  'apt',
  'apt_repository',
  'get_url',
  'systemd',
]

const hasSideEffect = (task: AnsibleTask): boolean =>
  SIDE_EFFECT_MODULES.some((m) => moduleArgs(task, m) !== undefined)

describe('GitLab Runner bundled roles のトークン形式検証（gitlab_runner / gitlab_runner_k8s）', () => {
  it.each(ROLES)(
    '$role は認証トークンを ^glrt- のアンカー付き正規表現で検証する',
    ({ role, prefix }) => {
      const authVar = `${prefix}_auth_token`
      const validators = parseTasks(role)
        .map(assertArgs)
        .filter((a): a is AssertArgs => a !== undefined)
        .map(thatText)
        .filter((text) => text.includes(authVar))

      expect(validators.length).toBeGreaterThan(0)

      // 形式を縛る assert が1つ以上あること（排他チェックだけでは不十分）。
      const formatChecks = validators.filter((text) => /\^glrt-/.test(text))
      expect(formatChecks.length).toBeGreaterThan(0)
    },
  )

  it.each(ROLES)(
    '$role の認証トークン検証は | trim 後の値に対して行う（末尾改行だけで落とさない）',
    ({ role, prefix }) => {
      const authVar = `${prefix}_auth_token`
      const formatChecks = parseTasks(role)
        .map(assertArgs)
        .filter((a): a is AssertArgs => a !== undefined)
        .map(thatText)
        .filter((text) => text.includes(authVar) && /\^glrt-/.test(text))

      expect(formatChecks.length).toBeGreaterThan(0)
      for (const text of formatChecks) {
        expect(text).toMatch(/trim/)
      }
    },
  )

  it.each(ROLES)(
    '$role は旧登録トークンが空白を含まないことを検証する（コマンド全文の貼り付けを捕捉）',
    ({ role, prefix }) => {
      const regVar = `${prefix}_registration_token`
      const checks = parseTasks(role)
        .map(assertArgs)
        .filter((a): a is AssertArgs => a !== undefined)
        .map(thatText)
        .filter((text) => text.includes(regVar))

      expect(checks.length).toBeGreaterThan(0)

      // 空白を許さないことを表す anchored regex（`^\S+$`）を持つ assert があること。
      const whitespaceChecks = checks.filter((text) =>
        /\^\\S\+\$|\^\\S\*\$/.test(text),
      )
      expect(whitespaceChecks.length).toBeGreaterThan(0)
    },
  )

  it.each(ROLES)(
    '$role のトークン検証は fail_msg / success_msg にトークン変数を展開しない（値の漏洩防止）',
    ({ role, prefix }) => {
      const authVar = `${prefix}_auth_token`
      const regVar = `${prefix}_registration_token`
      const tokenAsserts = parseTasks(role)
        .map(assertArgs)
        .filter((a): a is AssertArgs => a !== undefined)
        .filter((args) => {
          const text = thatText(args)
          return text.includes(authVar) || text.includes(regVar)
        })

      expect(tokenAsserts.length).toBeGreaterThan(0)

      // 危険なのは変数「名」の言及ではなく「値」の展開である。変数名は運用者への
      // 案内として有用なので許し、`{{ ... }}` によるトークン値の埋め込みだけを禁じる。
      const expandsToken = new RegExp(
        `\\{\\{[^}]*(${authVar}|${regVar})[^}]*\\}\\}`,
      )
      for (const args of tokenAsserts) {
        for (const key of ['fail_msg', 'success_msg'] as const) {
          const msg = args[key]
          if (typeof msg !== 'string') continue
          expect(msg).not.toMatch(expandsToken)
        }
      }
    },
  )

  it.each(ROLES)(
    '$role はトークン形式の検証を副作用のあるどのタスクより先に行う（fail fast）',
    ({ role, prefix }) => {
      const authVar = `${prefix}_auth_token`
      const tasks = parseTasks(role)

      const formatIndex = tasks.findIndex((task) => {
        const args = assertArgs(task)
        if (!args) return false
        const text = thatText(args)
        return text.includes(authVar) && /\^glrt-/.test(text)
      })
      expect(formatIndex).toBeGreaterThanOrEqual(0)

      const firstSideEffect = tasks.findIndex(hasSideEffect)
      expect(firstSideEffect).toBeGreaterThanOrEqual(0)
      expect(formatIndex).toBeLessThan(firstSideEffect)
    },
  )
})
