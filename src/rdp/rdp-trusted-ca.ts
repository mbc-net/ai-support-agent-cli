import { randomBytes, X509Certificate } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { detectAgentRuntime } from '../capability/capability-plan'
import { ENV_VARS } from '../constants'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'

/**
 * guacd の信頼ストアへ、プロジェクトに登録された社内 CA を反映する。
 *
 * guacd（FreeRDP 2 / OpenSSL 1.1）は `SSL_CERT_FILE` で指定されたバンドルを
 * 信頼ストアとして読む。生成されるマニフェストと Docker 形態の起動引数は、
 * guacd を `SSL_CERT_FILE=/run/ais-rdp-ca/bundle.pem` で起動し、同じ
 * ディレクトリをエージェントにも見せる（`AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR`）。
 *
 * - `system-ca.pem` — 標準 CA バンドル。K8s / ECS ではエージェントが起動時に自分の
 *   イメージのものを置き（`prepareRdpTrustedCaStore`）、Docker 形態ではホストの
 *   スーパーバイザが guacd イメージから取り出して置く。guacd 自身は読むだけ。
 *   guacd 側が差し替え得るものとして読む（`readSystemBundle`）
 * - `bundle.pem` — 標準バンドル＋登録 CA。`rdp_open` のたびにエージェントが
 *   同じディレクトリの一時ファイル経由で **rename により原子的に**置き換える
 *   （guacd が書きかけのファイルを読むことが無いように）
 *
 * :::note host 形態は対象外
 * CLI 直起動では guacd の起動方法を agent が握っていないため申告しない
 * （`rdp-tunnel-support.ts` の方針と同じ）。
 * :::
 */

/** guacd とエージェントの双方がこのディレクトリを見る（コンテナ内パス）。 */
export const RDP_TRUSTED_CA_MOUNT_PATH = '/run/ais-rdp-ca'
/** guacd イメージの標準バンドルの写し。 */
export const RDP_TRUSTED_CA_SYSTEM_FILE = 'system-ca.pem'
/** guacd の `SSL_CERT_FILE` が指すファイル。 */
export const RDP_TRUSTED_CA_BUNDLE_FILE = 'bundle.pem'
/** 1 プロジェクトに登録できる CA の上限（API と同じ値）。 */
export const RDP_TRUSTED_CA_MAX_COUNT = 10
/** 1 件の PEM の最大長（API と同じ値）。 */
export const RDP_TRUSTED_CA_PEM_MAX_LENGTH = 16384
/**
 * 標準バンドル（`system-ca.pem`）として読む大きさの上限。guacd:1.5.5 の実物は
 * 約 220 KB（147 件）。桁違いに大きいものは標準バンドルではない。
 */
export const RDP_TRUSTED_CA_SYSTEM_MAX_BYTES = 4 * 1024 * 1024

const PEM_BLOCK_PATTERN = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g

/**
 * 信頼ストアのディレクトリ。使えないときは `undefined`（`rdpTrustedCa` を
 * 申告せず、CA 付きの `rdp_open` を断る）。
 *
 * `system-ca.pem` が無いディレクトリも使えないものとして扱う: 標準バンドル
 * 抜きの `bundle.pem` を書くと、公開 CA の証明書まで検証に失敗するようになる。
 */
export function resolveRdpTrustedCaDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = configuredRdpTrustedCaDir(env)
  if (!configured) return undefined
  if (!fs.existsSync(path.join(configured, RDP_TRUSTED_CA_SYSTEM_FILE))) return undefined
  return configured
}

/**
 * 信頼ストアとして設定されたディレクトリ（`system-ca.pem` の有無は問わない）。
 *
 * 設定済みなのに標準バンドルが使えない（欠落・破損）ときに、前回の登録 CA 入りの
 * `bundle.pem` を片付けるために使う。非対応形態（未設定・相対パス・host 形態）は
 * `undefined`。
 */
export function configuredRdpTrustedCaDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dir = env[ENV_VARS.RDP_TRUSTED_CA_DIR]
  if (!dir || !path.isAbsolute(dir)) return undefined
  if (detectAgentRuntime(env) === 'host') return undefined
  return dir
}

/**
 * `rdp_open.trustedCaCertificates` の検証。
 *
 * API 側でも同じ検証をしているが、エージェントは受け取った値を信頼しない。
 * エラー文言は API 経由でブラウザへ届くため、**入力の中身を載せない**。
 *
 * @returns 各 CA を `X509Certificate#toString()` で正規化した PEM
 */
