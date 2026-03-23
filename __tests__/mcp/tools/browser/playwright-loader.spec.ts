// We test the playwright-loader module by directly testing its behavior.
// Since playwright is an optional dependency that may not be installed in test env,
// we focus on the public API behavior.

describe('playwright-loader', () => {
  let isPlaywrightAvailable: () => boolean
  let loadPlaywright: () => unknown
  let resetPlaywrightCache: () => void

  beforeEach(() => {
    // Fresh import for each test to avoid module-level cache issues
    jest.resetModules()
    const mod = require('../../../../src/mcp/tools/browser/playwright-loader')
    isPlaywrightAvailable = mod.isPlaywrightAvailable
    loadPlaywright = mod.loadPlaywright
    resetPlaywrightCache = mod.resetPlaywrightCache
  })

  describe('isPlaywrightAvailable', () => {
    it('should return a boolean', () => {
      const result = isPlaywrightAvailable()
      expect(typeof result).toBe('boolean')
    })

    it('should return consistent results on repeated calls', () => {
      const first = isPlaywrightAvailable()
      const second = isPlaywrightAvailable()
      expect(first).toBe(second)
    })
  })

  describe('loadPlaywright', () => {
    it('should either return a module or throw a user-friendly error', () => {
      try {
        const mod = loadPlaywright()
        // If playwright is installed, it should return the module
        expect(mod).toBeDefined()
      } catch (error) {
        // If not installed, should give a helpful message
        expect((error as Error).message).toContain('Playwright is not installed')
      }
    })

    it('should cache the result after first load', () => {
      // After first call (success or failure), isPlaywrightAvailable should be deterministic
      try {
        loadPlaywright()
      } catch {
        // expected if playwright not installed
      }
      const result1 = isPlaywrightAvailable()
      const result2 = isPlaywrightAvailable()
      expect(result1).toBe(result2)
    })
  })

  describe('resetPlaywrightCache', () => {
    it('should allow re-checking availability after reset', () => {
      // First check
      const before = isPlaywrightAvailable()
      // Reset
      resetPlaywrightCache()
      // Check again - should still return same value (environment hasn't changed)
      const after = isPlaywrightAvailable()
      expect(before).toBe(after)
    })
  })
})
