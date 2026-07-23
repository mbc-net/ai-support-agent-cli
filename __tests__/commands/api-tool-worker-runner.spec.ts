import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { _terminateSharedWorker, runToolInWorker } from '../../src/commands/api-tool-worker-runner'
import { API_TOOL_WORKER_TIMEOUT_MS } from '../../src/constants'

jest.mock('../../src/logger')

// A pattern the static isDangerousRegexPattern() heuristic (paren-nesting-only) is
// known NOT to catch: consecutive bracket-less quantifiers. Against a run of 'a's
// followed by a non-matching character, this triggers genuine catastrophic
// backtracking in V8's regex engine (confirmed manually: hangs for minutes+ without
// the worker-timeout backstop).
const REDOS_BYPASS_PATTERN = 'a*'.repeat(20) + '!'
// Critically, this must NOT contain '!' (and hence NOT match): if it matched, the
// regex engine would find a successful split on its very first (greedy) attempt and
// return immediately without any backtracking at all. Omitting the terminator forces
// the engine to exhaustively search every combinatorial split among the 20 `a*`
// groups before concluding "no match" — that exhaustive search is what's exponential
// (independently confirmed via a subprocess with a 3s OS-level timeout: this pattern
// genuinely hangs well past 3 seconds without a guard).
const PATHOLOGICAL_LINE = 'a'.repeat(35)

describe('api-tool-worker-runner', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-tool-worker-runner-')))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(async () => {
    await _terminateSharedWorker()
  })

  it('runs Grep in a worker thread and returns a real match', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'hello NEEDLE world')

    const result = await runToolInWorker('Grep', { pattern: 'NEEDLE' }, [tmpRoot])

    expect(result.isError).toBe(false)
    expect(result.output).toContain('NEEDLE')
  }, 10_000)

  it('runs Glob in a worker thread and returns real results', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.ts'), 'x')

    const result = await runToolInWorker('Glob', { pattern: '*.ts' }, [tmpRoot])

    expect(result.isError).toBe(false)
    expect(result.output).toContain('a.ts')
  }, 10_000)

  it(
    'terminates a worker that hangs on a static-heuristic-bypassing ReDoS pattern within the timeout window',
    async () => {
      fs.writeFileSync(path.join(tmpRoot, 'evil.txt'), PATHOLOGICAL_LINE)

      const start = Date.now()
      const result = await runToolInWorker('Grep', { pattern: REDOS_BYPASS_PATTERN }, [tmpRoot])
      const elapsedMs = Date.now() - start

      expect(result.isError).toBe(true)
      expect(result.output.toLowerCase()).toContain('timed out')
      // Proves this actually went through the timeout path (not an instant
      // rejection): it took roughly the configured timeout window, not ~0ms.
      expect(elapsedMs).toBeGreaterThanOrEqual(API_TOOL_WORKER_TIMEOUT_MS - 200)
      // ...but still bounded — nowhere near what the pathological regex itself
      // would take if actually left to run to completion (minutes+).
      expect(elapsedMs).toBeLessThan(API_TOOL_WORKER_TIMEOUT_MS + 2000)
    },
    API_TOOL_WORKER_TIMEOUT_MS + 5000,
  )

  it(
    'recovers after a timeout: the next call gets a fresh worker and succeeds normally',
    async () => {
      fs.writeFileSync(path.join(tmpRoot, 'evil.txt'), PATHOLOGICAL_LINE)
      const timedOut = await runToolInWorker('Grep', { pattern: REDOS_BYPASS_PATTERN }, [tmpRoot])
      expect(timedOut.isError).toBe(true)

      fs.writeFileSync(path.join(tmpRoot, 'ok.txt'), 'NEEDLE here')
      const start = Date.now()
      const recovered = await runToolInWorker('Grep', { pattern: 'NEEDLE' }, [tmpRoot])
      const elapsedMs = Date.now() - start

      expect(recovered.isError).toBe(false)
      expect(recovered.output).toContain('NEEDLE here')
      // A fresh worker still has to pay (small) startup cost, but should be
      // nowhere near the full timeout window — proves it didn't silently
      // piggyback on the dead/terminated worker.
      expect(elapsedMs).toBeLessThan(API_TOOL_WORKER_TIMEOUT_MS)
    },
    API_TOOL_WORKER_TIMEOUT_MS + 8000,
  )

  it(
    'aborts a hanging tool call quickly when the AbortSignal fires, well before the timeout window',
    async () => {
      fs.writeFileSync(path.join(tmpRoot, 'evil.txt'), PATHOLOGICAL_LINE)
      const controller = new AbortController()

      const start = Date.now()
      const promise = runToolInWorker('Grep', { pattern: REDOS_BYPASS_PATTERN }, [tmpRoot], controller.signal)
      setTimeout(() => controller.abort(), 200)
      const result = await promise
      const elapsedMs = Date.now() - start

      expect(result.isError).toBe(true)
      expect(result.output.toLowerCase()).toContain('cancel')
      // The whole point: abort must win the race against the (much longer)
      // worker timeout.
      expect(elapsedMs).toBeLessThan(API_TOOL_WORKER_TIMEOUT_MS)
    },
    API_TOOL_WORKER_TIMEOUT_MS + 5000,
  )

  it('does not fire an already-passed AbortSignal spuriously (normal completion still wins)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'NEEDLE')
    const controller = new AbortController()

    const result = await runToolInWorker('Grep', { pattern: 'NEEDLE' }, [tmpRoot], controller.signal)

    expect(result.isError).toBe(false)
    expect(result.output).toContain('NEEDLE')
  }, 10_000)

  describe('_terminateSharedWorker', () => {
    it('is a no-op when no worker has been created yet', async () => {
      await _terminateSharedWorker()
      await _terminateSharedWorker()
    })

    it('allows a fresh worker to be created again after termination', async () => {
      fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'NEEDLE')
      await runToolInWorker('Grep', { pattern: 'NEEDLE' }, [tmpRoot])
      await _terminateSharedWorker()

      const result = await runToolInWorker('Grep', { pattern: 'NEEDLE' }, [tmpRoot])
      expect(result.isError).toBe(false)
    }, 15_000)
  })
})
