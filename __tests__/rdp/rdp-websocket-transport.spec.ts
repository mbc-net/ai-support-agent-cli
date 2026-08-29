import { connectToGuacd } from '../../src/rdp/guacd-tcp-socket'
import { RdpWebSocket } from '../../src/rdp/rdp-websocket'

jest.mock('ws', () => {
  const MockWebSocket = jest.fn().mockImplementation((url: string, opts: unknown) => ({
    url,
    opts,
    readyState: 1,
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
  }))
  ;(MockWebSocket as unknown as { OPEN: number }).OPEN = 1
  return { __esModule: true, default: MockWebSocket }
})

jest.mock('../../src/rdp/guacd-tcp-socket', () => ({
  ...jest.requireActual('../../src/rdp/guacd-tcp-socket'),
  connectToGuacd: jest.fn(),
}))

/**
 * Transport wiring: the URL and headers the agent dials with, and the seams
 * that connect the registry to the socket and to guacd.
 */

const WebSocketMock = jest.requireMock('ws').default as jest.Mock

describe('RdpWebSocket transport wiring', () => {
  beforeEach(() => {
    WebSocketMock.mockClear()
    ;(connectToGuacd as jest.Mock).mockReset()
    ;(connectToGuacd as jest.Mock).mockResolvedValue({
      write: jest.fn(),
      onData: jest.fn(),
      onClose: jest.fn(),
      onError: jest.fn(),
      destroy: jest.fn(),
    })
    delete process.env.GUACD_HOST
    delete process.env.GUACD_PORT
  })

  const create = (): RdpWebSocket =>
    new RdpWebSocket('https://api.example.com', 'tok', 'agent-1')

  const call = <T>(ws: RdpWebSocket, name: string, ...args: unknown[]): T =>
    (ws as unknown as Record<string, (...a: unknown[]) => T>)[name](...args)

  it('dials the agent RDP path over wss', () => {
    call(create(), 'createWebSocket')
    expect(WebSocketMock).toHaveBeenCalledWith(
      'wss://api.example.com/ws/agent-rdp',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('★ sends the agent token and id as handshake headers', () => {
    call(create(), 'createWebSocket')
    const headers = WebSocketMock.mock.calls[0][1].headers as Record<
      string,
      string
    >
    expect(JSON.stringify(headers)).toContain('tok')
    expect(JSON.stringify(headers)).toContain('agent-1')
  })

  it('resolves the connect promise on open', () => {
    const resolve = jest.fn()
    call(create(), 'onOpen', {}, resolve)
    expect(resolve).toHaveBeenCalled()
  })

  it('reports the live session count', () => {
    const ws = create()
    expect(ws.sessionCount).toBe(0)
  })

  it('routes registry output onto the socket', () => {
    const ws = create()
    const sendMessage = jest.fn()
    ;(ws as unknown as { sendMessage: unknown }).sendMessage = sendMessage

    call(ws, 'sendToApi', { type: 'rdp_ready', sessionId: 's', connectionId: 'c' })
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'rdp_ready',
      sessionId: 's',
      connectionId: 'c',
    })
  })

  describe('guacd endpoint', () => {
    /** Reach the registry's connect seam without opening a session. */
    const connectSeam = (ws: RdpWebSocket): (() => Promise<unknown>) =>
      (
        (ws as unknown as { registry: { options: { connect: () => Promise<unknown> } } })
          .registry as unknown as { options: { connect: () => Promise<unknown> } }
      ).options.connect

    it('defaults to loopback on the standard guacd port', async () => {
      const ws = create()
      await connectSeam(ws)()
      expect(connectToGuacd).toHaveBeenCalledWith('127.0.0.1', 4822)
    })

    it('★ honours GUACD_HOST / GUACD_PORT (sidecar deployments)', async () => {
      process.env.GUACD_HOST = 'guacd'
      process.env.GUACD_PORT = '14822'
      const ws = new RdpWebSocket('https://api.example.com', 'tok', 'agent-1')
      await connectSeam(ws)()
      expect(connectToGuacd).toHaveBeenCalledWith('guacd', 14822)
    })

    it('explicit arguments win over the environment', async () => {
      process.env.GUACD_HOST = 'ignored'
      const ws = new RdpWebSocket(
        'https://api.example.com',
        'tok',
        'agent-1',
        'explicit-host',
        9999,
      )
      await connectSeam(ws)()
      expect(connectToGuacd).toHaveBeenCalledWith('explicit-host', 9999)
    })
  })
})
