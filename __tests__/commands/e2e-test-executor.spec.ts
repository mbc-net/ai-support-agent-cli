import { executeE2eTest, type ExecuteE2eTestOptions } from '../../src/commands/e2e-test-executor'
import * as chatExecutor from '../../src/commands/chat-executor'
import * as playwrightTestRunner from '../../src/browser/playwright-test-runner'
import type { PlaywrightRunnerResult } from '../../src/browser/playwright-test-runner'
import * as browserScriptExecutor from '../../src/browser/browser-script-executor'
import * as playwrightSubprocessExecutor from '../../src/browser/playwright-subprocess-executor'
import { logger } from '../../src/logger'

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

  it('should handle missing tenantCode gracefully in status reporting', async () => {
    const options = { ...baseOptions, tenantCode: undefined }
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    // Should not throw, just warn
    expect(mockClient.updateE2eExecutionStatus).not.toHaveBeenCalled()
  })

  it('should handle missing projectCode gracefully in status reporting', async () => {
    const options = { ...baseOptions, projectConfig: undefined }
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(mockClient.updateE2eExecutionStatus).not.toHaveBeenCalled()
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

  it('should skip fetching support files when tenantCode is missing', async () => {
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
      tenantCode: undefined,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(mockClient.getE2eSupportFiles).not.toHaveBeenCalled()
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ supportFiles: [] }),
    )
  })

  it('should skip fetching support files when projectCode is missing', async () => {
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
      projectConfig: undefined,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(mockClient.getE2eSupportFiles).not.toHaveBeenCalled()
    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ supportFiles: [] }),
    )
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

  it('should skip step reporting when tenantCode is missing in playwright mode', async () => {
    ;(playwrightSubprocessExecutor.runPlaywrightSubprocess as jest.Mock).mockResolvedValue({
      success: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      steps: [{ title: 'Step 1', status: 'passed' }],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      tenantCode: undefined,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')",
        executionMethod: 'playwright',
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
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
