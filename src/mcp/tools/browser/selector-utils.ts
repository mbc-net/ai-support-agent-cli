/**
 * selector-utils.ts — Utility for trying multiple comma-separated CSS selectors.
 *
 * When AI sends comma-separated selectors like
 *   `button:has-text("OK"), a:has-text("OK"), [aria-label*="OK"]`
 * these helpers try each one sequentially and return the selector that matched.
 */

import type { Page } from 'playwright'

import { logger } from '../../../logger'
import { truncateString } from '../../../utils'
import {
  ACTION_LOG_PREVIEW_MAX_LENGTH,
  GET_TEXT_MAX_LENGTH,
  MAX_WAIT_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MULTIPLE_MS,
  SELECTOR_TIMEOUT_NAVIGATION_MS,
  SELECTOR_TIMEOUT_SINGLE_MS,
} from './browser-types'

/**
 * Split a comma-separated selector string into trimmed, non-empty candidates.
 * Shared by tryClickSelectors/tryFillSelectors so both stay in sync on how
 * candidates are parsed (trimming, dropping empty segments from things like
 * a trailing comma).
 */
function parseSelectorCandidates(selectors: string): string[] {
  return selectors.split(',').map(s => s.trim()).filter(Boolean)
}

/**
 * Apply the optional post-navigation `waitForSelector` / `waitForTimeout`
 * params shared by the browser_navigate MCP tool and its local-server HTTP
 * counterpart: wait for a selector to appear, then wait for an additional
 * (clamped) delay. Both are no-ops when their param is falsy/undefined.
 */
export async function applyPostNavigateWait(
  page: Page,
  waitForSelector: string | undefined,
  waitForTimeout: number | undefined,
): Promise<void> {
  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: SELECTOR_TIMEOUT_SINGLE_MS })
  }
  if (waitForTimeout) {
    const clampedTimeout = Math.min(waitForTimeout, MAX_WAIT_TIMEOUT_MS)
    await page.waitForTimeout(clampedTimeout)
  }
}

/**
 * Truncate a page-extracted text blob (e.g. innerText()) so it does not
 * overwhelm the LLM context. Shared by browser_get_text / browser_extract
 * across the in-process MCP tool and the local-server HTTP handler.
 */
export function truncateForContext(text: string, maxLength: number = GET_TEXT_MAX_LENGTH): string {
  return truncateString(text, maxLength, '\n... (truncated)')
}

/**
 * Collapse whitespace and truncate to a single-line preview for display in
 * the browser action log (e.g. `get_text "selector" → "preview…"`).
 */
export function actionLogPreview(text: string, maxLength: number = ACTION_LOG_PREVIEW_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return truncateString(collapsed, maxLength, '…')
}

/**
 * Try multiple comma-separated CSS selectors for a click action.
 * Returns the selector that actually matched.
 * If the selector contains no commas, it is used as-is.
 */
export async function tryClickSelectors(page: Page, selectors: string, options?: { waitForNavigation?: boolean }): Promise<string> {
  const candidates = parseSelectorCandidates(selectors)

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
  const candidates = parseSelectorCandidates(selectors)

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
