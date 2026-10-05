/**
 * `.github/scripts/npm-channel-target.js` の検証。
 *
 * リリースチャンネル（GHCR の `:latest`/`:beta`/`:alpha` と API の「最新版」）を
 * 「この run の版 V に動かす」のではなく、「npm の dist-tag が今指している版 H に合わせる」
 * （冪等な収束）ための解決器。チャンネル更新ジョブはチャンネルごとのロック
 * （job-level concurrency）下でこれを呼び、H に合わせる。
 *
 * なぜ V ではなく H か: concurrency グループは「実行中 1 + 待機 1」で、新しく待機に入った
 * ジョブは既存の待機ジョブを取り消す。V に動かす設計だと、取り消されたリリースの更新が
 * 失われたり、古いタグの再実行が新しいリリースの後に `:latest` を巻き戻したりする。
 * 全ジョブが「その時点の npm の真実」に合わせれば、どのジョブが取り消されても、
 * 最後に走るジョブが正しい値に収束させる。
 *
 * 規則（holder = dist-tags[channel]）:
 *   - holder >= version（同じ版、またはより新しい版） → target=holder（待たない）
 *   - holder が無い／古い → 公開直後の伝搬遅延とみなし上限付きで再照会。
 *                          version 以上になれば target=holder、期限切れなら失敗
 *   - 照会失敗・JSON 不正・holder が文字列でない・semver として不正 → 失敗（推測しない）
 *
 * 保持者はキャッシュされない `/-/package/<pkg>/dist-tags` から読む（npm-dist-tags.js。
 * npm-publish-tag.js と共通）。以前は `npm view`（packument。CDN で最大 300 秒キャッシュ）を
 * 読んでいたため、新しいリリース直後の古いタグの再実行が、キャッシュ上の H == 古い V を
 * 「準備完了」と読んでチャンネルを巻き戻せた。
 *
 * ネットワークは使わない。`fetchDistTags` と `sleep` を注入する。
 */

type ViewResult = { status: number; body: string }

interface ResolveOptions {
  packageName: string
  version: string
  channel: string
  fetchDistTags: (packageName: string) => Promise<ViewResult>
  sleep: (ms: number) => Promise<void>
  log?: (msg: string) => void
  maxAttempts?: number
  intervalMs?: number
}

interface MainOptions {
  argv: string[]
  fetchDistTags: (packageName: string) => Promise<ViewResult>
  appendOutput: (line: string) => void
  sleep: (ms: number) => Promise<void>
  log?: (msg: string) => void
  error?: (msg: string) => void
  maxAttempts?: number
  intervalMs?: number
}

interface ScriptModule {
  parseArgs: (argv: string[]) => { packageName: string; version: string; channel: string }
  readHolder: (result: ViewResult, channel: string) => string | undefined
  decide: (holder: string | undefined, version: string) => 'ready' | 'pending'
  resolveTarget: (options: ResolveOptions) => Promise<string>
  main: (options: MainOptions) => Promise<number>
  defaultFetchDistTags: (packageName: string) => Promise<ViewResult>
  DEFAULT_MAX_ATTEMPTS: number
  DEFAULT_INTERVAL_MS: number
}

const script = require('../../.github/scripts/npm-channel-target.js') as ScriptModule

const PKG = '@ai-support-agent/cli'

/** `/-/package/<pkg>/dist-tags` の応答（成功時）。 */
const distTags = (tags: Record<string, unknown>): ViewResult => ({
  status: 200,
  body: JSON.stringify(tags),
})

async function run(
  results: Array<ViewResult | (() => ViewResult)>,
  {
    argv = [`--package=${PKG}`, '--version=0.5.16', '--channel=latest'],
    maxAttempts = 5,
    intervalMs = 10_000,
  }: { argv?: string[]; maxAttempts?: number; intervalMs?: number } = {},
) {
  const outputs: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  const queries: string[] = []
  const sleeps: number[] = []
  let call = 0
  const code = await script.main({
    argv,
    fetchDistTags: async (packageName) => {
      queries.push(packageName)
      // 用意した結果を使い切ったら最後の結果を返し続ける。
      const r = results[Math.min(call, results.length - 1)]
      call += 1
      return typeof r === 'function' ? r() : r
    },
    appendOutput: (line) => outputs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    maxAttempts,
    intervalMs,
  })
  return { code, outputs, logs, errors, queries, sleeps }
}

