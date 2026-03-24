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
    }

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
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
      expect(mockBrowser.newPage).toHaveBeenCalled()
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
    it('should set User-Agent header and init script for iPhone preset', async () => {
      const session = new BrowserSession()
      const emulation = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      }
      await session.setDeviceEmulation(emulation)

      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith({
        'User-Agent': emulation.userAgent,
      })
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('navigator'),
      )
      // Check platform is iPhone
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('iPhone'),
      )
      // Check maxTouchPoints is 5
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('5'),
      )
    })

    it('should set Linux platform for Android UA', async () => {
      const session = new BrowserSession()
      const emulation = {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2.625,
      }
      await session.setDeviceEmulation(emulation)

      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('Linux armv8l'),
      )
    })

    it('should set iPad platform for iPad UA', async () => {
      const session = new BrowserSession()
      const emulation = {
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      }
      await session.setDeviceEmulation(emulation)

      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('iPad'),
      )
    })

    it('should set maxTouchPoints to 0 when hasTouch is false', async () => {
      const session = new BrowserSession()
      const emulation = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        isMobile: false,
        hasTouch: false,
        deviceScaleFactor: 1,
      }
      await session.setDeviceEmulation(emulation)

      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('0'),
      )
      // Should default to Win32 platform
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('Win32'),
      )
    })

    it('should clear emulation when called with null', async () => {
      const session = new BrowserSession()
      await session.setDeviceEmulation(null)

      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith({})
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('device emulation cleared'),
      )
    })
  })

  describe('setViewport with deviceId', () => {
    it('should apply device emulation and reload when deviceId is provided', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 375, height: 667 })
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ 'User-Agent': expect.stringContaining('iPhone') }),
      )
      expect(mockPage.addInitScript).toHaveBeenCalled()
      // Should reload the page to apply new UA
      expect(mockPage.reload).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' })
    })

    it('should clear device emulation and reload when deviceId is empty string', async () => {
      const session = new BrowserSession()
      // First set a device
      await session.setViewport(375, 667, 'iphone-se')
      mockPage.setExtraHTTPHeaders.mockClear()
      mockPage.addInitScript.mockClear()
      mockPage.reload.mockClear()

      // Then clear it
      await session.setViewport(1280, 720, '')

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 })
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith({})
      expect(mockPage.addInitScript).toHaveBeenCalledWith(
        expect.stringContaining('device emulation cleared'),
      )
      // Should reload to apply cleared UA
      expect(mockPage.reload).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' })
    })

    it('should not reload when switching to same device', async () => {
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')
      mockPage.reload.mockClear()

      // Same device again
      await session.setViewport(375, 667, 'iphone-se')
      expect(mockPage.reload).not.toHaveBeenCalled()
    })

    it('should not reload when page is about:blank', async () => {
      mockPage.url.mockReturnValue('about:blank')
      const session = new BrowserSession()
      await session.setViewport(375, 667, 'iphone-se')

      expect(mockPage.reload).not.toHaveBeenCalled()
    })

    it('should not change emulation when deviceId is undefined (backward compat)', async () => {
      const session = new BrowserSession()
      await session.setViewport(1920, 1080)

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 })
      expect(mockPage.setExtraHTTPHeaders).not.toHaveBeenCalled()
      expect(mockPage.addInitScript).not.toHaveBeenCalled()
      expect(mockPage.reload).not.toHaveBeenCalled()
    })

    it('should ignore unknown deviceId', async () => {
      const session = new BrowserSession()
      await session.setViewport(1024, 768, 'unknown-device')

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1024, height: 768 })
      // No emulation should be applied for unknown device
      expect(mockPage.setExtraHTTPHeaders).not.toHaveBeenCalled()
      expect(mockPage.reload).not.toHaveBeenCalled()
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
