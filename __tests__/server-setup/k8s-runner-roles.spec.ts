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
 *  10. gitlab_runner_k8s のオプトイン設定（pull_policy / requests・limits / S3 キャッシュ）は
 *      既定では何も出力せず、値は anchored regex で検証してから TOML へ展開する
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
          expect(expression).not.toMatch(/_(token|pat)\b|_s3_(access|secret)_key\b/)
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
      const secretVarPattern = /_(token|pat)\b|_s3_(access|secret)_key\b/
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
    // S3 キャッシュのクレデンシャル Secret（accesskey / secretkey）は別物なので除く。
    const secretScripts = scripts.filter((s) =>
      s.includes('create secret generic {{ gitlab_runner_k8s_secret_name }}'),
    )
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

/**
 * gitlab_runner_k8s のオプトイン設定（イメージ取得ポリシー / ジョブの requests・limits /
 * S3 共有キャッシュ）。
 *
 * 実クラスタ・Ansible 無しで固定できる不変条件:
 *   - 既定値（空）では TOML にも HelmChart の values にも1行も出力しない（既存の導入で
 *     生成マニフェストがバイト単位で変わらず、Deployment が再起動しない）
 *   - 各オプションは対応する `{% if %}` の内側でだけ出力される
 *   - TOML へ展開する値は anchored regex の assert を通る（生 TOML の注入を防ぐ）
 *   - S3 のクレデンシャルはマニフェストへ展開されず、Secret 名の参照だけが載る
 */
