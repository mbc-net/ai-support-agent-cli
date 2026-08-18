/**
 * Tests for src/server-setup/progress-tailer.ts.
 *
 * The Ansible callback appends NDJSON progress events to a side file while the
 * playbook runs (see ansible/callback_plugins/json.py). This reader turns that
 * growing file into batches of events without re-reading what it already saw.
 *
 * Real files in a real temp dir are used rather than a mocked `fs`: the whole
 * point of this module is byte-offset bookkeeping against a file that is being
 * appended to concurrently, and a mock would only assert our own assumptions.
 * (`fs`'s sync methods are also non-configurable getters under Jest's Node
 * environment, so spying on them individually does not work here.)
 */

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import {
  ProgressFileReader,
  startProgressTailer,
} from '../../src/server-setup/progress-tailer'

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

let workDir: string
let progressFile: string

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'progress-tailer-'))
  progressFile = path.join(workDir, 'progress.ndjson')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const startEvent = (seq: number, name: string) =>
  JSON.stringify({ seq, phase: 'start', name }) + '\n'

const endEvent = (seq: number, name: string) =>
  JSON.stringify({
    seq,
    phase: 'end',
    name,
    host: 'target',
    result: { changed: true, failed: false, skipped: false },
  }) + '\n'

describe('ProgressFileReader', () => {
  it('returns no events when the file does not exist yet', () => {
    const reader = new ProgressFileReader(progressFile)

    expect(reader.read()).toEqual([])
  })

  it('reads complete events appended to the file', () => {
    writeFileSync(progressFile, startEvent(1, 'a : one') + endEvent(2, 'a : one'))
    const reader = new ProgressFileReader(progressFile)

    const events = reader.read()

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ seq: 1, phase: 'start', name: 'a : one' })
    expect(events[1].phase).toBe('end')
    expect(events[1].result).toEqual({
      changed: true,
      failed: false,
      skipped: false,
    })
  })

  it('returns only events appended since the previous read', () => {
    writeFileSync(progressFile, startEvent(1, 'a : one'))
    const reader = new ProgressFileReader(progressFile)
    expect(reader.read().map((event) => event.seq)).toEqual([1])

    appendFileSync(progressFile, endEvent(2, 'a : one') + startEvent(3, 'a : two'))

    expect(reader.read().map((event) => event.seq)).toEqual([2, 3])
  })

  it('returns nothing when the file has not grown', () => {
    writeFileSync(progressFile, startEvent(1, 'a : one'))
    const reader = new ProgressFileReader(progressFile)
    reader.read()

    expect(reader.read()).toEqual([])
  })

  it('holds back a partially written line until its newline arrives', () => {
    const full = endEvent(1, 'a : one')
    const splitAt = Math.floor(full.length / 2)
    writeFileSync(progressFile, full.slice(0, splitAt))
    const reader = new ProgressFileReader(progressFile)

    // The callback flushes per line, but a reader can still observe a
    // half-written line; emitting it would produce a JSON parse error.
    expect(reader.read()).toEqual([])

    appendFileSync(progressFile, full.slice(splitAt))

    expect(reader.read().map((event) => event.seq)).toEqual([1])
  })

  it('does not corrupt multi-byte task names split across reads', () => {
    // Task names are operator-authored and routinely Japanese, so the leftover
    // buffer must be kept as bytes: slicing a UTF-8 sequence in the middle and
    // decoding each half separately yields replacement characters.
    const line = startEvent(1, 'os_init : パッケージを導入する')
    const bytes = Buffer.from(line, 'utf-8')
    const splitAt = bytes.indexOf(Buffer.from('パ', 'utf-8')) + 1

    writeFileSync(progressFile, bytes.subarray(0, splitAt))
    const reader = new ProgressFileReader(progressFile)
    reader.read()

    appendFileSync(progressFile, bytes.subarray(splitAt))

    const events = reader.read()
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('os_init : パッケージを導入する')
  })

  it('skips malformed lines instead of losing the whole batch', () => {
    writeFileSync(
      progressFile,
      startEvent(1, 'a : one') + 'not json\n' + endEvent(2, 'a : one'),
    )
    const reader = new ProgressFileReader(progressFile)

    expect(reader.read().map((event) => event.seq)).toEqual([1, 2])
  })

  it('skips lines that parse but are not progress events', () => {
    writeFileSync(
      progressFile,
      '"a string"\n' +
        '{"phase":"start","name":"no seq"}\n' +
        '{"seq":"2","phase":"start","name":"seq not a number"}\n' +
        '{"seq":3,"phase":"sideways","name":"bad phase"}\n' +
        startEvent(4, 'a : ok'),
    )
    const reader = new ProgressFileReader(progressFile)

    expect(reader.read().map((event) => event.seq)).toEqual([4])
  })

  it('ignores blank lines', () => {
    writeFileSync(progressFile, '\n' + startEvent(1, 'a : one') + '\n\n')
    const reader = new ProgressFileReader(progressFile)

    expect(reader.read().map((event) => event.seq)).toEqual([1])
  })

  it('survives the file disappearing mid-run', () => {
    writeFileSync(progressFile, startEvent(1, 'a : one'))
    const reader = new ProgressFileReader(progressFile)
    reader.read()

    rmSync(progressFile)

    expect(reader.read()).toEqual([])
  })
})

