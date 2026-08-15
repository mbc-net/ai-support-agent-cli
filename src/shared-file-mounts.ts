/**
 * 共有ファイルをエージェント内へ配置する。
 *
 * Docker イメージだけでは賄えないプロジェクト固有のデータ・認証情報を、エージェント
 * （Kubernetes の Pod を含む）内の指定パスへ置くための仕組み。設定は api から
 * `ProjectConfigResponse.sharedFileMounts` として配信され、起動時・設定変更時に適用する。
 * Pod が作り直されても起動時に再配置されるため、`kubectl cp` のような手動投入と違い消えない。
 *
 * **api 側でも保存時に検証しているが、ここでも再検証する。** api を経由しない経路・改ざん・
 * 古い api ビルドを想定した二重防御であり、加えて「エージェント自身の設定ディレクトリ」は
 * 実行環境ごとに異なり api からは判定できないため、その禁止はこちら側の責務になる。
 */
import { createHash, randomBytes } from 'crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'

import { logger } from './logger'
import { atomicWriteJson } from './utils'

/**
 * 配置先として許すルート。**allowlist 方式**（api の同名の一覧と必ず揃えること）。
 *
 * エージェントは root で動作するため、危険な場所を数え上げて塞ぐ方式では守り切れない。
 * 置いてよい場所を列挙し、それ以外はすべて拒否する。
 */
const ALLOWED_DESTINATION_PREFIXES: readonly string[] = [
  '/root/',
  '/home/',
  '/data/',
  '/opt/',
  '/srv/',
  '/tmp/',
  '/usr/local/share/',
]

/** 許可ルート配下でも拒否するセグメント（`authorized_keys` の設置を防ぐ） */
const FORBIDDEN_SEGMENTS: readonly string[] = ['.ssh']

/** 既定のパーミッション。秘密情報を含み得るため最小権限にする。 */
const DEFAULT_MODE = 0o600

const MODE_PATTERN = /^0[0-7]{3}$/

export interface SharedFileMount {
  sourcePath: string
  destPath: string
  mode?: string
}

export interface SharedFileMountResult {
  destPath: string
  status: 'applied' | 'skipped' | 'failed' | 'removed'
  error?: string
}

export interface SharedFileMountDeps {
  /** 共有ファイルを取り寄せて指定パスへ書き出す（api クライアント経由） */
  downloadToFile: (sourcePath: string, destination: string) => Promise<void>
  /** エージェント自身の設定ディレクトリ（配置先として禁止する） */
  configDir: string
}

/**
 * 配置先パスが安全かを判定する。
 *
 * 規則は api 側の `assertSafeMountDestination` と同一に保つこと（片方だけ緩めると、
 * 保存できるのに適用されない、または逆の非対称が生じる）。加えてエージェント自身の
 * 設定ディレクトリ配下を禁止する。
 */
export function isSafeMountDestination(destPath: string, configDir: string): boolean {
  if (typeof destPath !== 'string') return false
  // **前後の空白を落として判定しない。** 落とすと「検証した文字列」と「実際に
  // 書き込む文字列」がずれ、先頭に空白が付いた絶対パスが検証を通ったあと、
  // fs 層では相対パスとして解決されてしまう。
  if (destPath !== destPath.trim()) return false
  const value = destPath

  if (value.length === 0) return false
  // NUL・制御文字はファイル名として扱えず、経路によって解釈も割れる。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  if (!value.startsWith('/')) return false
  // 正規形でない表記（`/etc/./passwd`・`//etc/passwd`）は、OS では禁止対象と同じ
  // ファイルに解決されるのに文字列比較をすり抜ける。api 側と同じく正規形のみ受ける。
  if (path.posix.normalize(value) !== value) return false
  if (value === '/') return false
  if (value.endsWith('/')) return false
  // `..foo` のような正当な名前は通す必要があるため、セグメント単位で比較する。
  if (value.split('/').some((segment) => segment === '..')) return false
  if (!ALLOWED_DESTINATION_PREFIXES.some((prefix) => value.startsWith(prefix))) return false
  if (value.split('/').some((segment) => FORBIDDEN_SEGMENTS.includes(segment))) return false

  // エージェント自身の設定・トークンを上書きさせない。名前が前方一致するだけの
  // 別ディレクトリ（`...-backup`）は誤って禁止しないよう、区切り記号まで含めて比較する。
  const normalizedConfigDir = resolveConfigDir(configDir)
  const normalized = path.resolve(value)
  if (normalized === normalizedConfigDir) return false
  if (normalized.startsWith(`${normalizedConfigDir}${path.sep}`)) return false

  return true
}

