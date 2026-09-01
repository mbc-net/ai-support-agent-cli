import { startRdpWebSocket, type TransportState } from '../../src/agent-transport'

jest.mock('../../src/rdp/rdp-websocket', () => {
  const connect = jest.fn().mockResolvedValue(undefined)
  const disconnect = jest.fn()
  const RdpWebSocket = jest.fn().mockImplementation(() => ({
    connect,
    disconnect,
  }))
  return { RdpWebSocket, __connect: connect, __disconnect: disconnect }
})

/**
 * Starting the RDP relay from the agent's transport layer.
 *
 * The relay must be opt-in on the same signal as the other WebSocket relays
 * (`wsEnabled` from the register response) and must record itself on the shared
 * transport state so shutdown can close it — a relay the shutdown path cannot
 * see keeps RDP logons alive on remote hosts after the agent stops.
 */

const mocked = jest.requireMock('../../src/rdp/rdp-websocket') as {
  RdpWebSocket: jest.Mock
  __connect: jest.Mock
}

function makeState(): TransportState {
  return { rdpWs: null } as unknown as TransportState
}

const deps = {
  apiUrl: 'https://api.example.com',
  token: 'tok',
  agentId: 'agent-1',
  prefix: '[test]',
} as never

describe('startRdpWebSocket', () => {
  beforeEach(() => {
    mocked.RdpWebSocket.mockClear()
    mocked.__connect.mockClear()
    mocked.__connect.mockResolvedValue(undefined)
  })

  it('creates the relay with the agent credentials', () => {
    startRdpWebSocket(deps, makeState())
    expect(mocked.RdpWebSocket).toHaveBeenCalledWith(
      'https://api.example.com',
      'tok',
      'agent-1',
    )
  })

  it('prefers the WebSocket URL returned by the server', () => {
    startRdpWebSocket(deps, makeState(), 'wss://ws.example.com')
    expect(mocked.RdpWebSocket).toHaveBeenCalledWith(
      'wss://ws.example.com',
      'tok',
      'agent-1',
    )
  })

  it('★ records the relay on the transport state so shutdown can close it', () => {
    const state = makeState()
    startRdpWebSocket(deps, state)
    expect(state.rdpWs).not.toBeNull()
  })

  it('opens the connection', () => {
    startRdpWebSocket(deps, makeState())
    expect(mocked.__connect).toHaveBeenCalled()
  })

  it('★ a failed connection does not throw into the caller', () => {
    mocked.__connect.mockRejectedValue(new Error('refused'))
    expect(() => startRdpWebSocket(deps, makeState())).not.toThrow()
  })
})