export function parseTrustedCaCertificates(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error('trustedCaCertificates must be an array')
  }
  if (raw.length > RDP_TRUSTED_CA_MAX_COUNT) {
    throw new Error(`trustedCaCertificates must have at most ${RDP_TRUSTED_CA_MAX_COUNT} entries`)
  }
  return raw.map((value: unknown, index) => {
    const name = `trustedCaCertificates[${index}]`
    if (typeof value !== 'string') throw new Error(`${name} must be a string`)
    if (value.length > RDP_TRUSTED_CA_PEM_MAX_LENGTH) {
      throw new Error(`${name} is longer than ${RDP_TRUSTED_CA_PEM_MAX_LENGTH} characters`)
    }
    const blocks = [...value.matchAll(PEM_BLOCK_PATTERN)]
    if (blocks.length !== 1 || blocks[0][1] !== 'CERTIFICATE') {
      throw new Error(`${name} must contain exactly one CERTIFICATE block`)
    }
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(blocks[0][0])
    } catch {
      throw new Error(`${name} is not a valid X.509 certificate`)
    }
    if (!certificate.ca) throw new Error(`${name} is not a CA certificate`)
    return certificate.toString()
  })
}

/**
 * `bundle.pem` の書き換え。
 *
 * 同期処理にしているのは、`rdp_open` の受付（guacd へ接続する前）で完了して
 * いなければならないため。ロックは取らない: 同じディレクトリを使うのは同じ
 * プロジェクトのセッションだけで、書く内容は同じプロジェクト設定から来る。
 * rename は原子的なので、並行して書かれても guacd が読むのは常にどちらかの完全な版である。
 */
export class RdpTrustedCaStore {
  constructor(
    private readonly resolveDir: () => string | undefined = () => resolveRdpTrustedCaDir(),
    /** 設定済みの信頼ストア（標準バンドルの有無を問わない）。古い bundle.pem の片付け用。 */
    private readonly configuredDir: () => string | undefined = () => configuredRdpTrustedCaDir(),
  ) {}

  /**
   * @throws Error — 理由コード（`rdp_trusted_ca_invalid|unsupported|unavailable`）
   *   で始まる文言。API はこの接頭辞で利用者向けの固定文言を引く。
   */
  apply(raw: unknown): void {
    let pems: string[]
    try {
      pems = parseTrustedCaCertificates(raw)
    } catch (error) {
      throw new Error(`rdp_trusted_ca_invalid: ${getErrorMessage(error)}`)
    }

    const dir = this.resolveDir()
    if (!dir) {
      // 設定済みなのに標準バンドルが無い。前回の bundle.pem が残っていれば guacd は
      // それ（登録 CA 入りかもしれない）を読み続けるので、消してから判断する。
      const configured = this.configuredDir()
      if (configured) removeStaleBundle(configured)
      if (pems.length === 0) return
      throw new Error(
        'rdp_trusted_ca_unsupported: this agent has no trust store shared with guacd ' +
          '(update the agent and regenerate the manifest or recreate the container)',
      )
    }

    let system: string
    try {
      system = readSystemBundle(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE))
    } catch (error) {
      // 標準バンドルが壊れている。古い bundle.pem を残さない（上と同じ理由）。
      // 片付けにも失敗したときは、元の理由（壊れている・大きすぎる等）も併せて伝える。
      const reason = `could not prepare the trust store: ${getErrorMessage(error)}`
      removeStaleBundle(dir, reason)
      throw new Error(`rdp_trusted_ca_unavailable: ${reason}`, { cause: error })
    }
    try {
      const parts = [system, ...pems].map((part) => (part.endsWith('\n') ? part : `${part}\n`))
      writeTrustStoreFile(dir, RDP_TRUSTED_CA_BUNDLE_FILE, parts.join(''), 'replace')
    } catch (error) {
      throw new Error(
        `rdp_trusted_ca_unavailable: could not prepare the trust store: ${getErrorMessage(error)}`,
      )
    }
  }
}

/**
 * 前回の `bundle.pem` を消す（リンクならリンク自体を消し、たどらない）。
 *
 * 標準バンドルが使えず新しい `bundle.pem` を作れないときに使う。残すと guacd が
 * 前回の登録 CA 入りのバンドルを読み続け、削除済みの CA を信頼し得る。消せなければ
 * 信頼し得る状態を残したまま進めないよう、rdp_trusted_ca_unavailable で断る。
 */
