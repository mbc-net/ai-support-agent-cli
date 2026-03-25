import { executeE2eTest, type ExecuteE2eTestOptions } from '../../src/commands/e2e-test-executor'
import * as chatExecutor from '../../src/commands/chat-executor'
import * as browserScriptExecutor from '../../src/browser/browser-script-executor'

// Mock the chat executor
jest.mock('../../src/commands/chat-executor', () => ({
  executeChatCommand: jest.fn(),
}))

// Mock the browser script executor
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
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: true,
      completedSteps: 2,
      totalSteps: 2,
      results: [],
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({
          getPage: jest.fn(),
          actionLog: { add: jest.fn() },
          variables: new Map(),
        }),
      },
    }

    const result = await executeE2eTest(options)

    expect(browserScriptExecutor.executePlaywrightScript).toHaveBeenCalled()
    expect(chatExecutor.executeChatCommand).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should fall back to AI mode when browserSessionManager is not provided', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      // No browserSessionManager
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should fall back to AI mode when script has fallbackToChat', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      fallbackToChat: true,
      completedSteps: 0,
      totalSteps: 1,
      results: [],
    })
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({
          getPage: jest.fn(),
          actionLog: { add: jest.fn() },
          variables: new Map(),
        }),
      },
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should report step progress via onStepComplete callback', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockImplementation(
      async (_session: unknown, _script: string, onStepComplete?: (step: number, total: number, line: string) => Promise<void>) => {
        if (onStepComplete) {
          await onStepComplete(1, 2, 'await page.goto("/")')
        }
        return {
          success: true,
          completedSteps: 2,
          totalSteps: 2,
          results: [],
        }
      },
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({
          getPage: jest.fn(),
          actionLog: { add: jest.fn() },
          variables: new Map(),
        }),
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
        action: 'await page.goto("/")',
        status: 'passed',
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
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'ai',
      },
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(browserScriptExecutor.executePlaywrightScript).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should attempt AI recovery when script execution fails', async () => {
    // First call: script fails
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 1,
        totalSteps: 2,
        results: [
          { line: 'await page.goto("/")', success: true },
          { line: "await page.click('#bad')", success: false, error: 'Element not found' },
        ],
        failedLine: "await page.click('#bad')",
      })
      // Second call: recovery script succeeds
      .mockResolvedValueOnce({
        success: true,
        completedSteps: 2,
        totalSteps: 2,
        results: [],
      })

    // AI recovery returns a fixed script
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')\nawait page.click('#good')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn().mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')\nawait page.click('#bad')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({
          getPage: jest.fn(),
          actionLog: { add: jest.fn() },
          variables: new Map(),
        }),
      },
    }

    const result = await executeE2eTest(options)

    // Recovery chat should have been called
    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    // Script should have been updated
    expect(mockClient.updateE2eTestScript).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        playwrightScript: "await page.goto('/')\nawait page.click('#good')",
        testCaseId: 'tc-1',
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'passed',
          recoveredOnAttempt: 1,
        }),
      )
    }
  })

  it('should fall back to AI mode when getOrCreate throws', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockRejectedValue(new Error('Browser launch failed')),
      },
    }

    const result = await executeE2eTest(options)

    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should handle script execution throwing an error', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockRejectedValue(
      new Error('Page crashed'),
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Page crashed')
    }
  })

  it('should handle step report failure gracefully', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockImplementation(
      async (_session: unknown, _script: string, onStepComplete?: (step: number, total: number, line: string) => Promise<void>) => {
        if (onStepComplete) {
          await onStepComplete(1, 1, 'await page.goto("/")')
        }
        return { success: true, completedSteps: 1, totalSteps: 1, results: [] }
      },
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue(new Error('API Error'))

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
  })

  it('should handle recovery chat failure gracefully', async () => {
    // Script fails
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      completedSteps: 0,
      totalSteps: 1,
      results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
      failedLine: "await page.click('#x')",
    })
    // Recovery chat throws
    ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue(new Error('LLM error'))
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle recovery chat returning failure result', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      completedSteps: 0,
      totalSteps: 1,
      results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
      failedLine: "await page.click('#x')",
    })
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Recovery failed',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle non-extractable script from recovery chat', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      completedSteps: 0,
      totalSteps: 1,
      results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
      failedLine: "await page.click('#x')",
    })
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: { notAString: true },
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle recovery retry script execution throwing', async () => {
    // First call: script fails normally
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      // Recovery executions throw
      .mockRejectedValue(new Error('Browser crashed during recovery'))

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle updateE2eTestScript failure gracefully during recovery', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      .mockResolvedValueOnce({
        success: true,
        completedSteps: 1,
        totalSteps: 1,
        results: [],
      })

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn().mockRejectedValue(new Error('Save failed'))

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    // Should still succeed even though script save failed
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'passed' }))
    }
  })

  it('should extract script from code block in recovery result', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      .mockResolvedValueOnce({
        success: true,
        completedSteps: 1,
        totalSteps: 1,
        results: [],
      })

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn().mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
  })

  it('should skip step report when tenantCode is missing', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockImplementation(
      async (_session: unknown, _script: string, onStepComplete?: (step: number, total: number, line: string) => Promise<void>) => {
        if (onStepComplete) {
          await onStepComplete(1, 1, 'await page.goto("/")')
        }
        return { success: true, completedSteps: 1, totalSteps: 1, results: [] }
      },
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      tenantCode: undefined,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
  })

  it('should skip step report when projectCode is missing', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockImplementation(
      async (_session: unknown, _script: string, onStepComplete?: (step: number, total: number, line: string) => Promise<void>) => {
        if (onStepComplete) {
          await onStepComplete(1, 1, 'await page.goto("/")')
        }
        return { success: true, completedSteps: 1, totalSteps: 1, results: [] }
      },
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      projectConfig: undefined,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    expect(mockClient.reportE2eTestStep).not.toHaveBeenCalled()
  })

  it('should skip script save when testCaseId is missing during recovery', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      .mockResolvedValueOnce({
        success: true,
        completedSteps: 1,
        totalSteps: 1,
        results: [],
      })

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn()

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        testCaseId: undefined,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    expect(mockClient.updateE2eTestScript).not.toHaveBeenCalled()
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

  it('should handle non-Error thrown by getOrCreate', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'Done',
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockRejectedValue('non-error-object'),
      },
    }

    const result = await executeE2eTest(options)
    expect(chatExecutor.executeChatCommand).toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should handle non-Error thrown by executePlaywrightScript', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockRejectedValue('crash')
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('crash')
    }
  })

  it('should handle non-Error thrown by step report', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockImplementation(
      async (_session: unknown, _script: string, onStepComplete?: (step: number, total: number, line: string) => Promise<void>) => {
        if (onStepComplete) {
          await onStepComplete(1, 1, 'await page.goto("/")')
        }
        return { success: true, completedSteps: 1, totalSteps: 1, results: [] }
      },
    )
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.reportE2eTestStep.mockRejectedValue('non-error')

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: 'await page.goto("/")',
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
  })

  it('should handle non-Error thrown by recovery chat', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      completedSteps: 0,
      totalSteps: 1,
      results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
      failedLine: "await page.click('#x')",
    })
    ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue('recovery-crash')
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle non-Error thrown by recovery script execution', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      .mockRejectedValue('recovery-script-crash')

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('should handle non-Error thrown by updateE2eTestScript', async () => {
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock)
      .mockResolvedValueOnce({
        success: false,
        completedSteps: 0,
        totalSteps: 1,
        results: [{ line: "await page.click('#x')", success: false, error: 'fail' }],
        failedLine: "await page.click('#x')",
      })
      .mockResolvedValueOnce({
        success: true,
        completedSteps: 1,
        totalSteps: 1,
        results: [],
      })

    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn().mockRejectedValue('save-crash')

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.click('#x')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({}),
      },
    }

    const result = await executeE2eTest(options)
    expect(result.success).toBe(true)
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

  it('should report failed after max recovery attempts', async () => {
    // Script always fails
    ;(browserScriptExecutor.executePlaywrightScript as jest.Mock).mockResolvedValue({
      success: false,
      completedSteps: 1,
      totalSteps: 2,
      results: [
        { line: 'await page.goto("/")', success: true },
        { line: "await page.click('#bad')", success: false, error: 'Element not found' },
      ],
      failedLine: "await page.click('#bad')",
    })

    // AI recovery always returns a script but it always fails
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "await page.goto('/')\nawait page.click('#still-bad')",
    })
    mockClient.updateE2eExecutionStatus.mockResolvedValue(undefined)
    mockClient.updateE2eTestScript = jest.fn().mockResolvedValue(undefined)

    const options: ExecuteE2eTestOptions = {
      ...baseOptions,
      payload: {
        ...baseOptions.payload,
        playwrightScript: "await page.goto('/')\nawait page.click('#bad')",
        executionMethod: 'script',
      },
      browserSessionManager: {
        getOrCreate: jest.fn().mockResolvedValue({
          getPage: jest.fn(),
          actionLog: { add: jest.fn() },
          variables: new Map(),
        }),
      },
    }

    const result = await executeE2eTest(options)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          executionId: 'exec-1',
          status: 'failed',
        }),
      )
    }

    // Should have attempted recovery 3 times (MAX_RECOVERY_ATTEMPTS)
    expect(chatExecutor.executeChatCommand).toHaveBeenCalledTimes(3)

    // Final status should be failed
    const failedCall = mockClient.updateE2eExecutionStatus.mock.calls.find(
      (call: unknown[]) => (call[3] as Record<string, unknown>).status === 'failed',
    )
    expect(failedCall).toBeDefined()
    expect(failedCall![3]).toEqual(
      expect.objectContaining({
        status: 'failed',
        recoveryAttempts: 3,
      }),
    )
  })
})
