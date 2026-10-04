import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `npm audit`（ゲートスクリプト経由）を CI の実ゲートとして固定する静的検証。
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
 * ## 修正版のない勧告の扱い（期限付き除外）
 *
 * `npm audit` には勧告単位の除外が無い。修正版のない勧告（例: braces の
 * GHSA-vfj7-8cjw-p6xm）が出ると CI が恒久的に赤になるが、そこで `continue-on-error`
 * を戻すのではなく、`.github/scripts/npm-audit-gate.js` 経由で監査する。
 * このスクリプトは `npm audit --json` を解釈し、`.github/npm-audit-exclusions.json` に
 * 「GHSA ID＋パッケージ名＋理由＋期限（expires）」で登録した勧告だけを通す。
 * 期限切れの除外・どの勧告にも一致しない除外・除外されていない high 以上の勧告は
 * いずれも失敗になる。除外の前提（修正版が未公開・dev 依存のみ）も reason の記述ではなく
 * レジストリの公開バージョンと `npm audit --omit=dev` で機械的に検査する
 * （判定ロジックは `npm-audit-gate.spec.ts` で検証）。
 *
 * ここでは次を固定する:
 *   - 監査ステップの run が `node .github/scripts/npm-audit-gate.js --audit-level=high`
 *     と完全一致すること（`|| true` 等の後置や監査レベルの変更を許さない）
 *   - ゲートを経由しない素の `npm audit` ステップが無いこと（除外の仕組みを迂回して
 *     `continue-on-error` 付きで足す、といった抜け道を塞ぐ）
 *   - 除外ファイルの各エントリが理由と期限を持つこと
 *
 * `overrides` での対処を検討する場合、メジャーを跨ぐと 447f0d0 と同じ
 * ESM 非互換を招くため、同一メジャー内に留めること。
 */
/** 監査ステップの run として許す唯一のコマンド（high 以上を検出対象にする）。 */
const AUDIT_GATE_COMMAND = 'node .github/scripts/npm-audit-gate.js --audit-level=high'

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

  /** ゲートスクリプト経由で監査しているステップ。 */
  const auditSteps = (workflow: Record<string, any>): Record<string, any>[] =>
    allSteps(workflow).filter((s) => String(s?.run ?? '').includes('npm-audit-gate.js'))

  /** ゲートを経由せず `npm audit` を直接実行しているステップ。 */
  const bareAuditSteps = (workflow: Record<string, any>): Record<string, any>[] =>
    allSteps(workflow).filter((s) => /\bnpm\s+audit\b/.test(String(s?.run ?? '')))

  describe.each(['ci-cd.yml', 'dependency-update-test.yml'])('%s', (file) => {
    const workflow = loadWorkflow(file)

    it('ゲートスクリプトで監査するステップが存在する', () => {
      expect(auditSteps(workflow).length).toBeGreaterThan(0)
      // 完全一致で固定する。前方一致だと `|| true`・`; true`・`&& ...` の後置や
      // 別レベル（例: --audit-level=critical）への変更を見逃す。
      for (const step of auditSteps(workflow)) {
        expect(String(step.run).trim()).toBe(AUDIT_GATE_COMMAND)
      }
    })

    it('ゲートを迂回する素の npm audit ステップが無い', () => {
      expect(bareAuditSteps(workflow)).toEqual([])
    })

    it('監査ステップが continue-on-error で握り潰されていない', () => {
      for (const step of auditSteps(workflow)) {
        expect(step['continue-on-error']).toBeFalsy()
      }
    })

  })
})

describe('CI: npm audit の除外ファイル', () => {
  const root = join(__dirname, '..', '..')

  it('ゲートスクリプトが存在する', () => {
    expect(existsSync(join(root, '.github', 'scripts', 'npm-audit-gate.js'))).toBe(true)
  })

  it('各エントリが GHSA ID・パッケージ名・理由・期限を持つ', () => {
    const entries = JSON.parse(
      readFileSync(join(root, '.github', 'npm-audit-exclusions.json'), 'utf8'),
    ) as unknown
    expect(Array.isArray(entries)).toBe(true)
    for (const entry of entries as Record<string, unknown>[]) {
      expect(entry.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/)
      expect(typeof entry.package).toBe('string')
      expect(String(entry.package).trim()).not.toBe('')
      expect(typeof entry.reason).toBe('string')
      expect(String(entry.reason).trim()).not.toBe('')
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
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
