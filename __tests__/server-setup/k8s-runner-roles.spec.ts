import { readFileSync, existsSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * Kubernetes 上に CI ランナーを配置する bundled role
 * （`gitlab_runner_k8s` / `github_runner_k8s`）の構造テスト。
 *
 * これらのロールは (a) 長期有効な秘匿トークン（GitLab 認証トークン / GitHub PAT）を
 * 扱い、(b) クラスタへ任意の Helm チャートを適用しうる力を持つため、実クラスタ無しでも
 * 固定できる不変条件をここで縛る。ロール変数の**値**はガード（ansible-task-guard.ts）が
 * 検証しない＝テナント入力は敵性入力として扱う、という前提に基づく。
 *
 * 固定する不変条件:
 *   1. tasks/main.yml がタスクマッピングの非空配列としてパースできる
 *   2. shell 本文への Jinja 展開は信頼できる `*_tempfile.path` のみ（シェルインジェクション防止）
 *   3. トークン一時ファイルは `always` ブロックで無条件に削除される
 *   4. チャートの取得元（repo / チャート名 / OCI 参照）がインラインリテラルである
 *   5. ジョブ実行は非特権（privileged / dind を有効化しない）
 *   6. チャートバージョンがロール変数でピン留めされ、既定値が具体的なバージョンである
 *   7. kubectl / kubeconfig の存在を assert する
 *   8. Kubernetes オブジェクト名を DNS-1123 ラベルとして assert する
 *   9. 秘匿値が `environment:` にも生成マニフェストにも載らない
 */
const ROLE_NAMES = ['gitlab_runner_k8s', 'github_runner_k8s'] as const
type RoleName = (typeof ROLE_NAMES)[number]

const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')

interface AnsibleTask {
  name?: string
  block?: AnsibleTask[]
  rescue?: AnsibleTask[]
  always?: AnsibleTask[]
  [key: string]: unknown
}

const roleDir = (role: RoleName): string => path.join(rolesDir, role)

/** ロール配下の tasks/*.yml をすべて読む（main.yml は必須）。 */
const taskFiles = (role: RoleName): { file: string; content: string }[] => {
  const files = ['main.yml']
  return files.map((file) => ({
    file,
    content: readFileSync(path.join(roleDir(role), 'tasks', file), 'utf8'),
  }))
}

const readTasks = (role: RoleName): string =>
  taskFiles(role)
    .map((f) => f.content)
    .join('\n')

const readDefaults = (role: RoleName): string =>
  readFileSync(path.join(roleDir(role), 'defaults', 'main.yml'), 'utf8')

/**
 * コメント行を除いた本文。
 *
 * 「危険な記述を含まない」系の検査を生テキストに掛けると、その危険な記述を**禁じる
 * 理由を説明したコメント**自体に反応してしまう（実際に `privileged = true` を禁ずる
 * 解説文で誤検知した）。禁止しているのはタスクの実体であってコメントではないので、
 * 行頭 `#` の行を落としてから検査する。
 */
const stripComments = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

/** block/rescue/always を展開してタスクを平坦化する。 */
const flatten = (tasks: unknown): AnsibleTask[] => {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as AnsibleTask
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

const parseTasks = (role: RoleName): AnsibleTask[] =>
  flatten(load(readTasks(role), { schema: DEFAULT_SCHEMA }))

const moduleArgs = (task: AnsibleTask, module: string): unknown =>
  task[`ansible.builtin.${module}`] ?? task[module]

const stringArg = (task: AnsibleTask, module: string): string | undefined => {
  const val = moduleArgs(task, module)
  if (typeof val === 'string') return val
  return undefined
}

/** `copy` タスクの content（マニフェスト・トークン書き出しの本文）。 */
const copyContent = (task: AnsibleTask): string | undefined => {
  const args = moduleArgs(task, 'copy')
  if (typeof args !== 'object' || args === null) return undefined
  const content = (args as Record<string, unknown>).content
  return typeof content === 'string' ? content : undefined
}

describe('Kubernetes CI runner bundled roles (gitlab_runner_k8s / github_runner_k8s)', () => {
  it.each(ROLE_NAMES)('%s は tasks/main.yml と defaults/main.yml を持つ', (role) => {
    expect(existsSync(path.join(roleDir(role), 'tasks', 'main.yml'))).toBe(true)
    expect(existsSync(path.join(roleDir(role), 'defaults', 'main.yml'))).toBe(true)
  })

  it.each(ROLE_NAMES)(
    '%s の tasks/main.yml はタスクマッピングの非空配列としてパースできる',
    (role) => {
      const parsed = load(readTasks(role), { schema: DEFAULT_SCHEMA })
      expect(Array.isArray(parsed)).toBe(true)
      const tasks = parsed as unknown[]
      expect(tasks.length).toBeGreaterThan(0)
      for (const task of tasks) {
        expect(typeof task).toBe('object')
        expect(task).not.toBeNull()
        expect(Array.isArray(task)).toBe(false)
      }
    },
  )

  it.each(ROLE_NAMES)(
    '%s の shell 本文へ展開する変数は tempfile パスか anchored regex で検証済みのものだけ（シェルインジェクション防止）',
    (role) => {
      const content = readTasks(role)
      const scripts = parseTasks(role)
        .map((task) => stringArg(task, 'shell'))
        .filter((s): s is string => !!s)
      expect(scripts.length).toBeGreaterThan(0)

      for (const script of scripts) {
        for (const expression of script.match(/\{\{[^}]*\}\}/g) ?? []) {
          // (a) Ansible が生成した信頼できる一時ファイルパスは無条件で許可する。
          if (/[\w.]*_tempfile\.path/.test(expression)) continue

          // (b) それ以外は、同ロール内で `<var> is match('^...$')` の形で
          //     アンカー付き正規表現の assert を通っている変数に限る。ガードは変数
          //     「名」しか検証しないため、値を検証しないままシェル本文へ差し込むと
          //     クォートを破って任意コマンドを実行できる（root 権限で動く）。
          const referenced = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
          const roleVars = referenced.filter((n) => n.startsWith(`${role}_`))
          expect(roleVars.length).toBeGreaterThan(0)
          for (const varName of roleVars) {
            const validated = new RegExp(
              `${varName}\\s+is\\s+match\\('\\^[^']*\\$'\\)`,
            ).test(content)
            expect(validated).toBe(true)
          }
        }
      }
    },
  )

  it.each(ROLE_NAMES)(
    '%s は秘匿値（トークン / PAT）を shell 本文へ展開しない',
    (role) => {
      const scripts = parseTasks(role)
        .map((task) => stringArg(task, 'shell'))
        .filter((s): s is string => !!s)
      for (const script of scripts) {
        for (const expression of script.match(/\{\{[^}]*\}\}/g) ?? []) {
          expect(expression).not.toMatch(/_(token|pat)\b/)
        }
      }
    },
  )

  it.each(ROLE_NAMES)(
    '%s はトークン一時ファイルを always ブロックで無条件に削除する',
    (role) => {
      const tasks = load(readTasks(role), { schema: DEFAULT_SCHEMA }) as AnsibleTask[]
      const alwaysTasks = tasks.flatMap((t) => flatten(t.always))
      const removesTempfile = alwaysTasks.some((task) => {
        const args = moduleArgs(task, 'file')
        if (typeof args !== 'object' || args === null) return false
        const record = args as Record<string, unknown>
        return (
          record.state === 'absent' &&
          typeof record.path === 'string' &&
          record.path.includes('_tempfile.path')
        )
      })
      expect(removesTempfile).toBe(true)
    },
  )

  it.each(ROLE_NAMES)(
    '%s のチャート取得元（repo/チャート名/OCI参照）はインラインリテラルで、ロール変数から差し替えられない',
    (role) => {
      const manifests = parseTasks(role)
        .map(copyContent)
        .filter((c): c is string => !!c)
        .filter((c) => c.includes('kind: HelmChart'))
      expect(manifests.length).toBeGreaterThan(0)
      for (const manifest of manifests) {
        for (const line of manifest.split('\n')) {
          const trimmed = line.trim()
          if (
            trimmed.startsWith('chart:') ||
            trimmed.startsWith('repo:') ||
            trimmed.startsWith('targetNamespace:')
          ) {
            // これらは「守るべき値」であり、変数化すると守る対象と一緒に
            // レシピ側の task-level vars から上書きされて検証が無効化される。
            // targetNamespace のみ、ロールが検証済みの名前空間変数を許す。
            if (trimmed.startsWith('targetNamespace:')) continue
            expect(trimmed).not.toContain('{{')
          }
        }
      }
      // defaults にチャート取得元を差し替えられる変数を置かない。
      const defaults = readDefaults(role)
      expect(defaults).not.toMatch(/_chart_repo\s*:/)
      expect(defaults).not.toMatch(/_chart_name\s*:/)
      expect(defaults).not.toMatch(/_chart_url\s*:/)
    },
  )

  it.each(ROLE_NAMES)(
    '%s のマニフェスト内 Jinja ブロックタグは行頭（列0）に置かれている（lstrip_blocks 非依存）',
    (role) => {
      // `copy` の content は YAML のリテラルブロックなので、YAML パーサがブロックの
      // 基準インデントを削ってから Jinja に渡る。したがってタグが「削られた後の列0」に
      // あれば、Ansible の Jinja 設定（trim_blocks=True / lstrip_blocks=False）でも
      // タグ行の前後に余計な空白が出力されない。
      //
      // ここを外すと、外側の HelmChart CR は valid なまま `valuesContent` の中身だけが
      // 壊れる（kubectl apply は成功し、helm の install ジョブだけが失敗する）という、
      // 気づきにくい形の不具合になる。
      const manifests = parseTasks(role)
        .map(copyContent)
        .filter((c): c is string => !!c)
      for (const manifest of manifests) {
        for (const line of manifest.split('\n')) {
          if (!line.trimStart().startsWith('{%')) continue
          expect(line.startsWith('{%')).toBe(true)
        }
      }
    },
  )

  it('gitlab_runner_k8s の RBAC ルールは GitLab 公式の必要権限表を超えない', () => {
    // チャートは rbac.rules が空だと core API group の resources:["*"] verbs:["*"] へ
    // フォールバックするため明示は必須だが、明示内容を広げてもいけない。
    // 特に configmaps は公式表に無い（ビルドスクリプトは kubelet 経由でマウントされ、
    // runner の API 権限を必要としない）。
    const manifest = parseTasks('gitlab_runner_k8s')
      .map(copyContent)
      .filter((c): c is string => !!c)
      .find((c) => c.includes('kind: HelmChart'))!
    const rbacSection = manifest.slice(manifest.indexOf('rbac:'))
    expect(rbacSection).not.toContain('configmaps')
    expect(rbacSection).not.toContain('namespaces')
    // ワイルドカードでの権限付与を禁止する。
    expect(rbacSection).not.toContain('"*"')
  })

  it('gitlab_runner_k8s は rollout status だけで成功と判定せず、実際に登録できたかを検証する', () => {
    // 回帰対象（実クラスタで観測）: チャートの readinessProbe は
    // `pgrep gitlab.*runner` だけで、登録をリトライ中のプロセスにもマッチする。
    // そのため不正なトークンでも Pod は一度 Ready になり rollout status が成功し、
    // 「セットアップ成功、しかし CI ジョブは永久に実行されない」状態になる。
    const tasks = parseTasks('gitlab_runner_k8s')
    const names = tasks.map((t) => t.name ?? '')
    const rolloutIndex = names.findIndex((n) => n.includes('runner manager to become ready'))
    const verifyIndex = names.findIndex((n) => n.includes('actually registered'))
    expect(rolloutIndex).toBeGreaterThanOrEqual(0)
    expect(verifyIndex).toBeGreaterThan(rolloutIndex)
    // 検証は chart 同梱の check-live（中身は gitlab-runner verify）に委ねる。
    expect(JSON.stringify(tasks[verifyIndex])).toContain('check-live')
  })

  it('gitlab_runner_k8s の登録検証は verify のタイムアウトを明示し、判定不能を成功として受け入れない', () => {
    // chart 同梱の check-live は `VERIFY_TIMEOUT=${1:-${VERIFY_TIMEOUT:-3}}` で、
    // タイムアウト時は「判定不能」として exit 0 に倒す。既定の3秒のままだと、回線が
    // 遅い環境ではトークンが無効でも毎回タイムアウトして「成功」と報告され、この
    // ゲートを入れた目的がそのまま失われる。
    const tasks = parseTasks('gitlab_runner_k8s')
    const verify = tasks.find((t) => (t.name ?? '').includes('actually registered'))!
    const argv = (moduleArgs(verify, 'command') as { argv: string[] }).argv
    const timeoutArg = argv[argv.indexOf('/configmaps/check-live') + 1]
    expect(Number(timeoutArg)).toBeGreaterThanOrEqual(10)
    // 判定不能（"not a conclusive failure"）を成功として通さない。
    expect(String(verify.until)).toContain('not a conclusive failure')
  })

  it('github_runner_k8s はランナー Pod への ServiceAccount トークン自動マウントを止める', () => {
    // containerMode 未設定なのでランナーの ServiceAccount には RoleBinding が付かないが、
    // 将来の設定ミスやチャート更新で権限が付いた場合に備えた多層防御
    //（gitlab_runner_k8s の automount_service_account_token = false と同じ方針）。
    expect(stripComments(readTasks('github_runner_k8s'))).toContain(
      'automountServiceAccountToken: false',
    )
  })

  it('gitlab_runner_k8s はジョブ Pod への ServiceAccount トークン自動マウントを止める', () => {
    expect(stripComments(readTasks('gitlab_runner_k8s'))).toContain(
      'automount_service_account_token = false',
    )
  })

  it('gitlab_runner_k8s は GitLab 公式チャートリポジトリを参照する', () => {
    const content = readTasks('gitlab_runner_k8s')
    expect(content).toContain('repo: https://charts.gitlab.io')
    expect(content).toMatch(/chart:\s*gitlab-runner\s*$/m)
  })

  it('github_runner_k8s は ARC 公式 OCI チャート（コントローラ + スケールセット）を参照する', () => {
    const content = readTasks('github_runner_k8s')
    expect(content).toContain(
      'chart: oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller',
    )
    expect(content).toContain(
      'chart: oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set',
    )
  })

  it.each(ROLE_NAMES)(
    '%s はジョブを非特権で実行する（privileged / dind を有効化する記述を持たない）',
    (role) => {
      const content = stripComments(readTasks(role))
      const defaults = stripComments(readDefaults(role))
      // privileged を true にする記述（TOML/YAML どちらの綴りでも）を禁止する。
      expect(content).not.toMatch(/privileged\s*[:=]\s*true/i)
      expect(defaults).not.toMatch(/privileged/i)
      // ARC の containerMode（dind / kubernetes）は特権または追加 RBAC を伴うため使わない。
      expect(content).not.toContain('containerMode')
      expect(defaults).not.toContain('containerMode')
    },
  )

  it('gitlab_runner_k8s は kubernetes executor の privileged を明示的に false で固定する', () => {
    // 既定値に頼らず明示する（チャート既定が変わっても非特権であることを保証する）。
    expect(stripComments(readTasks('gitlab_runner_k8s'))).toContain('privileged = false')
  })

  it.each(ROLE_NAMES)(
    '%s はチャートバージョンをロール変数でピン留めし、既定値が具体的なバージョンである',
    (role) => {
      const content = readTasks(role)
      const versionLines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('version:'))
      expect(versionLines.length).toBeGreaterThan(0)
      for (const line of versionLines) {
        // バージョン無指定（最新追従）を禁止する。ノード間・再実行間で
        // 別バージョンが入るとクラスタの状態が再現できなくなる。
        expect(line).toMatch(/\{\{.*_chart_version.*\}\}/)
      }
      expect(readDefaults(role)).toMatch(/_chart_version:\s*['"]?\d+\.\d+\.\d+['"]?/)
    },
  )

  it.each(ROLE_NAMES)('%s は kubectl と kubeconfig の存在を assert する', (role) => {
    const content = readTasks(role)
    expect(content).toContain('kubectl')
    expect(content).toContain('kubeconfig')
    const asserts = parseTasks(role).filter(
      (task) => moduleArgs(task, 'assert') !== undefined,
    )
    const assertText = JSON.stringify(asserts)
    expect(assertText).toContain('kubectl')
    expect(assertText).toContain('kubeconfig')
  })

  it.each(ROLE_NAMES)(
    '%s は Kubernetes オブジェクト名を DNS-1123 ラベルとして assert する',
    (role) => {
      const asserts = parseTasks(role).filter(
        (task) => moduleArgs(task, 'assert') !== undefined,
      )
      const assertText = JSON.stringify(asserts)
      // metadata.name / ラベルセレクタ / Secret 参照など複数の構造的位置へ展開されるため、
      // クォートでは救えない。適用前に名指しで落とす。
      expect(assertText).toMatch(/\^\[a-z0-9\]\(\[-a-z0-9\]\*\[a-z0-9\]\)\?\$/)
    },
  )

  it.each(ROLE_NAMES)(
    '%s は秘匿値を environment: に載せない（-vvv の EXEC トレースへ平文で出るため）',
    (role) => {
      const tasks = parseTasks(role)
      for (const task of tasks) {
        expect(task.environment).toBeUndefined()
      }
    },
  )

  it.each(ROLE_NAMES)(
    '%s は生成する HelmChart マニフェストに秘匿値を書かず、既存 Secret を名前で参照する',
    (role) => {
      const secretVarPattern = /_(token|pat)\b/
      const manifests = parseTasks(role)
        .map(copyContent)
        .filter((c): c is string => !!c)
        .filter((c) => c.includes('kind: HelmChart'))
      expect(manifests.length).toBeGreaterThan(0)
      for (const manifest of manifests) {
        // マニフェストはノード上に平文で残る。トークン系の変数を展開してはならない。
        for (const expression of manifest.match(/\{\{[^}]*\}\}/g) ?? []) {
          expect(expression).not.toMatch(secretVarPattern)
        }
      }
    },
  )

  it('gitlab_runner_k8s の HelmChart は runners.secret で既存 Secret を参照する', () => {
    const content = stripComments(readTasks('gitlab_runner_k8s'))
    expect(content).toContain('secret:')
    // チャート自身の Secret 生成は runnerToken/runnerRegistrationToken を渡したときのみ
    // 発火する。値を渡さないことでロールが作った Secret が上書きされないことを担保する。
    expect(content).not.toContain('runnerToken:')
    expect(content).not.toContain('runnerRegistrationToken:')
  })

  it('gitlab_runner_k8s の Secret は runner-token / runner-registration-token の両キーを必ず作る', () => {
    // チャートの Deployment は両キーを projected volume で参照し、どちらにも
    // `optional: true` を付けていない（templates/deployment.yaml で確認）。片方でも
    // 欠けるとボリュームを射影できず Pod が ContainerCreating のまま起動しない。
    // 使わない方のキーは空文字で作る（チャート自身の secrets.yaml と同じ挙動）。
    const scripts = parseTasks('gitlab_runner_k8s')
      .map((task) => stringArg(task, 'shell'))
      .filter((s): s is string => !!s)
    const secretScripts = scripts.filter((s) => s.includes('create secret'))
    expect(secretScripts.length).toBeGreaterThan(0)
    for (const script of secretScripts) {
      expect(script).toContain('--from-file=runner-token=')
      expect(script).toContain('--from-file=runner-registration-token=')
    }
  })

  it('github_runner_k8s の HelmChart は githubConfigSecret に既存 Secret 名を文字列で渡す', () => {
    const content = stripComments(readTasks('github_runner_k8s'))
    expect(content).toMatch(/githubConfigSecret:\s*\{\{/)
    // マップ形式（github_token: <値>）で渡すとチャートが値から Secret を作り、
    // トークンがマニフェスト経由でノード上に平文で残る。
    expect(content).not.toContain('github_token:')
  })

  it('github_runner_k8s はコントローラの CRD 出現を待ってからスケールセットを適用する', () => {
    const tasks = parseTasks('github_runner_k8s')
    const names = tasks.map((t) => t.name ?? '')
    const crdWaitIndex = names.findIndex((n) =>
      n.includes('autoscalingrunnersets.actions.github.com'),
    )
    const scaleSetApplyIndex = names.findIndex((n) => n.includes('scale set'))
    expect(crdWaitIndex).toBeGreaterThanOrEqual(0)
    expect(scaleSetApplyIndex).toBeGreaterThan(crdWaitIndex)
  })
})
