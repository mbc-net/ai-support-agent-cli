import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { getDockerPath } from '../docker/docker-utils'
import { logger } from '../logger'
import { DEFAULT_GUACD_PORT } from './guacd-tcp-socket'
import {
  RDP_TRUSTED_CA_BUNDLE_FILE,
  RDP_TRUSTED_CA_MOUNT_PATH,
  RDP_TRUSTED_CA_SYSTEM_FILE,
} from './rdp-trusted-ca'

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

/**
 * guacd コンテナの名前。再利用と後始末のため固定する。
 *
 * CLI 直起動（loopback 形態）と、Docker 形態の legacy fallback（共有方式）が
 * 使う。Docker 形態の通常経路はプロジェクト別の `ais-guacd-<key>`
 * （{@link resolveProjectGuacdIdentity}）で、この名前の接頭辞になる。
 */
export const GUACD_CONTAINER_NAME = 'ais-guacd'

/**
 * Docker 形態の legacy fallback でエージェントと guacd をつなぐネットワーク名。
 * 通常経路はプロジェクト別の `ais-rdp-<key>`。
 */
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
    options.mode === 'network'
      ? [
          '--network',
          GUACD_NETWORK_NAME,
          // 現行の legacy fallback が起動した共有 guacd であることの印。
          // removeLegacySharedGuacd はこれの無いもの（旧版の残骸）だけを撤去する。
          '--label',
          `${GUACD_LAYOUT_LABEL}=${GUACD_SHARED_LAYOUT}`,
        ]
      : []

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
 * Docker 形態のプロジェクト別 guacd の名前と置き場所。
 *
 * 信頼する CA はプロジェクトごとに違い、guacd の信頼ストア（`SSL_CERT_FILE`）
 * は guacd プロセス単位でしか分けられない。そのため Docker 形態では guacd を
 * プロジェクトごとに立て、ネットワークも分ける（別プロジェクトの guacd や
 * エージェントから到達させない）。
 */
export interface ProjectGuacdIdentity {
  /** `sha256("<tenantCode>/<projectCode>/<agentId>")` の先頭 16 hex。 */
  key: string
  /** `ais-guacd-<key>` */
  containerName: string
  /** `ais-rdp-<key>` */
  networkName: string
  /** ホスト側の信頼ストア `<configDir>/rdp-trusted-ca/<key>`。 */
  caHostDir: string
  /** `<tenantCode>/<projectCode>`（ラベルに載せて取り違えを検出する）。 */
  projectRef: string
}

/** プロジェクト別 guacd に付けるラベル（再利用してよいかの判定に使う）。 */
export const GUACD_PROJECT_LABEL = 'ai-support-agent.rdp.project'
export const GUACD_LAYOUT_LABEL = 'ai-support-agent.rdp.layout'
/** 構成の版。引数の構成を変えたら上げ、古い構成のコンテナを作り直させる。 */
export const GUACD_PROJECT_LAYOUT = 'project-v1'
/**
 * Docker 形態の legacy fallback（プロジェクト 0 件）が起動する共有 guacd の印。
 * {@link removeLegacySharedGuacd} が稼働中の共有 guacd を旧版の残骸と誤認しないため。
 */
export const GUACD_SHARED_LAYOUT = 'shared-v1'
/** `docker exec`（標準バンドルの取り出し）の上限。固まった daemon で起動経路を止めない。 */
export const GUACD_EXEC_TIMEOUT_MS = 30_000

/** guacd イメージ（Alpine）の標準 CA バンドル。 */
const GUACD_IMAGE_SYSTEM_CA_PATH = '/etc/ssl/certs/ca-certificates.crt'
const GUACD_SSL_CERT_FILE_ENV = `SSL_CERT_FILE=${RDP_TRUSTED_CA_MOUNT_PATH}/${RDP_TRUSTED_CA_BUNDLE_FILE}`
/** `docker exec cat` の出力上限（標準バンドルは数百 KB）。 */
const SYSTEM_CA_MAX_BYTES = 16 * 1024 * 1024

