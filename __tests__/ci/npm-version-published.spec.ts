/**
 * `.github/scripts/npm-version-published.js` の検証。
 *
 * タグ push の publish ジョブを「再実行可能」にするための判定スクリプト。
 * `npm publish` は同じバージョンを二度公開できない（E403）ため、
 * 1 回目で公開まで成功し後続ステップだけ落ちた場合、再実行が publish で必ず失敗していた
 * （v0.5.15-beta.0 の run 37213081596 attempt 2）。
 *
 * 判定はキャッシュされないバージョン別マニフェスト
 * `GET https://registry.npmjs.org/<pkg の / を %2f>/<version>`（cf-cache-status: DYNAMIC）で行う:
 *   - HTTP 404                              → 未公開（publish する）
 *   - HTTP 200 かつ gitHead == SHA          → 同じコミットからの再実行（publish をスキップ）
 *   - HTTP 200 かつ gitHead != SHA / 無し   → 失敗（同じソースからの公開だと証明できない）
 *   - それ以外（他の status・JSON 不正・接続エラー・タイムアウト）→ 失敗
 *
 * なぜ `npm view <pkg>@<ver> gitHead` を使わないか: npm view は CDN で最大 300 秒キャッシュされる
 * packument を読む。公開直後 300 秒以内の再実行が E404（キャッシュ）→ skip=false → `npm publish` E403、
 * あるいは後続のキャッシュされない dist-tag 判定と食い違って失敗し、即時再実行ができなかった。
 *
 * ネットワークは使わない。`main` に `fetchVersionManifest` を注入する。
 */

interface FetchResult {
  status: number
  body: string
}

type FetchManifest = (packageName: string, version: string) => Promise<FetchResult>

interface MainOptions {
  argv: string[]
  env: Record<string, string | undefined>
  fetchVersionManifest?: FetchManifest
  appendOutput: (line: string) => void
  log?: (msg: string) => void
  error?: (msg: string) => void
}

