import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerE2eTestStepTool } from '../../../src/mcp/tools/e2e-test-step'

describe('registerE2eTestStepTool', () => {
  let server: { tool: jest.Mock }
  let mockApiClient: { reportE2eTestStep: jest.Mock }
  const originalEnv = process.env

  beforeEach(() => {
    server = { tool: jest.fn() }
    mockApiClient = { reportE2eTestStep: jest.fn() }
    process.env = { ...originalEnv }
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
})
