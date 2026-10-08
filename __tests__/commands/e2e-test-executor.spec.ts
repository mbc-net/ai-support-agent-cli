import { executeE2eTest, type ExecuteE2eTestOptions } from '../../src/commands/e2e-test-executor'
import * as chatExecutor from '../../src/commands/chat-executor'
import * as playwrightTestRunner from '../../src/browser/playwright-test-runner'
import type { PlaywrightRunnerResult } from '../../src/browser/playwright-test-runner'
import * as browserScriptExecutor from '../../src/browser/browser-script-executor'
import * as playwrightSubprocessExecutor from '../../src/browser/playwright-subprocess-executor'
import { logger } from '../../src/logger'
import { AxiosError, AxiosHeaders } from 'axios'

// Mock the chat executor
jest.mock('../../src/commands/chat-executor', () => ({
  executeChatCommand: jest.fn(),
}))

// Mock the playwright test runner
jest.mock('../../src/browser/playwright-test-runner', () => ({
  runPlaywrightScript: jest.fn(),
}))

// Mock the playwright subprocess executor
jest.mock('../../src/browser/playwright-subprocess-executor', () => ({
  runPlaywrightSubprocess: jest.fn(),
}))

// Mock the browser script executor (legacy API, kept for assertion coverage)
jest.mock('../../src/browser/browser-script-executor', () => ({
  executePlaywrightScript: jest.fn(),
}))

const mockClient = {
  updateE2eExecutionStatus: jest.fn(),
  reportE2eTestStep: jest.fn(),
  getE2eEnvironmentVariables: jest.fn(),
  getE2eSupportFiles: jest.fn(),
} as any

