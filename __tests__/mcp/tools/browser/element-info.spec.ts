import { formatElementInfo, getElementAtPoint, getFocusedElementInfo, type ElementInfo } from '../../../../src/mcp/tools/browser/element-info'

describe('element-info', () => {
  describe('formatElementInfo', () => {
    it('should format a button element', () => {
      const info: ElementInfo = {
        selector: 'button:has-text("Submit")',
        tagName: 'button',
        role: 'button',
        text: 'Submit',
      }
      const result = formatElementInfo(info)
      expect(result).toContain('selector="button:has-text("Submit")"')
      expect(result).toContain('<button role=button>')
      expect(result).toContain('text="Submit"')
    })

    it('should format an input element with label', () => {
      const info: ElementInfo = {
        selector: 'input[name="email"]',
        tagName: 'input',
        type: 'email',
        role: 'textbox',
        label: 'Email address',
      }
      const result = formatElementInfo(info)
      expect(result).toContain('selector="input[name="email"]"')
      expect(result).toContain('<input type=email role=textbox>')
      expect(result).toContain('label="Email address"')
    })

    it('should format a link with href', () => {
      const info: ElementInfo = {
        selector: 'a:has-text("Home")',
        tagName: 'a',
        role: 'link',
        text: 'Home',
        href: '/home',
      }
      const result = formatElementInfo(info)
      expect(result).toContain('href="/home"')
    })

    it('should format minimal element', () => {
      const info: ElementInfo = {
        selector: 'div',
        tagName: 'div',
      }
      const result = formatElementInfo(info)
      expect(result).toBe('selector="div" <div>')
    })
  })

  describe('getElementAtPoint', () => {
    it('should return null on error', async () => {
      const mockPage = {
        evaluate: jest.fn().mockRejectedValue(new Error('eval error')),
      }
      const result = await getElementAtPoint(mockPage, 100, 200)
      expect(result).toBeNull()
    })

    it('should call page.evaluate with coordinates', async () => {
      const mockInfo: ElementInfo = {
        selector: '#btn',
        tagName: 'button',
        role: 'button',
        text: 'Click me',
      }
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue(mockInfo),
      }
      const result = await getElementAtPoint(mockPage, 100, 200)
      expect(result).toEqual(mockInfo)
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(String), { x: 100, y: 200 })
    })

    it('should return null when evaluate returns null', async () => {
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue(null),
      }
      const result = await getElementAtPoint(mockPage, 0, 0)
      expect(result).toBeNull()
    })
  })

  describe('getFocusedElementInfo', () => {
    it('should return null on error', async () => {
      const mockPage = {
        evaluate: jest.fn().mockRejectedValue(new Error('eval error')),
      }
      const result = await getFocusedElementInfo(mockPage)
      expect(result).toBeNull()
    })

    it('should call page.evaluate', async () => {
      const mockInfo: ElementInfo = {
        selector: 'input[name="search"]',
        tagName: 'input',
        type: 'text',
        role: 'textbox',
        label: 'Search',
      }
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue(mockInfo),
      }
      const result = await getFocusedElementInfo(mockPage)
      expect(result).toEqual(mockInfo)
      expect(mockPage.evaluate).toHaveBeenCalledWith(expect.any(String))
    })

    it('should return null when no element is focused', async () => {
      const mockPage = {
        evaluate: jest.fn().mockResolvedValue(null),
      }
      const result = await getFocusedElementInfo(mockPage)
      expect(result).toBeNull()
    })
  })
})
