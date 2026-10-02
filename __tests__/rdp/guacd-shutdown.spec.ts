import {
  resolveProjectGuacdIdentity,
  stopProjectGuacdContainer,
} from '../../src/rdp/guacd-container'

/**
 * 終了時に guacd コンテナを止めること。
 *
 * :::danger
 * **ソース文字列の検査では足りない。** 停止関数が import されて
 * いるだけ、あるいは片方の終了経路にだけ書かれていても、文字列を探すテストは
 * 通ってしまう。実際に停止経路を実行して呼び出しを確認する。
 * :::
 *
 * guacd は無認証で待ち受けるため、エージェントが終わったあとも残ると、同じ
 * ホスト上の何かから使える状態が続く。Docker 形態の guacd はプロジェクト別
 * （`ais-guacd-<key>`）なので、止めたかどうかもプロジェクト単位で持つ。
 */

jest.mock('../../src/rdp/guacd-container', () => ({
  ...jest.requireActual('../../src/rdp/guacd-container'),
  stopProjectGuacdContainer: jest.fn(),
  removeProjectGuacdNetwork: jest.fn().mockReturnValue(true),
  removeProjectTrustStore: jest.fn().mockReturnValue(true),
}))

const stopGuacd = stopProjectGuacdContainer as jest.Mock

describe('DockerSupervisor の終了経路', () => {
  beforeEach(() => {
    stopGuacd.mockReset()
  })

  type Supervisor = {
    stopAll: () => Promise<void>
    shutdownGuacd: (options: { agentsStopped: boolean }) => void
    guacdProjects: Map<string, unknown>
  }

  /**
   * RDP 有効な supervisor を、コンテナを起動せずに組み立てる。`guacdOf` の
   * プロジェクトについて guacd を用意した状態（spawnProject 済み）にする。
   */
  const build = (rdp: boolean, guacdOf: string[] = ['mbc/P1']): Supervisor => {
    const {
      DockerSupervisor,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
    } = require('../../src/docker/docker-supervisor') as {
      DockerSupervisor: new (version: string, opts: Record<string, unknown>) => Supervisor
    }
    const supervisor = new DockerSupervisor('0.0.0-test', {
      apiUrl: 'https://api.example.com',
      agentId: 'agent-1',
      projects: [],
      rdp,
    })
    for (const ref of guacdOf) {
      const [tenantCode, projectCode] = ref.split('/')
      supervisor.guacdProjects.set(ref, {
        id: resolveProjectGuacdIdentity({ tenantCode, projectCode }, 'agent-1'),
        containerStopped: false,
      })
    }
    return supervisor
  }

  it('★ stopAll が guacd を止める', async () => {
    stopGuacd.mockReturnValue(true)
    await build(true).stopAll()
    expect(stopGuacd).toHaveBeenCalledTimes(1)
  })

  it('★ stopAll は全プロジェクトの guacd を止める', async () => {
    stopGuacd.mockReturnValue(true)
    await build(true, ['mbc/P1', 'mbc/P2']).stopAll()
    expect(stopGuacd.mock.calls.map((c) => c[0].projectRef)).toEqual(['mbc/P1', 'mbc/P2'])
  })

  it('RDP 無効なら guacd に触らない', async () => {
    await build(false).stopAll()
    expect(stopGuacd).not.toHaveBeenCalled()
  })

  // 「全コンテナが自然終了 → process.exit」経路の検証は
  // __tests__/docker/docker-supervisor.spec.ts が実際に close を発火させて行う。
  // ここでヘルパを直接呼ぶだけの形にすると、配線が消えても緑のままになる
  // （実際にミューテーションで素通りすることを確認した）。

  it('停止処理を繰り返しても guacd の停止は 1 回だけ', async () => {
    stopGuacd.mockReturnValue(true)
    const supervisor = build(true)
    supervisor.shutdownGuacd({ agentsStopped: true })
    await supervisor.stopAll()
    expect(stopGuacd).toHaveBeenCalledTimes(1)
  })

  it('★ 停止に失敗したら次の終了経路で再試行する', async () => {
    // 二重呼び出しを抑えること自体は正しいが、**成否を見ずに抑える**と
    // 一時障害で止め損ねた guacd がそのまま残る。guacd は無認証で待ち受ける
    // ため、エージェント終了後も到達できる者が任意のホストへ RDP を張れる。
    stopGuacd.mockReturnValueOnce(false).mockReturnValue(true)
    const supervisor = build(true)

    supervisor.shutdownGuacd({ agentsStopped: true })
    await supervisor.stopAll()

    expect(stopGuacd).toHaveBeenCalledTimes(2)
  })
})
