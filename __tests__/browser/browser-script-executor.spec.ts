import { executePlaywrightScript } from '../../src/browser/browser-script-executor'

jest.mock('../../src/logger')

describe('browser-script-executor', () => {
  const mockPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue({
      innerText: jest.fn().mockResolvedValue('Extracted Text'),
    }),
    keyboard: {
      type: jest.fn().mockResolvedValue(undefined),
      press: jest.fn().mockResolvedValue(undefined),
    },
    mouse: {
      wheel: jest.fn().mockResolvedValue(undefined),
    },
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
  }

  const mockSession = {
    getPage: jest.fn().mockResolvedValue(mockPage),
    variables: new Map<string, string>(),
    actionLog: { add: jest.fn() },
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockSession.variables.clear()
  })

  it('should execute a goto command', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });",
    )

    expect(result.success).toBe(true)
    expect(result.completedSteps).toBe(1)
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object))
  })

  it('should execute a click command', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "await page.click('#submit-btn');",
    )

    expect(result.success).toBe(true)
    expect(mockPage.click).toHaveBeenCalledWith('#submit-btn', { timeout: 10000 })
  })

  it('should execute a fill command', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "await page.fill('#email', 'user@example.com');",
    )

    expect(result.success).toBe(true)
    expect(mockPage.fill).toHaveBeenCalledWith('#email', 'user@example.com', { timeout: 10000 })
  })

  it('should execute innerText extraction and store variable', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "const companyName = await page.locator('.partner-list li:nth-child(2)').innerText();",
    )

    expect(result.success).toBe(true)
    expect(mockSession.variables.get('companyName')).toBe('Extracted Text')
    expect(mockSession.actionLog.add).toHaveBeenCalledWith('chat', 'extract', expect.stringContaining('companyName'))
  })

  it('should execute keyboard type', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "await page.keyboard.type('hello world');",
    )

    expect(result.success).toBe(true)
    expect(mockPage.keyboard.type).toHaveBeenCalledWith('hello world')
  })

  it('should execute keyboard press', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "await page.keyboard.press('Enter');",
    )

    expect(result.success).toBe(true)
    expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter')
  })

  it('should execute mouse wheel', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      'await page.mouse.wheel(0, 300);',
    )

    expect(result.success).toBe(true)
    expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 300)
  })

  it('should handle variable declarations', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "const myVar = 'hello';",
    )

    expect(result.success).toBe(true)
    expect(mockSession.variables.get('myVar')).toBe('hello')
  })

  it('should handle waitForTimeout', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      'await page.waitForTimeout(1000);',
    )

    expect(result.success).toBe(true)
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1000)
  })

  it('should clamp waitForTimeout to 10000', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      'await page.waitForTimeout(30000);',
    )

    expect(result.success).toBe(true)
    expect(mockPage.waitForTimeout).toHaveBeenCalledWith(10000)
  })

  it('should skip comments', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "// This is a comment\nawait page.click('#btn');",
    )

    expect(result.success).toBe(true)
    expect(result.completedSteps).toBe(1)
  })

  it('should skip empty lines', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      "\n\nawait page.click('#btn');\n\n",
    )

    expect(result.success).toBe(true)
    expect(result.completedSteps).toBe(1)
  })

  it('should handle multi-step scripts', async () => {
    const script = [
      "await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });",
      "await page.fill('#email', 'test@test.com');",
      "await page.click('#submit');",
    ].join('\n')

    const result = await executePlaywrightScript(mockSession, script)

    expect(result.success).toBe(true)
    expect(result.completedSteps).toBe(3)
    expect(result.totalSteps).toBe(3)
  })

  it('should report fallbackToChat for unparseable lines', async () => {
    const result = await executePlaywrightScript(
      mockSession,
      'some unparseable javascript code',
    )

    expect(result.success).toBe(false)
    expect(result.fallbackToChat).toBe(true)
    expect(result.failedLine).toBe('some unparseable javascript code')
  })

  it('should stop on execution error and report partial failure', async () => {
    mockPage.click.mockRejectedValueOnce(new Error('Element not found'))

    const script = [
      "await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });",
      "await page.click('#nonexistent');",
      "await page.click('#another');",
    ].join('\n')

    const result = await executePlaywrightScript(mockSession, script)

    expect(result.success).toBe(false)
    expect(result.completedSteps).toBe(1)
    expect(result.totalSteps).toBe(3)
    expect(result.failedLine).toContain('#nonexistent')
    expect(result.results[1].error).toContain('Element not found')
  })

  it('should call onStepComplete callback', async () => {
    const onStep = jest.fn()

    await executePlaywrightScript(
      mockSession,
      "await page.click('#btn');",
      onStep,
    )

    expect(onStep).toHaveBeenCalledWith(1, 1, expect.stringContaining('#btn'))
  })

  it('should return success for empty script', async () => {
    const result = await executePlaywrightScript(mockSession, '')

    expect(result.success).toBe(true)
    expect(result.completedSteps).toBe(0)
    expect(result.totalSteps).toBe(0)
  })
})
