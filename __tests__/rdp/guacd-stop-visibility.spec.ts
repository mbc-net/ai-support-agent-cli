import { logger } from '../../src/logger'
import {
  createGuacdShutdownHook,
  stopGuacdContainer,
} from '../../src/rdp/guacd-container'

jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('../../src/logger', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

const { execFileSync } = jest.requireMock('child_process') as {
  execFileSync: jest.Mock
}

/**
 * guacd の停止に失敗したことが運用者に見えるか。
 *
 * :::danger
 * **止め損ねた事実を debug ログに埋めない。** guacd には認証が無く、到達できる者は
 * 誰でも任意のホストへ RDP 接続を張れる。エージェントを終えても残り続けている
 * 状態は、通常の運用で収集されない debug では気づけない。
 * :::
 */
describe('guacd の停止失敗の可視性', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('★ 停止に失敗したら warn を残す（debug に埋めない）', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('docker daemon is not running')
    })

    stopGuacdContainer()

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('guacd'),
    )
  })

  it('★ 失敗しても投げない（後続の後始末を止めない）', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('boom')
    })

    expect(() => stopGuacdContainer()).not.toThrow()
  })

  it('成功時は警告を出さない', () => {
    execFileSync.mockReturnValue(Buffer.from(''))

    stopGuacdContainer()

    expect(logger.warn).not.toHaveBeenCalled()
  })
})

/**
 * 終了ハンドラは複数のシグナルに登録される。
 *
 * :::danger
 * **同じ停止処理を素通しで 2 回走らせない。** `exit` と `SIGINT` / `SIGTERM`
 * の 3 箇所に同じハンドラを登録しているため、通常の終了で 2 回呼ばれる。
 * 2 回目は必ず「そんなコンテナは無い」で失敗し、「まだ RDP 接続を受け付けて
 * いるかもしれない」という警告が**正常な終了のたびに**出る。狼少年になり、
 * 本物の停止失敗がその中に埋もれる。
 * :::
 */
