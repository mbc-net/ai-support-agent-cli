import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * k3s ロールの time sync ブロックの回帰テスト。
 *
 * 回帰対象のバグ: common.yml の time sync ブロックは「systemd-timesyncd は OS に同梱
 * されている」という前提で、パッケージ導入タスクを `k3s_time_sync_service == 'chrony'`
 * のときだけ実行していた。しかし Ubuntu では systemd-timesyncd は独立パッケージであり、
 * クラウド/VPS イメージ（chrony を同梱）や minimal イメージには入っていない。その結果
 * unit が存在せず、enable/start タスクが
 *   "Could not find the requested service systemd-timesyncd: host"
 * で失敗する（実測: ubuntu:24.04 では systemd-timesyncd は Installed:(none) /
 * Candidate: 255.4-1ubuntu8.17）。
 *
 * さらに systemd-timesyncd と chrony は双方 `Provides/Conflicts: time-daemon` で排他の
 * ため、片方を apt で導入するともう片方が削除される（実測: chrony 導入済みホストに
 * systemd-timesyncd を入れると "Removing chrony ..."）。したがって既定 (`auto`) では
 * 「ホストに既にある対応 daemon」を有効化し、どちらも無い場合にのみ導入する。
 *
 * 固定する不変条件:
 *   1. 既定は `auto`（稼働中の time daemon を勝手に置き換えない）
 *   2. 有効化するサービスのパッケージ導入タスクが存在し、chrony 限定ガードを持たない
 *   3. その導入タスクは enable/start タスクより前に実行される
 *   4. apt に渡すパッケージ名は生の変数展開ではなくインライン許可リスト経由
 *      （レシピ body がロール変数を指定できるため、任意パッケージ導入を防ぐ）
 *   5. 許可リスト外の値は assert で明示的に失敗する
 *
 * 注: 実際に unit を enable/start するところまでの機能テストは systemd 有効な特権
 * コンテナ／実 VM が必要で jest では実行できないため、YAML の構造を直接検証する
 * （k3s-role-task-order.spec.ts と同じ方針）。
 */
const ROLE_DIR = join(__dirname, '../../ansible/roles/k3s')

interface AnsibleTask {
  name?: string
  when?: unknown
  register?: string
  loop?: unknown
  'ansible.builtin.command'?: { argv?: string[] }
  'ansible.builtin.apt'?: { name?: string; state?: string }
  'ansible.builtin.systemd'?: { name?: string; enabled?: boolean; state?: string }
  'ansible.builtin.assert'?: { that?: unknown }
  'ansible.builtin.set_fact'?: Record<string, unknown>
  [key: string]: unknown
}

function loadYaml<T>(relPath: string): T {
  const raw = readFileSync(join(ROLE_DIR, relPath), 'utf8')
  return load(raw, { schema: DEFAULT_SCHEMA }) as T
}

/** タスクの `when`（文字列 / 配列 / 未指定）を1本の文字列に正規化する。 */
function whenText(task: AnsibleTask): string {
  const cond = task.when
  if (cond === undefined || cond === null) return ''
  return Array.isArray(cond) ? cond.map((c) => String(c)).join(' && ') : String(cond)
}

