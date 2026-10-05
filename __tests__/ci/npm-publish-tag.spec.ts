/**
 * `.github/scripts/npm-publish-tag.js` の検証。
 *
 * npm のチャンネル dist-tag（latest / beta / alpha）を「単調にしか進まない」ようにするための判定。
 * publish ジョブはチャンネルごとのロック（job-level concurrency）下で、npm publish の直前に
 * これを呼び、publish に付ける dist-tag を決める。
 *
 * 問題: 以前は `npm publish --tag <channel>` が無条件にチャンネルを動かしていた。
 * v0.5.16-beta.0 と beta.1 の publish が並行し beta.0 が後に完了すると、npm の `beta` が
 * beta.0 に巻き戻り、下流（移動タグ・API 通知）はその誤った保持者へ忠実に収束してしまう。
 *
 * 規則（holder P = dist-tags[channel]、この run の版 V）:
 *   公開前（--published=false）:
 *     - P が無い／P < V → publish_tag=<channel>（V がチャンネルを取る）
 *     - P > V           → publish_tag=superseded-<channel>（古い版はチャンネルを取らない。notice）
 *     - P == V          → 失敗（V は未公開と判定されたのにチャンネルが V を指す＝照会結果が矛盾）
 *   公開済みの再実行（--published=true、publish はスキップ）:
 *     - P >= V          → 成功（何もしない。P > V は notice）
 *     - P が無い／P < V → 失敗（ロック下の publish が設定したはずの値がワークフロー外で変わった。
 *                          手動復旧コマンドを示す）
 *   照会失敗・HTTP 200 以外・JSON 不正・holder が文字列でない・semver 不正 → 失敗（推測しない）
 *
 * dist-tag はキャッシュされない `/-/package/<pkg>/dist-tags` から読む（packument は CDN で
 * 最大 300 秒キャッシュされ、ロック直前に動いたチャンネルを古い値で読む恐れがある）。
 * ネットワークは使わない。`fetchDistTags` を注入する。
 */

type FetchResult = { status: number; body: string }

interface MainOptions {
  argv: string[]
  fetchDistTags: (packageName: string) => Promise<FetchResult>
  appendOutput: (line: string) => void
  log?: (msg: string) => void
  error?: (msg: string) => void
}

interface Decision {
  publishTag?: string
  message: string
}

