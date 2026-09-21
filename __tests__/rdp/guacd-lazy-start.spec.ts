import { RdpWebSocket, type RdpServerMessage } from '../../src/rdp/rdp-websocket'
import { createGuacdEndpointResolverForCapability } from '../../src/rdp/guacd-runtime'
import type { AgentCapabilityDeclaration } from '../../src/types'

/**
 * Starting guacd on demand instead of at process start.
 *
 * The point of the whole capability feature is that turning RDP on from the
 * admin UI works **without restarting the agent** on a host install. That is
 * only true if the guacd endpoint is resolved when the first session is asked
 * for, not baked into the relay's constructor.
 *
 * Two failure modes are pinned here because neither is visible from the outside:
 *
 * - starting guacd for an agent nobody asked RDP of (an unauthenticated relay
 *   listening for no reason), and
 * - **not stopping** one that was started lazily — the shutdown hook used to be
 *   registered only under the `--rdp` flag, which the lazy path does not pass
 *   through.
 *
 * Only `ensureGuacdContainer` is stubbed. The session registry is the real one,
 * so a gate that exists only in a mock cannot make this file green.
 */

jest.mock('../../src/logger')

const stopHook = jest.fn()
jest.mock('../../src/rdp/guacd-container', () => ({
  ...jest.requireActual('../../src/rdp/guacd-container'),
  ensureGuacdContainer: jest.fn(),
  // The real hook would shell out to `docker stop`; what matters here is that
  // *the* hook is the thing handed to the shutdown registration.
  createGuacdShutdownHook: jest.fn(() => stopHook),
}))

jest.mock('../../src/rdp/guacd-tcp-socket', () => ({
  ...jest.requireActual('../../src/rdp/guacd-tcp-socket'),
  connectToGuacd: jest.fn(),
}))

const { ensureGuacdContainer } = jest.requireMock(
  '../../src/rdp/guacd-container',
) as { ensureGuacdContainer: jest.Mock }
const { connectToGuacd } = jest.requireMock(
  '../../src/rdp/guacd-tcp-socket',
) as { connectToGuacd: jest.Mock }

interface Harness {
  ws: RdpWebSocket
  sent: unknown[]
  registerShutdownHook: jest.Mock
  env: NodeJS.ProcessEnv
  open: (sessionId: string) => void
}

function makeHarness(options: {
  declaration?: AgentCapabilityDeclaration
  env?: NodeJS.ProcessEnv
}): Harness {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? {}) }
  const registerShutdownHook = jest.fn()
  const resolve = createGuacdEndpointResolverForCapability({
    getDeclaration: () => options.declaration,
    env,
    registerShutdownHook,
  })
  const ws = new RdpWebSocket('https://api.example.com', 'tok', 'agent-1', resolve)
  const sent: unknown[] = []
  ;(ws as unknown as { sendMessage: (m: unknown) => void }).sendMessage = (m) => {
    sent.push(m)
  }
  const open = (sessionId: string): void => {
    const msg: RdpServerMessage = {
      type: 'rdp_open',
      sessionId,
      parameters: { hostname: '10.0.0.5' },
      width: 1280,
      height: 800,
      dpi: 96,
    }
    ;(
      ws as unknown as { onParsedMessage: (m: RdpServerMessage) => void }
    ).onParsedMessage(msg)
  }
  return { ws, sent, registerShutdownHook, env, open }
}

/** A guacd socket that accepts everything and never completes a handshake. */
function fakeGuacdSocket(): unknown {
  return {
    write: jest.fn(),
    onData: jest.fn(),
    onClose: jest.fn(),
    onError: jest.fn(),
    destroy: jest.fn(),
  }
}

