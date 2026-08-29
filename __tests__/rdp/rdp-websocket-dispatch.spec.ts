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
    it('★ closes every session when the API connection drops', () => {
      ;(ws as unknown as { onDisconnect: () => void }).onDisconnect()
      expect(calls).toEqual(['closeAll:API connection lost'])
    })
  })
})
