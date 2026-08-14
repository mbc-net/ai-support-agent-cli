/**
 * 自動アップデートを「いま実行してよいか」を毎回の更新チェック時に判定するゲート。
 *
 * 起動時に一度だけ決めるのではなく毎回評価するのは、管理画面のトグルを
 * エージェントの再起動なしで反映させるため。ON にした側から見ると、
 * 「設定したのに次の再起動まで効かない」のは設定できていないのと大差ない。
 *
 * 優先順位は `resolveAutoUpdateEnablement` に従う（CLI > サーバー > ローカル > OFF）。
 */

import type { ApiClient } from './api-client'
import { resolveAutoUpdateEnablement } from './auto-update-enablement'
import { logger } from './logger'
import { getErrorMessage } from './utils'

/**
 * サーバー（管理画面のプロジェクト設定）から見た自動アップデートの可否。
 *
 * - `true`  … 対象プロジェクトすべてが明示的に有効
 * - `false` … 1つでも明示的に無効
 * - `undefined` … サーバー層に意見が無い（問い合わせ失敗、または値を持たない）
 *
 * 自動アップデートはホスト単位の操作であり、1つのホストに同居する複数プロジェクトへ
 * 個別に適用できない。したがって「1つでも無効なら無効」「すべて有効なときだけ有効」とする。
 *
 * 値を持たない応答（管理画面で未操作、または `autoUpdateEnabled` を知らない旧 API）を
 * `false` ではなく `undefined` にするのは重要である。`false` に倒すと、`set-auto-update
 * --enable` で明示的に有効化してあるホストが、サーバー側の未設定というだけで停止する。
 * 「サーバーが無効と言った」と「サーバーに意見が無い」は別物として扱い、後者はローカル
 * 設定へ落とす（ローカルにも無ければ既定の OFF になるので、fail-closed は保たれる）。
 */
export async function fetchServerAutoUpdateEnabled(
  clients: readonly ApiClient[],
): Promise<boolean | undefined> {
  if (clients.length === 0) return undefined

  try {
    const configs = await Promise.all(clients.map((client) => client.getConfig()))
    const values = configs.map((config) => config?.autoUpdateEnabled)
    if (values.some((value) => value === false)) return false
    if (values.every((value) => value === true)) return true
    return undefined
  } catch (error: unknown) {
    // ここは更新チェックのたびに通るため warn では出さない（到達不能なネットワークで
    // ログが埋まる）。判断できなかったことだけを debug に残す。
    logger.debug(
      `[auto-update] Could not read the server-side auto-update setting: ${getErrorMessage(error)}`,
    )
    return undefined
  }
}

export interface AutoUpdateGateInput {
  /** 対象プロジェクトぶんの API クライアント。 */
  clients: readonly ApiClient[]
  /** CLI フラグ（`--auto-update` / `--no-auto-update`）。未指定なら undefined。 */
  cli?: boolean
  /** エージェントのローカル設定。未設定なら undefined。 */
  local?: boolean
}

/**
 * 更新チェックのたびに呼ばれるゲート関数を作る。
 */
export function createAutoUpdateGate({
  clients,
  cli,
  local,
}: AutoUpdateGateInput): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    // CLI フラグが与えられていればサーバー設定は結果を変えられない。
    // 変えられないと分かっているのに毎回問い合わせるのは無駄なので先に返す。
    if (cli !== undefined) return cli

    const server = await fetchServerAutoUpdateEnabled(clients)
    return resolveAutoUpdateEnablement({ server, local })
  }
}

/**
 * 自動アップデートの判定に使う API クライアント一式を作る。
 *
 * `ApiClient` のコンストラクタは HTTP の API URL などで**例外を投げる**。全プロジェクト
 * ぶんを素直に生成すると、1つでも不正な設定があるだけで自動アップデートの初期化が
 * エージェント全体の起動を落とす（以前は先頭プロジェクトしか生成していなかったため
 * 表面化しなかった）。かといって失敗したものを黙って除外すると、そのプロジェクトの
 * サーバー設定を評価しないまま更新を実行してしまう。
 *
 * どちらも避けるため、1つでも作れなければ `undefined` を返し、呼び出し側は自動
 * アップデート自体を諦める（fail-closed）。エージェント本体の稼働には影響しない。
 */
export function createAutoUpdateClients(
  projects: readonly { apiUrl: string; token: string }[],
  createClient: (apiUrl: string, token: string) => ApiClient,
): ApiClient[] | undefined {
  if (projects.length === 0) return undefined

  const clients: ApiClient[] = []
  for (const project of projects) {
    if (!project.apiUrl || !project.token) {
      logger.warn(
        '[auto-update] Skipping auto-update: a registered project has no API URL or token',
      )
      return undefined
    }
    try {
      clients.push(createClient(project.apiUrl, project.token))
    } catch (error: unknown) {
      logger.warn(
        `[auto-update] Skipping auto-update: could not build an API client for a registered project: ${getErrorMessage(error)}`,
      )
      return undefined
    }
  }
  return clients
}
