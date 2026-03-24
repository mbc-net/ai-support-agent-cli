/**
 * BrowserSession — Playwright wrapper managing a singleton browser + page.
 * Auto-closes after idle timeout (5 minutes).
 * Supports live view streaming (JPEG frames) and direct interaction.
 */

import { logger } from '../../../logger'
import { BrowserActionLog } from './browser-action-log'
import { BROWSER_IDLE_TIMEOUT_MS } from './browser-types'
import { DeviceEmulation, DEVICE_PRESETS } from './device-presets'
import { getElementAtPoint, getFocusedElementInfo, formatElementInfo } from './element-info'
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
  private liveViewInterval: ReturnType<typeof setInterval> | null = null
  private _currentDeviceId: string | null = null

  /**
   * Get the currently active device emulation ID, or null if none.
   */
  get currentDeviceId(): string | null {
    return this._currentDeviceId
  }

  /** Session-scoped temporary variables */
  readonly variables = new Map<string, string>()

  /** Action log for recording browser operations */
  readonly actionLog = new BrowserActionLog()

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
    this.stopLiveView()
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
   * Set device emulation (User-Agent, touch, platform overrides).
   * Pass null to clear emulation.
   */
  async setDeviceEmulation(emulation: DeviceEmulation | null): Promise<void> {
    const page = await this.getPage()

    if (emulation) {
      await page.setExtraHTTPHeaders({ 'User-Agent': emulation.userAgent })

      const ua = emulation.userAgent
      const maxTouchPoints = emulation.hasTouch ? 5 : 0
      let platform = 'Win32'
      if (ua.includes('iPhone')) {
        platform = 'iPhone'
      } else if (ua.includes('iPad')) {
        platform = 'iPad'
      } else if (ua.includes('Linux') || ua.includes('Android')) {
        platform = 'Linux armv8l'
      }

      await page.addInitScript(`
        Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(ua)} });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${maxTouchPoints} });
        Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(platform)} });
      `)
    } else {
      await page.setExtraHTTPHeaders({})
      // addInitScript は蓄積される（Playwright仕様）。
      // 最後の defineProperty が有効になるため機能的には問題なし。
      // コンテキスト再作成（V2）で解消予定。
      await page.addInitScript('// device emulation cleared')
    }
  }

  /**
   * Set the viewport size for the current page.
   * If deviceId is a non-empty string, apply corresponding device emulation.
   * If deviceId is empty string, clear device emulation.
   * If deviceId is undefined, don't change emulation (backward compat).
   */
  async setViewport(width: number, height: number, deviceId?: string): Promise<void> {
    const page = await this.getPage()
    await page.setViewportSize({ width, height })

    if (deviceId !== undefined) {
      if (deviceId === '') {
        await this.setDeviceEmulation(null)
        this._currentDeviceId = null
      } else {
        const preset = DEVICE_PRESETS[deviceId]
        if (preset) {
          await this.setDeviceEmulation(preset)
          this._currentDeviceId = deviceId
        }
      }
    }
  }

  /**
   * Take a screenshot of the current page.
   */
  async screenshot(fullPage: boolean = true): Promise<Buffer> {
    const page = await this.getPage()
    return page.screenshot({ fullPage, type: 'png' }) as Promise<Buffer>
  }

  // --- Live View ---

  /**
   * Start live view streaming. Takes JPEG screenshots at the specified interval
   * and calls the onFrame callback with the base64-encoded data.
   * While live view is active, the idle timeout is disabled.
   */
  startLiveView(intervalMs: number, onFrame: (base64: string) => void): void {
    this.stopLiveView()
    this.clearIdleTimer() // Disable idle timeout during live view

    let capturing = false
    this.liveViewInterval = setInterval(() => {
      if (capturing || !this.page) return
      capturing = true
      void (async () => {
        try {
          const buffer = await this.page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 }) as Buffer
          onFrame(buffer.toString('base64'))
        } catch (error) {
          logger.debug(`[browser] Live view screenshot error: ${String(error)}`)
        } finally {
          capturing = false
        }
      })()
    }, intervalMs)

    logger.debug(`[browser] Live view started (interval=${intervalMs}ms)`)
  }

  /**
   * Stop live view streaming and re-enable idle timeout.
   */
  stopLiveView(): void {
    if (this.liveViewInterval) {
      clearInterval(this.liveViewInterval)
      this.liveViewInterval = null
      logger.debug('[browser] Live view stopped')
    }
    // Re-enable idle timeout
    if (this.isActive()) {
      this.resetIdleTimer()
    }
  }

  /**
   * Check if live view is currently active.
   */
  isLiveViewActive(): boolean {
    return this.liveViewInterval !== null
  }

  // --- Direct Interaction ---

  /**
   * Click at the specified coordinates.
   */
  async executeMouseClick(x: number, y: number, button?: string, clickCount?: number): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()

    // Get element info BEFORE click (element might change after click)
    const elementInfo = await getElementAtPoint(this.page, x, y)

    await this.page.mouse.click(x, y, {
      button: button || 'left',
      clickCount: clickCount || 1,
    })

    const elementDesc = elementInfo ? formatElementInfo(elementInfo) : '(no element)'
    this.actionLog.add('direct', 'click', `(${x}, ${y}) ${elementDesc}`)
  }

  /**
   * Scroll the page.
   */
  async executeMouseWheel(deltaX: number, deltaY: number): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.mouse.wheel(deltaX, deltaY)
    this.actionLog.add('direct', 'scroll', `deltaX=${deltaX} deltaY=${deltaY}`)
  }

  /**
   * Type text into the focused element.
   */
  async executeKeyboardType(text: string): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()

    // Get focused element info for Playwright context
    const focusedInfo = await getFocusedElementInfo(this.page)

    await this.page.keyboard.type(text)

    const target = focusedInfo ? `target=${formatElementInfo(focusedInfo)}` : '(no focused element)'
    this.actionLog.add('direct', 'type', `"${text}" ${target}`)
  }

  /**
   * Press a key combination.
   */
  async executeKeyboardPress(key: string, modifiers?: string[]): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()

    const focusedInfo = await getFocusedElementInfo(this.page)

    if (modifiers && modifiers.length > 0) {
      const combo = [...modifiers, key].join('+')
      await this.page.keyboard.press(combo)
    } else {
      await this.page.keyboard.press(key)
    }

    const keyStr = modifiers?.length ? `${modifiers.join('+')}+${key}` : key
    const target = focusedInfo ? `target=${formatElementInfo(focusedInfo)}` : ''
    this.actionLog.add('direct', 'press', target ? `${keyStr} ${target}` : keyStr)
  }

  /**
   * Navigate back.
   */
  async goBack(): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.goBack()
    this.actionLog.add('direct', 'go_back', this.getCurrentUrl())
  }

  /**
   * Navigate forward.
   */
  async goForward(): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.goForward()
    this.actionLog.add('direct', 'go_forward', this.getCurrentUrl())
  }

  /**
   * Reload the page.
   */
  async reload(): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.reload()
    this.actionLog.add('direct', 'reload', this.getCurrentUrl())
  }

  /**
   * Get current page URL.
   */
  getCurrentUrl(): string {
    if (!this.page) return ''
    return this.page.url() as string
  }

  /**
   * Get current page title.
   */
  async getPageTitle(): Promise<string> {
    if (!this.page) return ''
    return this.page.title() as Promise<string>
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    // Don't set idle timer during live view
    if (this.liveViewInterval) return
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
