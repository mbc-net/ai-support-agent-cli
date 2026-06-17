/**
 * BrowserSession — Playwright wrapper managing a singleton browser + page.
 * Auto-closes after idle timeout (5 minutes).
 * Supports live view streaming (JPEG frames) and direct interaction.
 */

import type { Browser, BrowserContext, FileChooser, Page } from 'playwright'

import { logger } from '../../../logger'
import { BrowserActionLog } from './browser-action-log'
import { BROWSER_IDLE_TIMEOUT_MS } from './browser-types'
import { DeviceEmulation, DEVICE_PRESETS } from './device-presets'
import { getElementAtPoint, getFocusedElementInfo } from './element-info'
import { loadPlaywright } from './playwright-loader'

/**
 * Browser-context script that reads the current selection.
 * Prefers the selection range of a focused input/textarea, falling back to
 * the document selection. Returns an empty string when nothing is selected.
 */
const GET_SELECTED_TEXT_SCRIPT = `() => {
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
    active.selectionStart != null &&
    active.selectionEnd != null &&
    active.selectionStart !== active.selectionEnd
  ) {
    return active.value.substring(active.selectionStart, active.selectionEnd);
  }
  const sel = window.getSelection();
  return sel ? sel.toString() : '';
}`

/**
 * Payload passed to Playwright's `FileChooser.setFiles`. Each entry carries the
 * file content as an in-memory buffer (uploaded from the web client as base64),
 * rather than a remote path on the agent host.
 */
export type FileChooserPayload = Array<{ name: string; mimeType: string; buffer: Buffer }>

export class BrowserSession {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly idleTimeoutMs: number
  private liveViewInterval: ReturnType<typeof setInterval> | null = null
  private _debouncedCapture: (() => void) | null = null
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null
  private _liveViewOnFrame: ((base64: string) => void) | null = null
  private _currentDeviceId: string | null = null
  private closed = false
  private readonly onClosed?: () => void
  private pendingFileChooser: FileChooser | null = null
  /**
   * ファイルチューザーが開いたときに呼ばれるコールバック。
   * accept(files) でファイル内容を設定する。accept は `setFiles` の結果を
   * 反映した Promise を返すため、呼び出し側で失敗を検知できる。
   */
  onFileChooser: ((accept: (files: FileChooserPayload) => Promise<void>) => void) | null = null

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

  constructor(idleTimeoutMs: number = BROWSER_IDLE_TIMEOUT_MS, onClosed?: () => void) {
    this.idleTimeoutMs = idleTimeoutMs
    this.onClosed = onClosed
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.context = await this.browser!.newContext()
    this.attachContextListeners(this.context)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.page = await this.context!.newPage()
    this.attachPageListeners(this.page)
    await this.enableFocusEmulation(this.page)

    return this.page
  }

  /**
   * Enable focus emulation so the page renders as if always focused.
   * This keeps the text caret (cursor) visible in input fields even though
   * the headless browser window itself never has OS-level focus.
   * Safe no-op on non-Chromium engines (CDP unavailable).
   */
  private async enableFocusEmulation(page: Page): Promise<void> {
    try {
      const client = await page.context().newCDPSession(page)
      await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch (error) {
      logger.warn(`[browser] Focus emulation not enabled: ${String(error)}`)
    }
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
    if (this.closed) return
    this.closed = true
    this.pendingFileChooser = null
    this.onFileChooser = null
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
      this.context = null
      this.page = null
    }
    this.onClosed?.()
  }

  /**
   * Attach context-level listeners. Registers a 'page' handler so file inputs
   * that open in a popup / new tab still surface the filechooser event.
   * Called both when the initial context is created and whenever the context is
   * recreated (e.g. by setDeviceEmulation), to avoid losing the listener.
   */
  private attachContextListeners(context: BrowserContext): void {
    context.on('page', (p: Page) => this.attachPageListeners(p))
  }

  private attachPageListeners(page: Page): void {
    page.on('filechooser', (fc: FileChooser) => {
      this.pendingFileChooser = fc
      if (this.onFileChooser) {
        // accept returns a Promise so the caller (web client relay) can detect
        // and surface setFiles failures instead of silently swallowing them.
        this.onFileChooser((files: FileChooserPayload): Promise<void> => {
          const chooser = this.pendingFileChooser
          this.pendingFileChooser = null
          if (!chooser) return Promise.resolve()
          return chooser.setFiles(files)
        })
      } else {
        fc.setFiles([]).catch(() => {})
        this.pendingFileChooser = null
      }
    })
  }

  /**
   * Set device emulation by recreating the browser context with the new userAgent.
   * This ensures the server receives the correct User-Agent on every request.
   * Pass null to clear emulation (reset to default UA).
   */
  async setDeviceEmulation(emulation: DeviceEmulation | null): Promise<void> {
    if (!this.browser) return

    // Save current state
    const currentUrl = this.page ? this.page.url() : 'about:blank'
    const currentViewport = this.page?.viewportSize() ?? { width: 1280, height: 720 }

    // Close old context (which also closes its pages)
    if (this.context) {
      try {
        await this.context.close()
      } catch {
        // ignore close errors
      }
    }

    // Create new context with the desired userAgent
    const contextOptions: Record<string, unknown> = {}
    if (emulation) {
      contextOptions.userAgent = emulation.userAgent
      contextOptions.isMobile = emulation.isMobile
      contextOptions.hasTouch = emulation.hasTouch
      contextOptions.deviceScaleFactor = emulation.deviceScaleFactor
    }
    contextOptions.viewport = currentViewport

    this.context = await this.browser.newContext(contextOptions)
    this.attachContextListeners(this.context)
    this.page = await this.context.newPage()
    this.attachPageListeners(this.page)
    await this.enableFocusEmulation(this.page)

    // Navigate back to the previous URL
    if (currentUrl && currentUrl !== 'about:blank') {
      try {
        await this.page.goto(currentUrl, { waitUntil: 'domcontentloaded' })
      } catch (error) {
        logger.debug(`[browser] Navigate after device change failed: ${String(error)}`)
      }
    }
  }

