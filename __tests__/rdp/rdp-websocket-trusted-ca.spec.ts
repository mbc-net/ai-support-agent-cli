import { RdpWebSocket, type RdpServerMessage } from '../../src/rdp/rdp-websocket'
import { RdpTrustedCaStore } from '../../src/rdp/rdp-trusted-ca'
import type { RdpTunnelSupport } from '../../src/rdp/rdp-tunnel'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'

jest.mock('../../src/logger')

/**
 * rdp_open に trustedCaCertificates がある場合の入口。
 *
 * guacd の信頼ストア（bundle.pem）を、guacd に接続する**前**に書き換える。
 * 失敗したら接続せず、理由コード付きの致命エラーをブラウザまで届ける
 * （検証を黙って落とした接続を張らない）。
 */

function harness(apply: (raw: unknown) => void = () => undefined, resolveGuacdThrows = false) {
  const tunnels: RdpTunnelSupport = {
    supportedKinds: jest.fn(() => undefined),
    open: jest.fn(),
    checkDirectTarget: jest.fn(async () => '203.0.113.10'),
  } as unknown as RdpTunnelSupport
  const order: string[] = []
  const resolveGuacd = jest.fn(() => {
    order.push('resolve')
    if (resolveGuacdThrows) throw new Error('rdp capability is off')
    return { host: 'ais-guacd-x', port: 4822 }
  })
  const store = {
    apply: jest.fn((raw: unknown) => {
      order.push('apply')
      apply(raw)
    }),
  } as unknown as RdpTrustedCaStore
  const ws = new RdpWebSocket('https://api.example.com', 'tok', 'agent-1', resolveGuacd, tunnels, store)
  const sent: Record<string, unknown>[] = []
  ;(ws as unknown as { sendMessage: (m: Record<string, unknown>) => void }).sendMessage = (m) => {
    sent.push(m)
  }
  const opened: unknown[] = []
  const realRegistry = (ws as unknown as { registry: object }).registry
  ;(ws as unknown as { registry: unknown }).registry = {
    ...realRegistry,
    open: jest.fn((req: unknown) => {
      order.push('open')
      opened.push(req)
      return Promise.resolve()
    }),
  }
  const dispatch = (extra: Record<string, unknown>): void => {
    const msg = {
      type: 'rdp_open',
      sessionId: 'sess-1',
      parameters: { username: 'u' },
      width: 1280,
      height: 800,
      dpi: 96,
      ...extra,
    } as RdpServerMessage
    ;(ws as unknown as { onParsedMessage: (m: RdpServerMessage) => void }).onParsedMessage(msg)
  }
  return { ws, store, sent, opened, order, dispatch }
}

describe('RdpWebSocket — rdp_open.trustedCaCertificates', () => {
  it('★ guacd の解決の後・セッション登録の前に信頼ストアへ反映する', () => {
    const h = harness()
    h.dispatch({ trustedCaCertificates: [TEST_CA_PEM] })
    expect(h.store.apply).toHaveBeenCalledWith([TEST_CA_PEM])
    expect(h.order).toEqual(['resolve', 'apply', 'open'])
    expect(h.sent).toEqual([])
  })

  it('★ 空配列も反映する（標準バンドルへ戻す）', () => {
    const h = harness()
    h.dispatch({ trustedCaCertificates: [] })
    expect(h.store.apply).toHaveBeenCalledWith([])
    expect(h.opened).toHaveLength(1)
  })

  it('trustedCaCertificates が無ければ信頼ストアに触れない', () => {
    const h = harness()
    h.dispatch({})
    expect(h.store.apply).not.toHaveBeenCalled()
    expect(h.opened).toHaveLength(1)
  })

  it('★ 反映に失敗したら致命エラーで断り、登録しない', () => {
    const h = harness(() => {
      throw new Error('rdp_trusted_ca_unsupported: no trust store')
    })
    h.dispatch({ trustedCaCertificates: [TEST_CA_PEM] })
    expect(h.opened).toEqual([])
    expect(h.sent).toEqual([
      {
        type: 'error',
        sessionId: 'sess-1',
        message: 'rdp_trusted_ca_unsupported: no trust store',
        fatal: true,
      },
    ])
  })

  it('guacd を解決できなければ信頼ストアに触れない', () => {
    const h = harness(undefined, true)
    h.dispatch({ trustedCaCertificates: [TEST_CA_PEM] })
    expect(h.store.apply).not.toHaveBeenCalled()
    expect(h.sent[0]).toEqual(expect.objectContaining({ type: 'error', fatal: true }))
  })

  it('★ 第 6 引数の既定は RdpTrustedCaStore', () => {
    const ws = new RdpWebSocket('https://api.example.com', 'tok', 'agent-1', () => ({
      host: 'h',
      port: 1,
    }))
    expect((ws as unknown as { trustedCa: unknown }).trustedCa).toBeInstanceOf(RdpTrustedCaStore)
  })
})
