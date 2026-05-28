/**
 * Browser tool types
 */

export type { BrowserCredentials } from '../../../types'

export const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:']

// Playwright timeout constants
export const BROWSER_TIMEOUT_PAGE_LOAD_MS = 30_000   // page.goto / waitForNavigation
export const BROWSER_TIMEOUT_SELECTOR_MS = 10_000    // single-candidate click / fill / innerText / waitForSelector
export const BROWSER_TIMEOUT_SELECTOR_FALLBACK_MS = 5_000  // multi-candidate fallback click / fill
export const BROWSER_TIMEOUT_REQUEST_MS = 3_000      // HTTP GET probe
