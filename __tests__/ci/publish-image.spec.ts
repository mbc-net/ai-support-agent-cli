import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `ci-cd.yml` のコンテナイメージ公開ジョブ（`publish_image`）の静的検証。
 *
 * このジョブは `ghcr.io/mbc-net/ai-support-agent-cli` を発行する唯一の経路であり、
 * `manifest-generator.ts` の `DEFAULT_AGENT_IMAGE` が指す先そのものである。
 * ここが壊れると、生成マニフェストを適用したユーザーが ImagePullBackOff になる
 * （ワークフロー追加前は実際にその状態だった）。
 *
 * ワークフローは jest から実行できないため、YAML として満たすべき不変条件を固定する。
 * 特に重要なのは次の 3 点で、いずれも壊れても CI は緑のまま通ってしまう:
 *   - npm 公開の完了後に走ること（Dockerfile が npm から CLI を取得するため）
 *   - タグ由来のバージョンが `AGENT_VERSION` に渡ること（`latest` 固定だと別物が入る）
 *   - `latest` タグが正式リリース時のみ動くこと（beta が latest を奪わない）
 */
describe('ci-cd.yml: publish_image ジョブ', () => {
  const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci-cd.yml')
  const raw = readFileSync(workflowPath, 'utf8')
  const workflow = load(raw, { schema: DEFAULT_SCHEMA }) as Record<string, any>
  const job = () => workflow.jobs?.publish_image as Record<string, any> | undefined
  /** タグ付け（manifest list の作成）を担当するジョブ。 */
  const manifestJob = () =>
    workflow.jobs?.publish_image_manifest as Record<string, any> | undefined

  /** ジョブ内の全ステップを 1 本の文字列に畳む（`with` や `run` を横断して検索するため）。 */
  function jobText(): string {
    return JSON.stringify(job() ?? {})
  }

  /** ビルドとタグ付けの両ジョブを合わせた全文（どちらに置かれても検出する）。 */
  function allText(): string {
    return JSON.stringify({ build: job() ?? {}, manifest: manifestJob() ?? {} })
  }

  it('publish_image ジョブが存在する', () => {
    expect(Object.keys(workflow.jobs ?? {})).toContain('publish_image')
  })

  it('npm 公開（publish ジョブ）の完了後に実行される', () => {
    // Dockerfile は `npm install -g @ai-support-agent/cli@${AGENT_VERSION}` で
    // npm レジストリから取得する。publish より先に走ると、そのバージョンはまだ存在しない。
    const needs = job()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish')
  })

  it('タグ push のときだけ実行される', () => {
    expect(String(job()?.if ?? '')).toContain("startsWith(github.ref, 'refs/tags/')")
  })

  it('GHCR へ push するための packages: write 権限を持つ', () => {
    expect(job()?.permissions?.packages).toBe('write')
  })

  it('タグ由来のバージョンを AGENT_VERSION に渡す（latest 固定にしない）', () => {
    const text = jobText()
    expect(text).toContain('AGENT_VERSION=')
    // タグから抽出した値を参照していること。素の `AGENT_VERSION=latest` は不可。
    expect(text).toMatch(/AGENT_VERSION=\$\{\{[^}]*version[^}]*\}\}/)
    expect(text).not.toMatch(/AGENT_VERSION=latest/)
  })

  it('amd64 と arm64 の両方を発行する', () => {
    const text = jobText()
    expect(text).toContain('amd64')
    expect(text).toContain('arm64')
  })

  it('アーキテクチャ別のイメージを結合するジョブがビルド後に走る', () => {
    const needs = manifestJob()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish_image')
    expect(manifestJob()?.permissions?.packages).toBe('write')
  })

  it('バージョンとチャンネルを publish ジョブの出力として公開している', () => {
    // 下流で再計算するとコンテナタグが npm の dist-tag とずれる余地が生まれる。
    const outputs = workflow.jobs?.publish?.outputs ?? {}
    expect(String(outputs.version ?? '')).toContain('steps.version.outputs.version')
    expect(String(outputs.channel_tag ?? '')).toContain('steps.release-type.outputs.tag')
  })

  it('publish ジョブの release-type 判定が beta / alpha / latest を区別する', () => {
    const publishText = JSON.stringify(workflow.jobs?.publish ?? {})
    expect(publishText).toContain('beta')
    expect(publishText).toContain('alpha')
    expect(publishText).toContain('prerelease')
  })

  it('不変のバージョンタグを必ず発行する', () => {
    // `latest` だけだと過去のリリースを再現できない。
    const text = JSON.stringify(manifestJob() ?? {})
    expect(text).toContain('needs.publish.outputs.version')
    expect(text).toMatch(/\$\{IMAGE\}:\$\{VERSION\}/)
  })

  it('移動タグは publish ジョブの決定を参照する（latest を直書きしない）', () => {
    // beta リリースで `latest` が動くと、既定値 `:latest` を使う全ユーザーが
    // プレリリース版を引くことになる。移動タグは move_channel_tag ジョブだけが動かす。
    const text = JSON.stringify(workflow.jobs?.move_channel_tag ?? {})
    expect(text).toContain('needs.publish.outputs.channel_tag')
    expect(text).toMatch(/\$\{IMAGE\}:\$\{CHANNEL_TAG\}/)
    // タグ名をワークフロー内で直書きしていないこと。
    expect(raw).not.toMatch(/\$\{IMAGE\}:latest/)
  })

  it('manifest ジョブは publish の出力を参照できるよう needs に publish を含む', () => {
    const needs = manifestJob()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish')
  })

  it('イメージ名が manifest-generator の DEFAULT_AGENT_IMAGE と一致する', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_AGENT_IMAGE } = require('../../src/manifest/manifest-generator')
    const repository = String(DEFAULT_AGENT_IMAGE).split(':')[0]
    expect(repository).toBe('ghcr.io/mbc-net/ai-support-agent-cli')
    // ワークフローが発行する先がその参照先とずれていないこと。
    expect(allText().toLowerCase()).toContain(repository.toLowerCase())
  })
})

