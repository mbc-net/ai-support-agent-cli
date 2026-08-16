/**
 * Tests for the incremental progress output of the bundled Ansible stdout
 * callback (`ansible/callback_plugins/json.py`).
 *
 * WHY THESE EXIST: the callback used to accumulate every task result in memory
 * and print one JSON blob at `v2_playbook_on_stats`, so a 30-minute playbook
 * produced zero observable progress until it finished. The plugin now *also*
 * appends one NDJSON event per task start and per task result to a side file
 * (`AI_SUPPORT_AGENT_PROGRESS_FILE`), which the agent tails and forwards to the
 * API while the run is still going.
 *
 * The side file is deliberately a *separate* channel: the end-of-run JSON on
 * stdout is the authoritative result and its contract must not change, so these
 * tests assert both — progress events appear, and stdout still emits exactly one
 * JSON document of the original shape.
 *
 * The plugin is Python, so it is exercised through `fixtures/run-json-callback.py`,
 * which stubs the one Ansible symbol the plugin imports. That keeps the test
 * runnable without installing ansible-core.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import { ProgressFileReader } from '../../src/server-setup/progress-tailer'
import { toProgressPayload } from '../../src/server-setup/server-setup-runner'

interface ScenarioEvent {
  type: string
  name?: string
  host?: string
  result?: Record<string, unknown>
  no_log?: boolean
}

interface ProgressEvent {
  seq: number
  phase: 'start' | 'end'
  name: string
  host?: string
  result?: {
    changed?: boolean
    failed?: boolean
    skipped?: boolean
    unreachable?: boolean
    msg?: string
  }
}

const HARNESS = path.join(__dirname, 'fixtures', 'run-json-callback.py')

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'progress-callback-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Run the callback plugin against a scripted sequence of hooks.
 *
 * Returns the raw stdout (the end-of-run JSON contract) and the parsed NDJSON
 * progress events, so a single run can assert both channels.
 */
function runCallback(
  events: ScenarioEvent[],
  options: { withProgressFile?: boolean } = {},
): { stdout: string; progress: ProgressEvent[]; progressRaw: string } {
  const withProgressFile = options.withProgressFile ?? true
  const progressFile = path.join(workDir, 'progress.ndjson')
  const scenarioFile = path.join(workDir, 'scenario.json')
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      progressFile: withProgressFile ? progressFile : null,
      events,
    }),
  )

  const stdout = execFileSync('python3', [HARNESS, scenarioFile], {
    encoding: 'utf-8',
  })

  const progressRaw =
    withProgressFile && existsSync(progressFile)
      ? readFileSync(progressFile, 'utf-8')
      : ''
  const progress = progressRaw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ProgressEvent)

  return { stdout, progress, progressRaw }
}

const OK_RUN: ScenarioEvent[] = [
  { type: 'play_start', name: 'server setup' },
  { type: 'task_start', name: 'os_init : Install packages' },
  { type: 'ok', host: 'target', result: { changed: true } },
  { type: 'stats' },
]

describe('bundled json callback — incremental progress', () => {
  it('emits a start event when a task begins, before any result arrives', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'os_init : Install packages' },
    ])

    expect(progress).toEqual([
      { seq: 1, phase: 'start', name: 'os_init : Install packages' },
    ])
  })

  it('emits an end event carrying the fields the agent maps to a task result', () => {
    const { progress } = runCallback(OK_RUN)

    expect(progress).toHaveLength(2)
    expect(progress[1]).toEqual({
      seq: 2,
      phase: 'end',
      name: 'os_init : Install packages',
      host: 'target',
      result: { changed: true, failed: false, skipped: false },
    })
  })

  it('numbers events monotonically across the whole run', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : one' },
      { type: 'ok', host: 'target', result: {} },
      { type: 'task_start', name: 'a : two' },
      { type: 'skipped', host: 'target', result: { skipped: true } },
      { type: 'stats' },
    ])

    expect(progress.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(progress.map((event) => event.phase)).toEqual([
      'start',
      'end',
      'start',
      'end',
    ])
  })

  it('marks skipped tasks so the UI does not show them as succeeded', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : conditional' },
      { type: 'skipped', host: 'target', result: { skipped: true } },
      { type: 'stats' },
    ])

    expect(progress[1].result).toEqual({
      changed: false,
      failed: false,
      skipped: true,
    })
  })

  it('includes the failure message on failed tasks so the reason is visible live', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : risky' },
      { type: 'failed', host: 'target', result: { msg: 'permission denied' } },
      { type: 'stats' },
    ])

    expect(progress[1].result).toEqual({
      changed: false,
      failed: true,
      skipped: false,
      msg: 'permission denied',
    })
  })

  it('flags unreachable hosts so they are not reported as a plain failure', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : connect' },
      {
        type: 'unreachable',
        host: 'target',
        result: { msg: 'ssh timed out' },
      },
      { type: 'stats' },
    ])

    expect(progress[1].result).toEqual({
      changed: false,
      failed: true,
      skipped: false,
      unreachable: true,
      msg: 'ssh timed out',
    })
  })

  it('omits the message on successful tasks, keeping module output off this channel', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : reads a file' },
      {
        type: 'ok',
        host: 'target',
        result: { changed: false, msg: 'secret-bearing module output' },
      },
      { type: 'stats' },
    ])

    expect(progress[1].result).not.toHaveProperty('msg')
    expect(progress[1].result).toEqual({
      changed: false,
      failed: false,
      skipped: false,
    })
  })

  it('never emits the message of a no_log task, even when it fails', () => {
    const { progress, progressRaw } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'database : set password', no_log: true },
      {
        type: 'failed',
        host: 'target',
        no_log: true,
        result: { msg: 'hunter2 was rejected' },
      },
      { type: 'stats' },
    ])

    expect(progressRaw).not.toContain('hunter2')
    expect(progress[1].result).not.toHaveProperty('msg')
    expect(progress[1].result).toEqual({
      changed: false,
      failed: true,
      skipped: false,
    })
  })

  it('honours a module-set _ansible_no_log flag as well as the task flag', () => {
    const { progressRaw } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'task_start', name: 'a : module censors itself' },
      {
        type: 'failed',
        host: 'target',
        result: { msg: 'hunter2 leaked', _ansible_no_log: true },
      },
      { type: 'stats' },
    ])

    expect(progressRaw).not.toContain('hunter2')
  })

  it('records handler tasks too', () => {
    const { progress } = runCallback([
      { type: 'play_start', name: 'server setup' },
      { type: 'handler_task_start', name: 'a : restart service' },
      { type: 'ok', host: 'target', result: { changed: true } },
      { type: 'stats' },
    ])

    expect(progress[0]).toEqual({
      seq: 1,
      phase: 'start',
      name: 'a : restart service',
    })
    expect(progress[1].phase).toBe('end')
  })

  it('writes nothing when no progress file is configured', () => {
    const { progress } = runCallback(OK_RUN, { withProgressFile: false })

    expect(progress).toEqual([])
  })

  it('leaves the end-of-run stdout JSON contract unchanged', () => {
    const { stdout } = runCallback(OK_RUN)

    expect(JSON.parse(stdout)).toEqual({
      plays: [
        {
          play: { name: 'server setup' },
          tasks: [
            {
              task: { name: 'os_init : Install packages' },
              hosts: {
                target: { changed: true, failed: false, skipped: false },
              },
            },
          ],
        },
      ],
    })
  })

  it('still produces the authoritative stdout JSON when no progress file is set', () => {
    const { stdout } = runCallback(OK_RUN, { withProgressFile: false })

    const parsed = JSON.parse(stdout)
    expect(parsed.plays[0].tasks[0].hosts.target.changed).toBe(true)
  })
})

