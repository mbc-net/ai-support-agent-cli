import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

import axios from 'axios'
import { Readable } from 'stream'

import type { ApiClient } from '../../src/api-client'
import {
  SHARED_FILE_MAX_FILE_BYTES,
  SHARED_FILE_MAX_TOTAL_BYTES,
  SHARED_FILE_STAGING_DIR_VAR,
  collectSharedFileSources,
  stageSharedFiles,
} from '../../src/server-setup/shared-file-staging'

jest.mock('axios')
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockedAxios = axios as jest.Mocked<typeof axios>

describe('collectSharedFileSources', () => {
  const includeRole = (name: string, vars?: Record<string, unknown>) => ({
    name: 'task',
    'ansible.builtin.include_role': { name },
    ...(vars ? { vars } : {}),
  })

  it('shared_file ロールの shared_file_src を集める', () => {
    expect(
      collectSharedFileSources([
        includeRole('shared_file', { shared_file_src: 'certs/server.pem' }),
      ]),
    ).toEqual(['certs/server.pem'])
  })

  it('短縮形の include_role でも集める', () => {
    expect(
      collectSharedFileSources([
        {
          name: 'task',
          include_role: { name: 'shared_file' },
          vars: { shared_file_src: 'a.txt' },
        },
      ]),
    ).toEqual(['a.txt'])
  })

  it('他のロールは対象外', () => {
    expect(
      collectSharedFileSources([
        includeRole('docker', { shared_file_src: 'a.txt' }),
      ]),
    ).toEqual([])
  })

  it('block / rescue / always の入れ子も走査する', () => {
    const tasks = [
      {
        block: [includeRole('shared_file', { shared_file_src: 'in-block.txt' })],
        rescue: [
          includeRole('shared_file', { shared_file_src: 'in-rescue.txt' }),
        ],
        always: [
          includeRole('shared_file', { shared_file_src: 'in-always.txt' }),
        ],
      },
    ]
    expect(collectSharedFileSources(tasks)).toEqual([
      'in-block.txt',
      'in-rescue.txt',
      'in-always.txt',
    ])
  })

  it('重複は1つにまとめる', () => {
    expect(
      collectSharedFileSources([
        includeRole('shared_file', { shared_file_src: 'a.txt' }),
        includeRole('shared_file', { shared_file_src: 'a.txt' }),
      ]),
    ).toEqual(['a.txt'])
  })

  it('前後の空白を落とし、末尾スラッシュを正規化する', () => {
    expect(
      collectSharedFileSources([
        includeRole('shared_file', { shared_file_src: '  certs/  ' }),
      ]),
    ).toEqual(['certs'])
  })

  it('src が無い・文字列でないタスクは無視する（ガードが別途拒否する）', () => {
    expect(
      collectSharedFileSources([
        includeRole('shared_file'),
        includeRole('shared_file', { shared_file_src: 123 }),
      ]),
    ).toEqual([])
  })

  it('タスクでない要素が混ざっても落ちない', () => {
    expect(collectSharedFileSources([null as never, 'x' as never])).toEqual([])
  })
})

