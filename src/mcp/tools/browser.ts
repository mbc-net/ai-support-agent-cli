/**
 * Browser MCP tools — headless browser navigation and interaction.
 *
 * Phase 1: browser_navigate, browser_close
 * Phase 2: browser_click, browser_fill, browser_get_text, browser_login
 * Phase 3: browser_open_session, browser_close_session, browser_set_variable, browser_get_variable, browser_list_variables
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { logger } from '../../logger'
import { BrowserProxySession } from './browser/browser-proxy-session'
import { validateUrl } from './browser/browser-security'
import { BrowserSession } from './browser/browser-session'
import { BrowserSessionManager } from './browser/browser-session-manager'
import { isPlaywrightAvailable } from './browser/playwright-loader'
import { mcpErrorResponse, mcpTextImageResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

/**
 * Get the current browser session, using the environment variable or the manager's first session.
 * When running in a child process (MCP server), uses the local HTTP proxy if available.
 */
function getActiveSession(sessionManager: BrowserSessionManager, fallbackSession: BrowserSession): BrowserSession | BrowserProxySession {
  const browserSessionId = process.env.AI_SUPPORT_BROWSER_SESSION_ID
  const localPort = process.env.AI_SUPPORT_BROWSER_LOCAL_PORT

  if (browserSessionId) {
    // First try in-process session (main process context)
    const session = sessionManager.get(browserSessionId)
    if (session) return session

    // If local port is set, use proxy session (child process context)
    if (localPort) {
      logger.debug(`[browser] Using proxy session: sessionId=${browserSessionId}, port=${localPort}`)
      return new BrowserProxySession(`http://127.0.0.1:${localPort}`, browserSessionId)
    }
  }
  // Fall back to the default singleton session
  return fallbackSession
}

/**
 * Register all browser tools on the MCP server.
 */
export function registerBrowserTools(server: McpServer, apiClient: ApiClient, sessionManager?: BrowserSessionManager): void {
  // Skip registration entirely if Playwright is not installed
  if (!isPlaywrightAvailable()) {
    logger.debug('[browser] Playwright not installed, skipping browser tool registration')
    return
  }

  const defaultSession = new BrowserSession()
  const manager = sessionManager ?? new BrowserSessionManager()

  registerBrowserNavigateTool(server, defaultSession, manager)
  registerBrowserCloseTool(server, defaultSession, manager)
  registerBrowserClickTool(server, defaultSession, manager)
  registerBrowserFillTool(server, defaultSession, manager)
  registerBrowserGetTextTool(server, defaultSession, manager)
  registerBrowserLoginTool(server, defaultSession, manager, apiClient)
  registerBrowserSetVariableTool(server, defaultSession, manager)
  registerBrowserGetVariableTool(server, defaultSession, manager)
  registerBrowserListVariablesTool(server, defaultSession, manager)
}

function registerBrowserNavigateTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_navigate',
    'Navigate to a URL and take a screenshot. Returns the page screenshot, title, and URL.',
    {
      url: z.string().describe('URL to navigate to'),
      waitForSelector: z.string().optional().describe('CSS selector to wait for before taking screenshot'),
      waitForTimeout: z.number().optional().describe('Additional wait time in ms (max 10000)'),
      fullPage: z.boolean().optional().default(true).describe('Take full-page screenshot (default: true)'),
      viewport: z.object({
        width: z.number().min(320).max(3840),
        height: z.number().min(240).max(2160),
      }).optional().describe('Viewport size (default: 1280x720)'),
    },
    async ({ url, waitForSelector, waitForTimeout, fullPage, viewport }) => withMcpErrorHandling(async () => {
      const validation = validateUrl(url)
      if (!validation.valid) {
        return mcpErrorResponse(validation.reason!)
      }

      const session = getActiveSession(manager, defaultSession)

      logger.debug(`[browser] Navigating to: ${url}`)

      if (session instanceof BrowserProxySession) {
        const result = await session.navigate(url, { waitForSelector, waitForTimeout, fullPage: fullPage ?? true })
        const base64 = result.screenshot.toString('base64')
        session.actionLog.add('chat', 'navigate', url)
        return mcpTextImageResponse(`Page: ${result.title}\nURL: ${result.url}`, base64, 'image/png')
      }

      if (viewport) {
        await session.setViewport(viewport.width, viewport.height)
      }

      const page = await session.getPage()

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 10000 })
      }

      if (waitForTimeout) {
        const clampedTimeout = Math.min(waitForTimeout, 10000)
        await page.waitForTimeout(clampedTimeout)
      }

      const title: string = await page.title()
      const currentUrl: string = page.url()
      const screenshotBuffer = await session.screenshot(fullPage ?? true)
      const base64 = screenshotBuffer.toString('base64')

      session.actionLog.add('chat', 'navigate', url)

      return mcpTextImageResponse(`Page: ${title}\nURL: ${currentUrl}`, base64, 'image/png')
    }),
  )
}

function registerBrowserCloseTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_close',
    'Close the browser session and free resources.',
    {},
    async () => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      if (!session.isActive()) {
        return mcpTextResponse('No active browser session.')
      }
      // Proxy sessions cannot be closed from MCP child process
      if (session instanceof BrowserProxySession) {
        return mcpTextResponse('Browser session is managed by the main process.')
      }
      await session.close()
      return mcpTextResponse('Browser session closed.')
    }),
  )
}

function registerBrowserClickTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_click',
    'Click an element on the page. Optionally wait for navigation and take a screenshot.',
    {
      selector: z.string().describe('CSS selector of the element to click'),
      waitForNavigation: z.boolean().optional().default(false).describe('Wait for navigation after click'),
      screenshot: z.boolean().optional().default(true).describe('Take screenshot after click (default: true)'),
    },
    async ({ selector, waitForNavigation, screenshot }) => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      logger.debug(`[browser] Clicking: ${selector}`)

      if (session instanceof BrowserProxySession) {
        const result = await session.click(selector, { waitForNavigation: waitForNavigation ?? false, screenshot: screenshot ?? true })
        const statusText = `Clicked: ${selector}\nPage: ${result.title}\nURL: ${result.url}`
        session.actionLog.add('chat', 'click', selector)
        if (result.screenshot) {
          return mcpTextImageResponse(statusText, result.screenshot.toString('base64'), 'image/png')
        }
        return mcpTextResponse(statusText)
      }

      const page = await session.getPage()

      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: 30000 }).catch(() => { /* navigation may not happen */ }),
          page.click(selector, { timeout: 10000 }),
        ])
      } else {
        await page.click(selector, { timeout: 10000 })
      }

      const title: string = await page.title()
      const currentUrl: string = page.url()
      const statusText = `Clicked: ${selector}\nPage: ${title}\nURL: ${currentUrl}`

      session.actionLog.add('chat', 'click', selector)

      if (screenshot) {
        const screenshotBuffer = await session.screenshot(true)
        const base64 = screenshotBuffer.toString('base64')
        return mcpTextImageResponse(statusText, base64, 'image/png')
      }

      return mcpTextResponse(statusText)
    }),
  )
}

function registerBrowserFillTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_fill',
    'Fill a form field with a value.',
    {
      selector: z.string().describe('CSS selector of the input field'),
      value: z.string().describe('Value to fill'),
      screenshot: z.boolean().optional().default(false).describe('Take screenshot after fill'),
    },
    async ({ selector, value, screenshot }) => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      logger.debug(`[browser] Filling: ${selector}`)

      if (session instanceof BrowserProxySession) {
        const screenshotBuf = await session.fill(selector, value, screenshot ?? false)
        session.actionLog.add('chat', 'fill', selector)
        if (screenshotBuf) {
          return mcpTextImageResponse(`Filled: ${selector}`, screenshotBuf.toString('base64'), 'image/png')
        }
        return mcpTextResponse(`Filled: ${selector}`)
      }

      const page = await session.getPage()
      await page.fill(selector, value, { timeout: 10000 })

      session.actionLog.add('chat', 'fill', selector)

      if (screenshot) {
        const screenshotBuffer = await session.screenshot(true)
        const base64 = screenshotBuffer.toString('base64')
        return mcpTextImageResponse(`Filled: ${selector}`, base64, 'image/png')
      }

      return mcpTextResponse(`Filled: ${selector}`)
    }),
  )
}

function registerBrowserGetTextTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_get_text',
    'Get text content from the page or a specific element.',
    {
      selector: z.string().optional().describe('CSS selector (default: body)'),
    },
    async ({ selector }) => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      const target = selector ?? 'body'
      logger.debug(`[browser] Getting text: ${target}`)

      if (session instanceof BrowserProxySession) {
        const text = await session.getText(target)
        return mcpTextResponse(text)
      }

      const page = await session.getPage()
      const text: string = await page.locator(target).innerText({ timeout: 10000 })

      // Truncate to 50KB to avoid overwhelming the context
      const maxLength = 50 * 1024
      const truncated = text.length > maxLength ? text.substring(0, maxLength) + '\n... (truncated)' : text

      return mcpTextResponse(truncated)
    }),
  )
}

function registerBrowserLoginTool(
  server: McpServer,
  defaultSession: BrowserSession,
  manager: BrowserSessionManager,
  apiClient: ApiClient,
): void {
  server.tool(
    'browser_login',
    'Navigate to a website and retrieve saved login credentials. Returns a screenshot of the page along with username/password. Use browser_fill and browser_click to complete the login.',
    {
      credentialName: z.string().describe('Name of the browser credential (BROWSER_AUTH# prefix is added automatically)'),
    },
    async ({ credentialName }) => withMcpErrorHandling(async () => {
      logger.debug(`[browser] Logging in with credential: ${credentialName}`)

      const session = getActiveSession(manager, defaultSession)

      // Fetch credentials from API
      const credentials = await apiClient.getBrowserCredentials(credentialName)

      const validation = validateUrl(credentials.baseUrl)
      if (!validation.valid) {
        return mcpErrorResponse(validation.reason!)
      }

      let title: string
      let currentUrl: string
      let base64: string

      if (session instanceof BrowserProxySession) {
        const result = await session.navigate(credentials.baseUrl)
        title = result.title
        currentUrl = result.url
        base64 = result.screenshot.toString('base64')
        session.actionLog.add('chat', 'login', credentialName)
      } else {
        // Navigate to base URL
        const page = await session.getPage()
        await page.goto(credentials.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

        title = await page.title()
        currentUrl = page.url()
        const screenshotBuffer = await session.screenshot(true)
        base64 = screenshotBuffer.toString('base64')
        session.actionLog.add('chat', 'login', credentialName)
      }

      let statusText = `Login page loaded.\nPage: ${title}\nURL: ${currentUrl}\n\nCredentials:\n- Username: ${credentials.username}\n- Password: [provided, use browser_fill to enter]\n\nUse browser_fill to enter the username and password into the appropriate fields, then browser_click to submit the form.`

      if (credentials.promptText) {
        statusText += `\n\nAdditional instructions: ${credentials.promptText}`
      }
      if (credentials.customFields && Object.keys(credentials.customFields).length > 0) {
        statusText += `\n\nCustom fields: ${JSON.stringify(credentials.customFields)}`
      }

      return {
        content: [
          { type: 'text' as const, text: statusText },
          { type: 'image' as const, data: base64, mimeType: 'image/png' },
          { type: 'text' as const, text: `__CREDENTIALS__\nusername: ${credentials.username}\npassword: ${credentials.password}` },
        ],
      }
    }),
  )
}

// --- Session variable tools ---

function registerBrowserSetVariableTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_set_variable',
    'Set a temporary variable in the current browser session. Variables are session-scoped and lost when the session closes.',
    {
      name: z.string().describe('Variable name'),
      value: z.string().describe('Variable value'),
    },
    async ({ name, value }) => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      session.variables.set(name, value)
      return mcpTextResponse(`Variable set: ${name}`)
    }),
  )
}

function registerBrowserGetVariableTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_get_variable',
    'Get the value of a temporary variable from the current browser session.',
    {
      name: z.string().describe('Variable name'),
    },
    async ({ name }) => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      const value = session.variables.get(name)
      if (value === undefined) {
        return mcpErrorResponse(`Variable not found: ${name}`)
      }
      return mcpTextResponse(value)
    }),
  )
}

function registerBrowserListVariablesTool(server: McpServer, defaultSession: BrowserSession, manager: BrowserSessionManager): void {
  server.tool(
    'browser_list_variables',
    'List all temporary variables in the current browser session.',
    {},
    async () => withMcpErrorHandling(async () => {
      const session = getActiveSession(manager, defaultSession)
      const entries = Array.from(session.variables.entries())
      if (entries.length === 0) {
        return mcpTextResponse('No variables set.')
      }
      const text = entries.map(([k, v]) => `${k}=${v}`).join('\n')
      return mcpTextResponse(text)
    }),
  )
}
