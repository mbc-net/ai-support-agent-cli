import { executeCommand } from '../src/commands'
import { logger } from '../src/logger'

jest.mock('../src/commands/file-executor', () => ({
  fileRead: jest.fn().mockResolvedValue({ success: true }),
  fileWrite: jest.fn().mockResolvedValue({ success: true }),
  fileList: jest.fn().mockResolvedValue({ success: true }),
  fileRename: jest.fn().mockResolvedValue({ success: true }),
  fileDelete: jest.fn().mockResolvedValue({ success: true }),
  fileMkdir: jest.fn().mockResolvedValue({ success: true }),
}))
jest.mock('../src/commands/process-executor', () => ({
  processList: jest.fn().mockResolvedValue({ success: true }),
  processKill: jest.fn().mockResolvedValue({ success: true }),
}))

/**
 * payload のデバッグログは、**ラベルがコマンド種別と一致していないと意味を成さない**。
 *
 * 以前は各ハンドラが `logger.debug(`[file_read] path=...`)` と自前で出しており、
 * コピー&ペーストでラベルを直し忘れても型チェックもテストも通った。障害調査の
 * ときに別のコマンドの名前が付いたログを読むことになる。
 *
 * 現在はディスパッチが受け取った `type` からラベルを作るので取り違えようがない。
 * ここではその性質と、出力する項目を固定する。
 */
describe('payload のデバッグログ', () => {
  let debugSpy: jest.SpyInstance

  beforeEach(() => {
    debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => {
    debugSpy.mockRestore()
  })

  /** そのコマンドで出た `[<type>] ...` 行を返す */
  const payloadLogFor = (type: string): string | undefined =>
    debugSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith(`[${type}] `))

  it.each([
    ['file_read', { path: '/tmp/a.txt' }, 'path="/tmp/a.txt"'],
    ['file_write', { path: '/tmp/b.txt' }, 'path="/tmp/b.txt"'],
    ['file_list', { path: '/tmp' }, 'path="/tmp"'],
    ['file_delete', { path: '/tmp/c.txt' }, 'path="/tmp/c.txt"'],
    ['file_mkdir', { path: '/tmp/d' }, 'path="/tmp/d"'],
    ['process_kill', { pid: 4242 }, 'pid="4242"'],
  ])('%s のラベルは種別と一致し、項目を出す', async (type, payload, expected) => {
    await executeCommand(type as never, payload)

    expect(payloadLogFor(type)).toBe(`[${type}] ${expected}`)
  })

  it('file_rename は 2 項目を出す', async () => {
    await executeCommand('file_rename' as never, {
      oldPath: '/tmp/old',
      newPath: '/tmp/new',
    })

    expect(payloadLogFor('file_rename')).toBe(
      '[file_rename] oldPath="/tmp/old" newPath="/tmp/new"',
    )
  })

  it('値が無い項目は空文字にする（undefined を出さない）', async () => {
    await executeCommand('file_read' as never, {})

    expect(payloadLogFor('file_read')).toBe('[file_read] path=""')
  })

  /**
   * 表に載っていないコマンドでは payload ログを出さない。出すと、意図せず
   * 秘匿値（トークン等）がログへ流れる恐れがある。
   */
  it('表に無いコマンドでは payload ログを出さない', async () => {
    await executeCommand('process_list' as never, { secret: 'do-not-log' })

    expect(payloadLogFor('process_list')).toBeUndefined()
    expect(
      debugSpy.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toContain('do-not-log')
  })
})
