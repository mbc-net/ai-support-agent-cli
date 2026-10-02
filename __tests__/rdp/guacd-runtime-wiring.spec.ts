import {
  buildGuacdDockerArgs,
  buildSharedGuacdDockerArgs,
  createLazyGuacdEndpointResolver,
  RdpUnavailableError,
} from '../../src/rdp/guacd-runtime'
import { resolveProjectGuacdIdentity } from '../../src/rdp/guacd-container'
import { logger } from '../../src/logger'

jest.mock('../../src/logger')
jest.mock('../../src/rdp/guacd-container', () => ({
  ...jest.requireActual('../../src/rdp/guacd-container'),
  ensureGuacdContainer: jest.fn(),
  ensureProjectGuacdContainer: jest.fn(),
  extractGuacdSystemCaBundle: jest.fn(),
  invalidateProjectTrustStore: jest.fn().mockReturnValue(true),
}))

const {
  ensureGuacdContainer,
  ensureProjectGuacdContainer,
  extractGuacdSystemCaBundle,
  invalidateProjectTrustStore,
} = jest.requireMock('../../src/rdp/guacd-container') as {
  ensureGuacdContainer: jest.Mock
  ensureProjectGuacdContainer: jest.Mock
  extractGuacdSystemCaBundle: jest.Mock
  invalidateProjectTrustStore: jest.Mock
}

/**
 * Docker 形態と CLI 直起動での guacd の面倒見。
 *
 * K8s / ECS はマニフェストでサイドカーを宣言できるが、この 2 形態には仕組みが
 * 無いため、エージェント自身が guacd コンテナを起動して接続先を配る。
 */

describe('buildGuacdDockerArgs（Docker 形態・プロジェクト別 guacd）', () => {
  const project = { tenantCode: 'mbc', projectCode: 'MBC_01' }
  const id = resolveProjectGuacdIdentity(project, 'agent-1')

  beforeEach(() => {
    ensureProjectGuacdContainer.mockReset()
    ensureProjectGuacdContainer.mockReturnValue({ host: id.containerName, port: 4822 })
    extractGuacdSystemCaBundle.mockReset()
    jest.mocked(logger.warn).mockClear()
  })

  it('★ RDP 無効なら何も足さず guacd も起動しない', () => {
    expect(buildGuacdDockerArgs({ rdp: false }, project, 'agent-1')).toEqual([])
    expect(ensureProjectGuacdContainer).not.toHaveBeenCalled()
  })

  it('★ そのプロジェクトの guacd を用意し、専用ネットワーク・接続先・信頼ストアを渡す', () => {
    const args = buildGuacdDockerArgs({ rdp: true, guacdImage: 'registry/guacd:1.5.5' }, project, 'agent-1')
    expect(ensureProjectGuacdContainer).toHaveBeenCalledWith(id, 'registry/guacd:1.5.5')
    expect(extractGuacdSystemCaBundle).toHaveBeenCalledWith(id)
    expect(args).toEqual([
      '--network', id.networkName,
      '-e', `GUACD_HOST=${id.containerName}`,
      '-e', 'GUACD_PORT=4822',
      '-e', 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN=docker-network',
      '-v', `${id.caHostDir}:/run/ais-rdp-ca:rw`,
      '-e', 'AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR=/run/ais-rdp-ca',
    ])
  })

  it('★ 標準バンドルを取り出せなければ CA を申告しない形（信頼ストアを渡さない）で続ける', () => {
    extractGuacdSystemCaBundle.mockImplementation(() => {
      throw new Error('container is not running')
    })
    const args = buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
    expect(args).toEqual([
      '--network', id.networkName,
      '-e', `GUACD_HOST=${id.containerName}`,
      '-e', 'GUACD_PORT=4822',
      '-e', 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN=docker-network',
    ])
    expect(args.join(' ')).not.toContain('RDP_TRUSTED_CA_DIR')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('container is not running'))
    // 信頼ストアを消すので、検証を有効にした接続は公開 CA でも失敗し得る（実態どおり伝える）。
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'RDP connections without certificate verification are unaffected; connections with ' +
          'certificate verification enabled (including ones needing a registered CA) may fail ' +
          'until the container is recreated with a valid CA bundle',
      ),
    )
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('RDP itself stays available'))
    // 前回の登録 CA 入りの bundle.pem を guacd に読ませ続けない（fail-closed）。
    expect(invalidateProjectTrustStore).toHaveBeenCalledWith(id)
  })

  it('★ 取り出しに成功したら信頼ストアを無効化しない', () => {
    invalidateProjectTrustStore.mockClear()
    buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
    expect(invalidateProjectTrustStore).not.toHaveBeenCalled()
  })

  it('★ 取り出しにも無効化にも失敗したら、このプロジェクトの RDP を無効にする（古い CA を信頼し得る guacd へ繋がない）', () => {
    extractGuacdSystemCaBundle.mockImplementation(() => {
      throw new Error('container is not running')
    })
    invalidateProjectTrustStore.mockReturnValueOnce(false)
    expect(buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mbc/MBC_01'))
  })

  it('★ guacd の用意に失敗しても投げない（プロジェクト全体を巻き添えにしない）', () => {
    ensureProjectGuacdContainer.mockImplementation(() => {
      throw new Error('docker daemon is not running')
    })
    expect(buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')).toEqual([])
    expect(extractGuacdSystemCaBundle).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('docker daemon is not running'))
    // 複数プロジェクトのログが混ざるため、どのプロジェクトのものか分かること。
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mbc/MBC_01'))
  })

  it('★ 同じプロジェクトでも agentId が違えば別の guacd を使う', () => {
    buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
    buildGuacdDockerArgs({ rdp: true }, project, 'agent-2')
    const [a, b] = ensureProjectGuacdContainer.mock.calls.map((c) => c[0].containerName)
    expect(a).toBe(id.containerName)
    expect(b).not.toBe(a)
  })

  it('★ 標準バンドルの取り出しがタイムアウトしても、CA を申告しない形で続ける', () => {
    extractGuacdSystemCaBundle.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })
    const args = buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
    expect(args).toContain(`GUACD_HOST=${id.containerName}`)
    expect(args.join(' ')).not.toContain('RDP_TRUSTED_CA_DIR')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ETIMEDOUT'))
  })

  it('★ プロジェクトごとに別の guacd を使う', () => {
    buildGuacdDockerArgs({ rdp: true }, project, 'agent-1')
    buildGuacdDockerArgs({ rdp: true }, { tenantCode: 'mbc', projectCode: 'MBC_02' }, 'agent-1')
    const [a, b] = ensureProjectGuacdContainer.mock.calls.map((c) => c[0].containerName)
    expect(a).not.toBe(b)
  })
})