describe('k3s role: time sync service (systemd-timesyncd は OS 同梱ではない)', () => {
  const tasks = loadYaml<AnsibleTask[]>('tasks/common.yml')
  const defaults = loadYaml<Record<string, unknown>>('defaults/main.yml')

  /** time sync サービスを enable/start する systemd タスク。 */
  const enableTaskIndex = tasks.findIndex((t) =>
    (t['ansible.builtin.systemd']?.name ?? '').includes('k3s_time_sync'),
  )
  /** 許可リスト検証（assert）タスク。 */
  const validateTaskIndex = tasks.findIndex((t) =>
    (t.name ?? '').includes('Validate the requested time sync service'),
  )
  /** apt / systemd が受け取る「リテラル辞書を解決値で index する」式。 */
  const ALLOWLIST_EXPR =
    "{{ {'systemd-timesyncd': 'systemd-timesyncd', 'chrony': 'chrony'}[k3s_time_sync_resolved] }}"
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()
  /** time sync サービスのパッケージを導入する apt タスク。 */
  const installTaskIndex = tasks.findIndex((t) =>
    (t['ansible.builtin.apt']?.name ?? '').includes('k3s_time_sync'),
  )

  it('既定は auto（ホストに既にある time daemon を置き換えない）', () => {
    expect(defaults.k3s_time_sync_service).toBe('auto')
  })

  it('enable/start するサービスのパッケージ導入タスクがあり、chrony 限定ガードを持たない', () => {
    // 根本原因: 旧実装の導入タスクは `when: k3s_time_sync_service == 'chrony'` で
    // chrony のときだけ走り、既定の systemd-timesyncd では何も導入されなかった。
    expect(enableTaskIndex).toBeGreaterThanOrEqual(0)
    expect(installTaskIndex).toBeGreaterThanOrEqual(0)
    expect(whenText(tasks[installTaskIndex])).not.toMatch(/chrony/)
  })

  it('パッケージ導入タスクは enable/start タスクより前に実行される', () => {
    expect(installTaskIndex).toBeGreaterThanOrEqual(0)
    expect(enableTaskIndex).toBeGreaterThanOrEqual(0)
    expect(installTaskIndex).toBeLessThan(enableTaskIndex)
  })

  it('apt に渡すパッケージ名はインライン許可リスト経由で、生の変数展開ではない', () => {
    // レシピ body は include_role の vars で k3s_time_sync_service を指定できる。
    // 値をそのまま apt の name に流すと任意パッケージ導入になるため、タスク内の
    // リテラル許可リストを経由させる（セキュリティ許可リストはインラインリテラル、
    // という既存ロールの方針に合わせる。defaults の変数は上書き可能で許可リストに
    // ならない）。
    // 「リテラル辞書を assert 済みの解決値で index する」形以外を許さない。部分文字列の
    // 有無だけを見ると、飾りのリテラルを置いて実際は敵性入力を apt に渡す式も通ってしまう。
    const aptName = tasks[installTaskIndex]?.['ansible.builtin.apt']?.name ?? ''
    expect(normalize(aptName)).toBe(ALLOWLIST_EXPR)
  })

  it('systemd に渡す unit 名も同じ許可リスト経由で、assert より後に実行される', () => {
    // apt と同じ二重防御。assert の位置に依存せずタスク単体で安全であること、かつ
    // 許可リスト検証が解決・導入・起動より前にあることの両方を固定する。
    const enableName = tasks[enableTaskIndex]?.['ansible.builtin.systemd']?.name ?? ''
    expect(normalize(enableName)).toBe(ALLOWLIST_EXPR)

    expect(validateTaskIndex).toBeGreaterThanOrEqual(0)
    expect(validateTaskIndex).toBeLessThan(installTaskIndex)
    expect(validateTaskIndex).toBeLessThan(enableTaskIndex)
    const resolveIndex = tasks.findIndex(
      (t) => t['ansible.builtin.set_fact']?.k3s_time_sync_resolved !== undefined,
    )
    expect(resolveIndex).toBeGreaterThanOrEqual(0)
    expect(validateTaskIndex).toBeLessThan(resolveIndex)
  })

  it('検出は systemctl の LoadState を厳密判定する（masked/未導入を「既存」と誤認しない）', () => {
    // `systemctl list-unit-files` は mask シンボリックリンクだけの unit も
    // "systemd-timesyncd.service masked" として出力する（chrony 稼働ホストで実測）。
    // 文字列包含で判定すると masked の timesyncd を「既存」と誤認し、apt が稼働中の
    // chrony を削除したうえで masked unit の起動に失敗する。よって LoadState を
    // unit ごとに問い合わせ、`loaded` だけを既存とみなすことを固定する。
    const stateTask = tasks.find((t) => t.register === 'k3s_time_sync_unit_states')
    expect(stateTask).toBeDefined()
    const argv = stateTask?.['ansible.builtin.command']?.argv ?? []
    expect(argv).toContain('show')
    expect(argv).toContain('--property=LoadState')
    // 既知の time daemon はすべて問い合わせ対象に含める
    expect(stateTask?.loop).toEqual(
      expect.arrayContaining([
        'systemd-timesyncd.service',
        'chrony.service',
        'ntpsec.service',
        'openntpd.service',
        'ntp.service',
      ]),
    )
    // list-unit-files のテキスト包含判定に戻さない
    expect(JSON.stringify(tasks)).not.toContain('list-unit-files')
  })

  it('auto はホストで loaded な unit を選ぶ（既存 daemon を置き換えない）', () => {
    // ここが消えて `auto` が常に systemd-timesyncd 固定になると、chrony 稼働ホストで
    // apt が chrony を削除する（Conflicts: time-daemon）。本ファイルが防ぎたい実害そのもの
    // なので、検出の両分岐が式に残っていることを固定する。
    const resolveTask = tasks.find(
      (t) => t['ansible.builtin.set_fact']?.k3s_time_sync_resolved !== undefined,
    )
    expect(resolveTask).toBeDefined()
    const expr = String(resolveTask?.['ansible.builtin.set_fact']?.k3s_time_sync_resolved ?? '')
    expect(expr).toContain("k3s_time_sync_load_states['systemd-timesyncd.service'] == 'loaded'")
    expect(expr).toContain("k3s_time_sync_load_states['chrony.service'] == 'loaded'")
    // 明示指定（auto 以外）はその値がそのまま使われる
    expect(expr).toContain("k3s_time_sync_service if k3s_time_sync_service != 'auto'")

    // 検出元となる LoadState 取得タスクが、解決タスクより前に存在すること。
    const stateIndex = tasks.findIndex((t) => t.register === 'k3s_time_sync_unit_states')
    expect(stateIndex).toBeGreaterThanOrEqual(0)
    expect(stateIndex).toBeLessThan(tasks.indexOf(resolveTask as AnsibleTask))
  })

  it('導入で他の time daemon を乱す場合は fail-closed で止まる（状態の列挙に穴を作らない）', () => {
    // ntpsec / openntpd / ntp も Conflicts: time-daemon のため、導入すると稼働中のそれが
    // apt に削除される。masked な timesyncd / chrony も同様（管理者が意図的に無効化した
    // ものを暗黙に置き換えない）。「loaded と masked を列挙」ではなく「全 unit が
    // not-found のときだけ導入する」形にして、列挙漏れの状態が素通りしないようにする。
    const guard = tasks.find((t) => {
      const that = JSON.stringify(t['ansible.builtin.assert']?.that ?? '')
      return that.includes('k3s_time_sync_load_states') && that.includes('not-found')
    })
    expect(guard).toBeDefined()
    const that = normalize(JSON.stringify(guard?.['ansible.builtin.assert']?.that ?? ''))
    // 特定の状態名（loaded/masked）を列挙する形に退化していないこと
    expect(that).not.toContain("'loaded'")
    expect(that).not.toContain("'masked'")
    expect(that).toContain("rejectattr('value', 'equalto', 'not-found')")
    expect(that).toContain('length == 0')
    // 明示指定時と、対応 daemon が既にある場合は止めない（auto かつ両方 loaded でないときだけ）
    const cond = whenText(guard as AnsibleTask)
    expect(cond).toContain("k3s_time_sync_service == 'auto'")
    expect(cond).toContain("k3s_time_sync_load_states['systemd-timesyncd.service'] != 'loaded'")
    expect(cond).toContain("k3s_time_sync_load_states['chrony.service'] != 'loaded'")
  })

  it('許可リスト外の k3s_time_sync_service は assert で明示的に失敗する', () => {
    const assertTask = tasks[validateTaskIndex]
    expect(assertTask).toBeDefined()
    const thatText = JSON.stringify(assertTask?.['ansible.builtin.assert']?.that ?? '')
    expect(thatText).toContain('k3s_time_sync_service')
    for (const allowed of ['auto', 'systemd-timesyncd', 'chrony']) {
      expect(thatText).toContain(allowed)
    }
  })
})
