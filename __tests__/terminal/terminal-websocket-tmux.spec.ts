/**
 * Tests for tmux session management messages in TerminalWebSocket.
 *
 * Uses a real WebSocket server (same pattern as terminal-websocket.spec.ts).
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

describe('TerminalWebSocket — tmux session management', () => {
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

  describe('tmux_list_sessions', () => {
    it('sends tmux_sessions with parsed session list when tmux has sessions', (done) => {
      // Simulate tmux list-sessions output
      const tmuxOutput = [
        'ais-abc123\t2\t1\t1700000000\t1700000100',
        'ais-def456\t1\t0\t1700001000\t1700001200',
      ].join('\n')

      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
          callback(null, tmuxOutput, '')
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_sessions') {
            expect(msg.requestId).toBe('req-001')
            expect(msg.sessions).toBeDefined()
            expect(msg.sessions).toHaveLength(2)

            const first = msg.sessions![0]
            expect(first.name).toBe('ais-abc123')
            expect(first.windows).toBe(2)
            expect(first.attached).toBe(true)
            expect(first.created).toBe(1700000000)
            expect(first.activity).toBe(1700000100)

            const second = msg.sessions![1]
            expect(second.name).toBe('ais-def456')
            expect(second.windows).toBe(1)
            expect(second.attached).toBe(false)
            expect(second.created).toBe(1700001000)
            expect(second.activity).toBe(1700001200)

            done()
          }
        })

        const listMsg: TerminalServerMessage = {
          type: 'tmux_list_sessions',
          requestId: 'req-001',
        }
        ws.send(JSON.stringify(listMsg))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    it('sends tmux_sessions with empty array when tmux has no server running', (done) => {
      // Simulate tmux returning "no server running" error
      const noServerError = Object.assign(new Error('no server running'), { code: 1 })

      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error, stdout: string, stderr: string) => void) => {
          callback(noServerError, '', 'no server running on /tmp/tmux-1000/default')
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_sessions') {
            expect(msg.requestId).toBe('req-002')
            expect(msg.sessions).toBeDefined()
            expect(msg.sessions).toHaveLength(0)
            done()
          }
        })

        const listMsg: TerminalServerMessage = {
          type: 'tmux_list_sessions',
          requestId: 'req-002',
        }
        ws.send(JSON.stringify(listMsg))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    it('sends tmux_sessions with empty array when tmux binary is not found (ENOENT)', (done) => {
      const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error, stdout: string, stderr: string) => void) => {
          callback(enoentError, '', '')
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_sessions') {
            expect(msg.requestId).toBe('req-enoent')
            expect(msg.sessions).toHaveLength(0)
            done()
          }
        })

        ws.send(JSON.stringify({ type: 'tmux_list_sessions', requestId: 'req-enoent' }))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })
  })

  describe('tmux_kill_session', () => {
    it('sends tmux_session_killed with success=true when kill succeeds', (done) => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: null, stdout: string, stderr: string) => void) => {
          callback(null, '', '')
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_session_killed') {
            expect(msg.requestId).toBe('req-kill-001')
            expect(msg.name).toBe('ais-abc123')
            expect(msg.success).toBe(true)
            expect(msg.error).toBeUndefined()
            done()
          }
        })

        const killMsg: TerminalServerMessage = {
          type: 'tmux_kill_session',
          requestId: 'req-kill-001',
          name: 'ais-abc123',
        }
        ws.send(JSON.stringify(killMsg))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    it('sends tmux_session_killed with success=false when session not found', (done) => {
      const notFoundError = Object.assign(
        new Error("can't find session: ais-nonexistent"),
        { code: 1 },
      )

      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error, stdout: string, stderr: string) => void) => {
          callback(notFoundError, '', "can't find session: ais-nonexistent")
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_session_killed') {
            expect(msg.requestId).toBe('req-kill-002')
            expect(msg.name).toBe('ais-nonexistent')
            expect(msg.success).toBe(false)
            expect(msg.error).toBeTruthy()
            done()
          }
        })

        const killMsg: TerminalServerMessage = {
          type: 'tmux_kill_session',
          requestId: 'req-kill-002',
          name: 'ais-nonexistent',
        }
        ws.send(JSON.stringify(killMsg))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    it('sends tmux_session_killed with success=false and error="tmux not found" when ENOENT', (done) => {
      const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error, stdout: string, stderr: string) => void) => {
          callback(enoentError, '', '')
        },
      )

      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'tmux_session_killed') {
            expect(msg.requestId).toBe('req-kill-enoent')
            expect(msg.name).toBe('ais-abc123')
            expect(msg.success).toBe(false)
            expect(msg.error).toBe('tmux not found')
            done()
          }
        })

        ws.send(JSON.stringify({
          type: 'tmux_kill_session',
          requestId: 'req-kill-enoent',
          name: 'ais-abc123',
        }))
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })
  })
})
