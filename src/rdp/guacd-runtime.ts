import {
  recordCapabilityApplyFailure,
  clearCapabilityApplyFailure,
} from '../capability/capability-apply-failures'
import { planCapability } from '../capability/capability-report'
import { ENV_VARS } from '../constants'
import { logger } from '../logger'
import type { AgentCapabilityDeclaration } from '../types'
import { getErrorMessage } from '../utils'
import {
  createGuacdShutdownHook,
  ensureGuacdContainer,
  ensureProjectGuacdContainer,
  extractGuacdSystemCaBundle,
  GUACD_NETWORK_NAME,
  invalidateProjectTrustStore,
  resolveProjectGuacdIdentity,
  type GuacdEndpoint,
} from './guacd-container'
import { DEFAULT_GUACD_PORT } from './guacd-tcp-socket'
import { RDP_TRUSTED_CA_MOUNT_PATH } from './rdp-trusted-ca'

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

/** guacd の用意に失敗したときの警告（プロジェクトは RDP 無しで起動する）。 */
function warnRdpUnavailable(error: unknown, projectRef?: string): void {
  const target = projectRef ? `the container of ${projectRef}` : 'this container'
  logger.warn(
    `[guacd] Web RDP is unavailable for ${target}: ${getErrorMessage(error)}. ` +
      'The project starts without RDP; set GUACD_HOST / GUACD_PORT to point at an existing guacd.',
  )
}

/** guacd への接続先とトンネル中継の待ち受けを渡す引数（Docker 形態共通）。 */
function guacdConnectionArgs(networkName: string, endpoint: GuacdEndpoint): string[] {
  return [
    '--network',
    networkName,
    '-e',
    `GUACD_HOST=${endpoint.host}`,
    '-e',
    `GUACD_PORT=${endpoint.port}`,
    // RDP tunnel relay: listen on this container's address on guacd's network
    // and admit only guacd (src/rdp/rdp-tunnel.ts). Explicit, never guessed.
    '-e',
    `${ENV_VARS.RDP_TUNNEL_LISTEN}=docker-network`,
  ]
}

/**
 * Docker 形態（通常経路 = DockerSupervisor）: `docker run` へ追加する引数を組み立てる。
 *
 * guacd を**プロジェクト（とエージェント）ごとに**専用ネットワーク（`ais-rdp-<key>`）へ置き
 * （`ais-guacd-<key>`）、エージェントのコンテナを同じネットワークへ参加させる。
 * ポートは公開しない。プロジェクトごとに分けるのは、guacd の信頼ストア
 * （`SSL_CERT_FILE`）が guacd プロセス単位でしか分けられず、信頼する CA は
 * プロジェクトごとに違うため。
 *
 * 標準 CA バンドルを取り出せたときだけ、信頼ストアのディレクトリを rw で渡し
 * `AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR` を設定する（＝`rdpTrustedCa` を申告する）。
 * 取り出せなければ RDP 自体は使える形で続け、CA は申告しない。
 *
 * :::warning
 * **失敗しても致命傷にしない**。呼び出し元はプロジェクトのコンテナを起動する経路で
 * あり、ここで投げると RDP とは無関係なチャット・ターミナルまで含めてその
 * プロジェクトが一切起動しなくなる。しかも呼び出し元の一つ（`rebuildAndRestart` の
 * 末尾からの再起動）は catch を持たない fire-and-forget であり、投げた例外は
 * プロジェクト名すら残らない unhandled rejection にしかならない。
 * :::
 *
 * @returns `docker run` へ差し込む引数。RDP が無効・用意に失敗した場合は空配列
 */
