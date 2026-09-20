import WebSocket from 'ws'

import { TerminalWebSocket } from '../../src/terminal/terminal-websocket'
import type {
  TerminalAgentMessage,
  TerminalServerMessage,
} from '../../src/terminal/terminal-websocket'
import type { SshCredentials } from '../../src/types'

/**
 * Opening a terminal against a host registered in the project's
 * remote-connection settings.
 *
 * The agent fetches the credential itself (the API never puts key material on
 * the relay) and refuses to open anything it cannot connect to safely:
 *
 * - a credential it cannot fetch → error frame, **no PTY**
 * - an unsupported route (tailscale) → error frame, **no PTY**
 * - no tenant context for the TOFU known_hosts → error frame, because the
 *   alternative is turning host key checking off for a remote host
 *
 * "No PTY" matters: falling back to the agent's own shell would leave the user
 * operating the container while believing they are on the remote host.
 */
describe('TerminalWebSocket（登録済みホストへの接続）', () => {
  let server: WebSocket.Server
  let serverPort: number
  let terminalWs: TerminalWebSocket
  let exitSpy: jest.SpyInstance

  const credential = (
    overrides: Partial<SshCredentials> = {},
  ): SshCredentials =>
    ({
      hostId: 'web-1',
      hostname: '127.0.0.1',
      port: 22,
      username: 'deploy',
      authType: 'privateKey',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      connectionType: 'ssh',
      ...overrides,
    }) as SshCredentials

  beforeEach((done) => {
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

  /**
   * Collects frames the agent sends and lets a test wait for one.
   *
   * Must be installed **before** `connect()`: a handler registered afterwards
   * misses the already-established connection and every frame with it.
   */
  const collectFrames = () => {
    const frames: TerminalAgentMessage[] = []
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        frames.push(JSON.parse(raw.toString()) as TerminalAgentMessage)
      })
    })
    const waitFor = async (
      predicate: (f: TerminalAgentMessage) => boolean,
      timeoutMs = 3000,
    ): Promise<TerminalAgentMessage> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find(predicate)
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`frame not received; got ${JSON.stringify(frames)}`)
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    return { frames, waitFor }
  }

  const openRemote = (
    ws: TerminalWebSocket,
    overrides: Record<string, unknown> = {},
  ) => {
    const msg: TerminalServerMessage = {
      type: 'open',
      sessionId: 'sess-remote-1',
      cols: 80,
      rows: 24,
      meta: { tenantCode: 'mbc', projectCode: 'MBC_01', userId: 'user-1' },
      remoteHost: { hostId: 'web-1', connectionType: 'ssh' },
      ...overrides,
    } as TerminalServerMessage
    ;(
      ws as unknown as { onParsedMessage: (m: TerminalServerMessage) => void }
    ).onParsedMessage(msg)
  }

  const createWs = (
    sshCredentialsProvider?: (hostId: string) => Promise<SshCredentials>,
  ) =>
    new TerminalWebSocket(
      `http://localhost:${serverPort}`,
      'test-token',
      'agent-1',
      '/tmp',
      undefined,
      undefined,
      sshCredentialsProvider,
    )

  it('資格情報を hostId で取得し、接続計画を渡してセッションを開く', async () => {
    // 実際に ssh を起動すると外部へ接続を試みてテストが宙吊りになるため、
    // PTY の生成だけを差し替えて「何を渡したか」を観測する。
    const provider = jest.fn().mockResolvedValue(credential())
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    const created: Record<string, unknown>[] = []
    jest
      .spyOn(terminalWs.getSessionManager(), 'createSessionWithId')
      .mockImplementation((_id: string, options: Record<string, unknown>) => {
        created.push(options)
        return {
          pid: 4242,
          cols: 80,
          rows: 24,
          onData: jest.fn(),
          onExit: jest.fn(),
        } as never
      })

    openRemote(terminalWs)

    await waitFor((f) => f.type === 'ready')
    expect(provider).toHaveBeenCalledWith('web-1')
    const plan = created[0]?.remoteShell as { script: string; files: unknown[] }
    expect(plan.script).toContain('exec ssh')
    // 秘匿値はファイル経由（スクリプト本文には出ない）。
    expect(plan.script).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(plan.files).toHaveLength(1)
  })

  it('資格情報の取得に失敗したら error を返し PTY を作らない', async () => {
    const provider = jest.fn().mockRejectedValue(new Error('403'))
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    openRemote(terminalWs)

    const frame = await waitFor((f) => f.type === 'error')
    expect(frame.sessionId).toBe('sess-remote-1')
    expect(terminalWs.getSessionManager().getSession('sess-remote-1')).toBeUndefined()
  })

  it('未対応の経路（tailscale）は error を返し PTY を作らない', async () => {
    const provider = jest
      .fn()
      .mockResolvedValue(credential({ connectionType: 'tailscale' } as Partial<SshCredentials>))
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    openRemote(terminalWs, {
      remoteHost: { hostId: 'web-1', connectionType: 'ssh' },
    })

    await waitFor((f) => f.type === 'error')
    expect(terminalWs.getSessionManager().getSession('sess-remote-1')).toBeUndefined()
  })

  it('テナントが分からない要求は拒否する（ホスト鍵検証を切らない）', async () => {
    // meta が無いと TOFU の known_hosts を引けない。ローカルシェルは警告付きで
    // 続行するが、リモートホストへの接続でホスト鍵検証を切ると MITM を検出できない。
    const provider = jest.fn().mockResolvedValue(credential())
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    openRemote(terminalWs, { meta: undefined })

    await waitFor((f) => f.type === 'error')
    expect(provider).not.toHaveBeenCalled()
    expect(terminalWs.getSessionManager().getSession('sess-remote-1')).toBeUndefined()
  })

  it('資格情報の取得手段が無ければ拒否する（自身のシェルへ落とさない）', async () => {
    terminalWs = createWs(undefined)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    openRemote(terminalWs)

    await waitFor((f) => f.type === 'error')
    expect(terminalWs.getSessionManager().getSession('sess-remote-1')).toBeUndefined()
  })

  it('remoteHost の無い open は従来どおりエージェント自身のシェルを開く', async () => {
    const provider = jest.fn().mockResolvedValue(credential())
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    const created: Record<string, unknown>[] = []
    jest
      .spyOn(terminalWs.getSessionManager(), 'createSessionWithId')
      .mockImplementation((_id: string, options: Record<string, unknown>) => {
        created.push(options)
        return {
          pid: 4242,
          cols: 80,
          rows: 24,
          onData: jest.fn(),
          onExit: jest.fn(),
        } as never
      })

    openRemote(terminalWs, { remoteHost: undefined })

    await waitFor((f) => f.type === 'ready')
    expect(provider).not.toHaveBeenCalled()
    expect(created[0]?.remoteShell).toBeUndefined()
  })

  it('エラー本文に秘匿値を載せない', async () => {
    const provider = jest
      .fn()
      .mockRejectedValue(new Error('failed for key -----BEGIN OPENSSH PRIVATE KEY-----'))
    terminalWs = createWs(provider)
    const { waitFor } = collectFrames()
    await terminalWs.connect()

    openRemote(terminalWs)

    const frame = await waitFor((f) => f.type === 'error')
    expect(JSON.stringify(frame)).not.toContain('BEGIN OPENSSH PRIVATE KEY')
  })
})
