import * as net from 'net'
import { PassThrough } from 'stream'

import {
  inspectConnectionRequest,
  RELAY_GATE_MAX_BYTES,
  RELAY_GATE_TIMEOUT_MS,
  readFirstTpkt,
} from '../../src/rdp/rdp-relay-gate'

/**
 * 中継の入口の合言葉（routing token）検査。
 *
 * guacd には `load-balance-info` として合言葉を渡す。FreeRDP 2.x はこれを
 * X.224 Connection Request の可変部の先頭に、**生の値 + CRLF** として載せ、
 * mstshash の Cookie は送らない（FreeRDP 2.11.7 libfreerdp/core/nego.c
 * `nego_send_negotiation_request`）。guacd 1.5.5 で実際に採取した先頭パケット:
 *
 *   03 00 00 26 | 21 e0 00 00 00 00 00 | "TOKEN_abc-DEF_123" 0d 0a | 01 00 08 00 03 00 00 00
 */

const TOKEN = 'k3y_abcdefghijklmnopqrstuvwxyz0123'

/** FreeRDP と同じ形の Connection Request を組み立てる。 */
function connectionRequest(cookieLine?: string, negReq = true): Buffer {
  const variable = cookieLine === undefined ? Buffer.alloc(0) : Buffer.from(`${cookieLine}\r\n`, 'latin1')
  const neg = negReq ? Buffer.from([0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00]) : Buffer.alloc(0)
  const total = 11 + variable.length + neg.length
  const head = Buffer.from([0x03, 0x00, total >> 8, total & 0xff, total - 5, 0xe0, 0, 0, 0, 0, 0])
  return Buffer.concat([head, variable, neg])
}

describe('inspectConnectionRequest', () => {
  it('★ 実際に guacd 1.5.5 が送った形を受理する（採取したバイト列）', () => {
    const captured = Buffer.from(
      '0300002621e00000000000544f4b454e5f6162632d4445465f3132330d0a0100080003000000',
      'hex',
    )
    const result = inspectConnectionRequest(captured, 'TOKEN_abc-DEF_123')
    expect(result).toEqual({
      ok: true,
      // 19 バイト（トークン 17 + CRLF）を除いた 0x13 バイト、LI は 0x0e
      rewritten: Buffer.from('030000130ee000000000000100080003000000', 'hex'),
    })
  })

  it('★ 正しいトークン: その行を取り除き、TPKT の長さと LI を書き直す', () => {
    const packet = connectionRequest(TOKEN)
    const result = inspectConnectionRequest(packet, TOKEN)
    if (!result.ok) throw new Error(result.reason)
    const expected = connectionRequest(undefined)
    expect(result.rewritten).toEqual(expected)
    expect(result.rewritten.readUInt16BE(2)).toBe(19)
    expect(result.rewritten[4]).toBe(19 - 5)
  })

  it('★ 元の routing token を差し戻す: 長さと LI も書き直す', () => {
    const result = inspectConnectionRequest(connectionRequest(TOKEN), TOKEN, 'tsv://MS Terminal Services Plugin.1.C')
    if (!result.ok) throw new Error(result.reason)
    expect(result.rewritten).toEqual(connectionRequest('tsv://MS Terminal Services Plugin.1.C'))
    const expectedLength = 11 + 'tsv://MS Terminal Services Plugin.1.C'.length + 2 + 8
    expect(result.rewritten.readUInt16BE(2)).toBe(expectedLength)
    expect(result.rewritten[4]).toBe(expectedLength - 5)
  })

  it('元の値が既に CRLF で終わっていれば CRLF を重ねない（FreeRDP と同じ）', () => {
    const result = inspectConnectionRequest(connectionRequest(TOKEN), TOKEN, 'orig\r\n')
    if (!result.ok) throw new Error(result.reason)
    expect(result.rewritten).toEqual(connectionRequest('orig'))
  })

  it('差し戻すと LI が 1 バイトに収まらないなら拒否', () => {
    const result = inspectConnectionRequest(connectionRequest(TOKEN), TOKEN, 'x'.repeat(300))
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/too long/) })
  })

  describe('LI の境界（0〜254 が有効、255 は予約値）', () => {
    /** 合言葉付きの CR を、LI がちょうど `li` になるまで後ろを埋めて作る。 */
    const withLi = (li: number): Buffer => {
      const base = connectionRequest(TOKEN)
      const total = li + 5
      const padded = Buffer.concat([base, Buffer.alloc(total - base.length, 0x00)])
      padded.writeUInt16BE(total, 2)
      padded[4] = li
      return padded
    }

    it('★ 入力の LI=254 は受理する', () => {
      const result = inspectConnectionRequest(withLi(254), TOKEN)
      expect(result.ok).toBe(true)
    })

    it('★ 入力の LI=255（予約値）は拒否する', () => {
      expect(inspectConnectionRequest(withLi(255), TOKEN)).toEqual({
        ok: false,
        reason: expect.stringMatching(/reserved/),
      })
    })

    // 書き直し後の LI = 16 + 差し戻す値の長さ（固定部 6 + 値 + CRLF + RDP_NEG_REQ 8）
    it('★ 書き直し後の LI=254 は受理する', () => {
      const result = inspectConnectionRequest(connectionRequest(TOKEN), TOKEN, 'x'.repeat(238))
      if (!result.ok) throw new Error(result.reason)
      expect(result.rewritten[4]).toBe(254)
      expect(result.rewritten.readUInt16BE(2)).toBe(259)
    })

    it('★ 書き直し後の LI=255（予約値）は拒否する', () => {
      expect(inspectConnectionRequest(connectionRequest(TOKEN), TOKEN, 'x'.repeat(239))).toEqual({
        ok: false,
        reason: expect.stringMatching(/too long/),
      })
    })
  })

  it('RDP_NEG_REQ が無い CR でも書き直せる', () => {
    const result = inspectConnectionRequest(connectionRequest(TOKEN, false), TOKEN)
    if (!result.ok) throw new Error(result.reason)
    expect(result.rewritten).toEqual(connectionRequest(undefined, false))
    expect(result.rewritten.readUInt16BE(2)).toBe(11)
  })

  it.each([
    ['違うトークン', connectionRequest('k3y_abcdefghijklmnopqrstuvwxyz0124'), /token mismatch/],
    ['長さの違うトークン', connectionRequest('short'), /token mismatch/],
    ['トークンなし（可変部なし）', connectionRequest(undefined), /no routing token/],
    ['mstshash だけ', connectionRequest('Cookie: mstshash=admin'), /token mismatch/],
    ['CRLF が無い', Buffer.concat([connectionRequest(undefined).subarray(0, 11), Buffer.from(TOKEN)]), /no routing token|length/],
  ])('★ %s は拒否', (_name, packet, pattern) => {
    const fixed = Buffer.from(packet)
    if (fixed.length >= 4 && fixed.readUInt16BE(2) !== fixed.length) {
      fixed.writeUInt16BE(fixed.length, 2)
      fixed[4] = fixed.length - 5
    }
    const result = inspectConnectionRequest(fixed, TOKEN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(pattern)
  })

  it('★ 先頭が 0x03 以外は拒否', () => {
    const packet = connectionRequest(TOKEN)
    packet[0] = 0x16 // TLS ClientHello など
    const result = inspectConnectionRequest(packet, TOKEN)
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/not a TPKT/) })
  })

  it('★ LI が TPKT の長さと合わなければ拒否', () => {
    const packet = connectionRequest(TOKEN)
    packet[4] = packet[4] + 1
    expect(inspectConnectionRequest(packet, TOKEN)).toEqual({
      ok: false,
      reason: expect.stringMatching(/length indicator/),
    })
  })

  it('★ Connection Request（0xE0）以外は拒否', () => {
    const packet = connectionRequest(TOKEN)
    packet[5] = 0xf0
    expect(inspectConnectionRequest(packet, TOKEN)).toEqual({
      ok: false,
      reason: expect.stringMatching(/not an X\.224 Connection Request/),
    })
  })

  it('TPKT の長さとバッファの長さが違えば拒否', () => {
    const packet = connectionRequest(TOKEN)
    expect(inspectConnectionRequest(packet.subarray(0, packet.length - 1), TOKEN).ok).toBe(false)
  })

  it('短すぎる TPKT は拒否', () => {
    expect(inspectConnectionRequest(Buffer.from([0x03, 0x00, 0x00, 0x04]), TOKEN).ok).toBe(false)
  })
})

