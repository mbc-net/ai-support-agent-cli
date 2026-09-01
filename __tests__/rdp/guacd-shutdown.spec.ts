import { stopGuacdContainer } from '../../src/rdp/guacd-container'

/**
 * 終了時に guacd コンテナを止めること。
 *
 * :::danger
 * **ソース文字列の検査では足りない。** `stopGuacdContainer` が import されて
 * いるだけ、あるいは片方の終了経路にだけ書かれていても、文字列を探すテストは
 * 通ってしまう。実際に停止経路を実行して呼び出しを確認する。
 * :::
 *
 * guacd は無認証で待ち受けるため、エージェントが終わったあとも残ると、同じ
 * ホスト上の何かから使える状態が続く。
 */

jest.mock('../../src/rdp/guacd-container', () => ({
  ...jest.requireActual('../../src/rdp/guacd-container'),
  stopGuacdContainer: jest.fn(),
}))

const stopGuacd = stopGuacdContainer as jest.Mock

describe('DockerSupervisor の終了経路', () => {
  beforeEach(() => {
    stopGuacd.mockReset()
  })

  /** RDP 有効な supervisor を、コンテナを起動せずに組み立てる。 */
  const build = (rdp: boolean): { stopAll: () => Promise<void> } => {
    // 実際の spawn を避けるため、必要な内部状態だけを持つ最小の実体を作る。
    const {
      DockerSupervisor,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
    } = require('../../src/docker/docker-supervisor') as {
      DockerSupervisor: new (
        version: string,
        opts: Record<string, unknown>,
      ) => {
        stopAll: () => Promise<void>
      }
    }
    return new DockerSupervisor('0.0.0-test', {
      apiUrl: 'https://api.example.com',
      agentId: 'agent-1',
      projects: [],
      rdp,
    })
  }

  it('★ stopAll が guacd を止める', async () => {
    await build(true).stopAll()
    expect(stopGuacd).toHaveBeenCalledTimes(1)
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
    const supervisor = build(true) as unknown as {
      shutdownGuacd: () => void
      stopAll: () => Promise<void>
    }
    supervisor.shutdownGuacd()
    await supervisor.stopAll()
    expect(stopGuacd).toHaveBeenCalledTimes(1)
  })
})
