import { chromium, type Browser, type Page } from 'playwright'

import {
  getCursorAt,
  getElementAtPoint,
  getFocusedElementInfo,
} from '../../../../src/mcp/tools/browser/element-info'
import { FOCUS_REPORTING_SCRIPT } from '../../../../src/mcp/tools/browser/browser-session'

/**
 * Regression test for the page-script execution bug.
 *
 * The browser helper scripts were defined as bare arrow-function STRINGS and
 * passed to page.evaluate()/page.addInitScript(). Playwright treats a string
 * pageFunction as an EXPRESSION (not a callable), so the arrow functions were
 * never invoked and any arg was ignored — every call silently returned
 * undefined / installed nothing. That made:
 *   - cursor shape (getCursorAt) always 'default'
 *   - the focus/caret overlay (FOCUS_REPORTING_SCRIPT) never fire
 *
 * These tests run a REAL headless Chromium (the agent's runtime), so they fail
 * (red) on the broken string-based code and pass (green) once the scripts are
 * passed as real functions.
 */
describe('browser page-script execution (real Chromium)', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    page = await context.newPage()
  })

  afterEach(async () => {
    await page?.context().close()
  })

  it('getCursorAt returns the real CSS cursor (pointer) over a link', async () => {
    await page.setContent(
      '<a href="#" style="cursor:pointer;position:absolute;left:0;top:0;width:400px;height:300px">link</a>',
    )
    const cursor = await getCursorAt(page, 50, 50)
    expect(cursor).toBe('pointer')
  })

  it('getCursorAt returns "text" over a text input', async () => {
    await page.setContent(
      '<input style="position:absolute;left:0;top:0;width:400px;height:60px" />',
    )
    const cursor = await getCursorAt(page, 50, 20)
    expect(cursor).toBe('text')
  })

  it('getElementAtPoint resolves a real element (not null) at the point', async () => {
    await page.setContent(
      '<button id="go" style="position:absolute;left:0;top:0;width:400px;height:200px">Go</button>',
    )
    const info = await getElementAtPoint(page, 50, 50)
    expect(info).not.toBeNull()
    expect(info?.selector).toBe('#go')
  })

  it('getFocusedElementInfo reports the focused input', async () => {
    await page.setContent('<input id="name" name="name" />')
    await page.focus('#name')
    const info = await getFocusedElementInfo(page)
    expect(info).not.toBeNull()
    expect(info?.tagName).toBe('input')
  })

  it('FOCUS_REPORTING_SCRIPT actually installs listeners and fires the binding on focus', async () => {
    const calls: Array<{ focused: boolean }> = []
    // Mirror browser-session.ts enableFocusReporting wiring.
    await page.exposeBinding(
      '__onBrowserFocus',
      (_source, payload: { focused: boolean }) => {
        calls.push(payload)
      },
    )
    await page.addInitScript(FOCUS_REPORTING_SCRIPT)
    await page.setContent('<input id="a" /><input id="b" />')
    // Re-run after content load (browser-session calls evaluate(FOCUS_REPORTING_SCRIPT)).
    await page.evaluate(FOCUS_REPORTING_SCRIPT)
    await page.focus('#a')
    // Poll the Node-side calls array until a focused:true arrives (the focusin
    // handler + binding round-trip are async) instead of a fixed sleep.
    const deadline = Date.now() + 5000
    while (!calls.some((c) => c.focused === true) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const focusedTrue = calls.filter((c) => c.focused === true)
    expect(focusedTrue.length).toBeGreaterThan(0)
  })
})