/**
 * タグ run を「再実行可能」に保つための不変条件。
 *
 * v0.5.15-beta.0（run 37213081596）では、npm 公開と GitHub Release の作成後に
 * publish ジョブ末尾の「API へのバージョン通知」が CloudFront の地域制限で 403 になった。
 * publish ジョブが失敗扱いになったため publish_image / publish_image_manifest がスキップされ、
 * 再実行は npm publish の E403（同一バージョンの再公開不可）で必ず失敗した。
 *   - 通知は publish から切り離し、イメージ発行の前提にしない
 *   - npm publish は「同じコミットから公開済み」ならスキップする（冪等化）
 */
describe('ci-cd.yml: タグ run の再実行可能性', () => {
  const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci-cd.yml')
  const workflow = load(readFileSync(workflowPath, 'utf8'), { schema: DEFAULT_SCHEMA }) as Record<
    string,
    any
  >
  const jobs = () => (workflow.jobs ?? {}) as Record<string, any>
  const needsOf = (job: Record<string, any> | undefined): string[] => {
    const needs = job?.needs
    if (needs === undefined) return []
    return Array.isArray(needs) ? needs : [needs]
  }
  const steps = (jobName: string): Array<Record<string, any>> => jobs()[jobName]?.steps ?? []
  const NOTIFY_SCRIPT = '.github/scripts/notify-version.js'
  /** /api/agent/version を呼ぶステップ（通知スクリプトを実行するか、run に URL を直書き）。 */
  const callsVersionApi = (step: Record<string, any>) =>
    String(step.run ?? '').includes('/api/agent/version') ||
    String(step.run ?? '').includes(NOTIFY_SCRIPT)
  const npmPublishSteps = () =>
    steps('publish').filter((s) => /\bnpm publish\b/.test(String(s.run ?? '')))

  describe('バージョン通知の分離', () => {
    it('publish ジョブには /api/agent/version を呼ぶステップが無い', () => {
      expect(steps('publish').filter(callsVersionApi)).toEqual([])
    })

    it('notify_version ジョブが publish の後に通知スクリプトで /api/agent/version を呼ぶ', () => {
      const job = jobs().notify_version
      expect(job).toBeDefined()
      expect(needsOf(job)).toContain('publish')
      expect(String(job?.if ?? '')).toContain("startsWith(github.ref, 'refs/tags/')")
      const notify = (job?.steps ?? []).filter(callsVersionApi)
      expect(notify).toHaveLength(1)
      expect(String(notify[0].run)).toContain(`node ${NOTIFY_SCRIPT}`)
      const source = readFileSync(join(__dirname, '..', '..', NOTIFY_SCRIPT), 'utf8')
      expect(source).toContain('/api/agent/version')
      // curl の --max-time 30 に相当するタイムアウト。
      expect(source).toContain('AbortSignal.timeout')
    })

    it('notify_version は publish の出力を env 経由で受け取る（スクリプト内に ${{ }} を埋め込まない）', () => {
      const [step] = (jobs().notify_version?.steps ?? []).filter(callsVersionApi)
      const env = JSON.stringify(step?.env ?? {})
      expect(env).toContain('needs.publish.outputs.version')
      expect(env).toContain('needs.publish.outputs.channel_tag')
      expect(String(step?.env?.VERSION_API_URL ?? '')).toContain('secrets.AGENT_VERSION_API_URL')
      expect(String(step?.env?.VERSION_API_KEY ?? '')).toContain('secrets.AGENT_VERSION_API_KEY')
      expect(String(step?.run ?? '')).not.toContain('${{')
    })

    it('notify_version は最小権限（contents: read のみ）で動く', () => {
      expect(jobs().notify_version?.permissions).toEqual({ contents: 'read' })
    })

    it.each(['publish_image', 'publish_image_manifest', 'move_channel_tag'])(
      '%s は notify_version に依存しない（通知失敗でイメージ発行を止めない）',
      (name) => {
        expect(jobs()[name]).toBeDefined()
        expect(needsOf(jobs()[name])).not.toContain('notify_version')
      },
    )
  })

  describe('npm publish の冪等化', () => {
    /** publish ステップの if が参照する「公開済み判定」ステップの id。 */
    const guardIds = () =>
      npmPublishSteps().map((s) => {
        const m = String(s.if ?? '').match(/steps\.([\w-]+)\.outputs\.skip != 'true'/)
        return m ? m[1] : null
      })

    it('npm publish ステップは 1 つ（dist-tag はロック下の判定ステップが決める）', () => {
      expect(npmPublishSteps()).toHaveLength(1)
    })

    it("npm publish ステップの if に steps.<id>.outputs.skip != 'true' のガードがある", () => {
      const ids = guardIds()
      expect(ids).toHaveLength(1)
      expect(ids.every((id) => id !== null)).toBe(true)
    })

    it('ガードのステップが同じジョブ内で npm publish より前にあり、gitHead と GITHUB_SHA で照合する', () => {
      const [id] = guardIds()
      const all = steps('publish')
      const guardIndex = all.findIndex((s) => s.id === id)
      expect(guardIndex).toBeGreaterThanOrEqual(0)
      const firstPublish = Math.min(...npmPublishSteps().map((s) => all.indexOf(s)))
      expect(guardIndex).toBeLessThan(firstPublish)

      const guard = all[guardIndex]
      const scriptMatch = String(guard.run ?? '').match(/\.github\/scripts\/[\w.-]+\.js/)
      expect(scriptMatch).not.toBeNull()
      const scriptSource = readFileSync(join(__dirname, '..', '..', scriptMatch![0]), 'utf8')
      const text = String(guard.run) + scriptSource
      expect(text).toContain('gitHead')
      expect(text).toContain('GITHUB_SHA')
    })

    it('公開済み判定はレジストリの失敗を「未公開」に化けさせない（HTTP 404 だけを明示的に「未公開」と判定する）', () => {
      const [id] = guardIds()
      const guard = steps('publish').find((s) => s.id === id)
      const run = String(guard?.run ?? '')
      const scriptMatch = run.match(/\.github\/scripts\/[\w.-]+\.js/)
      const scriptSource = scriptMatch
        ? readFileSync(join(__dirname, '..', '..', scriptMatch[0]), 'utf8')
        : ''
      expect(scriptSource).toMatch(/status === 404/)
      // CDN キャッシュされる packument（npm view）ではなく、キャッシュされないバージョン別マニフェストを読む。
      expect(scriptSource).toContain('fetchVersionManifest')
      expect(scriptSource).not.toContain('child_process')
      for (const text of [run, scriptSource]) {
        expect(text).not.toMatch(/\|\|\s*true/)
        expect(text).not.toMatch(/\|\|\s*echo/)
      }
      expect(guard?.['continue-on-error']).toBeUndefined()
    })
  })

  /**
   * リリースチャンネル（GHCR の移動タグ `:latest`/`:beta`/`:alpha` と API の「最新版」）の更新。
   *
   * 問題: 古いタグの再実行が dist-tag を確認（まだ自分）→ その間に新しいリリースが
   * npm と `:latest` を動かす → 古い run のタグ更新が最後に着地、で `:latest` が巻き戻る。
   * ワークフローの concurrency はタグ（ref）ごとなので、別タグの run 同士は直列化されない。
   *
   * 対策: チャンネル更新をチャンネルごとのロック（job-level concurrency）下で直列化し、
   * かつ「この run の版 V に動かす」のではなく「npm の dist-tag が今指す版 H に合わせる」
   * 冪等な収束にする。GitHub の concurrency は待機 1 件のみで、新しい待機ジョブが既存の
   * 待機ジョブを取り消すが、全ジョブが H に合わせるので、取り消されても最後に走るジョブが
   * 正しい値にする。
   *
   * 可否・対象を publish ジョブの出力で渡してはならない: 「Re-run failed jobs」は成功済みの
   * publish ジョブを再実行せず前回の出力を再利用する。再利用してよいのはタグ名だけから
   * 決まる version / channel_tag だけ。
   */
  describe('チャンネル更新の直列化と npm への収束', () => {
    const TARGET_SCRIPT = '.github/scripts/npm-channel-target.js'
    const isResolve = (s: Record<string, any>) => String(s.run ?? '').includes(TARGET_SCRIPT)
    const lockfile = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string }> }
    const CHANNEL_JOBS = ['move_channel_tag', 'notify_version'] as const
    /** チャンネル解決（解決スクリプトか、それを内部で呼ぶ通知スクリプト）を行うステップ。 */
    const resolvingStep = (jobName: string) => {
      const all = steps(jobName)
      const found = all.filter((s) => isResolve(s) || String(s.run ?? '').includes(NOTIFY_SCRIPT))
      expect(found).toHaveLength(1)
      return { step: found[0], index: all.indexOf(found[0]), all }
    }
    const channelTagCreates = (jobName: string) =>
      steps(jobName).filter((s) => /imagetools create[^\n]*--tag "\$\{IMAGE\}:\$\{CHANNEL_TAG\}"/.test(String(s.run ?? '')))

    it('publish ジョブの出力は version / channel_tag / prerelease だけ（再実行で古くなる判定を出さない）', () => {
      expect(Object.keys(jobs().publish?.outputs ?? {}).sort()).toEqual(['channel_tag', 'prerelease', 'version'])
    })

    it('どのジョブも needs.publish.outputs の version / channel_tag 以外を読まない', () => {
      const refs = [...JSON.stringify(workflow).matchAll(/needs\.publish\.outputs\.([\w-]+)/g)].map((m) => m[1])
      expect(refs.length).toBeGreaterThan(0)
      expect([...new Set(refs)].sort()).toEqual(['channel_tag', 'version'])
    })

    it('publish ジョブの公開済み判定はチャンネルを扱わない（単一の判定元にする）', () => {
      const guard = steps('publish').find((s) => /npm-version-published\.js/.test(String(s.run ?? '')))
      expect(guard).toBeDefined()
      expect(String(guard?.run)).not.toContain('--channel')
      expect(guard?.env?.CHANNEL).toBeUndefined()
    })

    it.each(CHANNEL_JOBS)('%s はチャンネル単位の job-level concurrency を持ち、実行中を取り消さない', (name) => {
      const c = jobs()[name]?.concurrency
      expect(c).toBeDefined()
      expect(typeof c).toBe('object')
      expect(String(c.group)).toMatch(/\$\{\{\s*needs\.publish\.outputs\.channel_tag\s*\}\}/)
      expect(c['cancel-in-progress']).toBe(false)
    })

    it('移動タグと API 通知のロックは別グループ（互いに待たない）、ワークフローのグループとも別', () => {
      const a = String(jobs().move_channel_tag?.concurrency?.group)
      const b = String(jobs().notify_version?.concurrency?.group)
      expect(a).not.toBe(b)
      // ref ごとのワークフローグループでは別タグの run が直列化されない。
      for (const g of [a, b]) {
        expect(g).not.toContain('github.ref')
        expect(g).not.toContain('github.workflow')
      }
    })

    it('move_channel_tag は version タグの発行後に走り、タグ push 時のみ・packages: write', () => {
      const job = jobs().move_channel_tag
      expect(needsOf(job)).toEqual(expect.arrayContaining(['publish', 'publish_image_manifest']))
      expect(String(job?.if ?? '')).toContain("startsWith(github.ref, 'refs/tags/')")
      expect(job?.permissions).toEqual({ contents: 'read', packages: 'write' })
    })

    it('publish_image_manifest は版タグだけを発行し、チャンネルを扱わない', () => {
      const job = jobs().publish_image_manifest
      const text = JSON.stringify(job ?? {})
      expect(text).not.toContain('CHANNEL')
      expect(text).not.toContain('channel_tag')
      expect(text).not.toContain(TARGET_SCRIPT)
      expect(text).not.toContain('npm-publish-tag')
      expect(job?.concurrency).toBeUndefined()
      const versionSteps = steps('publish_image_manifest').filter((s) =>
        /imagetools create .*"\$\{IMAGE\}:\$\{VERSION\}"/.test(String(s.run ?? '')),
      )
      expect(versionSteps).toHaveLength(1)
      expect(versionSteps[0].if).toBeUndefined()
    })

    it('移動タグを動かすのは move_channel_tag だけ', () => {
      for (const name of Object.keys(jobs())) {
        if (name === 'move_channel_tag') continue
        expect(JSON.stringify(jobs()[name])).not.toMatch(/\$\{IMAGE\}:\$\{CHANNEL_TAG\}/)
      }
      expect(channelTagCreates('move_channel_tag')).toHaveLength(1)
    })

    it('移動タグは解決した target の版タグ ${IMAGE}:${TARGET} から作る（VERSION やダイジェストからではない）', () => {
      const [step] = channelTagCreates('move_channel_tag')
      const run = String(step.run)
      expect(run).not.toContain('${{')
      expect(run).toMatch(/imagetools create --tag "\$\{IMAGE\}:\$\{CHANNEL_TAG\}" "\$\{IMAGE\}:\$\{TARGET\}"/)
      expect(run).not.toContain('VERSION')
      expect(run).not.toContain('/tmp/digests')
      const { step: resolve, index } = resolvingStep('move_channel_tag')
      expect(steps('move_channel_tag').indexOf(step)).toBeGreaterThan(index)
      expect(String(step.env?.TARGET ?? '')).toBe(`\${{ steps.${resolve.id}.outputs.target }}`)
      expect(String(step.env?.CHANNEL_TAG ?? '')).toContain('needs.publish.outputs.channel_tag')
    })

    it.each(CHANNEL_JOBS)('%s の解決は版とチャンネルを env 経由で渡す', (jobName) => {
      const { step } = resolvingStep(jobName)
      const run = String(step.run)
      expect(run).not.toContain('${{')
      expect(run).toMatch(/--version="\$VERSION"/)
      expect(run).toMatch(/--channel="\$CHANNEL"/)
      expect(String(step.env?.VERSION ?? '')).toContain('needs.publish.outputs.version')
      expect(String(step.env?.CHANNEL ?? '')).toContain('needs.publish.outputs.channel_tag')
      expect(step['continue-on-error']).toBeUndefined()
      expect(step.if).toBeUndefined()
    })

    it.each(CHANNEL_JOBS)('%s は解決より前に checkout（認証情報を残さない）と Node のセットアップをする', (jobName) => {
      const { index, all } = resolvingStep(jobName)
      const checkout = all.findIndex((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
      const setupNode = all.findIndex((s) => String(s.uses ?? '').startsWith('actions/setup-node@'))
      expect(checkout).toBeGreaterThanOrEqual(0)
      expect(setupNode).toBeGreaterThanOrEqual(0)
      expect(checkout).toBeLessThan(index)
      expect(setupNode).toBeLessThan(index)
      expect(all[checkout].with?.['persist-credentials']).toBe(false)
    })

    it.each(CHANNEL_JOBS)('%s は semver を lockfile と同じ版に固定して導入する', (jobName) => {
      const { step } = resolvingStep(jobName)
      const pinned = lockfile.packages['node_modules/semver']?.version
      expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
      const run = String(step.run)
      expect(run).toContain(`semver@${pinned}`)
      expect(run).toContain('--no-save')
      expect(run).toContain('--ignore-scripts')
    })

    it('notify_version は解決スクリプトを試行ごとに呼ぶ通知スクリプトで、解決した target を送る', () => {
      const source = readFileSync(join(__dirname, '..', '..', NOTIFY_SCRIPT), 'utf8')
      expect(source).toContain("require('./npm-channel-target.js')")
      expect(source).toMatch(/latestVersion:\s*target/)
      expect(source).not.toMatch(/latestVersion:\s*version/)
    })

    it.each(['publish_image', 'publish_image_manifest', 'notify_version', 'move_channel_tag'])(
      '%s はジョブ単位で古い判定によるスキップをしない',
      (name) => {
        expect(String(jobs()[name]?.if ?? '')).not.toMatch(/steps\./)
      },
    )
  })

  /**
   * npm のチャンネル dist-tag 自体の単調・直列更新。
   *
   * 問題: `npm publish --tag <channel>` はロックも版比較も無くチャンネルを動かしていた。
   * v0.5.16-beta.0 と beta.1 の publish が並行し beta.0 が後に完了すると、npm の `beta` が
   * beta.0 に巻き戻り、下流（移動タグ・API 通知）はその誤った保持者に忠実に収束し、
   * beta.1 の解決器は 5 分待って失敗する。
   *
   * 対策:
   *   - publish ジョブをチャンネルごとの job-level concurrency で直列化する。
   *     ジョブ開始前に評価されるため、グループはタグ名（github.ref_name）から式で導出し、
   *     「Determine release type」ステップの判定と一致させる（不一致ならステップが失敗する）
   *   - publish の dist-tag はロック下で npm-publish-tag.js が決める:
   *     チャンネル保持者 P が無い／P < V → <channel>、P > V → superseded-<channel>
   *     （古い版がチャンネルを取らない）。npm publish に `--tag <channel>` を直書きしない
   *   - 再実行（publish スキップ）でもこの判定は走り、チャンネルが V 未満なら失敗して知らせる
   *
   * dist-tag の書き込みは npm publish（OIDC Trusted Publishing）だけで行い、
   * `npm dist-tag add` は使わない（OIDC で dist-tag を操作するには npm 11.21.0 以上と
   * npmjs.com 側の「Allow npm dist-tag」設定が別途必要なため）。
   */
  describe('npm チャンネル dist-tag の単調・直列更新', () => {
    const TAG_SCRIPT = '.github/scripts/npm-publish-tag.js'
    const LOCK_EXPR =
      "${{ contains(github.ref_name, 'beta') && 'beta' || (contains(github.ref_name, 'alpha') && 'alpha' || 'latest') }}"
    const publishJob = () => jobs().publish as Record<string, any>
    const releaseTypeStep = () => steps('publish').find((s) => s.id === 'release-type') as Record<string, any>
    const tagStep = () => {
      const found = steps('publish').filter((s) => String(s.run ?? '').includes(TAG_SCRIPT))
      expect(found).toHaveLength(1)
      return found[0]
    }
    const indexOf = (s: Record<string, any>) => steps('publish').indexOf(s)

    /**
     * GitHub Actions の式 `contains(github.ref_name, 'A') && 'A' || (contains(github.ref_name, 'B') && 'B' || 'C')`
     * をこの形に限って評価する（contains は大文字小文字を区別しない）。形が変わったら例外にする。
     */
    function evalLockExpr(expr: string, refName: string): string {
      const m = expr.match(
        /^\$\{\{\s*contains\(github\.ref_name, '(\w+)'\) && '(\w+)' \|\| \(contains\(github\.ref_name, '(\w+)'\) && '(\w+)' \|\| '(\w+)'\)\s*\}\}$/,
      )
      if (!m) throw new Error(`unsupported expression shape: ${expr}`)
      const [, n1, v1, n2, v2, fallback] = m
      const contains = (needle: string) => refName.toLowerCase().includes(needle.toLowerCase())
      if (contains(n1)) return v1
      if (contains(n2)) return v2
      return fallback
    }

    function runReleaseType(version: string, lockChannel: string) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mkdtempSync, readFileSync: read, writeFileSync } = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { tmpdir } = require('os')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawnSync } = require('child_process')
      const dir = mkdtempSync(join(tmpdir(), 'release-type-'))
      const out = join(dir, 'out')
      writeFileSync(out, '')
      const r = spawnSync('bash', ['-eo', 'pipefail', '-c', String(releaseTypeStep().run)], {
        env: { PATH: process.env.PATH, VERSION: version, LOCK_CHANNEL: lockChannel, GITHUB_OUTPUT: out },
        encoding: 'utf8',
      })
      const outputs: Record<string, string> = {}
      for (const line of String(read(out, 'utf8')).split('\n').filter(Boolean)) {
        const [k, v] = line.split('=')
        outputs[k] = v
      }
      return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr), outputs }
    }

    it('publish ジョブはチャンネル単位の job-level concurrency を持ち、実行中を取り消さない', () => {
      const c = publishJob()?.concurrency
      expect(c).toBeDefined()
      expect(c.group).toBe(`release-channel-npm-${LOCK_EXPR}`)
      expect(c['cancel-in-progress']).toBe(false)
    })

    it('npm / 移動タグ / API 通知のロックはすべて別グループで、ref ごとのワークフローグループとも別', () => {
      const groups = ['publish', 'move_channel_tag', 'notify_version'].map((n) => String(jobs()[n]?.concurrency?.group))
      expect(new Set(groups).size).toBe(3)
      for (const g of groups) {
        expect(g).toMatch(/^release-channel-/)
        expect(g).not.toMatch(/github\.ref(?!_name)/)
        expect(g).not.toContain('github.workflow')
      }
    })

    it('release-type ステップはロックと同じ式を LOCK_CHANNEL として受け取り、版は env 経由で受け取る', () => {
      const step = releaseTypeStep()
      expect(step.env?.LOCK_CHANNEL).toBe(LOCK_EXPR)
      expect(String(step.env?.VERSION ?? '')).toContain('steps.version.outputs.version')
      expect(String(step.run)).not.toContain('${{')
    })

    it.each<[string, string, string]>([
      ['v1.2.3', 'latest', 'false'],
      ['v1.2.3-beta.0', 'beta', 'true'],
      ['v1.2.3-alpha.1', 'alpha', 'true'],
      ['v1.2.3-BETA.2', 'beta', 'true'],
      ['v1.2.3-rc.1', 'latest', 'false'],
    ])('タグ %s: ロックの式と release-type ステップがともに %s と判定する', (refName, channel, prerelease) => {
      const lock = evalLockExpr(LOCK_EXPR, refName)
      expect(lock).toBe(channel)
      // ロックの式そのもの（ワークフローに書かれた文字列）でも評価する。
      expect(evalLockExpr(String(publishJob().concurrency.group).replace(/^release-channel-npm-/, ''), refName)).toBe(channel)
      const r = runReleaseType(refName.replace(/^v/, ''), lock)
      expect(r.status).toBe(0)
      expect(r.outputs).toEqual({ tag: channel, prerelease })
    })

    it('ロックのチャンネルと release-type の判定が食い違えば失敗し、出力しない', () => {
      const r = runReleaseType('1.2.3-beta.0', 'latest')
      expect(r.status).not.toBe(0)
      expect(r.stdout + r.stderr).toContain('::error::')
      expect(r.outputs).toEqual({})
    })

    it('dist-tag 判定ステップは公開済み判定の後・npm publish の前にあり、skip に関係なく常に走る', () => {
      const step = tagStep()
      const guard = steps('publish').find((s) => /npm-version-published\.js/.test(String(s.run ?? '')))!
      const [publish] = npmPublishSteps()
      expect(indexOf(step)).toBeGreaterThan(indexOf(guard))
      expect(indexOf(step)).toBeLessThan(indexOf(publish))
      expect(step.if).toBeUndefined()
      expect(step['continue-on-error']).toBeUndefined()
    })

    it('dist-tag 判定ステップは版・チャンネル・公開済みフラグを env 経由で渡す', () => {
      const step = tagStep()
      const run = String(step.run)
      expect(run).not.toContain('${{')
      expect(run).toMatch(/--version="\$VERSION"/)
      expect(run).toMatch(/--channel="\$CHANNEL"/)
      expect(run).toMatch(/--published="\$PUBLISHED"/)
      expect(run).not.toContain('--dry-run')
      expect(step.env?.VERSION).toBe('${{ steps.version.outputs.version }}')
      expect(step.env?.CHANNEL).toBe('${{ steps.release-type.outputs.tag }}')
      const guard = steps('publish').find((s) => /npm-version-published\.js/.test(String(s.run ?? '')))!
      expect(step.env?.PUBLISHED).toBe(`\${{ steps.${guard.id}.outputs.skip }}`)
    })

    it('semver は npm ci 済みのリポジトリの node_modules から解決する（lockfile で 7.7.4 に固定）', () => {
      const step = tagStep()
      expect(step.env?.NODE_PATH).toBeUndefined()
      expect(String(step.run)).not.toMatch(/npm (install|i) /)
      const all = steps('publish')
      const ci = all.findIndex((s) => /^npm ci\b/.test(String(s.run ?? '')))
      expect(ci).toBeGreaterThanOrEqual(0)
      expect(ci).toBeLessThan(indexOf(step))
      // dev 依存（semver は devDependencies）を落とすと解決できない。
      expect(String(all[ci].run)).not.toMatch(/--omit|--production|--only/)
      const lockfile = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8'))
      expect(lockfile.packages['node_modules/semver']?.version).toBe('7.7.4')
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
      expect({ ...pkg.dependencies, ...pkg.devDependencies }.semver).toBeDefined()
      // スクリプトの位置から require('semver') すると、リポジトリ直下の node_modules に解決される。
      const resolved = require.resolve('semver', { paths: [join(__dirname, '..', '..', '.github', 'scripts')] })
      expect(resolved.startsWith(join(__dirname, '..', '..', 'node_modules', 'semver') + '/')).toBe(true)
    })

    it('npm publish は判定ステップの publish_tag だけを使い、チャンネル名を直接渡さない', () => {
      const [publish] = npmPublishSteps()
      const run = String(publish.run)
      expect(run).not.toContain('${{')
      expect(run).toContain('--tag "${PUBLISH_TAG:?')
      expect(String(publish.env?.PUBLISH_TAG)).toBe(`\${{ steps.${tagStep().id}.outputs.publish_tag }}`)
      expect(JSON.stringify(publish)).not.toContain('release-type')
      expect(run).not.toMatch(/--tag[ =]+["']?(latest|beta|alpha)\b/)
    })

    it('publish_tag が空なら npm publish を呼ばずに失敗する（既定の latest に落ちない）', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mkdtempSync, writeFileSync, chmodSync, existsSync } = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { tmpdir } = require('os')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawnSync } = require('child_process')
      const dir = mkdtempSync(join(tmpdir(), 'npm-publish-'))
      const callLog = join(dir, 'calls.log')
      writeFileSync(join(dir, 'npm'), `#!/bin/bash\necho "$*" >> "${callLog}"\n`)
      chmodSync(join(dir, 'npm'), 0o755)
      const [publish] = npmPublishSteps()
      const exec = (tag: string) =>
        spawnSync('bash', ['-eo', 'pipefail', '-c', String(publish.run)], {
          env: { PATH: `${dir}:${process.env.PATH}`, PUBLISH_TAG: tag },
          encoding: 'utf8',
        })
      expect(exec('').status).not.toBe(0)
      expect(existsSync(callLog)).toBe(false)
      expect(exec('superseded-beta').status).toBe(0)
      expect(readFileSync(callLog, 'utf8').trim()).toBe('publish --access public --ignore-scripts --tag superseded-beta')
    })

    it('ワークフローは npm dist-tag を直接操作しない（チャンネルの書き込みはロック下の npm publish だけ）', () => {
      expect(JSON.stringify(workflow)).not.toMatch(/npm dist-tag (add|rm)/)
    })
  })

  /**
   * move_channel_tag の「タグ移動」ステップをそのまま bash で実行し、docker を偽物に差し替えて
   * 分岐を確かめる。H の版タグが未発行（H 自身のリリースがまだビルド中）なら成功扱いで
   * 何もしない（H の run が後で合わせる）。それ以外の inspect 失敗は失敗にする。
   * 「not found」の文言は実機（buildx v0.33）で確認したもの:
   *   ERROR: ghcr.io/mbc-net/ai-support-agent-cli:0.0.0-nonexistent: not found
   */
  describe('move_channel_tag: タグ移動ステップの実行', () => {
    const IMAGE = 'ghcr.io/mbc-net/ai-support-agent-cli'
    const moveStep = () =>
      steps('move_channel_tag').find((s) => /imagetools create/.test(String(s.run ?? ''))) as Record<string, any>

    function runMove(mode: 'exists' | 'missing' | 'denied' | 'create-fails') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mkdtempSync, writeFileSync, chmodSync, readFileSync: read, existsSync } = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { tmpdir } = require('os')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawnSync } = require('child_process')
      const dir = mkdtempSync(join(tmpdir(), 'move-channel-'))
      const callLog = join(dir, 'calls.log')
      writeFileSync(
        join(dir, 'docker'),
        [
          '#!/bin/bash',
          `echo "$*" >> "${callLog}"`,
          'if [ "$3" = "inspect" ]; then',
          '  case "$FAKE_MODE" in',
          '    missing) echo "ERROR: $4: not found" >&2; exit 1 ;;',
          '    denied) echo "ERROR: failed to authorize: 403 Forbidden" >&2; exit 1 ;;',
          '  esac',
          '  echo "Name: $4"; exit 0',
          'fi',
          'if [ "$3" = "create" ] && [ "$FAKE_MODE" = "create-fails" ]; then echo "ERROR: denied" >&2; exit 1; fi',
          'exit 0',
        ].join('\n'),
      )
      chmodSync(join(dir, 'docker'), 0o755)
      const step = moveStep()
      const env: Record<string, string> = {
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_MODE: mode,
        IMAGE,
        CHANNEL_TAG: 'latest',
        TARGET: '0.5.17',
      }
      // ステップ env のうち ${{ }} を含まない固定値（IMAGE）も実ファイルの値で上書きする。
      for (const [k, v] of Object.entries(step.env ?? {})) {
        if (!String(v).includes('${{')) env[k] = String(v)
      }
      const r = spawnSync('bash', ['-eo', 'pipefail', '-c', String(step.run)], { env, encoding: 'utf8' })
      const calls: string[] = existsSync(callLog) ? read(callLog, 'utf8').trim().split('\n') : []
      return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr), calls }
    }

    it('target の版タグがあれば、それから移動タグを作る', () => {
      const r = runMove('exists')
      expect(r.status).toBe(0)
      expect(r.calls).toEqual([
        `buildx imagetools inspect ${IMAGE}:0.5.17`,
        `buildx imagetools create --tag ${IMAGE}:latest ${IMAGE}:0.5.17`,
        `buildx imagetools inspect ${IMAGE}:latest`,
      ])
    })

    it('target の版タグがまだ無ければ notice を出して成功（移動しない）', () => {
      const r = runMove('missing')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('::notice::')
      expect(r.calls).toEqual([`buildx imagetools inspect ${IMAGE}:0.5.17`])
    })

    it('not found 以外の inspect 失敗は失敗にする（移動しない）', () => {
      const r = runMove('denied')
      expect(r.status).not.toBe(0)
      expect(r.stdout + r.stderr).toContain('::error::')
      expect(r.calls).toEqual([`buildx imagetools inspect ${IMAGE}:0.5.17`])
    })

    it('移動タグの作成失敗は失敗にする', () => {
      const r = runMove('create-fails')
      expect(r.status).not.toBe(0)
    })
  })
})