/**
 * プロジェクトの guacd の名前を決める。
 *
 * ハッシュにするのは、`sanitizeNameSegment` 等で名前を組むと `a_b/C` と
 * `a/B_C` が同じ名前になるため（別プロジェクトの guacd を共有してしまう）。
 *
 * agentId も含める。同じホストで同じプロジェクトを別のエージェント（agentId
 * 違い）が動かすことがあり、名前が同じだと互いの guacd を構成違いとして
 * 作り直し（`rm -f`）合ってしまう。エージェントのコンテナ名
 * （`buildContainerName` の `ai-<tenant>-<project>-<agentId>`）と同じ単位にそろえる。
 */
export function resolveProjectGuacdIdentity(
  project: { tenantCode: string; projectCode: string },
  agentId: string | undefined,
  configDir: string = getConfigDir(),
): ProjectGuacdIdentity {
  const projectRef = `${project.tenantCode}/${project.projectCode}`
  const key = createHash('sha256')
    .update(`${projectRef}/${agentId ?? ''}`)
    .digest('hex')
    .slice(0, 16)
  return {
    key,
    containerName: `${GUACD_CONTAINER_NAME}-${key}`,
    networkName: `${GUACD_NETWORK_NAME}-${key}`,
    caHostDir: path.join(configDir, 'rdp-trusted-ca', key),
    projectRef,
  }
}

/** `docker inspect` の結果のうち、ここで見る部分。 */
interface InspectedContainer {
  State?: { Running?: boolean }
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null }
  Mounts?: { Source?: string; Destination?: string }[] | null
  HostConfig?: { PortBindings?: Record<string, unknown> | null }
  NetworkSettings?: { Networks?: Record<string, unknown> | null }
}

/**
 * @returns コンテナが無ければ `undefined`。出力が読めなければ `{}`
 *   （存在はするが構成不明＝作り直す側に倒す）
 */
