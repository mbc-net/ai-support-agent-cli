import * as fs from 'fs'
import * as path from 'path'

jest.mock('fs')
jest.mock('../src/logger')
jest.mock('../src/project-dir', () => ({
  // jest.fn で包むのは返り値を変えるためではなく、個別のテストで
  // 「想定外の例外」を注入できるようにするため。既定の実装は同じ。
  getAwsDir: jest.fn((projectDir: string) =>
    path.join(projectDir, '.ai-support-agent', 'aws'),
  ),
}))

import { sweepStaleAwsCredentials } from '../src/aws-credential-sweep'
import { logger } from '../src/logger'
import { getAwsDir } from '../src/project-dir'

const mockedFs = jest.mocked(fs)

describe('sweepStaleAwsCredentials', () => {
  const PREFIX = '[mbc/MBC_01]'
  const oldMs = Date.now() - 25 * 60 * 60 * 1000

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('projectDir が無ければ何もしない（掃除対象を決められない）', () => {
    sweepStaleAwsCredentials(undefined, PREFIX)

    expect(mockedFs.readdirSync).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('削除件数が 0 件のときはログを出さない', () => {
    mockedFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[])

    sweepStaleAwsCredentials('/proj', PREFIX)

    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('削除したら件数を info で残す', () => {
    mockedFs.readdirSync.mockReturnValue(['credentials-aaaa1111'] as unknown as fs.Dirent[])
    mockedFs.statSync.mockReturnValue({ mtimeMs: oldMs } as fs.Stats)
    mockedFs.rmSync.mockReturnValue(undefined)

    sweepStaleAwsCredentials('/proj', PREFIX)

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Cleaned up 1 stale AWS credentials file(s)'),
    )
  })

  it('ディレクトリが読めないときは何も起きない（sweepStaleEntries が 0 を返す）', () => {
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(() => sweepStaleAwsCredentials('/proj', PREFIX)).not.toThrow()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  /**
   * これは heartbeat ループの中から呼ばれる。例外を投げると、平文の認証情報が
   * 残っているという軽微な後始末の失敗が、エージェントそのものの停止に化ける。
   * `sweepStaleEntries` は内部で readdir 失敗を吸収するため、外側の catch が
   * 効くのは想定外の例外が出たときだけ。それをここで固定する。
   */
  it('想定外の例外が出ても投げず warn に留める', () => {
    jest.mocked(getAwsDir).mockImplementationOnce(() => {
      throw new Error('unexpected')
    })

    expect(() => sweepStaleAwsCredentials('/proj', PREFIX)).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up stale AWS credentials files'),
    )
  })
})
