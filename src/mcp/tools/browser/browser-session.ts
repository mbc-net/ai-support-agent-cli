/**
 * BrowserSession — Playwright wrapper managing a singleton browser + page.
 * Auto-closes after idle timeout (5 minutes).
 */

import { logger } from '../../../logger'
import { BROWSER_IDLE_TIMEOUT_MS } from './browser-types'
import { loadPlaywright } from './playwright-loader'

// Playwright types (used loosely to avoid hard dependency)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browser = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any

export class BrowserSession {
  private browser: Browser | null = null
  private page: Page | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleTimeoutMs: number

  constructor(idleTimeoutMs: number = BROWSER_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs
  }

  /**
   * Get the current page, launching browser if needed.
   */
  async getPage(): Promise<Page> {
    this.resetIdleTimer()

    if (this.page) {
      return this.page
    }

    const pw = loadPlaywright()
    logger.debug('[browser] Launching Chromium (headless)')
    this.browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    this.page = await this.browser.newPage()
    return this.page
  }

  /**
   * Check if a browser session is currently active.
   */
  isActive(): boolean {
    return this.browser !== null
  }

  /**
   * Close the browser and clean up resources.
   */
  async close(): Promise<void> {
    this.clearIdleTimer()
    if (this.browser) {
      logger.debug('[browser] Closing browser')
      try {
        await this.browser.close()
      } catch (error) {
        logger.debug(`[browser] Error closing browser: ${String(error)}`)
      }
      this.browser = null
      this.page = null
    }
  }

  /**
   * Set the viewport size for the current page.
   */
  async setViewport(width: number, height: number): Promise<void> {
    const page = await this.getPage()
    await page.setViewportSize({ width, height })
  }

  /**
   * Take a screenshot of the current page.
   */
  async screenshot(fullPage: boolean = true): Promise<Buffer> {
    const page = await this.getPage()
    return page.screenshot({ fullPage, type: 'png' }) as Promise<Buffer>
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      logger.debug('[browser] Idle timeout reached, closing browser')
      void this.close()
    }, this.idleTimeoutMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
