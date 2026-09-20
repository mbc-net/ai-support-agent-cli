import { buildGuacdDockerArgs, resolveGuacdForHost } from '../../src/rdp/guacd-runtime'

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

describe('resolveGuacdForHost（CLI 直起動）', () => {
  beforeEach(() => {
    ensureGuacdContainer.mockReset()
    ensureGuacdContainer.mockReturnValue({ host: '127.0.0.1', port: 4822 })
    delete process.env.GUACD_HOST
    delete process.env.GUACD_PORT
  })

  it('★ RDP 無効なら guacd を起動せず環境変数も設定しない', () => {
    resolveGuacdForHost({ rdp: false })
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
    expect(process.env.GUACD_HOST).toBeUndefined()
  })

  it('ループバックモードで guacd を用意し環境変数を設定する', () => {
    resolveGuacdForHost({ rdp: true })
    expect(ensureGuacdContainer).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'loopback' }),
    )
    expect(process.env.GUACD_HOST).toBe('127.0.0.1')
    expect(process.env.GUACD_PORT).toBe('4822')
  })

  it('★ 既に GUACD_HOST が設定されていれば尊重し、コンテナを起動しない', () => {
    // 運用側が別途 guacd を用意している場合を壊さない。
    process.env.GUACD_HOST = 'guacd.internal'
    process.env.GUACD_PORT = '14822'
    resolveGuacdForHost({ rdp: true })
    expect(ensureGuacdContainer).not.toHaveBeenCalled()
    expect(process.env.GUACD_HOST).toBe('guacd.internal')
  })

  it('★ 起動に失敗しても致命傷にしない（RDP は付加機能）', () => {
    ensureGuacdContainer.mockImplementation(() => {
      throw new Error('docker not available')
    })
    // エージェント本体（チャット・ターミナル等）まで起動できなくなるのは割に合わない。
    expect(() => resolveGuacdForHost({ rdp: true })).not.toThrow()
    expect(process.env.GUACD_HOST).toBeUndefined()
  })
})
