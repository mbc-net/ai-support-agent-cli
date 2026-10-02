import { RdpWebSocket } from '../../src/rdp/rdp-websocket'
import type { RdpServerMessage } from '../../src/rdp/rdp-websocket'

/**
 * Message dispatch on the agent's RDP WebSocket.
 *
 * The socket itself (connect/reconnect/framing) is the base class's job; what is
 * specific here is turning each server message into a registry action, and
 * refusing anything malformed **before** it reaches guacd.
 */

describe('RdpWebSocket message dispatch', () => {
  let ws: RdpWebSocket
  let calls: string[]

  /** Replace the registry with a recorder. */
  const stubRegistry = (): void => {
    calls = []
    ;(ws as unknown as { registry: unknown }).registry = {
      open: jest.fn((req: { sessionId: string }) => {
        calls.push(`open:${req.sessionId}`)
        return Promise.resolve()
      }),
      send: jest.fn((id: string, data: string) => {
        calls.push(`send:${id}:${data}`)
      }),
      resize: jest.fn((id: string, w: number, h: number) => {
        calls.push(`resize:${id}:${w}x${h}`)
      }),
      close: jest.fn((id: string, reason: string) => {
        calls.push(`close:${id}:${reason}`)
      }),
      closeAll: jest.fn((reason: string) => {
        calls.push(`closeAll:${reason}`)
      }),
      has: jest.fn((id: string) => id === 'sess-1'),
      size: 0,
    }
  }

  const dispatch = (msg: RdpServerMessage): void => {
    ;(
      ws as unknown as {
        onParsedMessage: (msg: RdpServerMessage) => void
      }
    ).onParsedMessage(msg)
  }

  const openMsg = (overrides: Partial<RdpServerMessage> = {}): RdpServerMessage =>
    ({
      type: 'rdp_open',
      sessionId: 'sess-1',
      parameters: { hostname: '10.0.0.5' },
      width: 1280,
      height: 800,
      dpi: 96,
      ...overrides,
    }) as RdpServerMessage

  beforeEach(() => {
    ws = new RdpWebSocket('https://api.example.com', 'token', 'agent-1')
    stubRegistry()
  })

  it('opens a session', () => {
    dispatch(openMsg())
    expect(calls).toEqual(['open:sess-1'])
  })

  it('forwards data', () => {
    dispatch({ type: 'rdp_data', sessionId: 'sess-1', data: 'QQ==' })
    expect(calls).toEqual(['send:sess-1:QQ=='])
  })

  it('forwards a resize', () => {
    dispatch({
      type: 'rdp_resize',
      sessionId: 'sess-1',
      width: 1920,
      height: 1080,
    })
    expect(calls).toEqual(['resize:sess-1:1920x1080'])
  })

  it('closes a session', () => {
    dispatch({ type: 'rdp_close', sessionId: 'sess-1' })
    expect(calls).toEqual(['close:sess-1:closed by API'])
  })

  it('logs an API-reported error without touching any session', () => {
    dispatch({
      type: 'error',
      sessionId: 'sess-1',
      message: 'boom',
    } as RdpServerMessage)
    expect(calls).toEqual([])
  })

  it('★ API が知らないセッションは閉じる（孤児の guacd 接続を残さない）', () => {
    // grace で生き延びたあと API 側のセッションが既に消えていると、以後この
    // エージェントの送信はすべて「Session not found」で弾かれる。閉じなければ
    // guacd 接続とリモートホスト上の RDP ログオンが誰にも見えないまま残る。
    dispatch({
      type: 'error',
      sessionId: 'sess-1',
      message: 'Session not found: sess-1',
    } as RdpServerMessage)
    expect(calls).toEqual(['close:sess-1:the API no longer knows this session'])
  })

  it('知らないセッション ID の Session not found では何もしない', () => {
    dispatch({
      type: 'error',
      sessionId: 'other',
      message: 'Session not found: other',
    } as RdpServerMessage)
    expect(calls).toEqual([])
  })

  it('ignores the auth acknowledgement', () => {
    dispatch({ type: 'auth_success' } as RdpServerMessage)
    expect(calls).toEqual([])
  })

  describe('rejects malformed input before it reaches guacd', () => {
    it.each([
      ['path traversal', '../../etc/passwd'],
      ['shell metacharacters', 'a;rm -rf /'],
      ['empty', ''],
    ])('★ refuses an unsafe sessionId (%s)', (_label, sessionId) => {
      dispatch(openMsg({ sessionId } as Partial<RdpServerMessage>))
      expect(calls).toEqual([])
    })

    it('★ refuses an open with no parameters object', () => {
      dispatch(openMsg({ parameters: undefined } as Partial<RdpServerMessage>))
      expect(calls).toEqual([])
    })

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['non-integer', 12.5],
      ['absurd', 100000],
    ])('★ refuses an open with a %s width', (_label, width) => {
      dispatch(openMsg({ width } as Partial<RdpServerMessage>))
      expect(calls).toEqual([])
    })

    it('★ refuses a resize with an invalid dimension', () => {
      dispatch({
        type: 'rdp_resize',
        sessionId: 'sess-1',
        width: 0,
        height: 1080,
      })
      expect(calls).toEqual([])
    })

    it('ignores an unknown message type', () => {
      dispatch({ type: 'rdp_bogus', sessionId: 'sess-1' } as never)
      expect(calls).toEqual([])
    })

    it('ignores a message with no sessionId', () => {
      dispatch({ type: 'rdp_data', data: 'QQ==' } as never)
      expect(calls).toEqual([])
    })
  })

  describe('teardown', () => {
    // The base class calls onDisconnect() ONLY from the public disconnect()
    // (explicit shutdown). Real drops — ALB idle timeout, a network blip, a
    // heartbeat false positive, an API restart — land on onWebSocketClose(),
    // and a permanent auth rejection lands on onPermanentClose(). Wiring the
    // teardown to onDisconnect() alone leaves guacd sockets — and the RDP
    // logons they represent — alive through every reconnect, addressable by
    // nobody: the API's session registry is keyed to the old connection.
    const hook = (name: string): void => {
      ;(ws as unknown as Record<string, () => void>)[name]()
    }

    it.each(['onWebSocketClose', 'onPermanentClose', 'onDisconnect'])(
      '★ %s で全セッションを即座に閉じる',
      (name) => {
        hook(name)
        expect(calls).toEqual(['closeAll:API connection lost'])
      },
    )

    it('★ 一時切断でも猶予を置かない（RDP は再開できないため）', () => {
      // ターミナルは一時切断に猶予を置けるが、それは出力をリングバッファに溜めて
      // 再生できるから。RDP には同等の仕組みが無く、WS が OPEN でない間の送信は
      // sendMessage が黙って捨てる。Guacamole の命令列は差分の積み重ねなので、
      // 欠落を挟んで再開すると画面は静かに壊れたまま復旧しない。
      const registry = (ws as unknown as { registry: Record<string, unknown> })
        .registry
      expect(registry.closeAllGracefully).toBeUndefined()

      hook('onWebSocketClose')
      expect(calls).toEqual(['closeAll:API connection lost'])
    })

    it('★ 一時切断のフックが基底クラスの契約どおり存在する', () => {
      // onDisconnect だけを実装しても、実際の切断経路では呼ばれない。
      const proto = Object.getPrototypeOf(ws) as Record<string, unknown>
      expect(typeof proto.onWebSocketClose).toBe('function')
      expect(typeof proto.onPermanentClose).toBe('function')
    })
  })
})
