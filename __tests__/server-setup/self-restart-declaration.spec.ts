/**
 * Tests for src/server-setup/self-restart-declaration.ts.
 *
 * The `ai_support_agent_k8s` role defers every spec-changing kubectl call that
 * targets the agent executing the play, and runs them last (tasks/self.yml).
 * That still ends the run without a result: Kubernetes replaces the Pod, so the
 * process that would report the outcome is gone. Before it gets there the role
 * drops a marker file on the controller and waits for this module to answer
 * with an ack file; the wait is what makes "reported before restarted" an
 * ordering guarantee rather than a race.
 *
 * Real files in a real temp dir, like progress-tailer.spec.ts: the whole point
 * of the module is deciding on file *existence* rather than on Ansible's
 * wording, and a mocked `fs` would only assert our own assumptions.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

import {
  createSelfRestartDeclarer,
  SELF_RESTART_NOTICE_TASK_NAME,
} from '../../src/server-setup/self-restart-declaration'
import type { SelfRestartDeclarationAck } from '../../src/types/server-setup'
import { SERVER_SETUP_SELF_RESTART_NOTICE_SEQ } from '../../src/constants'
import { logger } from '../../src/logger'

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
let markerPath: string
let ackPath: string

beforeEach(() => {
  jest.clearAllMocks()
  workDir = mkdtempSync(path.join(tmpdir(), 'self-restart-'))
  markerPath = path.join(workDir, 'self-restart.marker.json')
  ackPath = path.join(workDir, 'self-restart.ack')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeMarker(content = JSON.stringify({ targets: ['ai-support-agent'] })): void {
  writeFileSync(markerPath, content)
}

function allLoggedText(): string {
  const mocked = logger as unknown as Record<string, jest.Mock>
  return ['info', 'success', 'error', 'warn', 'debug']
    .flatMap((method) => mocked[method].mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n')
}

describe('createSelfRestartDeclarer', () => {
  it('does nothing while the marker is absent', async () => {
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })

    await declarer.check()
    await declarer.check()

    expect(declare).not.toHaveBeenCalled()
    expect(existsSync(ackPath)).toBe(false)
  })

  it('acknowledges only after the declaration has been delivered', async () => {
    // The ordering this module exists for: the role waits on the ack, so
    // writing it before the API call completed would let the Pod be replaced
    // with the declaration still in flight — exactly the race being closed.
    let release: (() => void) | undefined
    const declare = jest.fn(
      () =>
        new Promise<SelfRestartDeclarationAck>((resolve) => {
          release = () => resolve({ acknowledged: true })
        }),
    )
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker()

    const pending = declarer.check()
    await Promise.resolve()
    expect(declare).toHaveBeenCalledTimes(1)
    expect(existsSync(ackPath)).toBe(false)

    release!()
    await pending

    expect(existsSync(ackPath)).toBe(true)
  })

  it('declares at most once even while the marker stays on disk', async () => {
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker()

    await declarer.check()
    await declarer.check()
    await declarer.check()

    expect(declare).toHaveBeenCalledTimes(1)
  })

  it('does not start a second declaration while the first is still in flight', async () => {
    let release: (() => void) | undefined
    const declare = jest.fn(
      () =>
        new Promise<SelfRestartDeclarationAck>((resolve) => {
          release = () => resolve({ acknowledged: true })
        }),
    )
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker()

    const first = declarer.check()
    await declarer.check()

    expect(declare).toHaveBeenCalledTimes(1)

    release!()
    await first
  })


  /**
   * 申告が失敗したときの**痕跡**。
   *
   * この直後に Pod は置き換えられ、このプロセスの標準出力は消える。ログ行だけでは
   * 運用者は何も見られない（実行詳細にも ansible の出力にも残らない）。そこで:
   *  1. 実行ログ（進捗イベント経路）に1件残す — 運用者が実際に見る場所
   *  2. ack ファイルに成否を書く — ロールがそれを読んで ansible 出力に出す
   * ack を**書くこと自体はやめない**（60秒の待ちを無駄に消費させないため）。
   * 変えるのは「失敗が見えないこと」だけである。
   */
  describe('申告が失敗したときに、それが見える場所へ残る', () => {
    function ackJson(): Record<string, unknown> {
      return JSON.parse(readFileSync(ackPath, 'utf8')) as Record<string, unknown>
    }

    it('declare() が失敗したら実行ログへ1件記録する', async () => {
      const reportProgress = jest.fn().mockResolvedValue(undefined)
      const declare = jest.fn().mockRejectedValue(new Error('api unreachable'))
      const declarer = createSelfRestartDeclarer({
        markerPath,
        ackPath,
        declare,
        reportProgress,
      })
      writeMarker()

      await declarer.check()

      expect(reportProgress).toHaveBeenCalledTimes(1)
      const [events] = reportProgress.mock.calls[0]
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual(
        expect.objectContaining({
          seq: SERVER_SETUP_SELF_RESTART_NOTICE_SEQ,
          phase: 'end',
          name: SELF_RESTART_NOTICE_TASK_NAME,
          status: 'failed',
        }),
      )
      expect(String(events[0].message)).toContain('api unreachable')
    })

    it('API が 200 でも「反映できなかった」と答えたら失敗として扱う', async () => {
      // 最も起きやすい経路: HTTP は成功しているので、戻り値を見ない限り
      // 「申告できた」と誤解したまま自分自身を再起動してしまう。
      const reportProgress = jest.fn().mockResolvedValue(undefined)
      const declare = jest
        .fn()
        .mockResolvedValue({ acknowledged: false, outcome: 'already_terminal' })
      const declarer = createSelfRestartDeclarer({
        markerPath,
        ackPath,
        declare,
        reportProgress,
      })
      writeMarker()

      await declarer.check()

      expect(reportProgress).toHaveBeenCalledTimes(1)
      expect(String(reportProgress.mock.calls[0][0][0].message)).toContain(
        'already_terminal',
      )
      expect(ackJson().declared).toBe(false)
    })

    it('理由が返らない未反映でも、未反映であること自体は記録する', async () => {
      const reportProgress = jest.fn().mockResolvedValue(undefined)
      const declare = jest.fn().mockResolvedValue({ acknowledged: false })
      const declarer = createSelfRestartDeclarer({
        markerPath,
        ackPath,
        declare,
        reportProgress,
      })
      writeMarker()

      await declarer.check()

      expect(reportProgress).toHaveBeenCalledTimes(1)
      expect(String(reportProgress.mock.calls[0][0][0].message)).toContain('unknown')
      expect(ackJson().declared).toBe(false)
    })

    it('成功したときは実行ログに何も足さない', async () => {
      const reportProgress = jest.fn().mockResolvedValue(undefined)
      const declare = jest.fn().mockResolvedValue({ acknowledged: true, outcome: 'declared' })
      const declarer = createSelfRestartDeclarer({
        markerPath,
        ackPath,
        declare,
        reportProgress,
      })
      writeMarker()

      await declarer.check()

      expect(reportProgress).not.toHaveBeenCalled()
    })

    it('ack に成否を記録する（存在するだけでは「申告できた」の証拠にならない）', async () => {
      const declare = jest.fn().mockResolvedValue({ acknowledged: true, outcome: 'declared' })
      const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
      writeMarker()

      await declarer.check()

      expect(ackJson().declared).toBe(true)
    })

    it('失敗しても ack は書く（ロールの待ち時間を無駄に消費させない）が、失敗と記録する', async () => {
      const declare = jest.fn().mockRejectedValue(new Error('api unreachable'))
      const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
      writeMarker()

      await declarer.check()

      expect(existsSync(ackPath)).toBe(true)
      const ack = ackJson()
      expect(ack.declared).toBe(false)
      expect(String(ack.error)).toContain('api unreachable')
    })

    it('実行ログへの記録が失敗しても ack は書かれ、check() は throw しない', async () => {
      // 申告が届かない原因が API 断なら、この記録も同じ理由で失敗する。それでも
      // 配置は続ける（ack はロールのための信号であり、報告経路ではない）。
      const reportProgress = jest.fn().mockRejectedValue(new Error('api unreachable too'))
      const declare = jest.fn().mockRejectedValue(new Error('api unreachable'))
      const declarer = createSelfRestartDeclarer({
        markerPath,
        ackPath,
        declare,
        reportProgress,
      })
      writeMarker()

      await expect(declarer.check()).resolves.toBeUndefined()

      expect(existsSync(ackPath)).toBe(true)
      expect(ackJson().declared).toBe(false)
    })

    it('reportProgress が渡されていなくても失敗経路は成立する（ローカル実行など）', async () => {
      const declare = jest.fn().mockRejectedValue(new Error('api unreachable'))
      const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
      writeMarker()

      await expect(declarer.check()).resolves.toBeUndefined()
      expect(ackJson().declared).toBe(false)
    })
  })

  it('acknowledges anyway when the declaration fails, and says so in the log', async () => {
    // Best-effort by design (same contract as progress reporting): a reporting
    // failure must not hold the deployment hostage for the role's whole wait
    // window. It must never be silent either.
    const declare = jest.fn().mockRejectedValue(new Error('api unreachable'))
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker()

    await declarer.check()

    expect(existsSync(ackPath)).toBe(true)
    expect(allLoggedText()).toContain('api unreachable')
  })

  it('declares even when the marker content cannot be read', async () => {
    // Existence is the signal; the content is diagnostics only. Requiring the
    // content to parse would put the decision back on something the role could
    // get wrong halfway through writing it.
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    mkdirSync(markerPath)

    await declarer.check()

    expect(declare).toHaveBeenCalledTimes(1)
    expect(existsSync(ackPath)).toBe(true)
  })

  it('reports the marker content in the log so the run explains itself', async () => {
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker(JSON.stringify({ targets: ['ai-support-agent', 'agent-canary'] }))

    await declarer.check()

    expect(allLoggedText()).toContain('agent-canary')
  })

  it('logs and continues when the ack cannot be written', async () => {
    // The role's wait then times out and deploys anyway (its wait is
    // best-effort too), so this must not throw into the poll loop.
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({
      markerPath,
      ackPath: path.join(workDir, 'missing-dir', 'self-restart.ack'),
      declare,
    })
    writeMarker()

    await expect(declarer.check()).resolves.toBeUndefined()

    expect(declare).toHaveBeenCalledTimes(1)
    expect(allLoggedText()).toMatch(/acknowledge/i)
  })

  it('writes an ack file the role can only observe after it is complete', async () => {
    const declare = jest.fn().mockResolvedValue({ acknowledged: true })
    const declarer = createSelfRestartDeclarer({ markerPath, ackPath, declare })
    writeMarker()

    await declarer.check()

    // `wait_for` returns as soon as the path exists, so the content is
    // incidental — but an empty file makes a truncated write indistinguishable
    // from a complete one when someone inspects a stuck run by hand.
    expect(readFileSync(ackPath, 'utf8').length).toBeGreaterThan(0)
  })
})
