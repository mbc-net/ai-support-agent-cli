/**
 * `.github/scripts/notify-version.js` の検証。
 *
 * API へ「チャンネルの最新版」を通知する。送る値はこの run の版 V ではなく、
 * 試行のたびに npm の dist-tag から解決し直した版 H（npm-channel-target.js）。
 * 再試行の待ち時間中に新しいリリースがチャンネルを取っても、古い値を送らない。
 *
 * 既存の挙動を維持する:
 *   - 秘密情報が未設定なら warning を出して成功扱い（通知しない）
 *   - 接続エラー/タイムアウト・5xx・429・403 は再試行（最大 3 回、10s/30s 待ち）
 *   - それ以外の 4xx（鍵不正等）は即失敗
 *   - CloudFront の地域制限（"block access from your country"）なら原因を示す
 */

interface FetchResponse {
  status: number
  text: () => Promise<string>
}

type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: unknown },
) => Promise<FetchResponse>

interface MainOptions {
  argv: string[]
  env: Record<string, string | undefined>
  resolveTarget: (options: {
    packageName: string
    version: string
    channel: string
    log: (m: string) => void
  }) => Promise<string>
  fetchImpl: FetchImpl
  sleep: (ms: number) => Promise<void>
  log?: (msg: string) => void
  error?: (msg: string) => void
  maxAttempts?: number
  delaysMs?: number[]
  timeoutMs?: number
}

interface ScriptModule {
  main: (options: MainOptions) => Promise<number>
  isRetryable: (outcome: { status?: number; networkError?: unknown }) => boolean
  MAX_ATTEMPTS: number
  DELAYS_MS: number[]
  TIMEOUT_MS: number
  GEO_BLOCK_MARKER: string
}

const script = require('../../.github/scripts/notify-version.js') as ScriptModule

const PKG = '@ai-support-agent/cli'
const ENV = { VERSION_API_URL: 'https://api.example.test', VERSION_API_KEY: 'k-123' }

type Step = { status: number; body?: string } | Error

async function run(
  steps: Step[],
  {
    targets = ['0.5.16'],
    env = ENV,
    argv = [`--package=${PKG}`, '--version=0.5.16', '--channel=latest'],
    resolveError,
  }: {
    targets?: string[]
    env?: Record<string, string | undefined>
    argv?: string[]
    resolveError?: Error
  } = {},
) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: any; signal: unknown }> =
    []
  const resolves: Array<{ packageName: string; version: string; channel: string }> = []
  const sleeps: number[] = []
  const logs: string[] = []
  const errors: string[] = []
  const order: string[] = []
  let call = 0
  let resolveCall = 0
  const code = await script.main({
    argv,
    env,
    resolveTarget: async ({ packageName, version, channel, log }) => {
      order.push('resolve')
      resolves.push({ packageName, version, channel })
      if (resolveError) throw resolveError
      const t = targets[Math.min(resolveCall, targets.length - 1)]
      resolveCall += 1
      // 本物の resolveTarget は H > V のとき notice を渡された log に出す。
      if (t !== version) log(`::notice::newer ${t} holds ${channel}`)
      return t
    },
    fetchImpl: async (url, init) => {
      order.push('fetch')
      requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body), signal: init.signal })
      const s = steps[Math.min(call, steps.length - 1)]
      call += 1
      if (s instanceof Error) throw s
      return { status: s.status, text: async () => s.body ?? '' }
    },
    sleep: async (ms) => {
      order.push(`sleep:${ms}`)
      sleeps.push(ms)
    },
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  })
  return { code, requests, resolves, sleeps, logs, errors, order }
}