describe('guacd の遅延起動', () => {
  beforeEach(() => {
    ensureGuacdContainer.mockReset()
    ensureGuacdContainer.mockReturnValue({ host: '127.0.0.1', port: 4822 })
    connectToGuacd.mockReset()
    connectToGuacd.mockResolvedValue(fakeGuacdSocket())
    stopHook.mockReset()
  })

  it('★ 起動時（relay 生成時）には guacd を起動しない', () => {
    makeHarness({ declaration: { rdp: true } })
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
  })

  it('★ 初回の rdp_open で 1 回だけ起動する', () => {
    const h = makeHarness({ declaration: { rdp: true } })
    h.open('sess-1')
    expect(ensureGuacdContainer).toHaveBeenCalledTimes(1)
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'loopback' }),
    )
  })

  it('★ 2 回目以降は起動しない（冪等）', () => {
    const h = makeHarness({ declaration: { rdp: true } })
    h.open('sess-1')
    h.open('sess-2')
    expect(ensureGuacdContainer).toHaveBeenCalledTimes(1)
  })

  it('解決した接続先を環境変数へ反映する（診断・子プロセス用）', () => {
    const h = makeHarness({ declaration: { rdp: true } })
    h.open('sess-1')
    expect(h.env.GUACD_HOST).toBe('127.0.0.1')
    expect(h.env.GUACD_PORT).toBe('4822')
  })

  it('★ GUACD_HOST が既にあれば何も起動せず、その接続先を使う', () => {
    // 運用側が別途 guacd を用意している構成を壊さない（既存方針）。
    const h = makeHarness({
      declaration: { rdp: true },
      env: { GUACD_HOST: 'guacd.internal', GUACD_PORT: '14822' },
    })
    h.open('sess-1')
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
    expect(connectToGuacd).toHaveBeenCalledWith('guacd.internal', 14822)
  })

  describe('停止漏れ', () => {
    it('★ 遅延起動したら終了フックを登録する', () => {
      // 以前は `--rdp` が指定されたときにだけ登録していた。遅延起動の経路は
      // そのフラグを通らないため、止め損ねると無認証の guacd がホストに
      // 残り続ける。
      const h = makeHarness({ declaration: { rdp: true } })
      h.open('sess-1')
      expect(h.registerShutdownHook).toHaveBeenCalledTimes(1)
      expect(h.registerShutdownHook).toHaveBeenCalledWith(stopHook)
    })

    it('★ 起動していなければ登録しない（毎回の偽警告を出さない）', () => {
      const h = makeHarness({
        declaration: { rdp: true },
        env: { GUACD_HOST: 'guacd.internal' },
      })
      h.open('sess-1')
      expect(h.registerShutdownHook).not.toHaveBeenCalled()
    })

    it('二重起動しても登録は 1 回', () => {
      const h = makeHarness({ declaration: { rdp: true } })
      h.open('sess-1')
      h.open('sess-2')
      expect(h.registerShutdownHook).toHaveBeenCalledTimes(1)
    })
  })

  describe('capability が有効でないとき', () => {
    it('★ guacd を起動せず、明示的なエラーで拒否する', () => {
      // 以前は存在しない guacd へ接続を試み、タイムアウトするまで利用者には
      // 「繋がらない」としか見えなかった。
      const h = makeHarness({ declaration: {} })
      h.open('sess-1')

      expect(ensureGuacdContainer).not.toHaveBeenCalled()
      expect(connectToGuacd).not.toHaveBeenCalled()
      expect(h.sent).toEqual([
        expect.objectContaining({
          type: 'error',
          sessionId: 'sess-1',
          fatal: true,
          message: expect.stringContaining('rdp'),
        }),
      ])
    })

    it('★ Docker 形態（再起動待ち）も同じく拒否する', () => {
      const h = makeHarness({
        declaration: { rdp: true },
        env: { AI_SUPPORT_AGENT_IN_DOCKER: '1' },
      })
      h.open('sess-1')

      expect(ensureGuacdContainer).not.toHaveBeenCalled()
      expect(h.sent).toEqual([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('action_required_restart'),
        }),
      ])
    })
  })

  describe('K8s / ECS', () => {
    it.each([
      ['k8s', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
      ['ecs', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/t' }],
    ])(
      '★ %s では guacd コンテナを絶対に起動しない（顧客クラスタへ何も書かない）',
      (_name, env) => {
        const h = makeHarness({ declaration: { rdp: true }, env })
        h.open('sess-1')

        expect(ensureGuacdContainer).not.toHaveBeenCalled()
        expect(h.registerShutdownHook).not.toHaveBeenCalled()
        expect(h.sent).toEqual([
          expect.objectContaining({
            type: 'error',
            message: expect.stringContaining('action_required_redeploy'),
          }),
        ])
      },
    )

    it('サイドカーで配線済みなら、コンテナを起こさずそのまま繋ぐ', () => {
      const h = makeHarness({
        declaration: { rdp: true },
        env: { KUBERNETES_SERVICE_HOST: '10.43.0.1', GUACD_HOST: '127.0.0.1' },
      })
      h.open('sess-1')

      expect(ensureGuacdContainer).not.toHaveBeenCalled()
      expect(connectToGuacd).toHaveBeenCalledWith('127.0.0.1', 4822)
    })
  })

  describe('起動に失敗したとき', () => {
    beforeEach(() => {
      ensureGuacdContainer.mockImplementation(() => {
        throw new Error('docker daemon is not running')
      })
    })

    it('★ エージェント本体を巻き添えにせず、セッションだけを明示エラーで断る', () => {
      const h = makeHarness({ declaration: { rdp: true } })
      expect(() => h.open('sess-1')).not.toThrow()
      expect(h.sent).toEqual([
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('docker daemon is not running'),
        }),
      ])
    })

    it('失敗は記憶せず、次の要求で再試行する（利用者の操作で復旧できる）', () => {
      const h = makeHarness({ declaration: { rdp: true } })
      h.open('sess-1')
      ensureGuacdContainer.mockReturnValue({ host: '127.0.0.1', port: 4822 })
      h.open('sess-2')
      expect(connectToGuacd).toHaveBeenCalledWith('127.0.0.1', 4822)
    })
  })
})
