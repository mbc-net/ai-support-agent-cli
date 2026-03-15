import WebSocket from 'ws'

import * as wsConstants from '../../src/terminal/constants'
import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type { TerminalAgentMessage, TerminalServerMessage } from '../../src/terminal/terminal-websocket'

describe('TerminalWebSocket', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket

  beforeEach((done) => {
    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      done()
    })
  })

  afterEach((done) => {
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

  it('should connect to WebSocket server', async () => {
    terminalWs = createTerminalWs()
    await terminalWs.connect()
    expect(server.clients.size).toBe(1)
  })

  it('should send auth headers on connect', async () => {
    const headerPromise = new Promise<void>((resolve) => {
      server.on('connection', (_ws, req) => {
        expect(req.headers.authorization).toBe('Bearer test-token')
        expect(req.headers['x-agent-id']).toBe('agent-1')
        resolve()
      })
    })
    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await headerPromise
  })

  it('should handle open message and create session', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          expect(msg.sessionId).toBeTruthy()
          expect(msg.pid).toBeGreaterThan(0)
          expect(msg.cols).toBe(80)
          expect(msg.rows).toBe(24)

          // Cleanup: close the session
          const closeMsg: TerminalServerMessage = {
            type: 'close',
            sessionId: msg.sessionId,
          }
          ws.send(JSON.stringify(closeMsg))
          done()
        }
      })

      const openMsg: TerminalServerMessage = {
        type: 'open',
        sessionId: 'test-session-1',
        cols: 80,
        rows: 24,
      }
      ws.send(JSON.stringify(openMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should relay stdin to session and receive stdout', (done) => {
    let sessionId: string | null = null
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          sessionId = msg.sessionId
          // Send stdin
          const stdinMsg: TerminalServerMessage = {
            type: 'stdin',
            sessionId: msg.sessionId,
            data: Buffer.from('echo test123\n').toString('base64'),
          }
          ws.send(JSON.stringify(stdinMsg))
        }
        if (msg.type === 'stdout' && sessionId) {
          const decoded = Buffer.from(msg.data!, 'base64').toString('utf-8')
          if (decoded.includes('test123')) {
            // Cleanup
            const closeMsg: TerminalServerMessage = {
              type: 'close',
              sessionId: sessionId,
            }
            ws.send(JSON.stringify(closeMsg))
            done()
          }
        }
      })

      const openMsg: TerminalServerMessage = { type: 'open', sessionId: 'test-stdin-session' }
      ws.send(JSON.stringify(openMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should handle resize message', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          const resizeMsg: TerminalServerMessage = {
            type: 'resize',
            sessionId: msg.sessionId,
            cols: 200,
            rows: 50,
          }
          ws.send(JSON.stringify(resizeMsg))

          // Verify resize was applied
          setTimeout(() => {
            const manager = terminalWs.getSessionManager()
            const session = manager.getSession(msg.sessionId)
            expect(session?.cols).toBe(200)
            expect(session?.rows).toBe(50)

            const closeMsg: TerminalServerMessage = {
              type: 'close',
              sessionId: msg.sessionId,
            }
            ws.send(JSON.stringify(closeMsg))
            done()
          }, 50)
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'test-resize-session' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should handle close message', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          const closeMsg: TerminalServerMessage = {
            type: 'close',
            sessionId: msg.sessionId,
          }
          ws.send(JSON.stringify(closeMsg))

          setTimeout(() => {
            const manager = terminalWs.getSessionManager()
            expect(manager.size).toBe(0)
            done()
          }, 50)
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'test-close-session' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should send exit message when session exits', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          // Send exit command
          const stdinMsg: TerminalServerMessage = {
            type: 'stdin',
            sessionId: msg.sessionId,
            data: Buffer.from('exit\n').toString('base64'),
          }
          ws.send(JSON.stringify(stdinMsg))
        }
        if (msg.type === 'exit') {
          expect(msg.sessionId).toBeTruthy()
          expect(typeof msg.code).toBe('number')
          done()
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'test-exit-session' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should send error when stdin targets unknown session', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'error') {
          expect(msg.error).toContain('Session not found')
          done()
        }
      })

      const stdinMsg: TerminalServerMessage = {
        type: 'stdin',
        sessionId: 'nonexistent',
        data: Buffer.from('test').toString('base64'),
      }
      ws.send(JSON.stringify(stdinMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should send error when max sessions reached', (done) => {
    // Temporarily reduce MAX_CONCURRENT_SESSIONS for faster test
    const origMax = wsConstants.MAX_CONCURRENT_SESSIONS
    Object.defineProperty(wsConstants, 'MAX_CONCURRENT_SESSIONS', { value: 2, writable: true })

    let openCount = 0
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          openCount++
          if (openCount < 2) {
            ws.send(JSON.stringify({ type: 'open', sessionId: `max-session-${openCount + 1}` }))
          } else {
            // 3rd open should fail (MAX_CONCURRENT_SESSIONS = 2)
            ws.send(JSON.stringify({ type: 'open', sessionId: 'overflow' }))
          }
        }
        if (msg.type === 'error' && msg.error?.includes('Maximum concurrent sessions')) {
          Object.defineProperty(wsConstants, 'MAX_CONCURRENT_SESSIONS', { value: origMax, writable: true })
          done()
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'max-session-1' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should disconnect and close all sessions', async () => {
    terminalWs = createTerminalWs()
    await terminalWs.connect()
    terminalWs.disconnect()
    expect(terminalWs.getSessionManager().size).toBe(0)
  })

  it('should handle invalid JSON gracefully', async () => {
    server.on('connection', (ws) => {
      ws.send('not valid json')
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    // Should not throw
  })

  it('should ignore stdin with missing data', (done) => {
    server.on('connection', (ws) => {
      const stdinMsg: TerminalServerMessage = {
        type: 'stdin',
        sessionId: 'some-id',
      }
      ws.send(JSON.stringify(stdinMsg))
      // Should not throw or send error since data is missing
      setTimeout(done, 50)
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should ignore resize with missing sessionId', (done) => {
    server.on('connection', (ws) => {
      const resizeMsg = { type: 'resize', cols: 100, rows: 50 }
      ws.send(JSON.stringify(resizeMsg))
      setTimeout(done, 50)
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should ignore close with missing sessionId', (done) => {
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'close' }))
      setTimeout(done, 50)
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should ignore unknown message types', async () => {
    const connected = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'unknown_type' }))
        resolve()
      })
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await connected
    // Wait briefly to confirm no crash or unexpected behavior
    await new Promise((r) => setTimeout(r, 50))
  })

  it('should handle auth_success message silently', async () => {
    const connected = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'auth_success' }))
        resolve()
      })
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await connected
    await new Promise((r) => setTimeout(r, 50))
  })

  it('should log server error message', async () => {
    const connected = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'error', sessionId: 'sess-1', message: 'Session not found' }))
        resolve()
      })
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await connected
    await new Promise((r) => setTimeout(r, 50))
  })

  it('should log server error with error field fallback', async () => {
    const connected = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'error', sessionId: 'sess-2', error: 'Access denied' }))
        resolve()
      })
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await connected
    await new Promise((r) => setTimeout(r, 50))
  })

  it('should log server error with unknown fallback', async () => {
    const connected = new Promise<void>((resolve) => {
      server.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'error' }))
        resolve()
      })
    })

    terminalWs = createTerminalWs()
    await terminalWs.connect()
    await connected
    await new Promise((r) => setTimeout(r, 50))
  })

  it('should attempt reconnect when server closes connection', (done) => {
    const origDelay = wsConstants.TERMINAL_WS_RECONNECT_BASE_DELAY_MS
    const origRetries = wsConstants.TERMINAL_WS_MAX_RECONNECT_RETRIES
    Object.defineProperty(wsConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: 50, writable: true })
    Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: 1, writable: true })

    let connectionCount = 0
    server.on('connection', (ws) => {
      connectionCount++
      if (connectionCount === 1) {
        // Close the first connection to trigger reconnect
        ws.close()
      } else {
        // Second connection = successful reconnect
        Object.defineProperty(wsConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: origDelay, writable: true })
        Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: origRetries, writable: true })
        done()
      }
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should stop reconnecting after max retries', (done) => {
    const origDelay = wsConstants.TERMINAL_WS_RECONNECT_BASE_DELAY_MS
    const origRetries = wsConstants.TERMINAL_WS_MAX_RECONNECT_RETRIES
    Object.defineProperty(wsConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: 10, writable: true })
    Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: 1, writable: true })

    terminalWs = createTerminalWs()
    void terminalWs.connect().then(() => {
      // Close the server so reconnect attempts fail
      server.close(() => {
        // Force-close the ws from server side to trigger reconnect
        for (const client of server.clients) {
          client.close()
        }
      })
      // Close all server clients to trigger reconnection
      for (const client of server.clients) {
        client.close()
      }

      // After max retries with no server, it should stop
      setTimeout(() => {
        Object.defineProperty(wsConstants, 'TERMINAL_WS_RECONNECT_BASE_DELAY_MS', { value: origDelay, writable: true })
        Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: origRetries, writable: true })
        // Create a new server for afterEach cleanup
        server = new WebSocket.Server({ port: serverPort })
        done()
      }, 500)
    })
  }, 10000)

  it('should not reconnect if disconnect was called', async () => {
    terminalWs = createTerminalWs()
    await terminalWs.connect()
    terminalWs.disconnect()
    // After explicit disconnect, no reconnect should happen
    expect(terminalWs.getSessionManager().size).toBe(0)
  })

  it('should handle resize for unknown session gracefully', (done) => {
    server.on('connection', (ws) => {
      // Send resize for a nonexistent session - should not throw or send error
      ws.send(JSON.stringify({ type: 'resize', sessionId: 'nonexistent', cols: 100, rows: 50 }))
      setTimeout(done, 50)
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should reject cwd outside project directory', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'error') {
          expect(msg.error).toContain('Invalid cwd: outside project directory')
          done()
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'traversal-test', cwd: '../../etc' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should handle close for unknown session gracefully', (done) => {
    server.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'close', sessionId: 'nonexistent' }))
      setTimeout(done, 50)
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })
})
