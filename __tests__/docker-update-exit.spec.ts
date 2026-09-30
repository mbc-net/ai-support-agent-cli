jest.mock('../src/logger')
jest.mock('../src/utils', () => ({
  atomicWriteFile: jest.fn(),
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  isInDocker: jest.fn(),
}))
jest.mock('../src/utils/path-utils', () => ({
  getUpdateVersionFilePath: () => '/cfg/update-version.json',
}))

import { DOCKER_UPDATE_EXIT_CODE } from '../src/constants'
import { exitIfDockerUpdateRestart } from '../src/docker-update-exit'
import { logger } from '../src/logger'
import { atomicWriteFile, isInDocker } from '../src/utils'

/**
 * 自動更新（`auto-updater`）と手動更新コマンド（`project-agent`）の 2 経路が
 * 逐語で持っていた「Docker 内なら新バージョンを記録して専用コードで終了する」
 * 処理。
 *
 * ホスト側は終了コードだけを頼りに「更新による再起動」と「正常停止」を区別し、
 * `update-version.json` を読んで `npm install` してから再ビルドする。片方の経路
 * でどちらかが欠けると、その経路から更新したときだけ再ビルドされない／どの
 * バージョンへ上げるか分からない、という形でしか現れない。
 */
describe('exitIfDockerUpdateRestart', () => {
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('Docker 外では何もしない（書き出しも終了もしない）', () => {
    jest.mocked(isInDocker).mockReturnValue(false)

    exitIfDockerUpdateRestart('1.2.3')

    expect(atomicWriteFile).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('Docker 内ではバージョンを書き出してから専用コードで終了する', () => {
    jest.mocked(isInDocker).mockReturnValue(true)

    exitIfDockerUpdateRestart('1.2.3')

    expect(atomicWriteFile).toHaveBeenCalledWith(
      '/cfg/update-version.json',
      JSON.stringify({ version: '1.2.3' }),
    )
    expect(exitSpy).toHaveBeenCalledWith(DOCKER_UPDATE_EXIT_CODE)
  })

  it('書き出しは終了より先に行う（順序が逆だとホストが読めない）', () => {
    jest.mocked(isInDocker).mockReturnValue(true)
    const order: string[] = []
    jest.mocked(atomicWriteFile).mockImplementation(() => {
      order.push('write')
    })
    exitSpy.mockImplementation(((): undefined => {
      order.push('exit')
      return undefined
    }) as never)

    exitIfDockerUpdateRestart('1.2.3')

    expect(order).toEqual(['write', 'exit'])
  })

  /**
   * 書き出しの失敗で中断すると、更新の最後の一歩だけが失敗してコンテナが
   * 古いまま動き続ける。warn に留めて終了コードは出す。
   */
  it('書き出しに失敗しても warn に留めて終了コードは出す', () => {
    jest.mocked(isInDocker).mockReturnValue(true)
    jest.mocked(atomicWriteFile).mockImplementation(() => {
      throw new Error('ENOSPC')
    })

    expect(() => exitIfDockerUpdateRestart('1.2.3')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write update-version.json'),
    )
    expect(exitSpy).toHaveBeenCalledWith(DOCKER_UPDATE_EXIT_CODE)
  })
})
