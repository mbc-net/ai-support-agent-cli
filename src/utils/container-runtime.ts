/**
 * 実行環境がコンテナオーケストレータ上かどうかの判定を一箇所にまとめる。
 *
 * 同じ判定を複数箇所に複製すると、片方だけ更新されて挙動が食い違う不具合を
 * 生む（このリポジトリでは実際に繰り返し発生している）。Kubernetes 判定は
 * 自動更新の抑止（`self-update-capability.ts`）と Codex のサンドボックス
 * モード決定（`commands/codex-runner.ts`）の双方が必要とするため、両者は
 * このヘルパーだけを参照する。
 */

/**
 * Kubernetes は全 Pod へ Service 環境変数 `KUBERNETES_SERVICE_HOST` を注入する。
 * Pod 内から in-cluster API へ到達するための標準的な検出手段であり、
 * `automountServiceAccountToken` を無効にしていても設定される。
 */
const KUBERNETES_SERVICE_HOST = 'KUBERNETES_SERVICE_HOST'

/**
 * Kubernetes の Pod 内で動いているかを判定する。
 *
 * @param env 判定に使う環境変数（既定は現在のプロセスのもの）
 */
export function isRunningOnKubernetes(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[KUBERNETES_SERVICE_HOST])
}