describe('readFirstTpkt', () => {
  it('★ 1 バイトずつ届いても組み立てる', async () => {
    const stream = new PassThrough()
    const packet = connectionRequest(TOKEN)
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    for (const byte of packet) {
      stream.write(Buffer.from([byte]))
      await new Promise((r) => setImmediate(r))
    }
    await expect(reading).resolves.toEqual({ packet, rest: Buffer.alloc(0) })
  })

  it('TPKT の後ろに続いたバイトは rest として返す', async () => {
    const stream = new PassThrough()
    const packet = connectionRequest(TOKEN)
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    stream.write(Buffer.concat([packet, Buffer.from('extra')]))
    await expect(reading).resolves.toEqual({ packet, rest: Buffer.from('extra') })
  })

  it('★ 長さが上限（1 KiB）を超えれば読まずに拒否', async () => {
    const stream = new PassThrough()
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    stream.write(Buffer.from([0x03, 0x00, 0x04, 0x01]))
    await expect(reading).rejects.toThrow(/exceeds 1024 bytes/)
    expect(RELAY_GATE_MAX_BYTES).toBe(1024)
  })

  it('★ 先頭が 0x03 以外なら即座に拒否', async () => {
    const stream = new PassThrough()
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    stream.write(Buffer.from('GET / HTTP/1.1\r\n'))
    await expect(reading).rejects.toThrow(/not a TPKT/)
  })

  it('★ 期限切れで拒否（既定は 5 秒）', async () => {
    const stream = new PassThrough()
    const reading = readFirstTpkt(stream as unknown as net.Socket, { timeoutMs: 20 })
    stream.write(Buffer.from([0x03, 0x00]))
    await expect(reading).rejects.toThrow(/within 20ms/)
    expect(RELAY_GATE_TIMEOUT_MS).toBe(5_000)
  })

  it('読み終わる前に閉じたら拒否', async () => {
    const stream = new PassThrough()
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    stream.write(Buffer.from([0x03]))
    stream.end()
    await expect(reading).rejects.toThrow(/closed before/)
  })

  it('エラーでも拒否', async () => {
    const stream = new PassThrough()
    const reading = readFirstTpkt(stream as unknown as net.Socket)
    stream.destroy(new Error('ECONNRESET'))
    await expect(reading).rejects.toThrow(/ECONNRESET/)
  })
})
