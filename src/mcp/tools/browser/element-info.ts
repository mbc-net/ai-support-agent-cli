/**
 * element-info.ts — Extracts Playwright-friendly element information from the page.
 *
 * Used by BrowserSession to enrich action logs with CSS selectors, element types,
 * and text content so that chat AI can reproduce user interactions via Playwright.
 */

import type { Page } from 'playwright'

import { logger } from '../../../logger'
import {
  CURSOR_AT_POINT_SCRIPT,
  ELEMENT_AT_POINT_SCRIPT,
  FOCUSED_ELEMENT_SCRIPT,
} from './page-scripts'

/** Structured information about a DOM element */
export interface ElementInfo {
  /** Best CSS selector for Playwright (e.g., '#submit-btn', 'button:has-text("Login")') */
  selector: string
  /** Tag name (e.g., 'button', 'input', 'a') */
  tagName: string
  /** Element type attribute for input/button (e.g., 'text', 'submit', 'checkbox') */
  type?: string
  /** Visible text content (truncated) */
  text?: string
  /** Role attribute or implicit ARIA role */
  role?: string
  /** name, placeholder, aria-label, or title attribute */
  label?: string
  /** href for links */
  href?: string
}

/**
 * Get element info at the given coordinates via page.evaluate().
 * Returns null if no element found or on error.
 */
export async function getElementAtPoint(page: Page, x: number, y: number): Promise<ElementInfo | null> {
  try {
    return await page.evaluate(ELEMENT_AT_POINT_SCRIPT, { x, y }) as ElementInfo | null
  } catch (error) {
    // The script now actually executes in the page, so real eval errors reach
    // here; log them (debug — this is best-effort enrichment) instead of
    // silently dropping them.
    logger.debug(`[browser] getElementAtPoint evaluate failed: ${String(error)}`)
    return null
  }
}

/**
 * Get info about the currently focused element.
 * Returns null if no element is focused or on error.
 */
export async function getFocusedElementInfo(page: Page): Promise<ElementInfo | null> {
  try {
    return await page.evaluate(FOCUSED_ELEMENT_SCRIPT) as ElementInfo | null
  } catch (error) {
    logger.debug(`[browser] getFocusedElementInfo evaluate failed: ${String(error)}`)
    return null
  }
}

/**
 * Get the CSS `cursor` value of the element at the given coordinates.
 *
 * Returns 'default' when no element is at the point or the computed cursor is
 * empty/non-string. Unlike getElementAtPoint, this does NOT swallow evaluate
 * errors: it re-throws so the caller (mouse-move handler) can skip sending a
 * cursor update for that frame instead of reporting a misleading 'default'.
 */
export async function getCursorAt(page: Page, x: number, y: number): Promise<string> {
  const result = await page.evaluate(CURSOR_AT_POINT_SCRIPT, { x, y })
  return typeof result === 'string' ? result : 'default'
}

/**
 * Format ElementInfo into a human-readable, Playwright-actionable string.
 */
export function formatElementInfo(info: ElementInfo): string {
  const parts: string[] = []

  // selector is always first — the most important part for Playwright
  parts.push(`selector="${info.selector}"`)

  // Element description
  const desc: string[] = [info.tagName]
  if (info.type) desc.push(`type=${info.type}`)
  if (info.role) desc.push(`role=${info.role}`)
  parts.push(`<${desc.join(' ')}>`)

  if (info.label) parts.push(`label="${info.label}"`)
  if (info.text) parts.push(`text="${info.text}"`)
  if (info.href) parts.push(`href="${info.href}"`)

  return parts.join(' ')
}
