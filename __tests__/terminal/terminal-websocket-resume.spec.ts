/**
 * Tests for the resume-only open path of TerminalWebSocket
 * (reconnect-resilience design 1 + 2).
 *
 * Protocol contract (3 repos, field names fixed):
 *   API → Agent: open { resume?: boolean, meta?: { tenantCode, projectCode, userId } }
 *   Agent → API: { type: 'replay', sessionId, data }            // base64
 *                { type: 'resume_failed', sessionId, reason }   // not_found | meta_mismatch | dead
 *
 * Spec fixed by these tests:
 * - resume success ordering: ready → replay → (subsequent) stdout
 * - replay is OMITTED when the scrollback buffer is empty
 * - a failed resume NEVER spawns a new PTY
 * - re-registering the relay on resume does not double-send stdout
 */

import WebSocket from 'ws'

import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type { TerminalAgentMessage, TerminalServerMessage } from '../../src/terminal/terminal-websocket'

const META = { tenantCode: 'mbc', projectCode: 'MBC_01', userId: 'user-1' }

describe('TerminalWebSocket resume protocol', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket

  beforeEach((done) => {
    server = new WebSocket.Server({ port: 0 }, () => {
      const addr = server.address()
      serverPort = typeof addr === 'object' && addr !== null ? addr.port : 0
      ;(server as unknown as { _server: { unref(): void } })._server?.unref()
      done()
    })
  })

  afterEach((done) => {
    if (terminalWs) terminalWs.disconnect()
    server.close(() => done())
  })

  /**
   * Connect a TerminalWebSocket and return the server-side socket plus a
   * growing log of every agent → API message, with a predicate waiter.
   */
  async function connectWithMessageLog(): Promise<{
    serverWs: WebSocket
    messages: TerminalAgentMessage[]
    waitFor: (pred: (m: TerminalAgentMessage) => boolean) => Promise<TerminalAgentMessage>
  }> {
    const messages: TerminalAgentMessage[] = []
    const waiters: Array<{ pred: (m: TerminalAgentMessage) => boolean; resolve: (m: TerminalAgentMessage) => void }> = []

    const serverWsPromise = new Promise<WebSocket>((resolve) => {
      server.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as TerminalAgentMessage
          messages.push(msg)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(msg)) {
              const [waiter] = waiters.splice(i, 1)
              waiter.resolve(msg)
            }
          }
        })
        resolve(ws)
      })
    })

    terminalWs = new TerminalWebSocket(`http://localhost:${serverPort}`, 'test-token', 'agent-1', '/tmp')
    await terminalWs.connect()
    const serverWs = await serverWsPromise

    const waitFor = (pred: (m: TerminalAgentMessage) => boolean): Promise<TerminalAgentMessage> => {
      const existing = messages.find(pred)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve) => waiters.push({ pred, resolve }))
    }

    return { serverWs, messages, waitFor }
  }

  function sendToAgent(serverWs: WebSocket, msg: TerminalServerMessage): void {
    serverWs.send(JSON.stringify(msg))
  }

  it('replies resume_failed (not_found) for an unknown session and does NOT spawn', async () => {
    const { serverWs, waitFor } = await connectWithMessageLog()

    sendToAgent(serverWs, { type: 'open', sessionId: 'ghost-session', resume: true, meta: META })

    const failed = await waitFor((m) => m.type === 'resume_failed')
    expect(failed.sessionId).toBe('ghost-session')
    expect(failed.reason).toBe('not_found')
    // No fallback spawn happened.
    expect(terminalWs.getSessionManager().size).toBe(0)
  })

  it('replies resume_failed (meta_mismatch) and keeps the existing PTY untouched', async () => {
    const { serverWs, waitFor } = await connectWithMessageLog()

    sendToAgent(serverWs, { type: 'open', sessionId: 'mismatch-session', meta: META })
    await waitFor((m) => m.type === 'ready' && m.sessionId === 'mismatch-session')

    sendToAgent(serverWs, {
      type: 'open',
      sessionId: 'mismatch-session',
      resume: true,
      meta: { ...META, userId: 'intruder' },
    })

    const failed = await waitFor((m) => m.type === 'resume_failed')
    expect(failed.sessionId).toBe('mismatch-session')
    expect(failed.reason).toBe('meta_mismatch')
    // The original session was neither killed nor replaced.
    expect(terminalWs.getSessionManager().size).toBe(1)
    expect(terminalWs.getSessionManager().getSession('mismatch-session')?.isAlive()).toBe(true)
  })

  it('resumes with ready → replay → stdout ordering and no stdout duplication', async () => {
    const { serverWs, messages, waitFor } = await connectWithMessageLog()

    // 1) Open a session with meta and produce some output (mock PTY echoes stdin).
    sendToAgent(serverWs, { type: 'open', sessionId: 'replay-session', cols: 80, rows: 24, meta: META })
    await waitFor((m) => m.type === 'ready' && m.sessionId === 'replay-session')

    sendToAgent(serverWs, {
      type: 'stdin',
      sessionId: 'replay-session',
      data: Buffer.from('hello').toString('base64'),
    })
    await waitFor(
      (m) => m.type === 'stdout' && Buffer.from(m.data!, 'base64').toString('utf-8').includes('hello'),
    )

    // 2) Resume with the exact same meta.
    const beforeResume = messages.length
    sendToAgent(serverWs, {
      type: 'open',
      sessionId: 'replay-session',
      resume: true,
      cols: 100,
      rows: 30,
      meta: { ...META },
    })

    const replay = await waitFor((m) => m.type === 'replay')
    // Replay restores the buffered output (base64).
    expect(Buffer.from(replay.data!, 'base64').toString('utf-8')).toContain('hello')

    // Ordering: the post-resume ready comes strictly before replay.
    const post = messages.slice(beforeResume)
    const readyIdx = post.findIndex((m) => m.type === 'ready' && m.sessionId === 'replay-session')
    const replayIdx = post.findIndex((m) => m.type === 'replay')
    expect(readyIdx).toBeGreaterThanOrEqual(0)
    expect(replayIdx).toBeGreaterThan(readyIdx)
    // The resume applied the new size.
    const resumedReady = post[readyIdx]
    expect(resumedReady.cols).toBe(100)
    expect(resumedReady.rows).toBe(30)
    // No PTY was spawned for the resume: it is the same session object.
    expect(terminalWs.getSessionManager().size).toBe(1)

    // 3) New output after the resume arrives as stdout strictly AFTER replay,
    //    and exactly once (relay re-registration replaces, never stacks).
    sendToAgent(serverWs, {
      type: 'stdin',
      sessionId: 'replay-session',
      data: Buffer.from('world').toString('base64'),
    })
    await waitFor(
      (m) => m.type === 'stdout' && Buffer.from(m.data!, 'base64').toString('utf-8').includes('world'),
    )
    // Give any (buggy) duplicate relay a chance to fire before counting.
    await new Promise((r) => setTimeout(r, 100))

    const postResume = messages.slice(beforeResume)
    const worldFrames = postResume.filter(
      (m) => m.type === 'stdout' && Buffer.from(m.data!, 'base64').toString('utf-8').includes('world'),
    )
    expect(worldFrames).toHaveLength(1)
    const worldIdx = postResume.indexOf(worldFrames[0])
    expect(worldIdx).toBeGreaterThan(postResume.findIndex((m) => m.type === 'replay'))
  })

  it('omits replay when the scrollback buffer is empty (spec fixed here)', async () => {
    const { serverWs, messages, waitFor } = await connectWithMessageLog()

    // Open without producing any output (the mock PTY prints no prompt).
    sendToAgent(serverWs, { type: 'open', sessionId: 'empty-buffer-session', meta: META })
    await waitFor((m) => m.type === 'ready' && m.sessionId === 'empty-buffer-session')

    const beforeResume = messages.length
    sendToAgent(serverWs, { type: 'open', sessionId: 'empty-buffer-session', resume: true, meta: META })
    await waitFor((m) => m.type === 'ready' && messages.indexOf(m) >= beforeResume)

    // Allow a grace period for a (spec-violating) replay frame to arrive.
    await new Promise((r) => setTimeout(r, 100))
    const post = messages.slice(beforeResume)
    expect(post.some((m) => m.type === 'replay')).toBe(false)

    // The resumed session is still fully functional.
    sendToAgent(serverWs, {
      type: 'stdin',
      sessionId: 'empty-buffer-session',
      data: Buffer.from('ping').toString('base64'),
    })
    const out = await waitFor(
      (m) => m.type === 'stdout' && Buffer.from(m.data!, 'base64').toString('utf-8').includes('ping'),
    )
    expect(out.sessionId).toBe('empty-buffer-session')
  })

  it('keeps backward compatibility: open without resume/meta behaves as before', async () => {
    const { serverWs, messages, waitFor } = await connectWithMessageLog()

    // Plain legacy open (no resume, no meta) → session created, ready sent.
    sendToAgent(serverWs, { type: 'open', sessionId: 'legacy-session', cols: 80, rows: 24 })
    const ready = await waitFor((m) => m.type === 'ready' && m.sessionId === 'legacy-session')
    expect(ready.pid).toBeGreaterThan(0)
    expect(terminalWs.getSessionManager().size).toBe(1)
    expect(terminalWs.getSessionManager().getSession('legacy-session')?.getMeta()).toBeNull()

    // Legacy grace-resume: a second plain open with the same sessionId reuses
    // the live PTY (createSessionWithId path) — no resume_failed, no replay.
    const beforeReopen = messages.length
    sendToAgent(serverWs, { type: 'open', sessionId: 'legacy-session', cols: 80, rows: 24 })
    await waitFor((m) => m.type === 'ready' && messages.indexOf(m) >= beforeReopen)
    await new Promise((r) => setTimeout(r, 50))
    const post = messages.slice(beforeReopen)
    expect(post.some((m) => m.type === 'resume_failed')).toBe(false)
    expect(post.some((m) => m.type === 'replay')).toBe(false)
    expect(terminalWs.getSessionManager().size).toBe(1)
  })

  it('records meta on a non-resume open so a later resume can validate it', async () => {
    const { serverWs, waitFor } = await connectWithMessageLog()

    sendToAgent(serverWs, { type: 'open', sessionId: 'meta-recorded-session', meta: META })
    await waitFor((m) => m.type === 'ready' && m.sessionId === 'meta-recorded-session')

    expect(
      terminalWs.getSessionManager().getSession('meta-recorded-session')?.getMeta(),
    ).toEqual(META)
  })
})