describe('npm-channel-target.js', () => {
  describe('main: 即決できるケース（待たない）', () => {
    it('H == V なら target=V', async () => {
      const r = await run([distTags({ latest: '0.5.16', beta: '0.5.17-beta.0' })])
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.16'])
      expect(r.queries).toEqual([PKG])
      expect(r.sleeps).toEqual([])
    })

    it('H > V なら target=H（V ではない）を出し、新しい版が保持している旨を notice する', async () => {
      const r = await run([distTags({ latest: '0.5.17' })])
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.17'])
      expect(r.sleeps).toEqual([])
      const log = r.logs.join('\n')
      expect(log).toContain('::notice::')
      expect(log).toContain('0.5.17')
      expect(log).toContain('latest')
    })

    it('プレリリースの順序も semver で比較する（0.5.16-beta.1 > 0.5.16-beta.0）', async () => {
      const r = await run([distTags({ beta: '0.5.16-beta.1' })], {
        argv: [`--package=${PKG}`, '--version=0.5.16-beta.0', '--channel=beta'],
      })
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.16-beta.1'])
    })

    it('数値として比較する（文字列比較なら 0.5.9 > 0.5.10 になってしまう）', async () => {
      const r = await run([distTags({ latest: '0.5.10' })], {
        argv: [`--package=${PKG}`, '--version=0.5.9', '--channel=latest'],
      })
      expect(r.outputs).toEqual(['target=0.5.10'])
      expect(r.sleeps).toEqual([])
    })
  })

  describe('main: 公開直後の伝搬遅延（上限付きで再照会）', () => {
    it('H < V → H < V → H == V と追いつけば待ってから target=V', async () => {
      const r = await run([
        distTags({ latest: '0.5.15' }),
        distTags({ latest: '0.5.15' }),
        distTags({ latest: '0.5.16' }),
      ])
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.16'])
      expect(r.queries).toHaveLength(3)
      expect(r.sleeps).toEqual([10_000, 10_000])
    })

    it('dist-tag が無い → 現れて V を指す、なら target=V', async () => {
      const r = await run(
        [distTags({ latest: '0.5.15' }), distTags({ latest: '0.5.15', alpha: '0.5.16-alpha.0' })],
        { argv: [`--package=${PKG}`, '--version=0.5.16-alpha.0', '--channel=alpha'] },
      )
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.16-alpha.0'])
      expect(r.sleeps).toEqual([10_000])
    })

    it('待っている間により新しい版が来たら target=その新しい版', async () => {
      const r = await run([distTags({ latest: '0.5.15' }), distTags({ latest: '0.5.17' })])
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['target=0.5.17'])
    })

    it('期限まで古いままなら失敗し、target を出力しない（推測しない）', async () => {
      const r = await run([distTags({ latest: '0.5.15' })], { maxAttempts: 4 })
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.queries).toHaveLength(4)
      // 最後の照会の後は待たない。
      expect(r.sleeps).toEqual([10_000, 10_000, 10_000])
      const msg = r.errors.join('\n')
      expect(msg).toContain('::error::')
      expect(msg).toContain('0.5.15')
    })

    it('期限まで dist-tag が無いままなら失敗する', async () => {
      const r = await run([distTags({ latest: '0.5.15' })], {
        argv: [`--package=${PKG}`, '--version=0.5.16-alpha.0', '--channel=alpha'],
        maxAttempts: 3,
      })
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toContain('::error::')
    })

    it('既定値は 10 秒間隔・約 5 分', () => {
      expect(script.DEFAULT_INTERVAL_MS).toBe(10_000)
      const totalWaitMs = (script.DEFAULT_MAX_ATTEMPTS - 1) * script.DEFAULT_INTERVAL_MS
      expect(totalWaitMs).toBeGreaterThanOrEqual(4 * 60_000)
      expect(totalWaitMs).toBeLessThanOrEqual(6 * 60_000)
    })
  })

  describe('main: 信頼できない照会結果は失敗（再照会もしない）', () => {
    it.each<[string, ViewResult | (() => ViewResult)]>([
      ['HTTP 503', { status: 503, body: 'Service Unavailable' }],
      ['HTTP 404', { status: 404, body: '{"error":"not found"}' }],
      ['JSON でない応答', { status: 200, body: 'latest: 0.5.17' }],
      ['壊れた JSON', { status: 200, body: '{"latest": "0.5.17"' }],
      ['空の応答', { status: 200, body: '' }],
      ['オブジェクトでない JSON（配列）', { status: 200, body: '["0.5.17"]' }],
      ['オブジェクトでない JSON（null）', { status: 200, body: 'null' }],
      ['チャンネル値が文字列でない', { status: 200, body: '{"latest": 1}' }],
      ['holder が semver として不正', distTags({ latest: 'not-a-version' })],
      [
        '照会が例外を投げた（接続エラー・タイムアウト）',
        () => {
          throw new Error('The operation was aborted due to timeout')
        },
      ],
    ])('%s なら失敗する', async (_label, result) => {
      const r = await run([result])
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.queries).toHaveLength(1)
      expect(r.sleeps).toEqual([])
      expect(r.errors.join('\n')).toContain('::error::')
    })

    it('holder がビルドメタデータだけ違う（semver 上は同順位だが別物）なら失敗する', async () => {
      const r = await run([distTags({ latest: '0.5.16+other' })])
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
    })
  })

  describe('resolveTarget（notify-version.js から試行ごとに呼ばれる）', () => {
    it('H を返し、出力ファイルには書かない', async () => {
      const logs: string[] = []
      const target = await script.resolveTarget({
        packageName: PKG,
        version: '0.5.16',
        channel: 'latest',
        fetchDistTags: async () => distTags({ latest: '0.5.17' }),
        sleep: async () => undefined,
        log: (m) => logs.push(m),
      })
      expect(target).toBe('0.5.17')
      expect(logs.join('\n')).toContain('::notice::')
    })

    it('期限切れでは例外を投げる', async () => {
      await expect(
        script.resolveTarget({
          packageName: PKG,
          version: '0.5.16',
          channel: 'latest',
          fetchDistTags: async () => distTags({ latest: '0.5.15' }),
          sleep: async () => undefined,
          log: () => undefined,
          maxAttempts: 2,
        }),
      ).rejects.toThrow(/0\.5\.15/)
    })
  })

  describe('入力検証（npm を呼ばずに失敗）', () => {
    it.each(['beta', 'latest', '^0.5.0', '0.5.x', '', 'v0.5.15'])(
      '厳密なバージョンでない %p は拒否する',
      async (version) => {
        const r = await run([distTags({ latest: '0.5.16' })], {
          argv: [`--package=${PKG}`, `--version=${version}`, '--channel=latest'],
        })
        expect(r.code).toBe(1)
        expect(r.queries).toEqual([])
      },
    )

    it.each([undefined, '', 'Latest', '1.0.0', 'beta tag', '--x'])(
      'チャンネルが無い・不正（%p）なら拒否する',
      (channel) => {
        const argv = ['--package=x', '--version=1.0.0']
        if (channel !== undefined) argv.push(`--channel=${channel}`)
        expect(() => script.parseArgs(argv)).toThrow(/--channel/)
      },
    )

    it('未知の引数・パッケージ名欠落を拒否する', () => {
      expect(() => script.parseArgs(['--version=1.0.0', '--channel=latest'])).toThrow(/--package/)
      expect(() =>
        script.parseArgs(['--package=x', '--version=1.0.0', '--channel=latest', '--foo']),
      ).toThrow(/Unknown/)
    })

    it('正しい引数を解釈する', () => {
      expect(
        script.parseArgs([`--package=${PKG}`, '--version=1.2.3-beta.4', '--channel=beta']),
      ).toEqual({ packageName: PKG, version: '1.2.3-beta.4', channel: 'beta' })
    })
  })

  describe('decide / readHolder', () => {
    it.each<[string | undefined, string, string]>([
      ['0.5.16', '0.5.16', 'ready'],
      ['0.5.17', '0.5.16', 'ready'],
      ['0.5.15', '0.5.16', 'pending'],
      [undefined, '0.5.16', 'pending'],
      ['0.5.16', '0.5.16-beta.0', 'ready'],
      ['0.5.16-beta.0', '0.5.16', 'pending'],
    ])('holder=%p version=%p → %p', (holder, version, expected) => {
      expect(script.decide(holder, version)).toBe(expected)
    })

    it('decide は semver として不正な holder で例外を投げる', () => {
      expect(() => script.decide('nope', '0.5.16')).toThrow(/semver/)
    })

    it('readHolder は無いチャンネルに undefined を返す', () => {
      expect(script.readHolder(distTags({ latest: '0.5.14' }), 'alpha')).toBeUndefined()
    })

    it('readHolder は前後の空白を落とす', () => {
      expect(script.readHolder({ status: 200, body: '{"latest":" 0.5.14 "}' }, 'latest')).toBe('0.5.14')
    })
  })
})
