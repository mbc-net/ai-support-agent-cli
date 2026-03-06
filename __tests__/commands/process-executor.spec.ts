import { processKill, processList } from '../../src/commands/process-executor'
import * as shellExecutor from '../../src/commands/shell-executor'
import type { CommandResult } from '../../src/types'

function expectFailure(result: CommandResult): asserts result is { success: false; error: string; data?: unknown } {
  expect(result.success).toBe(false)
}

describe('process-executor', () => {
  describe('processList', () => {
    it('should list processes', async () => {
      const result = await processList()
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
    })

    it('should truncate output exceeding 50KB', async () => {
      const header = 'USER PID %CPU %MEM COMMAND'
      const line = 'user 12345 0.0 0.1 some-process'
      // 50KB超のデータを生成
      const lines = [header, ...Array(3000).fill(line)]
      const largeOutput = lines.join('\n')
      expect(largeOutput.length).toBeGreaterThan(50000)

      jest.spyOn(shellExecutor, 'executeShellCommand').mockResolvedValue({
        success: true,
        data: largeOutput,
      })

      const result = await processList()
      expect(result.success).toBe(true)
      expect(typeof result.data).toBe('string')
      expect((result.data as string).length).toBeLessThanOrEqual(51000) // header + truncation message
      expect(result.data).toContain(header)
      expect(result.data).toContain('more processes truncated')

      jest.restoreAllMocks()
    })

    it('should not truncate output under 50KB', async () => {
      const smallOutput = 'USER PID COMMAND\nuser 1 init\nuser 2 bash'
      jest.spyOn(shellExecutor, 'executeShellCommand').mockResolvedValue({
        success: true,
        data: smallOutput,
      })

      const result = await processList()
      expect(result.success).toBe(true)
      expect(result.data).toBe(smallOutput)

      jest.restoreAllMocks()
    })
  })

  describe('processKill', () => {
    it('should return error when no PID specified', async () => {
      const result = await processKill({})
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should reject negative PID', async () => {
      const result = await processKill({ pid: -1 })
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should send signal to existing process', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true)

      const result = await processKill({ pid: 12345 })
      expect(result.success).toBe(true)
      expect(result.data).toBe('Sent SIGTERM to PID 12345')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')

      killSpy.mockRestore()
    })

    it('should block SIGKILL signal', async () => {
      const result = await processKill({ pid: 12345, signal: 'SIGKILL' })
      expectFailure(result)
      expect(result.error).toContain('Signal not allowed: SIGKILL')
    })

    it('should send SIGUSR1 signal when specified', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true)

      const result = await processKill({ pid: 12345, signal: 'SIGUSR1' })
      expect(result.success).toBe(true)
      expect(result.data).toBe('Sent SIGUSR1 to PID 12345')

      killSpy.mockRestore()
    })
  })
})
