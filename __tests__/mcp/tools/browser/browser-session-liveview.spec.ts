import { BrowserSession } from '../../../../src/mcp/tools/browser/browser-session'

// Mock playwright-loader
jest.mock('../../../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
}))

jest.mock('../../../../src/logger')

import { loadPlaywright } from '../../../../src/mcp/tools/browser/playwright-loader'

const mockLoadPlaywright = loadPlaywright as jest.MockedFunction<typeof loadPlaywright>

describe('BrowserSession - Live View & Interaction', () => {
  let mockPage: Record<string, jest.Mock | Record<string, jest.Mock>>
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
      goBack: jest.fn().mockResolvedValue(undefined),
      goForward: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
      viewportSize: jest.fn().mockReturnValue({ width: 1280, height: 720 }),
      mouse: {
        click: jest.fn().mockResolvedValue(undefined),
        wheel: jest.fn().mockResolvedValue(undefined),
      },
      keyboard: {
        type: jest.fn().mockResolvedValue(undefined),
        press: jest.fn().mockResolvedValue(undefined),
      },
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

  describe('startLiveView', () => {
    it('should start interval and capture screenshots', async () => {
      const session = new BrowserSession()
      await session.getPage()

      const onFrame = jest.fn()
      session.startLiveView(100, onFrame)

      expect(session.isLiveViewActive()).toBe(true)

      // Advance timer to trigger the interval callback
      jest.advanceTimersByTime(100)
      // Allow the async screenshot to complete
      await Promise.resolve()
      await Promise.resolve()

      expect((mockPage.screenshot as jest.Mock)).toHaveBeenCalledWith({
        fullPage: false,
        type: 'jpeg',
        quality: 50,
      })
      expect(onFrame).toHaveBeenCalledWith(Buffer.from('fake-screenshot').toString('base64'))

      session.stopLiveView()
    })

    it('should handle screenshot error gracefully during live view', async () => {
      const session = new BrowserSession()
      await session.getPage()
      ;(mockPage.screenshot as jest.Mock).mockRejectedValueOnce(new Error('Page crashed'))

      const onFrame = jest.fn()
      session.startLiveView(100, onFrame)

      jest.advanceTimersByTime(100)
      // Allow the async screenshot rejection to complete
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // onFrame should not be called when screenshot fails
      expect(onFrame).not.toHaveBeenCalled()

      // Live view should still be active (not stopped by error)
      expect(session.isLiveViewActive()).toBe(true)

      session.stopLiveView()
    })

    it('should disable idle timeout during live view', async () => {
      const session = new BrowserSession(500)
      await session.getPage()

      session.startLiveView(100, jest.fn())

      // Advance beyond idle timeout
      jest.advanceTimersByTime(1000)
      await Promise.resolve()

      // Browser should still be active (idle timer disabled)
      expect(session.isActive()).toBe(true)
      expect(mockBrowser.close).not.toHaveBeenCalled()

      session.stopLiveView()
    })

    it('should stop previous live view when starting a new one', async () => {
      const session = new BrowserSession()
      await session.getPage()

      const onFrame1 = jest.fn()
      const onFrame2 = jest.fn()

      session.startLiveView(100, onFrame1)
      session.startLiveView(200, onFrame2)

      // Only the second live view should be active
      jest.advanceTimersByTime(200)
      await Promise.resolve()
      await Promise.resolve()

      expect(onFrame2).toHaveBeenCalled()

      session.stopLiveView()
    })
  })

  describe('stopLiveView', () => {
    it('should clear interval and mark as inactive', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(100, jest.fn())
      expect(session.isLiveViewActive()).toBe(true)

      session.stopLiveView()
      expect(session.isLiveViewActive()).toBe(false)
    })

    it('should re-enable idle timer after stopping', async () => {
      const session = new BrowserSession(500)
      await session.getPage()

      session.startLiveView(100, jest.fn())
      session.stopLiveView()

      // Now idle timer should be active again
      jest.advanceTimersByTime(500)
      await Promise.resolve()

      expect(mockBrowser.close).toHaveBeenCalled()
    })

    it('should be safe to call when no live view is active', async () => {
      const session = new BrowserSession()
      expect(() => session.stopLiveView()).not.toThrow()
    })

    it('should not re-enable idle timer if browser is not active', () => {
      const session = new BrowserSession(500)
      // Browser not launched, stopLiveView should not set idle timer
      session.stopLiveView()

      jest.advanceTimersByTime(1000)
      // No error should occur
      expect(session.isActive()).toBe(false)
    })
  })

  describe('isLiveViewActive', () => {
    it('should return false initially', () => {
      const session = new BrowserSession()
      expect(session.isLiveViewActive()).toBe(false)
    })

    it('should return true when live view is started', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(100, jest.fn())
      expect(session.isLiveViewActive()).toBe(true)

      session.stopLiveView()
    })

    it('should return false after live view is stopped', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(100, jest.fn())
      session.stopLiveView()
      expect(session.isLiveViewActive()).toBe(false)
    })
  })

  describe('executeMouseClick', () => {
    it('should call page.mouse.click with coordinates and options', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeMouseClick(100, 200)

      expect((mockPage.mouse as Record<string, jest.Mock>).click).toHaveBeenCalledWith(100, 200, {
        button: 'left',
        clickCount: 1,
      })
    })

    it('should support custom button and click count', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeMouseClick(50, 75, 'right', 2)

      expect((mockPage.mouse as Record<string, jest.Mock>).click).toHaveBeenCalledWith(50, 75, {
        button: 'right',
        clickCount: 2,
      })
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.executeMouseClick(0, 0)).rejects.toThrow('No active browser page')
    })
  })

  describe('executeMouseWheel', () => {
    it('should call page.mouse.wheel with delta values', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeMouseWheel(0, 100)

      expect((mockPage.mouse as Record<string, jest.Mock>).wheel).toHaveBeenCalledWith(0, 100)
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.executeMouseWheel(0, 100)).rejects.toThrow('No active browser page')
    })
  })

  describe('executeKeyboardType', () => {
    it('should call page.keyboard.type with text', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardType('hello world')

      expect((mockPage.keyboard as Record<string, jest.Mock>).type).toHaveBeenCalledWith(
        'hello world',
      )
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.executeKeyboardType('test')).rejects.toThrow('No active browser page')
    })
  })

  describe('executeKeyboardPress', () => {
    it('should call page.keyboard.press with key', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardPress('Enter')

      expect((mockPage.keyboard as Record<string, jest.Mock>).press).toHaveBeenCalledWith('Enter')
    })

    it('should combine modifiers with key', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardPress('c', ['Control'])

      expect((mockPage.keyboard as Record<string, jest.Mock>).press).toHaveBeenCalledWith(
        'Control+c',
      )
    })

    it('should combine multiple modifiers with key', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardPress('s', ['Control', 'Shift'])

      expect((mockPage.keyboard as Record<string, jest.Mock>).press).toHaveBeenCalledWith(
        'Control+Shift+s',
      )
    })

    it('should press key without modifiers when modifiers is empty array', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.executeKeyboardPress('Escape', [])

      expect((mockPage.keyboard as Record<string, jest.Mock>).press).toHaveBeenCalledWith('Escape')
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.executeKeyboardPress('Enter')).rejects.toThrow('No active browser page')
    })
  })

  describe('goBack', () => {
    it('should call page.goBack()', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.goBack()

      expect((mockPage.goBack as jest.Mock)).toHaveBeenCalled()
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.goBack()).rejects.toThrow('No active browser page')
    })
  })

  describe('goForward', () => {
    it('should call page.goForward()', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.goForward()

      expect((mockPage.goForward as jest.Mock)).toHaveBeenCalled()
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.goForward()).rejects.toThrow('No active browser page')
    })
  })

  describe('reload', () => {
    it('should call page.reload()', async () => {
      const session = new BrowserSession()
      await session.getPage()

      await session.reload()

      expect((mockPage.reload as jest.Mock)).toHaveBeenCalled()
    })

    it('should throw when no page is active', async () => {
      const session = new BrowserSession()
      await expect(session.reload()).rejects.toThrow('No active browser page')
    })
  })

  describe('getCurrentUrl', () => {
    it('should return page URL', async () => {
      const session = new BrowserSession()
      await session.getPage()

      expect(session.getCurrentUrl()).toBe('https://example.com')
    })

    it('should return empty string when no page is active', () => {
      const session = new BrowserSession()
      expect(session.getCurrentUrl()).toBe('')
    })
  })

  describe('getPageTitle', () => {
    it('should return page title', async () => {
      const session = new BrowserSession()
      await session.getPage()

      const title = await session.getPageTitle()
      expect(title).toBe('Test Page')
    })

    it('should return empty string when no page is active', async () => {
      const session = new BrowserSession()
      const title = await session.getPageTitle()
      expect(title).toBe('')
    })
  })
})
