import { spawn } from 'child_process'

import {
  killTrackedChildProcesses,
  trackChildProcess,
  trackedChildProcessCount,
} from '../../src/utils/child-process-reaper'

/**
 * エージェントが終わっても子プロセス（tailscaled・tailscale nc・SSM の
 * session-manager-plugin）を残さない。
 *
 * detached にしていないので同じプロセスグループにいるが、それだけでは親の
 * 終了で子は終わらない（孤児として再親付けされる）。プロセスの `exit` で
 * 追跡中の子へ SIGKILL を送る。
 */
describe('child-process-reaper（実プロセス）', () => {
  it('★ 追跡中の子を kill し、終了したら追跡から外す', async () => {
    const before = trackedChildProcessCount()
    const child = trackChildProcess(spawn('sleep', ['30']))
    expect(trackedChildProcessCount()).toBe(before + 1)
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    )
    killTrackedChildProcesses()
    await expect(exited).resolves.toBe('SIGKILL')
    expect(trackedChildProcessCount()).toBe(before)
  })

  it('自然に終わった子は追跡から外れる', async () => {
    const before = trackedChildProcessCount()
    const child = trackChildProcess(spawn('true'))
    await new Promise((resolve) => child.once('exit', resolve))
    expect(trackedChildProcessCount()).toBe(before)
  })

  it('起動に失敗した子（pid なし）は追跡しない', async () => {
    const before = trackedChildProcessCount()
    const child = trackChildProcess(spawn('/nonexistent/ais-no-such-binary'))
    await new Promise((resolve) => child.once('error', resolve))
    expect(trackedChildProcessCount()).toBe(before)
  })

  it('★ プロセスの exit フックは 1 回だけ登録する', () => {
    const before = process.listeners('exit').length
    trackChildProcess(spawn('true'))
    trackChildProcess(spawn('true'))
    expect(process.listeners('exit').length - before).toBeLessThanOrEqual(1)
    killTrackedChildProcesses()
  })

  it('既に終わった子への kill が投げても他の子の kill を続ける', () => {
    const throwing = { pid: 1, once: jest.fn(), kill: jest.fn(() => { throw new Error('ESRCH') }) }
    const ok = { pid: 2, once: jest.fn(), kill: jest.fn() }
    trackChildProcess(throwing as never)
    trackChildProcess(ok as never)
    expect(() => killTrackedChildProcesses()).not.toThrow()
    expect(ok.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
