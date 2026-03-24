import { BrowserSession } from '../../../../src/mcp/tools/browser/browser-session'

// Mock playwright-loader
jest.mock('../../../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
}))

jest.mock('../../../../src/logger')

import { loadPlaywright } from '../../../../src/mcp/tools/browser/playwright-loader'

const mockLoadPlaywright = loadPlaywright as jest.MockedFunction<typeof loadPlaywright>

describe('BrowserSession', () => {
  let mockPage: Record<string, jest.Mock>
  let mockContext: Record<string, jest.Mock>
  let mockBrowser: Record<string, jest.Mock>
  let mockPlaywright: { chromium: { launch: jest.Mock } }

  beforeEach(() => {
    jest.useFakeTimers()

    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      title: jest.fn().mockResolvedValue('Test Page'),
      url: jest.fn().mockReturnValue('https://example.com'),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      setViewportSize: jest.fn().mockResolvedValue(undefined),
      setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
      addInitScript: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
      viewportSize: jest.fn().mockReturnValue({ width: 1280, height: 720 }),
    }

    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
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

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 375, height: 667 })
      // Should recreate context for iPhone SE
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
})