function inspectContainer(name: string): InspectedContainer | undefined {
  let out: string
  try {
    out = execFileSync(getDockerPath(), ['inspect', '--format', '{{json .}}', name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
  try {
    return JSON.parse(out) as InspectedContainer
  } catch {
    return {}
  }
}

/**
 * プロジェクト別 guacd の状態。
 *
 * `match` だけが再利用してよい状態。稼働中でもラベル・信頼ストアの指定・
 * マウント元のどれかが違えば `mismatch`（古い版が起動したもの、別の設定
 * ディレクトリで起動したもの等）として作り直す。
 */
function projectGuacdState(
  id: ProjectGuacdIdentity,
): 'match' | 'mismatch' | 'stopped' | 'absent' {
  const container = inspectContainer(id.containerName)
  if (!container) return 'absent'
  if (container.State?.Running !== true) return 'stopped'
  const labels = container.Config?.Labels ?? {}
  const matches =
    labels[GUACD_PROJECT_LABEL] === id.projectRef &&
    labels[GUACD_LAYOUT_LABEL] === GUACD_PROJECT_LAYOUT &&
    (container.Config?.Env ?? []).includes(GUACD_SSL_CERT_FILE_ENV) &&
    (container.Mounts ?? []).some(
      (m) => m.Source === id.caHostDir && m.Destination === RDP_TRUSTED_CA_MOUNT_PATH,
    )
  return matches ? 'match' : 'mismatch'
}

/**
 * Docker 形態: プロジェクトの guacd が動いていることを保証し、接続先を返す。
 *
 * - 信頼ストアのディレクトリ（`caHostDir`）を**起動より先に** 0755 で作る。
 *   無いまま `-v` すると Docker が root 所有で作り、エージェント（ホストの uid）
 *   が書けなくなる。guacd は別 uid で読むため 0755 / ファイル 0644 にする。
 * - guacd には信頼ストアを `:ro` で見せる（書くのはエージェントだけ）。
 * - ポートは公開しない（プロジェクト専用ネットワーク内からのみ到達させる）。
 * - 別プロセスとの起動競合（name conflict）は {@link ensureGuacdContainer} と同じく、
 *   相手が同じ構成で稼働中なら採用する。
 *
 * @throws 起動に失敗した場合
 */
export function ensureProjectGuacdContainer(
  id: ProjectGuacdIdentity,
  image: string = DEFAULT_GUACD_IMAGE,
): GuacdEndpoint {
  const endpoint: GuacdEndpoint = { host: id.containerName, port: DEFAULT_GUACD_PORT }

  // caHostDir 自体がリンクなら、たどって chmod・マウントしない（下の注記）。
  if (entryExists(id.caHostDir)) assertRealDirectory(id.caHostDir)
  fs.mkdirSync(id.caHostDir, { recursive: true, mode: 0o755 })
  assertRealDirectory(id.caHostDir)
  fs.chmodSync(id.caHostDir, 0o755)

  const state = projectGuacdState(id)
  if (state === 'match') {
    logger.debug(`[guacd] Reusing the running container ${id.containerName}`)
    return endpoint
  }
  if (state !== 'absent') {
    // 停止済み・構成違いのどちらも、同名のまま `docker run --name` はできない。
    runDocker(['rm', '-f', id.containerName], {
      containerName: id.containerName,
      ignoreFailure: true,
    })
  }

  // 既にあれば失敗するが、それは正常な状態。
  runDocker(['network', 'create', id.networkName], {
    containerName: id.containerName,
    ignoreFailure: true,
  })

  let adopted = false
  runDocker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      id.containerName,
      '--network',
      id.networkName,
      '--label',
      `${GUACD_PROJECT_LABEL}=${id.projectRef}`,
      '--label',
      `${GUACD_LAYOUT_LABEL}=${GUACD_PROJECT_LAYOUT}`,
      '-e',
      GUACD_SSL_CERT_FILE_ENV,
      '-v',
      `${id.caHostDir}:${RDP_TRUSTED_CA_MOUNT_PATH}:ro`,
      image,
    ],
    {
      containerName: id.containerName,
      rescue: (err) => {
        if (!isNameConflictError(err, id.containerName)) return false
        adopted = projectGuacdState(id) === 'match'
        return adopted
      },
    },
  )

  if (adopted) {
    logger.info(`[guacd] Adopted ${id.containerName}, started by another process`)
  } else {
    logger.info(`[guacd] Started ${id.containerName} for ${id.projectRef} (${image})`)
  }
  return endpoint
}

/**
 * 稼働中の guacd から標準 CA バンドルを取り出し、`system-ca.pem` として置く。
 *
 * エージェントはこれに登録 CA を足して `bundle.pem` を作る。guacd イメージの
 * 版で中身が変わるため、guacd を用意するたびに取り直す。
 *
 * `bundle.pem` が無ければ同じ内容で作る。guacd は `SSL_CERT_FILE=bundle.pem`
 * で起動しており、エージェントが最初の接続で書くまでの間に存在しないファイルを
 * 指させないため。**既にあれば上書きしない**: プロジェクトコンテナの
 * エージェントが書いた登録 CA 入りの内容を消さないため（`link` で置くので、
 * 確認と作成の間に書かれても上書きしない）。
 *
 * @throws 取り出せない・証明書を含まない・書けない場合（呼び出し元は CA を
 *   申告しない形へ倒す）
 */
export function extractGuacdSystemCaBundle(id: ProjectGuacdIdentity): void {
  const bundle = execFileSync(
    getDockerPath(),
    ['exec', id.containerName, 'cat', GUACD_IMAGE_SYSTEM_CA_PATH],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: SYSTEM_CA_MAX_BYTES,
      timeout: GUACD_EXEC_TIMEOUT_MS,
    },
  )
  if (!bundle.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      `the system CA bundle of ${id.containerName} contains no certificates`,
    )
  }
  assertRealDirectory(id.caHostDir)
  const target = path.join(id.caHostDir, RDP_TRUSTED_CA_SYSTEM_FILE)
  // 共有ディレクトリの外（ホスト専用）で完成させてから rename で置く（下の注記）。
  const tmp = writeStagingFile(id, `${RDP_TRUSTED_CA_SYSTEM_FILE}.${process.pid}.tmp`, bundle)
  try {
    // rename は置き先がリンクでもたどらず、リンク自体を置き換える。
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  seedTrustStoreBundle(id, bundle)
}