describe('startProgressTailer', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('delivers events in batches as they are appended', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one') + endEvent(2, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)

    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents.mock.calls[0][0].map((e: { seq: number }) => e.seq)).toEqual([
      1, 2,
    ])

    await tailer.stop()
  })

  it('does not call back when there is nothing new', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    await jest.advanceTimersByTimeAsync(3000)

    expect(onEvents).not.toHaveBeenCalled()

    await tailer.stop()
  })

  it('drains events written after the last tick when stopped', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    // Ansible can finish between two ticks; without a final drain the last
    // tasks would never be reported as progress.
    appendFileSync(progressFile, endEvent(9, 'a : last'))
    await tailer.stop()

    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents.mock.calls[0][0].map((e: { seq: number }) => e.seq)).toEqual([
      9,
    ])
  })

  it('stops polling after stop() is called', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })
    await tailer.stop()
    onEvents.mockClear()

    appendFileSync(progressFile, startEvent(1, 'a : after stop'))
    await jest.advanceTimersByTimeAsync(5000)

    expect(onEvents).not.toHaveBeenCalled()
  })

  it('does not overlap callbacks when one is still in flight', async () => {
    let release: (() => void) | undefined
    const onEvents = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)
    appendFileSync(progressFile, startEvent(2, 'a : two'))
    await jest.advanceTimersByTimeAsync(1000)

    // A slow API call must not let a second batch be sent concurrently, which
    // would let events arrive out of order.
    expect(onEvents).toHaveBeenCalledTimes(1)

    release?.()
    await jest.advanceTimersByTimeAsync(1000)
    expect(onEvents).toHaveBeenCalledTimes(2)

    await tailer.stop()
  })

  it('keeps tailing after a callback rejects', async () => {
    const onEvents = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)
    appendFileSync(progressFile, startEvent(2, 'a : two'))
    await jest.advanceTimersByTimeAsync(1000)

    // Progress delivery is best-effort: a failed send must not stop the run
    // from reporting later tasks.
    expect(onEvents).toHaveBeenCalledTimes(2)

    await tailer.stop()
  })

  it('waits for an in-flight delivery before the final drain', async () => {
    // stop() が in-flight の送信を待たずに deliver() を始めると、2つの
    // onEvents が同時に走り、順序が入れ替わったまま API へ届く（実行終了時は
    // まさに送信が飛んでいる最中になりやすい）。単一フライトの契約は
    // インターバル経路だけでなく stop() 経路でも守る必要がある。
    const order: string[] = []
    let release: (() => void) | undefined
    const onEvents = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            order.push('first:start')
            release = () => {
              order.push('first:end')
              resolve()
            }
          }),
      )
      .mockImplementation(async () => {
        order.push('second')
      })
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)
    expect(order).toEqual(['first:start'])

    appendFileSync(progressFile, endEvent(2, 'a : one'))
    const stopping = tailer.stop()
    await jest.advanceTimersByTimeAsync(0)

    // 送信中に stop() が来ても、2件目は1件目の完了後にだけ走る。
    expect(order).toEqual(['first:start'])

    release?.()
    await stopping

    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('still drains after an in-flight delivery that rejects', async () => {
    let reject: ((error: Error) => void) | undefined
    const onEvents = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, rej) => {
            reject = rej
          }),
      )
      .mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)

    appendFileSync(progressFile, endEvent(2, 'a : one'))
    const stopping = tailer.stop()
    reject?.(new Error('network down'))

    await expect(stopping).resolves.toBeUndefined()
    expect(onEvents).toHaveBeenCalledTimes(2)
  })

  it('is safe to stop twice', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
    })

    await tailer.stop()
    await expect(tailer.stop()).resolves.toBeUndefined()
  })
})

/**
 * `onPoll` piggybacks on the same loop rather than adding a second timer.
 *
 * The one other thing that has to be watched while ansible runs — the
 * self-restart marker the `ai_support_agent_k8s` role drops before replacing
 * this Pod (see self-restart-declaration.ts) — is checked on this tick so it
 * inherits the single-flight ordering instead of racing event delivery.
 */
describe('startProgressTailer - onPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('runs on every tick, including ticks with no new events', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    const onPoll = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
      onPoll,
    })

    await jest.advanceTimersByTimeAsync(3000)

    expect(onEvents).not.toHaveBeenCalled()
    expect(onPoll).toHaveBeenCalledTimes(3)

    await tailer.stop()
  })

  it('does not run concurrently with an in-flight event delivery', async () => {
    let release: (() => void) | undefined
    const onEvents = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const onPoll = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
      onPoll,
    })

    appendFileSync(progressFile, startEvent(1, 'a : one'))
    await jest.advanceTimersByTimeAsync(1000)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onPoll).not.toHaveBeenCalled()

    release!()
    await jest.advanceTimersByTimeAsync(0)
    expect(onPoll).toHaveBeenCalledTimes(1)

    await tailer.stop()
  })

  it('runs once more during the final drain', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    const onPoll = jest.fn().mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
      onPoll,
    })

    await tailer.stop()

    expect(onPoll).toHaveBeenCalledTimes(1)
  })

  it('keeps polling after onPoll rejects', async () => {
    const onEvents = jest.fn().mockResolvedValue(undefined)
    const onPoll = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined)
    writeFileSync(progressFile, '')
    const tailer = startProgressTailer({
      filePath: progressFile,
      intervalMs: 1000,
      onEvents,
      onPoll,
    })

    await jest.advanceTimersByTimeAsync(2000)

    expect(onPoll).toHaveBeenCalledTimes(2)

    await tailer.stop()
  })
})