describe('終了時の guacd 停止ハンドラ', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    execFileSync.mockReturnValue(Buffer.from(''))
  })

  it('★ 2 回呼ばれても docker stop は 1 度しか走らない', () => {
    const stop = createGuacdShutdownHook()

    stop()
    stop()

    const stops = execFileSync.mock.calls.filter((c) =>
      (c[1] as string[]).includes('stop'),
    )
    expect(stops).toHaveLength(1)
  })

  it('★ 2 回目で偽の警告を出さない（本物の失敗を埋もれさせない）', () => {
    const stop = createGuacdShutdownHook()
    stop()
    // 1 度目で消えているので、2 度目の docker stop は必ず失敗する
    execFileSync.mockImplementation(() => {
      throw new Error('Error response from daemon: No such container: ais-guacd')
    })

    stop()

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('1 度目の停止失敗は従来どおり warn で残す', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('docker daemon is not running')
    })
    const stop = createGuacdShutdownHook()

    stop()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('guacd'))
  })

  it('★ 1 回目の停止に失敗したら 2 回目で再試行する', () => {
    // 素通しで 2 回走らせていた頃は、1 回目が Docker daemon の一時障害で
    // 失敗しても 2 回目が止め直していた。多重呼び出しを畳むときに成否を
    // 見ないと、その再試行ごと落ちる。**認証の無い guacd が終了後も稼働した
    // まま残る。**
    execFileSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    const stop = createGuacdShutdownHook()

    stop()
    stop()

    const stops = execFileSync.mock.calls.filter((c) =>
      (c[1] as string[]).includes('stop'),
    )
    expect(stops).toHaveLength(2)
  })

  it('★ 再試行が成功したらそこで止める（3 回目は走らない）', () => {
    execFileSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    const stop = createGuacdShutdownHook()

    stop()
    stop()
    stop()

    const stops = execFileSync.mock.calls.filter((c) =>
      (c[1] as string[]).includes('stop'),
    )
    expect(stops).toHaveLength(2)
  })

  /** `docker stop` が「そんなコンテナは無い」で落ちる状況を作る。 */
  const noSuchContainer = (): Error => {
    const err = new Error('Command failed: docker stop ais-guacd') as Error & {
      stderr: Buffer
    }
    err.stderr = Buffer.from(
      'Error response from daemon: No such container: ais-guacd\n',
    )
    return err
  }

  /**
   * :::danger
   * **「もう無い」は失敗ではない。**
   * `--rdp` を付けていても、`GUACD_HOST` を指定した外部 guacd 運用や Docker
   * 不在の環境では、エージェントはコンテナを起動しない。それでも終了ハンドラは
   * 登録されるため、毎回の終了で `docker stop` が「そんなコンテナは無い」で
   * 落ちる。これを失敗として扱うと、**正常な終了のたびに「まだ RDP 接続を
   * 受け付けているかもしれない」と警告が出て**、しかも畳まれないので再試行で
   * 2 回出る。狼少年になり、本物の停止失敗が埋もれる。
   * :::
   */
  describe('コンテナが元から存在しない場合', () => {
    it('★ 警告を出さない（起動していないものを止め損ねたとは言わない）', () => {
      execFileSync.mockImplementation(() => {
        throw noSuchContainer()
      })

      createGuacdShutdownHook()()

      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('★ 終端として畳む（終了のたびに再試行しない）', () => {
      execFileSync.mockImplementation(() => {
        throw noSuchContainer()
      })
      const stop = createGuacdShutdownHook()

      stop()
      stop()

      const stops = execFileSync.mock.calls.filter((c) =>
        (c[1] as string[]).includes('stop'),
      )
      expect(stops).toHaveLength(1)
    })

    it('★ 別コンテナ名の「そんなコンテナは無い」では畳まない', () => {
      // 「無い」と言われたのが**停止対象とは別のコンテナ**なら、guacd は
      // 止め損ねたままかもしれない。名前を見ずに終端と決めると、警告も
      // 再試行も消えて、無認証の guacd が残ったことに誰も気づけない。
      const err = new Error('Command failed') as Error & { stderr: Buffer }
      err.stderr = Buffer.from(
        'Error response from daemon: No such container: unrelated-helper\n',
      )
      execFileSync.mockImplementation(() => {
        throw err
      })
      const stop = createGuacdShutdownHook()

      stop()
      stop()

      expect(logger.warn).toHaveBeenCalled()
      const stops = execFileSync.mock.calls.filter((c) =>
        (c[1] as string[]).includes('stop'),
      )
      expect(stops).toHaveLength(2)
    })

    it('stderr が string でも対象名の不在を認識する', () => {
      const err = new Error('Command failed') as Error & { stderr: string }
      err.stderr = 'Error response from daemon: No such container: ais-guacd'
      execFileSync.mockImplementation(() => {
        throw err
      })

      createGuacdShutdownHook()()

      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('stderr が無くても message 側の文言で判定できる', () => {
      execFileSync.mockImplementation(() => {
        throw new Error('No such container: ais-guacd')
      })

      createGuacdShutdownHook()()

      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('本物の停止失敗は従来どおり警告し、再試行する', () => {
      execFileSync.mockImplementation(() => {
        throw new Error('Cannot connect to the Docker daemon')
      })
      const stop = createGuacdShutdownHook()

      stop()
      stop()

      expect(logger.warn).toHaveBeenCalled()
      const stops = execFileSync.mock.calls.filter((c) =>
        (c[1] as string[]).includes('stop'),
      )
      expect(stops).toHaveLength(2)
    })
  })

  it('ハンドラごとに状態は独立する（別プロセス相当の再利用で塞がない）', () => {
    createGuacdShutdownHook()()
    createGuacdShutdownHook()()

    const stops = execFileSync.mock.calls.filter((c) =>
      (c[1] as string[]).includes('stop'),
    )
    expect(stops).toHaveLength(2)
  })
})