/*
 * :::danger 共有ディレクトリのリンクをホスト側でたどらない
 * caHostDir はエージェントのコンテナへ :rw でマウントされる。コンテナ内の処理は
 * そこへ任意の名前のシンボリックリンクを置ける。ホストの監督プロセスがそれを
 * たどって書き込み・chmod すると、ホスト上の任意のファイルを書き換えられる
 * （コンテナ → ホストの書き込み昇格）。そのため:
 *
 * - 一時ファイルは共有ディレクトリではなく、コンテナにマウントしない
 *   `<configDir>/rdp-trusted-ca/.staging/<key>`（0700、同じファイルシステム）で
 *   作り、完成後に rename / link で共有ディレクトリへ置く。どちらも置き先の
 *   リンクをたどらない。
 * - 共有ディレクトリ内の既存エントリは lstat で見る（リンクをたどらない）。
 * - 削除（rm）はリンク自体を消し、リンク先をたどらない。
 * - caHostDir 自体はコンテナ内ではマウントポイントで差し替えられず、親
 *   （rdp-trusted-ca）はマウントしない。それでもリンクであれば使わない。
 * :::
 */

/** lstat で存在を見る（リンクはたどらない。壊れたリンクも「ある」）。 */
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** リンクではない実ディレクトリであることを確かめる。 */
function assertRealDirectory(dir: string): void {
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${dir} is not a directory (refusing to follow a link into the host)`)
  }
}

/** ホスト専用の一時ディレクトリ（コンテナにマウントしない）。 */
function stagingDirOf(id: ProjectGuacdIdentity): string {
  return path.join(path.dirname(id.caHostDir), '.staging', id.key)
}

/**
 * ホスト専用の一時ディレクトリにファイルを新規作成して書く（0644）。
 * `wx`（O_EXCL）で作るため、既存のものを上書きしない（前回の残骸は先に消す）。
 */
function writeStagingFile(id: ProjectGuacdIdentity, name: string, content: string): string {
  const dir = stagingDirOf(id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertRealDirectory(dir)
  fs.chmodSync(dir, 0o700)
  const tmp = path.join(dir, name)
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, content, { mode: 0o644, flag: 'wx' })
  fs.chmodSync(tmp, 0o644)
  return tmp
}

/** `bundle.pem` が無ければ標準バンドルで作る（あれば触れない。リンクでも触れない）。 */
function seedTrustStoreBundle(id: ProjectGuacdIdentity, content: string): void {
  const target = path.join(id.caHostDir, RDP_TRUSTED_CA_BUNDLE_FILE)
  if (entryExists(target)) return
  const tmp = writeStagingFile(id, `${RDP_TRUSTED_CA_BUNDLE_FILE}.${process.pid}.seed.tmp`, content)
  try {
    try {
      // link は既存のエントリ（リンクを含む）を置き換えず、たどりもしない
      // （先に書かれていれば EEXIST）。
      fs.linkSync(tmp, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * プロジェクトの信頼ストアの中身（`bundle.pem` と `system-ca.pem`）を消す。投げない。
 *
 * 標準バンドルを取り出せなかった回に使う（fail-closed）。その回はエージェントへ
 * 信頼ストアを渡さないため、以後に CA が削除されてもエージェントは `bundle.pem`
 * を書き直せない。稼働中の guacd は `SSL_CERT_FILE` で前回の登録 CA 入りの
 * `bundle.pem` を読み続けるので、残すと削除済みの CA で検証が通ってしまう。
 * 消しておけば guacd は登録 CA を一切信頼しない（公開 CA は OpenSSL の既定の
 * 証明書ディレクトリから引き続き読まれ得る）。
 *
 * @returns 消えたか（元から無い場合を含む）
 */
export function invalidateProjectTrustStore(id: ProjectGuacdIdentity): boolean {
  try {
    if (entryExists(id.caHostDir)) assertRealDirectory(id.caHostDir)
    // rm はリンクならリンク自体を消す（リンク先をたどらない）。
    for (const name of [RDP_TRUSTED_CA_BUNDLE_FILE, RDP_TRUSTED_CA_SYSTEM_FILE]) {
      fs.rmSync(path.join(id.caHostDir, name), { force: true })
    }
    return true
  } catch (err) {
    logger.warn(
      `[guacd] Could not invalidate the RDP trust store of ${id.projectRef} (${id.caHostDir}): ${String(err)}`,
    )
    return false
  }
}

/**
 * プロジェクトの guacd コンテナを止める。投げない。
 *
 * 止め損ねた事実は、どのプロジェクトのものか分かる形で warn に残す
 * （{@link stopGuacdContainer} と同じ理由）。ネットワークは
 * {@link removeProjectGuacdNetwork} で別に消す: エージェントのコンテナが
 * まだ接続している間は消せないため、呼び出し元がエージェントの停止後に行う。
 *
 * @returns 停止が完了したか（既に無い場合を含む）
 */
export function stopProjectGuacdContainer(id: ProjectGuacdIdentity): boolean {
  return runDocker(['stop', id.containerName], {
    containerName: id.containerName,
    ignoreFailure: true,
    absentIsSettled: true,
    failureMessage: `guacd container ${id.containerName} for ${id.projectRef} could not be stopped; it may still be running and accepting RDP connections`,
  })
}

/**
 * プロジェクトの guacd の専用ネットワークを消す。投げない。
 *
 * 失敗は debug に留め、`false` を返して呼び出し元に再試行を任せる。接続中の
 * コンテナが残っているときに起こり、待ち受けるものは何も無い。
 *
 * @returns 消えたか（既に無い場合を含む）
 */
export function removeProjectGuacdNetwork(id: ProjectGuacdIdentity): boolean {
  try {
    execFileSync(getDockerPath(), ['network', 'rm', id.networkName], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return true
  } catch (err) {
    if (/network\s+\S+\s+not found|no such network/i.test(dockerErrorText(err))) return true
    logger.debug(
      `[guacd] network ${id.networkName} for ${id.projectRef} could not be removed yet: ${String(err)}`,
    )
    return false
  }
}

/**
 * プロジェクトの信頼ストアのディレクトリ（`<configDir>/rdp-trusted-ca/<key>`）を消す。
 * 投げない。
 *
 * 再帰削除なので、消す前に**その形の場所であること**を確かめる（絶対パスで、
 * 末尾が key、その親が `rdp-trusted-ca`）。想定外なら消さずに warn を残す。
 *
 * @returns 消えたか（既に無い場合を含む）
 */
export function removeProjectTrustStore(id: ProjectGuacdIdentity): boolean {
  const dir = id.caHostDir
  const expected =
    path.isAbsolute(dir) &&
    /^[0-9a-f]{16}$/.test(id.key) &&
    path.basename(dir) === id.key &&
    path.basename(path.dirname(dir)) === 'rdp-trusted-ca'
  if (!expected) {
    logger.warn(
      `[guacd] Refusing to remove the RDP trust store of ${id.projectRef}: unexpected location ${dir}`,
    )
    return false
  }
  try {
    // caHostDir 自体がリンクなら消さない（たどった先を再帰削除しないため）。中の
    // リンクは fs.rm がリンク自体を消し、たどらない。
    if (entryExists(dir)) assertRealDirectory(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(stagingDirOf(id), { recursive: true, force: true })
    return true
  } catch (err) {
    logger.warn(
      `[guacd] Could not remove the RDP trust store of ${id.projectRef} (${dir}): ${String(err)}`,
    )
    return false
  }
}

/**
 * `ais-rdp` に接続している guacd 以外のコンテナ名。
 *
 * @returns 確かめられなければ `undefined`（呼び出し元は撤去しない側に倒す）
 */
function otherLegacyNetworkEndpoints(): string[] | undefined {
  let out: string
  try {
    out = execFileSync(
      getDockerPath(),
      ['network', 'inspect', '--format', '{{json .Containers}}', GUACD_NETWORK_NAME],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return undefined
  }
  let containers: Record<string, { Name?: string }> | null
  try {
    containers = JSON.parse(out) as Record<string, { Name?: string }> | null
  } catch {
    return undefined
  }
  return Object.values(containers ?? {})
    .map((c) => c.Name ?? '(unnamed)')
    .filter((name) => name !== GUACD_CONTAINER_NAME)
}

/**
 * 旧 Docker 形態の共有 guacd（`ais-guacd` on `ais-rdp`）を撤去する。
 *
 * プロジェクト別へ移行したあと、旧版が起動した共有 guacd は誰にも使われない
 * まま無認証で待ち受け続ける。撤去するのは**旧 Docker 形態の引数で起動された
 * もの**（`ais-rdp` に所属し、ポートを公開しておらず、現行の legacy fallback
 * が付ける `shared-v1` ラベルが無く、`ais-rdp` に guacd 以外が接続していない）
 * だけで、CLI 直起動
 * （`-p 127.0.0.1:4822:4822`、既定の bridge）の guacd は同じ名前でも残す。
 * ネットワーク形態の起動は同名コンテナを所属ネットワークの確認なしに再利用
 * していたため、名前だけで判定すると host 形態のものを止めてしまう。
 *
 * 投げない（プロジェクトの起動経路から呼ばれる）。
 */
export function removeLegacySharedGuacd(): void {
  const container = inspectContainer(GUACD_CONTAINER_NAME)
  if (container?.Config?.Labels?.[GUACD_LAYOUT_LABEL] === GUACD_SHARED_LAYOUT) {
    // 現行の legacy fallback（別プロセス）が使っている共有 guacd。残骸ではない。
    logger.debug(
      `[guacd] Leaving ${GUACD_CONTAINER_NAME} in place: it is the shared guacd of a running legacy fallback`,
    )
    return
  }
  if (container) {
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {})
    const bindings = Object.keys(container.HostConfig?.PortBindings ?? {})
    if (networks.includes(GUACD_NETWORK_NAME) && bindings.length === 0) {
      // 旧版のエージェントが別の設定ディレクトリ・別ユーザーでまだ動いていれば、
      // この guacd を使っている（ais-rdp に接続している）。guacd 以外の接続が
      // 無いと確かめられたときだけ撤去する。
      // 受容済みの競合（TOCTOU）: この確認と下の rm -f の間に旧版のエージェントが
      // 接続し得る。旧版と新版を同時に起動したときに限られるため受容している。
      const others = otherLegacyNetworkEndpoints()
      if (others === undefined) {
        logger.info(
          `[guacd] Leaving the legacy shared guacd ${GUACD_CONTAINER_NAME} in place: could not confirm ` +
            `that nothing else is connected to ${GUACD_NETWORK_NAME}`,
        )
        return
      }
      if (others.length > 0) {
        logger.info(
          `[guacd] Leaving the legacy shared guacd ${GUACD_CONTAINER_NAME} in place: ` +
            `${others.join(', ')} still connected to ${GUACD_NETWORK_NAME} (an older agent may be using it)`,
        )
        return
      }
      const removed = runDocker(['rm', '-f', GUACD_CONTAINER_NAME], {
        ignoreFailure: true,
        failureMessage: `legacy shared guacd container ${GUACD_CONTAINER_NAME} could not be removed; it may still be running and accepting RDP connections`,
      })
      if (removed) {
        logger.info(
          `[guacd] Removed the legacy shared guacd container ${GUACD_CONTAINER_NAME} (guacd now runs per project)`,
        )
        // 撤去したときだけネットワークも消す。コンテナが無いだけで消すと、
        // 別プロセスの legacy fallback が network create と docker run の間にいる
        // ときにネットワークを奪ってしまう。旧エージェントのコンテナがまだ接続して
        // いれば失敗する（debug に留める）。
        runDocker(['network', 'rm', GUACD_NETWORK_NAME], { ignoreFailure: true })
      }
    } else {
      logger.debug(
        `[guacd] Leaving ${GUACD_CONTAINER_NAME} in place: it is not a legacy Docker-form guacd`,
      )
    }
  }
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
 * {@link ensureGuacdContainer} (and {@link ensureProjectGuacdContainer}, which
 * rescues the same way). docker words it "Conflict. The container name
 * "/ais-guacd" is already in use by container "<id>"", and puts it on stderr,
 * so the message alone says only that the command failed.
 *
 * Matching on the message follows {@link isAbsentContainerError}: an
 * unrecognised wording degrades to "failed", which throws — the previous
 * behaviour, and the safe direction, because a swallowed real failure hands the
 * caller an endpoint nothing is listening on. The *name* has to match for the
 * same reason it does there: a conflict on some other container (say a
 * differently named sidecar) says nothing about ours, and the boundary after
 * the name keeps `ais-guacd` from matching a project's `ais-guacd-<key>` or
 * `ais-guacd-sidecar`.
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
    /** The container the command is about (default {@link GUACD_CONTAINER_NAME}). */
    containerName?: string
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
    const containerName = opts.containerName ?? GUACD_CONTAINER_NAME
    if (
      opts.absentIsSettled &&
      isAbsentContainerError(err, containerName)
    ) {
      logger.debug(
        `[guacd] container ${containerName} is already gone; nothing to stop`,
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
