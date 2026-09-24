import { cleanupStaleAwsCredentials } from './aws-profile'
import { logger } from './logger'
import { getAwsDir } from './project-dir'
import { getErrorMessage } from './utils'

/**
 * 孤立した AWS 認証情報ファイルを掃除し、結果をログに出す。失敗しても投げない。
 *
 * 呼び出し元は config sync（`applyProjectConfig`）と heartbeat
 * （`agent-transport`）の 2 つ。config sync は configHash が変わったときしか
 * 走らないため、設定が長期間変化しないまま稼働し続けると掃除の機会が失われる。
 * そのため heartbeat 側にも安全網として置いてある（`sweepStaleEntries` は
 * 冪等なので二重実行しても無害）。
 *
 * :::danger
 * **掃除の失敗で呼び出し元を止めない。** ここは heartbeat ループの中から
 * 呼ばれる。例外を投げると、平文の認証情報が残っているという**軽微な後始末の
 * 失敗**が、エージェントそのものの停止に化ける。掃除できなかったことは warn
 * で残し、処理は続行する。
 * :::
 *
 * :::note
 * **`aws-profile.ts` ではなくこのモジュールに置いている。** 複数の spec が
 * `jest.mock('../src/aws-profile')` で必要なメンバーだけを差し替えており、
 * ここを `aws-profile` に置くとそれらのモックで `undefined` になる。呼び出しは
 * この関数の try/catch の**外側**で起きるため握り潰されず、config sync や
 * heartbeat がテスト中に落ちる。別モジュールなら本体が実在したまま、内部で
 * モックされた `cleanupStaleAwsCredentials` を呼ぶ。
 * :::
 *
 * `projectDir` が無い場合は何もしない（掃除対象のディレクトリを決められない）。
 * accounts が現在未設定でも過去の孤立ファイルを掃除できるよう、条件は
 * `projectDir` の有無だけにしている。
 *
 * @param prefix ログ行の接頭辞（`[tenant/project]` 等）
 */
export function sweepStaleAwsCredentials(
  projectDir: string | undefined,
  prefix: string,
): void {
  if (!projectDir) return
  try {
    const removedCount = cleanupStaleAwsCredentials(getAwsDir(projectDir))
    if (removedCount > 0) {
      logger.info(`${prefix} Cleaned up ${removedCount} stale AWS credentials file(s)`)
    }
  } catch (error) {
    logger.warn(`${prefix} Failed to clean up stale AWS credentials files: ${getErrorMessage(error)}`)
  }
}
