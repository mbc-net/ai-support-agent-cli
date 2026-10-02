import { logger } from '../../src/logger'
import { createClosedSignal } from '../../src/utils/closed-signal'

/**
 * 「一度だけ閉じ、後から登録したリスナーにも通知する」の共通実装。
 *
 * 後から登録したリスナーを取りこぼすと、トンネルが先に切れていた場合に
 * セッションが閉じずに残る（レビュー指摘 HIGH の再発防止）。
 */
describe('createClosedSignal', () => {
  it('★ 最初の close だけが効き、理由を保持する', () => {
    const signal = createClosedSignal()
    expect(signal.isClosed).toBe(false)
    expect(signal.reason).toBeNull()
    expect(signal.close('first')).toBe(true)
    expect(signal.close('second')).toBe(false)
    expect(signal.isClosed).toBe(true)
    expect(signal.reason).toBe('first')
  })

  it('登録済みのリスナーへ close のその場で 1 回だけ通知する', () => {
    const signal = createClosedSignal()
    const seen: string[] = []
    signal.onClosed((r) => seen.push(`a:${r}`))
    signal.onClosed((r) => seen.push(`b:${r}`))
    signal.close('gone')
    signal.close('again')
    expect(seen).toEqual(['a:gone', 'b:gone'])
  })

  it('★ リスナーが投げても残りのリスナーを呼び、例外はログに出す', () => {
    const signal = createClosedSignal()
    const seen: string[] = []
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    signal.onClosed(() => {
      throw new Error('listener boom')
    })
    signal.onClosed((r) => seen.push(r))
    expect(() => signal.close('gone')).not.toThrow()
    expect(seen).toEqual(['gone'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/listener boom/))
    warn.mockRestore()
  })

  it('閉じた後に登録したリスナーが投げても、ログに出して握る', async () => {
    const signal = createClosedSignal()
    signal.close('gone')
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    signal.onClosed(() => {
      throw new Error('late boom')
    })
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/late boom/))
    warn.mockRestore()
  })

  it('★ 閉じた後に登録したリスナーにも、非同期（microtask）で通知する', async () => {
    const signal = createClosedSignal()
    signal.close('gone')
    const seen: string[] = []
    signal.onClosed((r) => seen.push(r))
    // 登録した呼び出しの中で同期的には呼ばない（呼び出し側の状態が整う前に
    // 再入させないため）
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual(['gone'])
  })
})
