import { killWithEscalation, scheduleForceKill } from '../../src/commands/cli-process-kill'
import { CHAT_SIGKILL_DELAY } from '../../src/constants'
import { createMockChildProcess } from '../helpers/mock-factory'

jest.mock('../../src/logger')

describe('cli-process-kill', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('scheduleForceKill', () => {
    it('sends SIGKILL after the delay when the process is still running', () => {
      const child = createMockChildProcess()
      scheduleForceKill(child, 'claude')
      expect(child.kill).not.toHaveBeenCalled()
      jest.advanceTimersByTime(CHAT_SIGKILL_DELAY)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('does not send SIGKILL when the process already exited', () => {
      const child = createMockChildProcess()
      scheduleForceKill(child, 'codex')
      child.killed = true
      jest.advanceTimersByTime(CHAT_SIGKILL_DELAY)
      expect(child.kill).not.toHaveBeenCalled()
    })
  })

  describe('killWithEscalation', () => {
    it('sends SIGTERM immediately and SIGKILL after the delay if still running', () => {
      const child = createMockChildProcess()
      killWithEscalation(child, 'claude')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      jest.advanceTimersByTime(CHAT_SIGKILL_DELAY)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(child.kill).toHaveBeenCalledTimes(2)
    })

    it('skips SIGKILL when the process exits before the delay elapses', () => {
      const child = createMockChildProcess()
      killWithEscalation(child, 'codex')
      child.killed = true
      jest.advanceTimersByTime(CHAT_SIGKILL_DELAY)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    })
  })
})
