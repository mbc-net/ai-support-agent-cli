import { DOCKER_UPDATE_EXIT_CODE } from './constants'
import { logger } from './logger'
import { atomicWriteFile, getErrorMessage, isInDocker } from './utils'
import { getUpdateVersionFilePath } from './utils/path-utils'

/**
 * Docker コンテナ内なら、新バージョンを記録したうえで専用の終了コードで抜ける。
 * コンテナ外では何もしない。
 *
 * コンテナ内では `process.send` が使えないため、ホスト側（`runInDocker()` /
 * `DockerSupervisor`）はこの終了コードだけを頼りに「更新による再起動」と
 * 「SIGINT による正常停止」を区別し、イメージの再ビルドへ進む。
 *
 * :::danger
 * **バージョンの書き出しと終了コードはセットでなければならない。**
 * ホスト側の `installUpdateAndRestart()` は `update-version.json` を読んで
 * `npm install` を実行してから再ビルドする。書き出しに失敗したまま終了すると、
 * ホストは更新を検知しつつ**どのバージョンへ上げるか分からない**状態になる。
 * 逆に書き出しても終了コードが違えば、ホストは通常停止と区別できず再ビルドしない。
 * 自動更新と手動更新コマンドの 2 経路が逐語で同じ処理を持っていたため、ここへ寄せた。
 * :::
 *
 * 書き出しの失敗そのものでは中断しない（warn に留めて終了する）。ここで投げると
 * 更新の最後の一歩だけが失敗してコンテナが古いまま動き続ける。
 *
 * 設定ディレクトリはボリュームマウントされており、ホスト・コンテナの双方から
 * 読める。
 */
export function exitIfDockerUpdateRestart(targetVersion: string): void {
  if (!isInDocker()) return
  try {
    atomicWriteFile(
      getUpdateVersionFilePath(),
      JSON.stringify({ version: targetVersion }),
    )
  } catch (err: unknown) {
    logger.warn(
      `[update] Failed to write update-version.json: ${getErrorMessage(err)}`,
    )
  }
  process.exit(DOCKER_UPDATE_EXIT_CODE)
}
