import { tryClickSelectors, tryFillSelectors } from '../../../../src/mcp/tools/browser/selector-utils'

function createMockPage(matchingSelectors: string[] = []) {
  const page = {
    click: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    waitForNavigation: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockImplementation((selector: string) => ({
      count: jest.fn().mockResolvedValue(matchingSelectors.includes(selector) ? 1 : 0),
    })),
  }
  return page
}

describe('selector-utils', () => {
  describe('tryClickSelectors', () => {
    it('should click single selector directly', async () => {
      const page = createMockPage()
      const result = await tryClickSelectors(page, '#submit')
      expect(result).toBe('#submit')
      expect(page.click).toHaveBeenCalledWith('#submit', { timeout: 10000 })
    })

    it('should handle single selector with waitForNavigation', async () => {
      const page = createMockPage()
      const result = await tryClickSelectors(page, '#submit', { waitForNavigation: true })
      expect(result).toBe('#submit')
      expect(page.waitForNavigation).toHaveBeenCalled()
      expect(page.click).toHaveBeenCalledWith('#submit', { timeout: 10000 })
    })

    it('should try multiple selectors and return the matching one', async () => {
      const page = createMockPage(['.btn-ok'])
      const result = await tryClickSelectors(page, '#nonexistent, .btn-ok, .fallback')
      expect(result).toBe('.btn-ok')
      expect(page.click).toHaveBeenCalledWith('.btn-ok', { timeout: 5000 })
    })

    it('should try multiple selectors with waitForNavigation', async () => {
      const page = createMockPage(['.btn-ok'])
      const result = await tryClickSelectors(page, '#nonexistent, .btn-ok', { waitForNavigation: true })
      expect(result).toBe('.btn-ok')
      expect(page.waitForNavigation).toHaveBeenCalled()
    })

    it('should throw when no selector matches', async () => {
      const page = createMockPage()
      await expect(tryClickSelectors(page, '#a, #b, #c'))
        .rejects.toThrow('No matching element found')
    })

    it('should skip selectors with count 0 and try next', async () => {
      const page = createMockPage(['.third'])
      const result = await tryClickSelectors(page, '.first, .second, .third')
      expect(result).toBe('.third')
      expect(page.locator).toHaveBeenCalledWith('.first')
      expect(page.locator).toHaveBeenCalledWith('.second')
      expect(page.locator).toHaveBeenCalledWith('.third')
    })

    it('should handle click errors and try next', async () => {
      const page = createMockPage(['.first', '.second'])
      page.click.mockRejectedValueOnce(new Error('click failed'))
      const result = await tryClickSelectors(page, '.first, .second')
      expect(result).toBe('.second')
    })

    it('should trim whitespace from selectors', async () => {
      const page = createMockPage()
      const result = await tryClickSelectors(page, '  #submit  ')
      expect(result).toBe('#submit')
      expect(page.click).toHaveBeenCalledWith('#submit', { timeout: 10000 })
    })
  })

  describe('tryFillSelectors', () => {
    it('should fill single selector directly', async () => {
      const page = createMockPage()
      const result = await tryFillSelectors(page, '#email', 'test@test.com')
      expect(result).toBe('#email')
      expect(page.fill).toHaveBeenCalledWith('#email', 'test@test.com', { timeout: 10000 })
    })

    it('should try multiple selectors and return the matching one', async () => {
      const page = createMockPage(['input[name="email"]'])
      const result = await tryFillSelectors(page, '#nonexistent, input[name="email"]', 'test@test.com')
      expect(result).toBe('input[name="email"]')
      expect(page.fill).toHaveBeenCalledWith('input[name="email"]', 'test@test.com', { timeout: 5000 })
    })

    it('should throw when no selector matches', async () => {
      const page = createMockPage()
      await expect(tryFillSelectors(page, '#a, #b', 'value'))
        .rejects.toThrow('No matching element found')
    })

    it('should handle fill errors and try next', async () => {
      const page = createMockPage(['.first', '.second'])
      page.fill.mockRejectedValueOnce(new Error('fill failed'))
      const result = await tryFillSelectors(page, '.first, .second', 'value')
      expect(result).toBe('.second')
    })
  })
})
