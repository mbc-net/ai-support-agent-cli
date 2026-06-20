import {
  BrowserSession,
  FileChooserPayload,
  FocusChangePayload,
  FOCUS_REPORTING_SCRIPT,
  SET_FOCUSED_INPUT_VALUE_SCRIPT,
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

const mockGetFocusedElementInfo = getFocusedElementInfo as jest.MockedFunction<typeof getFocusedElementInfo>
const mockGetCursorAt = getCursorAt as jest.MockedFunction<typeof getCursorAt>

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
      expect(mockPage.addInitScript).toHaveBeenCalledWith(expect.stringContaining('__browserFocusReportingInstalled'))
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.stringContaining('__browserFocusReportingInstalled'))
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
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('__browserFocusReportingInstalled'),
      )
      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.stringContaining('__browserFocusReportingInstalled'),
      )
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

      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.stringContaining('dispatchEvent'),
        { value: 'hello', selectionStart: 1, selectionEnd: 3 },
      )
    })

    it('should pass undefined selection bounds when omitted', async () => {
      const session = new BrowserSession()
      await session.getPage()
      mockPage.evaluate.mockClear()

      await session.setFocusedInputValue('world')

      expect(mockPage.evaluate).toHaveBeenCalledWith(
        expect.any(String),
        { value: 'world', selectionStart: undefined, selectionEnd: undefined },
      )
    })

    it('should throw when no active page', async () => {
      const session = new BrowserSession()
      await expect(session.setFocusedInputValue('x')).rejects.toThrow('No active browser page')
    })
  })

  // ---------------------------------------------------------------------------
  // In-browser script behavior. FOCUS_REPORTING_SCRIPT and
  // SET_FOCUSED_INPUT_VALUE_SCRIPT run inside the page (passed to Playwright as
  // strings). We exercise their logic directly in Node by compiling the arrow
  // function and feeding it a hand-built fake window/document so the branches
  // (false-suppression, missing native setter) are covered without a real DOM.
  // ---------------------------------------------------------------------------
  describe('SET_FOCUSED_INPUT_VALUE_SCRIPT (in-browser)', () => {
    interface FakeEl {
      tagName: string
      attrs: Record<string, string>
      getAttribute: (n: string) => string | null
      dispatchEvent: jest.Mock
      setSelectionRange?: jest.Mock
      value?: string
    }

    function makeEl(tagName: string, attrs: Record<string, string> = {}): FakeEl {
      return {
        tagName,
        attrs,
        getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
        dispatchEvent: jest.fn(),
        setSelectionRange: jest.fn(),
        value: '',
      }
    }

    // Build a fake window with INPUT/TEXTAREA prototypes whose `value` property
    // descriptor optionally exposes a setter, plus a recording InputEvent.
    function makeEnv(opts: { inputHasSetter: boolean; textareaHasSetter: boolean }) {
      const inputSetter = jest.fn(function (this: FakeEl, v: string) {
        this.value = v
      })
      const textareaSetter = jest.fn(function (this: FakeEl, v: string) {
        this.value = v
      })
      const inputProto = {}
      Object.defineProperty(inputProto, 'value', {
        configurable: true,
        get() {
          return ''
        },
        ...(opts.inputHasSetter ? { set: inputSetter } : {}),
      })
      const textareaProto = {}
      Object.defineProperty(textareaProto, 'value', {
        configurable: true,
        get() {
          return ''
        },
        ...(opts.textareaHasSetter ? { set: textareaSetter } : {}),
      })
      const win = {
        HTMLInputElement: { prototype: inputProto },
        HTMLTextAreaElement: { prototype: textareaProto },
      }
      const inputEvents: Array<{ type: string }> = []
      class FakeInputEvent {
        type: string
        constructor(type: string) {
          this.type = type
          inputEvents.push(this)
        }
      }
      return { win, inputSetter, textareaSetter, inputEvents, FakeInputEvent }
    }

    function run(
      script: string,
      activeElement: FakeEl | null,
      win: Record<string, unknown>,
      InputEventCtor: unknown,
      args: unknown,
    ): void {
      const doc = { activeElement }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const fn = new Function(
        'window',
        'document',
        'InputEvent',
        `return (${script})`,
      )(win, doc, InputEventCtor) as (a: unknown) => void
      fn(args)
    }

    it('should set the value via the native setter and dispatch input for an input', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      const el = makeEl('INPUT', { type: 'text' })

      run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, {
        value: 'hello',
        selectionStart: 1,
        selectionEnd: 3,
      })

      expect(env.inputSetter).toHaveBeenCalledWith('hello')
      expect(el.dispatchEvent).toHaveBeenCalledTimes(1)
      expect(env.inputEvents).toEqual([{ type: 'input' }])
      expect(el.setSelectionRange).toHaveBeenCalledWith(1, 3)
    })

    it('should be a no-op (no crash) when the native value setter is missing', () => {
      const env = makeEnv({ inputHasSetter: false, textareaHasSetter: true })
      const el = makeEl('INPUT', { type: 'text' })

      // Must not throw a TypeError reading .set of undefined; nothing dispatched.
      expect(() =>
        run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, { value: 'x' }),
      ).not.toThrow()
      expect(el.dispatchEvent).not.toHaveBeenCalled()
      expect(env.inputEvents).toEqual([])
    })

    it('should no-op when there is no active element', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      expect(() =>
        run(SET_FOCUSED_INPUT_VALUE_SCRIPT, null, env.win, env.FakeInputEvent, { value: 'x' }),
      ).not.toThrow()
      expect(env.inputSetter).not.toHaveBeenCalled()
    })

    it('should no-op for a non-reporting input type', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      const el = makeEl('INPUT', { type: 'checkbox' })
      run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, { value: 'x' })
      expect(env.inputSetter).not.toHaveBeenCalled()
    })

    it('should no-op for a non-input/textarea element', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      const el = makeEl('DIV')
      run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, { value: 'x' })
      expect(env.inputSetter).not.toHaveBeenCalled()
      expect(env.textareaSetter).not.toHaveBeenCalled()
    })

    it('should set value on a textarea via its native setter', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      const el = makeEl('TEXTAREA')
      run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, { value: 'multi' })
      expect(env.textareaSetter).toHaveBeenCalledWith('multi')
      expect(el.dispatchEvent).toHaveBeenCalledTimes(1)
    })

    it('should skip setSelectionRange when bounds are omitted', () => {
      const env = makeEnv({ inputHasSetter: true, textareaHasSetter: true })
      const el = makeEl('INPUT', { type: 'text' })
      run(SET_FOCUSED_INPUT_VALUE_SCRIPT, el, env.win, env.FakeInputEvent, { value: 'x' })
      expect(el.setSelectionRange).not.toHaveBeenCalled()
    })
  })

  describe('FOCUS_REPORTING_SCRIPT (in-browser)', () => {
    interface FakeReportEl {
      tagName: string
      attrs: Record<string, string>
      getAttribute: (n: string) => string | null
      value: string
      selectionStart: number | null
      selectionEnd: number | null
      maxLength: number
      getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
    }

    function makeReportEl(tagName: string, attrs: Record<string, string> = {}): FakeReportEl {
      return {
        tagName,
        attrs,
        getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
        value: 'abc',
        selectionStart: 0,
        selectionEnd: 0,
        maxLength: -1,
        getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
      }
    }

    // Install the focus reporting script into a fake page environment and return
    // helpers to drive its registered event listeners and inspect emitted payloads.
    function install(onFocus: jest.Mock, opts?: { throwOnFocus?: boolean }) {
      let activeElement: FakeReportEl | null = null
      const listeners: Record<string, Array<() => void>> = {}
      const consoleWarn = jest.fn()
      const win: Record<string, unknown> = {
        __onBrowserFocus: opts?.throwOnFocus
          ? () => {
              throw new Error('binding gone')
            }
          : onFocus,
        console: { warn: consoleWarn },
      }
      const doc = {
        get activeElement() {
          return activeElement
        },
        addEventListener: (type: string, cb: () => void) => {
          ;(listeners[type] ||= []).push(cb)
        },
      }
      const getComputedStyle = (): Record<string, string> => ({
        fontSize: '16px',
        lineHeight: '20px',
        paddingTop: '2px',
        paddingLeft: '4px',
        textAlign: 'left',
      })
      // Inject `console` explicitly: the script's `console.warn` resolves to the
      // global in a real browser, but in this Function sandbox we route it to a
      // spy so the one-shot warning can be asserted.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const fn = new Function(
        'window',
        'document',
        'getComputedStyle',
        'console',
        `return (${FOCUS_REPORTING_SCRIPT})`,
      )(win, doc, getComputedStyle, { warn: consoleWarn }) as () => void
      fn()
      const fire = (type: string): void => {
        for (const cb of listeners[type] ?? []) cb()
      }
      return {
        win,
        consoleWarn,
        setActive: (el: FakeReportEl | null) => {
          activeElement = el
        },
        fire,
      }
    }

    it('should emit focused:true with payload when a reporting target is focused', () => {
      const onFocus = jest.fn()
      const env = install(onFocus)
      env.setActive(makeReportEl('INPUT', { type: 'text' }))

      env.fire('focusin')

      expect(onFocus).toHaveBeenCalledTimes(1)
      const payload = onFocus.mock.calls[0][0] as FocusChangePayload
      expect(payload.focused).toBe(true)
      expect(payload.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
      expect(payload.value).toBe('abc')
      expect(payload.fontSize).toBe(16)
    })

    it('should NOT emit focused:false from selectionchange while nothing was focused (false-suppression)', () => {
      const onFocus = jest.fn()
      const env = install(onFocus)
      env.setActive(null)

      // Unrelated document text selections fire selectionchange repeatedly; with
      // nothing reporting-focused these must NOT spam focused:false.
      env.fire('selectionchange')
      env.fire('selectionchange')
      env.fire('selectionchange')

      expect(onFocus).not.toHaveBeenCalled()
    })

    it('should emit focused:false exactly once on the true->false transition', () => {
      const onFocus = jest.fn()
      const env = install(onFocus)

      // Focus a target (true), then defocus (false), then keep firing while
      // unfocused — only the first transition should emit false.
      env.setActive(makeReportEl('INPUT', { type: 'text' }))
      env.fire('focusin')
      onFocus.mockClear()

      env.setActive(null)
      env.fire('focusout')
      env.fire('selectionchange')
      env.fire('input')

      expect(onFocus).toHaveBeenCalledTimes(1)
      expect((onFocus.mock.calls[0][0] as FocusChangePayload).focused).toBe(false)
    })

    it('should keep emitting focused:true updates while a target stays focused', () => {
      const onFocus = jest.fn()
      const env = install(onFocus)
      env.setActive(makeReportEl('TEXTAREA'))

      env.fire('focusin')
      env.fire('input')
      env.fire('selectionchange')

      // Every update while focused is forwarded so value/selection stay in sync.
      expect(onFocus).toHaveBeenCalledTimes(3)
      for (const call of onFocus.mock.calls) {
        expect((call[0] as FocusChangePayload).focused).toBe(true)
      }
      // textarea reports multiline + inputType 'textarea'
      const p = onFocus.mock.calls[0][0] as FocusChangePayload
      expect(p.multiline).toBe(true)
      expect(p.inputType).toBe('textarea')
    })

    it('should log a one-shot console warning when the binding throws', () => {
      const onFocus = jest.fn()
      const env = install(onFocus, { throwOnFocus: true })
      env.setActive(makeReportEl('INPUT', { type: 'text' }))

      // First failing report logs once; subsequent failures stay silent.
      env.fire('focusin')
      env.fire('input')

      expect(env.consoleWarn).toHaveBeenCalledTimes(1)
      expect(env.consoleWarn.mock.calls[0][0]).toContain('[focus-reporting] report failed')
      expect(env.win.__focusReportErrorLogged).toBe(true)
    })

    it('should be idempotent: a second install is a no-op', () => {
      const onFocus = jest.fn()
      const env = install(onFocus)
      // Re-running the script in the same window must early-return without
      // re-registering listeners (guarded by __browserFocusReportingInstalled).
      expect(env.win.__browserFocusReportingInstalled).toBe(true)

      const getComputedStyle = (): Record<string, string> => ({})
      const doc = {
        get activeElement() {
          return null
        },
        addEventListener: jest.fn(),
      }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const fn = new Function(
        'window',
        'document',
        'getComputedStyle',
        'console',
        `return (${FOCUS_REPORTING_SCRIPT})`,
      )(env.win, doc, getComputedStyle, { warn: jest.fn() }) as () => void
      fn()

      expect(doc.addEventListener).not.toHaveBeenCalled()
    })
  })
})
