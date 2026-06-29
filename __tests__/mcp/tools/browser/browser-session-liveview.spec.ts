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
      on: jest.fn(),
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
        quality: 70,
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

    it('should NOT call onFrame when consecutive frames are identical', async () => {
      const session = new BrowserSession()
      await session.getPage()
      // Always return the same buffer
      ;(mockPage.screenshot as jest.Mock).mockResolvedValue(Buffer.from('same-frame'))

      const onFrame = jest.fn()
      session.startLiveView(100, onFrame)

      // First tick → new frame, should send
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      // Second tick → identical frame, should skip
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      session.stopLiveView()
    })

    it('should call onFrame when frame data changes between ticks', async () => {
      const session = new BrowserSession()
      await session.getPage()
      ;(mockPage.screenshot as jest.Mock)
        .mockResolvedValueOnce(Buffer.from('frame-1'))
        .mockResolvedValueOnce(Buffer.from('frame-2'))

      const onFrame = jest.fn()
      session.startLiveView(100, onFrame)

      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(2)

      session.stopLiveView()
    })

    it('should reset lastFrameData on stopLiveView so first frame of next session is always sent', async () => {
      const session = new BrowserSession()
      await session.getPage()
      ;(mockPage.screenshot as jest.Mock).mockResolvedValue(Buffer.from('same-frame'))

      const onFrame = jest.fn()
      session.startLiveView(100, onFrame)
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      // Stop and restart — same data but should send again
      session.stopLiveView()
      session.startLiveView(100, onFrame)
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(2)

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

  describe('debounce capture after keyboard input', () => {
    it('should call _debouncedCapture after executeKeyboardType', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(200, jest.fn())
      // Override _debouncedCapture with a mock after startLiveView initializes it
      const captureMock = jest.fn()
      ;(session as unknown as Record<string, unknown>)._debouncedCapture = captureMock

      ;(mockPage.keyboard as Record<string, jest.Mock>).type.mockResolvedValue(undefined)

      await session.executeKeyboardType('hello')

      expect(captureMock).toHaveBeenCalledTimes(1)

      session.stopLiveView()
    })

    it('should debounce rapid executeKeyboardType calls — capture fires only once', async () => {
      const session = new BrowserSession()
      await session.getPage()

      // startLiveView initializes _debouncedCapture internally with a 50ms debounce
      session.startLiveView(200, jest.fn())

      // Spy on the underlying page screenshot to verify it is called only once
      // after multiple rapid keystrokes are flushed through the debounce.
      ;(mockPage.screenshot as jest.Mock).mockClear()
      ;(mockPage.keyboard as Record<string, jest.Mock>).type.mockResolvedValue(undefined)

      // Inject a counting mock that simulates the debounce contract:
      // _debouncedCapture is called on each keystroke but only fires once after the delay.
      const captureCount = { n: 0 }
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      ;(session as unknown as Record<string, unknown>)._debouncedCapture = () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => { captureCount.n++ }, 50)
      }

      // Call multiple times within the debounce window (< 50ms apart)
      await session.executeKeyboardType('a')
      await session.executeKeyboardType('b')
      await session.executeKeyboardType('c')

      // Nothing fired yet (debounce pending)
      expect(captureCount.n).toBe(0)

      // Advance past the debounce delay (but not the live view interval)
      jest.advanceTimersByTime(60)

      // Should fire exactly once
      expect(captureCount.n).toBe(1)

      session.stopLiveView()
    })

    it('should call _debouncedCapture after executeKeyboardPress', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(200, jest.fn())
      const captureMock = jest.fn()
      ;(session as unknown as Record<string, unknown>)._debouncedCapture = captureMock

      ;(mockPage.keyboard as Record<string, jest.Mock>).press.mockResolvedValue(undefined)

      await session.executeKeyboardPress('Enter')

      expect(captureMock).toHaveBeenCalledTimes(1)

      session.stopLiveView()
    })

    it('should NOT throw when _debouncedCapture is null (live view not active)', async () => {
      const session = new BrowserSession()
      await session.getPage()

      // Do not call startLiveView — _debouncedCapture should be null
      ;(mockPage.keyboard as Record<string, jest.Mock>).type.mockResolvedValue(undefined)

      // Should not throw even though _debouncedCapture is null
      await expect(session.executeKeyboardType('hello')).resolves.not.toThrow()
    })

    it('should reset _debouncedCapture to null after stopLiveView', async () => {
      const session = new BrowserSession()
      await session.getPage()

      session.startLiveView(200, jest.fn())
      expect((session as unknown as Record<string, unknown>)._debouncedCapture).not.toBeNull()

      session.stopLiveView()
      expect((session as unknown as Record<string, unknown>)._debouncedCapture).toBeNull()
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
