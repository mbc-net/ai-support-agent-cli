/**
 * Browser MCP tools — headless browser navigation and interaction.
 *
 * Phase 1: browser_navigate, browser_close
 * Phase 2: browser_click, browser_fill, browser_get_text, browser_login
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { logger } from '../../logger'
import { validateUrl } from './browser/browser-security'
import { BrowserSession } from './browser/browser-session'
import { isPlaywrightAvailable } from './browser/playwright-loader'
import { mcpErrorResponse, mcpTextImageResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

/**
 * Register all browser tools on the MCP server.
 */
export function registerBrowserTools(server: McpServer, apiClient: ApiClient): void {
  // Skip registration entirely if Playwright is not installed
  if (!isPlaywrightAvailable()) {
    logger.debug('[browser] Playwright not installed, skipping browser tool registration')
    return
  }

  const session = new BrowserSession()

  registerBrowserNavigateTool(server, session)
  registerBrowserCloseTool(server, session)
  registerBrowserClickTool(server, session)
  registerBrowserFillTool(server, session)
  registerBrowserGetTextTool(server, session)
  registerBrowserLoginTool(server, session, apiClient)
}

function registerBrowserNavigateTool(server: McpServer, session: BrowserSession): void {
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

      if (viewport) {
        await session.setViewport(viewport.width, viewport.height)
      }

      const page = await session.getPage()

      logger.debug(`[browser] Navigating to: ${url}`)
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

      return mcpTextImageResponse(`Page: ${title}\nURL: ${currentUrl}`, base64, 'image/png')
    }),
  )
}

function registerBrowserCloseTool(server: McpServer, session: BrowserSession): void {
  server.tool(
    'browser_close',
    'Close the browser session and free resources.',
    {},
    async () => withMcpErrorHandling(async () => {
      if (!session.isActive()) {
        return mcpTextResponse('No active browser session.')
      }
      await session.close()
      return mcpTextResponse('Browser session closed.')
    }),
  )
}

function registerBrowserClickTool(server: McpServer, session: BrowserSession): void {
  server.tool(
    'browser_click',
    'Click an element on the page. Optionally wait for navigation and take a screenshot.',
    {
      selector: z.string().describe('CSS selector of the element to click'),
      waitForNavigation: z.boolean().optional().default(false).describe('Wait for navigation after click'),
      screenshot: z.boolean().optional().default(true).describe('Take screenshot after click (default: true)'),
    },
    async ({ selector, waitForNavigation, screenshot }) => withMcpErrorHandling(async () => {
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      const page = await session.getPage()

      logger.debug(`[browser] Clicking: ${selector}`)
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

      if (screenshot) {
        const screenshotBuffer = await session.screenshot(true)
        const base64 = screenshotBuffer.toString('base64')
        return mcpTextImageResponse(statusText, base64, 'image/png')
      }

      return mcpTextResponse(statusText)
    }),
  )
}

function registerBrowserFillTool(server: McpServer, session: BrowserSession): void {
  server.tool(
    'browser_fill',
    'Fill a form field with a value.',
    {
      selector: z.string().describe('CSS selector of the input field'),
      value: z.string().describe('Value to fill'),
      screenshot: z.boolean().optional().default(false).describe('Take screenshot after fill'),
    },
    async ({ selector, value, screenshot }) => withMcpErrorHandling(async () => {
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      const page = await session.getPage()

      logger.debug(`[browser] Filling: ${selector}`)
      await page.fill(selector, value, { timeout: 10000 })

      if (screenshot) {
        const screenshotBuffer = await session.screenshot(true)
        const base64 = screenshotBuffer.toString('base64')
        return mcpTextImageResponse(`Filled: ${selector}`, base64, 'image/png')
      }

      return mcpTextResponse(`Filled: ${selector}`)
    }),
  )
}

function registerBrowserGetTextTool(server: McpServer, session: BrowserSession): void {
  server.tool(
    'browser_get_text',
    'Get text content from the page or a specific element.',
    {
      selector: z.string().optional().describe('CSS selector (default: body)'),
    },
    async ({ selector }) => withMcpErrorHandling(async () => {
      if (!session.isActive()) {
        return mcpErrorResponse('No active browser session. Use browser_navigate first.')
      }

      const page = await session.getPage()
      const target = selector ?? 'body'

      logger.debug(`[browser] Getting text: ${target}`)
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
  session: BrowserSession,
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

      // Fetch credentials from API
      const credentials = await apiClient.getBrowserCredentials(credentialName)

      const validation = validateUrl(credentials.baseUrl)
      if (!validation.valid) {
        return mcpErrorResponse(validation.reason!)
      }

      // Navigate to base URL
      const page = await session.getPage()
      await page.goto(credentials.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

      const title: string = await page.title()
      const currentUrl: string = page.url()
      const screenshotBuffer = await session.screenshot(true)
      const base64 = screenshotBuffer.toString('base64')

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
