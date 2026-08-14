/**
 * 自動アップデートを実行してよいかの判定。
 *
 * 設定は3層あり、上の層が下の層を上書きする。値を持たない層は素通りする。
 *
 *   1. CLI フラグ    `--auto-update` / `--no-auto-update`
 *   2. サーバー設定  管理画面のプロジェクト設定（`autoUpdateEnabled`）
 *   3. ローカル設定  `ai-support-agent set-auto-update`
 *   4. 既定          OFF
 *
 * 既定を OFF にしているのは、自動アップデートが「動かしてよい環境か」を
 * エージェント側では判断しきれないためである（イメージで版を固定している、
 * 検証済みの版に留めたい、等）。明示的に有効化されたときだけ動かす。
 *
 * サーバー設定を取得できなかった場合は `server` を `undefined` にして呼ぶ。
 * そのときはローカル設定へ落ち、ローカル設定も無ければ既定の OFF になる。
 */
export interface AutoUpdateEnablementInput {
  /** CLI フラグ。未指定なら `undefined`（`--auto-update` と `--no-auto-update` の両方を定義して初めて三状態になる）。 */
  cli?: boolean
  /** 管理画面のプロジェクト設定。取得できていなければ `undefined`。 */
  server?: boolean
  /** エージェントのローカル設定。未設定なら `undefined`。 */
  local?: boolean
}

export function resolveAutoUpdateEnablement({
  cli,
  server,
  local,
}: AutoUpdateEnablementInput): boolean {
  if (cli !== undefined) return cli
  if (server !== undefined) return server
  if (local !== undefined) return local
  return false
}
