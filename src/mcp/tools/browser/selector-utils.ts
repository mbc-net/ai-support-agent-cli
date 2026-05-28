/**
 * selector-utils.ts — Utility for trying multiple comma-separated CSS selectors.
 *
 * When AI sends comma-separated selectors like
 *   `button:has-text("OK"), a:has-text("OK"), [aria-label*="OK"]`
 * these helpers try each one sequentially and return the selector that matched.
 */

import { logger } from '../../../logger'
import {
  BROWSER_TIMEOUT_PAGE_LOAD_MS,
  BROWSER_TIMEOUT_SELECTOR_FALLBACK_MS,
  BROWSER_TIMEOUT_SELECTOR_MS,
} from './browser-types'

/**
 * Try multiple comma-separated CSS selectors for a click action.
 * Returns the selector that actually matched.
 * If the selector contains no commas, it is used as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryClickSelectors(page: any, selectors: string, options?: { waitForNavigation?: boolean }): Promise<string> {
  const candidates = selectors.split(',').map(s => s.trim()).filter(Boolean)

  if (candidates.length <= 1) {
    const sel = selectors.trim()
    if (options?.waitForNavigation) {
      await Promise.all([
        page.waitForNavigation({ timeout: BROWSER_TIMEOUT_PAGE_LOAD_MS }).catch(() => { /* navigation may not happen */ }),
        page.click(sel, { timeout: BROWSER_TIMEOUT_SELECTOR_MS }),
      ])
    } else {
      await page.click(sel, { timeout: BROWSER_TIMEOUT_SELECTOR_MS })
    }
    return sel
  }

  // Multiple candidates — try each
  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const count: number = await page.locator(candidate).count()
      if (count === 0) continue

      if (options?.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: BROWSER_TIMEOUT_PAGE_LOAD_MS }).catch(() => { /* navigation may not happen */ }),
          page.click(candidate, { timeout: BROWSER_TIMEOUT_SELECTOR_FALLBACK_MS }),
        ])
      } else {
        await page.click(candidate, { timeout: BROWSER_TIMEOUT_SELECTOR_FALLBACK_MS })
      }
      logger.debug(`[browser] Selector matched: ${candidate}`)
      return candidate
    } catch (err) {
      lastError = err as Error
      continue
    }
  }

  throw lastError ?? new Error(`No matching element found for: ${selectors}`)
}

/**
 * Try multiple comma-separated CSS selectors for a fill action.
 * Returns the selector that actually matched.
 * If the selector contains no commas, it is used as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryFillSelectors(page: any, selectors: string, value: string): Promise<string> {
  const candidates = selectors.split(',').map(s => s.trim()).filter(Boolean)

  if (candidates.length <= 1) {
    const sel = selectors.trim()
    await page.fill(sel, value, { timeout: BROWSER_TIMEOUT_SELECTOR_MS })
    return sel
  }

  // Multiple candidates — try each
  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const count: number = await page.locator(candidate).count()
      if (count === 0) continue

      await page.fill(candidate, value, { timeout: BROWSER_TIMEOUT_SELECTOR_FALLBACK_MS })
      logger.debug(`[browser] Selector matched: ${candidate}`)
      return candidate
    } catch (err) {
      lastError = err as Error
      continue
    }
  }

  throw lastError ?? new Error(`No matching element found for: ${selectors}`)
}
