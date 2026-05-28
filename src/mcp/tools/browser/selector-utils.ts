/**
 * selector-utils.ts — Utility for trying multiple comma-separated CSS selectors.
 *
 * When AI sends comma-separated selectors like
 *   `button:has-text("OK"), a:has-text("OK"), [aria-label*="OK"]`
 * these helpers try each one sequentially and return the selector that matched.
 */

import type { Page } from 'playwright'

import { logger } from '../../../logger'
import {
  SELECTOR_TIMEOUT_MULTIPLE_MS,
  SELECTOR_TIMEOUT_NAVIGATION_MS,
  SELECTOR_TIMEOUT_SINGLE_MS,
} from './browser-types'

/**
 * Try multiple comma-separated CSS selectors for a click action.
 * Returns the selector that actually matched.
 * If the selector contains no commas, it is used as-is.
 */
export async function tryClickSelectors(page: Page, selectors: string, options?: { waitForNavigation?: boolean }): Promise<string> {
  const candidates = selectors.split(',').map(s => s.trim()).filter(Boolean)

  if (candidates.length <= 1) {
    const sel = selectors.trim()
    if (options?.waitForNavigation) {
      await Promise.all([
        page.waitForNavigation({ timeout: SELECTOR_TIMEOUT_NAVIGATION_MS }).catch(() => undefined /* navigation may not happen */),
        page.click(sel, { timeout: SELECTOR_TIMEOUT_SINGLE_MS }),
      ])
    } else {
      await page.click(sel, { timeout: SELECTOR_TIMEOUT_SINGLE_MS })
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
          page.waitForNavigation({ timeout: SELECTOR_TIMEOUT_NAVIGATION_MS }).catch(() => undefined /* navigation may not happen */),
          page.click(candidate, { timeout: SELECTOR_TIMEOUT_MULTIPLE_MS }),
        ])
      } else {
        await page.click(candidate, { timeout: SELECTOR_TIMEOUT_MULTIPLE_MS })
      }
      logger.debug(`[browser] Selector matched: ${candidate}`)
      return candidate
    } catch (err: unknown) {
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
export async function tryFillSelectors(page: Page, selectors: string, value: string): Promise<string> {
  const candidates = selectors.split(',').map(s => s.trim()).filter(Boolean)

  if (candidates.length <= 1) {
    const sel = selectors.trim()
    await page.fill(sel, value, { timeout: SELECTOR_TIMEOUT_SINGLE_MS })
    return sel
  }

  // Multiple candidates — try each
  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      const count: number = await page.locator(candidate).count()
      if (count === 0) continue

      await page.fill(candidate, value, { timeout: SELECTOR_TIMEOUT_MULTIPLE_MS })
      logger.debug(`[browser] Selector matched: ${candidate}`)
      return candidate
    } catch (err: unknown) {
      lastError = err as Error
      continue
    }
  }

  throw lastError ?? new Error(`No matching element found for: ${selectors}`)
}
