/**
 * Tests for tmux pane split (split_pane) messages in TerminalWebSocket.
 *
 * Uses a real WebSocket server (same pattern as terminal-websocket-tmux.spec.ts).
 * child_process is mocked at module level to avoid actually running tmux.
 */
import WebSocket from 'ws'

// Mock child_process at module level (execFile property is non-configurable in Node.js)
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}))

import * as childProcess from 'child_process'
import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type { TerminalAgentMessage, TerminalServerMessage } from '../../src/terminal/terminal-websocket'

const execFileMock = childProcess.execFile as jest.Mock

describe('TerminalWebSocket — split_pane', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket
  let exitSpy: jest.SpyInstance

  beforeEach((done) => {
    jest.clearAllMocks()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      ;(server as unknown as { _server: { unref(): void } })._server?.unref()
      done()
    })
  })

  afterEach((done) => {
    exitSpy.mockRestore()
    if (terminalWs) terminalWs.disconnect()
    server.close(() => done())
  })

  function createTerminalWs(): TerminalWebSocket {
    return new TerminalWebSocket(
      `http://localhost:${serverPort}`,
      'test-token',
      'agent-1',
      '/tmp',
    )
  }

  it('calls tmux split-window -h for horizontal split (default)', (done) => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.requestId).toBe('req-split-001')
          expect(msg.sessionName).toBe('ais-abc123')
          expect(msg.success).toBe(true)
          expect(msg.error).toBeUndefined()

          // Verify the tmux command args
          const splitCalls = execFileMock.mock.calls.filter(
            (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('split-window'),
          )
          expect(splitCalls).toHaveLength(1)
          const args = splitCalls[0][1] as string[]
          expect(args).toContain('-h')
          expect(args).toContain('-t')
          expect(args).toContain('ais-abc123')

          done()
        }
      })

      const splitMsg: TerminalServerMessage = {
        type: 'split_pane',
        requestId: 'req-split-001',
        sessionName: 'ais-abc123',
        direction: 'horizontal',
      }
      ws.send(JSON.stringify(splitMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('calls tmux split-window -h when direction is omitted (default is horizontal)', (done) => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(true)

          const splitCalls = execFileMock.mock.calls.filter(
            (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('split-window'),
          )
          const args = splitCalls[0][1] as string[]
          expect(args).toContain('-h')
          expect(args).not.toContain('-v')

          done()
        }
      })

      const splitMsg: TerminalServerMessage = {
        type: 'split_pane',
        requestId: 'req-split-default',
        sessionName: 'ais-abc123',
      }
      ws.send(JSON.stringify(splitMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('calls tmux split-window -v for vertical split', (done) => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.requestId).toBe('req-split-vertical')
          expect(msg.sessionName).toBe('ais-abc123')
          expect(msg.success).toBe(true)

          const splitCalls = execFileMock.mock.calls.filter(
            (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('split-window'),
          )
          expect(splitCalls).toHaveLength(1)
          const args = splitCalls[0][1] as string[]
          expect(args).toContain('-v')
          expect(args).not.toContain('-h')
          expect(args).toContain('-t')
          expect(args).toContain('ais-abc123')

          done()
        }
      })

      const splitMsg: TerminalServerMessage = {
        type: 'split_pane',
        requestId: 'req-split-vertical',
        sessionName: 'ais-abc123',
        direction: 'vertical',
      }
      ws.send(JSON.stringify(splitMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('rejects invalid sessionName containing semicolon with success=false', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.requestId).toBe('req-invalid-semi')
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('Invalid session name')
          // execFile must NOT have been called
          expect(execFileMock).not.toHaveBeenCalled()
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-invalid-semi',
        sessionName: 'ais-abc123; rm -rf /',
        direction: 'horizontal',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('rejects invalid sessionName containing backtick with success=false', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('Invalid session name')
          expect(execFileMock).not.toHaveBeenCalled()
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-invalid-backtick',
        sessionName: 'ais-`id`',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('rejects invalid sessionName containing dollar sign with success=false', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('Invalid session name')
          expect(execFileMock).not.toHaveBeenCalled()
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-invalid-dollar',
        sessionName: 'ais-$HOME',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('rejects empty sessionName with success=false', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('Invalid session name')
          expect(execFileMock).not.toHaveBeenCalled()
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-invalid-empty',
        sessionName: '',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('rejects missing sessionName with success=false', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('Invalid session name')
          expect(execFileMock).not.toHaveBeenCalled()
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-invalid-missing',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('returns success=false and error="tmux not found" when tmux binary is missing (ENOENT)', (done) => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: Error) => void) => {
        callback(enoentError)
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.requestId).toBe('req-split-enoent')
          expect(msg.sessionName).toBe('ais-abc123')
          expect(msg.success).toBe(false)
          expect(msg.error).toBe('tmux not found')
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-split-enoent',
        sessionName: 'ais-abc123',
        direction: 'horizontal',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('returns success=false with error message when tmux split-window fails', (done) => {
    const splitError = Object.assign(
      new Error("can't find session: ais-gone"),
      { code: 1 },
    )

    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: Error) => void) => {
        callback(splitError)
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.requestId).toBe('req-split-fail')
          expect(msg.sessionName).toBe('ais-gone')
          expect(msg.success).toBe(false)
          expect(msg.error).toBe("can't find session: ais-gone")
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-split-fail',
        sessionName: 'ais-gone',
        direction: 'horizontal',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('accepts valid session names with allowed special characters (hyphen, underscore, colon, period)', (done) => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
        callback(null, '', '')
      },
    )

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'tmux_pane_split') {
          expect(msg.success).toBe(true)
          expect(msg.sessionName).toBe('ais-abc123def456-sess_1.2:3')
          done()
        }
      })

      ws.send(JSON.stringify({
        type: 'split_pane',
        requestId: 'req-split-valid-chars',
        sessionName: 'ais-abc123def456-sess_1.2:3',
        direction: 'horizontal',
      } as TerminalServerMessage))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })
})