describe('buildSharedGuacdDockerArgs（legacy fallback・共有 guacd）', () => {
  beforeEach(() => {
    ensureGuacdContainer.mockReset()
    ensureGuacdContainer.mockReturnValue({ host: 'ais-guacd', port: 4822 })
  })

  it('★ RDP 無効なら何も足さず guacd も起動しない', () => {
    expect(buildSharedGuacdDockerArgs({ rdp: false })).toEqual([])
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
  })

  it('ネットワークモードで guacd を用意する', () => {
    buildSharedGuacdDockerArgs({ rdp: true })
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'network' }),
    )
  })

  it('★ エージェントを同じネットワークへ参加させる', () => {
    const args = buildSharedGuacdDockerArgs({ rdp: true })
    expect(args).toContain('--network')
    expect(args[args.indexOf('--network') + 1]).toBe('ais-rdp')
  })

  it('★ 信頼 CA を申告しない（共有 guacd の信頼ストアはプロジェクトで分けられない）', () => {
    const args = buildSharedGuacdDockerArgs({ rdp: true })
    expect(args.join(' ')).not.toContain('RDP_TRUSTED_CA_DIR')
    expect(args.join(' ')).not.toContain('/run/ais-rdp-ca')
  })

  it('★ 接続先を環境変数で渡す', () => {
    const args = buildSharedGuacdDockerArgs({ rdp: true })
    const joined = args.join(' ')
    expect(joined).toContain('GUACD_HOST=ais-guacd')
    expect(joined).toContain('GUACD_PORT=4822')
  })

  it('★ RDP トンネル中継の待ち受けを docker-network と明示する', () => {
    const args = buildSharedGuacdDockerArgs({ rdp: true })
    const index = args.indexOf('AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN=docker-network')
    expect(index).toBeGreaterThan(0)
    expect(args[index - 1]).toBe('-e')
  })

  it('イメージ指定を引き渡す', () => {
    buildSharedGuacdDockerArgs({ rdp: true, guacdImage: 'registry/guacd:1.5.5' })
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

    expect(() => buildSharedGuacdDockerArgs({ rdp: true })).not.toThrow()
    expect(buildSharedGuacdDockerArgs({ rdp: true })).toEqual([])
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
