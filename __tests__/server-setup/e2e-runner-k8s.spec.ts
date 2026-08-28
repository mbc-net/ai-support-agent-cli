import { readFileSync, existsSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * E2E(Playwright)ジョブをオンデマンドで投入できるようにする bundled role
 * (`e2e_runner_k8s`)の構造テスト。
 *
 * このロールは (a) namespace 限定とはいえ Job/Pod を操作できる ServiceAccount の
 * 長期トークンを発行し、(b) 対象リポジトリを clone するための git デプロイトークンを
 * 扱う。どちらも実クラスタ無しでも固定できる不変条件をここで縛る
 * (`k8s-runner-roles.spec.ts` と同じ設計思想)。ロール変数の**値**はガード
 * (ansible-task-guard.ts)が検証しない＝テナント入力は敵性入力として扱う、という前提。
 *
 * 固定する不変条件:
 *   1. tasks/main.yml がタスクマッピングの非空配列としてパースできる
 *   2. shell 本文への Jinja 展開は信頼できる tempfile パスか、assert 済みの変数のみ
 *   3. 秘匿値（git デプロイトークン / pat）は shell 本文へ展開しない
 *   4. git デプロイトークンの一時ファイルは always ブロックで無条件に削除される
 *   5. ServiceAccount トークンの値は register / set_fact のいずれにも現れない
 *      （kubeconfig 生成タスクは register を持たず、トークン待機タスクは文字数のみ）
 *   6. RBAC は namespace 限定の Role のみで、ワイルドカードを使わず
 *      jobs/pods/pods-log 以外へアクセスできない
 *   7. kubectl / kubeconfig / CA 証明書の存在を assert する
 *   8. Kubernetes オブジェクト名を DNS-1123 ラベルとして assert する
 *   9. 秘匿値が `environment:` にも生成マニフェストにも載らない
 *  10. 出力 kubeconfig はクラスタ管理者 kubeconfig と別ファイルである
 */
const ROLE = 'e2e_runner_k8s'
const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')
const roleDir = path.join(rolesDir, ROLE)

interface AnsibleTask {
  name?: string
  block?: AnsibleTask[]
  rescue?: AnsibleTask[]
  always?: AnsibleTask[]
  register?: string
  environment?: unknown
  [key: string]: unknown
}

const readTasks = (): string => readFileSync(path.join(roleDir, 'tasks', 'main.yml'), 'utf8')
const readDefaults = (): string => readFileSync(path.join(roleDir, 'defaults', 'main.yml'), 'utf8')

const stripComments = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

const flatten = (tasks: unknown): AnsibleTask[] => {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap((task) => {
    if (typeof task !== 'object' || task === null) return []
    const t = task as AnsibleTask
    return [t, ...flatten(t.block), ...flatten(t.rescue), ...flatten(t.always)]
  })
}

const parseTasks = (): AnsibleTask[] => flatten(load(readTasks(), { schema: DEFAULT_SCHEMA }))

const moduleArgs = (task: AnsibleTask, module: string): unknown =>
  task[`ansible.builtin.${module}`] ?? task[module]

const stringArg = (task: AnsibleTask, module: string): string | undefined => {
  const val = moduleArgs(task, module)
  if (typeof val === 'string') return val
  return undefined
}

const copyContent = (task: AnsibleTask): string | undefined => {
  const args = moduleArgs(task, 'copy')
  if (typeof args !== 'object' || args === null) return undefined
  const content = (args as Record<string, unknown>).content
  return typeof content === 'string' ? content : undefined
}

describe('e2e_runner_k8s bundled role', () => {
  it('tasks/main.yml と defaults/main.yml を持つ', () => {
    expect(existsSync(path.join(roleDir, 'tasks', 'main.yml'))).toBe(true)
    expect(existsSync(path.join(roleDir, 'defaults', 'main.yml'))).toBe(true)
  })

  it('tasks/main.yml はタスクマッピングの非空配列としてパースできる', () => {
    const parsed = load(readTasks(), { schema: DEFAULT_SCHEMA })
    expect(Array.isArray(parsed)).toBe(true)
    const tasks = parsed as unknown[]
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(typeof task).toBe('object')
      expect(task).not.toBeNull()
      expect(Array.isArray(task)).toBe(false)
    }
  })

  it('shell 本文へ展開する変数は tempfile パスか anchored regex で検証済みのものだけ（シェルインジェクション防止）', () => {
    const content = readTasks()
    const scripts = parseTasks()
      .map((task) => stringArg(task, 'shell'))
      .filter((s): s is string => !!s)
    expect(scripts.length).toBeGreaterThan(0)

    for (const script of scripts) {
      for (const expression of script.match(/\{\{[^}]*\}\}/g) ?? []) {
        if (/[\w.]*_tempfile\.path/.test(expression)) continue

        const referenced = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
        const roleVars = referenced.filter((n) => n.startsWith(`${ROLE}_`))
        expect(roleVars.length).toBeGreaterThan(0)
        for (const varName of roleVars) {
          const validated = new RegExp(`${varName}\\s+is\\s+match\\('\\^[^']*\\$'\\)`).test(
            content,
          )
          expect(validated).toBe(true)
        }
      }
    }
  })

  it('秘匿値（デプロイトークン / pat）を shell 本文へ展開しない', () => {
    const scripts = parseTasks()
      .map((task) => stringArg(task, 'shell'))
      .filter((s): s is string => !!s)
    for (const script of scripts) {
      for (const expression of script.match(/\{\{[^}]*\}\}/g) ?? []) {
        expect(expression).not.toMatch(/_(token|pat)\b/)
      }
    }
  })

  it('git デプロイトークンの一時ファイルを always ブロックで無条件に削除する', () => {
    const tasks = load(readTasks(), { schema: DEFAULT_SCHEMA }) as AnsibleTask[]
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
  })

  it('ServiceAccount トークンの値は register / set_fact のいずれにも現れない', () => {
    const tasks = parseTasks()
    // kubeconfig を組み立てるタスクは、値をシェル変数としてのみ扱い register しない。
    const kubeconfigGenTask = tasks.find((t) => (t.name ?? '').includes('scoped kubeconfig'))
    expect(kubeconfigGenTask).toBeDefined()
    expect(kubeconfigGenTask!.register).toBeUndefined()
    for (const key of ['set_fact', 'ansible.builtin.set_fact']) {
      expect(kubeconfigGenTask![key]).toBeUndefined()
    }

    // トークン待機タスクは文字数のみを register し、値そのものは扱わない。
    const waitTask = tasks.find((t) => (t.name ?? '').includes('token to be populated'))
    expect(waitTask).toBeDefined()
    const waitScript = stringArg(waitTask!, 'shell') ?? ''
    expect(waitScript).toContain('wc -c')
    expect(String(waitTask!.until ?? '')).toMatch(/int\s*>\s*0/)
  })

  it('RBAC は namespace 限定の Role のみで、ワイルドカードを使わない', () => {
    const manifests = parseTasks()
      .map(copyContent)
      .filter((c): c is string => !!c)
    const rbacManifest = manifests.find((c) => c.includes('kind: Role'))
    expect(rbacManifest).toBeDefined()
    expect(rbacManifest).not.toContain('kind: ClusterRole')
    expect(rbacManifest).not.toContain('"*"')
    expect(rbacManifest).not.toMatch(/verbs:\s*\[\s*"\*"\s*\]/)

    // jobs/pods/pods-log 以外のリソースへはアクセスできない。
    const resourceLines = (rbacManifest ?? '')
      .split('\n')
      .filter((l) => l.trim().startsWith('resources:'))
    expect(resourceLines.length).toBeGreaterThan(0)
    for (const line of resourceLines) {
      expect(line).toMatch(/\["(jobs|pods|pods\/log)"\]/)
    }
  })

  it('kubectl / kubeconfig / CA 証明書の存在を assert する', () => {
    const content = readTasks()
    expect(content).toContain('kubectl')
    expect(content).toContain('kubeconfig')
    // CA証明書パスはインラインリテラル（role変数ではない。任意ファイル漏洩防止のため）。
    expect(content).toContain('/var/lib/rancher/k3s/server/tls/server-ca.crt')
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const assertText = JSON.stringify(asserts)
    expect(assertText).toContain('kubectl')
    expect(assertText).toContain('kubeconfig')
  })

  it('CA証明書パスはrole変数ではなくインラインリテラルである（任意ファイル漏洩防止）', () => {
    const content = readTasks()
    expect(content).not.toContain('e2e_runner_k8s_cluster_ca_cert')
    expect(readDefaults()).not.toContain('e2e_runner_k8s_cluster_ca_cert:')
  })

  it('output kubeconfigのowner/groupはrole変数ではなくインラインリテラルである（任意パスのchown乗っ取り防止）', () => {
    const content = readTasks()
    expect(content).not.toContain('e2e_runner_k8s_output_kubeconfig_owner')
    expect(content).not.toContain('e2e_runner_k8s_output_kubeconfig_group')
    expect(content).toMatch(/owner:\s*mbc/)
    expect(content).toMatch(/group:\s*mbc/)
  })

  it('output kubeconfigのpathは/etc/e2e-runner/配下に限定される', () => {
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const assertText = JSON.stringify(asserts)
    expect(assertText).toContain("match('^/etc/e2e-runner/")
    // 域外パスは拒否されることを再現検証する。
    const regex = new RegExp('^/etc/e2e-runner/(?!\\.)[A-Za-z0-9._-]+$')
    expect(regex.test('/etc/e2e-runner/kubeconfig')).toBe(true)
    expect(regex.test('/etc/passwd')).toBe(false)
    expect(regex.test('/etc/cron.d/x')).toBe(false)
    expect(regex.test('/etc/e2e-runner/./kubeconfig')).toBe(false)
  })

  it('Kubernetes オブジェクト名を DNS-1123 ラベルとして assert する', () => {
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const assertText = JSON.stringify(asserts)
    expect(assertText).toMatch(/\^\[a-z0-9\]\(\[-a-z0-9\]\*\[a-z0-9\]\)\?\$/)
  })

  it('秘匿値を environment: に載せない（-vvv の EXEC トレースへ平文で出るため）', () => {
    const tasks = parseTasks()
    for (const task of tasks) {
      expect(task.environment).toBeUndefined()
    }
  })

  it('生成する ResourceQuota / RBAC / ServiceAccount トークン Secret マニフェストに秘匿値を書かない', () => {
    // `copyContent` は「git デプロイトークンを一時ファイルへ書く」copy タスクの
    // content も拾ってしまう（あれは秘匿値を書いてよい唯一の場所であり、対象外）。
    // ここでは実際に kubectl apply する Kubernetes マニフェスト（`kind:` を持つもの）
    // だけを対象にする。
    const secretVarPattern = /_(token|pat)\b/
    const manifests = parseTasks()
      .map(copyContent)
      .filter((c): c is string => !!c)
      .filter((c) => /^kind:/m.test(c))
    expect(manifests.length).toBeGreaterThan(0)
    for (const manifest of manifests) {
      for (const expression of manifest.match(/\{\{[^}]*\}\}/g) ?? []) {
        expect(expression).not.toMatch(secretVarPattern)
      }
    }
  })

  it('ServiceAccount トークン Secret マニフェストは type: kubernetes.io/service-account-token で値を持たない', () => {
    const manifests = parseTasks()
      .map(copyContent)
      .filter((c): c is string => !!c)
    const tokenSecretManifest = manifests.find((c) =>
      c.includes('kubernetes.io/service-account-token'),
    )
    expect(tokenSecretManifest).toBeDefined()
    // `metadata:` は正当なキーであり `data:` を部分文字列として含むため、行頭一致で
    // 判定する（`toContain('data:')` は誤検知する）。
    expect(tokenSecretManifest).not.toMatch(/^\s*(data|stringData):/m)
  })

  it('出力 kubeconfig はクラスタ管理者 kubeconfig と別ファイルである', () => {
    const defaults = load(readDefaults(), { schema: DEFAULT_SCHEMA }) as Record<string, unknown>
    expect(defaults.e2e_runner_k8s_output_kubeconfig_path).toBeDefined()
    expect(defaults.e2e_runner_k8s_kubeconfig).toBeDefined()
    expect(defaults.e2e_runner_k8s_output_kubeconfig_path).not.toEqual(
      defaults.e2e_runner_k8s_kubeconfig,
    )
  })

  it('recipe が output_kubeconfig_path を kubeconfig と同じ値へ上書きした場合を runtime で検知する', () => {
    // 上のテストは defaults の値が異なることしか確認しない。recipe の task-level vars
    // で両者を同じ値に上書きされた場合に実行時に落ちる assert が実在することを、
    // 構造的に固定する。
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const guardAssert = asserts.find((task) =>
      (task.name ?? '').includes('not the cluster admin kubeconfig'),
    )
    expect(guardAssert).toBeDefined()
    const that = (moduleArgs(guardAssert!, 'assert') as Record<string, unknown>).that
    const thatText = JSON.stringify(that)
    expect(thatText).toContain('e2e_runner_k8s_output_kubeconfig_path')
    expect(thatText).toMatch(/!=\s*e2e_runner_k8s_kubeconfig/)
  })

  it('recipe が output_kubeconfig_path を manifest_dir と同じ値へ上書きした場合を runtime で検知する', () => {
    // 両方とも独立した /etc/e2e-runner/<1階層> 形状の変数のため衝突しうる。衝突すると
    // kubeconfig 生成の `cat > <path> <<EOF` がディレクトリへのリダイレクトになり、
    // 生の bash エラーで落ちる。それを避ける assert が実在することを固定する。
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const guardAssert = asserts.find((task) =>
      (task.name ?? '').includes('collide with the manifest directory'),
    )
    expect(guardAssert).toBeDefined()
    const that = (moduleArgs(guardAssert!, 'assert') as Record<string, unknown>).that
    const thatText = JSON.stringify(that)
    expect(thatText).toContain('e2e_runner_k8s_output_kubeconfig_path')
    expect(thatText).toMatch(/!=\s*e2e_runner_k8s_manifest_dir/)
  })

  it('ジョブを非特権で実行する（privileged / dind を有効化する記述を持たない）', () => {
    const content = stripComments(readTasks())
    const defaults = stripComments(readDefaults())
    expect(content).not.toMatch(/privileged\s*[:=]\s*true/i)
    expect(defaults).not.toMatch(/privileged/i)
    expect(content).not.toContain('containerMode')
  })

  it('パス変数の assert は dot-segment（"." / ".." / 連続スラッシュ）による同一ファイルの別綴りを拒否する', () => {
    // commit 342192a "close the dot-segment path bypass" と同じ理由・同じパターン。
    // 文字集合と絶対パス性だけでは `/etc/rancher/k3s/./k3s.yaml` のような別綴りの
    // 同一ファイルを弾けず、「output kubeconfig と管理者 kubeconfig の分離」assert
    // （文字列の != 比較）が素通りしてしまう。
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const pathAssert = asserts.find((task) => (task.name ?? '').includes('cluster access paths'))
    expect(pathAssert).toBeDefined()
    const that = (moduleArgs(pathAssert!, 'assert') as Record<string, unknown>).that
    const thatLines = (Array.isArray(that) ? that : [that]).map((v) => String(v))

    const kubeconfigMatch = thatLines.find((l) =>
      l.startsWith('e2e_runner_k8s_kubeconfig is match('),
    )
    expect(kubeconfigMatch).toBeDefined()
    const pattern = kubeconfigMatch!.match(/is match\('(\^.*\$)'\)/)?.[1]
    expect(pattern).toBeDefined()
    const regex = new RegExp(pattern!)

    expect(regex.test('/etc/rancher/k3s/k3s.yaml')).toBe(true)
    expect(regex.test('/etc/rancher/k3s/./k3s.yaml')).toBe(false)
    expect(regex.test('/etc/rancher/k3s/../k3s.yaml')).toBe(false)
    expect(regex.test('/etc/rancher/k3s//k3s.yaml')).toBe(false)

    // regex の否定先読みだけに頼らず、'..' 明示チェックも二重に存在する
    // （バックスラッシュエスケープの解釈違いに対する保険。342192a のコメント参照）。
    expect(thatLines.some((l) => l === "'..' not in e2e_runner_k8s_kubeconfig")).toBe(true)
  })

  it('namespace は "e2e" または "e2e-" prefix のみ許可し、既存の重要 namespace を指定できない', () => {
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const nsAssert = asserts.find((task) => (task.name ?? '').includes('e2e prefix'))
    expect(nsAssert).toBeDefined()
    const that = (moduleArgs(nsAssert!, 'assert') as Record<string, unknown>).that
    const thatLines = (Array.isArray(that) ? that : [that]).map((v) => String(v))
    const nsMatch = thatLines.find((l) => l.startsWith('e2e_runner_k8s_namespace is match('))
    expect(nsMatch).toBeDefined()
    const pattern = nsMatch!.match(/is match\('(\^.*\$)'\)/)?.[1]
    expect(pattern).toBeDefined()
    const regex = new RegExp(pattern!)

    expect(regex.test('e2e')).toBe(true)
    expect(regex.test('e2e-staging')).toBe(true)
    expect(regex.test('kube-system')).toBe(false)
    expect(regex.test('ai-support-agent')).toBe(false)
    expect(regex.test('default')).toBe(false)

    // defaults の既定値 "e2e" 自体がこの assert を満たすことも固定する。
    const defaults = load(readDefaults(), { schema: DEFAULT_SCHEMA }) as Record<string, unknown>
    expect(regex.test(String(defaults.e2e_runner_k8s_namespace))).toBe(true)
  })

  it('namespace 作成後に Pod Security Standard baseline を enforce するラベルを付与する', () => {
    const tasks = parseTasks()
    const labelTask = tasks.find((t) => (t.name ?? '').includes('Pod Security Standard'))
    expect(labelTask).toBeDefined()
    const argv = (moduleArgs(labelTask!, 'command') as Record<string, unknown> | undefined)?.argv
    expect(Array.isArray(argv)).toBe(true)
    const argvText = (argv as unknown[]).join(' ')
    expect(argvText).toContain('label')
    expect(argvText).toContain('namespace')
    expect(argvText).toContain('pod-security.kubernetes.io/enforce=baseline')
    expect(argvText).toContain('--overwrite')
  })

  it('ServiceAccount トークンを kubectl のコマンドライン引数（argv）として渡さない（ps 経由の露出防止）', () => {
    // `kubectl config set-credentials --token=$VAR` は値がそのプロセスの argv として
    // 展開され、実行中は同一ホスト上の他プロセスから ps で観測できてしまう
    // （このロールが Secret 作成に --from-literal= ではなく --from-file= を使う
    // 理由と同じ脅威モデル）。kubeconfig は heredoc で直接書き出す方式でなければならない。
    const content = stripComments(readTasks())
    expect(content).not.toContain('config set-credentials')
    expect(content).not.toMatch(/--token=/)

    const kubeconfigGenTask = parseTasks().find((t) =>
      (t.name ?? '').includes('scoped kubeconfig'),
    )
    expect(kubeconfigGenTask).toBeDefined()
    const script = stringArg(kubeconfigGenTask!, 'shell') ?? ''
    expect(script).toContain('<<KUBECONFIG_EOF')
    expect(script).toContain('$E2E_TOKEN')
    expect(script).not.toContain('--token')
  })

  it('manifest_dir は /etc/e2e-runner/ 配下に限定される', () => {
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const manifestDirAssert = asserts.find((task) =>
      (task.name ?? '').includes('manifest directory is confined'),
    )
    expect(manifestDirAssert).toBeDefined()
    const that = (moduleArgs(manifestDirAssert!, 'assert') as Record<string, unknown>).that
    const thatLines = (Array.isArray(that) ? that : [that]).map((v) => String(v))
    const dirMatch = thatLines.find((l) => l.startsWith('e2e_runner_k8s_manifest_dir is match('))
    expect(dirMatch).toBeDefined()
    const pattern = dirMatch!.match(/is match\('(\^.*\$)'\)/)?.[1]
    expect(pattern).toBeDefined()
    const regex = new RegExp(pattern!)

    expect(regex.test('/etc/e2e-runner/k8s')).toBe(true)
    expect(regex.test('/etc')).toBe(false)
    expect(regex.test('/etc/rancher/k3s')).toBe(false)
    expect(regex.test('/etc/e2e-runner/./k8s')).toBe(false)

    const defaults = load(readDefaults(), { schema: DEFAULT_SCHEMA }) as Record<string, unknown>
    expect(regex.test(String(defaults.e2e_runner_k8s_manifest_dir))).toBe(true)
  })

  it('output kubeconfigディレクトリは root:mbc 0750 で、mbc は書き込めない（symlink TOCTOU対策）', () => {
    const tasks = parseTasks()
    const dirTask = tasks.find((t) => (t.name ?? '').includes('output kubeconfig directory exists'))
    expect(dirTask).toBeDefined()
    const args = moduleArgs(dirTask!, 'file') as Record<string, unknown>
    expect(args.owner).toBe('root')
    expect(args.group).toBe('mbc')
    expect(args.mode).toBe('0750')
  })

  it('ServiceAccountトークン待機のretries/delay_secondsは1〜30の範囲の整数であることをassertする', () => {
    const asserts = parseTasks().filter((task) => moduleArgs(task, 'assert') !== undefined)
    const waitSettingsAssert = asserts.find((task) =>
      (task.name ?? '').includes('token wait settings are bounded integers'),
    )
    expect(waitSettingsAssert).toBeDefined()
    const that = (moduleArgs(waitSettingsAssert!, 'assert') as Record<string, unknown>).that
    const thatLines = (Array.isArray(that) ? that : [that]).map((v) => String(v))

    const retriesMatch = thatLines.find((l) =>
      l.startsWith('e2e_runner_k8s_token_secret_retries is match('),
    )
    const delayMatch = thatLines.find((l) =>
      l.startsWith('e2e_runner_k8s_token_secret_delay_seconds is match('),
    )
    expect(retriesMatch).toBeDefined()
    expect(delayMatch).toBeDefined()

    for (const match of [retriesMatch, delayMatch]) {
      const pattern = match!.match(/is match\('(\^.*\$)'\)/)?.[1]
      expect(pattern).toBeDefined()
      const regex = new RegExp(pattern!)
      expect(regex.test('10')).toBe(true)
      expect(regex.test('0')).toBe(true)
      expect(regex.test('-1')).toBe(false)
      expect(regex.test('1.5')).toBe(false)
      expect(regex.test('abc')).toBe(false)
    }

    // 範囲チェック自体(charsetの正規表現とは別のthat行)が上限・下限を持つことを検証する。
    expect(
      thatLines.some((l) => l.includes('e2e_runner_k8s_token_secret_retries | int >= 1')),
    ).toBe(true)
    expect(
      thatLines.some((l) => l.includes('e2e_runner_k8s_token_secret_retries | int <= 30')),
    ).toBe(true)
    expect(
      thatLines.some((l) => l.includes('e2e_runner_k8s_token_secret_delay_seconds | int >= 1')),
    ).toBe(true)
    expect(
      thatLines.some((l) => l.includes('e2e_runner_k8s_token_secret_delay_seconds | int <= 30')),
    ).toBe(true)
  })

  it('manifest_dirが既にsymlinkとして存在する場合を検知して停止する', () => {
    const tasks = parseTasks()
    const idxCheck = tasks.findIndex((t) =>
      (t.name ?? '').includes('manifest directory is not a pre-existing symlink'),
    )
    const idxFail = tasks.findIndex((t) =>
      (t.name ?? '').includes('Fail if the manifest directory path is a symlink'),
    )
    const idxEnsure = tasks.findIndex((t) => (t.name ?? '').includes('manifest directory exists'))
    expect(idxCheck).toBeGreaterThanOrEqual(0)
    expect(idxFail).toBeGreaterThan(idxCheck)
    expect(idxEnsure).toBeGreaterThan(idxFail)

    const statArgs = moduleArgs(tasks[idxCheck], 'stat') as Record<string, unknown>
    expect(statArgs.follow).toBe(false)

    const failWhen = String(tasks[idxFail].when)
    expect(failWhen).toContain('islnk')
  })

  it('output kubeconfigのディレクトリ・ファイル双方が既にsymlinkとして存在する場合を検知して停止する', () => {
    const tasks = parseTasks()
    const idxDirCheck = tasks.findIndex((t) =>
      (t.name ?? '').includes('output kubeconfig directory is not a pre-existing symlink'),
    )
    const idxDirFail = tasks.findIndex((t) =>
      (t.name ?? '').includes('Fail if the output kubeconfig directory path is a symlink'),
    )
    const idxEnsureDir = tasks.findIndex((t) =>
      (t.name ?? '').includes('output kubeconfig directory exists'),
    )
    const idxFileCheck = tasks.findIndex((t) =>
      (t.name ?? '').includes('output kubeconfig path itself is not a pre-existing symlink'),
    )
    const idxFileFail = tasks.findIndex((t) =>
      (t.name ?? '').includes('Fail if the output kubeconfig path is a symlink'),
    )
    const idxGenerate = tasks.findIndex((t) => (t.name ?? '').includes('Generate the scoped kubeconfig'))

    expect(idxDirCheck).toBeGreaterThanOrEqual(0)
    expect(idxDirFail).toBeGreaterThan(idxDirCheck)
    expect(idxEnsureDir).toBeGreaterThan(idxDirFail)
    expect(idxFileCheck).toBeGreaterThan(idxEnsureDir)
    expect(idxFileFail).toBeGreaterThan(idxFileCheck)
    expect(idxGenerate).toBeGreaterThan(idxFileFail)

    expect((moduleArgs(tasks[idxDirCheck], 'stat') as Record<string, unknown>).follow).toBe(false)
    expect((moduleArgs(tasks[idxFileCheck], 'stat') as Record<string, unknown>).follow).toBe(false)
    expect(String(tasks[idxDirFail].when)).toContain('islnk')
    expect(String(tasks[idxFileFail].when)).toContain('islnk')
  })
})
