import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

import { ENV_VARS } from '../../src/constants'

/**
 * ai_support_agent_k8s bundled role（agent/ansible/roles/ai_support_agent_k8s）の静的検証。
 *
 * このロールは kubectl / kubeconfig を持つノード上で動き、エージェントを
 * **StatefulSet** としてクラスタへ配置する。ホスト常駐の `ai_support_agent`
 * （nvm 依存・systemd ユーザーサービス）とは配送経路が異なる別ロールである。
 *
 * StatefulSet を選ぶ理由（Deployment ではなく）:
 *   1. `volumeClaimTemplates` によりレプリカごとに専用 PVC が発行される。1つの
 *      PVC を共有する形では RWO が Multi-Attach で衝突し、RWX にしても全レプリカが
 *      同じワークスペース（git clone / ワークツリー）を踏み合って壊れる。
 *   2. Pod 名が序数で固定されるため、downward API で注入する
 *      `AI_SUPPORT_AGENT_INSTANCE_ID` が再スケジュールをまたいで安定する。
 *
 * 実機のクラスタ適用挙動は jest では検証できないため、ここでは
 * (1) defaults の既定値、(2) タスク列の構造、(3) 秘匿トークンの取り回し、
 * (4) 生成マニフェストが両分岐（永続化 on/off）で妥当な YAML になること、
 * (5) `manifest-generator.ts` との環境変数パリティ、を固定する。
 */
