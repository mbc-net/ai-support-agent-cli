/**
 * `.github/scripts/npm-dist-tags.js` の検証。
 *
 * npm のチャンネル保持者（dist-tags[channel]）を読む唯一の経路。npm-publish-tag.js（publish の
 * dist-tag 判定）と npm-channel-target.js（移動タグ・API 通知の収束先の解決。notify-version.js も
 * これを経由する）の両方がこのモジュールで読む。
 *
 * なぜ単一経路か: 以前の npm-channel-target.js は `npm view <pkg> dist-tags --json`（packument）を
 * 読んでいた。packument は CDN で最大 300 秒キャッシュされるため、新しいリリースの直後 300 秒以内に
 * 古いタグの move_channel_tag / notify_version を再実行すると、キャッシュ上の H == 古い V を
 * 「準備完了」と読み、GHCR の `:latest`/`:beta` と API を古い版へ巻き戻せた。
 * キャッシュされない `/-/package/<pkg>/dist-tags` だけを読むことでこれを防ぐ。
 *
 * ネットワークは使わない。`fetchImpl` / `globalThis.fetch` を差し替える。
 */

interface FetchResult {
  status: number
  body: string
}

interface DistTagsModule {
  REGISTRY: string
  TIMEOUT_MS: number
  distTagsUrl: (packageName: string) => string
  fetchDistTags: (
    packageName: string,
    options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
  ) => Promise<FetchResult>
  readHolder: (result: FetchResult, channel: string) => string | undefined
  versionManifestUrl: (packageName: string, version: string) => string
  fetchVersionManifest: (
    packageName: string,
    version: string,
    options?: { fetchImpl?: typeof fetch; timeoutMs?: number },
  ) => Promise<FetchResult>
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const distTags = require('../../.github/scripts/npm-dist-tags.js') as DistTagsModule

const PKG = '@ai-support-agent/cli'
const URL = 'https://registry.npmjs.org/-/package/@ai-support-agent%2fcli/dist-tags'

function fakeResponse(status: number, body: string): Response {
  return { status, text: async () => body } as unknown as Response
}

describe('npm-dist-tags.js', () => {
  describe('distTagsUrl', () => {
    it('キャッシュされない dist-tags エンドポイント（スコープの / はエスケープ）を指す', () => {
      expect(distTags.distTagsUrl(PKG)).toBe(URL)
    })

    it('packument（/<pkg>）や npm view の経路ではない', () => {
      expect(distTags.distTagsUrl(PKG)).toContain('/-/package/')
      expect(distTags.distTagsUrl(PKG)).toMatch(/\/dist-tags$/)
    })
  })

  describe('fetchDistTags', () => {
    it('dist-tags エンドポイントを GET し、status と本文を返す', async () => {
      const calls: Array<[string, RequestInit | undefined]> = []
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return fakeResponse(200, '{"latest":"0.5.14"}')
      }) as unknown as typeof fetch
      const r = await distTags.fetchDistTags(PKG, { fetchImpl })
      expect(r).toEqual({ status: 200, body: '{"latest":"0.5.14"}' })
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe(URL)
      expect(calls[0][1]?.method ?? 'GET').toBe('GET')
      // タイムアウト用の signal を必ず付ける（無期限に待たない）。
      expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    })

    it('既定では呼び出し時点の globalThis.fetch を使う', async () => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation((async () => fakeResponse(200, '{}')) as unknown as typeof fetch)
      try {
        await distTags.fetchDistTags(PKG)
        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy.mock.calls[0][0]).toBe(URL)
      } finally {
        spy.mockRestore()
      }
    })

    it('タイムアウトしたら例外にする（推測しない）', async () => {
      const fetchImpl = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as unknown as typeof fetch
      await expect(distTags.fetchDistTags(PKG, { fetchImpl, timeoutMs: 20 })).rejects.toBeDefined()
    })

    it('接続エラーは例外のまま伝える', async () => {
      const fetchImpl = (async () => {
        throw new Error('fetch failed')
      }) as unknown as typeof fetch
      await expect(distTags.fetchDistTags(PKG, { fetchImpl })).rejects.toThrow(/fetch failed/)
    })

