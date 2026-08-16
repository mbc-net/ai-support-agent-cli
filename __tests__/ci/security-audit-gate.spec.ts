import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `npm audit` を CI の実ゲートとして固定する静的検証。
 *
 * ## 背景
 *
 * `continue-on-error: true` は 447f0d0「fix(ci): remove minimatch override breaking
 * jest coverage」の時点で意図的に付けられた。当時は minimatch の ReDoS 勧告に
 * CJS 互換の修正版が存在せず、ゲート化すると CI が恒久的に赤になったためである。
 *
 * その前提は解消した（現在 `npm audit` は全 severity で 0 件）。ゲートを外したままだと、
 * 開発依存経由で high が再混入しても CI は緑のまま通り、検知は GitHub の
 * Dependabot アラート（人間が見る経路）だけに依存する。
 *
 * ## なぜ静的検証なのか
 *
 * ワークフローは jest から実行できない。`continue-on-error` は 1 行消すだけで
 * 元に戻せてしまい、戻しても**全テストが緑のまま**なので、レビューで見落とせば
 * 誰も気づかない。YAML 上の不変条件として固定する。
 *
 * ## 将来ゲートを外したくなったら
 *
 * 修正版のない勧告が出て CI が赤くなった場合、`continue-on-error` を戻すのではなく
 * `npm audit --audit-level=high --exclude <advisory>` のような限定的な除外か、
 * `overrides` での対処を検討すること。ただし `overrides` はメジャーを跨ぐと
 * 447f0d0 と同じ ESM 非互換を招くため、同一メジャー内に留めること。
 */
describe('CI: npm audit を実ゲートとして維持する', () => {
  const workflowsDir = join(__dirname, '..', '..', '.github', 'workflows')

  const loadWorkflow = (file: string): Record<string, any> =>
    load(readFileSync(join(workflowsDir, file), 'utf8'), {
      schema: DEFAULT_SCHEMA,
    }) as Record<string, any>

  /** 全ジョブのステップを平坦化する。 */
  const allSteps = (workflow: Record<string, any>): Record<string, any>[] =>
    Object.values(workflow.jobs ?? {}).flatMap(
      (job: any) => (job?.steps ?? []) as Record<string, any>[],
    )

  /** `npm audit` を実行しているステップ。 */
  const auditSteps = (workflow: Record<string, any>): Record<string, any>[] =>
    allSteps(workflow).filter((s) => String(s?.run ?? '').includes('npm audit'))

  describe.each(['ci-cd.yml', 'dependency-update-test.yml'])('%s', (file) => {
    const workflow = loadWorkflow(file)

    it('npm audit を実行するステップが存在する', () => {
      expect(auditSteps(workflow).length).toBeGreaterThan(0)
    })

    it('npm audit のステップが continue-on-error で握り潰されていない', () => {
      for (const step of auditSteps(workflow)) {
        expect(step['continue-on-error']).toBeFalsy()
      }
    })

    it('high 以上を検出対象にしている', () => {
      for (const step of auditSteps(workflow)) {
        expect(String(step.run)).toContain('--audit-level=high')
      }
    })
  })
})

/**
 * 依存更新の検証ジョブでカバレッジ計装込みのテストを走らせることを固定する。
 *
 * 447f0d0 の障害（`minimatch is not a function`）は
 * babel-plugin-istanbul → test-exclude → minimatch という
 * **`--coverage` のときだけ通る経路**で起きた。通常の `npm test` では再現しない。
 *
 * 依存更新こそがその経路を壊す変更であり、それを検証するワークフローが
 * カバレッジなしで回っていると、同種の破壊を CI が最後まで捕まえられない。
 */
describe('CI: 依存更新の検証はカバレッジ経路も通す', () => {
  const workflow = load(
    readFileSync(
      join(__dirname, '..', '..', '.github', 'workflows', 'dependency-update-test.yml'),
      'utf8',
    ),
    { schema: DEFAULT_SCHEMA },
  ) as Record<string, any>

  it('カバレッジ付きでテストを実行するステップがある', () => {
    const text = JSON.stringify(workflow.jobs ?? {})
    expect(text).toMatch(/test:cov|--coverage/)
  })
})
