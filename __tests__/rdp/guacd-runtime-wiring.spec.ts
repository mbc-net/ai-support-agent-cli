import {
  buildGuacdDockerArgs,
  createLazyGuacdEndpointResolver,
  RdpUnavailableError,
} from '../../src/rdp/guacd-runtime'

jest.mock('../../src/rdp/guacd-container', () => ({
  ...jest.requireActual('../../src/rdp/guacd-container'),
  ensureGuacdContainer: jest.fn(),
}))

const { ensureGuacdContainer } = jest.requireMock(
  '../../src/rdp/guacd-container',
) as { ensureGuacdContainer: jest.Mock }

/**
 * Docker 形態と CLI 直起動での guacd の面倒見。
 *
 * K8s / ECS はマニフェストでサイドカーを宣言できるが、この 2 形態には仕組みが
 * 無いため、エージェント自身が guacd コンテナを起動して接続先を配る。
 */

describe('buildGuacdDockerArgs（Docker 形態）', () => {
  beforeEach(() => {
    ensureGuacdContainer.mockReset()
    ensureGuacdContainer.mockReturnValue({ host: 'ais-guacd', port: 4822 })
  })

  it('★ RDP 無効なら何も足さず guacd も起動しない', () => {
    expect(buildGuacdDockerArgs({ rdp: false })).toEqual([])
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
  })

  it('ネットワークモードで guacd を用意する', () => {
    buildGuacdDockerArgs({ rdp: true })
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'network' }),
    )
  })

  it('★ エージェントを同じネットワークへ参加させる', () => {
    const args = buildGuacdDockerArgs({ rdp: true })
    expect(args).toContain('--network')
    expect(args[args.indexOf('--network') + 1]).toBe('ais-rdp')
  })

  it('★ 接続先を環境変数で渡す', () => {
    const args = buildGuacdDockerArgs({ rdp: true })
    const joined = args.join(' ')
    expect(joined).toContain('GUACD_HOST=ais-guacd')
    expect(joined).toContain('GUACD_PORT=4822')
  })

  it('イメージ指定を引き渡す', () => {
    buildGuacdDockerArgs({ rdp: true, guacdImage: 'registry/guacd:1.5.5' })
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'registry/guacd:1.5.5' }),
    )
  })

  it('★ guacd の用意に失敗しても投げない（プロジェクト全体を巻き添えにしない）', () => {
    // 呼び出し元はプロジェクトのコンテナを起動する経路。ここで投げると RDP と
    // 無関係なチャット・ターミナルまで含めてそのプロジェクトが起動しない。
    // しかも呼び出し元の一つ（rebuildAndRestart 末尾からの再起動）は catch を
    // 持たない fire-and-forget であり、投げた例外はプロジェクト名すら残らない
    // unhandled rejection にしかならない。CLI 直起動（resolveGuacdForHost）が
    // 既に同じ方針を明記している。
    ensureGuacdContainer.mockImplementation(() => {
      throw new Error('docker daemon is not running')
    })

    expect(() => buildGuacdDockerArgs({ rdp: true })).not.toThrow()
    expect(buildGuacdDockerArgs({ rdp: true })).toEqual([])
  })
})

describe('createLazyGuacdEndpointResolver（CLI 直起動・遅延起動）', () => {
  /** 解決関数と、それに渡した環境変数・終了フック登録をまとめて作る。 */
  const build = (
    env: NodeJS.ProcessEnv = {},
  ): {
    resolve: () => { host: string; port: number }
    env: NodeJS.ProcessEnv
    registerShutdownHook: jest.Mock
  } => {
    const registerShutdownHook = jest.fn()
    return {
      resolve: createLazyGuacdEndpointResolver({ env, registerShutdownHook }),
      env,
      registerShutdownHook,
    }
  }

  beforeEach(() => {
    ensureGuacdContainer.mockReset()
    ensureGuacdContainer.mockReturnValue({ host: '127.0.0.1', port: 4822 })
  })

  it('★ 解決関数を作っただけでは guacd を起動しない', () => {
    // 起動時にまとめて用意すると、画面から有効化してもプロセスを再起動する
    // までは使えないままになる。
    build()
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
  })

  it('ループバックモードで guacd を用意し環境変数を設定する', () => {
    const { resolve, env } = build()
    expect(resolve()).toEqual({ host: '127.0.0.1', port: 4822 })
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'loopback' }),
    )
    expect(env.GUACD_HOST).toBe('127.0.0.1')
    expect(env.GUACD_PORT).toBe('4822')
  })

  it('★ 既に GUACD_HOST が設定されていれば尊重し、コンテナを起動しない', () => {
    // 運用側が別途 guacd を用意している場合を壊さない。
    const { resolve } = build({ GUACD_HOST: 'guacd.internal', GUACD_PORT: '14822' })
    expect(resolve()).toEqual({ host: 'guacd.internal', port: 14822 })
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
  })

  it('★ 起動に成功したら終了フックを登録する（止め損ねると無認証の guacd が残る）', () => {
    const { resolve, registerShutdownHook } = build()
    resolve()
    expect(registerShutdownHook).toHaveBeenCalledTimes(1)
  })

  it('★ CLI の --guacd-image を環境変数経由で引き渡す', () => {
    // 中継を担うのは fork された子プロセスであり、argv は継承しない。
    const { resolve } = build({ AI_SUPPORT_AGENT_GUACD_IMAGE: 'registry/guacd:1.5.5' })
    resolve()
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'registry/guacd:1.5.5' }),
    )
  })

  it('★ 起動に失敗したら明示的に投げる（黙って死んだ接続先へ繋ぎに行かない）', () => {
    // 以前は警告だけ出して続行していたため、利用者には「しばらく待たされて
    // 繋がらない」としか見えなかった。エージェント本体は巻き添えにしないが、
    // その 1 件の接続要求は理由付きで断る。
    ensureGuacdContainer.mockImplementation(() => {
      throw new Error('docker not available')
    })
    const { resolve, env } = build()
    expect(() => resolve()).toThrow(RdpUnavailableError)
    expect(env.GUACD_HOST).toBeUndefined()
  })
})
