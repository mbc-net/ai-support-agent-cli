/**
 * Dynamic Playwright loader.
 * Playwright is an optional dependency — this module handles its absence gracefully.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightModule = any

let cachedModule: PlaywrightModule | null = null
let loadAttempted = false

/**
 * Check if Playwright is available (installed).
 */
export function isPlaywrightAvailable(): boolean {
  if (loadAttempted) return cachedModule !== null
  try {
    require.resolve('playwright')
    return true
  } catch {
    return false
  }
}

/**
 * Dynamically load the Playwright module.
 * Throws a user-friendly error if not installed.
 */
export function loadPlaywright(): PlaywrightModule {
  if (cachedModule) return cachedModule
  loadAttempted = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require('playwright')
    return cachedModule
  } catch {
    throw new Error(
      'Playwright is not installed. Install it with: npm install playwright && npx playwright install chromium',
    )
  }
}

/**
 * Reset internal cache (for testing).
 */
export function resetPlaywrightCache(): void {
  cachedModule = null
  loadAttempted = false
}
