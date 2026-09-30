import { PassThrough, Readable } from 'stream'

import { createSsmBannerFilter } from '../../src/rdp/ssm-session-banner'

/**
 * session-manager-plugin の stdout に混ざる非データ行の扱い（stdio 方式）。
 *
 * 根拠（aws/session-manager-plugin mainline）:
 * - session.go `Execute`: データチャネルを開く前に
 *   `fmt.Fprintf(os.Stdout, "\nStarting session with SessionId: %s\n", s.SessionId)`
 * - datachannel/streaming.go: ハンドシェイク完了時に CustomerMessage があれば
 *   `fmt.Fprintln(os.Stdout, …)`、チャネル終了時に
 *   `"\n\nExiting session with sessionId: %s.\n\n"`
 *
 * 先頭の Starting 行だけは形式が決まっているので、その形式に一致するときだけ捨てる。
 * その後の最初のバイトは RDP サーバーの TPKT（0x03）でなければならず、
 * それ以外（CustomerMessage など）は推測で捨てずに接続を失敗させる。
 */

async function run(chunks: (string | Buffer)[]): Promise<{ data: Buffer; error?: Error }> {
  const source = new PassThrough()
  const filtered = source.pipe(createSsmBannerFilter())
  const out: Buffer[] = []
  const done = new Promise<{ data: Buffer; error?: Error }>((resolve) => {
    filtered.on('data', (d: Buffer) => out.push(d))
    filtered.on('end', () => resolve({ data: Buffer.concat(out) }))
    filtered.on('error', (error) => resolve({ data: Buffer.concat(out), error }))
  })
  for (const c of chunks) source.write(c)
  source.end()
  return done
}

const TPKT = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, 0x02, 0x00, 0x08, 0x00, 0x02, 0, 0, 0])
const BANNER = '\nStarting session with SessionId: botocore-session-0123456789abcdef0\n'

describe('createSsmBannerFilter', () => {
  it('★ Starting 行を捨て、以降のデータはそのまま通す', async () => {
    const result = await run([BANNER, TPKT, Buffer.from('more')])
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(Buffer.concat([TPKT, Buffer.from('more')]))
  })

  it('★ 1 バイトずつ届いても同じ', async () => {
    const all = Buffer.concat([Buffer.from(BANNER), TPKT])
    const result = await run([...all].map((b) => Buffer.from([b])))
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(TPKT)
  })

  it('★ Starting 行とデータが同じチャンクでも分けて扱う', async () => {
    const result = await run([Buffer.concat([Buffer.from(BANNER), TPKT])])
    expect(result.data).toEqual(TPKT)
  })

  it('★ 形式の違う先頭は捨てずに失敗させる', async () => {
    const result = await run(['\nSomething else\n', TPKT])
    expect(result.error?.message).toMatch(/unexpected output from session-manager-plugin/)
    expect(result.data.length).toBe(0)
  })

  it('★ Starting 行の後に RDP 以外（CustomerMessage など）が来たら失敗させる', async () => {
    const result = await run([BANNER, 'Welcome to the bastion\n', TPKT])
    expect(result.error?.message).toMatch(/unexpected output from session-manager-plugin before RDP data/)
    expect(result.data.length).toBe(0)
  })

  it('SessionId に使えない文字が入っていたら失敗させる', async () => {
    const result = await run(['\nStarting session with SessionId: a b\n', TPKT])
    expect(result.error).toBeDefined()
  })

  it('Starting 行が長すぎれば失敗させる', async () => {
    const result = await run([`\nStarting session with SessionId: ${'x'.repeat(300)}`])
    expect(result.error?.message).toMatch(/unexpected output/)
  })

  it('データが来る前に終わっても失敗にはしない（空で終わる）', async () => {
    const result = await run([BANNER])
    expect(result.error).toBeUndefined()
    expect(result.data.length).toBe(0)
  })

  it('Readable.from でも動く', async () => {
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      Readable.from([Buffer.from(BANNER), TPKT])
        .pipe(createSsmBannerFilter())
        .on('data', (d: Buffer) => chunks.push(d))
        .on('end', () => resolve())
        .on('error', reject)
    })
    expect(Buffer.concat(chunks)).toEqual(TPKT)
  })
})
