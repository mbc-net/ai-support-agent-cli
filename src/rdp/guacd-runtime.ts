import { logger } from '../logger'
import { getErrorMessage } from '../utils'
import {
  ensureGuacdContainer,
  GUACD_NETWORK_NAME,
} from './guacd-container'

/**
 * Docker 形態と CLI 直起動での guacd の面倒見。
 *
 * K8s / ECS はマニフェストでサイドカーを宣言できるが、この 2 形態には仕組みが
 * 無いため、エージェント自身が guacd コンテナを起動して接続先を配る。
 */

export interface GuacdRuntimeOptions {
  /** Web RDP を有効にするか。 */
  rdp?: boolean
  /** guacd のイメージ。 */
  guacdImage?: string
}

/**
 * Docker 形態: `docker run` へ追加する引数を組み立てる。
 *
 * guacd を専用ネットワークに置き、エージェントのコンテナを同じネットワークへ
 * 参加させる。ポートは公開しない（ネットワーク内からのみ到達させる）。
 *
 * :::warning
 * **失敗しても致命傷にしない**（`resolveGuacdForHost` と同じ方針）。呼び出し元は
 * プロジェクトのコンテナを起動する経路であり、ここで投げると RDP とは無関係な
 * チャット・ターミナルまで含めてそのプロジェクトが一切起動しなくなる。しかも
 * 呼び出し元の一つ（`rebuildAndRestart` の末尾からの再起動）は catch を持たない
 * fire-and-forget であり、投げた例外はプロジェクト名すら残らない
 * unhandled rejection にしかならない。
 * :::
 *
 * @returns `docker run` へ差し込む引数。RDP が無効・用意に失敗した場合は空配列
 */
export function buildGuacdDockerArgs(options: GuacdRuntimeOptions): string[] {
  if (!options.rdp) return []

  try {
    const endpoint = ensureGuacdContainer({
      mode: 'network',
      image: options.guacdImage,
    })

    return [
      '--network',
      GUACD_NETWORK_NAME,
      '-e',
      `GUACD_HOST=${endpoint.host}`,
      '-e',
      `GUACD_PORT=${endpoint.port}`,
    ]
  } catch (error) {
    logger.warn(
      `[guacd] Web RDP is unavailable for this container: ${getErrorMessage(error)}. ` +
        'The project starts without RDP; set GUACD_HOST / GUACD_PORT to point at an existing guacd.',
    )
    return []
  }
}

/**
 * CLI 直起動: guacd を用意して環境変数へ反映する。
 *
 * :::warning
 * **失敗しても致命傷にしない。** Docker が使えない環境もあり、RDP は付加機能に
 * すぎない。ここで落とすと、チャットやターミナルまで含めてエージェント本体が
 * 起動できなくなる。
 * :::
 *
 * `GUACD_HOST` が既に設定されている場合は何もしない。運用側が別途 guacd を
 * 用意している構成を壊さないため。
 */
export function resolveGuacdForHost(options: GuacdRuntimeOptions): void {
  if (!options.rdp) return

  if (process.env.GUACD_HOST) {
    logger.debug(
      `[guacd] Using the preconfigured endpoint ${process.env.GUACD_HOST}`,
    )
    return
  }

  try {
    const endpoint = ensureGuacdContainer({
      mode: 'loopback',
      image: options.guacdImage,
    })
    process.env.GUACD_HOST = endpoint.host
    process.env.GUACD_PORT = String(endpoint.port)
  } catch (error) {
    logger.warn(
      `[guacd] Web RDP is unavailable: ${getErrorMessage(error)}. ` +
        'Set GUACD_HOST / GUACD_PORT to point at an existing guacd, or run the agent where Docker is available.',
    )
  }
}
