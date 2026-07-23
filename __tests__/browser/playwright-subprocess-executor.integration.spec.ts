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

  // --- harness-level step screenshots (captureStepScreenshots) ---

  it('auto-captures a per-step screenshot for a git-synced style spec that never calls testInfo.attach()', async () => {
    // "airliza style": the test callback has NO testInfo param, aliases
    // `test.step` to a local `step`, and never attaches its own screenshot.
    // Without the harness preload this would yield ZERO screenshots (the
    // silent-failure bug); with it, every top-level step gets one.
    const script = `
import { test } from '@playwright/test'

test('git-synced multi-step, no attach', async ({ page }) => {
  const step = test.step
  await step('render alpha', async () => {
    await page.setContent('<html><body style="background:#ffffff"><h1>Alpha</h1></body></html>')
  })
  await step('render beta', async () => {
    await page.setContent('<html><body style="background:#000000"><h1 style="color:white">Beta</h1></body></html>')
  })
  await step('render gamma', async () => {
    await page.setContent('<html><body style="background:#3366ff"><h1>Gamma</h1></body></html>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-autocapture'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(3)

    // Every step must have a screenshot even though the spec never attached one.
    for (const step of result.steps) {
      expect(step.screenshotBase64).toBeDefined()
      // Valid PNG magic bytes.
      expect(
        Buffer.from(step.screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
      ).toBe('89504e470d0a1a0a')
    }

    // Distinct page content → distinct screenshots (no duplication/swapping).
    const [a, b, c] = result.steps
    expect(a.screenshotBase64).not.toBe(b.screenshotBase64)
    expect(b.screenshotBase64).not.toBe(c.screenshotBase64)
    expect(a.screenshotBase64).not.toBe(c.screenshotBase64)
  }, 60_000)

  it('maps each step to its own harness screenshot even when the spec ALSO self-attaches per step', async () => {
    // A spec that still self-attaches its own screenshot per step now produces
    // a redundant extra image alongside the harness-indexed one (expected — a
    // generator follow-up to stop self-attaching is deliberately deferred). The
    // parser reads ONLY the harness-indexed names, so each step still maps to
    // exactly its own screenshot and none are dropped.
    const script = `
import { test } from '@playwright/test'

test('self-attaching multi-step', async ({ page }, testInfo) => {
  await test.step('render one', async () => {
    await page.setContent('<html><body style="background:#ffffff"><h1>One</h1></body></html>')
    await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' })
  })
  await test.step('render two', async () => {
    await page.setContent('<html><body style="background:#000000"><h1 style="color:white">Two</h1></body></html>')
    await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' })
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-self-attach'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)

    // One screenshot per step, correctly associated (distinct pages).
    const [one, two] = result.steps
    expect(one.screenshotBase64).toBeDefined()
    expect(two.screenshotBase64).toBeDefined()
    expect(one.screenshotBase64).not.toBe(two.screenshotBase64)
    expect(
      Buffer.from(one.screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
    ).toBe('89504e470d0a1a0a')
  }, 60_000)

  it('captures no step screenshots when captureStepScreenshots is false', async () => {
    // With the harness preload disabled and a git-synced style spec that never
    // attaches its own screenshot, there must be zero screenshots — proving the
    // opt-out path does not inject the preload.
    const script = `
import { test } from '@playwright/test'

test('no-capture spec', async ({ page }) => {
  await test.step('render only', async () => {
    await page.setContent('<div>no screenshot</div>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-disabled'),
      captureStepScreenshots: false,
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].screenshotBase64).toBeUndefined()
  }, 60_000)

  it('captures a screenshot for the FAILED step (and the whole test is not dropped by count-mismatch)', async () => {
    // Airliza style (no testInfo, aliased `step`, page.setContent). Step 2
    // fails an assertion. Capture-on-failure must attach a screenshot for the
    // failed step, and because step 1 + the failed step 2 are the only steps
    // Playwright reports, the image-attachment count must equal the step count
    // so NO screenshots are dropped by the parser's count-mismatch guard.
    const script = `
import { test, expect } from '@playwright/test'

test('fails on step two', async ({ page }) => {
  const step = test.step
  await step('render before', async () => {
    await page.setContent('<html><body><h1>Before</h1></body></html>')
  })
  await step('assert missing element (fails)', async () => {
    await page.setContent('<html><body><h1>During</h1></body></html>')
    await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 500 })
  })
  await step('never runs', async () => {
    await page.setContent('<html><body><h1>After</h1></body></html>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-failed-step'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(false)
    // Only the two attempted steps are reported ("never runs" never appears).
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].title).toBe('render before')
    expect(result.steps[0].status).toBe('passed')
    expect(result.steps[1].title).toBe('assert missing element (fails)')
    expect(result.steps[1].status).toBe('failed')

    // Both the passed step AND the failed step must carry a screenshot — the
    // count matches (2 steps / 2 image attachments) so none are dropped.
    expect(result.steps[0].screenshotBase64).toBeDefined()
    expect(result.steps[1].screenshotBase64).toBeDefined()
    expect(
      Buffer.from(result.steps[1].screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
    ).toBe('89504e470d0a1a0a')
  }, 60_000)

  it('does not crash on test.step.skip; the executed step keeps its screenshot while the skipped one has none', async () => {
    // Two wins over the previous round:
    //  1. No crash — the preload copies the original step's own properties
    //     (Object.assign), so test.step.skip survives (a bare replacement would
    //     drop it and throw a TypeError at spec load).
    //  2. Index-based mapping — a skipped top-level step still occupies a slot
    //     in Playwright's steps[] array, so the preload makes it CONSUME an
    //     index (without screenshotting). The executed step therefore lands on
    //     its own index and keeps its screenshot, instead of the whole test's
    //     screenshots being dropped by a count mismatch (the old behavior).
    // Skip is intentionally FIRST — the hardest ordering, since it would offset
    // every later step's index if skips did not consume one.
    const script = `
import { test } from '@playwright/test'

test('mixes step and step.skip', async ({ page }) => {
  test.step.skip('skipped step', async () => {
    await page.setContent('<div>should not run</div>')
  })
  await test.step('real step', async () => {
    await page.setContent('<html><body><h1>Real</h1></body></html>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-step-skip'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)

    const skippedStep = result.steps.find((s) => s.title === 'skipped step')
    const realStep = result.steps.find((s) => s.title === 'real step')
    expect(skippedStep).toBeDefined()
    expect(realStep).toBeDefined()
    expect(realStep!.status).toBe('passed')

    // The skipped step has no screenshot; the executed step keeps its own.
    expect(skippedStep!.screenshotBase64).toBeUndefined()
    expect(realStep!.screenshotBase64).toBeDefined()
    expect(
      Buffer.from(realStep!.screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
    ).toBe('89504e470d0a1a0a')
  }, 60_000)

  it('captures screenshots for TOP-LEVEL steps run in parallel via Promise.all, correctly per step', async () => {
    // Parallel top-level steps would clobber a shared nesting counter; with ALS
    // + a synchronous per-call index, each step gets a stable index in call
    // order (a=0, b=1). Step a sets red and ends immediately (captured ~t0);
    // step b waits 200ms before setting green (captured ~t200), so a's capture
    // is deterministically taken while the page is still red — proving each
    // step maps to ITS OWN screenshot and neither is dropped.
    const script = `
import { test } from '@playwright/test'

test('parallel steps', async ({ page }) => {
  await Promise.all([
    test.step('step a', async () => {
      await page.setContent('<body style="margin:0;background:#ff0000;height:100vh"></body>')
    }),
    test.step('step b', async () => {
      await page.waitForTimeout(200)
      await page.setContent('<body style="margin:0;background:#00ff00;height:100vh"></body>')
    }),
  ])
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-parallel'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)
    // steps[] order follows call order (a then b).
    expect(result.steps[0].title).toBe('step a')
    expect(result.steps[1].title).toBe('step b')

    // Both captured (not dropped) and distinct (a=red, b=green).
    expect(result.steps[0].screenshotBase64).toBeDefined()
    expect(result.steps[1].screenshotBase64).toBeDefined()
    expect(result.steps[0].screenshotBase64).not.toBe(result.steps[1].screenshotBase64)
    for (const step of result.steps) {
      expect(
        Buffer.from(step.screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
      ).toBe('89504e470d0a1a0a')
    }
  }, 60_000)

  it('captures the newest page when a step opens a second page (multi-page heuristic)', async () => {
    // Step 1 paints the initial page RED. Step 2 opens a second page and paints
    // it GREEN, leaving the initial page red. If the "newest page" heuristic
    // works, step 2's screenshot is of the green page and DIFFERS from step 1's
    // red one; if it wrongly captured the (still red) initial page, the two
    // screenshots would be byte-identical — so the inequality is the proof.
    const script = `
import { test } from '@playwright/test'

test('multi page', async ({ page, context }) => {
  await test.step('paint initial red', async () => {
    await page.setContent('<body style="margin:0;background:#ff0000;height:100vh"></body>')
  })
  await test.step('open second page green', async () => {
    const p2 = await context.newPage()
    await p2.setContent('<body style="margin:0;background:#00ff00;height:100vh"></body>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-multipage'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].screenshotBase64).toBeDefined()
    expect(result.steps[1].screenshotBase64).toBeDefined()
    // The second step captured a DIFFERENT page (green p2), not the red initial.
    expect(result.steps[1].screenshotBase64).not.toBe(result.steps[0].screenshotBase64)
  }, 60_000)

  it('drops screenshots (does not misattribute) when test.step() runs inside a beforeEach hook', async () => {
    // A test.step() inside beforeEach consumes a harness index but does NOT
    // appear in the test body's steps[], inflating the index space. The parser's
    // hooks-inflation guard must detect this and drop the body steps'
    // screenshots rather than map a body step to the HOOK's screenshot.
    const script = `
import { test } from '@playwright/test'

test.beforeEach(async () => {
  await test.step('hook setup', async () => {})
})

test('body after hook step', async ({ page }) => {
  await test.step('body one', async () => {
    await page.setContent('<body style="margin:0;background:#ff0000;height:100vh"></body>')
  })
  await test.step('body two', async () => {
    await page.setContent('<body style="margin:0;background:#00ff00;height:100vh"></body>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-hook-inflation'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    // Only the two BODY steps are reported (the hook step is not in steps[]).
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].title).toBe('body one')
    expect(result.steps[1].title).toBe('body two')
    // Both body steps have NO screenshot — the guard dropped them instead of
    // attributing the hook's screenshot to a body step.
    expect(result.steps[0].screenshotBase64).toBeUndefined()
    expect(result.steps[1].screenshotBase64).toBeUndefined()
  }, 60_000)

  it('falls back to the initial page for a later step after a popup opened then closed', async () => {
    // Step 1 opens a popup (so the tracker points at it) then CLOSES it. Without
    // the closed-page fallback, the tracker would still point at the closed
    // popup and step 2 would get no screenshot. With the fallback, step 2 is
    // captured from the still-open initial page.
    const script = `
import { test } from '@playwright/test'

test('popup then main', async ({ page, context }) => {
  await test.step('open and close popup', async () => {
    const popup = await context.newPage()
    await popup.setContent('<body style="margin:0;background:#0000ff;height:100vh"></body>')
    await popup.close()
  })
  await test.step('back on main', async () => {
    await page.setContent('<body style="margin:0;background:#00ff00;height:100vh"></body>')
  })
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-popup-close'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(2)
    // The step after the popup closed must still be captured (from the main
    // page), not silently blank.
    const backStep = result.steps.find((s) => s.title === 'back on main')
    expect(backStep).toBeDefined()
    expect(backStep!.screenshotBase64).toBeDefined()
    expect(
      Buffer.from(backStep!.screenshotBase64!, 'base64').subarray(0, 8).toString('hex'),
    ).toBe('89504e470d0a1a0a')
  }, 60_000)

  it('keeps indices aligned when a test.step.skip is mixed with a Promise.all of top-level steps', async () => {
    // Insurance for the ordering concern: a leading skip consumes index 0, then
    // the two parallel steps take indices 1 and 2 in call order. Each executed
    // step must receive its OWN screenshot; the skipped step has none.
    const script = `
import { test } from '@playwright/test'

test('skip then parallel', async ({ page }) => {
  test.step.skip('skipped first', async () => {})
  await Promise.all([
    test.step('par a', async () => {
      await page.setContent('<body style="margin:0;background:#ff0000;height:100vh"></body>')
    }),
    test.step('par b', async () => {
      await page.waitForTimeout(200)
      await page.setContent('<body style="margin:0;background:#0000ff;height:100vh"></body>')
    }),
  ])
})
`
    const result = await runPlaywrightSubprocess({
      script,
      executionId: uniqueExecutionId('harness-parallel-skip'),
      timeoutMs: 60_000,
    })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(3)

    const skipped = result.steps.find((s) => s.title === 'skipped first')
    const parA = result.steps.find((s) => s.title === 'par a')
    const parB = result.steps.find((s) => s.title === 'par b')
    expect(skipped!.screenshotBase64).toBeUndefined()
    expect(parA!.screenshotBase64).toBeDefined()
    expect(parB!.screenshotBase64).toBeDefined()
    // Distinct per-step images (a=red captured ~t0, b=blue captured ~t200).
    expect(parA!.screenshotBase64).not.toBe(parB!.screenshotBase64)
  }, 60_000)
})