describe('e2e-test-executor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default: no shared support files registered for the project
    mockClient.getE2eSupportFiles.mockResolvedValue([])
  })

  const baseOptions: ExecuteE2eTestOptions = {
    payload: {
      executionId: 'exec-1',
      testCaseId: 'tc-1',
      scenario: 'Open login page and verify title',
      targetUrl: 'https://example.com/login',
      executionMethod: 'ai',
    },
    commandId: 'cmd-1',
    client: mockClient,
    agentId: 'agent-1',
    tenantCode: 'mbc',
    // The agent's own project (transport deps / oneshot env) — the value
    // e2e_test persists under. projectConfig is config-synced and only used
    // for chat context.
    projectCode: 'MBC_01',
    projectConfig: {
      project: { projectCode: 'MBC_01' },
    } as any,
  }

  it('should return error if executionId is missing', async () => {
    const options = {
      ...baseOptions,
      payload: { ...baseOptions.payload, executionId: undefined },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('executionId is required')
    }
  })

  it('should return error if scenario is missing', async () => {
    const options = {
      ...baseOptions,
      payload: { ...baseOptions.payload, scenario: undefined },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('scenario is required')
    }
  })

  it('should return error if agentId is missing', async () => {
    const options = { ...baseOptions, agentId: undefined }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('agentId is required')
    }
  })

  it('should report running status and execute chat command', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Test completed',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const result = await executeE2eTest(baseOptions)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'passed',
        }),
      )
    }

    // Should report running status first
    expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({ status: 'running' }),
    )

    // Should report final passed status
    expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({ status: 'passed' }),
    )

    // Should call chat executor with scenario
    expect(chatExecutor.executeChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'cmd-1',
        agentId: 'agent-1',
      }),
    )
  })

  it('should report failed status when chat command fails', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Chat failed',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const result = await executeE2eTest(baseOptions)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'failed',
        }),
      )
    }
  })

  it('should report error status when chat command throws', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue(
      new Error('Unexpected error'),
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const result = await executeE2eTest(baseOptions)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Unexpected error')
    }

    expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        status: 'error',
        errorMessage: 'Unexpected error',
      }),
    )
  })

  it('should include targetUrl in system prompt', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(baseOptions)

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.payload.message).toContain('https://example.com/login')
    expect(chatCall.payload.message).toContain('browser_navigate')
  })

  it('should pass availableChatModes through to executeChatCommand', async () => {
    const availableChatModes = ['claude_code', 'codex'] as any
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest({
      ...baseOptions,
      availableChatModes,
    })

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.availableChatModes).toBe(availableChatModes)
  })

  it('should include credentialId in system prompt when provided', async () => {
    const options = {
      ...baseOptions,
      payload: { ...baseOptions.payload, credentialId: 'cred-1' },
    }
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(options)

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.payload.message).toContain('cred-1')
    expect(chatCall.payload.message).toContain('browser_login')
  })

  it('should handle status report failure gracefully (running)', async () => {
    mockClient.updateE2eExecutionStatus.mockRejectedValueOnce(new Error('Network error'))
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    // Second call (final status) succeeds
    mockClient.updateE2eExecutionStatus.mockResolvedValueOnce(undefined)

    const result = await executeE2eTest(baseOptions)

    // Should still succeed despite status report failure
    expect(result.success).toBe(true)
  })

  it('should handle final status report failure gracefully', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValueOnce(undefined) // running
    mockClient.updateE2eExecutionStatus.mockRejectedValueOnce(new Error('Network error')) // final

    const result = await executeE2eTest(baseOptions)

    expect(result.success).toBe(true)
  })

  it('should handle API error in reportExecutionStatus (inner catch)', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    // Running status: succeeds at outer level but fails at inner API call
    mockClient.updateE2eExecutionStatus.mockResolvedValueOnce(undefined)
    mockClient.updateE2eExecutionStatus.mockResolvedValueOnce(undefined)

    const result = await executeE2eTest(baseOptions)
    expect(result.success).toBe(true)
  })

  it('logs a status-report failure loudly (error level with executionId) instead of swallowing it', async () => {
    // Hardening for the silent-failure class behind the totalSteps=0 bug: a
    // non-retryable 4xx from a DTO whitelist/validation mismatch must not be
    // swallowed as a warning. It has to surface at error level with the
    // execution's identity so the failed report is detectable.
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
    mockClient.updateE2eExecutionStatus.mockResolvedValueOnce(undefined) // running
    mockClient.updateE2eExecutionStatus.mockRejectedValueOnce(
      new Error('Request failed with status code 400'),
    ) // final report fails

    const result = await executeE2eTest(baseOptions)

    // The command itself still completes gracefully (no throw).
    expect(result.success).toBe(true)
    // ...but the reporting failure is loud, not silent.
    const loudCall = errorSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('Failed to report execution status') &&
        c[0].includes('exec-1'),
    )
    expect(loudCall).toBeDefined()
    errorSpy.mockRestore()
  })

  it('should default executionMethod to ai when not specified', async () => {
    const options = {
      ...baseOptions,
      payload: { ...baseOptions.payload, executionMethod: undefined },
    }
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
  })

  it('should not include targetUrl in prompt when not provided', async () => {
    const options = {
      ...baseOptions,
      payload: { ...baseOptions.payload, targetUrl: undefined },
    }
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(options)

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.payload.message).not.toContain('browser_navigate')
  })

  it('should not include credentialId in prompt when not provided', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(baseOptions)

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.payload.message).not.toContain('browser_login')
  })

  it('should pass error from failed result to status report', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Assertion failed: expected "Dashboard"',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(baseOptions)

    // Final status should include error message
    const finalCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(finalCall).toBeDefined()
    expect(finalCall![3]).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Assertion failed: expected "Dashboard"',
      }),
    )
  })

  it('should handle API update failure in reportExecutionStatus', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    // Make the inner API call throw
    mockClient.updateE2eExecutionStatus.mockRejectedValue(new Error('API Error'))

    // Should not throw - reportExecutionStatus catches internally
    const result = await executeE2eTest(baseOptions)
    expect(result.success).toBe(true)
  })

  // --- Script execution mode tests ---

  it('should use script mode when playwrightScript is provided and executionMethod is not ai', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: true,
      passed: 2,
      failed: 0,
      skipped: 0,
      totalSteps: 2,
      results: [],
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "const { test } = require('@playwright/test'); test('t', async ({ page }) => { await page.goto('/') })",
        executionMethod: 'script',
      },
    }

    const result = await executeE2eTest(options)

    expect(playwrightTestRunner.runPlaywrightScript).toHaveBeenCalled()
    expect(chatExecutor.executeChatCommand).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'passed',
          passed: 2,
        }),
      )
    }
  })

  it('should report passed status when all playwright tests pass', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: true,
      passed: 3,
      failed: 0,
      skipped: 0,
      totalSteps: 3,
      results: [],
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
    }

    await executeE2eTest(options)

    const passedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'passed',
    )
    expect(passedCall).toBeDefined()
    expect(passedCall![3]).toEqual(
      expect.objectContaining({
        status: 'passed',
        passedSteps: 3,
        totalSteps: 3,
      }),
    )
  })

  it('should report failed status when playwright tests fail', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: false,
      passed: 1,
      failed: 2,
      skipped: 0,
      totalSteps: 3,
      results: [],
      errorOutput: 'Test failed: assertion error',
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          status: 'failed',
          failed: 2,
        }),
      )
    }

    const failedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(failedCall).toBeDefined()
    expect(failedCall![3]).toEqual(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Test failed: assertion error',
        failedSteps: 2,
      }),
    )
  })

  it('should use fallback error message when errorOutput is not present', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: false,
      passed: 0,
      failed: 1,
      skipped: 0,
      totalSteps: 1,
      results: [],
      // no errorOutput
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
    }

    await executeE2eTest(options)

    const failedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(failedCall![3]).toEqual(
      expect.objectContaining({
        errorMessage: '1 test(s) failed',
      }),
    )
  })

  it('should use AI mode when executionMethod is ai even with playwrightScript', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "const { test } = require('@playwright/test'); test('t', async ({ page }) => {})",
        executionMethod: 'ai',
        steps: [{ action: 'Open login page', expected: 'Login page is visible' }],
      },
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(playwrightTestRunner.runPlaywrightScript).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should use AI mode with a Playwright script even when no step definitions are provided', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const playwrightScript = "const { test } = require('@playwright/test'); test('t', async ({ page }) => {})"
    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript,
        executionMethod: 'ai',
        steps: undefined,
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(chatExecutor.executeChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.stringContaining(playwrightScript),
        }),
      }),
    )
    expect(playwrightTestRunner.runPlaywrightScript).not.toHaveBeenCalled()
  })

  it('should handle script execution throwing an error', async () => {
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockRejectedValue(
      new Error('spawn ENOENT'),
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('spawn ENOENT')
    }

    const errorCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'error',
    )
    expect(errorCall).toBeDefined()
  })

  it('should pass projectDir as agentRootDir to runPlaywrightScript', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      totalSteps: 1,
      results: [],
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
      projectDir: '/custom/project/dir',
    }

    await executeE2eTest(options)

    expect(playwrightTestRunner.runPlaywrightScript).toHaveBeenCalledWith(
      'script content',
      'exec-1',
      '/custom/project/dir',
    )
  })

  it('should include totalSteps when steps are provided', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        steps: [{ action: 'click' }, { action: 'fill' }],
      },
    }

    await executeE2eTest(options)

    // Running status should include totalSteps
    const runningCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'running',
    )
    expect(runningCall![3]).toEqual(
      expect.objectContaining({ totalSteps: 2 }),
    )
  })

  it('should not include totalSteps when steps are empty', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        steps: [],
      },
    }

    await executeE2eTest(options)

    const runningCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'running',
    )
    expect(runningCall![3]).not.toHaveProperty('totalSteps')
  })

  it('should handle non-Error thrown by chat executor', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue('string-error')
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const result = await executeE2eTest(baseOptions)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('string-error')
    }
  })

  it('should handle non-Error thrown by runPlaywrightScript', async () => {
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockRejectedValue('crash')
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'script content',
        executionMethod: 'script',
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('crash')
    }
  })

  it('should handle non-Error thrown by updateE2eExecutionStatus', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockRejectedValue('api-crash')

    const result = await executeE2eTest(baseOptions)
    expect(result.success).toBe(true)
  })

  // --- Playwright subprocess mode tests ---

  it('should use playwright subprocess mode when executionMethod is playwright', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      steps: [
        { title: 'Login', status: 'passed', duration: 100 },
        { title: 'Checkout', status: 'passed', duration: 200 },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalled()
    expect(browserScriptExecutor.executePlaywrightScript).not.toHaveBeenCalled()
    expect(chatExecutor.executeChatCommand).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'passed',
          passedTests: 2,
          totalTests: 2,
        }),
      )
    }
  })

  it('reports aggregate step counts to the API under DTO field names (totalSteps/passedSteps/failedSteps)', async () => {
    // Regression for the "passed but totalSteps=0" defect: the subprocess mode
    // reported the aggregates as totalTests/passedTests/failedTests, but the API
    // DTO (UpdateExecutionStatusDto) whitelists only totalSteps/passedSteps/
    // failedSteps. Under ValidationPipe({whitelist:true}) the mismatched fields
    // are silently stripped, so the execution's totalSteps stayed at its
    // creation-time default of 0 even for a passed run with recorded steps.
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 5,
      passedTests: 5,
      failedTests: 0,
      steps: [
        { title: 'Step 1', status: 'passed', duration: 10 },
        { title: 'Step 2', status: 'passed', duration: 10 },
        { title: 'Step 3', status: 'passed', duration: 10 },
        { title: 'Step 4', status: 'passed', duration: 10 },
        { title: 'Step 5', status: 'passed', duration: 10 },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    // The final status report is the one carrying the aggregate counts.
    const finalCall = (mockClient.updateE2eExecutionStatus as jest.Mock).mock.calls.find(
      (c) => c[3] && (c[3].status === 'passed' || c[3].status === 'failed'),
    )
    expect(finalCall).toBeDefined()
    const payload = finalCall![3]

    expect(payload).toMatchObject({
      status: 'passed',
      totalSteps: 5,
      passedSteps: 5,
      failedSteps: 0,
    })
    // The mismatched field names must not be sent (they would be stripped by
    // the whitelist and leave totalSteps at 0).
    expect(payload).not.toHaveProperty('totalTests')
    expect(payload).not.toHaveProperty('passedTests')
    expect(payload).not.toHaveProperty('failedTests')
  })

  it('should report steps for playwright subprocess mode', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'Login step', status: 'passed', duration: 150 }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        testCaseId: 'tc-1',
        stepNumber: 1,
        action: 'Login step',
        status: 'passed',
      }),
    )
  })

  it('should forward duration, executedAt, and screenshotBase64 from playwright subprocess steps to reportE2eTestStep', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [
        {
          title: 'Login step',
          status: 'passed',
          duration: 150,
          executedAt: '2026-07-23T04:09:18.639Z',
          screenshotBase64: 'iVBORw0KG-fake-base64',
        },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        stepNumber: 1,
        action: 'Login step',
        status: 'passed',
        duration: 150,
        executedAt: '2026-07-23T04:09:18.639Z',
        screenshotBase64: 'iVBORw0KG-fake-base64',
      }),
    )
  })

  it('should omit executedAt and screenshotBase64 when a playwright subprocess step does not provide them (legacy/fallback steps)', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'Legacy flat step', status: 'passed', duration: 50 }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    const stepCall = mockClient.reportE2eTestStep.mock.calls[0][3] as Record<string, unknown>
    expect(stepCall).not.toHaveProperty('executedAt')
    expect(stepCall).not.toHaveProperty('screenshotBase64')
  })

  it('should forward skipReason from a skipped playwright subprocess step to reportE2eTestStep', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 0,
      failedTests: 0,
      steps: [
        {
          title: 'Skipped test',
          status: 'skipped',
          skipReason: 'admin creds not set',
        },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        stepNumber: 1,
        action: 'Skipped test',
        status: 'skipped',
        skipReason: 'admin creds not set',
      }),
    )
  })

  it('should omit skipReason when a playwright subprocess step does not provide it', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'Passing step', status: 'passed', duration: 50 }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    const stepCall = mockClient.reportE2eTestStep.mock.calls[0][3] as Record<string, unknown>
    expect(stepCall).not.toHaveProperty('skipReason')
  })

  it('should NOT send screenshotPath as screenshotUrl to API (local path cannot be accessed by server)', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      steps: [
        {
          title: 'Failing step',
          status: 'failed',
          error: 'Assertion failed',
          screenshotPath: '/tmp/screenshot.png',
        },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    // The local filesystem screenshotPath must not be forwarded to the API —
    // the server/browser cannot access local /tmp paths.
    const stepCall = mockClient.reportE2eTestStep.mock.calls[0][3] as Record<string, unknown>
    expect(stepCall).not.toHaveProperty('screenshotUrl')
    expect(stepCall).toEqual(
      expect.objectContaining({
        error: 'Assertion failed',
        status: 'failed',
        action: 'Failing step',
      }),
    )
  })

  it('should report failed status when playwright subprocess has failures', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      steps: [
        { title: 'Step 1', status: 'passed', duration: 100 },
        { title: 'Step 2', status: 'failed', error: 'Element not found' },
      ],
      errorOutput: 'Test failed: Element not found',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    const failedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(failedCall).toBeDefined()

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({ status: 'failed' }),
      )
    }
  })

  it('should handle playwright subprocess throwing an error', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockRejectedValue(
      new Error('Playwright timed out'),
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Playwright timed out')
    }

    expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({ status: 'error' }),
    )
  })

  it('should report partial steps and a failed (timed-out) status when the subprocess times out WITH recovered partial results', async () => {
    // Regression for the observability bug: a timeout used to be swallowed as a
    // bare "timed out" error with totalSteps=0. Now the subprocess recovers the
    // partial result.json, so the real per-test failure must be reported as a
    // step and the aggregate counts must NOT collapse to 0.
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: true,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      steps: [
        { title: 'test1 assertion', status: 'failed', error: 'expect(received).toBe(expected)', duration: 30 },
        { title: 'test2 nav', status: 'passed', duration: 40 },
      ],
      errorOutput: 'Playwright subprocess timed out after 120000ms (partial results recovered)',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    // The real failure is reported as a step (not silently dropped).
    expect(mockClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        action: 'test1 assertion',
        status: 'failed',
        error: 'expect(received).toBe(expected)',
      }),
    )

    const finalCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (c: unknown[]) => {
        const s = (c[3] as Record<string, unknown>).status
        return s === 'failed' || s === 'error'
      },
    )
    expect(finalCall).toBeDefined()
    expect(finalCall![3]).toMatchObject({
      status: 'failed',
      totalSteps: 2,
      passedSteps: 1,
      failedSteps: 1,
    })
    expect((finalCall![3] as Record<string, unknown>).totalSteps).not.toBe(0)
    expect((finalCall![3] as Record<string, unknown>).errorMessage).toMatch(/timed out/i)
    // Recovered failures are a real test outcome, but the run was cut short by
    // the timeout, so the evidence is incomplete even though every step
    // report persisted.
    expect(finalCall![3]).toMatchObject({ testOutcome: 'failed', evidenceStatus: 'incomplete' })
  })

  it('should report an error status (not failed) when the subprocess times out with NO recoverable partial results', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: true,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
      errorOutput: 'Playwright subprocess timed out after 120000ms',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    // Nothing was recovered → no per-step reports at all.
    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()

    const finalCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (c: unknown[]) => {
        const s = (c[3] as Record<string, unknown>).status
        return s === 'failed' || s === 'error'
      },
    )
    expect(finalCall).toBeDefined()
    // No partial evidence → surface as error (true failure to produce results),
    // still carrying the timeout as the cause.
    expect((finalCall![3] as Record<string, unknown>).status).toBe('error')
    // Design 9.3 row 5: no test outcome at all, evidence incomplete.
    expect(finalCall![3]).not.toHaveProperty('testOutcome')
    expect(finalCall![3]).toMatchObject({ evidenceStatus: 'incomplete' })
    expect((finalCall![3] as Record<string, unknown>).errorMessage).toMatch(/timed out/i)
  })

  it('should escalate step-report failures to error logs with step context and note them in the final errorMessage', async () => {
    // The recovered partial steps are the true cause carried to the API; if a
    // per-step report fails it must be LOUD (logger.error with identifying
    // context) and the aggregate errorMessage must flag that some recovered
    // evidence may be missing — never swallowed at warn level.
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: true,
      totalTests: 2,
      passedTests: 0,
      failedTests: 2,
      steps: [
        { title: 'test1 assertion', status: 'failed', error: 'boom1' },
        { title: 'test2 assertion', status: 'failed', error: 'boom2' },
      ],
      errorOutput: 'Playwright subprocess timed out after 120000ms (partial results recovered)',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    // First step report fails, second succeeds.
    mockClient.reportE2eTestStep
      .mockRejectedValueOnce(new Error('DDB throttled'))
      .mockResolvedValueOnce(undefined)
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    // The failed step report is logged at ERROR with identifying context.
    const stepErrLog = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('test1 assertion'))
    expect(stepErrLog).toBeDefined()
    expect(stepErrLog).toContain('exec-1')
    expect(stepErrLog).toContain('step=1')
    expect(stepErrLog).toContain('failed')
    expect(stepErrLog).toContain('DDB throttled')

    // The aggregate errorMessage flags that some recovered steps did not persist.
    const finalCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (c: unknown[]) => {
        const s = (c[3] as Record<string, unknown>).status
        return s === 'failed' || s === 'error'
      },
    )
    expect(finalCall).toBeDefined()
    expect(String((finalCall![3] as Record<string, unknown>).errorMessage)).toMatch(
      /1\/2 step report\(s\) failed to persist/,
    )
    // The original cause (the timeout note) is preserved ahead of the annotation.
    expect(String((finalCall![3] as Record<string, unknown>).errorMessage)).toMatch(/timed out/i)
    errorSpy.mockRestore()
  })

  // Design 9.3 / phase A2: a passing test whose per-step evidence failed to
  // persist must NOT be reported as "passed" (dev: 3/3 step reports rejected
  // with HTTP 413, yet the run showed "passed 3/3" with empty evidence).
  const http413 = (): AxiosError =>
    new AxiosError(
      'Request failed with status code 413',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 413,
        statusText: 'Payload Too Large',
        data: { message: 'request entity too large' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    )

  const findFinalStatusCall = (): Record<string, unknown> | undefined => {
    const call = mockClient.updateE2eExecutionStatus.mock.calls.find((c: unknown[]) =>
      ['passed', 'failed', 'error'].includes(String((c[3] as Record<string, unknown>).status)),
    )
    return call ? (call[3] as Record<string, unknown>) : undefined
  }

  const playwrightOptions = (): ExecuteE2eTestOptions => ({
    ...baseOptions,
    payload: {
      ...baseOptions.payload,
      playwrightScript: "await page.goto('/')",
      executionMethod: 'playwright',
    },
  })

  it('should report error (not passed) when the test passed but every step report failed to persist', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 3,
      passedTests: 3,
      failedTests: 0,
      steps: [
        { title: 'step A', status: 'passed', duration: 10, screenshotBase64: 'AAAA' },
        { title: 'step B', status: 'passed', duration: 10, screenshotBase64: 'BBBB' },
        { title: 'step C', status: 'passed', duration: 10, screenshotBase64: 'CCCC' },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(http413())
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    // Every step was attempted (no early abort on the first failure).
    expect(mockClient.reportE2eTestStep).toHaveBeenCalledTimes(3)

    // Exactly one final status report, and it is error — never passed.
    const finalCalls = mockClient.updateE2eExecutionStatus.mock.calls.filter((c: unknown[]) =>
      ['passed', 'failed', 'error'].includes(String((c[3] as Record<string, unknown>).status)),
    )
    expect(finalCalls).toHaveLength(1)
    const final = findFinalStatusCall()!
    expect(final.status).toBe('error')
    const msg = String(final.errorMessage)
    expect(msg).toContain('3/3 step report(s) failed to persist')
    // The first failure's reason carries the HTTP status (not just "Error").
    expect(msg).toContain('[413] request entity too large')
    // Test aggregates still reflect the test outcome itself.
    expect(final).toMatchObject({ totalSteps: 3, passedSteps: 3, failedSteps: 0 })
    // Design 9.3: status=error / testOutcome=passed / evidenceStatus=incomplete.
    expect(final).toMatchObject({ testOutcome: 'passed', evidenceStatus: 'incomplete' })

    // Each failed step report is logged at ERROR with the HTTP status.
    const stepLogs = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('Failed to report playwright step'))
    expect(stepLogs).toHaveLength(3)
    expect(stepLogs[0]).toContain('step=1')
    expect(stepLogs[0]).toContain('[413]')

    // Return value is consistent with the reported status and test counts.
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      executionId: 'exec-1',
      status: 'error',
      passedTests: 3,
      failedTests: 0,
      totalTests: 3,
    })
    errorSpy.mockRestore()
  })

  it('should report error with the partial count and FIRST failure reason when only some step reports fail on a passed test', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 3,
      passedTests: 3,
      failedTests: 0,
      steps: [
        { title: 'step A', status: 'passed' },
        { title: 'step B', status: 'passed' },
        { title: 'step C', status: 'passed' },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(http413())
      .mockRejectedValueOnce(new Error('socket hang up'))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    expect(final.status).toBe('error')
    const msg = String(final.errorMessage)
    expect(msg).toContain('2/3 step report(s) failed to persist')
    expect(msg).toContain('[413] request entity too large')
    expect(msg).not.toContain('socket hang up')
    expect(result.data).toMatchObject({ status: 'error' })
    errorSpy.mockRestore()
  })

  it('should report passed with no errorMessage when the test passed and every step report persisted', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      steps: [
        { title: 'step A', status: 'passed' },
        { title: 'step B', status: 'passed' },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    expect(mockClient.reportE2eTestStep).toHaveBeenCalledTimes(2)
    const final = findFinalStatusCall()!
    expect(final.status).toBe('passed')
    expect(final).not.toHaveProperty('errorMessage')
    expect(final).toMatchObject({ totalSteps: 2, passedSteps: 2, failedSteps: 0 })
    expect(final).toMatchObject({ testOutcome: 'passed' })
    // Never 'complete' from the agent (reserved for the API's manifest check).
    expect(final).not.toHaveProperty('evidenceStatus')
    expect(result.data).toMatchObject({ status: 'passed', passedTests: 2, totalTests: 2 })
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('should keep status failed (not error) and append the note when a failed test also has step report failures', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      steps: [
        { title: 'step A', status: 'passed' },
        { title: 'step B', status: 'failed', error: 'expect(received).toBe(expected)' },
      ],
      errorOutput: '1 failed',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(http413())
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    expect(final.status).toBe('failed')
    // Existing contract: the failure output comes first, the note is appended.
    expect(final.errorMessage).toBe(
      '1 failed (2/2 step report(s) failed to persist; first failure: [413] request entity too large)',
    )
    expect(final).toMatchObject({ testOutcome: 'failed', evidenceStatus: 'incomplete' })
    expect(final).toMatchObject({ totalSteps: 2, passedSteps: 1, failedSteps: 1 })
    expect(result.data).toMatchObject({ status: 'failed', passedTests: 1, failedTests: 1 })
    errorSpy.mockRestore()
  })

  it('should note the step-report failure count in the completion log when the status becomes error', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      steps: [
        { title: 'step A', status: 'passed' },
        { title: 'step B', status: 'passed' },
      ],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(http413())
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})

    await executeE2eTest(playwrightOptions())

    const completionLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('Playwright subprocess completed'))
    expect(completionLog).toContain('status=error')
    expect(completionLog).toContain('2/2 step report(s) failed to persist')
    errorSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('should not append a step-report note to the completion log when every step report persisted', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'step A', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})

    await executeE2eTest(playwrightOptions())

    const completionLog = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('Playwright subprocess completed'))
    expect(completionLog).toContain('status=passed')
    expect(completionLog).not.toContain('step report')
    infoSpy.mockRestore()
  })

  it('should bound the first step-report failure reason (non-Axios error) in both the log and the aggregate errorMessage', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'step A', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const hugeReason = 'x'.repeat(5000)
    mockClient.reportE2eTestStep.mockRejectedValue(new Error(hugeReason))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    expect(final.status).toBe('error')
    const msg = String(final.errorMessage)
    expect(msg).not.toContain(hugeReason)
    // Hard limit: marker included, the reason is at most 500 chars.
    expect(msg).toContain(`(first failure: ${'x'.repeat(497)}...)`)
    expect(msg).not.toContain('x'.repeat(498))
    expect(msg.length).toBeLessThan(700)
    const stepLog = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('Failed to report playwright step'))
    expect(stepLog).toBeDefined()
    expect(stepLog).toContain(`: ${'x'.repeat(497)}...`)
    expect(stepLog!.endsWith(`: ${'x'.repeat(497)}...`)).toBe(true)
    expect(stepLog).not.toContain('x'.repeat(498))
    expect(result.data).toMatchObject({ errorMessage: msg })
    errorSpy.mockRestore()
  })

  it('should bound an unbounded Playwright stderr in the status report, the returned data and the logs', async () => {
    const hugeStderr = 'E'.repeat(3 * 1024 * 1024)
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      steps: [{ title: 'step A', status: 'failed', error: 'boom' }],
      errorOutput: hugeStderr,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(http413())
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    const sent = String(final.errorMessage)
    // Only the stderr part is cut, keeping its TAIL behind a marker; the
    // step-report note survives intact and the whole stays within 4000.
    const note = ' (1/1 step report(s) failed to persist; first failure: [413] request entity too large)'
    const marker = '[...truncated] '
    expect(sent).toBe(`${marker}${'E'.repeat(4000 - note.length - marker.length)}${note}`)
    expect(sent).toHaveLength(4000)
    expect((result.data as Record<string, unknown>).errorMessage).toBe(sent)
    expect(final).toMatchObject({ status: 'failed', testOutcome: 'failed', evidenceStatus: 'incomplete' })
    const allLogs = [...errorSpy.mock.calls, ...infoSpy.mock.calls].map((c) => String(c[0]))
    expect(allLogs.every((m) => m.length < 5000)).toBe(true)
    errorSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('should keep the tail of the stderr (where the failure is) when truncating', async () => {
    const stderr = `HEAD-${'x'.repeat(10_000)}-TAIL: Error: expect(locator).toBeVisible() failed`
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      steps: [{ title: 'step A', status: 'failed', error: 'boom' }],
      errorOutput: stderr,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    await executeE2eTest(playwrightOptions())

    const sent = String(findFinalStatusCall()!.errorMessage)
    expect(sent).toHaveLength(4000)
    expect(sent.startsWith('[...truncated] ')).toBe(true)
    expect(sent).not.toContain('HEAD-')
    expect(sent.endsWith('-TAIL: Error: expect(locator).toBeVisible() failed')).toBe(true)
  })

  it('should report error with no testOutcome and evidenceStatus=incomplete when a failed run produced no test results (non-timeout)', async () => {
    // e.g. the JSON reporter output was missing/unparsable: success=false, no
    // steps, not a timeout. Nothing ran to a result → execution error.
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: false,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const result = await executeE2eTest(playwrightOptions())

    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
    const final = findFinalStatusCall()!
    expect(final.status).toBe('error')
    expect(final).not.toHaveProperty('testOutcome')
    expect(final).toMatchObject({ evidenceStatus: 'incomplete' })
    expect(final.errorMessage).toBe('Playwright subprocess produced no test results')
    expect(result.data).toMatchObject({ status: 'error' })
  })

  it('should keep the subprocess stderr as the cause when a failed run produced no test results', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
      errorOutput: 'SyntaxError: Unexpected token in spec',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    expect(final).toMatchObject({
      status: 'error',
      evidenceStatus: 'incomplete',
      errorMessage: 'SyntaxError: Unexpected token in spec',
    })
    expect(final).not.toHaveProperty('testOutcome')
  })

  it('should bound the errorMessage of script mode at the shared reporting choke point (tail kept)', async () => {
    const stderr = `HEAD-${'s'.repeat(2 * 1024 * 1024)}-TAIL`
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      passed: 0,
      failed: 1,
      totalSteps: 1,
      steps: [],
      errorOutput: stderr,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest({
      ...baseOptions,
      payload: { ...baseOptions.payload, playwrightScript: "await page.goto('/')", executionMethod: 'script' },
    })

    const sent = String(findFinalStatusCall()!.errorMessage)
    expect(sent).toHaveLength(4000)
    expect(sent.startsWith('[...truncated] ')).toBe(true)
    expect(sent.endsWith('-TAIL')).toBe(true)
  })

  it('should bound the errorMessage of AI mode at the shared reporting choke point', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: false,
      error: `HEAD-${'a'.repeat(1024 * 1024)}-TAIL`,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(baseOptions)

    const sent = String(findFinalStatusCall()!.errorMessage)
    expect(sent.length).toBeLessThanOrEqual(4000)
    expect(sent.startsWith('[...truncated] ')).toBe(true)
    expect(sent.endsWith('-TAIL')).toBe(true)
  })

  it('should run and persist under the agent\'s own projectCode even when projectConfig has not been synced', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'step A', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const result = await executeE2eTest({ ...playwrightOptions(), projectConfig: undefined })

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalled()
    expect(mockClient.reportE2eTestStep).toHaveBeenCalledWith('mbc', 'MBC_01', 'exec-1', expect.anything())
    expect(mockClient.getE2eSupportFiles).toHaveBeenCalledWith('mbc', 'MBC_01')
    expect(findFinalStatusCall()).toMatchObject({ status: 'passed' })
    expect(mockClient.updateE2eExecutionStatus.mock.calls.every((c: unknown[]) => c[1] === 'MBC_01')).toBe(true)
    expect(result).toMatchObject({ success: true, data: { status: 'passed' } })
  })

  it('should use the agent\'s own projectCode over a differing config-synced projectConfig (single source)', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'step A', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    await executeE2eTest({
      ...playwrightOptions(),
      projectConfig: { project: { projectCode: 'STALE_SYNCED' } } as any,
    })

    const usedProjects = [
      ...mockClient.updateE2eExecutionStatus.mock.calls,
      ...mockClient.reportE2eTestStep.mock.calls,
    ].map((c: unknown[]) => c[1])
    expect(usedProjects.length).toBeGreaterThan(0)
    expect(new Set(usedProjects)).toEqual(new Set(['MBC_01']))
  })

  it('should keep the leading timeout note (and the step-report note) when truncating a long stderr after a timeout', async () => {
    const timeoutNote = 'Playwright subprocess timed out after 120000ms (partial results recovered)'
    const stderr = `${timeoutNote}\nHEAD-${'t'.repeat(50_000)}-TAIL: last error line`
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: true,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      steps: [
        { title: 'step A', status: 'passed' },
        { title: 'step B', status: 'failed', error: 'boom' },
      ],
      errorOutput: stderr,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValueOnce(undefined).mockRejectedValueOnce(http413())
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    const sent = String(final.errorMessage)
    const note = ' (1/2 step report(s) failed to persist; first failure: [413] request entity too large)'
    expect(sent).toHaveLength(4000)
    // Cause first, then the truncated stderr's tail, then the step-report note.
    expect(sent.startsWith(`${timeoutNote}\n[...truncated] `)).toBe(true)
    expect(sent).not.toContain('HEAD-')
    expect(sent.endsWith(`-TAIL: last error line${note}`)).toBe(true)
    expect(final).toMatchObject({ status: 'failed', testOutcome: 'failed', evidenceStatus: 'incomplete' })
    expect((result.data as Record<string, unknown>).errorMessage).toBe(sent)
    errorSpy.mockRestore()
  })

  it('should keep every leading timeout note line (SIGKILL force-resolve) when truncating', async () => {
    const notes = [
      'Playwright subprocess timed out after 120000ms',
      'Playwright subprocess timed out after 120000ms and did not exit after SIGKILL',
    ].join('\n')
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      timedOut: true,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
      errorOutput: `${notes}\n${'k'.repeat(20_000)}-END`,
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    const sent = String(final.errorMessage)
    expect(sent).toHaveLength(4000)
    expect(sent.startsWith(`${notes}\n[...truncated] `)).toBe(true)
    expect(sent.endsWith('-END')).toBe(true)
    expect(final).toMatchObject({ status: 'error', evidenceStatus: 'incomplete' })
  })

  it('should keep AI mode chat policyContext on the config-synced project while persisting under the agent\'s own projectCode', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({ success: true, data: 'Done' })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    await executeE2eTest({
      ...baseOptions,
      projectConfig: { project: { projectCode: 'SYNCED_PROJ' } } as any,
    })

    // Chat context: same source as executeChatCommand (redesigned in phase F).
    const chatArgs = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0]
    expect(JSON.stringify(chatArgs)).toContain('"policyContext":{"tenantCode":"mbc","projectCode":"SYNCED_PROJ"')
    // Persistence: always the agent's own project.
    expect(mockClient.updateE2eExecutionStatus.mock.calls.length).toBeGreaterThan(0)
    expect(mockClient.updateE2eExecutionStatus.mock.calls.every((c: unknown[]) => c[1] === 'MBC_01')).toBe(true)
  })

  it('should report passed with no step reports when the run succeeded with zero steps', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const result = await executeE2eTest(playwrightOptions())

    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
    const final = findFinalStatusCall()!
    expect(final.status).toBe('passed')
    expect(final).not.toHaveProperty('errorMessage')
    expect(final).toMatchObject({ totalSteps: 0, passedSteps: 0, failedSteps: 0 })
    expect(result.data).toMatchObject({ status: 'passed', totalTests: 0 })
    expect(result.data).not.toHaveProperty('errorMessage')
  })

  it('should treat success as authoritative (passed) even if timedOut is also set', async () => {
    // Current contract: `success` wins over `timedOut`. The subprocess executor
    // is not expected to produce this combination; this pins the behavior.
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      timedOut: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
      errorOutput: 'Playwright subprocess timed out after 120000ms',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const result = await executeE2eTest(playwrightOptions())

    const final = findFinalStatusCall()!
    expect(final.status).toBe('passed')
    expect(final).not.toHaveProperty('errorMessage')
    expect(result.data).toMatchObject({ status: 'passed' })
  })

  it('should log the final status report failure at error level and still return the computed status', async () => {
    // Pins current behavior: when the final status report itself fails, the
    // failure is logged loudly but the returned status is the computed one (the
    // API-side execution may remain "running"; recovery is the API's job — A5).
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'step A', status: 'passed' }],
    })
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)
    mockClient.updateE2eExecutionStatus.mockImplementation(
      async (_t: string, _p: string, _e: string, body: Record<string, unknown>) => {
        if (body.status !== 'running') throw http413()
      },
    )
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const result = await executeE2eTest(playwrightOptions())

    const statusLog = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('Failed to report execution status (status=passed)'))
    expect(statusLog).toBeDefined()
    expect(statusLog).toContain('[413]')
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ status: 'passed' })
    errorSpy.mockRestore()
  })

  // tenantCode/projectCode are required to persist anything (running/final
  // status, step evidence). Without them no mode may run the test, and the
  // result must never be "passed" — it is an error result returned up front.
  describe.each([
    ['ai', {}],
    ['script', { playwrightScript: "await page.goto('/')" }],
    ['playwright', { playwrightScript: "await page.goto('/')" }],
  ] as const)('missing tenantCode/projectCode (%s mode)', (executionMethod, extraPayload) => {
    it.each([
      ['tenantCode', { tenantCode: undefined }],
      ['projectCode', { projectCode: undefined }],
      ['projectCode (empty)', { projectCode: '' }],
    ] as const)('should refuse to run and return an error result when %s is missing', async (_label, override) => {
      // If execution were to start, every runner would report success.
      ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({ success: true, data: 'Done' })
      ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue({
        success: true, totalTests: 1, passedTests: 1, failedTests: 0, steps: [],
      })
      ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
        success: true, totalTests: 1, passedTests: 1, failedTests: 0, steps: [{ title: 's', status: 'passed' }],
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
      mockClient.reportE2eTestStep.mockResolvedValue(undefined)
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

      const result = await executeE2eTest({
        ...baseOptions,
        ...override,
        payload: { ...baseOptions.payload, executionMethod, ...extraPayload },
      })

      expect(result.success).toBe(false)
      expect(result).toMatchObject({
        error: 'tenantCode/projectCode is not set; E2E results cannot be reported',
        data: { executionId: 'exec-1', status: 'error' },
      })
      // Nothing started: no runner, no API calls at all.
      expect(chatExecutor.executeChatCommand).not.toHaveBeenCalled()
      expect(playwrightTestRunner.runPlaywrightScript).not.toHaveBeenCalled()
      expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).not.toHaveBeenCalled()
      expect(mockClient.updateE2eExecutionStatus).not.toHaveBeenCalled()
      expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
      expect(mockClient.getE2eSupportFiles).not.toHaveBeenCalled()
      // Logged exactly once at error level, and no duplicate "skipping" warn.
      const errLogs = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('tenantCode/projectCode'))
      expect(errLogs).toHaveLength(1)
      expect(errLogs[0]).toContain('exec-1')
      expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('tenantCode/projectCode'))).toBe(false)
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    })
  })

  it('should pass the resolved targetUrl as baseUrl to runPlaywrightSubprocess', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        targetUrl: 'https://staging.example.com',
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://staging.example.com' }),
    )
  })

  it('should pass undefined baseUrl to runPlaywrightSubprocess when targetUrl is not provided', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        targetUrl: undefined,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: undefined }),
    )
  })

  it('should default captureStepScreenshots to true when the payload omits the field', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ captureStepScreenshots: true }),
    )
  })

  it('should forward captureStepScreenshots=false when the payload sets it to boolean false', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        captureStepScreenshots: false,
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ captureStepScreenshots: false }),
    )
  })

  it('should treat the string "false" as captureStepScreenshots=false (deploy-window resilience)', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        captureStepScreenshots: 'false',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ captureStepScreenshots: false }),
    )
  })

  it('should keep captureStepScreenshots=true for any other truthy/unrecognized payload value', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        captureStepScreenshots: 'true',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ captureStepScreenshots: true }),
    )
  })

  it('should pull environment variables by environmentId and forward them to runPlaywrightSubprocess as envVars', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ API_KEY: 'abc123', STAGE: 'staging' })

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.getE2eEnvironmentVariables).toHaveBeenCalledWith('env-1')
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { API_KEY: 'abc123', STAGE: 'staging' } }),
    )
  })

  it('should not pull and pass undefined envVars to runPlaywrightSubprocess when environmentId is not provided', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.getE2eEnvironmentVariables).not.toHaveBeenCalled()
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: undefined }),
    )
  })

  it('should end the execution with error status when pulling environment variables fails (no silent fallback)', async () => {
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockRejectedValue(new Error('KMS throttled'))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('KMS throttled')
    }
    // The Playwright subprocess must not run when env variable pull fails.
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).not.toHaveBeenCalled()
    // The failure must be reported as an error status, not swallowed.
    expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({ status: 'error' }),
    )
    // The pull-failure log must carry executionId and environmentId for triage.
    const pullFailureLog = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((msg) => msg.includes('Failed to fetch E2E environment variables'))
    expect(pullFailureLog).toBeDefined()
    expect(pullFailureLog).toContain('[exec-1]')
    expect(pullFailureLog).toContain('environmentId=env-1')
    errorSpy.mockRestore()
  })

  // --- basic auth (httpCredentials) ---

  it('should resolve the basicAuth password from the environment variable map and forward httpCredentials to runPlaywrightSubprocess', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ BASIC_PW: 'sekret', OTHER: 'x' })

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
        basicAuth: { username: 'basic-user', passwordVariableKey: 'BASIC_PW' },
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        httpCredentials: { username: 'basic-user', password: 'sekret' },
      }),
    )
  })

  it('should end the execution with error (and NOT run the subprocess) when the basicAuth password variable is missing from the map', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ OTHER: 'x' })
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
        basicAuth: { username: 'basic-user', passwordVariableKey: 'MISSING_PW' },
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      // Error names the missing key, so operators can fix the environment...
      expect(result.error).toContain('MISSING_PW')
    }
    // ...but the Playwright subprocess must NOT run (would 401 then SIGKILL).
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).not.toHaveBeenCalled()
    // The failure must be reported as an error status, not swallowed.
    const errorStatusCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as { status?: string })?.status === 'error',
    )
    expect(errorStatusCall).toBeDefined()
    // The reported errorMessage carries the key name but never a password value.
    expect(String((errorStatusCall![3] as { errorMessage?: string }).errorMessage)).toContain('MISSING_PW')
    errorSpy.mockRestore()
  })

  it('should forward no httpCredentials to runPlaywrightSubprocess when basicAuth is absent', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ httpCredentials: undefined }),
    )
  })

  it('should treat a non-object basicAuth as absent WITHOUT warning (no credentials, no error)', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        basicAuth: 'not-an-object',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ httpCredentials: undefined }),
    )
    // A fully-absent / non-object basicAuth is silent — no incomplete warning.
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('basicAuth ignored'))).toBe(false)
    warnSpy.mockRestore()
  })

  it('should WARN (partial basicAuth) and treat it as absent when passwordVariableKey is missing', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ BASIC_PW: 'sekret' })
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
        // username present but passwordVariableKey missing → partial → warn + absent
        basicAuth: { username: 'basic-user' },
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ httpCredentials: undefined }),
    )
    // The partial basicAuth must be surfaced (not silently dropped), carrying
    // the executionId for triage but no secret values.
    const incompleteWarn = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((msg) => msg.includes('basicAuth ignored'))
    expect(incompleteWarn).toBeDefined()
    expect(incompleteWarn).toContain('exec-1')
    // No secret value leaks into the warning (only the username was present).
    expect(incompleteWarn).not.toContain('basic-user')
    warnSpy.mockRestore()
  })

  it('should WARN (partial basicAuth) and treat it as absent when username is missing', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ BASIC_PW: 'sekret' })
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
        // passwordVariableKey present but username missing → partial → warn + absent
        basicAuth: { passwordVariableKey: 'BASIC_PW' },
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ httpCredentials: undefined }),
    )
    const incompleteWarn = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((msg) => msg.includes('basicAuth ignored'))
    expect(incompleteWarn).toBeDefined()
    expect(incompleteWarn).toContain('exec-1')
    warnSpy.mockRestore()
  })

  // --- shared support files ---

  it('should fetch project support files and forward them to runPlaywrightSubprocess', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const supportFiles = [
      { path: 'lib/login.page.ts', content: 'export class LoginPage {}' },
      { path: 'lib/pages/top.page.ts', content: 'export class TopPage {}' },
    ]
    mockClient.getE2eSupportFiles.mockResolvedValue(supportFiles)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "import { LoginPage } from './lib/login.page'",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(mockClient.getE2eSupportFiles).toHaveBeenCalledWith('mbc', 'MBC_01')
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ supportFiles }),
    )
  })

  it('should warn and continue with empty supportFiles when fetching support files fails', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eSupportFiles.mockRejectedValue(new Error('Request failed with status code 404'))
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    // Unlike environment variable pull failure, support file pull failure must
    // not abort the execution (old API servers without the endpoint must keep working).
    expect(result.success).toBe(true)
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ supportFiles: [] }),
    )
    const failureLog = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((msg) => msg.includes('Failed to fetch support files'))
    expect(failureLog).toBeDefined()
    expect(failureLog).toContain('[exec-1]')
    expect(failureLog).toContain('Request failed with status code 404')
    // No error status must be reported for this
    expect(mockClient.updateE2eExecutionStatus).not.toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({ status: 'error' }),
    )
    warnSpy.mockRestore()
  })

  it('should handle step report failure gracefully in playwright mode', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'Step 1', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(new Error('API Error'))

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
  })

  it('should use fallback error message when errorOutput is absent in failed playwright run', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: false,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      steps: [{ title: 'Step', status: 'failed', error: 'fail' }],
      // no errorOutput
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    const failedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(failedCall![3]).toEqual(
      expect.objectContaining({ errorMessage: '1 test(s) failed' }),
    )
    expect(result.success).toBe(true)
  })

  // --- environmentId ignored outside executionMethod='playwright' ---

  it('should warn (not silently drop) when environmentId is provided in default AI mode', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        executionMethod: 'ai',
        environmentId: 'env-1',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(mockClient.getE2eEnvironmentVariables).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentId is only supported for executionMethod='playwright'"),
    )
    warnSpy.mockRestore()
  })

  it('should warn (not silently drop) when environmentId is provided in AI mode with a playwrightScript', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "const { test } = require('@playwright/test'); test('t', async ({ page }) => {})",
        executionMethod: 'ai',
        environmentId: 'env-1',
        steps: [{ action: 'Open login page', expected: 'Login page is visible' }],
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentId is only supported for executionMethod='playwright'"),
    )
    warnSpy.mockRestore()
  })

  it('should warn (not silently drop) when environmentId is provided in script mode', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      totalSteps: 1,
      results: [],
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "const { test } = require('@playwright/test'); test('t', async ({ page }) => { await page.goto('/') })",
        executionMethod: 'script',
        environmentId: 'env-1',
      },
    }

    await executeE2eTest(options)

    expect(mockClient.getE2eEnvironmentVariables).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentId is only supported for executionMethod='playwright'"),
    )
    warnSpy.mockRestore()
  })

  it('should not warn about environmentId scoping in AI mode when environmentId is absent', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    await executeE2eTest(baseOptions)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('only supported for executionMethod'),
    )
    warnSpy.mockRestore()
  })

  it('should not warn about environmentId scoping in script mode when environmentId is absent', async () => {
    const mockResult: PlaywrightRunnerResult = {
      success: true,
      passed: 1,
      failed: 0,
      skipped: 0,
      totalSteps: 1,
      results: [],
    }
    ;(playwrightTestRunner.runPlaywrightScript as jest.Mock).mockResolvedValue(mockResult)
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "const { test } = require('@playwright/test'); test('t', async ({ page }) => { await page.goto('/') })",
        executionMethod: 'script',
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('only supported for executionMethod'),
    )
    warnSpy.mockRestore()
  })

  it('should not warn about environmentId scoping when using playwright subprocess mode', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.getE2eEnvironmentVariables.mockResolvedValue({ API_KEY: 'abc123' })
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentId: 'env-1',
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('only supported for executionMethod'),
    )
    warnSpy.mockRestore()
  })

  // --- legacy environmentVariables field guard ---

  it('should warn when the legacy environmentVariables field is present in the payload (AI mode)', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        executionMethod: 'ai',
        environmentVariables: { SECRET_KEY: 'topsecret-value' },
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('legacy environmentVariables field is no longer supported'),
    )
    // The secret value must never appear in the log.
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain('topsecret-value')
    }
    warnSpy.mockRestore()
  })

  it('should warn when the legacy environmentVariables field is present in playwright subprocess mode', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
        environmentVariables: 'some-legacy-string',
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('legacy environmentVariables field is no longer supported'),
    )
    warnSpy.mockRestore()
  })

  it('should not warn about the legacy environmentVariables field when it is absent', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    await executeE2eTest(baseOptions)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('legacy environmentVariables field is no longer supported'),
    )
    warnSpy.mockRestore()
  })

  // --- browser session isolation (AI mode) ---
  //
  // E2E テストが AI モードで実行されると、コンソールでユーザーが見ている
  // ブラウザープレビュー（メインプロセスの BrowserSessionManager に登録された
  // 「最初のセッション」）を子プロセスが誤って乗っ取ってしまうバグの回帰テスト。
  // E2E 専用の一意な browserSessionId を chatPayload に含め、実行前後に
  // getOrCreateBrowserSession / closeBrowserSession で明示的にライフサイクル管理する。

  describe('browser session isolation (AI mode)', () => {
    it('should include a unique e2e browserSessionId at the top level of the chat payload', async () => {
      ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
        success: true,
        data: 'Done',
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      await executeE2eTest(baseOptions)

      const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
      expect(chatCall.payload.browserSessionId).toBe('e2e-exec-1')
    })

    it('should call getOrCreateBrowserSession with the e2e session id before executeChatCommand', async () => {
      const callOrder: string[] = []
      const getOrCreateBrowserSession = jest.fn(async (sessionId: string) => {
        callOrder.push(`getOrCreate:${sessionId}`)
      })
      ;(chatExecutor.executeChatCommand as jest.Mock).mockImplementation(async () => {
        callOrder.push('executeChatCommand')
        return { success: true, data: 'Done' }
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        getOrCreateBrowserSession,
      }

      await executeE2eTest(options)

      expect(getOrCreateBrowserSession).toHaveBeenCalledTimes(1)
      expect(getOrCreateBrowserSession).toHaveBeenCalledWith('e2e-exec-1')
      expect(callOrder).toEqual(['getOrCreate:e2e-exec-1', 'executeChatCommand'])
    })

    it('should report error status and closeBrowserSession when getOrCreateBrowserSession rejects', async () => {
      // getOrCreateBrowserSession が失敗した場合でも、他の全失敗パス
      // (executeChatCommand の catch 等) と対称的に 'error' ステータスが
      // 報告され、E2E 実行が 'running' のまま取り残されないことを保証する。
      const getOrCreateBrowserSession = jest.fn().mockRejectedValue(
        new Error('session pre-registration failed'),
      )
      const closeBrowserSession = jest.fn().mockResolvedValue(undefined)
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        getOrCreateBrowserSession,
        closeBrowserSession,
      }

      const result = await executeE2eTest(options)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('session pre-registration failed')
      }

      // executeChatCommand must never run if session pre-registration failed.
      expect(chatExecutor.executeChatCommand).not.toHaveBeenCalled()

      // The 'error' status must be reported, not left as 'running' forever.
      expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
        'mbc',
        'MBC_01',
        'exec-1',
        expect.objectContaining({
          status: 'error',
          errorMessage: expect.stringContaining('session pre-registration failed'),
        }),
      )

      // closeBrowserSession should still be attempted (finally-block cleanup).
      expect(closeBrowserSession).toHaveBeenCalledTimes(1)
      expect(closeBrowserSession).toHaveBeenCalledWith('e2e-exec-1')
    })

    it('should call closeBrowserSession with the e2e session id after executeChatCommand succeeds', async () => {
      const callOrder: string[] = []
      const closeBrowserSession = jest.fn(async (sessionId: string) => {
        callOrder.push(`close:${sessionId}`)
      })
      ;(chatExecutor.executeChatCommand as jest.Mock).mockImplementation(async () => {
        callOrder.push('executeChatCommand')
        return { success: true, data: 'Done' }
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        closeBrowserSession,
      }

      const result = await executeE2eTest(options)

      expect(result.success).toBe(true)
      expect(closeBrowserSession).toHaveBeenCalledTimes(1)
      expect(closeBrowserSession).toHaveBeenCalledWith('e2e-exec-1')
      // executeChatCommand must complete before the session is torn down.
      expect(callOrder).toEqual(['executeChatCommand', 'close:e2e-exec-1'])
    })

    it('should call closeBrowserSession even when executeChatCommand rejects (no leak)', async () => {
      const closeBrowserSession = jest.fn().mockResolvedValue(undefined)
      ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue(
        new Error('Unexpected error'),
      )
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        closeBrowserSession,
      }

      const result = await executeE2eTest(options)

      expect(result.success).toBe(false)
      expect(closeBrowserSession).toHaveBeenCalledTimes(1)
      expect(closeBrowserSession).toHaveBeenCalledWith('e2e-exec-1')
    })

    it('should not let a rejecting closeBrowserSession break the reported final result (success case)', async () => {
      const closeBrowserSession = jest.fn().mockRejectedValue(new Error('close failed'))
      ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
        success: true,
        data: 'Done',
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        closeBrowserSession,
      }

      const result = await executeE2eTest(options)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(
          expect.objectContaining({ executionId: 'exec-1', status: 'passed' }),
        )
      }
      // The passed status must still be reported to the API despite the close failure.
      expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
        'mbc',
        'MBC_01',
        'exec-1',
        expect.objectContaining({ status: 'passed' }),
      )
      warnSpy.mockRestore()
    })

    it('should not let a rejecting closeBrowserSession break the error path when executeChatCommand throws', async () => {
      const closeBrowserSession = jest.fn().mockRejectedValue(new Error('close failed'))
      ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue(
        new Error('Unexpected error'),
      )
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

      const options: ExecuteE2eTestOptions = {
        ...baseOptions,
        closeBrowserSession,
      }

      const result = await executeE2eTest(options)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Unexpected error')
      }
      expect(mockClient.updateE2eExecutionStatus).toHaveBeenCalledWith(
        'mbc',
        'MBC_01',
        'exec-1',
        expect.objectContaining({ status: 'error', errorMessage: 'Unexpected error' }),
      )
      warnSpy.mockRestore()
    })

    it('should work without getOrCreateBrowserSession/closeBrowserSession (backward compatibility)', async () => {
      ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
        success: true,
        data: 'Done',
      })
      mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

      // baseOptions does not set getOrCreateBrowserSession/closeBrowserSession
      const result = await executeE2eTest(baseOptions)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(
          expect.objectContaining({ executionId: 'exec-1', status: 'passed' }),
        )
      }
    })
  })
})