export function buildGuacdDockerArgs(
  options: GuacdRuntimeOptions,
  project: { tenantCode: string; projectCode: string },
  /** エージェントのコンテナ名と同じ agentId（guacd の識別子に含める）。 */
  agentId: string | undefined,
): string[] {
  if (!options.rdp) return []

  const id = resolveProjectGuacdIdentity(project, agentId)
  let base: string[]
  try {
    const endpoint = ensureProjectGuacdContainer(id, options.guacdImage)
    base = guacdConnectionArgs(id.networkName, endpoint)
  } catch (error) {
    warnRdpUnavailable(error, id.projectRef)
    return []
  }

  try {
    extractGuacdSystemCaBundle(id)
  } catch (error) {
    // fail-closed: この回はエージェントへ信頼ストアを渡さないので、以後に CA が
    // 削除されても bundle.pem は書き直されない。稼働中の guacd が前回の登録 CA 入りの
    // bundle.pem を読み続けないよう、信頼ストアを消してから RDP だけを渡す。
    if (!invalidateProjectTrustStore(id)) {
      logger.warn(
        `[guacd] Web RDP is disabled for ${id.projectRef}: the system CA bundle could not be ` +
          `copied out of ${id.containerName} (${getErrorMessage(error)}) and the previous trust ` +
          'store could not be cleared, so guacd might still trust CAs that were removed.',
      )
      return []
    }
    logger.warn(
      `[guacd] Registered RDP CAs are unavailable for ${id.projectRef}: could not copy the ` +
        `system CA bundle out of ${id.containerName}: ${getErrorMessage(error)}. ` +
        // 信頼ストア（bundle.pem）を消したので、guacd の SSL_CERT_FILE は存在しない
        // ファイルを指す。検証を有効にした接続は公開 CA の証明書でも失敗し得る。
        'RDP connections without certificate verification are unaffected; connections with ' +
        'certificate verification enabled (including ones needing a registered CA) may fail ' +
        'until the container is recreated with a valid CA bundle.',
    )
    return base
  }

  return [
    ...base,
    '-v',
    `${id.caHostDir}:${RDP_TRUSTED_CA_MOUNT_PATH}:rw`,
    '-e',
    `${ENV_VARS.RDP_TRUSTED_CA_DIR}=${RDP_TRUSTED_CA_MOUNT_PATH}`,
  ]
}

/**
 * Docker 形態の legacy fallback（プロジェクト 0 件で 1 コンテナが全プロジェクトを
 * 扱う経路）: 従来どおり共有の `ais-guacd`（`ais-rdp`）を使う。
 *
 * 1 つの guacd を全プロジェクトで共有するため、信頼ストアをプロジェクトで
 * 分けられない。信頼ストアは渡さず、`rdpTrustedCa` も申告しない。
 * 失敗しても投げない（{@link buildGuacdDockerArgs} と同じ理由）。
 */
export function buildSharedGuacdDockerArgs(options: GuacdRuntimeOptions): string[] {
  if (!options.rdp) return []

  try {
    const endpoint = ensureGuacdContainer({
      mode: 'network',
      image: options.guacdImage,
    })
    return guacdConnectionArgs(GUACD_NETWORK_NAME, endpoint)
  } catch (error) {
    warnRdpUnavailable(error)
    return []
  }
}

/** Raised by the resolver instead of letting a session hang on a dead endpoint. */
export class RdpUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RdpUnavailableError'
  }
}

export interface LazyGuacdOptions {
  /** guacd のイメージ。既定は `AI_SUPPORT_AGENT_GUACD_IMAGE`（CLI の `--guacd-image`）。 */
  guacdImage?: string
  /** 判定・書き込み先の環境変数。既定は現在のプロセスのもの。 */
  env?: NodeJS.ProcessEnv
  /**
   * Registers the hook that stops the container this resolver started.
   *
   * Injected so tests need no real process handlers — and named as its own
   * option so that "started it" and "registered its stop" cannot drift apart.
   */
  registerShutdownHook?: (stop: () => void) => void
}

