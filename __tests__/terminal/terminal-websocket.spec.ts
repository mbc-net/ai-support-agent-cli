import WebSocket from 'ws'

import { WS_CLOSE_CODE_AUTH_REJECTED } from '../../src/constants'
import * as wsConstants from '../../src/terminal/constants'
import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type { TerminalAgentMessage, TerminalServerMessage } from '../../src/terminal/terminal-websocket'

describe('TerminalWebSocket', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket
  let exitSpy: jest.SpyInstance

  beforeEach((done) => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      // Unref the underlying HTTP server so it doesn't keep Jest alive after tests
      ;(server as unknown as { _server: { unref(): void } })._server?.unref()
      done()
    })
  })

  afterEach((done) => {
    exitSpy.mockRestore()
    if (terminalWs) terminalWs.disconnect()
    server.close(() => done())
  })

  function createTerminalWs(onAuthRejected?: () => void): TerminalWebSocket {
    return new TerminalWebSocket(
      `http://localhost:${serverPort}`,
      'test-token',
      'agent-1',
      '/tmp',
      undefined,
      onAuthRejected,
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

  it('上限なし: 多数セッションを連続 open しても Maximum concurrent sessions エラーは発生しない', (done) => {
    let openCount = 0
    const TARGET = 5
    const errorMessages: string[] = []

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          openCount++
          if (openCount < TARGET) {
            ws.send(JSON.stringify({ type: 'open', sessionId: `max-session-${openCount + 1}` }))
          } else {
            // All sessions opened — verify no limit errors
            setTimeout(() => {
              expect(errorMessages.some((e) => e.includes('Maximum concurrent sessions'))).toBe(false)
              done()
            }, 100)
          }
        }
        if (msg.type === 'error') {
          errorMessages.push(msg.error ?? '')
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

  it('should handle invalid base64 data in stdin gracefully', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          // Send invalid base64 data — should not crash
          const invalidBase64Msg: TerminalServerMessage = {
            type: 'stdin',
            sessionId: msg.sessionId,
            data: '!!!invalid-base64!!!',
          }
          ws.send(JSON.stringify(invalidBase64Msg))

          // After a brief delay, verify the session is still alive
          setTimeout(() => {
            const manager = terminalWs.getSessionManager()
            const session = manager.getSession(msg.sessionId)
            expect(session).toBeDefined()

            const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
            ws.send(JSON.stringify(closeMsg))
            done()
          }, 50)
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'invalid-b64-session' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should clamp cols/rows to valid range on resize', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          // Send oversized resize values
          const resizeMsg: TerminalServerMessage = {
            type: 'resize',
            sessionId: msg.sessionId,
            cols: 999999,
            rows: -5,
          }
          ws.send(JSON.stringify(resizeMsg))

          setTimeout(() => {
            const manager = terminalWs.getSessionManager()
            const session = manager.getSession(msg.sessionId)
            // cols should be clamped to MAX (1000), rows clamped to MIN (1)
            expect(session?.cols).toBe(1000)
            expect(session?.rows).toBe(1)

            const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
            ws.send(JSON.stringify(closeMsg))
            done()
          }, 50)
        }
      })

      ws.send(JSON.stringify({ type: 'open', sessionId: 'clamp-resize-session' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should handle server-sent envVarsOverride in open message', (done) => {
    const pemKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key\n-----END OPENSSH PRIVATE KEY-----'
    const base64Key = Buffer.from(pemKey).toString('base64')

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          // セッションが envVarsOverride を含む open メッセージで正常に作成された
          expect(msg.sessionId).toBe('ssh-env-session')

          const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
          ws.send(JSON.stringify(closeMsg))
          done()
        }
      })

      // サーバーから GIT_SSH_KEY_CONTENT_BASE64 を含む open メッセージを送信
      const openMsg: TerminalServerMessage = {
        type: 'open',
        sessionId: 'ssh-env-session',
        cols: 80,
        rows: 24,
        envVarsOverride: {
          GIT_SSH_KEY_CONTENT_BASE64: base64Key,
        },
      }
      ws.send(JSON.stringify(openMsg))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should send error when open message has no sessionId', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'error') {
          expect(msg.sessionId).toBe('unknown')
          expect(msg.error).toContain('Missing sessionId in open message')
          done()
        }
      })

      // Send open message without sessionId
      ws.send(JSON.stringify({ type: 'open' }))
    })

    terminalWs = createTerminalWs()
    void terminalWs.connect()
  })

  it('should use resolved cwd when cwd is a valid subdirectory', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          // Session opened successfully with valid cwd inside projectDir
          expect(msg.sessionId).toBe('valid-cwd-session')

          const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
          ws.send(JSON.stringify(closeMsg))
          done()
        }
        if (msg.type === 'error') {
          // Should not get an error for valid cwd
          done(new Error(`Unexpected error: ${msg.error}`))
        }
      })

      // Send open message with a valid subdirectory cwd
      const openMsg: TerminalServerMessage = {
        type: 'open',
        sessionId: 'valid-cwd-session',
        cols: 80,
        rows: 24,
        cwd: 'subdir', // relative to /tmp — resolves to /tmp/subdir which starts with /tmp/
      }
      ws.send(JSON.stringify(openMsg))
    })

    terminalWs = createTerminalWs() // uses projectDir: '/tmp'
    void terminalWs.connect()
  })

  it('should use msg.cwd directly when no projectDir is set', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          expect(msg.sessionId).toBe('no-project-dir-session')
          const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
          ws.send(JSON.stringify(closeMsg))
          done()
        }
        if (msg.type === 'error') {
          done(new Error(`Unexpected error: ${msg.error}`))
        }
      })

      const openMsg: TerminalServerMessage = {
        type: 'open',
        sessionId: 'no-project-dir-session',
        cols: 80,
        rows: 24,
        cwd: '/tmp', // absolute cwd, no projectDir set
      }
      ws.send(JSON.stringify(openMsg))
    })

    // Create TerminalWebSocket without projectDir
    terminalWs = new TerminalWebSocket(
      `http://localhost:${serverPort}`,
      'test-token',
      'agent-1',
    )
    void terminalWs.connect()
  })

  // ─── grace / resume on a real transient 'close' event ────────────────────
  // A transient WS drop (ALB idle drop / heartbeat false-positive terminate /
  // network blip) fires the ws 'close' event, which routes through the base
  // class onWebSocketClose() hook — NOT the explicit disconnect()/onDisconnect()
  // path. The terminal connection must keep its PTYs alive (grace) so they can
  // be resumed on reconnect. This test drives the REAL 'close' event (by closing
  // the server-side socket) to verify the wiring, not a hand-called hook.
  it('should keep PTYs alive on a real transient close event (grace preserved)', async () => {
    // Disable reconnect so the transient close does not immediately spawn a new
    // connection during the assertion window.
    const origRetries = wsConstants.TERMINAL_WS_MAX_RECONNECT_RETRIES
    Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: 0, writable: true })

    let serverWs: WebSocket | null = null
    const sessionId = await new Promise<string>((resolve) => {
      server.on('connection', (ws) => {
        serverWs = ws
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'ready') {
            resolve(msg.sessionId)
          }
        })
        ws.send(
          JSON.stringify({ type: 'open', sessionId: 'grace-close-session', cols: 80, rows: 24 }),
        )
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    const manager = terminalWs.getSessionManager()
    expect(manager.getSession(sessionId)?.isAlive()).toBe(true)

    // Spy so we can prove the real 'close' event actually routes to grace, not
    // just that the PTY happens to still be alive (a no-op hook would also leave
    // it alive). RED before the fix: closeAllGracefully is never called because
    // grace was wired to onDisconnect()/disconnect(), not onWebSocketClose().
    const graceSpy = jest.spyOn(manager, 'closeAllGracefully')
    const killAllSpy = jest.spyOn(manager, 'closeAll')

    // Fire a real transient close by closing the server-side socket. The client
    // observes 'close' -> onWebSocketClose() -> manager.closeAllGracefully().
    const closed = new Promise<void>((resolve) => {
      ;(serverWs as unknown as WebSocket).on('close', () => resolve())
    })
    ;(serverWs as unknown as WebSocket).close()
    await closed
    // Give the client a tick to process its own 'close' event.
    await new Promise((r) => setTimeout(r, 50))

    // The transient close must arm grace and must NOT kill PTYs.
    expect(graceSpy).toHaveBeenCalledTimes(1)
    expect(killAllSpy).not.toHaveBeenCalled()
    // The PTY must still be alive within the grace window.
    expect(manager.size).toBe(1)
    expect(manager.getSession(sessionId)?.isAlive()).toBe(true)

    graceSpy.mockRestore()
    killAllSpy.mockRestore()
    Object.defineProperty(wsConstants, 'TERMINAL_WS_MAX_RECONNECT_RETRIES', { value: origRetries, writable: true })
  })

  // A permanent auth rejection (server closes with WS_CLOSE_CODE_AUTH_REJECTED,
  // e.g. Agent ID token-binding mismatch) must NOT arm grace — there is nothing
  // to resume, since reconnecting would send the same rejected credentials again.
  // Regression test for the silent-failure-hunter finding: this used to route
  // through onWebSocketClose() -> closeAllGracefully() just like a transient drop,
  // leaving PTYs alive (and reconnect looping forever) for up to the grace window.
  it('should kill all PTYs immediately (no grace) on a real auth-rejected close event, notify via onAuthRejected, and must not reconnect', async () => {
    const onAuthRejected = jest.fn()
    let serverWs: WebSocket | null = null
    const sessionId = await new Promise<string>((resolve) => {
      server.on('connection', (ws) => {
        serverWs = ws
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'ready') {
            resolve(msg.sessionId)
          }
        })
        ws.send(
          JSON.stringify({ type: 'open', sessionId: 'auth-rejected-session', cols: 80, rows: 24 }),
        )
      })

      terminalWs = createTerminalWs(onAuthRejected)
      void terminalWs.connect()
    })

    const manager = terminalWs.getSessionManager()
    expect(manager.getSession(sessionId)?.isAlive()).toBe(true)

    const graceSpy = jest.spyOn(manager, 'closeAllGracefully')
    const killAllSpy = jest.spyOn(manager, 'closeAll')

    const closed = new Promise<void>((resolve) => {
      ;(serverWs as unknown as WebSocket).on('close', () => resolve())
    })
    ;(serverWs as unknown as WebSocket).close(WS_CLOSE_CODE_AUTH_REJECTED, 'agent_id_mismatch')
    await closed
    await new Promise((r) => setTimeout(r, 50))

    expect(killAllSpy).toHaveBeenCalledTimes(1)
    expect(graceSpy).not.toHaveBeenCalled()
    expect(manager.size).toBe(0)
    // The permanent rejection must be reported so the worker can notify the parent.
    expect(onAuthRejected).toHaveBeenCalledTimes(1)

    graceSpy.mockRestore()
    killAllSpy.mockRestore()
  })

  // Explicit, user/agent-initiated shutdown must kill every PTY immediately
  // (no grace) — this is a genuine teardown, distinct from a transient close.
  it('should kill all PTYs immediately on explicit disconnect (no grace)', async () => {
    const sessionId = await new Promise<string>((resolve) => {
      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          if (msg.type === 'ready') {
            resolve(msg.sessionId)
          }
        })
        ws.send(
          JSON.stringify({ type: 'open', sessionId: 'explicit-disconnect-session', cols: 80, rows: 24 }),
        )
      })

      terminalWs = createTerminalWs()
      void terminalWs.connect()
    })

    const manager = terminalWs.getSessionManager()
    expect(manager.getSession(sessionId)?.isAlive()).toBe(true)

    // Explicit disconnect: genuine teardown.
    terminalWs.disconnect()

    expect(manager.size).toBe(0)
    expect(manager.getSession(sessionId)).toBeUndefined()
  })

  it('should warn when envVarsProvider exists but returns undefined', (done) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as TerminalAgentMessage
        if (msg.type === 'ready') {
          expect(msg.sessionId).toBe('provider-undefined-session')
          const closeMsg: TerminalServerMessage = { type: 'close', sessionId: msg.sessionId }
          ws.send(JSON.stringify(closeMsg))
          done()
        }
        if (msg.type === 'error') {
          done(new Error(`Unexpected error: ${msg.error}`))
        }
      })

      ws.send(JSON.stringify({
        type: 'open',
        sessionId: 'provider-undefined-session',
        cols: 80,
        rows: 24,
      }))
    })

    // Create TerminalWebSocket with envVarsProvider that returns undefined
    terminalWs = new TerminalWebSocket(
      `http://localhost:${serverPort}`,
      'test-token',
      'agent-1',
      '/tmp',
      () => undefined as unknown as Record<string, string>,
    )
    void terminalWs.connect()
  })
})
