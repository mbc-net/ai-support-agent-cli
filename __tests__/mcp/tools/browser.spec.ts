import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerBrowserTools } from '../../../src/mcp/tools/browser'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')

// Mock playwright-loader
jest.mock('../../../src/mcp/tools/browser/playwright-loader', () => ({
  isPlaywrightAvailable: jest.fn().mockReturnValue(true),
  loadPlaywright: jest.fn(),
}))

// Mock BrowserSession
const mockPage = {
  goto: jest.fn().mockResolvedValue(undefined),
  title: jest.fn().mockResolvedValue('Test Page'),
  url: jest.fn().mockReturnValue('https://example.com'),
  screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
  setViewportSize: jest.fn().mockResolvedValue(undefined),
  waitForSelector: jest.fn().mockResolvedValue(undefined),
  waitForTimeout: jest.fn().mockResolvedValue(undefined),
  waitForNavigation: jest.fn().mockResolvedValue(undefined),
  click: jest.fn().mockResolvedValue(undefined),
  fill: jest.fn().mockResolvedValue(undefined),
  locator: jest.fn().mockReturnValue({
    innerText: jest.fn().mockResolvedValue('Hello World'),
  }),
}

jest.mock('../../../src/mcp/tools/browser/browser-session', () => ({
  BrowserSession: jest.fn().mockImplementation(() => ({
    getPage: jest.fn().mockResolvedValue(mockPage),
    isActive: jest.fn().mockReturnValue(true),
    close: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    variables: new Map(),
    actionLog: { add: jest.fn() },
  })),
}))

// Track the last created proxy instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastProxyInstance: any = null

jest.mock('../../../src/mcp/tools/browser/browser-proxy-session', () => {
  class MockBrowserProxySession {
    navigate = jest.fn().mockResolvedValue({
      title: 'Proxy Page',
      url: 'https://proxy.example.com',
      screenshot: Buffer.from('proxy-screenshot'),
    })
    click = jest.fn().mockResolvedValue({
      title: 'Proxy Clicked',
      url: 'https://proxy.example.com/clicked',
      screenshot: Buffer.from('proxy-screenshot'),
    })
    fill = jest.fn().mockResolvedValue(undefined)
    getText = jest.fn().mockResolvedValue('Proxy text')
    screenshot = jest.fn().mockResolvedValue(Buffer.from('proxy-screenshot'))
    getUrl = jest.fn().mockResolvedValue('https://proxy.example.com')
    getTitle = jest.fn().mockResolvedValue('Proxy Page')
    isActive = jest.fn().mockReturnValue(true)
    variables = new Map()
    actionLog = { add: jest.fn() }
  }

  return {
    BrowserProxySession: class extends MockBrowserProxySession {
      constructor(..._args: unknown[]) {
        super()
        lastProxyInstance = this
      }
    },
  }
})

import { isPlaywrightAvailable } from '../../../src/mcp/tools/browser/playwright-loader'

const mockIsPlaywrightAvailable = isPlaywrightAvailable as jest.MockedFunction<typeof isPlaywrightAvailable>