describe('stageSharedFiles', () => {
  let stagingDir: string

  const entry = (
    over: Partial<{ name: string; path: string; type: 'file' | 'directory'; size: number }>,
  ) => ({
    id: 'id',
    name: over.name ?? 'f.txt',
    path: over.path ?? 'f.txt',
    type: over.type ?? ('file' as const),
    size: over.size ?? 10,
    modified: '2026-01-01T00:00:00Z',
  })

  function makeClient(
    listings: Record<string, ReturnType<typeof entry>[]>,
    opts?: { truncatedAt?: string },
  ): ApiClient {
    return {
      listProjectFiles: jest.fn().mockImplementation((p?: string) => {
        const key = p ?? ''
        return Promise.resolve({
          entries: listings[key] ?? [],
          truncated: opts?.truncatedAt === key,
          limit: 1000,
        })
      }),
      getProjectFileDownloadUrl: jest.fn().mockImplementation((p: string) =>
        Promise.resolve({
          downloadUrl: `https://example.com/${encodeURIComponent(p)}`,
          filename: p.split('/').pop() ?? p,
          contentType: 'application/octet-stream',
        }),
      ),
    } as unknown as ApiClient
  }

  beforeEach(() => {
    jest.clearAllMocks()
    stagingDir = mkdtempSync(path.join(tmpdir(), 'shared-file-staging-test-'))
    mockedAxios.get.mockImplementation(() =>
      Promise.resolve({ data: Readable.from([Buffer.from('hello')]) }),
    )
  })

  afterEach(() => {
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('単一ファイルを共有フォルダのパスと同じ相対位置へ保存する', async () => {
    const client = makeClient({
      certs: [entry({ name: 'server.pem', path: 'certs/server.pem' })],
    })

    await stageSharedFiles({
      client,
      sources: ['certs/server.pem'],
      stagingDir,
    })

    const staged = path.join(stagingDir, 'certs', 'server.pem')
    expect(readFileSync(staged, 'utf8')).toBe('hello')
  })

  it('保存したファイルは 0600（他ユーザーから読めない）', async () => {
    const client = makeClient({
      '': [entry({ name: 'a.txt', path: 'a.txt' })],
    })

    await stageSharedFiles({ client, sources: ['a.txt'], stagingDir })

    const mode = statSync(path.join(stagingDir, 'a.txt')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('フォルダ指定では配下を再帰的に保存する', async () => {
    const client = makeClient({
      '': [entry({ name: 'certs', path: 'certs', type: 'directory', size: 0 })],
      certs: [
        entry({ name: 'server.pem', path: 'certs/server.pem' }),
        entry({ name: 'sub', path: 'certs/sub', type: 'directory', size: 0 }),
      ],
      'certs/sub': [entry({ name: 'ca.pem', path: 'certs/sub/ca.pem' })],
    })

    await stageSharedFiles({ client, sources: ['certs'], stagingDir })

    expect(readFileSync(path.join(stagingDir, 'certs', 'server.pem'), 'utf8')).toBe(
      'hello',
    )
    expect(
      readFileSync(path.join(stagingDir, 'certs', 'sub', 'ca.pem'), 'utf8'),
    ).toBe('hello')
  })

  it('存在しないパスは、共有ファイル側の問題と分かるエラーにする', async () => {
    const client = makeClient({ '': [] })

    await expect(
      stageSharedFiles({ client, sources: ['missing.txt'], stagingDir }),
    ).rejects.toThrow(/missing\.txt/)
  })

  it('一覧が打ち切られていたら失敗させる（黙って取りこぼさない）', async () => {
    const client = makeClient(
      {
        '': [entry({ name: 'certs', path: 'certs', type: 'directory', size: 0 })],
        certs: [entry({ name: 'a.pem', path: 'certs/a.pem' })],
      },
      { truncatedAt: 'certs' },
    )

    await expect(
      stageSharedFiles({ client, sources: ['certs'], stagingDir }),
    ).rejects.toThrow(/truncated|打ち切/i)
  })

  it('1ファイルの上限を超えたら、ダウンロードせずに失敗させる', async () => {
    const client = makeClient({
      '': [
        entry({
          name: 'big.bin',
          path: 'big.bin',
          size: SHARED_FILE_MAX_FILE_BYTES + 1,
        }),
      ],
    })

    await expect(
      stageSharedFiles({ client, sources: ['big.bin'], stagingDir }),
    ).rejects.toThrow(/too large|上限/i)
    expect(mockedAxios.get).not.toHaveBeenCalled()
  })

  it('合計サイズの上限を超えたら、ダウンロードせずに失敗させる', async () => {
    // 1ファイル上限には掛からないサイズを並べて、合計だけが上限を超える状況を作る
    // （1ファイル上限で先に落ちてしまうと、合計判定を検証したことにならない）。
    const each = Math.floor(SHARED_FILE_MAX_FILE_BYTES * 0.8)
    const count = Math.ceil(SHARED_FILE_MAX_TOTAL_BYTES / each) + 1
    const names = Array.from({ length: count }, (_, i) => `f${i}.bin`)
    const client = makeClient({
      '': names.map((name) => entry({ name, path: name, size: each })),
    })

    expect(each).toBeLessThanOrEqual(SHARED_FILE_MAX_FILE_BYTES)
    await expect(
      stageSharedFiles({ client, sources: names, stagingDir }),
    ).rejects.toThrow(/total|合計/i)
    expect(mockedAxios.get).not.toHaveBeenCalled()
  })

  it('サーバー応答のパスがステージング外を指していたら保存しない（多層防御）', async () => {
    // path は API 側で検証済み（assertSafeProjectFilePath）だが、保存先の組み立ては
    // こちらの責務である。正当なフォルダを指定したのに、その配下として返ってきた
    // エントリが脱出するパスを持つ——という応答の破損・改変を想定する。
    const client = makeClient({
      '': [entry({ name: 'certs', path: 'certs', type: 'directory', size: 0 })],
      certs: [entry({ name: 'evil', path: '../../etc/evil', size: 10 })],
    })

    await expect(
      stageSharedFiles({ client, sources: ['certs'], stagingDir }),
    ).rejects.toThrow(/outside|ステージング/i)
    // 1件でも外を指したら、他のファイルも含めて一切書かない。
    expect(mockedAxios.get).not.toHaveBeenCalled()
  })

  it('ダウンロードはストリームで受け取る（メモリに載せない）', async () => {
    const client = makeClient({ '': [entry({ name: 'a.txt', path: 'a.txt' })] })

    await stageSharedFiles({ client, sources: ['a.txt'], stagingDir })

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ responseType: 'stream' }),
    )
  })

  it('署名付き URL はログに出さない', async () => {
    const { logger } = jest.requireMock('../../src/logger') as {
      logger: Record<string, jest.Mock>
    }
    const client = makeClient({ '': [entry({ name: 'a.txt', path: 'a.txt' })] })

    await stageSharedFiles({ client, sources: ['a.txt'], stagingDir })

    const logged = Object.values(logger)
      .flatMap((fn) => fn.mock.calls)
      .map((args) => args.join(' '))
      .join('\n')
    expect(logged).not.toContain('https://example.com/')
  })

  it('何も指定されていなければ API を呼ばない', async () => {
    const client = makeClient({})

    await stageSharedFiles({ client, sources: [], stagingDir })

    expect(client.listProjectFiles).not.toHaveBeenCalled()
  })
})

describe('定数', () => {
  it('ステージングディレクトリの extra-var 名はロールの既定値と同じ', () => {
    expect(SHARED_FILE_STAGING_DIR_VAR).toBe('shared_file_staging_dir')
  })

  it('上限は 1ファイル 500MiB / 合計 1GiB', () => {
    expect(SHARED_FILE_MAX_FILE_BYTES).toBe(500 * 1024 * 1024)
    expect(SHARED_FILE_MAX_TOTAL_BYTES).toBe(1024 * 1024 * 1024)
  })
})
