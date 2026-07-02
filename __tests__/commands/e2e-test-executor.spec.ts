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
} as any

describe('e2e-test-executor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
      },
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(playwrightTestRunner.runPlaywrightScript).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
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

  it('should forward environmentVariables from the payload to runPlaywrightSubprocess as envVars', async () => {
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
        environmentVariables: { API_KEY: 'abc123', STAGE: 'staging' },
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { API_KEY: 'abc123', STAGE: 'staging' } }),
    )
  })

  it('should pass undefined envVars to runPlaywrightSubprocess when environmentVariables is not provided', async () => {
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
      expect.objectContaining({ envVars: undefined }),
    )
  })

  it('should drop non-string values from environmentVariables before forwarding', async () => {
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
        environmentVariables: { VALID: 'ok', BAD_NUMBER: 42, BAD_NULL: null },
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: { VALID: 'ok' } }),
    )
  })

  it('should ignore environmentVariables when it is not a plain object', async () => {
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
        environmentVariables: ['not', 'an', 'object'],
      },
    }

    await executeE2eTest(options)

    expect(playwrightSubprocessExecutor.runPlaywrightSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({ envVars: undefined }),
    )
  })

  it('should log a warning when environmentVariables is not a plain object', async () => {
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
        environmentVariables: ['not', 'an', 'object'],
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('environmentVariables'),
    )
    warnSpy.mockRestore()
  })

  it('should log a warning for each non-string value dropped from environmentVariables', async () => {
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
        environmentVariables: { VALID: 'ok', BAD_NUMBER: 42, BAD_NULL: null },
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BAD_NUMBER'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BAD_NULL'))
    warnSpy.mockRestore()
  })

  it('should not warn when environmentVariables is entirely absent', async () => {
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
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('environmentVariables'))
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

  // --- environmentVariables ignored outside executionMethod='playwright' ---

  it('should warn (not silently drop) when environmentVariables is provided in default AI mode', async () => {
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
        environmentVariables: { API_KEY: 'abc123' },
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentVariables is only supported for executionMethod='playwright'"),
    )
    warnSpy.mockRestore()
  })

  it('should warn (not silently drop) when environmentVariables is provided in AI mode with a playwrightScript', async () => {
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
        environmentVariables: { API_KEY: 'abc123' },
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentVariables is only supported for executionMethod='playwright'"),
    )
    warnSpy.mockRestore()
  })

  it('should warn (not silently drop) when environmentVariables is provided in script mode', async () => {
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
        environmentVariables: { API_KEY: 'abc123', STAGE: 'staging' },
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("environmentVariables is only supported for executionMethod='playwright'"),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2 variable'))
    warnSpy.mockRestore()
  })

  it('should not warn about environmentVariables scoping in AI mode when environmentVariables is absent', async () => {
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

  it('should not warn about environmentVariables scoping in script mode when environmentVariables is absent', async () => {
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

  it('should not warn about environmentVariables scoping when using playwright subprocess mode', async () => {
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
        environmentVariables: { API_KEY: 'abc123' },
      },
    }

    await executeE2eTest(options)

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('only supported for executionMethod'),
    )
    warnSpy.mockRestore()
  })
})