describe('gitlab_runner_k8s のオプトイン設定（pull_policy / requests・limits / S3 キャッシュ）', () => {
  const ROLE = 'gitlab_runner_k8s' as const

  const manifest = (): string =>
    parseTasks(ROLE)
      .map(copyContent)
      .filter((c): c is string => !!c)
      .find((c) => c.includes('kind: HelmChart'))!

  /** 列0の `{% if COND %}` … `{% endif %}`（入れ子対応）を、COND が pattern に一致するものだけ取り除く。 */
  const stripIfBlocks = (content: string, pattern: RegExp): string => {
    const out: string[] = []
    let skipDepth = 0
    for (const line of content.split('\n')) {
      const ifMatch = /^\{%\s*if\s+(.*?)\s*%\}$/.exec(line)
      const isEndif = /^\{%\s*endif\s*%\}$/.test(line)
      if (skipDepth > 0) {
        if (ifMatch) skipDepth++
        if (isEndif) skipDepth--
        continue
      }
      if (ifMatch && pattern.test(ifMatch[1])) {
        skipDepth = 1
        continue
      }
      out.push(line)
    }
    return out.join('\n')
  }

  /** `{% if COND %}` の直後から対応する `{% endif %}` までの本文（入れ子の if 行も含む）。 */
  const ifBlockBody = (content: string, condition: RegExp): string[] => {
    const lines = content.split('\n')
    const start = lines.findIndex((l) => {
      const m = /^\{%\s*if\s+(.*?)\s*%\}$/.exec(l)
      return !!m && condition.test(m[1])
    })
    expect(start).toBeGreaterThanOrEqual(0)
    const body: string[] = []
    let depth = 1
    for (const line of lines.slice(start + 1)) {
      if (/^\{%\s*if\s/.test(line)) depth++
      if (/^\{%\s*endif\s*%\}$/.test(line)) depth--
      if (depth === 0) break
      body.push(line)
    }
    return body
  }

  const OPT_IN_CONDITION =
    /gitlab_runner_k8s_(pull_policy|cpu_request|cpu_limit|memory_request|memory_limit|cache_type)/

  /** 変更前（オプトイン設定の導入前）の `runners:` 以降。既定ではこれと完全一致すること。 */
  const RUNNERS_SECTION_BEFORE_OPT_IN = [
    '    runners:',
    '      secret: {{ gitlab_runner_k8s_secret_name | to_json }}',
    '{% if gitlab_runner_k8s_has_reg | bool %}',
    '      tags: {{ gitlab_runner_k8s_tags | to_json }}',
    '      runUntagged: {{ (gitlab_runner_k8s_run_untagged | bool) | to_json }}',
    '      locked: {{ (gitlab_runner_k8s_locked | bool) | to_json }}',
    '{% endif %}',
    '      config: |',
    '        [[runners]]',
    '          [runners.kubernetes]',
    '            namespace = {{ gitlab_runner_k8s_namespace | to_json }}',
    '            image = {{ gitlab_runner_k8s_job_image | to_json }}',
    '            privileged = false',
    '            automount_service_account_token = false',
    '',
  ].join('\n')

  /** assert の that から `<var> is match('<regex>')` を抜き出して JS の RegExp にする。 */
  const assertRegexFor = (varName: string): RegExp => {
    const asserts = parseTasks(ROLE)
      .map((task) => moduleArgs(task, 'assert'))
      .filter((a): a is { that: unknown } => typeof a === 'object' && a !== null)
    const thatText = asserts.flatMap((a) => (Array.isArray(a.that) ? a.that.map(String) : []))
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const expr of thatText) {
      const m = new RegExp(
        `${escaped}(?:\\s*\\|\\s*string\\s*\\))?\\s+is\\s+match\\('(\\^[^']*\\$)'\\)`,
      ).exec(expr)
      if (m) return new RegExp(m[1])
    }
    throw new Error(`no anchored-regex assert for ${varName}`)
  }

  it('新しい変数の既定値は従来どおりの挙動（空 / insecure=false / shared=true）', () => {
    const defaults = load(readDefaults(ROLE), {
      schema: DEFAULT_SCHEMA,
    }) as Record<string, unknown>
    for (const name of [
      'gitlab_runner_k8s_pull_policy',
      'gitlab_runner_k8s_cpu_request',
      'gitlab_runner_k8s_cpu_limit',
      'gitlab_runner_k8s_memory_request',
      'gitlab_runner_k8s_memory_limit',
      'gitlab_runner_k8s_cache_type',
      'gitlab_runner_k8s_cache_s3_server_address',
      'gitlab_runner_k8s_cache_s3_bucket_name',
      'gitlab_runner_k8s_cache_s3_bucket_location',
      'gitlab_runner_k8s_cache_s3_access_key',
      'gitlab_runner_k8s_cache_s3_secret_key',
    ]) {
      expect(defaults[name]).toBe('')
    }
    expect(defaults.gitlab_runner_k8s_cache_s3_insecure).toBe(false)
    expect(defaults.gitlab_runner_k8s_cache_shared).toBe(true)
  })

  it('オプトイン設定のブロックを除くと、マニフェストは導入前と完全に一致する（既定で出力が変わらない）', () => {
    const stripped = stripIfBlocks(manifest(), OPT_IN_CONDITION)
    expect(stripped.slice(stripped.indexOf('    runners:'))).toBe(RUNNERS_SECTION_BEFORE_OPT_IN)
    // 除いたブロック以外にオプトイン変数を参照する行が残っていない＝既定では何も出ない。
    expect(stripped).not.toMatch(
      /gitlab_runner_k8s_(pull_policy|cpu_|memory_|cache_)|pull_policy|cpu_request|memory_limit|\[runners\.cache/,
    )
  })

  it('各オプションの条件は「空でない」ときだけ真になる（空文字の既定値で発火しない）', () => {
    const conditions = manifest()
      .split('\n')
      .map((l) => /^\{%\s*if\s+(.*?)\s*%\}$/.exec(l)?.[1])
      .filter((c): c is string => !!c && OPT_IN_CONDITION.test(c))
    expect(conditions).toEqual([
      "gitlab_runner_k8s_cache_type == 's3' and (gitlab_runner_k8s_has_cache_access_key | bool)",
      'gitlab_runner_k8s_pull_policy | length > 0',
      '(gitlab_runner_k8s_cpu_request | string | length) > 0',
      '(gitlab_runner_k8s_cpu_limit | string | length) > 0',
      '(gitlab_runner_k8s_memory_request | string | length) > 0',
      '(gitlab_runner_k8s_memory_limit | string | length) > 0',
      "gitlab_runner_k8s_cache_type == 's3'",
    ])
  })

  it.each([
    [
      /gitlab_runner_k8s_pull_policy/,
      "pull_policy = {{ gitlab_runner_k8s_pull_policy.split(',') | to_json }}",
    ],
    [
      /gitlab_runner_k8s_cpu_request/,
      'cpu_request = {{ gitlab_runner_k8s_cpu_request | string | to_json }}',
    ],
    [
      /gitlab_runner_k8s_cpu_limit/,
      'cpu_limit = {{ gitlab_runner_k8s_cpu_limit | string | to_json }}',
    ],
    [
      /gitlab_runner_k8s_memory_request/,
      'memory_request = {{ gitlab_runner_k8s_memory_request | string | to_json }}',
    ],
    [
      /gitlab_runner_k8s_memory_limit/,
      'memory_limit = {{ gitlab_runner_k8s_memory_limit | string | to_json }}',
    ],
  ])('%s が設定されると [runners.kubernetes] に対応する1行を出力する', (condition, expected) => {
    const body = ifBlockBody(manifest(), condition)
    expect(body.map((l) => l.trim())).toEqual([expected])
    // [runners.kubernetes] のキーと同じ深さ（privileged と同じインデント）に置く。
    const privilegedIndent = manifest()
      .split('\n')
      .find((l) => l.trim() === 'privileged = false')!
      .search(/\S/)
    expect(body[0].search(/\S/)).toBe(privilegedIndent)
  })

  it('cache_type=s3 のとき [runners.cache] / [runners.cache.s3] を出力する', () => {
    const body = ifBlockBody(manifest(), /^gitlab_runner_k8s_cache_type == 's3'$/).map((l) =>
      l.trim(),
    )
    expect(body).toEqual([
      '[runners.cache]',
      'Type = "s3"',
      'Shared = {{ (gitlab_runner_k8s_cache_shared | bool) | to_json }}',
      '[runners.cache.s3]',
      'ServerAddress = {{ gitlab_runner_k8s_cache_s3_server_address | to_json }}',
      'BucketName = {{ gitlab_runner_k8s_cache_s3_bucket_name | to_json }}',
      '{% if gitlab_runner_k8s_cache_s3_bucket_location | length > 0 %}',
      'BucketLocation = {{ gitlab_runner_k8s_cache_s3_bucket_location | to_json }}',
      '{% endif %}',
      'Insecure = {{ (gitlab_runner_k8s_cache_s3_insecure | bool) | to_json }}',
      "AuthenticationType = {{ ('access-key' if (gitlab_runner_k8s_has_cache_access_key | bool) else 'iam') | to_json }}",
    ])
  })

  it('静的クレデンシャルがあるときだけ runners.cache.secretName でロールの Secret を参照する', () => {
    const body = ifBlockBody(manifest(), /gitlab_runner_k8s_has_cache_access_key/).map((l) =>
      l.trim(),
    )
    expect(body).toEqual([
      'cache:',
      'secretName: {{ gitlab_runner_k8s_cache_secret_name | to_json }}',
    ])
    // Secret 名は派生値で、DNS-1123 ラベルとして assert される。
    expect(readFileSync(path.join(roleDir(ROLE), 'vars', 'main.yml'), 'utf8')).toContain(
      'gitlab_runner_k8s_cache_secret_name: "{{ gitlab_runner_k8s_name }}-cache"',
    )
    expect(assertRegexFor('gitlab_runner_k8s_cache_secret_name').source).toBe(
      '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$',
    )
  })

  it('S3 のクレデンシャルはマニフェストにも shell 本文にも展開されない', () => {
    const credential = /gitlab_runner_k8s_cache_s3_(access|secret)_key\b/
    for (const expression of manifest().match(/\{\{[^}]*\}\}|\{%[^%]*%\}/g) ?? []) {
      expect(expression).not.toMatch(credential)
    }
    const scripts = parseTasks(ROLE)
      .map((task) => stringArg(task, 'shell'))
      .filter((s): s is string => !!s)
    for (const script of scripts) expect(script).not.toMatch(credential)
    // タスクの environment にも載せない（-vvv の EXEC トレースに平文で出るため）。
    for (const task of parseTasks(ROLE))
      expect(JSON.stringify(task.environment ?? '')).not.toMatch(credential)
  })

  it('S3 キャッシュの Secret は一時ファイル経由で accesskey / secretkey キーとして作り、always で削除する', () => {
    const tasks = load(readTasks(ROLE), {
      schema: DEFAULT_SCHEMA,
    }) as AnsibleTask[]
    const block = tasks.find((t) => (t.name ?? '').includes('S3 cache credentials Secret'))!
    expect(block).toBeDefined()
    const script = flatten(block.block)
      .map((t) => stringArg(t, 'shell'))
      .find((s): s is string => !!s)!
    expect(script).toContain('create secret generic {{ gitlab_runner_k8s_cache_secret_name }}')
    // キー名はチャートの entrypoint が /secrets/accesskey・/secrets/secretkey として読む名前。
    expect(script).toContain(
      '--from-file=accesskey={{ gitlab_runner_k8s_cache_access_key_tempfile.path }}',
    )
    expect(script).toContain(
      '--from-file=secretkey={{ gitlab_runner_k8s_cache_secret_key_tempfile.path }}',
    )
    const removed = flatten(block.always)
      .map((t) => moduleArgs(t, 'file') as Record<string, unknown> | undefined)
      .filter((a) => a?.state === 'absent')
      .map((a) => String(a?.path))
    expect(removed).toEqual([
      '{{ gitlab_runner_k8s_cache_access_key_tempfile.path }}',
      '{{ gitlab_runner_k8s_cache_secret_key_tempfile.path }}',
    ])
    // 値は copy の content（モジュール自身が秘匿する）でのみ書く。
    const contents = flatten(block.block)
      .map(copyContent)
      .filter((c): c is string => !!c)
    expect(contents).toEqual([
      '{{ gitlab_runner_k8s_cache_s3_access_key | trim }}',
      '{{ gitlab_runner_k8s_cache_s3_secret_key | trim }}',
    ])
  })

  it('S3 キャッシュの Secret はマニフェストの適用より前に作る（チャートは optional なしで projected volume に載せるため）', () => {
    const names = parseTasks(ROLE).map((t) => t.name ?? '')
    const secretIndex = names.findIndex((n) => n.includes('Apply the S3 cache credentials Secret'))
    const manifestIndex = names.findIndex((n) => n.includes('Write the HelmChart manifest'))
    expect(secretIndex).toBeGreaterThanOrEqual(0)
    expect(manifestIndex).toBeGreaterThan(secretIndex)
  })

  it('オプトイン設定の検証はすべての副作用（kubectl / ファイル作成）より前に行う', () => {
    const tasks = parseTasks(ROLE)
    const names = tasks.map((t) => t.name ?? '')
    const lastValidate = Math.max(
      ...[
        'pull policy',
        'requests and limits',
        'shared cache type',
        'S3 cache settings',
        'S3 cache credentials',
        'cache is disabled',
      ].map((fragment) =>
        names.findIndex(
          (n) => n.startsWith('gitlab_runner_k8s : Validate') && n.includes(fragment),
        ),
      ),
    )
    const firstSideEffect = tasks.findIndex(
      (t) =>
        moduleArgs(t, 'shell') !== undefined ||
        moduleArgs(t, 'file') !== undefined ||
        moduleArgs(t, 'command') !== undefined,
    )
    expect(lastValidate).toBeGreaterThan(0)
    expect(firstSideEffect).toBeGreaterThan(lastValidate)
  })

  describe('TOML へ展開する値の anchored regex（実際の assert から抽出して評価する）', () => {
    it.each([
      [
        'gitlab_runner_k8s_pull_policy',
        ['always', 'if-not-present', 'never', 'always,if-not-present'],
        ['IfNotPresent', 'always, never', 'always,', 'always"]\nprivileged = true #'],
      ],
      [
        'gitlab_runner_k8s_cpu_request',
        ['', '500m', '1', '1.5'],
        ['1.5m', '-1', '1 ', '1"\nprivileged=true', '1e3'],
      ],
      ['gitlab_runner_k8s_cpu_limit', ['', '250m', '2'], ['two', 'm', '.5']],
      [
        'gitlab_runner_k8s_memory_request',
        ['', '512Mi', '2Gi', '1000', '1G'],
        ['1GB', '-1Gi', '1.5Gi', 'Mi'],
      ],
      ['gitlab_runner_k8s_memory_limit', ['', '4Gi', '1Ti'], ['4gi', '4 Gi', '4Gi"']],
      ['gitlab_runner_k8s_cache_type', ['', 's3'], ['gcs', 'S3', 's3 ']],
      [
        'gitlab_runner_k8s_cache_s3_server_address',
        ['s3.amazonaws.com', 'minio.example.internal:9000', 'minio'],
        [
          '',
          'https://s3.amazonaws.com',
          's3.amazonaws.com/',
          'host"]\nprivileged = true',
          '-bad.example',
        ],
      ],
      [
        'gitlab_runner_k8s_cache_s3_bucket_name',
        ['ci-cache', 'my.bucket.01'],
        ['', 'CI_Cache', 'ab', 'bucket"'],
      ],
      [
        'gitlab_runner_k8s_cache_s3_bucket_location',
        ['', 'us-east-1', 'ap-northeast-1'],
        ['Tokyo 1', 'us_east_1', '-us', 'r"'],
      ],
    ])('%s', (varName, valid, invalid) => {
      const re = assertRegexFor(varName as string)
      for (const v of valid as string[])
        expect(`${varName}=${v}:${re.test(v)}`).toBe(`${varName}=${v}:true`)
      for (const v of invalid as string[])
        expect(`${varName}=${v}:${re.test(v)}`).toBe(`${varName}=${v}:false`)
    })

    it('S3 のクレデンシャル assert は値を fail_msg に展開しない', () => {
      const credAssert = parseTasks(ROLE).find((t) =>
        (t.name ?? '').includes('S3 cache credentials'),
      )!
      const args = moduleArgs(credAssert, 'assert') as {
        fail_msg: string
        success_msg: string
      }
      expect(args.fail_msg).not.toContain('{{')
      expect(args.success_msg).not.toContain('{{')
      expect(credAssert.no_log).toBeUndefined()
    })
  })
})
