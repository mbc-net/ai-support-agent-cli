import { execFileSync } from 'child_process'

import { getDockerPath } from '../docker/docker-utils'
import { logger } from '../logger'
import { DEFAULT_GUACD_PORT } from './guacd-tcp-socket'

/**
 * guacd を Docker コンテナとして起動・停止する。
 *
 * K8s / ECS は宣言的なマニフェストでサイドカーを組めるが、Docker 形態と CLI
 * 直起動にはサイドカーの仕組みが無いため、エージェント自身が面倒を見る。
 *
 * :::danger
 * **guacd には認証が無い。** 到達できる者は誰でも任意のホストへ RDP 接続を張れる。
 * 公開する場合も必ず `127.0.0.1` に束縛し、`0.0.0.0` へ出さないこと。ネットワーク
 * モードではポートを公開せず、同一 Docker ネットワーク内からのみ到達させる。
 * :::
 */

/** guacd コンテナの名前。再利用と後始末のため固定する。 */
export const GUACD_CONTAINER_NAME = 'ais-guacd'

/** Docker 形態でエージェントと guacd をつなぐネットワーク名。 */
export const GUACD_NETWORK_NAME = 'ais-rdp'

/**
 * guacd の既定イメージ。
 *
 * 版を固定する。移動タグを使うと、プロトコルの互換性が変わったときに再起動
 * しただけで挙動が変わり、原因が分からなくなる。
 */
export const DEFAULT_GUACD_IMAGE = 'guacamole/guacd:1.5.5'

/** 起動モード。 */
export type GuacdMode =
  /** ループバックへ公開する。エージェントがホスト上で直接動く場合（CLI 直起動）。 */
  | 'loopback'
  /** 専用ネットワークに置く。エージェントもコンテナで動く場合（Docker 形態）。 */
  | 'network'

export interface EnsureGuacdOptions {
  mode: GuacdMode
  /** イメージ。既定は {@link DEFAULT_GUACD_IMAGE}。 */
  image?: string
}

/** エージェントに教える guacd の在り処。 */
export interface GuacdEndpoint {
  host: string
  port: number
}

/** guacd コンテナが起動済みかどうか。 */
function containerState(): 'running' | 'stopped' | 'absent' {
  try {
    const out = execFileSync(
      getDockerPath(),
      ['inspect', '-f', '{{.State.Running}}', GUACD_CONTAINER_NAME],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'absent'
  }
}

/**
 * guacd が動いていることを保証し、接続先を返す。
 *
 * 冪等。既に稼働していれば何もしない。停止した同名コンテナが残っていれば削除して
 * から起動する（`--rm` を付けていても、ホストごと落ちた場合などに残ることがある）。
 *
 * @throws 起動に失敗した場合。握り潰すと、エージェントは存在しない guacd へ延々と
 *   接続を試み、利用者には「RDP がつながらない」としか見えない
 */
export function ensureGuacdContainer(
  options: EnsureGuacdOptions,
): GuacdEndpoint {
  const image = options.image ?? DEFAULT_GUACD_IMAGE
  const endpoint: GuacdEndpoint =
    options.mode === 'network'
      ? { host: GUACD_CONTAINER_NAME, port: DEFAULT_GUACD_PORT }
      : { host: '127.0.0.1', port: DEFAULT_GUACD_PORT }

  const state = containerState()
  if (state === 'running') {
    logger.debug(`[guacd] Reusing the running container ${GUACD_CONTAINER_NAME}`)
    return endpoint
  }
  if (state === 'stopped') {
    // `docker run --name` は同名の停止済みコンテナがあると失敗する。
    runDocker(['rm', '-f', GUACD_CONTAINER_NAME], { ignoreFailure: true })
  }

  if (options.mode === 'network') {
    // 既にあれば失敗するが、それは正常な状態。
    runDocker(['network', 'create', GUACD_NETWORK_NAME], {
      ignoreFailure: true,
    })
  }

  const publish =
    options.mode === 'loopback'
      ? // 127.0.0.1 に束縛する。0.0.0.0 に出すと、ホストに到達できる誰もが
        // 任意のホストへ RDP を張れる（guacd に認証は無い）。
        ['-p', `127.0.0.1:${DEFAULT_GUACD_PORT}:${DEFAULT_GUACD_PORT}`]
      : []

  const network =
    options.mode === 'network' ? ['--network', GUACD_NETWORK_NAME] : []

  runDocker([
    'run',
    '-d',
    '--rm',
    '--name',
    GUACD_CONTAINER_NAME,
    ...network,
    ...publish,
    image,
  ])

  logger.info(`[guacd] Started ${GUACD_CONTAINER_NAME} (${image})`)
  return endpoint
}

/**
 * guacd コンテナを停止する。
 *
 * 失敗しても投げない。エージェントの終了処理から呼ばれるため、ここで例外を出すと
 * 後続の後始末が走らなくなる。
 *
 * :::danger
 * **止め損ねた事実は warn で残す。** guacd には認証が無く、到達できる者は誰でも
 * 任意のホストへ RDP 接続を張れる。エージェントを終えても残り続けている状態を
 * debug ログに埋めると、通常の運用では収集されず誰も気づけない。
 * :::
 */
export function stopGuacdContainer(): void {
  runDocker(['stop', GUACD_CONTAINER_NAME], {
    ignoreFailure: true,
    failureMessage: `guacd container ${GUACD_CONTAINER_NAME} could not be stopped; it may still be running and accepting RDP connections`,
  })
}

function runDocker(
  args: string[],
  opts: { ignoreFailure?: boolean; failureMessage?: string } = {},
): void {
  try {
    execFileSync(getDockerPath(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
  } catch (err) {
    if (opts.ignoreFailure) {
      // 呼び出し元が「見えないと困る」と判断した失敗は warn へ上げる。
      if (opts.failureMessage) {
        logger.warn(`[guacd] ${opts.failureMessage}: ${String(err)}`)
      } else {
        logger.debug(
          `[guacd] docker ${args[0]} failed (ignored): ${String(err)}`,
        )
      }
      return
    }
    throw new Error(
      `Failed to start guacd (docker ${args.slice(0, 2).join(' ')}): ${String(err)}`,
    )
  }
}