/** Register the stop hook on the signals a normal shutdown goes through. */
function registerProcessShutdownHook(stop: () => void): void {
  // 3 つのハンドラに同じ処理を登録するため、多重呼び出しを畳むフック
  // （createGuacdShutdownHook）を渡すこと。素の停止関数だと通常の終了で 2 回走り、
  // 2 回目が「そんなコンテナは無い」で失敗して偽の警告が毎回出る。
  process.once('exit', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

/**
 * CLI 直起動: guacd の接続先を**要求時に**解決する。
 *
 * :::danger 起動時にまとめて用意しない
 * 以前は起動オプション `--rdp` を見て、プロセス開始時に一度だけ guacd を用意して
 * いた。そのため画面から capability を ON にしても、エージェントを再起動するまで
 * RDP は使えなかった。接続時に読まれるのは `GUACD_HOST` / `GUACD_PORT` だけなので、
 * **初回の接続要求時に用意して環境変数を書けば、その接続から成立する**。
 * ホスト直起動が「即時適用」になる根拠はここにある。
 * :::
 *
 * `GUACD_HOST` が既に設定されている場合はコンテナを起動しない。運用側が別途 guacd を
 * 用意している構成（およびサイドカー付きの Pod / タスク）を壊さないため。
 *
 * 解決に成功した時点で終了フックを登録する。**起動したものは必ず止める**——
 * guacd には認証が無く、エージェントを終えても残り続けると、到達できる者は誰でも
 * 任意のホストへ RDP 接続を張れる。以前この登録は `--rdp` が指定されたときにだけ
 * 行われており、遅延起動の経路はそのフラグを通らない。
 *
 * @returns 接続先を返す関数。失敗時は {@link RdpUnavailableError} を投げる
 */
export function createLazyGuacdEndpointResolver(
  options: LazyGuacdOptions = {},
): () => GuacdEndpoint {
  const env = options.env ?? process.env
  const registerShutdownHook =
    options.registerShutdownHook ?? registerProcessShutdownHook
  let resolved: GuacdEndpoint | null = null

  return (): GuacdEndpoint => {
    if (resolved) return resolved

    const preconfigured = env.GUACD_HOST
    if (preconfigured) {
      logger.debug(`[guacd] Using the preconfigured endpoint ${preconfigured}`)
      resolved = {
        host: preconfigured,
        port: Number(env.GUACD_PORT ?? DEFAULT_GUACD_PORT),
      }
      return resolved
    }

    let endpoint: GuacdEndpoint
    try {
      endpoint = ensureGuacdContainer({
        mode: 'loopback',
        image: options.guacdImage ?? env[ENV_VARS.GUACD_IMAGE],
      })
    } catch (error) {
      // 失敗を記憶して報告に載せる（not_applied(apply_failed)）。ここで投げるのは
      // このセッションを断るためだけであり、エージェント本体は巻き添えにしない
      // — 呼び出し元は 1 件の rdp_open であって、プロセスの起動経路ではない。
      const detail = getErrorMessage(error)
      recordCapabilityApplyFailure('rdp', detail)
      logger.warn(
        `[guacd] Web RDP is unavailable: ${detail}. ` +
          'Set GUACD_HOST / GUACD_PORT to point at an existing guacd, or run the agent where Docker is available.',
      )
      throw new RdpUnavailableError(`Could not start guacd: ${detail}`)
    }

    env.GUACD_HOST = endpoint.host
    env.GUACD_PORT = String(endpoint.port)
    registerShutdownHook(createGuacdShutdownHook())
    clearCapabilityApplyFailure('rdp')
    resolved = endpoint
    return resolved
  }
}

export interface CapabilityGuacdOptions extends LazyGuacdOptions {
  /**
   * Reads the currently delivered declaration. A function, not a value: the
   * relay outlives any single config sync, and the declaration is what changes
   * when an administrator flips the switch.
   */
  getDeclaration: () => AgentCapabilityDeclaration | undefined
}

/**
 * The resolver the RDP relay actually uses: the capability gate in front of the
 * lazy start.
 *
 * :::danger 無効なときは黙って繋ぎに行かない
 * 以前は capability の概念が無く、guacd が居なくても接続を試みていた。利用者から
 * 見えるのは「しばらく待たされたあと繋がらない」だけで、設定の不備なのか障害なのか
 * 区別が付かなかった。ここで**明示的に断る**ことで、画面にそのまま出せる理由
 * （`action_required_restart` / `action_required_redeploy` 等）が残る。
 * :::
 *
 * Gating on {@link planCapability} rather than the reported state is deliberate:
 * a previously recorded apply failure must not permanently refuse a connection
 * the user is explicitly asking for again.
 */
export function createGuacdEndpointResolverForCapability(
  options: CapabilityGuacdOptions,
): () => GuacdEndpoint {
  const env = options.env ?? process.env
  const lazy = createLazyGuacdEndpointResolver(options)

  return (): GuacdEndpoint => {
    const planned = planCapability('rdp', {
      declaration: options.getDeclaration(),
      env,
    })
    if (!planned) {
      throw new RdpUnavailableError(
        'The rdp capability is not enabled for this agent. Turn it on in the ' +
          'project settings, or start the agent with --rdp.',
      )
    }
    if (planned.state !== 'active') {
      throw new RdpUnavailableError(
        `The rdp capability is declared but not applied on this agent (${planned.reason}). ` +
          `${planned.detail ?? ''}`.trimEnd(),
      )
    }
    return lazy()
  }
}