interface ScriptModule {
  parseArgs: (argv: string[]) => { packageName: string; version: string }
  classify: (result: FetchResult, version: string, expectedSha: string) => { skip: boolean; reason: string }
  main: (options: MainOptions) => Promise<number>
  defaultFetchVersionManifest: unknown
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script = require('../../.github/scripts/npm-version-published.js') as ScriptModule
// eslint-disable-next-line @typescript-eslint/no-var-requires
const distTags = require('../../.github/scripts/npm-dist-tags.js')

const PKG = '@ai-support-agent/cli'
const VERSION = '0.5.15-beta.0'
const SHA = 'a461bc5d0d8412cd58d64645925fddffa4559678'
const OTHER_SHA = 'd306db6dc8382e2fa84c0630d60f8e7f629215e8'

/** レジストリが公開済みバージョンに返すマニフェスト（実測の形を縮めたもの）。 */
const manifest = (fields: Record<string, unknown>): FetchResult => ({
  status: 200,
  body: JSON.stringify({ name: PKG, version: VERSION, ...fields }),
})
const published = (sha: string) => manifest({ gitHead: sha })

/** 存在しないバージョンへの応答（実測: HTTP 404）。 */
const NOT_FOUND: FetchResult = { status: 404, body: '"version not found: 0.0.0-nonexistent"' }

async function run(
  result: FetchResult | (() => Promise<FetchResult>),
  {
    argv = [`--package=${PKG}`, `--version=${VERSION}`],
    env = { GITHUB_SHA: SHA } as Record<string, string | undefined>,
  } = {},
) {
  const outputs: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  const calls: Array<[string, string]> = []
  const code = await script.main({
    argv,
    env,
    fetchVersionManifest: async (pkg, ver) => {
      calls.push([pkg, ver])
      return typeof result === 'function' ? result() : result
    },
    appendOutput: (line) => outputs.push(line),
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  })
  return { code, outputs, logs, errors, calls }
}

describe('npm-version-published.js', () => {
  describe('main: 判定表', () => {
    it('200 かつ同じコミットから公開済みなら skip=true を出力して成功する（再実行）', async () => {
      const r = await run(published(SHA))
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['skip=true'])
      expect(r.logs.join('\n')).toContain('already published')
      expect(r.calls).toEqual([[PKG, VERSION]])
    })

    it('200 かつ別コミットから公開済みなら失敗し、skip を出力しない', async () => {
      const r = await run(published(OTHER_SHA))
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      const msg = r.errors.join('\n')
      expect(msg).toContain('::error::')
      expect(msg).toContain(OTHER_SHA)
      expect(msg).toContain(SHA)
    })

    it('200 だが gitHead が無いなら失敗する（同じソースだと証明できない）', async () => {
      const r = await run(manifest({}))
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toMatch(/gitHead/)
    })

    it('404（未公開）なら skip=false を出力して成功する', async () => {
      const r = await run(NOT_FOUND)
      expect(r.code).toBe(0)
      expect(r.outputs).toEqual(['skip=false'])
    })

    it.each<[string, FetchResult]>([
      ['HTTP 500', { status: 500, body: 'Internal Server Error' }],
      ['HTTP 429', { status: 429, body: 'Too Many Requests' }],
      ['HTTP 503', { status: 503, body: 'Service Unavailable' }],
      ['HTTP 304', { status: 304, body: '' }],
      ['HTTP 401', { status: 401, body: '{"error":"unauthorized"}' }],
      ['200 で壊れた JSON', { status: 200, body: '{"gitHead": "' }],
      ['200 で JSON でない', { status: 200, body: 'gitHead: abc' }],
      ['200 で空', { status: 200, body: '' }],
      ['200 で配列', { status: 200, body: JSON.stringify([{ gitHead: SHA, version: VERSION }]) }],
      ['200 で null', { status: 200, body: 'null' }],
      ['200 で文字列', { status: 200, body: JSON.stringify(SHA) }],
    ])('%s は「未公開」とも「公開済み」とも扱わず失敗する', async (_label, result) => {
      const r = await run(result)
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toContain('::error::')
    })

    it('タイムアウト（AbortSignal.timeout の TimeoutError）は失敗する', async () => {
      const r = await run(() =>
        Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      )
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toMatch(/timeout/i)
    })

    it('接続エラーは失敗する', async () => {
      const r = await run(() => Promise.reject(new TypeError('fetch failed')))
      expect(r.code).toBe(1)
      expect(r.outputs).toEqual([])
      expect(r.errors.join('\n')).toContain('fetch failed')
    })
  })

  describe('classify: 公開済みだが照合できない場合', () => {
    it('gitHead が文字列でなければ失敗する', () => {
      expect(() => script.classify(manifest({ gitHead: 1 }), VERSION, SHA)).toThrow(/gitHead/)
      expect(() => script.classify(manifest({ gitHead: null }), VERSION, SHA)).toThrow(/gitHead/)
      expect(() => script.classify(manifest({ gitHead: '' }), VERSION, SHA)).toThrow(/gitHead/)
    })

    it('マニフェストの version が要求と違えば失敗する（別バージョンの gitHead で照合しない）', () => {
      const r = { status: 200, body: JSON.stringify({ version: '0.5.14', gitHead: SHA }) }
      expect(() => script.classify(r, VERSION, SHA)).toThrow(/0\.5\.14/)
    })

    it('大文字小文字・前後空白の違いで別コミット扱いにしない', () => {
      expect(script.classify(manifest({ gitHead: ` ${SHA.toUpperCase()} ` }), VERSION, SHA).skip).toBe(true)
    })
  })

  describe('取得経路', () => {
    it('既定の取得関数は共有モジュールのキャッシュされない fetchVersionManifest', () => {
      expect(typeof distTags.fetchVersionManifest).toBe('function')
      expect(script.defaultFetchVersionManifest).toBe(distTags.fetchVersionManifest)
    })

    it('fetchVersionManifest を注入しなければ /<pkg%2f>/<version> を GET する（npm view を起動しない）', async () => {
      const fetched: string[] = []
      const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
        fetched.push(String(url))
        return { status: 200, text: async () => JSON.stringify({ version: VERSION, gitHead: SHA }) }
      }) as unknown as typeof fetch)
      const outputs: string[] = []
      try {
        const code = await script.main({
          argv: [`--package=${PKG}`, `--version=${VERSION}`],
          env: { GITHUB_SHA: SHA },
          appendOutput: (l) => outputs.push(l),
          log: () => undefined,
          error: () => undefined,
        })
        expect(code).toBe(0)
      } finally {
        spy.mockRestore()
      }
      expect(fetched).toEqual([`https://registry.npmjs.org/@ai-support-agent%2fcli/${VERSION}`])
      expect(outputs).toEqual(['skip=true'])
    })
  })

  describe('入力検証', () => {
    it('GITHUB_SHA が無ければレジストリを読まずに失敗する', async () => {
      const r = await run(published(SHA), { env: {} })
      expect(r.code).toBe(1)
      expect(r.calls).toEqual([])
      expect(r.outputs).toEqual([])
    })

    it('GITHUB_SHA が 40 桁の 16 進でなければ失敗する', async () => {
      const r = await run(published(SHA), { env: { GITHUB_SHA: 'main' } })
      expect(r.code).toBe(1)
      expect(r.calls).toEqual([])
    })

    it.each(['beta', 'latest', '^0.5.0', '0.5.x', '', 'v0.5.15', '0.5.15/../x'])(
      '厳密なバージョンでない %p は拒否する（dist-tag や範囲で別バージョンを照合しない）',
      async (version) => {
        const r = await run(published(SHA), {
          argv: [`--package=${PKG}`, `--version=${version}`],
        })
        expect(r.code).toBe(1)
        expect(r.calls).toEqual([])
      },
    )

    it('未知の引数・パッケージ名欠落を拒否する', () => {
      expect(() => script.parseArgs(['--version=1.0.0'])).toThrow(/--package/)
      expect(() => script.parseArgs(['--package=x', '--version=1.0.0', '--foo'])).toThrow(/Unknown/)
    })

    it('--channel は受け付けない（チャンネルは npm-publish-tag.js・npm-channel-target.js が扱う）', () => {
      // publish ジョブの出力でチャンネル可否を決めると「Re-run failed jobs」で古い出力が再利用される。
      expect(() => script.parseArgs(['--package=x', '--version=1.0.0', '--channel=latest'])).toThrow(
        /Unknown/,
      )
    })

    it('正しい引数を解釈する', () => {
      expect(script.parseArgs([`--package=${PKG}`, '--version=1.2.3-beta.4'])).toEqual({
        packageName: PKG,
        version: '1.2.3-beta.4',
      })
    })
  })
})
