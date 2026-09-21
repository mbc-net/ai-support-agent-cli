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
 * :::danger Idempotent across processes, not only within one
 * `execFileSync` serialises the inspect-then-run sequence inside a single
 * process, and nothing serialises it between processes. On a host install one
 * OS process runs per project (`fork()` in `child-process-manager.ts`) and each
 * resolves guacd lazily on its first `rdp_open`, so two projects connecting at
 * the same moment both see "absent" and both issue `docker run --name`. The
 * docker daemon serialises creation by name and refuses the loser with a name
 * conflict — which is **evidence that guacd was started**, not a failure.
 * Treating it as one turned a healthy guacd into a fatal `RdpUnavailableError`
 * (the user gets no automatic retry) and a `not_applied(apply_failed)` line on
 * the heartbeat. So the loser adopts the winner's container after confirming it
 * is actually running. Letting the daemon arbitrate is both simpler and safer
 * than a lock file of our own, which would still have to be reclaimed after a
 * crash.
 * :::
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

  let adopted = false
  runDocker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      GUACD_CONTAINER_NAME,
      ...network,
      ...publish,
      image,
    ],
    {
      // Only a name conflict is rescued, and only once the container is
      // confirmed running. A conflict whose container died on creation, or any
      // other failure (missing image, dead daemon), still throws: handing back
      // an endpoint nothing listens on is the failure mode this function's
      // "don't swallow" rule exists to prevent.
      rescue: (err) => {
        if (!isNameConflictError(err, GUACD_CONTAINER_NAME)) return false
        adopted = containerState() === 'running'
        return adopted
      },
    },
  )

  if (adopted) {
    // No `rm` and no second `run` here: the winner's container is serving the
    // connection it was started for, and removing it would cut that session.
    logger.info(
      `[guacd] Adopted ${GUACD_CONTAINER_NAME}, started by another process`,
    )
  } else {
    logger.info(`[guacd] Started ${GUACD_CONTAINER_NAME} (${image})`)
  }
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
export function stopGuacdContainer(): boolean {
  return runDocker(['stop', GUACD_CONTAINER_NAME], {
    ignoreFailure: true,
    absentIsSettled: true,
    failureMessage: `guacd container ${GUACD_CONTAINER_NAME} could not be stopped; it may still be running and accepting RDP connections`,
  })
}

/**
 * Create the process-exit hook that stops guacd.
 *
 * :::danger
 * **The same handler is registered on several signals.** `exit`, `SIGINT` and
 * `SIGTERM` all get it, so a normal shutdown calls it twice. Without a guard
 * the second call always fails with "No such container" and logs the warning
 * that says guacd may still be accepting RDP connections. A warning that fires
 * on every clean exit trains operators to ignore it, and a real failure to stop
 * guacd — which leaves an unauthenticated RDP relay running — is lost in it.
 * :::
 *
 * :::danger
 * **Latch on success, never on the attempt.** Registering the handler several
 * times used to double as a retry: a first `docker stop` lost to a transient
 * daemon error was re-issued by the next handler. Suppressing the repeat
 * unconditionally would remove that retry and leave an unauthenticated guacd
 * running after the agent is gone — the very state the warning in
 * {@link stopGuacdContainer} is about.
 * :::
 *
 * The state lives in the closure, not in the module, so separate hooks stay
 * independent (a restarted supervisor is free to stop its own container).
 */
export function createGuacdShutdownHook(): () => void {
  let stopped = false
  return (): void => {
    if (stopped) return
    stopped = stopGuacdContainer()
  }
}

/**
 * Whether docker refused because the container does not exist.
 *
 * A missing container is the desired end state for a stop, not a failure. The
 * shutdown hook is registered whenever `--rdp` is on, including setups where
 * the agent never starts a container of its own (`GUACD_HOST` points at an
 * external guacd, or Docker is unavailable). Treating that as a failure puts
 * the "guacd may still be accepting RDP connections" warning on *every* clean
 * exit and keeps retrying it, which is the false alarm this hook exists to
 * remove.
 *
 * Matching on the message is deliberate: an unrecognised wording degrades to
 * "failed", which warns and retries — the safe direction. For the same reason
 * the *name* has to match: "no such container" about some other container says
 * nothing about ours, and treating it as settled would drop both the warning
 * and the retry while guacd is still up.
 */
function isAbsentContainerError(err: unknown, name: string): boolean {
  return new RegExp(
    `no such container:?\\s*${escapeForRegExp(name)}(?![\\w.-])`,
    'i',
  ).test(dockerErrorText(err))
}

/**
 * Whether docker refused because a container of that name already exists.
 *
 * This is what the process that lost a cross-process race sees; see the note on
 * {@link ensureGuacdContainer}. docker words it "Conflict. The container name
 * "/ais-guacd" is already in use by container "<id>"", and puts it on stderr,
 * so the message alone says only that the command failed.
 *
 * Matching on the message follows {@link isAbsentContainerError}: an
 * unrecognised wording degrades to "failed", which throws — the previous
 * behaviour, and the safe direction, because a swallowed real failure hands the
 * caller an endpoint nothing is listening on. The *name* has to match for the
 * same reason it does there: a conflict on some other container (say a
 * differently named sidecar) says nothing about ours, and the boundary after
 * the name keeps `ais-guacd` from matching `ais-guacd-sidecar`.
 */
function isNameConflictError(err: unknown, name: string): boolean {
  return new RegExp(
    `container name\\s+"?/?${escapeForRegExp(name)}(?![\\w.-])"?\\s+is already in use`,
    'i',
  ).test(dockerErrorText(err))
}

/** Everything docker said about a failure: `execFileSync` splits it in two. */
function dockerErrorText(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr
  return `${String((err as Error)?.message ?? '')} ${
    stderr instanceof Buffer ? stderr.toString() : String(stderr ?? '')
  }`
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @returns whether the command reached its intended end state. With
 *   `absentIsSettled`, "no such container" counts as reached.
 */
function runDocker(
  args: string[],
  opts: {
    ignoreFailure?: boolean
    absentIsSettled?: boolean
    failureMessage?: string
    /**
     * Inspects a failure the caller may be able to accept — it returns true
     * when the intended end state was reached by other means. Given the raw
     * error rather than the wrapped one so the caller can read docker's own
     * wording; see {@link isNameConflictError}.
     */
    rescue?: (err: unknown) => boolean
  } = {},
): boolean {
  try {
    execFileSync(getDockerPath(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return true
  } catch (err) {
    if (opts.rescue?.(err)) return true
    if (
      opts.absentIsSettled &&
      isAbsentContainerError(err, GUACD_CONTAINER_NAME)
    ) {
      logger.debug(
        `[guacd] container ${GUACD_CONTAINER_NAME} is already gone; nothing to stop`,
      )
      return true
    }
    if (opts.ignoreFailure) {
      // 呼び出し元が「見えないと困る」と判断した失敗は warn へ上げる。
      if (opts.failureMessage) {
        logger.warn(`[guacd] ${opts.failureMessage}: ${String(err)}`)
      } else {
        logger.debug(
          `[guacd] docker ${args[0]} failed (ignored): ${String(err)}`,
        )
      }
      return false
    }
    throw new Error(
      `Failed to start guacd (docker ${args.slice(0, 2).join(' ')}): ${String(err)}`,
    )
  }
}