function removeStaleBundle(dir: string, precedingFailure?: string): void {
  try {
    fs.rmSync(path.join(dir, RDP_TRUSTED_CA_BUNDLE_FILE), { force: true })
  } catch (error) {
    const removal = `could not remove the previous trust store: ${getErrorMessage(error)}`
    throw new Error(
      `rdp_trusted_ca_unavailable: ${precedingFailure ? `${precedingFailure}; and ` : ''}${removal}`,
      { cause: error },
    )
  }
}

/**
 * 標準バンドル（`system-ca.pem`）を読む。
 *
 * :::danger guacd 側が差し替え得るものとして扱う
 * このファイルは guacd と共有するボリュームにある。生成するマニフェストでは guacd
 * に読み取り専用でしか見せないが、エージェントはそれに頼らない。guacd が乗っ取られ
 * これを `/proc/self/environ` などへのリンクに差し替えると、読んだ内容はそのまま
 * guacd が読む `bundle.pem` に写り、エージェントの環境変数（トークン）が漏れる。
 * そのため:
 *
 * - `O_NOFOLLOW` で開く（リンクなら開かない）。
 * - 開いたものを fstat で確かめる（通常ファイルであること、大きさの上限）。
 * - 中身が CERTIFICATE ブロックだけ（と空行）で構成されていることを確かめる。
 * :::
 *
 * @throws 満たさない場合（呼び出し元は rdp_trusted_ca_unavailable で断る）
 */
function readSystemBundle(file: string): string {
  return readCertificateBundle(file, { followLinks: false })
}

/**
 * 証明書だけの PEM バンドルを読む（通常ファイル・大きさの上限・中身の検証）。
 *
 * `followLinks: false` は `O_NOFOLLOW` で開く（共有ディレクトリの `system-ca.pem`）。
 * エージェント自身のイメージの標準バンドル（{@link AGENT_SYSTEM_CA_BUNDLE_PATH}）は
 * ディストリビューションによってはリンクなので、たどってよい（中身は同じく検証する）。
 */