interface ScriptModule {
  parseArgs: (argv: string[]) => {
    packageName: string
    version: string
    channel: string
    published: boolean
    dryRun: boolean
  }
  distTagsUrl: (packageName: string) => string
  readHolder: (result: FetchResult, channel: string) => string | undefined
  decide: (args: { holder: string | undefined; version: string; channel: string; published: boolean }) => Decision
  main: (options: MainOptions) => Promise<number>
  SUPERSEDED_PREFIX: string
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require('../../.github/scripts/npm-publish-tag.js') as ScriptModule

const PKG = '@ai-support-agent/cli'

const tags = (t: Record<string, unknown>): FetchResult => ({ status: 200, body: JSON.stringify(t) })

async function run(
  result: FetchResult | (() => FetchResult),
  {
    version = '0.5.16',
    channel = 'latest',
    published = 'false',
    extra = [] as string[],
  }: { version?: string; channel?: string; published?: string; extra?: string[] } = {},
) {
  const outputs: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  const queries: string[] = []
  const code = await script.main({
    argv: [`--package=${PKG}`, `--version=${version}`, `--channel=${channel}`, `--published=${published}`, ...extra],
    fetchDistTags: async (packageName) => {
      queries.push(packageName)
      return typeof result === 'function' ? result() : result
    },
    appendOutput: (line) => outputs.push(line),
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  })
  return { code, outputs, logs, errors, queries }
}

describe('npm-publish-tag.js', () => {
  describe('公開前（--published=false）: publish に付ける dist-tag を決める', () => {
    it('チャンネルの dist-tag が無ければ V がチャンネルを取る', async () => {
      const r = await run(tags({ latest: '0.5.15' }), { version: '0.5.16-alpha.0', channel: 'alpha' })
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['publish_tag=alpha'])
      expect(r.queries).toEqual([PKG])
    })

    it('P < V なら V がチャンネルを取る', async () => {
      const r = await run(tags({ latest: '0.5.15' }))
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['publish_tag=latest'])
    })

    it('P > V なら古い版はチャンネルを取らず superseded-<channel> で公開し、notice を出す', async () => {
      const r = await run(tags({ latest: '0.5.17' }))
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['publish_tag=superseded-latest'])
      const log = r.logs.join('\n')
      expect(log).toContain('0.5.17')
      // ワークフローコマンドは行頭にないと解釈されない。
      expect(r.logs.some((l) => l.startsWith('::notice::'))).toBe(true)
    })

    it('プレリリースの順序も semver で比較する（beta.1 公開後の beta.0 はチャンネルを取らない）', async () => {
      const r = await run(tags({ beta: '0.5.16-beta.1' }), { version: '0.5.16-beta.0', channel: 'beta' })
      expect(r.outputs).toEqual(['publish_tag=superseded-beta'])
      const r2 = await run(tags({ beta: '0.5.16-beta.0' }), { version: '0.5.16-beta.1', channel: 'beta' })
      expect(r2.outputs).toEqual(['publish_tag=beta'])
    })

    it('数値として比較する（文字列比較なら 0.5.9 > 0.5.10 になってしまう）', async () => {
      const r = await run(tags({ latest: '0.5.9' }), { version: '0.5.10' })
      expect(r.outputs).toEqual(['publish_tag=latest'])
    })

    it('P == V（未公開と判定されたのにチャンネルが V を指す）は矛盾として失敗する', async () => {
      const r = await run(tags({ latest: '0.5.16' }))
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toContain('::error::')
    })
  })

  describe('公開済みの再実行（--published=true）: チャンネルが V 以上であることを確認する', () => {
    it('P == V なら成功（何もしない・出力しない）', async () => {
      const r = await run(tags({ beta: '0.5.15-beta.0' }), { version: '0.5.15-beta.0', channel: 'beta', published: 'true' })
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual([])
    })

    it('P > V なら成功し notice を出す（古い版はチャンネルを取り戻さない）', async () => {
      const r = await run(tags({ latest: '0.5.17' }), { published: 'true' })
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual([])
      expect(r.logs.some((l) => l.startsWith('::notice::'))).toBe(true)
    })

    it.each<[string, Record<string, unknown>]>([
      ['P < V', { latest: '0.5.15' }],
      ['dist-tag が無い', { beta: '0.5.16-beta.0' }],
    ])('%s なら失敗し、手動の復旧コマンドを示す', async (_label, t) => {
      const r = await run(tags(t), { published: 'true' })
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      const msg = r.errors.join('\n')
      expect(msg).toContain('::error::')
      expect(msg).toContain(`npm dist-tag add ${PKG}@0.5.16 latest`)
    })
  })

  describe('信頼できない照会結果は失敗（推測しない）', () => {
    it.each<[string, FetchResult | (() => FetchResult)]>([
      ['HTTP 404', { status: 404, body: '{"error":"not found"}' }],
      ['HTTP 503', { status: 503, body: 'Service Unavailable' }],
      ['JSON でない', { status: 200, body: 'latest: 0.5.17' }],
      ['壊れた JSON', { status: 200, body: '{"latest": "0.5.17"' }],
      ['空', { status: 200, body: '' }],
      ['配列', { status: 200, body: '["0.5.17"]' }],
      ['null', { status: 200, body: 'null' }],
      ['値が文字列でない', { status: 200, body: '{"latest": 1}' }],
      ['holder が semver として不正', tags({ latest: 'not-a-version' })],
      ['holder がビルドメタデータだけ違う（同順位の別物）', tags({ latest: '0.5.16+other' })],
      [
        '照会が例外を投げた',
        () => {
          throw new Error('fetch failed')
        },
      ],
    ])('%s なら失敗する', async (_label, result) => {
      for (const published of ['false', 'true']) {
        const r = await run(result, { published })
        expect(r.code).toBe(1)
        expect(r.outputs).toEqual([])
        expect(r.errors.join('\n')).toContain('::error::')
      }
    })
  })

  describe('--dry-run', () => {
    it('判定を表示するだけで GITHUB_OUTPUT には書かない', async () => {
      const r = await run(tags({ latest: '0.5.15' }), { extra: ['--dry-run'] })
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual([])
      expect(r.logs.join('\n')).toContain('publish_tag=latest')
    })
  })

  describe('入力検証（照会せずに失敗）', () => {
    it.each(['beta', '^0.5.0', '0.5.x', '', 'v0.5.15'])('厳密なバージョンでない %p は拒否する', async (version) => {
      const r = await run(tags({ latest: '0.5.15' }), { version })
      expect(r.code).toBe(1)
      expect(r.queries).toEqual([])
    })

    it.each(['', 'Latest', '1.0.0', 'beta tag'])('不正なチャンネル %p は拒否する', async (channel) => {
      const r = await run(tags({ latest: '0.5.15' }), { channel })
      expect(r.code).toBe(1)
      expect(r.queries).toEqual([])
    })

    it.each(['', 'yes', 'TRUE', '1'])('--published=%p は拒否する（true / false のみ）', async (published) => {
      const r = await run(tags({ latest: '0.5.15' }), { published })
      expect(r.code).toBe(1)
      expect(r.queries).toEqual([])
    })

    it('--published 欠落・未知の引数・パッケージ名欠落を拒否する', () => {
      expect(() => script.parseArgs([`--package=${PKG}`, '--version=1.0.0', '--channel=latest'])).toThrow(/--published/)
      expect(() =>
        script.parseArgs([`--package=${PKG}`, '--version=1.0.0', '--channel=latest', '--published=false', '--x']),
      ).toThrow(/Unknown/)
      expect(() => script.parseArgs(['--version=1.0.0', '--channel=latest', '--published=false'])).toThrow(/--package/)
    })

    it('正しい引数を解釈する', () => {
      expect(
        script.parseArgs([`--package=${PKG}`, '--version=1.2.3-beta.4', '--channel=beta', '--published=true', '--dry-run']),
      ).toEqual({ packageName: PKG, version: '1.2.3-beta.4', channel: 'beta', published: true, dryRun: true })
    })
  })

  describe('照会先と退避タグ', () => {
    it('キャッシュされない dist-tags エンドポイント（スコープの / はエスケープ）を読む', () => {
      expect(script.distTagsUrl(PKG)).toBe('https://registry.npmjs.org/-/package/@ai-support-agent%2fcli/dist-tags')
    })

    it('退避タグは semver の範囲として解釈されない（npm に拒否されない）', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const semver = require('semver')
      for (const channel of ['latest', 'beta', 'alpha']) {
        const tag = `${script.SUPERSEDED_PREFIX}${channel}`
        expect(semver.validRange(tag)).toBeNull()
        expect(tag).not.toBe(channel)
        expect(tag).not.toMatch(/^[v\d]/)
      }
    })

    it('decide は publishTag をチャンネルか退避タグのどちらかにしかしない', () => {
      expect(script.decide({ holder: undefined, version: '1.0.0', channel: 'beta', published: false }).publishTag).toBe('beta')
      expect(script.decide({ holder: '2.0.0', version: '1.0.0', channel: 'beta', published: false }).publishTag).toBe(
        'superseded-beta',
      )
      expect(script.decide({ holder: '1.0.0', version: '1.0.0', channel: 'beta', published: true }).publishTag).toBeUndefined()
    })
  })
})
