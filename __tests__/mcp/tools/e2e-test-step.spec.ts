import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerE2eTestStepTool } from '../../../src/mcp/tools/e2e-test-step'
import { getActiveSession } from '../../../src/mcp/tools/browser'

jest.mock('../../../src/mcp/tools/browser', () => ({
  getActiveSession: jest.fn(),
}))

const mockGetActiveSession = getActiveSession as jest.MockedFunction<typeof getActiveSession>

describe('registerE2eTestStepTool', () => {
  let server: { tool: jest.Mock }
  let mockApiClient: { reportE2eTestStep: jest.Mock }
  const originalEnv = process.env

  beforeEach(() => {
    server = { tool: jest.fn() }
    mockApiClient = { reportE2eTestStep: jest.fn() }
    process.env = { ...originalEnv }
    mockGetActiveSession.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should register report_test_step tool', () => {
    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    expect(server.tool).toHaveBeenCalledWith(
      'report_test_step',
      expect.any(String),
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('should return message when execution ID is not set', async () => {
    delete process.env.AI_SUPPORT_E2E_EXECUTION_ID

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 1,
      action: 'Click button',
      status: 'passed',
    })

    expect(result.content[0].text).toContain('only available during E2E test execution')
    expect(mockApiClient.reportE2eTestStep).not.toHaveBeenCalled()
  })

  it('should report step when execution ID is set', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-1'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 1,
      action: 'Click login button',
      status: 'passed',
      duration: 500,
    })

    expect(result.content[0].text).toContain('Step 1: passed')
    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-1',
      expect.objectContaining({
        stepNumber: 1,
        action: 'Click login button',
        status: 'passed',
        duration: 500,
      }),
    )
  })

  it('should return message when tenant/project code is missing', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-1'
    delete process.env.AI_SUPPORT_AGENT_TENANT_CODE
    delete process.env.AI_SUPPORT_AGENT_PROJECT_CODE

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 1,
      action: 'Click',
      status: 'passed',
    })

    expect(result.content[0].text).toContain('Missing tenant or project code')
    expect(mockApiClient.reportE2eTestStep).not.toHaveBeenCalled()
  })

  it('should report step without screenshot when no browser session provided', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]

    await handler({
      stepNumber: 1,
      action: 'Capture page',
      status: 'passed',
    })

    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-123',
      expect.objectContaining({
        stepNumber: 1,
        action: 'Capture page',
        status: 'passed',
      }),
    )
    const callArgs = mockApiClient.reportE2eTestStep.mock.calls[0][3]
    expect(callArgs.screenshotBase64).toBeUndefined()
  })

  it('should auto-capture screenshot from shared browser session', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    const mockScreenshotBuffer = Buffer.from('fake-png-data')
    const mockBrowserSession = {
      screenshot: jest.fn().mockResolvedValue(mockScreenshotBuffer),
      isActive: jest.fn().mockReturnValue(true),
    }

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any, mockBrowserSession as any)

    const handler = server.tool.mock.calls[0][3]

    await handler({
      stepNumber: 1,
      action: 'Capture page',
      status: 'passed',
    })

    expect(mockBrowserSession.screenshot).toHaveBeenCalledWith(true)
    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-123',
      expect.objectContaining({
        screenshotBase64: mockScreenshotBuffer.toString('base64'),
      }),
    )
  })

  it('should handle non-Error thrown by browser screenshot gracefully', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    const mockBrowserSession = {
      screenshot: jest.fn().mockRejectedValue('non-error-screenshot-failure'),
      isActive: jest.fn().mockReturnValue(true),
    }

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any, mockBrowserSession as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 1,
      action: 'Click button',
      status: 'passed',
    }) as { content: Array<{ text: string }> }

    // Should still report the step even when screenshot fails
    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalled()
    const callArgs = mockApiClient.reportE2eTestStep.mock.calls[0][3]
    expect(callArgs.screenshotBase64).toBeUndefined()
    expect(result.content[0].text).toContain('Step 1: passed')
  })

  it('should include error message in response for failed steps', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-1'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 2,
      action: 'Verify page title',
      status: 'failed',
      error: 'Expected "Dashboard" but got "Login"',
    })

    expect(result.content[0].text).toContain('Step 2: failed')
    expect(result.content[0].text).toContain('Expected "Dashboard" but got "Login"')
  })

  it('should handle Error instance thrown by browser screenshot gracefully', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    const screenshotError = new Error('Page not loaded')
    const mockBrowserSession = {
      screenshot: jest.fn().mockRejectedValue(screenshotError),
      isActive: jest.fn().mockReturnValue(true),
    }

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any, mockBrowserSession as any)

    const handler = server.tool.mock.calls[0][3]
    const result = await handler({
      stepNumber: 1,
      action: 'Click button',
      status: 'passed',
    }) as { content: Array<{ text: string }> }

    // Should still report the step even when screenshot fails with an Error instance
    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalled()
    const callArgs = mockApiClient.reportE2eTestStep.mock.calls[0][3]
    expect(callArgs.screenshotBase64).toBeUndefined()
    expect(result.content[0].text).toContain('Step 1: passed')
  })

  it('should include testCaseId in report when AI_SUPPORT_E2E_TEST_CASE_ID is set', async () => {
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'
    process.env.AI_SUPPORT_E2E_TEST_CASE_ID = 'tc-456'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    registerE2eTestStepTool(server as unknown as McpServer, mockApiClient as any)

    const handler = server.tool.mock.calls[0][3]
    await handler({
      stepNumber: 1,
      action: 'Navigate to dashboard',
      status: 'passed',
    })

    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'exec-123',
      expect.objectContaining({
        testCaseId: 'tc-456',
      }),
    )
  })

  it('should screenshot the resolved active session, not the static fallback session, when a browser session manager is provided', async () => {
    // Reproduces the "blank white screenshot" bug: browser_navigate/browser_click
    // resolve the currently-active session (which may be a proxy pointing at a
    // different, already-navigated browser) via getActiveSession() on every call,
    // but report_test_step must do the same instead of always screenshotting the
    // static fallback session it was constructed with (which may never have been
    // navigated and would produce a blank about:blank screenshot).
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    // The static fallback session (never navigated) — screenshotting this would
    // be the bug: it should never be the one whose screenshot is reported.
    const staleFallbackSession = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from('blank-about-blank-png')),
    }

    // The actually-active session (e.g. a BrowserProxySession pointing at the
    // real, already-navigated browser) resolved by getActiveSession().
    const activeNavigatedSession = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from('real-page-content-png')),
      isActive: jest.fn().mockReturnValue(true),
    }
    mockGetActiveSession.mockResolvedValue(activeNavigatedSession as never)

    const mockManager = {} as never

    registerE2eTestStepTool(
      server as unknown as McpServer,
      mockApiClient as any,
      staleFallbackSession as any,
      mockManager,
    )

    const handler = server.tool.mock.calls[0][3]

    await handler({
      stepNumber: 1,
      action: 'Verify dashboard loaded',
      status: 'passed',
    })

    expect(mockGetActiveSession).toHaveBeenCalledWith(mockManager, staleFallbackSession)
    expect(activeNavigatedSession.screenshot).toHaveBeenCalledWith(true)
    expect(staleFallbackSession.screenshot).not.toHaveBeenCalled()

    const callArgs = mockApiClient.reportE2eTestStep.mock.calls[0][3]
    expect(callArgs.screenshotBase64).toBe(Buffer.from('real-page-content-png').toString('base64'))
  })

  it('should skip the screenshot (without throwing) when the resolved session has never been navigated (isActive() is false)', async () => {
    // A resolved session that was never navigated (browser not yet launched)
    // would otherwise produce a blank about:blank screenshot without ever
    // throwing — screenshot() itself succeeds. isActive() is the only signal
    // that distinguishes "real page" from "blank, never-navigated" sessions,
    // so it must be checked before screenshotting, not just relied on to fail.
    process.env.AI_SUPPORT_E2E_EXECUTION_ID = 'exec-123'
    process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'mbc'
    process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'MBC_01'

    mockApiClient.reportE2eTestStep.mockResolvedValue(undefined)

    const neverNavigatedSession = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from('would-be-blank-png')),
      isActive: jest.fn().mockReturnValue(false),
    }
    mockGetActiveSession.mockResolvedValue(neverNavigatedSession as never)

    const staleFallbackSession = { screenshot: jest.fn() }
    const mockManager = {} as never

    registerE2eTestStepTool(
      server as unknown as McpServer,
      mockApiClient as any,
      staleFallbackSession as any,
      mockManager,
    )

    const handler = server.tool.mock.calls[0][3]

    const result = await handler({
      stepNumber: 1,
      action: 'Verify dashboard loaded',
      status: 'passed',
    }) as { content: Array<{ text: string }> }

    expect(neverNavigatedSession.screenshot).not.toHaveBeenCalled()
    expect(mockApiClient.reportE2eTestStep).toHaveBeenCalled()
    const callArgs = mockApiClient.reportE2eTestStep.mock.calls[0][3]
    expect(callArgs.screenshotBase64).toBeUndefined()
    expect(result.content[0].text).toContain('Step 1: passed')
  })
})