describe('notify-version.js', () => {
  it('解決した target を PUT /api/agent/version に送り、2xx で成功', async () => {
    const r = await run([{ status: 200, body: '{"ok":true}' }])
    expect(r.code).toBe(0)
    expect(r.requests).toHaveLength(1)
    const [req] = r.requests
    expect(req.url).toBe('https://api.example.test/api/agent/version')
    expect(req.method).toBe('PUT')
    expect(req.headers['X-API-Key']).toBe('k-123')
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.body).toEqual({ channel: 'latest', latestVersion: '0.5.16' })
    // タイムアウト付き（curl の --max-time 30 相当）。
    expect(req.signal).toBeDefined()
    expect(r.resolves).toEqual([{ packageName: PKG, version: '0.5.16', channel: 'latest' }])
  })

  it('H > V なら V ではなく H を送る（収束）。解決器の notice はジョブログへ流す', async () => {
    const r = await run([{ status: 204 }], { targets: ['0.5.17'] })
    expect(r.code).toBe(0)
    expect(r.requests[0].body.latestVersion).toBe('0.5.17')
    expect(r.logs.join('\n')).toContain('::notice::')
  })

  it('試行ごとに解決し直す: 1 回目 0.5.16 が 503、2 回目に 0.5.17 へ動いていれば 0.5.17 を送る', async () => {
    const r = await run([{ status: 503 }, { status: 200 }], { targets: ['0.5.16', '0.5.17'] })
    expect(r.code).toBe(0)
    expect(r.requests.map((q) => q.body.latestVersion)).toEqual(['0.5.16', '0.5.17'])
    // 解決は各送信の直前（待ち時間の後）に行う。
    expect(r.order).toEqual(['resolve', 'fetch', 'sleep:10000', 'resolve', 'fetch'])
  })

  it.each<[string, Step]>([
    ['接続エラー', new Error('fetch failed')],
    ['タイムアウト', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['500', { status: 500 }],
    ['502', { status: 502 }],
    ['429', { status: 429 }],
    ['403', { status: 403 }],
  ])('%s は再試行する（最大 3 回、10s/30s 待ち）', async (_label, step) => {
    const r = await run([step])
    expect(r.code).toBe(1)
    expect(r.requests).toHaveLength(3)
    expect(r.resolves).toHaveLength(3)
    expect(r.sleeps).toEqual([10_000, 30_000])
    expect(r.errors.join('\n')).toContain('::error::')
  })

  it.each([400, 401, 404, 422])('%p は再試行せず即失敗する', async (status) => {
    const r = await run([{ status }])
    expect(r.code).toBe(1)
    expect(r.requests).toHaveLength(1)
    expect(r.sleeps).toEqual([])
    expect(r.errors.join('\n')).toContain(`HTTP ${status}`)
  })

  it('再試行の後に成功すれば成功', async () => {
    const r = await run([{ status: 403 }, new Error('ECONNRESET'), { status: 200 }])
    expect(r.code).toBe(0)
    expect(r.requests).toHaveLength(3)
  })

  it('地域制限の 403 なら原因（CloudFront geo restriction）を示す', async () => {
    const r = await run([
      { status: 403, body: '<html>The Amazon CloudFront distribution is configured to block access from your country.</html>' },
    ])
    expect(r.code).toBe(1)
    const msg = r.errors.join('\n')
    expect(msg).toContain('geo restriction')
    expect(msg).toContain('HTTP 403')
  })

  it('地域制限でない失敗では geo のヒントを出さない', async () => {
    const r = await run([{ status: 401, body: 'bad key' }])
    expect(r.errors.join('\n')).not.toContain('geo restriction')
  })

  it.each([
    [{ VERSION_API_URL: '', VERSION_API_KEY: 'k' }],
    [{ VERSION_API_URL: 'https://x', VERSION_API_KEY: '' }],
    [{}],
  ])('秘密情報が未設定（%p）なら warning を出して成功扱い、通知も解決もしない', async (env) => {
    const r = await run([{ status: 200 }], { env })
    expect(r.code).toBe(0)
    expect(r.requests).toEqual([])
    expect(r.resolves).toEqual([])
    expect(r.logs.join('\n')).toContain('::warning::')
  })

  it('target の解決に失敗したら通知せずに失敗する（推測で送らない）', async () => {
    const r = await run([{ status: 200 }], { resolveError: new Error('dist-tag "latest" is still held by the older 0.5.15') })
    expect(r.code).toBe(1)
    expect(r.requests).toEqual([])
    expect(r.errors.join('\n')).toContain('0.5.15')
  })

  it('引数が不正なら何もせず失敗する', async () => {
    const r = await run([{ status: 200 }], { argv: ['--package=x', '--version=latest', '--channel=latest'] })
    expect(r.code).toBe(1)
    expect(r.requests).toEqual([])
    expect(r.resolves).toEqual([])
  })

  it('API キーをログに出さない', async () => {
    const r = await run([{ status: 500, body: 'oops' }])
    expect([...r.logs, ...r.errors].join('\n')).not.toContain('k-123')
  })

  it('既定の解決器はキャッシュされない /-/package/<pkg>/dist-tags から H を読んで送る（npm view の CDN キャッシュを読まない）', async () => {
    const registryCalls: string[] = []
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      registryCalls.push(String(url))
      return { status: 200, text: async () => JSON.stringify({ latest: '0.5.17' }) }
    }) as unknown as typeof fetch)
    const sent: any[] = []
    try {
      const code = await script.main({
        argv: [`--package=${PKG}`, '--version=0.5.16', '--channel=latest'],
        env: ENV,
        // resolveTarget を注入しない＝npm-channel-target.js の既定の読み取りを使う。
        fetchImpl: async (_url, init) => {
          sent.push(JSON.parse(init.body))
          return { status: 200, text: async () => 'ok' }
        },
        sleep: async () => undefined,
        log: () => undefined,
        error: () => undefined,
      } as unknown as MainOptions)
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(registryCalls).toEqual(['https://registry.npmjs.org/-/package/@ai-support-agent%2fcli/dist-tags'])
    expect(sent).toEqual([{ channel: 'latest', latestVersion: '0.5.17' }])
  })

  it('既定値: 3 回・10s/30s・30 秒タイムアウト', () => {
    expect(script.MAX_ATTEMPTS).toBe(3)
    expect(script.DELAYS_MS).toEqual([10_000, 30_000])
    expect(script.TIMEOUT_MS).toBe(30_000)
    expect(script.GEO_BLOCK_MARKER).toBe('block access from your country')
  })

  it('isRetryable の分類', () => {
    expect(script.isRetryable({ networkError: new Error('x') })).toBe(true)
    expect(script.isRetryable({ status: 503 })).toBe(true)
    expect(script.isRetryable({ status: 429 })).toBe(true)
    expect(script.isRetryable({ status: 403 })).toBe(true)
    expect(script.isRetryable({ status: 401 })).toBe(false)
    expect(script.isRetryable({ status: 404 })).toBe(false)
  })
})