function readCertificateBundle(file: string, options: { followLinks: boolean }): string {
  const label = path.basename(file)
  const flags = fs.constants.O_RDONLY | (options.followLinks ? 0 : fs.constants.O_NOFOLLOW)
  const fd = fs.openSync(file, flags)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`)
    if (stat.size > RDP_TRUSTED_CA_SYSTEM_MAX_BYTES) {
      throw new Error(`${label} is too large (${stat.size} bytes)`)
    }
    const content = fs.readFileSync(fd, 'utf8')
    assertCertificatesOnly(content, label)
    return content
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 共有ディレクトリにファイルを置く（0644）。
 *
 * 予測できない名前の一時ファイルを `wx`（O_EXCL）で作り、fd に対して書き込み・
 * chmod してから置く。一時ファイル名に先置きされたリンクがあっても、たどらずに
 * 失敗する。
 *
 * - `replace`: rename で置き換える（置き先がリンクでもたどらず、リンク自体を置き換える）。
 * - `create`: 既にあれば触れない。link で置く（既存のエントリを置き換えず、たどらない）。
 */
function writeTrustStoreFile(
  dir: string,
  name: string,
  content: string,
  mode: 'replace' | 'create',
): void {
  const target = path.join(dir, name)
  if (mode === 'create' && lstatExists(target)) return
  const tmp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o644)
  try {
    try {
      fs.writeFileSync(fd, content)
      // umask が 0644 を削ることがあるため揃える（guacd は別 uid で読む）。fd に対して行う。
      fs.fchmodSync(fd, 0o644)
    } finally {
      fs.closeSync(fd)
    }
    if (mode === 'replace') {
      fs.renameSync(tmp, target)
      return
    }
    try {
      fs.linkSync(tmp, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    fs.rmSync(tmp, { force: true })
  } catch (error) {
    // 自分で作った一時ファイルだけを消す（rename 済みなら無い）。
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/** lstat で存在を見る（リンクはたどらない。壊れたリンクも「ある」）。 */
function lstatExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * エージェントのイメージの標準 CA バンドル（node:24-slim ＋ Debian の
 * ca-certificates。docker/Dockerfile の apt install で入る）。
 */
export const AGENT_SYSTEM_CA_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt'

/**
 * K8s / ECS（サイドカー構成）: エージェント自身が起動時に信頼ストアを用意する。
 *
 * 自イメージの標準 CA バンドルを検証して `system-ca.pem` として置き、`bundle.pem`
 * が無ければ同じ内容で作る（guacd の `SSL_CERT_FILE` が存在しないファイルを指す
 * 時間帯を作らない）。能力（`rdpTrustedCa`）を申告する前、ワーカーを起動する前に
 * 呼ぶ（`startAgent`）。
 *
 * 以前は guacd イメージの初期化コンテナが置いていたが、そのイメージが取得できない
 * だけでエージェントまで起動しなくなる（RDP の付加機能で本体を巻き添えにする）
 * ため、エージェント自身で行う。**標準バンドルの出どころはエージェントの
 * イメージ**である（公開 CA の検証に使う束も、エージェントのイメージのもの）。
 *
 * 権限: K8s は emptyDir（0777）にエージェントが書き、guacd（UID 1000）が読む。
 * ECS は bind mount（root:root 0755）に root のエージェントが書き、guacd が読む。
 * どちらもファイルは 0644 なので guacd から読める。guacd は読み取り専用でマウントする。
 *
 * 置けなければ（標準バンドルが無い・不正・書けない）、前回の `system-ca.pem` と
 * `bundle.pem` も消して warn を残す。`system-ca.pem` が無いので `rdpTrustedCa` は
 * 申告されず、登録 CA が要る接続は理由付きで断られる（fail-closed）。投げない。
 *
 * Docker 形態はホストのスーパーバイザが guacd から取り出して置くので対象外。
 *
 * @returns 置いたか（対象外の形態では false）
 */
export function prepareRdpTrustedCaStore(
  env: NodeJS.ProcessEnv = process.env,
  source: string = AGENT_SYSTEM_CA_BUNDLE_PATH,
): boolean {
  const dir = configuredRdpTrustedCaDir(env)
  const runtime = detectAgentRuntime(env)
  if (!dir || (runtime !== 'k8s' && runtime !== 'ecs')) return false
  try {
    const bundle = readCertificateBundle(source, { followLinks: true })
    writeTrustStoreFile(dir, RDP_TRUSTED_CA_SYSTEM_FILE, bundle, 'replace')
    writeTrustStoreFile(dir, RDP_TRUSTED_CA_BUNDLE_FILE, bundle, 'create')
    return true
  } catch (error) {
    for (const name of [RDP_TRUSTED_CA_SYSTEM_FILE, RDP_TRUSTED_CA_BUNDLE_FILE]) {
      try {
        // リンクならリンク自体を消す（たどらない）。
        fs.rmSync(path.join(dir, name), { force: true })
      } catch {
        // 消せなくても続ける（system-ca.pem が残るのは、下の warn で知らせる）。
      }
    }
    logger.warn(
      `[rdp] Registered RDP CAs are unavailable: could not place the system CA bundle into ` +
        `${dir}: ${getErrorMessage(error)}. ` +
        // guacd の SSL_CERT_FILE は bundle.pem 固定。bundle.pem が無いと、登録 CA が
        // 0 件でも検証を有効にした接続は公開 CA の証明書でも失敗し得る。
        'RDP connections without certificate verification are unaffected; connections with ' +
        'certificate verification enabled (including ones needing a registered CA) may fail ' +
        'until the agent restarts with a valid CA bundle.',
    )
    return false
  }
}

const PEM_BASE64_LINE = /^[A-Za-z0-9+/=]+$/
const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const CERT_END = '-----END CERTIFICATE-----'

/**
 * CERTIFICATE ブロック（1 件以上）と、ブロックの間の空行だけで構成されていること。
 * エラー文言に中身を載せない。
 */
function assertCertificatesOnly(content: string, label: string): void {
  const invalid = (): Error => new Error(`${label} is not a PEM bundle of certificates only`)
  let inside = false
  let bodyLines = 0
  let blocks = 0
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!inside) {
      if (line === '') continue
      if (line !== CERT_BEGIN) throw invalid()
      inside = true
      bodyLines = 0
    } else if (line === CERT_END) {
      if (bodyLines === 0) throw invalid()
      inside = false
      blocks += 1
    } else if (PEM_BASE64_LINE.test(line)) {
      bodyLines += 1
    } else {
      throw invalid()
    }
  }
  if (inside || blocks === 0) throw invalid()
}
