/**
 * 共有ファイルの取得（署名付き URL からのストリーミング保存）
 *
 * **タイムアウトが付いていること**を主眼に置く。無応答のまま止まると、呼び出し側の
 * 配置処理は成功も失敗も返せず、失敗をハートビートで可視化する仕組みへ到達しない。
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import path from 'path'
import { Readable } from 'stream'

import axios from 'axios'

import { downloadProjectFileTo } from '../src/project-file-download'

jest.mock('axios')
const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>

const client = {
  getProjectFileDownloadUrl: jest.fn(),
} as unknown as import('../src/api-client').ApiClient

describe('downloadProjectFileTo', () => {
  let tmpDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tmpDir = mkdtempSync(path.join('/tmp', 'project-file-download-test-'))
    ;(client.getProjectFileDownloadUrl as jest.Mock).mockResolvedValue({
      downloadUrl: 'https://example.com/signed',
    })
    mockedGet.mockResolvedValue({ data: Readable.from(['payload']) })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('取得した内容を指定先へ保存する', async () => {
    const dest = path.join(tmpDir, 'nested', 'a.txt')

    await downloadProjectFileTo(client, 'a.txt', dest)

    expect(readFileSync(dest, 'utf-8')).toBe('payload')
  })

  it('応答待ちのタイムアウトと中断シグナルを指定する', async () => {
    await downloadProjectFileTo(client, 'a.txt', path.join(tmpDir, 'a.txt'))

    const options = mockedGet.mock.calls[0][1]
    expect(options?.timeout).toBeGreaterThan(0)
    expect(options?.signal).toBeDefined()
  })

  it('受信が止まったまま無通信が続くと中断する', async () => {
    jest.useFakeTimers()
    try {
      // 何も流さないストリーム（接続はできたが以降データが来ない状態）
      const stalled = new Readable({ read() {} })
      let aborted = false
      mockedGet.mockImplementation(async (_url, config) => {
        config?.signal?.addEventListener?.('abort', () => {
          aborted = true
          stalled.destroy(new Error('aborted'))
        })
        return { data: stalled }
      })

      const promise = downloadProjectFileTo(
        client,
        'a.txt',
        path.join(tmpDir, 'stalled.txt'),
      )
      const assertion = expect(promise).rejects.toThrow()

      await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
      await assertion

      expect(aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('署名付き URL をログへ出さない', async () => {
    const logs: string[] = []
    const spy = jest
      .spyOn(console, 'log')
      .mockImplementation((...args) => logs.push(args.join(' ')))

    try {
      await downloadProjectFileTo(client, 'a.txt', path.join(tmpDir, 'a.txt'))
      expect(logs.join('\n')).not.toContain('https://example.com/signed')
    } finally {
      spy.mockRestore()
    }
  })
})
