// We test the playwright-loader module by directly testing its behavior.
// Playwright IS installed in this test environment (dev dependency).
// Tests cover both the "available" and "not available" code paths
// by using jest.doMock to simulate playwright being absent.

describe('playwright-loader', () => {
  let isPlaywrightAvailable: () => boolean
  let loadPlaywright: () => unknown
  let resetPlaywrightCache: () => void

  beforeEach(() => {
    // Fresh import for each test to avoid module-level cache issues
    jest.resetModules()
    jest.dontMock('playwright')
    const mod = require('../../../../src/mcp/tools/browser/playwright-loader')
    isPlaywrightAvailable = mod.isPlaywrightAvailable
    loadPlaywright = mod.loadPlaywright
    resetPlaywrightCache = mod.resetPlaywrightCache
  })

  afterEach(() => {
    jest.dontMock('playwright')
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

    it('should return true when playwright is installed (module found)', () => {
      // Playwright is installed in this env so require.resolve succeeds
      const result = isPlaywrightAvailable()
      expect(result).toBe(true)
    })

    it('should return false when playwright module cannot be resolved (not installed scenario)', () => {
      // Mock playwright to simulate it being missing
      jest.resetModules()
      jest.doMock('playwright', () => {
        throw new Error('Cannot find module playwright')
      })

      // Also need to patch require.resolve since isPlaywrightAvailable uses require.resolve
      // Jest's require uses the module registry but require.resolve uses Node's resolver.
      // We use the "loadAttempted" cache path instead: call loadPlaywright first to set
      // loadAttempted=true with cachedModule=null, then isPlaywrightAvailable returns false.
      const mod = require('../../../../src/mcp/tools/browser/playwright-loader')

      // Calling loadPlaywright() sets loadAttempted=true; since jest.doMock makes it throw,
      // cachedModule remains null
      expect(() => mod.loadPlaywright()).toThrow('Playwright is not installed')

      // Now isPlaywrightAvailable uses cached state: loadAttempted=true, cachedModule=null → false
      const result = mod.isPlaywrightAvailable()
      expect(result).toBe(false)
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

    it('should return playwright module when installed', () => {
      const mod = loadPlaywright()
      expect(mod).toBeDefined()
      expect(typeof mod).toBe('object')
    })

    it('should throw a user-friendly error when playwright require fails', () => {
      // Simulate playwright missing via jest.doMock
      jest.resetModules()
      jest.doMock('playwright', () => {
        throw new Error('Cannot find module playwright')
      })

      const mod = require('../../../../src/mcp/tools/browser/playwright-loader')
      expect(() => mod.loadPlaywright()).toThrow(
        'Playwright is not installed. Install it with: npm install playwright && npx playwright install chromium',
      )
    })

    it('should return cached module on second call without re-requiring', () => {
      // First load sets cachedModule
      const first = loadPlaywright()
      // Second load returns same cached reference (no new require needed)
      const second = loadPlaywright()
      expect(first).toBe(second)
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

    it('should clear cached module so isPlaywrightAvailable uses loadAttempted=false path after reset', () => {
      // Load once (sets cachedModule, then isPlaywrightAvailable uses cached path)
      loadPlaywright()
      // isPlaywrightAvailable now returns via cached path (loadAttempted=true)
      expect(isPlaywrightAvailable()).toBe(true)

      // Reset — clears both cachedModule and loadAttempted
      resetPlaywrightCache()

      // After reset: loadAttempted=false, so isPlaywrightAvailable re-runs require.resolve
      const afterReset = isPlaywrightAvailable()
      expect(afterReset).toBe(true) // playwright still installed
    })

    it('should allow loadPlaywright to re-require after cache reset', () => {
      // Load once
      const first = loadPlaywright()
      expect(first).toBeDefined()

      // Reset cache
      resetPlaywrightCache()

      // Load again — cache cleared, re-requires playwright
      const second = loadPlaywright()
      expect(second).toBeDefined()
      // Same playwright module (equal by reference since Node caches require results)
      expect(second).toBe(first)
    })
  })
})
