/**
 * Browser tool types
 */

export type { BrowserCredentials } from '../../../types'

export const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:']

// Selector / navigation timeouts
export const SELECTOR_TIMEOUT_NAVIGATION_MS = 30_000 // page.goto / waitForNavigation
export const SELECTOR_TIMEOUT_SINGLE_MS = 10_000 // single-candidate click / fill / innerText / waitForSelector
export const SELECTOR_TIMEOUT_MULTIPLE_MS = 5_000 // multi-candidate fallback click / fill

// HTTP request timeouts
export const BROWSER_TIMEOUT_REQUEST_MS = 3_000 // HTTP GET probe

// Delay between retries while resolving the first active browser session
export const BROWSER_SESSION_RETRY_DELAY_MS = 500
