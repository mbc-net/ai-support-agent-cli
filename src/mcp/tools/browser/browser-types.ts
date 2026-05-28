/**
 * Browser tool types
 */

export type { BrowserCredentials } from '../../../types'

export const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:']

// Selector / navigation timeouts
export const SELECTOR_TIMEOUT_NAVIGATION_MS = 30_000
export const SELECTOR_TIMEOUT_SINGLE_MS = 10_000
export const SELECTOR_TIMEOUT_MULTIPLE_MS = 5_000
