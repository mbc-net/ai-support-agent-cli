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
import { getCursorAt, getElementAtPoint, getFocusedElementInfo } from './element-info'
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
 * Payload passed to Playwright's `FileChooser.setFiles`.
 *  - `string[]`: absolute paths on the agent FS (workspace files chosen by the user).
 *  - `Array<{name,mimeType,buffer}>`: in-memory file content uploaded from the web client
 *    as base64. Playwright forwards the buffer directly to the browser via CDP, so no
 *    temp files are needed and there is no race between file deletion and browser read.
 */
export type FileChooserPayload =
  | string[]
  | Array<{ name: string; mimeType: string; buffer: Buffer }>

/**
 * Payload emitted to the Web client when the focused input/textarea changes,
 * its value/selection changes, or focus leaves a reporting target.
 *
 * Mirrors the `browser_focus_changed` wire contract (rect and below). When
 * `focused` is false, the overlay is hidden and the remaining fields are
 * omitted. Coordinates in `rect` are getBoundingClientRect raw values
 * (CSS px, viewport-relative).
 */
export interface FocusChangePayload {
  /** Whether a reporting-target input/textarea is focused. false hides overlay. */
  focused: boolean
  /** getBoundingClientRect of the focused element (CSS px, viewport-relative). */
  rect?: { x: number; y: number; width: number; height: number }
  /** Current value of the element. */
  value?: string
  selectionStart?: number
  selectionEnd?: number
  /** True when the element is a <textarea>. */
  multiline?: boolean
  /** input `type` attribute ('text'|'password'|... / 'textarea' for textarea). */
  inputType?: string
  /** maxLength attribute (omitted when -1/unset). */
  maxLength?: number
  /** Computed font-size in px. */
  fontSize?: number
  /** Computed line-height in px (omitted when 'normal'/non-numeric). */
  lineHeight?: number
  /** Computed text-align. */
  textAlign?: string
  /** Computed padding-top in px. */
  paddingTop?: number
  /** Computed padding-left in px. */
  paddingLeft?: number
}

/**
 * Browser-context script installed (idempotently) into the page to report
 * focus/value/selection changes of simple input/textarea elements back to the
 * agent via the `window.__onBrowserFocus` binding exposed by Playwright.
 *
 * Runs in the browser, so it is a string passed to addInitScript / evaluate to
 * avoid Node resolving DOM types (same convention as element-info scripts).
 *
 * Listens in the capture phase for focusin/focusout/input/selectionchange and,
 * for reporting targets (textarea, or input whose type is one of the simple
 * text-like types), builds and sends the focus payload. focusout / non-target
 * elements send `{ focused: false }`.
 *
 * Listener registration is guarded by `window.__browserFocusReportingInstalled`
 * so re-evaluating the script (e.g. after a navigation, or via reportFocusNow)
 * does not double-register handlers. The INITIAL report, however, runs on EVERY
 * evaluation (outside the guard): `focusin` only fires on focus CHANGES after
 * registration, so an element that is already focused at injection time (e.g. an
 * autofocused login field) would otherwise never be reported and its overlay
 * caret would never appear. Reporting the current activeElement at the end of
 * each evaluation surfaces such elements for both addInitScript (new document)
 * and evaluate (existing/re-evaluated document) injection paths.
 */