/**
 * Contract test across the Python/TypeScript seam.
 *
 * The callback (Python) and the reader (TypeScript) are each tested above
 * against a hand-written NDJSON shape, so a drift on one side alone would keep
 * both green. This drives the real plugin, reads its real output file with the
 * real reader, and maps it with the real `toProgressPayload` — the exact chain
 * a live run uses — and asserts what the API would receive.
 */
describe('callback → reader → wire payload', () => {
  it('turns a real run into the events the API stores', () => {
    const progressFile = path.join(workDir, 'seam.ndjson')
    const scenarioFile = path.join(workDir, 'seam-scenario.json')
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        progressFile,
        events: [
          { type: 'play_start', name: 'server setup' },
          { type: 'task_start', name: 'os_init : Update apt cache' },
          { type: 'ok', host: 'target', result: { changed: true } },
          { type: 'task_start', name: 'precheck : Verify supported OS' },
          { type: 'skipped', host: 'target', result: { skipped: true } },
          { type: 'task_start', name: 'db : configure' },
          { type: 'failed', host: 'target', result: { msg: 'permission denied' } },
          { type: 'stats' },
        ],
      }),
    )
    execFileSync('python3', [HARNESS, scenarioFile], { encoding: 'utf-8' })

    const events = new ProgressFileReader(progressFile).read()

    expect(toProgressPayload(events, [])).toEqual([
      { seq: 1, phase: 'start', name: 'os_init : Update apt cache' },
      {
        seq: 2,
        phase: 'end',
        name: 'os_init : Update apt cache',
        status: 'ok',
        changed: true,
        message: 'os_init : Update apt cache completed',
      },
      { seq: 3, phase: 'start', name: 'precheck : Verify supported OS' },
      {
        seq: 4,
        phase: 'end',
        name: 'precheck : Verify supported OS',
        status: 'skipped',
        changed: false,
        message: 'precheck : Verify supported OS skipped',
      },
      { seq: 5, phase: 'start', name: 'db : configure' },
      {
        seq: 6,
        phase: 'end',
        name: 'db : configure',
        status: 'failed',
        changed: false,
        message: 'permission denied',
      },
    ])
  })

  it('keeps a no_log task failure reason-free end to end', () => {
    const progressFile = path.join(workDir, 'seam-nolog.ndjson')
    const scenarioFile = path.join(workDir, 'seam-nolog-scenario.json')
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        progressFile,
        events: [
          { type: 'play_start', name: 'server setup' },
          { type: 'task_start', name: 'database : set password', no_log: true },
          {
            type: 'failed',
            host: 'target',
            no_log: true,
            result: { msg: 'hunter2 was rejected' },
          },
          { type: 'stats' },
        ],
      }),
    )
    execFileSync('python3', [HARNESS, scenarioFile], { encoding: 'utf-8' })

    const payload = toProgressPayload(
      new ProgressFileReader(progressFile).read(),
      [],
    )

    expect(JSON.stringify(payload)).not.toContain('hunter2')
    // 失敗は伝わるが、理由はタスク名にフォールバックする。
    expect(payload[1]).toMatchObject({
      status: 'failed',
      message: 'database : set password failed',
    })
  })
})
