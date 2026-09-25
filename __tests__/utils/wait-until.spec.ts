import { waitUntil, withTimeout } from '../../src/utils/wait-until'

describe('waitUntil', () => {
  it('条件が満たされたら解決する', async () => {
    let n = 0
    await expect(
      waitUntil(async () => ++n >= 3, { timeoutMs: 1_000, intervalMs: 1, timeoutMessage: 't' }),
    ).resolves.toBeUndefined()
    expect(n).toBe(3)
  })

  it('★ 相手が死んだら待たずに失敗する', async () => {
    await expect(
      waitUntil(() => false, {
        timeoutMs: 10_000,
        intervalMs: 1,
        isAlive: () => false,
        deadMessage: 'daemon died',
        timeoutMessage: 't',
      }),
    ).rejects.toThrow('daemon died')
  })

  it('期限切れで失敗する', async () => {
    await expect(
      waitUntil(() => false, { timeoutMs: 20, intervalMs: 5, timeoutMessage: 'too slow' }),
    ).rejects.toThrow('too slow')
  })

  it('deadMessage の既定値', async () => {
    await expect(
      waitUntil(() => false, { timeoutMs: 1_000, intervalMs: 1, isAlive: () => false, timeoutMessage: 't' }),
    ).rejects.toThrow('the process exited before it was ready')
  })
})

describe('withTimeout', () => {
  it('期限内なら結果をそのまま返す', async () => {
    await expect(withTimeout(Promise.resolve(5), 1_000, 'late')).resolves.toBe(5)
  })

  it('期限内の失敗はそのまま返す', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'late')).rejects.toThrow('boom')
  })

  it('★ 期限切れで失敗し、後から届いた結果は onLate に渡す（取りこぼさず片付けられる）', async () => {
    let resolveLate: (v: string) => void = () => undefined
    const late = new Promise<string>((r) => {
      resolveLate = r
    })
    const onLate = jest.fn()
    await expect(withTimeout(late, 10, 'timed out', onLate)).rejects.toThrow('timed out')
    resolveLate('stream')
    await new Promise((r) => setImmediate(r))
    expect(onLate).toHaveBeenCalledWith('stream')
  })

  it('期限切れの後の失敗は握り潰す（unhandled にしない）', async () => {
    let rejectLate: (e: Error) => void = () => undefined
    const late = new Promise<string>((_r, j) => {
      rejectLate = j
    })
    await expect(withTimeout(late, 10, 'timed out')).rejects.toThrow('timed out')
    rejectLate(new Error('after'))
    await new Promise((r) => setImmediate(r))
  })
})
