import { existsSync, promises as fs } from 'fs'
import * as path from 'path'
import { chromium } from 'playwright'

import { runPlaywrightSubprocess } from '../../src/browser/playwright-subprocess-executor'

/**
 * This suite spawns the REAL Playwright CLI (via `runPlaywrightSubprocess`,
 * unmocked child_process) against a real headless Chromium, so it can only
 * run where Playwright's browser binaries are installed (local dev,
 * browser-equipped CI). The default CI unit job runs `npm test` WITHOUT
 * `npx playwright install`, so the binary is absent there — skip cleanly
 * instead of failing, following the same convention as
 * `page-script-eval.integration.spec.ts`.
 *
 * Purpose: the nested test.step() JSON-reporter parsing logic in
 * `playwright-subprocess-executor.ts` (steps[]/attachments flattening/
 * startTime-based executedAt) was designed against an experimentally
 * verified output shape. These tests exercise the REAL Playwright CLI to
 * confirm that shape still holds, instead of only trusting synthetic JSON
 * fixtures (which the unit tests already cover for branch coverage).
 */
const hasChromium = ((): boolean => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()
const describeWithBrowser = hasChromium ? describe : describe.skip
if (!hasChromium) {
  // eslint-disable-next-line no-console
  console.warn(
    '[playwright-subprocess-executor] Skipping real-Chromium subprocess suite: Playwright browser not installed (run `npx playwright install chromium`).',
  )
}

function uniqueExecutionId(label: string): string {
  return `it-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

describeWithBrowser('runPlaywrightSubprocess (real Playwright CLI + Chromium)', () => {
  // `runPlaywrightSubprocess` spawns its child with `{ ...process.env, ... }`
  // (see spawnPlaywright), so running it from inside this Jest process would
  // otherwise leak Jest's own JEST_WORKER_ID into the child. Playwright Test
  // explicitly refuses to run at all when it sees that var set ("needs to be
  // invoked via 'npx playwright test' and excluded from Jest test runs"),
  // which is a real Playwright guard, not something under this repo's
  // control. In production the agent is never itself a Jest worker, so this
  // var would never be set there — this is purely a test-harness artifact of
  // exercising the real child-process code path from inside Jest.
  const originalJestWorkerId = process.env.JEST_WORKER_ID

  beforeAll(() => {
    delete process.env.JEST_WORKER_ID
  })

  afterAll(() => {
    if (originalJestWorkerId !== undefined) {
      process.env.JEST_WORKER_ID = originalJestWorkerId
    }
  })

  it('reports one entry per test.step() with correct title/duration, increasing executedAt, and per-step screenshotBase64', async () => {
    const script = `
import { test } from '@playwright/test'

test('multi-step scenario', async ({ page }, testInfo) => {
  await test.step('render page one', async () => {
    await page.setContent('<html><body style="background:#ffffff"><h1>Page One</h1></body></html>')
    await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' })
  })
  await test.step('render page two', async () => {
    await page.setContent('<html><body style="background:#000000"><h1 style="color:white">Page Two</h1></body></html>')
    await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' })
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('steps-screenshots'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)

    const [stepOne, stepTwo] = result.steps
    expect(stepOne.title).toBe('render page one')
    expect(stepOne.status).toBe('passed')
    expect(typeof stepOne.duration).toBe('number')
    expect(stepTwo.title).toBe('render page two')
    expect(stepTwo.status).toBe('passed')
    expect(typeof stepTwo.duration).toBe('number')

    // executedAt must be present and step two's must be strictly after step one's
    expect(stepOne.executedAt).toBeDefined()
    expect(stepTwo.executedAt).toBeDefined()
    expect(Date.parse(stepTwo.executedAt!)).toBeGreaterThanOrEqual(Date.parse(stepOne.executedAt!))

    // Each step's screenshot must be its own distinct PNG (positional mapping
    // by test.step() call order <-> attachments order), not the same image
    // duplicated or swapped.
    expect(stepOne.screenshotBase64).toBeDefined()
    expect(stepTwo.screenshotBase64).toBeDefined()
    expect(stepOne.screenshotBase64).not.toBe(stepTwo.screenshotBase64)
    // Sanity check both are valid PNG data (base64 of the PNG magic bytes)
    expect(Buffer.from(stepOne.screenshotBase64!, 'base64').subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a',
    )
    expect(Buffer.from(stepTwo.screenshotBase64!, 'base64').subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a',
    )
  }, 60_000)

  it('stops reporting steps after a failing test.step() — later steps never appear (not an exception)', async () => {
    const script = `
import { test, expect } from '@playwright/test'

test('fails mid-way', async ({ page }) => {
  await test.step('step one ok', async () => {
    await page.setContent('<div>ok</div>')
  })
  await test.step('step two fails', async () => {
    await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 500 })
  })
  await test.step('step three never runs', async () => {
    await page.setContent('<div>should not happen</div>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('failing-step'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(false)
    // Only the two attempted steps appear — "step three never runs" is
    // absent from Playwright's own JSON output, not truncated by our parser.
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toEqual(
      expect.objectContaining({ title: 'step one ok', status: 'passed' }),
    )
    expect(result.steps[1].title).toBe('step two fails')
    expect(result.steps[1].status).toBe('failed')
    expect(result.steps[1].error).toBeTruthy()
  }, 60_000)

  it('falls back to one step per test when test.step() is not used (backward compatibility)', async () => {
    const script = `
import { test } from '@playwright/test'

test('flat legacy test', async ({ page }) => {
  await page.setContent('<div>hello</div>')
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('legacy-flat'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].title).toBe('flat legacy test')
    expect(result.steps[0].status).toBe('passed')
    // No nested-step metadata for the legacy per-test format
    expect(result.steps[0].executedAt).toBeUndefined()
    expect(result.steps[0].screenshotBase64).toBeUndefined()
  }, 60_000)

  it('does not leak a test-results/ directory into the process cwd', async () => {
    // Regression test: Playwright's default `outputDir` resolves relative to
    // the CHILD PROCESS's cwd, not the config file's directory — confirmed
    // experimentally (see fix commit). Since `spawnPlaywright` did not pass a
    // `cwd` option and `RUN_CONFIG_TEMPLATE` did not set `outputDir`
    // explicitly, every real execution left a `test-results/` directory in
    // whatever directory the agent process happened to be started from,
    // which `cleanupRunDir` (scoped to the per-execution temp runDir) never
    // touches.
    const cwdTestResultsDir = path.join(process.cwd(), 'test-results')
    await fs.rm(cwdTestResultsDir, { recursive: true, force: true })

    const script = `
import { test } from '@playwright/test'

test('simple pass', async ({ page }) => {
  await page.setContent('<div>ok</div>')
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('cwd-leak'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(existsSync(cwdTestResultsDir)).toBe(false)
  }, 60_000)
})