describe('ai_support_agent_k8s bundled role', () => {
  const roleDir = path.join(
    __dirname,
    '..',
    '..',
    'ansible',
    'roles',
    'ai_support_agent_k8s',
  )

  function readRaw(...segments: string[]): string {
    return readFileSync(path.join(roleDir, ...segments), 'utf8')
  }

  function loadYaml(...segments: string[]): unknown {
    return load(readRaw(...segments))
  }

  type Task = Record<string, any>

  function tasks(): Task[] {
    return loadYaml('tasks', 'main.yml') as Task[]
  }

  /** ネストした block/rescue/always も含めて全タスクを平坦化する。 */
  function allTasks(): Task[] {
    const out: Task[] = []
    const walk = (list: Task[]) => {
      for (const task of list) {
        out.push(task)
        for (const key of ['block', 'rescue', 'always']) {
          if (Array.isArray(task[key])) walk(task[key])
        }
      }
    }
    walk(tasks())
    return out
  }

  /** StatefulSet マニフェストを書き出す copy タスクの `content` を取り出す。 */
  function manifestTemplate(): string {
    const task = allTasks().find((t) => {
      const copy = t['ansible.builtin.copy']
      return typeof copy?.content === 'string' && copy.content.includes('StatefulSet')
    })
    expect(task).toBeDefined()
    return task!['ansible.builtin.copy'].content as string
  }

  /**
   * Jinja を落として素の YAML に還元する簡易レンダラ。
   *
   * `{% if ai_support_agent_k8s_persistence %}` ブロックを分岐ごとに展開し、
   * `{{ ... }}` はプレースホルダのスカラーへ置換する。目的は値の正しさではなく
   * **インデントと構造**の検証（永続化 on/off のどちらかだけ壊れている、という
   * 事故を検出する）。
   */
  function renderManifest(template: string, persistence: boolean): unknown {
    const lines = template.split('\n')
    const kept: string[] = []
    let skipping = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('{% if ')) {
        skipping = !persistence
        continue
      }
      if (trimmed === '{% endif %}') {
        skipping = false
        continue
      }
      if (!skipping) kept.push(line)
    }
    // すべての式を同一の 'PLACEHOLDER' に潰すと「別々の変数を参照していても
    // 一致してしまう」ため、値の対応関係を検証するテスト（CONFIG_DIR と
    // mountPath の一致など）が素通りする。式ごとに一意な値を割り当て、
    // **同じ式は同じ値**になるようにする。
    const seen = new Map<string, string>()
    const rendered = kept.join('\n').replace(/\{\{([^}]*)\}\}/g, (_m, expr) => {
      const key = String(expr).trim()
      if (/\|\s*int\s*$/.test(key)) return '1'
      if (!seen.has(key)) seen.set(key, `expr-${seen.size}`)
      return seen.get(key)!
    })
    return load(rendered)
  }

  describe('defaults/main.yml', () => {
    const defaults = () => loadYaml('defaults', 'main.yml') as Record<string, unknown>

    it('秘匿値・必須値をハードコードせず空で定義する', () => {
      expect(defaults().ai_support_agent_k8s_token ?? '').toBe('')
      expect(defaults().ai_support_agent_k8s_project ?? '').toBe('')
    })

    it('レプリカ数の既定は1、永続化は既定オフ（オプトイン）', () => {
      expect(defaults().ai_support_agent_k8s_replicas).toBe(1)
      expect(defaults().ai_support_agent_k8s_persistence).toBe(false)
    })

    it('kubectl / kubeconfig の既定値が k3s の標準パスである', () => {
      expect(defaults().ai_support_agent_k8s_kubeconfig).toBe(
        '/etc/rancher/k3s/k3s.yaml',
      )
      expect(defaults().ai_support_agent_k8s_kubectl).toBe('/usr/local/bin/kubectl')
    })

    it('既定イメージは公式の GHCR イメージである', () => {
      expect(defaults().ai_support_agent_k8s_image).toMatch(
        /^ghcr\.io\/mbc-net\/ai-support-agent-cli:/,
      )
    })

    it('永続化のストレージ既定は Longhorn である', () => {
      expect(defaults().ai_support_agent_k8s_storage_class).toBe('longhorn')
      expect(String(defaults().ai_support_agent_k8s_storage_size)).toMatch(/^\d+[GM]i$/)
    })
  })

  describe('tasks/main.yml の構造', () => {
    it('タスク列（配列）としてパースできる', () => {
      expect(Array.isArray(tasks())).toBe(true)
      expect(tasks().length).toBeGreaterThan(0)
    })

    it('必須変数（token / project）の未設定を assert で検出する', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('ai_support_agent_k8s_token')
      expect(raw).toContain('ai_support_agent_k8s_project')
      const asserts = allTasks().filter((t) => t['ansible.builtin.assert'])
      expect(asserts.length).toBeGreaterThanOrEqual(2)
    })

    it('assert タスクに no_log を付けない（案内メッセージを潰さない）', () => {
      // 横断 spec（ansible-roles-assert-guidance）と同じ不変条件をこのロールでも明示する。
      for (const task of allTasks()) {
        if (task['ansible.builtin.assert'] && !task.loop) {
          expect(task.no_log).toBeUndefined()
        }
      }
    })

    it('kubectl / kubeconfig の不在を専用の assert で案内する', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('ansible.builtin.stat')
      expect(raw).toMatch(/kubectl/)
      expect(raw).toMatch(/kubeconfig/)
    })
  })

  describe('秘匿トークンの取り回し', () => {
    it('トークンを Ansible の environment: キーワードで渡さない', () => {
      // `environment:` は -vvv の EXEC トレースへ平文で出力され no_log でも抑止できない
      // （既存ロールのヘッダコメントに実測結果あり）。
      for (const task of allTasks()) {
        const env = task.environment
        if (!env) continue
        expect(JSON.stringify(env)).not.toContain('ai_support_agent_k8s_token')
      }
    })

    it('トークンを shell / command の本文へ Jinja 展開しない', () => {
      // 検出したいのはトークン「値」の展開のみ。一時ファイルのパスを指す
      // `ai_support_agent_k8s_token_tempfile.path` は秘匿値ではなく、むしろ
      // 正しい受け渡し経路そのものなので、識別子の境界で区別する。
      const TOKEN_VALUE_REF = /ai_support_agent_k8s_token(?![_A-Za-z0-9])/
      for (const task of allTasks()) {
        const shell = task['ansible.builtin.shell']
        const command = task['ansible.builtin.command']
        const body = JSON.stringify(shell ?? command ?? '')
        expect(body).not.toMatch(TOKEN_VALUE_REF)
      }
    })

    it('トークンは copy の content で 0600 の一時ファイルへ書き出される', () => {
      const writer = allTasks().find((t) => {
        const copy = t['ansible.builtin.copy']
        return (
          typeof copy?.content === 'string' &&
          copy.content.includes('ai_support_agent_k8s_token')
        )
      })
      expect(writer).toBeDefined()
      expect(String(writer!['ansible.builtin.copy'].mode)).toBe('0600')
      // 非ループの copy は content をモジュール自身が秘匿するため no_log を付けない
      // （付けると失敗理由だけが消える。ansible-roles-no-log-diagnostics 参照）。
      expect(writer!.no_log).toBeUndefined()
    })

    it('トークンは trim してから書き出す（前後の空白・改行が Secret に混入しない）', () => {
      // ホスト常駐の ai_support_agent ロールは `$(cat file)` で読むためシェルが末尾
      // 改行を落とすが、こちらは `--from-file=` でファイルの中身がそのまま Secret の
      // 値になる。ANSIBLE# 変数の入力に改行が1文字混ざるだけで、エージェントは
      // 「トークンは存在するのに 401」という切り分けの難しい失敗をする。
      const writer = allTasks().find((t) => {
        const copy = t['ansible.builtin.copy']
        return (
          typeof copy?.content === 'string' &&
          copy.content.includes('ai_support_agent_k8s_token')
        )
      })
      expect(writer!['ansible.builtin.copy'].content).toMatch(/\|\s*trim\s*\}\}/)
    })

    it('一時ファイルは失敗時も必ず削除される（block/always）', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('always:')
      const removal = allTasks().find(
        (t) => t['ansible.builtin.file']?.state === 'absent',
      )
      expect(removal).toBeDefined()
    })

    it('Secret は create --dry-run=client | apply で冪等に適用する', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('create secret generic')
      expect(raw).toContain('--dry-run=client')
      expect(raw).toContain('--from-file=')
    })

    it('Secret 名は StatefulSet 名から導出し、マニフェストは secretKeyRef のみを持つ', () => {
      const template = manifestTemplate()
      expect(template).toContain('secretKeyRef')
      // マニフェスト自体にはトークンが載らない（Secret は別タスクで作る）。
      expect(template).not.toContain('ai_support_agent_k8s_token')
    })
  })

  describe('生成マニフェスト', () => {
    it('Deployment ではなく StatefulSet を生成する', () => {
      const template = manifestTemplate()
      expect(template).toContain('kind: StatefulSet')
      expect(template).not.toContain('kind: Deployment')
    })

    it('永続化オフでも妥当な YAML で、volumeClaimTemplates を持たない', () => {
      const doc = renderManifest(manifestTemplate(), false) as any
      expect(doc.kind).toBe('StatefulSet')
      expect(doc.spec.volumeClaimTemplates).toBeUndefined()
      expect(doc.spec.template.spec.containers[0].volumeMounts).toBeUndefined()
    })

    it('永続化オンでは volumeClaimTemplates と volumeMounts が対になる', () => {
      const doc = renderManifest(manifestTemplate(), true) as any
      expect(doc.kind).toBe('StatefulSet')
      const templates = doc.spec.volumeClaimTemplates
      expect(Array.isArray(templates)).toBe(true)
      expect(templates).toHaveLength(1)
      expect(templates[0].spec.accessModes).toEqual(['ReadWriteOnce'])

      const mounts = doc.spec.template.spec.containers[0].volumeMounts
      expect(Array.isArray(mounts)).toBe(true)
      // マウント名と PVC テンプレート名が一致していないと Pod が起動しない。
      expect(mounts[0].name).toBe(templates[0].metadata.name)
    })

    it('レプリカ識別子を downward API（Pod 名）で注入する', () => {
      const doc = renderManifest(manifestTemplate(), false) as any
      const env = doc.spec.template.spec.containers[0].env as any[]
      const instanceId = env.find((e) => e.name === ENV_VARS.INSTANCE_ID)
      expect(instanceId).toBeDefined()
      expect(instanceId.valueFrom.fieldRef.fieldPath).toBe('metadata.name')
    })

    it('環境変数名が manifest-generator と同じ ENV_VARS 定数に一致する', () => {
      // 生成系が web / agent CLI / このロールの3系統になったため、名前の食い違いは
      // 「起動するが認証されない」形でしか現れない。定数に固定する。
      const doc = renderManifest(manifestTemplate(), false) as any
      const env = doc.spec.template.spec.containers[0].env as any[]
      const names = env.map((e) => e.name)
      expect(names).toContain(ENV_VARS.TOKEN)
      expect(names).toContain(ENV_VARS.INSTANCE_ID)
      expect(names).toContain(ENV_VARS.API_URL)
    })

    it('トークンは args ではなく Secret 参照で渡す', () => {
      const doc = renderManifest(manifestTemplate(), false) as any
      const container = doc.spec.template.spec.containers[0]
      expect(JSON.stringify(container.args ?? [])).not.toContain('token')
      const env = container.env as any[]
      const token = env.find((e) => e.name === ENV_VARS.TOKEN)
      expect(token.valueFrom.secretKeyRef).toBeDefined()
      expect(token.value).toBeUndefined()
    })

    it('StatefulSet に serviceName が指定されている（必須フィールド）', () => {
      const doc = renderManifest(manifestTemplate(), false) as any
      expect(typeof doc.spec.serviceName).toBe('string')
      expect(doc.spec.serviceName.length).toBeGreaterThan(0)
    })
  })

  describe('レビュー指摘の回帰（HIGH）', () => {
    it('永続ボリュームはエージェントが実際に書き込むデータディレクトリにマウントされる', () => {
      // エージェントは $HOME/.ai-support-agent/projects/<tenant>/<project>/workspace/... に
      // 書き込む（config-manager.ts の getConfigDir / project-dir.ts の
      // getDefaultProjectDirTemplate）。無関係なパスに PVC をマウントすると、
      // 「PVC は作られるが中身は空、実データは Pod 再作成で消える」という
      // **成功したように見える無効化**になる。CONFIG_DIR をマウント先へ明示的に
      // 向けることで、コンテナの HOME に依存せず確実に PVC 配下へ落とす。
      const doc = renderManifest(manifestTemplate(), true) as any
      const container = doc.spec.template.spec.containers[0]
      const env = container.env as any[]
      const configDir = env.find((e) => e.name === ENV_VARS.CONFIG_DIR)
      expect(configDir).toBeDefined()
      expect(container.volumeMounts[0].mountPath).toBe(configDir.value)
    })

    it('永続化オフでもデータディレクトリを明示する（有効化しても保存先が変わらない）', () => {
      const doc = renderManifest(manifestTemplate(), false) as any
      const env = doc.spec.template.spec.containers[0].env as any[]
      expect(env.map((e) => e.name)).toContain(ENV_VARS.CONFIG_DIR)
    })

    it('マニフェスト内の文字列展開はすべて to_json を通す（YAML構造インジェクション対策）', () => {
      // `value: "{{ var }}"` のように手書きのクォートへ素の値を差し込むと、`"` と改行を
      // 含む値でスカラーを閉じられ、同じ StatefulSet に任意のコンテナや securityContext を
      // 注入できる（イメージ許可リストの迂回になる）。manifest-generator.ts が
      // `yamlScalar()`（JSON.stringify）で行っているのと同じ防御を Jinja 側でも行う。
      const template = manifestTemplate()
      const interpolations = template.match(/\{\{[^}]*\}\}/g) ?? []
      expect(interpolations.length).toBeGreaterThan(0)
      for (const expr of interpolations) {
        expect(expr).toMatch(/\|\s*(to_json|int)\s*\}\}/)
      }
    })

    it('永続化トグルは | bool を通す（ANSIBLE#変数の文字列 "false" が truthy にならない）', () => {
      const template = manifestTemplate()
      const conditions = template.match(/\{%\s*if[^%]*%\}/g) ?? []
      expect(conditions.length).toBeGreaterThan(0)
      for (const cond of conditions) {
        expect(cond).toMatch(/\|\s*bool\s*%\}/)
      }
    })

    it('レプリカ数の検証は型ではなく値で比較する（ANSIBLE#変数由来の "3" を誤って弾かない）', () => {
      // ANSIBLE# 変数は文字列で渡るため、`x | int == x` のような型込みの比較にすると
      // 有効な "3" が「must be a positive integer」で拒否される。
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).not.toMatch(/ai_support_agent_k8s_replicas \| int == ai_support_agent_k8s_replicas\s*$/m)
      expect(raw).toMatch(/ai_support_agent_k8s_replicas \| int \| string ==/)
    })

    it('Secret が変化したときは StatefulSet を再起動する（トークンローテーションの反映）', () => {
      // Secret を更新しても、起動済みコンテナの env（secretKeyRef 由来）は更新されず、
      // StatefulSet の Pod template も変化しないため rollout は走らない。失効した
      // トークンを差し替えて再実行しても、Pod は旧トークンで接続し続ける。
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('rollout')
      expect(raw).toContain('restart')
      const restart = allTasks().find((t) => {
        const argv = t['ansible.builtin.command']?.argv
        return Array.isArray(argv) && argv.includes('restart')
      })
      expect(restart).toBeDefined()
      // 「when がある」だけでは `when: false` でも通ってしまう。この2条件 AND こそが
      // 修正の核心（ローテーション時のみ再起動し、初回作成時は再起動しない）なので、
      // 条件の中身まで固定する。
      expect(restart!.when).toEqual([
        expect.stringContaining('ai_support_agent_k8s_secret_apply.changed'),
        expect.stringContaining("'created' not in"),
      ])
    })

    it('Secret 適用タスクは kubectl の出力から changed を判定する（毎回 changed にしない）', () => {
      const secretApply = allTasks().find((t) => {
        const shell = t['ansible.builtin.shell']
        return typeof shell === 'string' && shell.includes('create secret generic')
      })
      expect(secretApply).toBeDefined()
      expect(secretApply!.register).toBeDefined()
      // 「true でない」だけでは常に false でも通る。kubectl apply の出力仕様
      //（created / configured / unchanged）に沿った判定であることを固定する。
      expect(String(secretApply!.changed_when)).toContain("'unchanged' not in")
    })

    it('すべての kubectl 呼び出しに --request-timeout を付ける（応答不能時のハング防止）', () => {
      // クライアント側タイムアウトが無いと、クラスタが応答不能なときタスクが無限に
      // ハングし、server-setup 実行が running のまま進捗しない（失敗にすらならない）。
      for (const task of allTasks()) {
        const shell = task['ansible.builtin.shell']
        const argv = task['ansible.builtin.command']?.argv
        const body =
          typeof shell === 'string' ? shell : Array.isArray(argv) ? argv.join(' ') : ''
        if (!body.includes('kubectl') && !body.includes('_kubectl')) continue
        // 1つの shell 本文が kubectl を複数回起動する（`create ... | apply -f -`）。
        // 「本文のどこかに1つあればよい」だと、パイプ後段の apply だけ落ちても
        // 検出できない。kubectl 起動ごとに検証する。
        const invocations = body
          .split(/\||&&/)
          .filter((seg) => /kubectl/.test(seg))
        expect(invocations.length).toBeGreaterThan(0)
        for (const seg of invocations) {
          expect(seg).toContain('--request-timeout')
        }
      }
    })
  })

  describe('レビュー指摘の回帰（2巡目）', () => {
    it('args は CLI の実行ファイル名から始まる（entrypoint の exec "$@" に渡るため）', () => {
      // 公式イメージは ENTRYPOINT ["/entrypoint.sh"] のみ（CMD なし）で、
      // entrypoint.sh は末尾で `exec "$@"` する。args の先頭がサブコマンド名だと
      // `exec start --project ...` となり、`start` という実行ファイルは存在しないため
      // exit 127 で CrashLoopBackOff になる。
      const bin = Object.keys(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../../package.json').bin as Record<string, string>,
      )[0]
      const doc = renderManifest(manifestTemplate(), false) as any
      const args = doc.spec.template.spec.containers[0].args as string[]

      // 先頭数要素だけの部分検証にすると、途中のフラグ欠落を見逃す。
      // `--no-docker` が無いと、Commander の negated option により
      // `opts.docker === true` となってコンテナの中でさらに runInDocker() へ入り、
      // Docker ソケット不在で起動に失敗する（exit 127 が別の失敗に置き換わるだけ）。
      // agent CLI の CONTAINER_START_ARGV と同じ契約であること。
      expect(args).toEqual([bin, 'start', '--no-docker', '--project', 'expr-3'])
    })

    it('ServiceAccount トークンを自動マウントしない', () => {
      // このエージェントは Kubernetes API を使わない。default ServiceAccount に
      // RoleBinding が付いているクラスタでは、エージェントが実行する任意コマンドから
      // クラスタ権限を悪用できてしまう。
      const doc = renderManifest(manifestTemplate(), false) as any
      expect(doc.spec.template.spec.automountServiceAccountToken).toBe(false)
    })

    it('kubectl apply 系タスクの changed 判定が一貫している', () => {
      // namespace だけ 'created' 判定だと、将来ラベル等を足したときに
      // 'configured' が changed=false と誤報告される。
      for (const task of allTasks()) {
        const cw = task.changed_when
        if (typeof cw !== 'string' || !cw.includes('stdout')) continue
        expect(cw).toContain("'unchanged' not in")
      }
    })
  })

  describe('入力値の検証（ロール内 assert）', () => {
    it('イメージの許可リストは assert 内のインラインリテラルで、role 変数にしない', () => {
      // 許可リストを role 変数にすると、レシピの task-level vars から許可リストごと
      // 上書きされて検証が無効化される（CLAUDE.md のセキュリティ規約）。
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('ghcr.io/mbc-net/ai-support-agent-cli')
      const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
      expect(defaults.ai_support_agent_k8s_image_allowlist).toBeUndefined()
      expect(defaults.ai_support_agent_k8s_allowed_images).toBeUndefined()
    })

    it('namespace / name を DNS-1123 ラベルとして検証する', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toContain('a-z0-9')
    })

    it('project は tenantCode/projectCode の形を検証する', () => {
      const raw = readRaw('tasks', 'main.yml')
      expect(raw).toMatch(/ai_support_agent_k8s_project\b[\s\S]{0,400}match/)
    })
  })
})
