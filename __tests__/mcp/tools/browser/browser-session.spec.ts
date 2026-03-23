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
