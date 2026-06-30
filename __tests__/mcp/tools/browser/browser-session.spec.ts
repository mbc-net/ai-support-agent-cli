import {
  BrowserSession,
  FileChooserPayload,
  FocusChangePayload,
} from '../../../../src/mcp/tools/browser/browser-session'

// Mock playwright-loader
jest.mock('../../../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
}))

jest.mock('../../../../src/logger')

jest.mock('../../../../src/mcp/tools/browser/element-info', () => ({
  getElementAtPoint: jest.fn(),
  getFocusedElementInfo: jest.fn(),
  getCursorAt: jest.fn(),
}))

import { loadPlaywright } from '../../../../src/mcp/tools/browser/playwright-loader'
import { getCursorAt, getFocusedElementInfo } from '../../../../src/mcp/tools/browser/element-info'
import { logger } from '../../../../src/logger'

const mockGetFocusedElementInfo = getFocusedElementInfo as jest.MockedFunction<typeof getFocusedElementInfo>
const mockGetCursorAt = getCursorAt as jest.MockedFunction<typeof getCursorAt>
const mockLogger = logger as jest.Mocked<typeof logger>

const mockLoadPlaywright = loadPlaywright as jest.MockedFunction<typeof loadPlaywright>

describe('BrowserSession', () => {
  let mockPage: Record<string, jest.Mock>
  let mockContext: Record<string, jest.Mock>
  let mockBrowser: Record<string, jest.Mock>
  let mockPlaywright: { chromium: { launch: jest.Mock } }
  let mockCdpSession: { send: jest.Mock }

  beforeEach(() => {
    jest.useFakeTimers()

    // Default: no focused element
    mockGetFocusedElementInfo.mockResolvedValue(null)
    mockGetCursorAt.mockResolvedValue('default')

    mockCdpSession = { send: jest.fn().mockResolvedValue(undefined) }

    mockCdpSession = { send: jest.fn().mockResolvedValue(undefined) }

    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      title: jest.fn().mockResolvedValue('Test Page'),
      url: jest.fn().mockReturnValue('https://example.com'),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      setViewportSize: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      exposeBinding: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(''),
      viewportSize: jest.fn().mockReturnValue({ width: 1280, height: 720 }),
      on: jest.fn(),
      // page.context() returns the owning context (used for CDP focus emulation)
      context: jest.fn(() => mockContext),
      keyboard: {
        type: jest.fn().mockResolvedValue(undefined),
        press: jest.fn().mockResolvedValue(undefined),
      },
      mouse: {
        click: jest.fn().mockResolvedValue(undefined),
        wheel: jest.fn().mockResolvedValue(undefined),
        move: jest.fn().mockResolvedValue(undefined),
        down: jest.fn().mockResolvedValue(undefined),
        up: jest.fn().mockResolvedValue(undefined),
      },
    }

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
      newCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
      on: jest.fn(),
    }

    mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext),
      close: jest.fn().mockResolvedValue(undefined),
    }

    mockPlaywright = {
      chromium: {
        launch: jest.fn().mockResolvedValue(mockBrowser),
      },
    }

    mockLoadPlaywright.mockReturnValue(mockPlaywright)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('getPage', () => {
    it('should launch browser and return page on first call', async () => {
      const session = new BrowserSession()
      const page = await session.getPage()

      expect(mockPlaywright.chromium.launch).toHaveBeenCalledWith({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
      expect(mockBrowser.newContext).toHaveBeenCalled()
      expect(mockContext.newPage).toHaveBeenCalled()
      expect(page).toBe(mockPage)
    })

    it('should reuse existing page on subsequent calls', async () => {
      const session = new BrowserSession()
      const page1 = await session.getPage()
      const page2 = await session.getPage()

      expect(page1).toBe(page2)
      expect(mockPlaywright.chromium.launch).toHaveBeenCalledTimes(1)
    })
  })

  describe('isActive', () => {
    it('should return false before browser is launched', () => {
      const session = new BrowserSession()
      expect(session.isActive()).toBe(false)
    })

    it('should return true after browser is launched', async () => {
      const session = new BrowserSession()
      await session.getPage()
      expect(session.isActive()).toBe(true)
    })

    it('should return false after close', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.close()
      expect(session.isActive()).toBe(false)
    })
  })

  describe('isAlive', () => {
    it('should return true for a brand-new (not yet launched) session', () => {
      // A session is "alive" until explicitly closed — the resume path uses this
      // to decide reuse vs. resume_failed, independent of whether a page exists.
      const session = new BrowserSession()
      expect(session.isAlive).toBe(true)
    })

    it('should return true after the browser is launched', async () => {
      const session = new BrowserSession()
      await session.getPage()
      expect(session.isAlive).toBe(true)
    })

    it('should return false after close', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.close()
      expect(session.isAlive).toBe(false)
    })
  })

  describe('close', () => {
    it('should close browser and clean up', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.close()

      expect(mockBrowser.close).toHaveBeenCalled()
      expect(session.isActive()).toBe(false)
    })

    it('should be safe to call when no browser is active', async () => {
      const session = new BrowserSession()
      await expect(session.close()).resolves.not.toThrow()
    })

    it('should handle browser.close() errors gracefully', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.close.mockRejectedValue(new Error('close failed'))

      await expect(session.close()).resolves.not.toThrow()
      expect(session.isActive()).toBe(false)
    })

    it('should clear onFileChooser and onFocusChange callbacks on close', async () => {
      const session = new BrowserSession()
      session.onFileChooser = () => {}
      session.onFocusChange = () => {}
      await session.getPage()

      await session.close()

      // Both callbacks are dropped symmetrically so a closed session cannot keep
      // the Web-side WebSocket alive through a retained reference.
      expect(session.onFileChooser).toBeNull()
      expect(session.onFocusChange).toBeNull()
    })
  })

  describe('setViewport', () => {
    it('should set viewport size on the page', async () => {
      const session = new BrowserSession()
      await session.setViewport(1920, 1080)

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 })
    })
  })

  describe('screenshot', () => {
    it('should take full-page screenshot by default', async () => {
      const session = new BrowserSession()
      await session.getPage()
      const result = await session.screenshot()

      expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: true, type: 'png' })
      expect(Buffer.isBuffer(result)).toBe(true)
    })

    it('should take viewport-only screenshot when fullPage is false', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.screenshot(false)

      expect(mockPage.screenshot).toHaveBeenCalledWith({ fullPage: false, type: 'png' })
    })
  })

  describe('setDeviceEmulation', () => {
    it('should recreate context with iPhone userAgent', async () => {
      const session = new BrowserSession()
      await session.getPage() // initialize
      mockBrowser.newContext.mockClear()

      const emulation = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      }
      await session.setDeviceEmulation(emulation)

      // Should close old context and create a new one with userAgent
      expect(mockContext.close).toHaveBeenCalled()
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: emulation.userAgent,
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
        }),
      )
      // Should navigate back to the current URL
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' })
    })

    it('should recreate context with Android userAgent', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.newContext.mockClear()

      const emulation = {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.625,
      }
      await session.setDeviceEmulation(emulation)

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ userAgent: emulation.userAgent }),
      )
    })

    it('should recreate context without userAgent when clearing emulation', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.newContext.mockClear()

      await session.setDeviceEmulation(null)

      expect(mockContext.close).toHaveBeenCalled()
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ viewport: { width: 1280, height: 720 } }),
      )
      // Should not include userAgent in context options
      const callArgs = mockBrowser.newContext.mock.calls[0][0]
      expect(callArgs.userAgent).toBeUndefined()
    })

    it('should not navigate when page was about:blank', async () => {
      mockPage.url.mockReturnValue('about:blank')
      const session = new BrowserSession()
      await session.getPage()
      mockPage.goto.mockClear()

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // goto should only be called for newPage, not for re-navigation
      expect(mockPage.goto).not.toHaveBeenCalled()
    })

    it('should do nothing if browser is not launched', async () => {
      const session = new BrowserSession()
      // Don't call getPage() — browser is null
      await session.setDeviceEmulation({
        userAgent: 'test',
        isMobile: false,
        hasTouch: false,
        deviceScaleFactor: 1,
      })
      expect(mockBrowser.newContext).not.toHaveBeenCalled()
    })

    it('should handle goto error gracefully after device change', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.newContext.mockClear()
      // Make goto fail on the new page
      mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'))

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // Should not throw — error is caught internally
      expect(mockBrowser.newContext).toHaveBeenCalled()
    })

    it('should handle context close error gracefully', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockContext.close.mockRejectedValueOnce(new Error('Already closed'))
      mockBrowser.newContext.mockClear()

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      expect(mockBrowser.newContext).toHaveBeenCalled()
    })

    it('should re-report focus AFTER the goto so an autofocused field shows its caret', async () => {
      const session = new BrowserSession()
      await session.getPage()
      const reportSpy = jest.spyOn(session, 'reportFocusNow')

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // The initial focus report must run after navigating back to the previous
      // URL so a page that autofocuses an input surfaces its overlay caret.
      expect(reportSpy).toHaveBeenCalled()
      const gotoOrder = mockPage.goto.mock.invocationCallOrder[0]
      // reportFocusNow forwards to page.evaluate(FOCUS_REPORTING_SCRIPT); use the
      // last evaluate call as its invocation marker. The script is now passed as
      // a real FUNCTION, so match against its serialized source.
      const focusEvaluateCalls = mockPage.evaluate.mock.calls
        .map((c, i) => ({ c, order: mockPage.evaluate.mock.invocationCallOrder[i] }))
        .filter(({ c }) => typeof c[0] === 'function' && String(c[0]).includes('__browserFocusReportingInstalled'))
      const lastFocusEvaluateOrder = focusEvaluateCalls[focusEvaluateCalls.length - 1].order
      expect(gotoOrder).toBeLessThan(lastFocusEvaluateOrder)
    })

    it('should NOT re-report focus when the previous URL was about:blank (no goto)', async () => {
      mockPage.url.mockReturnValue('about:blank')
      const session = new BrowserSession()
      await session.getPage()
      mockPage.goto.mockClear()
      const reportSpy = jest.spyOn(session, 'reportFocusNow')

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // No goto happened (about:blank), so there is nothing newly loaded to
      // report focus for.
      expect(mockPage.goto).not.toHaveBeenCalled()
      expect(reportSpy).not.toHaveBeenCalled()
    })
  })

  describe('currentDeviceId', () => {
    it('should return null when no device is set', () => {
      const session = new BrowserSession()
      expect(session.currentDeviceId).toBeNull()
    })

    it('should return deviceId after setViewport with device', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')
      expect(session.currentDeviceId).toBe('iphone-se')
    })

    it('should return null after clearing device', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')
      await session.setViewport(1280, 720, '')
      expect(session.currentDeviceId).toBeNull()
    })
  })

  describe('setViewport with deviceId', () => {
    it('should recreate context with device emulation when deviceId is provided', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')

      // setDeviceEmulation が先に呼ばれ、その後に新ページで setViewportSize が呼ばれる
      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 375, height: 667 })
      // newContext は2回呼ばれる: 1回目は getPage() 内（引数なし）、2回目は setDeviceEmulation 内（デバイス設定付き）
      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: expect.stringContaining('iPhone'),
          isMobile: true,
          hasTouch: true,
        }),
      )
    })

    it('should recreate context without UA when deviceId is empty string', async () => {
      const session = new BrowserSession()
      // First set a device
      await session.setViewport(375, 667, 'iphone-se')
      mockBrowser.newContext.mockClear()

      // Then clear it
      await session.setViewport(1280, 720, '')

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 })
      // Should recreate context without userAgent
      expect(mockBrowser.newContext).toHaveBeenCalled()
      const callArgs = mockBrowser.newContext.mock.calls[0][0]
      expect(callArgs.userAgent).toBeUndefined()
    })

    it('should not recreate context when switching to same device', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')
      mockBrowser.newContext.mockClear()

      // Same device again — only viewport size change
      await session.setViewport(375, 667, 'iphone-se')
      expect(mockBrowser.newContext).not.toHaveBeenCalled()
    })

    it('should not change emulation when deviceId is undefined (backward compat)', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.newContext.mockClear()

      await session.setViewport(1920, 1080)

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 })
      expect(mockBrowser.newContext).not.toHaveBeenCalled()
    })

    it('should ignore unknown deviceId', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockBrowser.newContext.mockClear()

      await session.setViewport(1024, 768, 'unknown-device')

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1024, height: 768 })
      // No context recreation for unknown device
      expect(mockBrowser.newContext).not.toHaveBeenCalled()
    })
  })

  describe('executeKeyboardType', () => {
    it('should log fill action when focused element is an input', async () => {
      mockGetFocusedElementInfo.mockResolvedValue({
        tagName: 'input',
        selector: '#username',
        text: '',
        attributes: {},
        isVisible: true,
        boundingBox: null,
      })

      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardType('hello')

      expect(mockPage.keyboard.type).toHaveBeenCalledWith('hello')
    })

    it('should log fill action when focused element is a textarea', async () => {
      mockGetFocusedElementInfo.mockResolvedValue({
        tagName: 'textarea',
        selector: '#message',
        text: '',
        attributes: {},
        isVisible: true,
        boundingBox: null,
      })

      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardType('world')

      expect(mockPage.keyboard.type).toHaveBeenCalledWith('world')
    })

    it('should log type action when focused element is not fillable', async () => {
      mockGetFocusedElementInfo.mockResolvedValue({
        tagName: 'div',
        selector: '#editor',
        text: '',
        attributes: {},
        isVisible: true,
        boundingBox: null,
      })

      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardType('some text')

      expect(mockPage.keyboard.type).toHaveBeenCalledWith('some text')
    })

    it('should log type action when no element is focused', async () => {
      mockGetFocusedElementInfo.mockResolvedValue(null)

      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardType('typing freely')

      expect(mockPage.keyboard.type).toHaveBeenCalledWith('typing freely')
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      // Don't call getPage() — no active page
      await expect(session.executeKeyboardType('text')).rejects.toThrow('No active browser page')
    })
  })

  describe('getSelectedText', () => {
    it('should return the selected text from page.evaluate', async () => {
      mockPage.evaluate.mockResolvedValue('selected snippet')
      const session = new BrowserSession()
      await session.getPage()

      const text = await session.getSelectedText()

      expect(mockPage.evaluate).toHaveBeenCalled()
      expect(text).toBe('selected snippet')
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.getSelectedText()).rejects.toThrow('No active browser page')
    })

    it('should return empty string when page.evaluate returns null', async () => {
      mockPage.evaluate.mockResolvedValue(null)
      const session = new BrowserSession()
      await session.getPage()

      const text = await session.getSelectedText()

      expect(text).toBe('')
    })

    it('should return empty string when page.evaluate returns a non-string value', async () => {
      mockPage.evaluate.mockResolvedValue(42)
      const session = new BrowserSession()
      await session.getPage()

      const text = await session.getSelectedText()

      expect(text).toBe('')
    })
  })

  describe('focus emulation', () => {
    it('should enable focus emulation after launching the page', async () => {
      const session = new BrowserSession()
      await session.getPage()

      expect(mockContext.newCDPSession).toHaveBeenCalledWith(mockPage)
      expect(mockCdpSession.send).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true })
    })

    it('should re-enable focus emulation after device emulation recreates the page', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockCdpSession.send.mockClear()
      mockContext.newCDPSession.mockClear()

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      expect(mockCdpSession.send).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true })
    })

    it('should not throw when CDP focus emulation is unavailable (non-Chromium)', async () => {
      mockContext.newCDPSession.mockRejectedValue(new Error('CDP not supported'))
      const session = new BrowserSession()

      await expect(session.getPage()).resolves.toBe(mockPage)
    })
  })

  describe('idle timeout', () => {
    it('should auto-close after idle timeout', async () => {
      const session = new BrowserSession(1000) // 1 second timeout
      await session.getPage()

      expect(session.isActive()).toBe(true)

      jest.advanceTimersByTime(1000)
      // Allow the microtask (async close) to complete
      await Promise.resolve()

      expect(mockBrowser.close).toHaveBeenCalled()
    })

    it('should reset idle timer on getPage call', async () => {
      const session = new BrowserSession(1000)
      await session.getPage()

      // Advance 500ms
      jest.advanceTimersByTime(500)
      // Call getPage again to reset timer
      await session.getPage()

      // Advance another 500ms (would have expired without reset)
      jest.advanceTimersByTime(500)
      await Promise.resolve()

      expect(mockBrowser.close).not.toHaveBeenCalled()

      // Full timeout from last reset
      jest.advanceTimersByTime(500)
      await Promise.resolve()

      expect(mockBrowser.close).toHaveBeenCalled()
    })
  })

  describe('onClosed callback', () => {
    it('should call onClosed when close() is called', async () => {
      const onClosed = jest.fn()
      const session = new BrowserSession(undefined, onClosed)
      await session.getPage()
      await session.close()

      expect(onClosed).toHaveBeenCalledTimes(1)
    })

    it('should call onClosed only once even if close() is called multiple times', async () => {
      const onClosed = jest.fn()
      const session = new BrowserSession(undefined, onClosed)
      await session.getPage()
      await session.close()
      await session.close()
      await session.close()

      expect(onClosed).toHaveBeenCalledTimes(1)
    })

    it('should call onClosed when idle timeout fires', async () => {
      const onClosed = jest.fn()
      const session = new BrowserSession(1000, onClosed)
      await session.getPage()

      jest.advanceTimersByTime(1000)
      await Promise.resolve()

      expect(onClosed).toHaveBeenCalledTimes(1)
    })

    it('should not throw when onClosed is not provided', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await expect(session.close()).resolves.not.toThrow()
    })
  })

  describe('executeMouseMove', () => {
    it('should call page.mouse.move with correct coordinates', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.executeMouseMove(100, 200)
      expect(mockPage.mouse.move).toHaveBeenCalledWith(100, 200)
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.executeMouseMove(100, 200)).rejects.toThrow('No active browser page')
    })
  })

  describe('getCursorAt', () => {
    it('should delegate to element-info getCursorAt when page is active', async () => {
      mockGetCursorAt.mockResolvedValue('pointer')
      const session = new BrowserSession()
      await session.getPage()
      const cursor = await session.getCursorAt(120, 240)
      expect(cursor).toBe('pointer')
      expect(mockGetCursorAt).toHaveBeenCalledWith(mockPage, 120, 240)
    })

    it('should throw when no active page', async () => {
      mockGetCursorAt.mockClear()
      const session = new BrowserSession()
      await expect(session.getCursorAt(10, 20)).rejects.toThrow('No active browser page')
      expect(mockGetCursorAt).not.toHaveBeenCalled()
    })
  })

  describe('executeMouseDown', () => {
    it('should move to position then press left button by default', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.executeMouseDown(50, 80)
      expect(mockPage.mouse.move).toHaveBeenCalledWith(50, 80)
      expect(mockPage.mouse.down).toHaveBeenCalledWith({ button: 'left' })
    })

    it('should pass specified button', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.executeMouseDown(50, 80, 'right')
      expect(mockPage.mouse.down).toHaveBeenCalledWith({ button: 'right' })
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.executeMouseDown(50, 80)).rejects.toThrow('No active browser page')
    })
  })

  describe('executeMouseUp', () => {
    it('should move to position then release left button by default', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.executeMouseUp(150, 250)
      expect(mockPage.mouse.move).toHaveBeenCalledWith(150, 250)
      expect(mockPage.mouse.up).toHaveBeenCalledWith({ button: 'left' })
    })

    it('should pass specified button', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.executeMouseUp(150, 250, 'right')
      expect(mockPage.mouse.up).toHaveBeenCalledWith({ button: 'right' })
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.executeMouseUp(150, 250)).rejects.toThrow('No active browser page')
    })
  })

  describe('file chooser', () => {
    // Helper: retrieve the 'filechooser' handler registered on a page mock.
    const getFileChooserHandler = (
      pageMock: Record<string, jest.Mock>,
    ): ((fc: { setFiles: jest.Mock }) => void) => {
      const call = pageMock.on.mock.calls.find((c: [string, unknown]) => c[0] === 'filechooser')
      expect(call).toBeDefined()
      return call![1] as (fc: { setFiles: jest.Mock }) => void
    }

    it('should invoke onFileChooser and forward payload to setFiles when callback is set', async () => {
      const session = new BrowserSession()
      const payload: FileChooserPayload = ['/tmp/browser-upload-x/0-a.txt']
      session.onFileChooser = (accept) => accept(payload)

      await session.getPage()

      const handler = getFileChooserHandler(mockPage)
      const fc = { setFiles: jest.fn().mockResolvedValue(undefined) }
      handler(fc)

      expect(fc.setFiles).toHaveBeenCalledWith(payload)
    })

    it('should call setFiles([]) when onFileChooser is null (cancel)', async () => {
      const session = new BrowserSession()
      session.onFileChooser = null

      await session.getPage()

      const handler = getFileChooserHandler(mockPage)
      const fc = { setFiles: jest.fn().mockResolvedValue(undefined) }
      handler(fc)

      expect(fc.setFiles).toHaveBeenCalledWith([])
    })

    it('should propagate setFiles rejection through the accept callback when accepting files', async () => {
      const session = new BrowserSession()
      let captured: ((files: FileChooserPayload) => Promise<void>) | null = null
      session.onFileChooser = (accept) => {
        captured = accept
      }

      await session.getPage()

      const handler = getFileChooserHandler(mockPage)
      const fc = { setFiles: jest.fn().mockRejectedValue(new Error('boom')) }
      // The synchronous handler must not throw; the rejection surfaces via accept().
      expect(() => handler(fc)).not.toThrow()
      await expect(captured!(['/tmp/browser-upload-x/0-a.txt'])).rejects.toThrow('boom')
    })

    it('should register a context page handler that attaches filechooser listeners to popups', async () => {
      const session = new BrowserSession()
      await session.getPage()

      // The context should register a 'page' handler for popups/new tabs.
      const pageHandlerCall = mockContext.on.mock.calls.find((c: [string, unknown]) => c[0] === 'page')
      expect(pageHandlerCall).toBeDefined()
      const pageHandler = pageHandlerCall![1] as (p: Record<string, jest.Mock>) => void

      // Simulate a popup page being created.
      const mockPage2: Record<string, jest.Mock> = { on: jest.fn() }
      pageHandler(mockPage2)

      expect(mockPage2.on).toHaveBeenCalledWith('filechooser', expect.any(Function))
    })

    it('should re-register the context page handler on the NEW context after setDeviceEmulation (HIGH-1)', async () => {
      const session = new BrowserSession()
      await session.getPage()

      // Build a distinct second context that the browser returns on the next newContext() call.
      const mockContext2: Record<string, jest.Mock> = {
        newPage: jest.fn().mockResolvedValue(mockPage),
        close: jest.fn().mockResolvedValue(undefined),
        newCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
        on: jest.fn(),
      }
      mockBrowser.newContext.mockResolvedValueOnce(mockContext2)

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // The newly-created context must have a 'page' listener so popups opened
      // after a device switch still surface the filechooser event.
      expect(mockContext2.on).toHaveBeenCalledWith('page', expect.any(Function))

      // The page handler on the new context attaches filechooser listeners to popups.
      const pageHandlerCall = mockContext2.on.mock.calls.find((c: [string, unknown]) => c[0] === 'page')
      expect(pageHandlerCall).toBeDefined()
      const pageHandler = pageHandlerCall![1] as (p: Record<string, jest.Mock>) => void
      const popupPage: Record<string, jest.Mock> = { on: jest.fn() }
      pageHandler(popupPage)
      expect(popupPage.on).toHaveBeenCalledWith('filechooser', expect.any(Function))
    })

    it('should reject from accept callback when setFiles rejects (HIGH-2)', async () => {
      const session = new BrowserSession()
      let captured: ((files: FileChooserPayload) => Promise<void>) | null = null
      session.onFileChooser = (accept) => {
        captured = accept
      }

      await session.getPage()

      const handler = getFileChooserHandler(mockPage)
      const fc = { setFiles: jest.fn().mockRejectedValue(new Error('boom')) }
      handler(fc)

      expect(captured).not.toBeNull()
      // The accept callback resolves to a promise that propagates the setFiles rejection.
      await expect(captured!(['/tmp/browser-upload-x/0-a.txt'])).rejects.toThrow('boom')
    })

    it('should resolve from accept callback when setFiles succeeds (HIGH-2)', async () => {
      const session = new BrowserSession()
      let captured: ((files: FileChooserPayload) => Promise<void>) | null = null
      session.onFileChooser = (accept) => {
        captured = accept
      }

      await session.getPage()

      const handler = getFileChooserHandler(mockPage)
      const fc = { setFiles: jest.fn().mockResolvedValue(undefined) }
      handler(fc)

      const payload: FileChooserPayload = ['/tmp/browser-upload-x/0-a.txt']
      await expect(captured!(payload)).resolves.toBeUndefined()
      expect(fc.setFiles).toHaveBeenCalledWith(payload)
    })
  })

  describe('focus reporting', () => {
    it('should expose binding, add init script and evaluate on getPage', async () => {
      const session = new BrowserSession()
      await session.getPage()

      expect(mockPage.exposeBinding).toHaveBeenCalledWith('__onBrowserFocus', expect.any(Function))
      // The script must be passed to Playwright as a real FUNCTION (a string
      // pageFunction is treated as an expression and never invoked). We still
      // assert it is THE focus-reporting script via its serialized source.
      expect(mockPage.addInitScript).toHaveBeenCalledWith(expect.any(Function))
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function))
      expect(String(mockPage.addInitScript.mock.calls[0][0])).toContain('__browserFocusReportingInstalled')
      expect(String(mockPage.evaluate.mock.calls[0][0])).toContain('__browserFocusReportingInstalled')
    })

    it('should forward the exposed binding payload to onFocusChange', async () => {
      const session = new BrowserSession()
      const received: FocusChangePayload[] = []
      session.onFocusChange = (p) => received.push(p)
      await session.getPage()

      // Retrieve the binding callback registered via exposeBinding and invoke it
      // the way Playwright would (source object + page payload).
      const call = mockPage.exposeBinding.mock.calls.find((c: [string, unknown]) => c[0] === '__onBrowserFocus')
      expect(call).toBeDefined()
      const binding = call![1] as (src: unknown, payload: FocusChangePayload) => void
      const payload: FocusChangePayload = { focused: true, value: 'hi' }
      binding({}, payload)

      expect(received).toEqual([payload])
    })

    it('should not call onFocusChange when callback is null', async () => {
      const session = new BrowserSession()
      session.onFocusChange = null
      await session.getPage()

      const call = mockPage.exposeBinding.mock.calls.find((c: [string, unknown]) => c[0] === '__onBrowserFocus')
      const binding = call![1] as (src: unknown, payload: FocusChangePayload) => void
      // Must not throw even though no listener is attached.
      expect(() => binding({}, { focused: false })).not.toThrow()
    })

    it('should log to the Node logger (once) when the binding callback throws', async () => {
      const session = new BrowserSession()
      session.onFocusChange = () => {
        throw new Error('subscriber boom')
      }
      await session.getPage()

      const call = mockPage.exposeBinding.mock.calls.find((c: [string, unknown]) => c[0] === '__onBrowserFocus')
      const binding = call![1] as (src: unknown, payload: FocusChangePayload) => void

      // A failing subscriber must not throw back into Playwright, and the first
      // failure must reach the Node logger (browser-side console.warn never does).
      expect(() => binding({}, { focused: true })).not.toThrow()
      expect(() => binding({}, { focused: true })).not.toThrow()
      const focusWarns = mockLogger.warn.mock.calls.filter(
        (c: [string]) => typeof c[0] === 'string' && c[0].includes('binding callback failed'),
      )
      expect(focusWarns).toHaveLength(1)
    })

    it('should expose the binding only once across multiple getPage calls', async () => {
      const session = new BrowserSession()
      await session.getPage()
      await session.getPage()

      const exposeCalls = mockPage.exposeBinding.mock.calls.filter(
        (c: [string, unknown]) => c[0] === '__onBrowserFocus',
      )
      expect(exposeCalls).toHaveLength(1)
    })

    it('should re-expose the binding on the new page after device emulation', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.exposeBinding.mockClear()

      await session.setDeviceEmulation({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      })

      // Context recreation resets the per-page binding guard, so the fresh page
      // gets its own __onBrowserFocus binding.
      expect(mockPage.exposeBinding).toHaveBeenCalledWith('__onBrowserFocus', expect.any(Function))
    })

    it('should not throw when exposeBinding fails (best-effort)', async () => {
      mockPage.exposeBinding.mockRejectedValue(new Error('binding boom'))
      const session = new BrowserSession()

      await expect(session.getPage()).resolves.toBe(mockPage)
    })

    it('should not throw when evaluate injection fails (best-effort)', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('evaluate boom'))
      const session = new BrowserSession()

      await expect(session.getPage()).resolves.toBe(mockPage)
    })

    it('should still inject the focus script when exposeBinding fails (isolation)', async () => {
      mockPage.exposeBinding.mockRejectedValue(new Error('binding boom'))
      const session = new BrowserSession()

      await session.getPage()

      // A failed binding expose must not block script injection — the script is
      // injected on every page regardless of whether the binding was exposed.
      // Passed as a real FUNCTION; verified to be the focus-reporting script.
      expect(mockPage.addInitScript).toHaveBeenCalledWith(expect.any(Function))
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function))
      expect(String(mockPage.addInitScript.mock.calls[0][0])).toContain('__browserFocusReportingInstalled')
      expect(String(mockPage.evaluate.mock.calls[0][0])).toContain('__browserFocusReportingInstalled')
    })

    it('should retry exposeBinding on the next getPage when the first expose fails', async () => {
      // First getPage: binding expose rejects, so focusReportingExposed must stay
      // false. The page-cache short-circuits getPage, so simulate a fresh page by
      // closing and re-opening to drive enableFocusReporting again.
      mockPage.exposeBinding.mockRejectedValueOnce(new Error('binding boom'))
      const session = new BrowserSession()
      await session.getPage()
      await session.close()

      mockPage.exposeBinding.mockClear()
      mockPage.exposeBinding.mockResolvedValue(undefined)

      await session.getPage()

      // Because the previous expose failed (guard not flipped to true), the next
      // session attempts the expose again instead of skipping it.
      expect(mockPage.exposeBinding).toHaveBeenCalledWith('__onBrowserFocus', expect.any(Function))
    })

    it('should still expose the binding when script injection fails (isolation)', async () => {
      mockPage.addInitScript.mockRejectedValue(new Error('init boom'))
      const session = new BrowserSession()

      await session.getPage()

      // A failed script injection must not prevent the binding from being exposed.
      expect(mockPage.exposeBinding).toHaveBeenCalledWith('__onBrowserFocus', expect.any(Function))
    })
  })

  describe('setFocusedInputValue', () => {
    it('should call page.evaluate with value and selection', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.evaluate.mockClear()

      await session.setFocusedInputValue('hello', 1, 3)

      // Passed as a real FUNCTION (not a string) so Playwright actually invokes
      // it with the arg; the source confirms it is the value-setting script.
      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        { value: 'hello', selectionStart: 1, selectionEnd: 3 },
      )
      expect(String(mockPage.evaluate.mock.calls[0][0])).toContain('dispatchEvent')
    })

    it('should pass undefined selection bounds when omitted', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.evaluate.mockClear()

      await session.setFocusedInputValue('world')

      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        { value: 'world', selectionStart: undefined, selectionEnd: undefined },
      )
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.setFocusedInputValue('x')).rejects.toThrow('No active browser page')
    })
  })

  describe('reportFocusNow', () => {
    it('should re-evaluate the focus reporting script on the current page', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.evaluate.mockClear()

      await session.reportFocusNow()

      // Passed as a real FUNCTION; verified to be the focus-reporting script.
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(Function))
      expect(String(mockPage.evaluate.mock.calls[0][0])).toContain('__browserFocusReportingInstalled')
    })

    it('should be a no-op when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.reportFocusNow()).resolves.toBeUndefined()
      expect(mockPage.evaluate).not.toHaveBeenCalled()
    })

    it('should swallow evaluate errors (best-effort)', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.evaluate.mockRejectedValueOnce(new Error('evaluate boom'))

      await expect(session.reportFocusNow()).resolves.toBeUndefined()
    })
  })
})