  /**
   * Set the viewport size for the current page.
   * If deviceId is a non-empty string, apply corresponding device emulation.
   * If deviceId is empty string, clear device emulation.
   * If deviceId is undefined, don't change emulation (backward compat).
   */
  async setViewport(width: number, height: number, deviceId?: string): Promise<void> {
    if (deviceId !== undefined && deviceId !== (this._currentDeviceId ?? '')) {
      // ブラウザ未起動の場合は先に起動（setDeviceEmulation は this.browser が必要）
      await this.getPage()
      // デバイスが変更された場合、先にエミュレーション変更（コンテキスト再作成）
      // → その後に新ページで viewport を設定
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
      // コンテキスト再作成後の新ページに対して viewport を設定
      const page = await this.getPage()
      await page.setViewportSize({ width, height })
    } else {
      // デバイス変更なし: ビューポートサイズのみ変更
      const page = await this.getPage()
      await page.setViewportSize({ width, height })
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
    this._liveViewOnFrame = onFrame

    let capturing = false
    this.liveViewInterval = setInterval(() => {
      if (capturing || !this.page) return
      capturing = true
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const buffer = await this.page!.screenshot({ fullPage: false, type: 'jpeg', quality: 70 }) as Buffer
          onFrame(buffer.toString('base64'))
        } catch (error) {
          logger.debug(`[browser] Live view screenshot error: ${String(error)}`)
        } finally {
          capturing = false
        }
      })()
    }, intervalMs)

    // Initialize debounced capture for event-triggered screenshots (e.g. after keyboard input)
    this._debouncedCapture = () => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer)
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null
        if (!this.page || !this._liveViewOnFrame) return
        void (async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const buffer = await this.page!.screenshot({ fullPage: false, type: 'jpeg', quality: 70 }) as Buffer
            this._liveViewOnFrame?.(buffer.toString('base64'))
          } catch (error) {
            logger.debug(`[browser] Debounced capture error: ${String(error)}`)
          }
        })()
      }, 50)
    }

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
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    this._debouncedCapture = null
    this._liveViewOnFrame = null
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
      button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left',
      clickCount: clickCount || 1,
    })

    // Use selector as primary detail for Playwright reproducibility
    const details = elementInfo
      ? elementInfo.selector
      : `page.mouse.click(${x}, ${y})`
    this.actionLog.add('direct', 'click', details)
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
   * Move the mouse to the given coordinates without pressing any button.
   * Used for drag-to-select text on the live view canvas.
   */
  async executeMouseMove(x: number, y: number): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.mouse.move(x, y)
  }

  /**
   * Move to (x, y) and press a mouse button without releasing it.
   * Pair with executeMouseMove / executeMouseUp to perform drag-selection.
   */
  async executeMouseDown(x: number, y: number, button?: string): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.mouse.move(x, y)
    await this.page.mouse.down({ button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left' })
  }

  /**
   * Move to (x, y) and release a mouse button.
   * Completes a drag-selection started by executeMouseDown.
   */
  async executeMouseUp(x: number, y: number, button?: string): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()
    await this.page.mouse.move(x, y)
    await this.page.mouse.up({ button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left' })
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

    // Use selector for fill action if focused element is fillable, otherwise type
    if (focusedInfo && (focusedInfo.tagName === 'input' || focusedInfo.tagName === 'textarea' || focusedInfo.tagName === 'select')) {
      this.actionLog.add('direct', 'fill', `${focusedInfo.selector} "${text}"`)
    } else {
      this.actionLog.add('direct', 'type', text)
    }

    this._debouncedCapture?.()
  }

  /**
   * Press a key combination.
   */
  async executeKeyboardPress(key: string, modifiers?: string[]): Promise<void> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()

    if (modifiers && modifiers.length > 0) {
      const combo = [...modifiers, key].join('+')
      await this.page.keyboard.press(combo)
    } else {
      await this.page.keyboard.press(key)
    }

    const keyStr = modifiers?.length ? `${modifiers.join('+')}+${key}` : key
    this.actionLog.add('direct', 'press', keyStr)

    this._debouncedCapture?.()
  }

  /**
   * Get the currently selected text on the page.
   * Reads the selection from a focused input/textarea, falling back to the
   * document selection for normal page content. Returns an empty string when
   * nothing is selected.
   */
  async getSelectedText(): Promise<string> {
    if (!this.page) throw new Error('No active browser page')
    this.resetIdleTimer()

    // page.evaluate のコールバックはブラウザコンテキストで実行されるため、
    // Node 側で DOM 型を解決できるよう文字列スクリプトとして渡す（element-info と同じ方針）。
    const result = await this.page.evaluate(GET_SELECTED_TEXT_SCRIPT)
    return typeof result === 'string' ? result : ''
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