export const FOCUS_REPORTING_SCRIPT = `() => {
  // The per-document focus reporting state (listeners + lastReportedFocused) is
  // installed once. Hang the report() helper off window so a re-evaluation that
  // skips re-registration can still invoke the initial report below.
  if (!window.__browserFocusReportingInstalled) {
    window.__browserFocusReportingInstalled = true;

    // Last focused state reported to the agent. Used to suppress repeated
    // { focused: false } notifications: selectionchange fires for the whole
    // document (including unrelated page text selections), so without this guard
    // every such selection would emit a redundant focused:false. We only forward
    // a false when transitioning from a previously-focused (true) state.
    var lastReportedFocused = false;

    // Forward a payload through the exposed binding, recording the new focused
    // state and logging the first failure once (high-frequency events would
    // otherwise flood the browser console).
    function emit(payload) {
      lastReportedFocused = payload.focused;
      try {
        window.__onBrowserFocus(payload);
      } catch (e) {
        if (!window.__focusReportErrorLogged) {
          window.__focusReportErrorLogged = true;
          try { console.warn('[focus-reporting] report failed', e && e.message ? e.message : e); } catch (_) {}
        }
      }
    }

    function isReportingTarget(el) {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag !== 'INPUT') return false;
      const type = (el.getAttribute('type') || '').toLowerCase();
      return type === '' || type === 'text' || type === 'search' || type === 'email' ||
        type === 'url' || type === 'tel' || type === 'password' || type === 'number';
    }

    function buildPayload(el) {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize);
      const lineHeight = parseFloat(cs.lineHeight);
      const paddingTop = parseFloat(cs.paddingTop);
      const paddingLeft = parseFloat(cs.paddingLeft);
      const multiline = el.tagName === 'TEXTAREA';
      const payload = {
        focused: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        value: el.value,
        selectionStart: el.selectionStart == null ? undefined : el.selectionStart,
        selectionEnd: el.selectionEnd == null ? undefined : el.selectionEnd,
        multiline: multiline,
        inputType: multiline ? 'textarea' : ((el.getAttribute('type') || 'text').toLowerCase()),
        textAlign: cs.textAlign,
      };
      if (typeof el.maxLength === 'number' && el.maxLength >= 0) payload.maxLength = el.maxLength;
      if (!Number.isNaN(fontSize)) payload.fontSize = fontSize;
      if (!Number.isNaN(lineHeight)) payload.lineHeight = lineHeight;
      if (!Number.isNaN(paddingTop)) payload.paddingTop = paddingTop;
      if (!Number.isNaN(paddingLeft)) payload.paddingLeft = paddingLeft;
      return payload;
    }

    // Report focused:true (with current value/selection) whenever a reporting
    // target is active; report focused:false only on the true->false transition.
    // Exposed on window so a guarded re-evaluation can still trigger the initial
    // report without re-registering listeners.
    window.__browserFocusReport = function () {
      const el = document.activeElement;
      if (isReportingTarget(el)) {
        emit(buildPayload(el));
      } else if (lastReportedFocused) {
        emit({ focused: false });
      }
    };

    document.addEventListener('focusin', window.__browserFocusReport, true);
    document.addEventListener('focusout', function () {
      if (lastReportedFocused) emit({ focused: false });
    }, true);
    document.addEventListener('input', window.__browserFocusReport, true);
    document.addEventListener('selectionchange', window.__browserFocusReport, true);
  }

  // Initial report on EVERY evaluation: surfaces an element that is already
  // focused at injection time (autofocus) for which focusin will never fire.
  if (typeof window.__browserFocusReport === 'function') window.__browserFocusReport();
}`

/**
 * Browser-context script that reflects a value into the currently-focused
 * reporting-target input/textarea using the native value setter +
 * InputEvent('input') dispatch, so React-style controlled components do not
 * roll the value back. Optionally applies a selection range.
 *
 * No-op when the active element is not a reporting target. String script for
 * the same reason as the others (DOM types resolved in the browser).
 */