    it('既定のタイムアウトは 30 秒', () => {
      expect(distTags.TIMEOUT_MS).toBe(30_000)
    })
  })

  /**
   * publish 済み判定（npm-version-published.js）が読むバージョン別マニフェスト。
   * `/<pkg>/<version>` はキャッシュされない（実測 2026-10-05: cf-cache-status: DYNAMIC）。
   * `npm view <pkg>@<ver>` は最大 300 秒キャッシュされる packument を読むため使わない。
   */
  describe('versionManifestUrl', () => {
    it('スコープの / を %2f にしたバージョン別マニフェストを指す', () => {
      expect(distTags.versionManifestUrl(PKG, '0.5.15-beta.0')).toBe(
        'https://registry.npmjs.org/@ai-support-agent%2fcli/0.5.15-beta.0',
      )
    })

    it('スコープなしのパッケージ名はそのまま', () => {
      expect(distTags.versionManifestUrl('left-pad', '1.3.0')).toBe('https://registry.npmjs.org/left-pad/1.3.0')
    })

    it('バージョンは 1 セグメントとしてエンコードする（+ やパス区切りで別リソースを指さない）', () => {
      expect(distTags.versionManifestUrl(PKG, '1.0.0+build.1')).toBe(
        'https://registry.npmjs.org/@ai-support-agent%2fcli/1.0.0%2Bbuild.1',
      )
      expect(distTags.versionManifestUrl(PKG, '1/../x')).toBe(
        'https://registry.npmjs.org/@ai-support-agent%2fcli/1%2F..%2Fx',
      )
    })
  })

  describe('fetchVersionManifest', () => {
    const MANIFEST_URL = 'https://registry.npmjs.org/@ai-support-agent%2fcli/0.5.15-beta.0'

    it('バージョン別マニフェストを GET し、status と本文を返す（タイムアウト signal 付き）', async () => {
      const calls: Array<[string, RequestInit | undefined]> = []
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return fakeResponse(404, '"version not found: 0.5.15-beta.0"')
      }) as unknown as typeof fetch
      const r = await distTags.fetchVersionManifest(PKG, '0.5.15-beta.0', { fetchImpl })
      expect(r).toEqual({ status: 404, body: '"version not found: 0.5.15-beta.0"' })
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe(MANIFEST_URL)
      expect(calls[0][1]?.method ?? 'GET').toBe('GET')
      expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    })

    it('既定では呼び出し時点の globalThis.fetch を使う', async () => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation((async () => fakeResponse(200, '{}')) as unknown as typeof fetch)
      try {
        await distTags.fetchVersionManifest(PKG, '0.5.15-beta.0')
        expect(spy).toHaveBeenCalledTimes(1)
        expect(spy.mock.calls[0][0]).toBe(MANIFEST_URL)
      } finally {
        spy.mockRestore()
      }
    })

    it('タイムアウトしたら例外にする', async () => {
      const fetchImpl = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })) as unknown as typeof fetch
      await expect(
        distTags.fetchVersionManifest(PKG, '0.5.15-beta.0', { fetchImpl, timeoutMs: 20 }),
      ).rejects.toBeDefined()
    })

    it('接続エラーは例外のまま伝える', async () => {
      const fetchImpl = (async () => {
        throw new Error('fetch failed')
      }) as unknown as typeof fetch
      await expect(distTags.fetchVersionManifest(PKG, '0.5.15-beta.0', { fetchImpl })).rejects.toThrow(
        /fetch failed/,
      )
    })
  })

  describe('readHolder（信頼できない結果は例外）', () => {
    it('チャンネルの保持者を返す（前後の空白は落とす）', () => {
      expect(distTags.readHolder({ status: 200, body: '{"latest":" 0.5.14 "}' }, 'latest')).toBe('0.5.14')
    })

    it('チャンネルが無ければ undefined', () => {
      expect(distTags.readHolder({ status: 200, body: '{"latest":"0.5.14"}' }, 'alpha')).toBeUndefined()
    })

    it.each<[string, FetchResult]>([
      ['HTTP 404', { status: 404, body: '{"error":"not found"}' }],
      ['HTTP 503', { status: 503, body: 'Service Unavailable' }],
      ['HTTP 304', { status: 304, body: '' }],
      ['JSON でない', { status: 200, body: 'latest: 0.5.17' }],
      ['壊れた JSON', { status: 200, body: '{"latest": "0.5.17"' }],
      ['空', { status: 200, body: '' }],
      ['配列', { status: 200, body: '["0.5.17"]' }],
      ['null', { status: 200, body: 'null' }],
      ['数値', { status: 200, body: '1' }],
      ['値が文字列でない', { status: 200, body: '{"latest": 1}' }],
    ])('%s なら例外', (_label, result) => {
      expect(() => distTags.readHolder(result, 'latest')).toThrow()
    })
  })

  /**
   * 回帰: 保持者の読み取り経路が 1 本であること。
   * どちらかのスクリプトが独自に（`npm view` 等で）読むと、CDN キャッシュの古い保持者で
   * 判定がずれる。
   */
  describe('単一の読み取り経路', () => {
    const scriptsDir = '../../.github/scripts'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const publishTag = require(`${scriptsDir}/npm-publish-tag.js`)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const channelTarget = require(`${scriptsDir}/npm-channel-target.js`)

    it('npm-publish-tag.js と npm-channel-target.js は同じ取得関数・同じ解釈関数を使う', () => {
      expect(publishTag.defaultFetchDistTags).toBe(distTags.fetchDistTags)
      expect(channelTarget.defaultFetchDistTags).toBe(distTags.fetchDistTags)
      expect(publishTag.readHolder).toBe(distTags.readHolder)
      expect(channelTarget.readHolder).toBe(distTags.readHolder)
      expect(publishTag.distTagsUrl).toBe(distTags.distTagsUrl)
    })

    it.each(['npm-publish-tag.js', 'npm-channel-target.js'])(
      '%s は共有モジュールを require し、npm CLI もレジストリ URL の直書きも持たない',
      (file) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { readFileSync } = require('fs')
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { join } = require('path')
        const source = String(readFileSync(join(__dirname, scriptsDir, file), 'utf8'))
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        expect(code).toContain("require('./npm-dist-tags.js')")
        expect(code).not.toContain('child_process')
        expect(code).not.toMatch(/spawn|execFile|execSync/)
        expect(code).not.toContain('registry.npmjs.org')
        expect(code).not.toMatch(/fetch\(/)
      },
    )

    /**
     * リリース経路のスクリプトは npm CLI を起動しない（npm view は CDN キャッシュされた packument を読む）。
     * 例外: npm-audit-gate.js は CI の監査ゲートで `npm audit` / `npm view <pkg> versions` を起動する
     * （リリースの公開判定・チャンネル判定には関与しない）。
     */
    it('.github/scripts 配下で child_process を使うのは npm-audit-gate.js だけ', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync, readdirSync } = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { join } = require('path')
      const dir = join(__dirname, scriptsDir)
      const files = (readdirSync(dir) as string[]).filter((f) => f.endsWith('.js')).sort()
      expect(files).toEqual(
        expect.arrayContaining([
          'npm-channel-target.js',
          'npm-dist-tags.js',
          'npm-publish-tag.js',
          'npm-version-published.js',
          'notify-version.js',
        ]),
      )
      const spawning = files.filter((f) => {
        const source = String(readFileSync(join(dir, f), 'utf8'))
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        return /child_process|spawn|execFile|execSync|['"]view['"]|npm view/.test(code)
      })
      expect(spawning).toEqual(['npm-audit-gate.js'])
    })

    it('npm-channel-target.js の既定の読み取りは /-/package/.../dist-tags を叩き、npm view を起動しない', async () => {
      const spawned: string[] = []
      const fetched: string[] = []
      const failSpawn = (name: string) => (...args: unknown[]) => {
        spawned.push(`${name} ${JSON.stringify(args)}`)
        throw new Error(`${name} must not be called`)
      }
      let result: { code: number; outputs: string[]; errors: string[] } | undefined
      const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
        fetched.push(String(url))
        return fakeResponse(200, JSON.stringify({ latest: '0.5.14', beta: '0.5.15-beta.0' }))
      }) as unknown as typeof fetch)
      try {
        await new Promise<void>((resolve, reject) => {
          jest.isolateModules(() => {
            jest.doMock('child_process', () => ({
              spawn: failSpawn('spawn'),
              spawnSync: failSpawn('spawnSync'),
              exec: failSpawn('exec'),
              execSync: failSpawn('execSync'),
              execFile: failSpawn('execFile'),
              execFileSync: failSpawn('execFileSync'),
            }))
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fresh = require(`${scriptsDir}/npm-channel-target.js`)
            const outputs: string[] = []
            const errors: string[] = []
            // fetchDistTags を注入しない＝既定の読み取りを使う。
            fresh
              .main({
                argv: [`--package=${PKG}`, '--version=0.5.13', '--channel=latest'],
                appendOutput: (l: string) => outputs.push(l),
                sleep: async () => undefined,
                log: () => undefined,
                error: (m: string) => errors.push(m),
              })
              .then((code: number) => {
                result = { code, outputs, errors }
                resolve()
              }, reject)
          })
        })
      } finally {
        spy.mockRestore()
        jest.dontMock('child_process')
      }
      expect(spawned).toEqual([])
      expect(fetched).toEqual([URL])
      expect(result).toEqual({ code: 0, outputs: ['target=0.5.14'], errors: [] })
    })
  })
})
