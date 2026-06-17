import { BrowserSession, FileChooserPayload } from '../../../../src/mcp/tools/browser/browser-session'

// Mock playwright-loader
jest.mock('../../../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
}))

jest.mock('../../../../src/logger')

jest.mock('../../../../src/mcp/tools/browser/element-info', () => ({
  getElementAtPoint: jest.fn(),
  getFocusedElementInfo: jest.fn(),
}))

import { loadPlaywright } from '../../../../src/mcp/tools/browser/playwright-loader'
import { getFocusedElementInfo } from '../../../../src/mcp/tools/browser/element-info'

const mockGetFocusedElementInfo = getFocusedElementInfo as jest.MockedFunction<typeof getFocusedElementInfo>

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

    mockCdpSession = { send: jest.fn().mockResolvedValue(undefined) }

    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      title: jest.fn().mockResolvedValue('Test Page'),
      url: jest.fn().mockReturnValue('https://example.com'),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      setViewportSize: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
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
      const payload = [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]
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
      await expect(
        captured!([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]),
      ).rejects.toThrow('boom')
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
      await expect(
        captured!([{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]),
      ).rejects.toThrow('boom')
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

      const payload = [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') }]
      await expect(captured!(payload)).resolves.toBeUndefined()
      expect(fc.setFiles).toHaveBeenCalledWith(payload)
    })
  })
})