export const SET_FOCUSED_INPUT_VALUE_SCRIPT = `(args) => {
  const el = document.activeElement;
  if (!el) return;
  const tag = el.tagName;
  let proto;
  if (tag === 'TEXTAREA') {
    proto = window.HTMLTextAreaElement.prototype;
  } else if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ok = type === '' || type === 'text' || type === 'search' || type === 'email' ||
      type === 'url' || type === 'tel' || type === 'password' || type === 'number';
    if (!ok) return;
    proto = window.HTMLInputElement.prototype;
  } else {
    return;
  }
  // The native value setter may be absent on exotic/polyfilled prototypes;
  // treat that as a no-op (same as a non-reporting target) rather than letting
  // a TypeError escape from reading .set of undefined.
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = desc && desc.set;
  if (!setter) return;
  setter.call(el, args.value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  if (args.selectionStart != null && args.selectionEnd != null) {
    try { el.setSelectionRange(args.selectionStart, args.selectionEnd); } catch (e) {}
  }
}`

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
  private _lastFrameData: string | null = null
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
   * フォーカスされた報告対象 input/textarea の変化を Web 側へ通知するコールバック。
   * `enableFocusReporting` が exposeBinding 経由でブラウザからのイベントを受けてこれを呼ぶ。
   */
  onFocusChange: ((payload: FocusChangePayload) => void) | null = null

  /**
   * `page.exposeBinding('__onBrowserFocus', ...)` を一度だけ呼ぶためのガード。
   * 同じ名前の binding を二重登録すると Playwright が例外を投げるため。
   */
  private focusReportingExposed = false

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
    await this.enableFocusReporting(this.page)

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
   * Install focus/value/selection reporting for simple input/textarea elements.
   *
   * Exposes the `__onBrowserFocus` binding once per session (guarded by
   * `focusReportingExposed`; re-exposing the same name throws in Playwright),
   * then injects FOCUS_REPORTING_SCRIPT both as an init script (for future
   * navigations) and into the current document (for the already-loaded page).
   * The script is idempotent via `window.__browserFocusReportingInstalled`.
   *
   * Binding exposure and script injection are wrapped in SEPARATE try/catch
   * blocks so a partial failure stays isolated: a failed binding expose must
   * not prevent the script from being injected, and a failed script injection
   * must not flip `focusReportingExposed` back (which would later trigger a
   * duplicate-name re-expose that throws). The `focusReportingExposed` guard is
   * only set true after the expose actually succeeds, and only the expose path
   * is gated by it — script injection is attempted on every page so it is not
   * coupled to whether the binding was (re-)exposed this call.
   *
   * Mirrors enableFocusEmulation's policy: failures are logged via warn and
   * never propagated — focus reporting is best-effort and not critical.
   */
  private async enableFocusReporting(page: Page): Promise<void> {
    if (!this.focusReportingExposed) {
      try {
        await page.exposeBinding(
          '__onBrowserFocus',
          (_src, payload: FocusChangePayload) => this.onFocusChange?.(payload),
        )
        this.focusReportingExposed = true
      } catch (error) {
        logger.warn(`[browser] Focus reporting binding not exposed: ${String(error)}`)
      }
    }
    try {
      await page.addInitScript(FOCUS_REPORTING_SCRIPT)
      await page.evaluate(FOCUS_REPORTING_SCRIPT)
    } catch (error) {
      logger.warn(`[browser] Focus reporting script not injected: ${String(error)}`)
    }
  }

  /**
   * Re-evaluate FOCUS_REPORTING_SCRIPT against the CURRENT document to force an
   * immediate focus report.
   *
   * Needed after a navigation/goto: the document is replaced, so an element that
   * the page autofocuses (e.g. a login field) is already focused by the time the
   * agent regains control. `focusin` only fires on focus CHANGES, so without an
   * explicit re-evaluation that element would never be reported and the overlay
   * caret would never appear. The script's listener registration is idempotent
   * (guarded), so this only triggers the initial report; the `__onBrowserFocus`
   * binding is intentionally NOT re-exposed here (it is session-scoped and would
   * throw on a duplicate name). No-op when no page is active; failures are warned
   * and swallowed, mirroring enableFocusReporting's best-effort policy.
   */
  async reportFocusNow(): Promise<void> {
    if (!this.page) return
    try {
      await this.page.evaluate(FOCUS_REPORTING_SCRIPT)
    } catch (error) {
      logger.warn(`[browser] Focus re-report failed: ${String(error)}`)
    }
  }

  /**
   * Reflect a value into the currently-focused reporting-target input/textarea.
   *
   * Uses the native value setter + InputEvent('input') dispatch so controlled
   * React components do not roll the value back, and applies the selection range
   * when both bounds are provided. No-op when the active element is not a
   * reporting target. Throws when no page is active.
   */
  async setFocusedInputValue(
    value: string,
    selectionStart?: number,
    selectionEnd?: number,
  ): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.evaluate(SET_FOCUSED_INPUT_VALUE_SCRIPT, { value, selectionStart, selectionEnd })
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
    // Symmetric with onFileChooser: drop the focus-change callback so a closed
    // session cannot keep the Web-side WebSocket alive via this reference.
    this.onFocusChange = null
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
    // The exposeBinding lives on the (now-closed) page; the fresh page below
    // needs its own binding, so allow enableFocusReporting to re-expose it.
    this.focusReportingExposed = false

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
    await this.enableFocusReporting(this.page)

    // Navigate back to the previous URL
    if (currentUrl && currentUrl !== 'about:blank') {
      try {
        await this.page.goto(currentUrl, { waitUntil: 'domcontentloaded' })
        // Re-report focus on the freshly reloaded document: enableFocusReporting
        // above re-wired the binding + listeners, but focusin only fires on focus
        // CHANGES, so an element the page autofocuses (e.g. a login field) after
        // this goto would otherwise never surface its overlay caret. Skip when no
        // goto happened (about:blank path) — there is nothing newly loaded.
        await this.reportFocusNow()
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
          const base64 = buffer.toString('base64')
          if (base64 === this._lastFrameData) return
          this._lastFrameData = base64
          onFrame(base64)
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
            const base64 = buffer.toString('base64')
            if (base64 === this._lastFrameData) return
            this._lastFrameData = base64
            this._liveViewOnFrame?.(base64)
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
    this._lastFrameData = null
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
    const page = this.assertPageActive()
    this.resetIdleTimer()

    // Get element info BEFORE click (element might change after click)
    const elementInfo = await getElementAtPoint(page, x, y)

    await page.mouse.click(x, y, {
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
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.mouse.wheel(deltaX, deltaY)
    this.actionLog.add('direct', 'scroll', `deltaX=${deltaX} deltaY=${deltaY}`)
  }

  /**
   * Move the mouse to the given coordinates without pressing any button.
   * Used for drag-to-select text on the live view canvas.
   */
  async executeMouseMove(x: number, y: number): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.mouse.move(x, y)
  }

  /**
   * Read the CSS `cursor` value of the element at the given coordinates.
   * Used by the live view to mirror the page's cursor shape on the web canvas.
   * Throws when no page is active; propagates page.evaluate errors so the
   * caller can skip the update for that frame.
   */
  async getCursorAt(x: number, y: number): Promise<string> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    return getCursorAt(page, x, y)
  }

  /**
   * Move to (x, y) and press a mouse button without releasing it.
   * Pair with executeMouseMove / executeMouseUp to perform drag-selection.
   */
  async executeMouseDown(x: number, y: number, button?: string): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.mouse.move(x, y)
    await page.mouse.down({ button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left' })
  }

  /**
   * Move to (x, y) and release a mouse button.
   * Completes a drag-selection started by executeMouseDown.
   */
  async executeMouseUp(x: number, y: number, button?: string): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.mouse.move(x, y)
    await page.mouse.up({ button: (button as 'left' | 'right' | 'middle' | undefined) ?? 'left' })
  }

  /**
   * Type text into the focused element.
   */
  async executeKeyboardType(text: string): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()

    // Get focused element info for Playwright context
    const focusedInfo = await getFocusedElementInfo(page)

    await page.keyboard.type(text)

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
    const page = this.assertPageActive()
    this.resetIdleTimer()

    if (modifiers && modifiers.length > 0) {
      const combo = [...modifiers, key].join('+')
      await page.keyboard.press(combo)
    } else {
      await page.keyboard.press(key)
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
    const page = this.assertPageActive()
    this.resetIdleTimer()

    // page.evaluate のコールバックはブラウザコンテキストで実行されるため、
    // Node 側で DOM 型を解決できるよう文字列スクリプトとして渡す（element-info と同じ方針）。
    const result = await page.evaluate(GET_SELECTED_TEXT_SCRIPT)
    return typeof result === 'string' ? result : ''
  }

  /**
   * Navigate back.
   */
  async goBack(): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.goBack()
    this.actionLog.add('direct', 'go_back', this.getCurrentUrl())
  }

  /**
   * Navigate forward.
   */
  async goForward(): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.goForward()
    this.actionLog.add('direct', 'go_forward', this.getCurrentUrl())
  }

  /**
   * Reload the page.
   */
  async reload(): Promise<void> {
    const page = this.assertPageActive()
    this.resetIdleTimer()
    await page.reload()
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
   * Whether this session is still usable (not closed). Used by the resume path
   * to decide between reusing an existing live session and replying
   * `resume_failed` so the Web client can fall back to a fresh open.
   */
  get isAlive(): boolean {
    return !this.closed
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

  private assertPageActive(): Page {
    if (!this.page) throw new Error('No active browser page')
    return this.page
  }
}
