/**
 * 自己更新（npm でこのプロセス自身のパッケージを差し替えて再実行する方式）が
 * 成立する実行環境かどうかを判定する。
 *
 * 自動アップデートの再起動は `update-checker.ts` の `reExecProcess()` が担い、
 * 「detached な子プロセスを spawn して自分は `process.exit(0)`」という形をとる。
 * これは「終了したら誰かが起動し直してくれる」監督プロセス（systemd のユーザー
 * ユニット、ホスト側の DockerSupervisor）を前提にした設計であり、その前提が無い
 * 環境では次のように壊れる。
 *
 *   1. コンテナの ENTRYPOINT は `exec "$@"` するため、エージェントは PID 1 になる
 *   2. 更新後の `process.exit(0)` で PID 1 が消え、コンテナ自体が終了する
 *   3. PID 1 が死ぬと同じ PID 名前空間に残った detached の子もカーネルに殺されるため、
 *      再実行したはずの新バージョンも即座に消える
 *   4. オーケストレータがコンテナを再作成する。中身はイメージのものに戻るので、
 *      npm で入れた新バージョンは残らない
 *   5. しばらくして再びチェックが走り、同じことを繰り返す
 *
 * つまり「更新できないまま再起動を繰り返す」だけになる。これらの環境での正しい
 * バージョンアップはイメージタグの差し替えであり、自己更新は設定に関わらず
 * 行わせない。
 */

import { ENV_VARS } from './constants'
import { isRunningOnKubernetes } from './utils/container-runtime'

/** 自己更新が成立しない理由。 */
export type SelfUpdateBlockReason = 'kubernetes' | 'pid1-no-supervisor'

export interface SelfUpdateCapability {
  /** true なら自己更新方式でのバージョンアップが成立する。 */
  capable: boolean
  /** `capable` が false のときだけ設定される。 */
  reason?: SelfUpdateBlockReason
}

/**
 * 実行環境から自己更新の可否を判定する。
 *
 * 判定順序には意味がある。Kubernetes の判定を `AI_SUPPORT_AGENT_IN_DOCKER` より
 * 先に置くのは、Pod にはホスト側の DockerSupervisor が存在しないためである
 * （マニフェストが何らかの理由でこの変数を立てていても、更新を引き受ける相手は
 * いない）。
 *
 * @param env 判定に使う環境変数（既定は現在のプロセスのもの）
 * @param pid 判定に使うプロセスID（既定は現在のプロセスのもの）
 */
export function resolveSelfUpdateCapability(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): SelfUpdateCapability {
  // Kubernetes の判定は codex-runner のサンドボックス判定と共有する
  // （`utils/container-runtime.ts`）。
  if (isRunningOnKubernetes(env)) {
    return { capable: false, reason: 'kubernetes' }
  }

  // ホスト側の CLI が `docker run` で起動したコンテナ。コンテナが専用の終了コードで
  // 抜けたあと、ホスト側が npm 導入とイメージ再ビルドを引き受けるため、
  // PID 1 であっても自己更新の流れは完結する。
  if (env[ENV_VARS.IN_DOCKER] === '1') {
    return { capable: true }
  }

  // 監督プロセスのいない PID 1（Kubernetes 以外のオーケストレータ、ECS、
  // 素の `docker run`）。終了すればコンテナごと消えるため成立しない。
  if (pid === 1) {
    return { capable: false, reason: 'pid1-no-supervisor' }
  }

  return { capable: true }
}

/**
 * ログ・ハートビート通知に載せる説明文。
 *
 * 「なぜ止めたか」だけでなく「代わりに何をすればよいか」まで書く。これを読む人は
 * 管理画面で自動アップデートを ON にしたのに動かない、という状況にいるため。
 */
export function describeSelfUpdateBlockReason(
  reason: SelfUpdateBlockReason,
): string {
  switch (reason) {
    case 'kubernetes':
      return (
        'Auto-update is disabled because this agent runs on Kubernetes. ' +
        'Updating the package inside the Pod would terminate the container and ' +
        'revert to the version baked into the image. Upgrade by changing the ' +
        'container image tag (e.g. ghcr.io/mbc-net/ai-support-agent-cli:<version>) ' +
        'and re-applying the manifest instead.'
      )
    case 'pid1-no-supervisor':
      return (
        'Auto-update is disabled because this agent runs as PID 1 with no ' +
        'supervisor to restart it. Updating the package would terminate the ' +
        'container and revert to the version baked into the image. Upgrade by ' +
        'changing the container image tag instead.'
      )
  }
}
