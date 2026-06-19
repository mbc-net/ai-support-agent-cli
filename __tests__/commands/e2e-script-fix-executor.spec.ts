import {
  executeE2eScriptFix,
  extractScriptFromResponse,
  type ExecuteE2eScriptFixOptions,
} from '../../src/commands/e2e-script-fix-executor'
import * as chatExecutor from '../../src/commands/chat-executor'

jest.mock('../../src/commands/chat-executor', () => ({
  executeChatCommand: jest.fn(),
}))

const mockClient = {
  updateE2eTestScript: jest.fn(),
} as any

const baseOptions: ExecuteE2eScriptFixOptions = {
  payload: {
    testCaseId: 'tc-42',
    message: 'セレクタ #old-button を #new-button に変更してください',
    currentScript: "await page.goto('/')\nawait page.click('#old-button')",
  },
  client: mockClient,
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  agentId: 'agent-1',
  commandId: 'cmd-fix-1',
}

describe('extractScriptFromResponse', () => {
  it('should extract from a typescript code block', () => {
    const response = "Here is the fix:\n```typescript\nawait page.click('#new-button')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.click('#new-button')")
  })

  it('should extract from a javascript code block', () => {
    const response = "```javascript\nawait page.goto('/')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.goto('/')")
  })

  it('should extract from a playwright code block', () => {
    const response = "```playwright\nawait page.fill('#input', 'text')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.fill('#input', 'text')")
  })

  it('should extract from a ts code block (short alias)', () => {
    const response = "```ts\nawait page.click('.btn')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.click('.btn')")
  })

  it('should extract from a js code block (short alias)', () => {
    const response = "```js\nawait page.click('.btn')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.click('.btn')")
  })

  it('should extract from a bare code block', () => {
    const response = "```\nawait page.goto('/')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.goto('/')")
  })

  it('should return the trimmed response when it contains await page.', () => {
    const response = "  await page.goto('/')\nawait page.click('.btn')  "
    expect(extractScriptFromResponse(response)).toBe("await page.goto('/')\nawait page.click('.btn')")
  })

  it('should return null when no script can be found', () => {
    const response = 'Sorry, I cannot help with that.'
    expect(extractScriptFromResponse(response)).toBeNull()
  })

  it('should return null for empty string', () => {
    expect(extractScriptFromResponse('')).toBeNull()
  })

  it('should prefer code block over inline script', () => {
    const response = "Use this: await page.goto('/')\n```typescript\nawait page.click('#x')\n```"
    expect(extractScriptFromResponse(response)).toBe("await page.click('#x')")
  })
})

describe('executeE2eScriptFix', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.updateE2eTestScript.mockResolvedValue(undefined)
  })

  it('should return error when message is missing', async () => {
    const result = await executeE2eScriptFix({
      ...baseOptions,
      payload: { ...baseOptions.payload, message: undefined },
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('message is required')
  })

  it('should return error when currentScript is missing', async () => {
    const result = await executeE2eScriptFix({
      ...baseOptions,
      payload: { ...baseOptions.payload, currentScript: undefined },
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('currentScript is required')
  })

  it('should return error when testCaseId is missing', async () => {
    const result = await executeE2eScriptFix({
      ...baseOptions,
      payload: { ...baseOptions.payload, testCaseId: undefined },
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('testCaseId is required')
  })

  it('should call executeChatCommand with a prompt containing the current script and message', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.click('#new-button')\n```",
    })

    await executeE2eScriptFix(baseOptions)

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.payload.message).toContain('#old-button')
    expect(chatCall.payload.message).toContain('セレクタ #old-button を #new-button に変更してください')
  })

  it('should save the updated script via updateE2eTestScript', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.click('#new-button')\n```",
    })

    const result = await executeE2eScriptFix(baseOptions)

    expect(mockClient.updateE2eTestScript).toHaveBeenCalledWith(
      'mbc',
      'MBC_01',
      'tc-42',
      expect.objectContaining({
        playwrightScript: "await page.click('#new-button')",
        testCaseId: 'tc-42',
      }),
    )
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(
        expect.objectContaining({
          testCaseId: 'tc-42',
          updatedScript: "await page.click('#new-button')",
        }),
      )
    }
  })

  it('should return error when chat executor throws', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockRejectedValue(new Error('LLM down'))

    const result = await executeE2eScriptFix(baseOptions)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('LLM down')
  })

  it('should return error when chat executor returns failure', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: false,
      error: 'Chat failed',
    })

    const result = await executeE2eScriptFix(baseOptions)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Chat failed')
  })

  it('should return error when LLM response contains no extractable script', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: 'I am unable to fix the script.',
    })

    const result = await executeE2eScriptFix(baseOptions)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Could not extract updated script')
  })

  it('should return error when chat result data is not a string', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: { notAString: true },
    })

    const result = await executeE2eScriptFix(baseOptions)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Could not extract updated script')
  })

  it('should still succeed when updateE2eTestScript throws', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })
    mockClient.updateE2eTestScript.mockRejectedValue(new Error('API error'))

    const result = await executeE2eScriptFix(baseOptions)
    // Script save failed but we still return success with the updated script
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).updatedScript).toBe("await page.goto('/')")
    }
  })

  it('should skip saving when tenantCode is missing', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })

    const result = await executeE2eScriptFix({
      ...baseOptions,
      tenantCode: undefined,
    })

    expect(mockClient.updateE2eTestScript).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should skip saving when projectCode is missing', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })

    const result = await executeE2eScriptFix({
      ...baseOptions,
      projectCode: undefined,
      projectConfig: undefined,
    })

    expect(mockClient.updateE2eTestScript).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('should use projectConfig.project.projectCode when projectCode option is absent', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })

    await executeE2eScriptFix({
      ...baseOptions,
      projectCode: undefined,
      projectConfig: { project: { projectCode: 'FROM_CONFIG' } } as any,
    })

    expect(mockClient.updateE2eTestScript).toHaveBeenCalledWith(
      'mbc',
      'FROM_CONFIG',
      'tc-42',
      expect.any(Object),
    )
  })

  it('should generate commandId from testCaseId when commandId is not provided', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })

    await executeE2eScriptFix({
      ...baseOptions,
      commandId: undefined,
    })

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.commandId).toBe('e2e-script-fix-tc-42')
  })

  it('should pass through serverConfig, activeChatMode, etc. to executeChatCommand', async () => {
    ;(chatExecutor.executeChatCommand as jest.Mock).mockResolvedValue({
      success: true,
      data: "```typescript\nawait page.goto('/')\n```",
    })

    const serverConfig = { apiUrl: 'https://api.example.com' } as any
    const activeChatMode = 'api' as any

    await executeE2eScriptFix({
      ...baseOptions,
      serverConfig,
      activeChatMode,
    })

    const chatCall = (chatExecutor.executeChatCommand as jest.Mock).mock.calls[0][0]
    expect(chatCall.serverConfig).toBe(serverConfig)
    expect(chatCall.activeChatMode).toBe(activeChatMode)
  })
})