/**
 * 待機中に取り消された publish を黙殺しない。
 *
 * publish はチャンネルごとの job-level concurrency（cancel-in-progress: false）で直列化している。
 * GitHub の concurrency グループは「実行中 1 + 待機 1」で、同じチャンネルの 3 本目のタグが待機に
 * 入ると、待機中の 2 本目の publish が取り消される。publish が cancelled になると下流はスキップされ、
 * run は failure 扱いにならないため失敗通知が飛ばない（そのリリースは npm に出ないまま気付かれない）。
 *
 * 対策: publish が cancelled のときだけ走り、タグ名を示して再実行を促し exit 1 で run を失敗にする
 * report_publish_cancelled ジョブ。
 */
describe('ci-cd.yml: 取り消された publish の報告', () => {
  const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci-cd.yml')
  const raw = readFileSync(workflowPath, 'utf8')
  const workflow = load(raw, { schema: DEFAULT_SCHEMA }) as Record<string, any>
  const JOB = 'report_publish_cancelled'
  const job = () => workflow.jobs?.[JOB] as Record<string, any> | undefined
  const runSteps = () => ((job()?.steps ?? []) as Array<Record<string, any>>).filter((s) => s.run !== undefined)

  it('publish だけを needs にし、タグ run で publish が cancelled のときだけ（always() で）走る', () => {
    expect(job()).toBeDefined()
    const needs = job()?.needs
    expect(Array.isArray(needs) ? needs : [needs]).toEqual(['publish'])
    expect(job()?.if).toBe(
      "always() && startsWith(github.ref, 'refs/tags/') && needs.publish.result == 'cancelled'",
    )
  })

  it('権限は持たない（permissions: {}）・秘密情報もチェックアウトも使わない', () => {
    expect(job()?.permissions).toEqual({})
    const text = JSON.stringify(job())
    expect(text).not.toContain('secrets.')
    expect(text).not.toContain('actions/checkout')
    expect(job()?.['timeout-minutes']).toBeLessThanOrEqual(5)
    expect(job()?.concurrency).toBeUndefined()
  })

  it('タグ名は env 経由で渡し、run 本体に ${{ }} を埋め込まない', () => {
    const steps = runSteps()
    expect(steps).toHaveLength(1)
    const [step] = steps
    expect(String(step.run)).not.toContain('${{')
    expect(step.env?.TAG).toBe('${{ github.ref_name }}')
    expect(String(step.run)).toMatch(/exit 1\s*$/)
    expect(step['continue-on-error']).toBeUndefined()
    expect(step.if).toBeUndefined()
  })

  it('どのジョブもこのジョブを needs にしない（報告専用）', () => {
    for (const [name, j] of Object.entries((workflow.jobs ?? {}) as Record<string, any>)) {
      const needs = j?.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]
      expect([name, needs.includes(JOB)]).toEqual([name, false])
    }
  })

  it('bash で実行すると exit 1 し、タグ名・ロック待ちでの取り消し・再実行の手順を ::error:: で示す', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process')
    const [step] = runSteps()
    const tag = 'v0.5.16-beta.1'
    const r = spawnSync('bash', ['-eo', 'pipefail', '-c', String(step.run)], {
      env: { PATH: process.env.PATH, TAG: tag },
      encoding: 'utf8',
    })
    expect(r.status).toBe(1)
    const out = `${r.stdout}${r.stderr}`
    const errorLines = out.split('\n').filter((l: string) => l.startsWith('::error::'))
    expect(errorLines.length).toBeGreaterThan(0)
    const msg = errorLines.join('\n')
    expect(msg).toContain(tag)
    expect(msg).toMatch(/release-channel/)
    expect(msg).toMatch(/Re-run all jobs/)
    expect(msg).toMatch(/gitHead/)
  })

  it('Channel locks のコメントに取り消し時の報告ジョブが書かれている', () => {
    const block = raw.slice(raw.indexOf('# Channel locks'), raw.indexOf('  publish:\n'))
    expect(block).toContain(JOB)
  })
})