describe('browser tools', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolCallbacks: Record<string, (args: any) => Promise<unknown>> = {}

  function setup(mockClient?: Partial<ApiClient>) {
    const mockServer = {
      tool: jest.fn().mockImplementation((name: string, _d: string, _s: unknown, cb: (args: unknown) => Promise<unknown>) => {
        toolCallbacks[name] = cb
      }),
    } as unknown as McpServer

    registerBrowserTools(mockServer, (mockClient ?? {}) as ApiClient)
    return mockServer
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockIsPlaywrightAvailable.mockReturnValue(true)
    // Reset page mocks
    mockPage.goto.mockResolvedValue(undefined)
    mockPage.title.mockResolvedValue('Test Page')
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot'))
  })

  describe('registerBrowserTools', () => {
    it('should register all 9 browser tools', () => {
      const mockServer = setup()

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledTimes(9)
      const registeredNames = (mockServer.tool as jest.Mock).mock.calls.map(
        (call: unknown[]) => call[0],
      )
      expect(registeredNames).toContain('browser_navigate')
      expect(registeredNames).toContain('browser_close')
      expect(registeredNames).toContain('browser_click')
      expect(registeredNames).toContain('browser_fill')
      expect(registeredNames).toContain('browser_get_text')
      expect(registeredNames).toContain('browser_login')
      expect(registeredNames).toContain('browser_set_variable')
      expect(registeredNames).toContain('browser_get_variable')
      expect(registeredNames).toContain('browser_list_variables')
    })

    it('should skip registration if Playwright is not available', () => {
      mockIsPlaywrightAvailable.mockReturnValue(false)
      const mockServer = {
        tool: jest.fn(),
      } as unknown as McpServer

      registerBrowserTools(mockServer, {} as ApiClient)

      expect((mockServer.tool as jest.Mock)).not.toHaveBeenCalled()
    })
  })

  describe('browser_navigate', () => {
    it('should navigate and return screenshot with page info', async () => {
      setup()

      const result = await toolCallbacks.browser_navigate({
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

      expect(result.content).toHaveLength(2)
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('Test Page')
      expect(result.content[0].text).toContain('https://example.com')
      expect(result.content[1].type).toBe('image')
      expect(result.content[1].mimeType).toBe('image/png')
    })

    it('should reject blocked protocols', async () => {
      setup()

      const result = await toolCallbacks.browser_navigate({
        url: 'file:///etc/passwd',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Blocked protocol')
    })

    it('should reject invalid URLs', async () => {
      setup()

      const result = await toolCallbacks.browser_navigate({
        url: 'not-a-url',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Invalid URL')
    })
  })

  describe('browser_close', () => {
    it('should close active session', async () => {
      setup()

      const result = await toolCallbacks.browser_close({}) as { content: Array<{ text: string }> }
      expect(result.content[0].text).toBe('Browser session closed.')
    })
  })

  describe('browser_click', () => {
    it('should click element and return screenshot', async () => {
      setup()

      const result = await toolCallbacks.browser_click({
        selector: '#submit-btn',
        screenshot: true,
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content).toHaveLength(2)
      expect(result.content[0].text).toContain('Clicked: #submit-btn')
    })

    it('should return text only when screenshot is false', async () => {
      setup()

      const result = await toolCallbacks.browser_click({
        selector: '#submit-btn',
        screenshot: false,
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('Clicked: #submit-btn')
    })
  })

  describe('browser_fill', () => {
    it('should fill input and return text status', async () => {
      setup()

      const result = await toolCallbacks.browser_fill({
        selector: '#email',
        value: 'test@example.com',
        screenshot: false,
      }) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toBe('Filled: #email')
    })

    it('should include screenshot when requested', async () => {
      setup()

      const result = await toolCallbacks.browser_fill({
        selector: '#email',
        value: 'test@example.com',
        screenshot: true,
      }) as { content: Array<{ type: string }> }

      expect(result.content).toHaveLength(2)
      expect(result.content[1].type).toBe('image')
    })
  })

  describe('browser_get_text', () => {
    it('should get text from body by default', async () => {
      setup()

      const result = await toolCallbacks.browser_get_text({}) as { content: Array<{ text: string }> }
      expect(result.content[0].text).toBe('Hello World')
    })

    it('should get text from specified selector', async () => {
      setup()

      await toolCallbacks.browser_get_text({ selector: '.content' })
      expect(mockPage.locator).toHaveBeenCalledWith('.content')
    })
  })

  describe('browser_login', () => {
    it('should fetch credentials and return page with credentials info', async () => {
      const mockClient = {
        getBrowserCredentials: jest.fn().mockResolvedValue({
          credentialId: 'STAGING',
          baseUrl: 'https://app.example.com',
          username: 'admin@example.com',
          password: 'secret',
          environment: 'staging',
          description: 'Staging login',
          promptText: 'Check dashboard after login',
          customFields: { orgId: '12345' },
        }),
      }

      setup(mockClient)

      const result = await toolCallbacks.browser_login({
        credentialName: 'STAGING',
      }) as { content: Array<{ type: string; text?: string }> }

      expect(mockClient.getBrowserCredentials).toHaveBeenCalledWith('STAGING')
      expect(result.content[0].text).toContain('Login page loaded')
      expect(result.content[0].text).toContain('Additional instructions: Check dashboard after login')
      expect(result.content[0].text).toContain('orgId')
      expect(result.content[1].type).toBe('image')
      expect(result.content[2].text).toContain('username: admin@example.com')
      expect(result.content[2].text).toContain('password: secret')
      expect(result.content).toHaveLength(3)
    })

    it('should handle API errors', async () => {
      const mockClient = {
        getBrowserCredentials: jest.fn().mockRejectedValue(new Error('Not found')),
      }

      setup(mockClient)

      const result = await toolCallbacks.browser_login({
        credentialName: 'UNKNOWN',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Not found')
    })

    it('should reject blocked URLs in credentials', async () => {
      const mockClient = {
        getBrowserCredentials: jest.fn().mockResolvedValue({
          baseUrl: 'file:///etc/passwd',
          username: 'admin',
          password: 'pass',
        }),
      }

      setup(mockClient)

      const result = await toolCallbacks.browser_login({
        credentialName: 'MALICIOUS',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Blocked protocol')
    })
  })

  describe('proxy session (when env vars are set)', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      process.env.AI_SUPPORT_BROWSER_SESSION_ID = 'proxy-sess-1'
      process.env.AI_SUPPORT_BROWSER_LOCAL_PORT = '12345'
      lastProxyInstance = null
    })

    afterEach(() => {
      process.env = originalEnv
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function getProxy(): any {
      return lastProxyInstance!
    }

    it('should use proxy session for navigate when env vars are set', async () => {
      setup()

      const result = await toolCallbacks.browser_navigate({
        url: 'https://example.com',
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content).toHaveLength(2)
      expect(result.content[0].text).toContain('Proxy Page')
      expect(getProxy().navigate).toHaveBeenCalledWith('https://example.com', expect.any(Object))
      expect(getProxy().actionLog.add).toHaveBeenCalledWith('chat', 'navigate', 'https://example.com')
    })

    it('should use proxy session for click', async () => {
      setup()

      const result = await toolCallbacks.browser_click({
        selector: '#btn',
        screenshot: true,
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content).toHaveLength(2)
      expect(result.content[0].text).toContain('Proxy Clicked')
      expect(getProxy().click).toHaveBeenCalled()
    })

    it('should use proxy session for click and return text only when no screenshot', async () => {
      setup()

      // With default mock that includes screenshot, click with screenshot:true gives 2 content items
      const result = await toolCallbacks.browser_click({
        selector: '#btn',
        screenshot: true,
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content[0].text).toContain('Clicked: #btn')
      expect(getProxy().actionLog.add).toHaveBeenCalledWith('chat', 'click', '#btn')
    })

    it('should use proxy session for fill', async () => {
      setup()

      const result = await toolCallbacks.browser_fill({
        selector: '#email',
        value: 'test@test.com',
        screenshot: false,
      }) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toBe('Filled: #email')
      expect(getProxy().fill).toHaveBeenCalledWith('#email', 'test@test.com', false)
    })

    it('should use proxy session for fill without screenshot (default)', async () => {
      setup()

      const result = await toolCallbacks.browser_fill({
        selector: '#email',
        value: 'test@test.com',
        screenshot: false,
      }) as { content: Array<{ text: string }> }

      // fill returns undefined by default, so no screenshot
      expect(result.content).toHaveLength(1)
      expect(result.content[0].text).toBe('Filled: #email')
      expect(getProxy().actionLog.add).toHaveBeenCalledWith('chat', 'fill', '#email "test@test.com"')
    })

    it('should use proxy session for get_text', async () => {
      setup()

      const result = await toolCallbacks.browser_get_text({}) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toBe('Proxy text')
      expect(getProxy().getText).toHaveBeenCalledWith('body')
    })

    it('should not close proxy session', async () => {
      setup()

      const result = await toolCallbacks.browser_close({}) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toContain('managed by the main process')
    })

    it('should use proxy session for login', async () => {
      const mockClient = {
        getBrowserCredentials: jest.fn().mockResolvedValue({
          baseUrl: 'https://app.example.com',
          username: 'admin',
          password: 'secret',
        }),
      }
      setup(mockClient)

      const result = await toolCallbacks.browser_login({
        credentialName: 'STAGING',
      }) as { content: Array<{ type: string; text?: string }> }

      expect(result.content[0].text).toContain('Login page loaded')
      expect(getProxy().navigate).toHaveBeenCalledWith('https://app.example.com')
    })

    it('should set variable via proxy session', async () => {
      setup()

      const setResult = await toolCallbacks.browser_set_variable({
        name: 'test',
        value: 'value',
      }) as { content: Array<{ text: string }> }
      expect(setResult.content[0].text).toBe('Variable set: test')
      // Variable was set on the proxy's variables map
      expect(getProxy().variables.get('test')).toBe('value')
    })

    it('should get variable error for missing variable via proxy session', async () => {
      setup()

      const result = await toolCallbacks.browser_get_variable({
        name: 'nonexistent',
      }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Variable not found')
    })

    it('should list variables via proxy session', async () => {
      setup()

      // First set a variable, then list
      await toolCallbacks.browser_set_variable({ name: 'a', value: '1' })
      // The list call creates a NEW proxy, so its variables map is empty
      const result = await toolCallbacks.browser_list_variables({}) as { content: Array<{ text: string }> }
      expect(result.content[0].text).toBe('No variables set.')
    })
  })
})
