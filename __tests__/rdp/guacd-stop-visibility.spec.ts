import { logger } from '../../src/logger'
import { stopGuacdContainer } from '../../src/rdp/guacd-container'

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