function parseMode(mode: string | undefined): number {
  if (mode === undefined || !MODE_PATTERN.test(mode)) return DEFAULT_MODE
  return parseInt(mode, 8)
}

async function sha256OfFile(filePath: string): Promise<string | undefined> {
  // 取得経路が数百MB を想定してストリーミングしているのに、比較用のハッシュだけ
  // 全量をメモリへ載せると、そこが上限になってしまう（同期処理のため
  // イベントループも止まる）。ここもストリームで計算する。
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(filePath), hash)
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

/** 配置の記録 1 件（自分が置いたものだけを後始末するために持つ） */
interface PlacedMount {
  destPath: string
  /** 配置した時点の内容のハッシュ。第三者による更新を見分けるために使う。 */
  hash: string
}

/** 配置の記録の保存先（エージェントの設定ディレクトリ内） */
function manifestPath(configDir: string): string {
  return path.join(configDir, 'shared-file-mounts.json')
}

/** 記録の読み込み結果。**「記録が無い」と「壊れて読めない」を必ず区別する。** */
interface LoadedManifest {
  mounts: PlacedMount[]
  /** 記録はあるが読めなかった（＝過去の配置を追跡できない） */
  corrupted: boolean
}

function loadManifest(configDir: string): LoadedManifest {
  const file = manifestPath(configDir)
  if (!existsSync(file)) return { mounts: [], corrupted: false }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed?.mounts)) {
      logger.error(`[shared-file] manifest has unexpected shape: ${file}`)
      return { mounts: [], corrupted: true }
    }
    return {
      mounts: parsed.mounts.filter(
        (entry: unknown): entry is PlacedMount =>
          typeof (entry as PlacedMount)?.destPath === 'string' &&
          typeof (entry as PlacedMount)?.hash === 'string',
      ),
      corrupted: false,
    }
  } catch (error) {
    // 壊れているのに「何も置いていない」とみなすと、過去に置いた認証情報を
    // 二度と後始末できなくなる。読めなかったことを呼び出し側へ伝える。
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[shared-file] failed to read manifest (${file}): ${message}`)
    return { mounts: [], corrupted: true }
  }
}

/**
 * 記録を保存する。失敗した場合は理由を返す（呼び出し側が結果として報告する）。
 *
 * **一時ファイル + rename で書く。** 直接上書きすると、書き込み途中で強制終了した
 * ときに記録が壊れ（過去の配置を追跡できなくなる）、記録ファイルがリンクへ
 * 差し替えられていた場合はリンク先を破壊してしまう。`writeFileSync` の `mode` は
 * 新規作成時にしか効かないため、権限も保証されない。
 */
function saveManifest(
  configDir: string,
  mounts: PlacedMount[],
): string | undefined {
  try {
    mkdirSync(configDir, { recursive: true })
    atomicWriteJson(manifestPath(configDir), { mounts }, 0o600)
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`[shared-file] failed to save manifest: ${message}`)
    return message
  }
}

/**
 * 設定から外れた配置先を削除する。
 *
 * 置きっぱなしにすると、漏洩に気づいて設定を消しても認証情報がエージェント内に残り、
 * 失効・ローテーションが実効的に機能しない（`/data` は PVC のため Pod を作り直しても
 * 消えない）。ただし**自分が置いたまま変わっていないものだけ**を消す。
 *
 * - 記録に無いファイルには触れない
 * - 内容が記録時と違うものは、第三者が更新したものとみなして消さずに報告する
 * - **記録の内容も削除前に検証する**（記録はただのファイルであり、書き換えられた場合に
 *   任意のファイルを root 権限で消せる経路になってはならない）
 *
 * 検証・ハッシュ確認から `rmSync` までの間に配置先が差し替えられる余地は残る
 * （Node からはディレクトリ FD 基準の操作ができない）。`rmSync` はリンクを辿らず
 * リンク自体を消すため、これによって許可範囲外のファイルが消えることはない。
 */
async function removeStaleMounts(
  recorded: PlacedMount[],
  keepDestPaths: Set<string>,
  deps: SharedFileMountDeps,
): Promise<{ results: SharedFileMountResult[]; remaining: PlacedMount[] }> {
  const results: SharedFileMountResult[] = []
  const remaining: PlacedMount[] = []

  for (const placed of recorded) {
    if (keepDestPaths.has(placed.destPath)) continue

    const destPath = placed.destPath
    try {
      if (
        !isSafeMountDestination(destPath, deps.configDir) ||
        findUnsafeSymlink(destPath, deps.configDir)
      ) {
        logger.error(`[shared-file] refused to remove unsafe path: ${destPath}`)
        results.push({
          destPath,
          status: 'failed',
          error: `削除先として許可されていないパスのため削除しませんでした: ${destPath}`,
        })
        // 記録は残す。消してしまうと、警告が次回以降出なくなり放置される。
        remaining.push(placed)
        continue
      }

      if (!existsSync(destPath)) continue

      const currentHash = await sha256OfFile(destPath)
      if (currentHash !== placed.hash) {
        results.push({
          destPath,
          status: 'failed',
          error:
            '配置後に内容が変更されているため削除しませんでした（手動で削除してください）',
        })
        remaining.push(placed)
        continue
      }

      rmSync(destPath, { force: true })
      logger.info(`[shared-file] removed ${destPath}`)
      results.push({ destPath, status: 'removed' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`[shared-file] failed to remove ${destPath}: ${message}`)
      results.push({ destPath, status: 'failed', error: message })
      remaining.push(placed)
    }
  }

  return { results, remaining }
}

/**
 * 設定に従って共有ファイルを配置する。
 *
 * 1 件の失敗で他の配置を止めない（部分失敗も結果として返し、呼び出し側が可視化する）。
 * **例外は投げない**。配置できなくてもエージェント自体は起動させ、チャット等の他機能を
 * 巻き添えにしないため（失敗は握り潰さず、戻り値で必ず報告する）。
 */
/**
 * 直前の実行が終わるまで待つための鎖。
 *
 * 設定同期はデバウンス経由の呼び出しと WebSocket の通知による即時呼び出しの
 * 両方から起動されるため、重なると記録（manifest）の読み書きが競合し、
 * 「置いたのに記録されない」＝後始末できないファイルが生まれる。
 */
let applyChain: Promise<unknown> = Promise.resolve()

export function applySharedFileMounts(
  mounts: SharedFileMount[] | undefined,
  deps: SharedFileMountDeps,
): Promise<SharedFileMountResult[]> {
  const next = applyChain.then(() => applySharedFileMountsInternal(mounts, deps))
  // 失敗しても鎖を切らない（次の呼び出しが永久に待たされないようにする）。
  applyChain = next.catch(() => undefined)
  return next
}

async function applySharedFileMountsInternal(
  mounts: SharedFileMount[] | undefined,
  deps: SharedFileMountDeps,
): Promise<SharedFileMountResult[]> {
  // **`undefined` は「設定が空」ではなく「今回は分からない」を意味する。**
  // 設定取得に失敗してキャッシュへ退避した場合・機能判定が一時的に失敗した場合・
  // 古い api と通信している場合に起こる。この状態で後始末をすると、単なる通信障害で
  // 動いていた認証情報を消してしまうため、削除は行わない（配置も対象が無いので行わない）。
  const authoritative = mounts !== undefined
  const targets = mounts ?? []
  const results: SharedFileMountResult[] = []
  const manifest = loadManifest(deps.configDir)
  const recordedDestPaths = new Set(
    manifest.mounts.map((entry) => entry.destPath),
  )
  /** 今回の設定で「置いた（置いてある）」と確認できたもの。次回の後始末の基準になる。 */
  const placed: PlacedMount[] = []

  for (const mount of targets) {
    const destPath = mount?.destPath ?? ''
    let tmpPath: string | undefined
    try {
      if (!isSafeMountDestination(destPath, deps.configDir)) {
        results.push({
          destPath,
          status: 'failed',
          error: `配置先として許可されていないパスです: ${destPath}`,
        })
        continue
      }

      // **シンボリックリンクを拒否する。** 文字列としてのパスが安全でも、そこに
      // リンクが置かれていれば copy/write はリンク先を書き換えてしまう
      // （root 実行のため任意ファイルの上書きになり得る）。配置先自身と、
      // 親ディレクトリのいずれもリンクでないことを確認する。
      const symlinkError = findUnsafeSymlink(destPath, deps.configDir)
      if (symlinkError) {
        results.push({ destPath, status: 'failed', error: symlinkError })
        continue
      }

      const destDir = path.dirname(destPath)
      // 秘密情報の置き場になるため 0700 で作る（既存ディレクトリの権限は変えない）。
      mkdirSync(destDir, { recursive: true, mode: 0o700 })

      // 一時ファイルは**配置先と同じディレクトリ**に、呼び出しごとに一意な名前で作る。
      // /tmp の共有領域に予測可能な名前で置くと、先回りしてリンクを仕込まれる
      // （root 権限で任意ファイルへ書かれる）。同一ディレクトリなら rename が
      // 原子的に行え、途中状態が配置先に見えることもない。
      tmpPath = path.join(destDir, `.shared-file-mount-${randomBytes(12).toString('hex')}.tmp`)

      await deps.downloadToFile(mount.sourcePath, tmpPath)

      const desiredMode = parseMode(mount.mode)
      const nextHash = await sha256OfFile(tmpPath)
      const currentHash = existsSync(destPath)
        ? await sha256OfFile(destPath)
        : undefined
      if (nextHash !== undefined && nextHash === currentHash) {
        // 既に同じ内容のファイルがある。**記録に無いものは自分が置いたとみなさない**
        // （第三者が用意したファイルとたまたま一致しただけの可能性があり、
        // 後で設定から外れたときにそれを消してしまう）。
        if (recordedDestPaths.has(destPath)) {
          placed.push({ destPath, hash: nextHash })
        }
        // 内容が同じでも権限が違えば直す。mode だけ厳しくした設定変更が
        // 反映されないと、秘密情報が緩い権限のまま残る。
        const currentMode = statSync(destPath).mode & 0o777
        if (currentMode !== desiredMode) {
          chmodSync(destPath, desiredMode)
          results.push({ destPath, status: 'applied' })
        } else {
          results.push({ destPath, status: 'skipped' })
        }
        continue
      }

      chmodSync(tmpPath, desiredMode)
      // rename はシンボリックリンクを辿らず、リンクそのものを置き換える。
      // copy と違い、途中まで書かれたファイルが見えることもない。
      renameSync(tmpPath, destPath)
      tmpPath = undefined

      logger.info(
        `[shared-file] placed ${mount.sourcePath} -> ${destPath} (${statSync(destPath).size} bytes)`,
      )
      // 記録できないと後始末の対象から漏れるため、ハッシュは取り直してでも残す。
      const placedHash = nextHash ?? (await sha256OfFile(destPath))
      if (placedHash !== undefined) {
        placed.push({ destPath, hash: placedHash })
      } else {
        logger.error(
          `[shared-file] placed but could not record hash (will not be cleaned up automatically): ${destPath}`,
        )
      }
      results.push({ destPath, status: 'applied' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 内容は出さない（秘密情報を含み得る）。出すのはパスと理由だけ。
      logger.error(`[shared-file] failed to place ${destPath}: ${message}`)
      results.push({ destPath, status: 'failed', error: message })
    } finally {
      if (tmpPath) rmSync(tmpPath, { force: true })
    }
  }

  // 設定から外れた配置先の後始末。**設定が空（空配列）のときも必ず通る**
  // （機能を無効化した／設定を削除したのにファイルが残る、を防ぐ）。
  //
  // 残す基準は「今回の設定に含まれるか」であって「今回置けたか」ではない。
  // 取得に失敗しただけの配置先を消すと、一時的なネットワーク障害で動いていた
  // 認証情報まで失われ、障害を自分で広げてしまう。
  const configuredDestPaths = new Set(
    targets.map((mount) => mount?.destPath ?? ''),
  )
  let remaining: PlacedMount[] = []
  if (authoritative && !manifest.corrupted) {
    const removal = await removeStaleMounts(
      manifest.mounts,
      configuredDestPaths,
      deps,
    )
    results.push(...removal.results)
    remaining = removal.remaining
  } else if (manifest.corrupted) {
    // 記録が読めない＝過去に置いたものを追跡できない。黙って「無かったこと」に
    // すると、失効させたはずの認証情報が残り続けるため、画面に出して知らせる。
    results.push({
      destPath: '(manifest)',
      status: 'failed',
      error:
        '配置の記録が読めないため、設定から外れたファイルを自動削除できません（手動で確認してください）',
    })
  }

  // 今回置けなかったが設定には残っている配置先は、前回の記録をそのまま引き継ぐ
  // （記録を失うと、後で設定から外れたときに後始末できなくなる）。判断材料が無い
  // 回（authoritative でない）は、記録全体をそのまま持ち越す。
  const placedDestPaths = new Set(placed.map((entry) => entry.destPath))
  const carriedOver = manifest.mounts.filter(
    (entry) =>
      !placedDestPaths.has(entry.destPath) &&
      !remaining.some((r) => r.destPath === entry.destPath) &&
      (!authoritative || configuredDestPaths.has(entry.destPath)),
  )

  // 記録が読めなかった場合は上書きしない（残っている情報を壊さない）。
  if (!manifest.corrupted) {
    const saveError = saveManifest(deps.configDir, [
      ...placed,
      ...carriedOver,
      ...remaining,
    ])
    if (saveError) {
      // 記録できないと次回の後始末ができない。握り潰さず画面に出す。
      results.push({
        destPath: '(manifest)',
        status: 'failed',
        error: `配置の記録を保存できませんでした: ${saveError}`,
      })
    }
  }

  return results
}

/**
 * 設定ディレクトリを実体へ解決する。
 *
 * 比較相手（配置先の解決先）は `realpathSync` を通した実体パスなので、こちらも
 * 実体に揃えないと一致しない。macOS の `/tmp` → `/private/tmp` のように、
 * 経路にリンクがあるだけで**設定ディレクトリの保護が外れてしまう**。
 */
function resolveConfigDir(configDir: string): string {
  try {
    return realpathSync(configDir)
  } catch {
    // まだ存在しない場合は文字列として正規化するだけに留める。
    return path.resolve(configDir)
  }
}

/**
 * 許可ルートを実体へ解決した一覧。
 *
 * 判定相手（配置先の解決先）は `realpathSync` を通した実体パスなので、許可ルート側も
 * 実体に揃える必要がある。macOS の `/tmp` → `/private/tmp` のように経路自体がリンクの
 * 環境では、揃えないと正当な配置まで拒否してしまう。
 */
function resolvedAllowedPrefixes(): string[] {
  const resolved: string[] = []
  for (const prefix of ALLOWED_DESTINATION_PREFIXES) {
    const dir = prefix.slice(0, -1)
    resolved.push(prefix)
    try {
      const real = realpathSync(dir)
      if (real !== dir) resolved.push(`${real}/`)
    } catch {
      // 実行環境に存在しないルートは、宣言どおりの文字列だけを許可対象にする。
    }
  }
  return resolved
}

/**
 * リンクを解決した「実際に書き込まれるパス」が安全かを判定する。
 *
 * **許可リスト方式**にする。危険な場所を数え上げて塞ぐ方式では、`/usr/share` のように
 * 危険リストには載らないが許可もしたくない場所を取りこぼすうえ、`/etc` → `/private/etc`
 * （macOS）のように実体名が想定と変わるだけで判定そのものが外れる。
 */
function isSafeResolvedDestination(effective: string, configDir: string): boolean {
  if (!resolvedAllowedPrefixes().some((prefix) => effective.startsWith(prefix))) {
    return false
  }

  if (effective.split('/').some((segment) => FORBIDDEN_SEGMENTS.includes(segment))) {
    return false
  }

  const normalizedConfigDir = resolveConfigDir(configDir)
  const normalized = path.resolve(effective)
  if (normalized === normalizedConfigDir) return false
  if (normalized.startsWith(`${normalizedConfigDir}${path.sep}`)) return false

  return true
}

/**
 * リンクを使った許可範囲外への書き込みを検出する。
 *
 * 配置先そのものがリンクの場合に加え、**祖先のいずれかがリンクの場合**も対象にする
 * （`/tmp/x` → `/etc` のようなリンクを先に仕込んでおけば、宣言上のパスは許可ルート配下の
 * ままで、実体は許可範囲外になる）。
 */
function findUnsafeSymlink(
  destPath: string,
  configDir: string,
): string | undefined {
  try {
    const stat = lstatSync(destPath)
    if (stat.isSymbolicLink()) {
      return `配置先がシンボリックリンクです: ${destPath}`
    }
    // ハードリンクはシンボリックリンクと違い lstat でも経路上は見分けられない。
    // 内容が一致したときの `chmod` がリンク先の実体（機密ファイル）の権限を
    // 書き換えてしまうため、リンク数で検出して拒否する。
    if (stat.nlink > 1) {
      return `配置先が他のファイルへのハードリンクです: ${destPath}`
    }
  } catch {
    // 配置先がまだ無いのは正常（これから作る）。
  }

  // 実在する最も深い祖先を実体へ解決し、そこへ**配置先のファイル名を含む**残りの
  // セグメントを継ぎ足して「実際に書き込まれるパス」を組み立て、再検証する。
  // ファイル名を含めないと判定対象が親ディレクトリ（例: `/etc`）そのものになり、
  // 末尾スラッシュ付きの前方一致をすり抜ける。
  const remaining: string[] = [path.basename(destPath)]
  let current = path.dirname(destPath)
  for (;;) {
    if (existsSync(current)) {
      const effective = path.join(realpathSync(current), ...remaining)
      if (effective !== destPath && !isSafeResolvedDestination(effective, configDir)) {
        return `配置先の実体が許可されていない場所を指しています: ${effective}`
      }
      return undefined
    }
    const parent = path.dirname(current)
    if (parent === current) break
    remaining.unshift(path.basename(current))
    current = parent
  }
  return undefined
}
