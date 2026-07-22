/**
 * `~/.claude.json` の `oauthAccount` セクション同期 helper。
 *
 * Claude Code CLI v2.1.150 は、`CLAUDE_CODE_OAUTH_TOKEN` env を渡しても
 * 対話モード (TTY) 起動時に `~/.claude.json` の `oauthAccount` キーが
 * 存在しないと `/login` プロンプトを出す。
 *
 * 実機検証で「`oauthAccount: {}` (空オブジェクト) が `~/.claude.json` に
 * 存在していれば対話モードでも認証通過する」ことが判明している
 * (claude auth status が `{"loggedIn": true, "authMethod": "oauth_token"}` を返す)。
 *
 * agent は PTY / code-server を spawn する前にこの helper を呼び、
 * envVarsOverride に `CLAUDE_CODE_OAUTH_TOKEN` が含まれていれば
 * `~/.claude.json` の `oauthAccount` キーを確保する。
 *
 * 設計上の注意:
 *
 * - `~/.claude.json` はホスト/コンテナで volume mount 共有されているケースが
 *   多い (mbc-ai-01 では複数プロジェクトコンテナが同一ファイルを参照)。
 *   並列 spawn による lost-update を防ぐため、`O_CREAT|O_EXCL` lockfile
 *   方式で排他制御する。
 * - atomic write: 一時ファイルに書き込んでから rename で置換する。
 *   書き込み途中で kill されても破損ファイルが残らない。
 * - mode 0o600 を明示的に chmod する。`writeFileSync` の mode は
 *   既存ファイルには適用されない Node.js 仕様への対策。
 * - 既存 `oauthAccount` が **オブジェクト型** の場合のみ温存する。
 *   `false`/`""`/`0`/`[]`/`null` 等の不正値は再生成対象とする。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../logger'
import { isErrnoException, getErrorMessage } from '../utils'

/** ~/.claude.json のパスを返す */
function getClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

/** 排他ロック用ファイル */
function getLockPath(): string {
  return path.join(os.homedir(), '.claude.json.lock')
}

/** 破損ファイルダンプ用パス（タイムスタンプ付） */
function getBrokenDumpPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(os.homedir(), `.claude.json.broken-${ts}`)
}

/** ロック取得試行間隔・最大試行数 */
const LOCK_RETRY_INTERVAL_MS = 50
const LOCK_RETRY_MAX = 40 // 50ms × 40 = 最大 2 秒待つ
/** ロックファイルがこの年齢を超えていたら stale とみなして奪う */
const LOCK_STALE_MS = 30_000

/**
 * `O_CREAT|O_EXCL` で lock ファイルを排他作成する。
 * 既に存在し、stale 判定でない場合は false を返す。
 */
function acquireLock(lockPath: string): number | null {
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    return fd
  } catch (error) {
    if (isErrnoException(error, 'EEXIST')) {
      // stale check
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          logger.warn(
            `[claude-json-sync] Removing stale lock file (age ${Math.round(
              (Date.now() - stat.mtimeMs) / 1000,
            )}s)`,
          )
          fs.unlinkSync(lockPath)
          // 再帰でもう一度試行
          return acquireLock(lockPath)
        }
      } catch {
        // stat 失敗時はロック取得失敗扱い
      }
      return null
    }
    throw error
  }
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    fs.closeSync(fd)
  } catch {
    // 既に閉じている可能性
  }
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // 既に削除されている可能性
  }
}

/**
 * lock を取得して fn を実行。取得できなければ null 返却。
 * 短時間（最大 2 秒）リトライする。
 */
function withLock<T>(lockPath: string, fn: () => T): T | null {
  for (let i = 0; i < LOCK_RETRY_MAX; i++) {
    const fd = acquireLock(lockPath)
    if (fd !== null) {
      try {
        return fn()
      } finally {
        releaseLock(fd, lockPath)
      }
    }
    // busy-wait（同期）。Node.js の同期 spawn 直前のため非同期化しない
    const start = Date.now()
    while (Date.now() - start < LOCK_RETRY_INTERVAL_MS) {
      // spin
    }
  }
  return null
}

/**
 * トップレベルが plain object かどうか
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/**
 * 既存 oauthAccount が「有効な object（再 login 済みの正規メタデータ）」か。
 * 空オブジェクト `{}` も placeholder として有効とみなす（再書き込みを避ける）。
 * 配列・プリミティブ・null は無効として再生成する。
 */
function hasValidOauthAccount(data: Record<string, unknown>): boolean {
  if (!('oauthAccount' in data)) return false
  const v = data.oauthAccount
  return isPlainObject(v)
}

/**
 * onboarding 完了 flag が既に正しくセットされているか。
 * `hasCompletedOnboarding: true` + `lastOnboardingVersion: string` の両方が必要。
 */
function hasValidOnboardingFlags(data: Record<string, unknown>): boolean {
  return (
    data.hasCompletedOnboarding === true &&
    typeof data.lastOnboardingVersion === 'string' &&
    data.lastOnboardingVersion.length > 0
  )
}

/**
 * インストール済み claude CLI のバージョンを取得する。
 *
 * `~/.claude.json` の `lastOnboardingVersion` に書き込むため、claude CLI 本体の
 * package.json から実バージョンを読む。これにより claude をアップデートしても
 * version 文字列が古いまま残らない。
 *
 * 取得失敗時はフォールバック値を返す。実機検証で `lastOnboardingVersion` は
 * 何かしらの string であれば onboarding スキップが有効になる挙動を確認済み。
 */
function detectClaudeVersion(): string {
  const candidates = [
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/package.json',
    path.join(os.homedir(), '.npm-global/lib/node_modules/@anthropic-ai/claude-code/package.json'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = fs.readFileSync(candidate, 'utf-8')
      const pkg = JSON.parse(raw) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version
      }
    } catch {
      // 次の候補を試す
    }
  }
  // フォールバック: 適当な version 文字列。claude CLI は string であれば
  // 内容を厳密にバージョン比較しないと推測される（実機検証では '2.1.150' で
  // OK だった）が、固定値だと将来の挙動変化に弱いため UNKNOWN を埋める
  return 'unknown'
}

/**
 * OAuth token の妥当性を簡易検証。
 * - 文字列でなければ無効
 * - trim 後に空ならば無効
 * - `'undefined'` / `'null'` の literal を弾く
 */
function isAcceptableToken(token: unknown): boolean {
  if (typeof token !== 'string') return false
  const trimmed = token.trim()
  if (trimmed === '') return false
  if (trimmed === 'undefined' || trimmed === 'null') return false
  return true
}

/**
 * 書き換え戦略:
 *
 * 1. **tmp + rename (atomic)**: tmp ファイルに書いてから `fs.renameSync` で
 *    原子的に置換。POSIX rename atomicity により、書き込み途中で kill されても
 *    破損ファイルが残らない。**ローカルディスク上のファイルでは最善**。
 *
 * 2. **直接 write (fallback)**: rename が `EBUSY` で失敗した場合に使う。
 *    Linux では **docker bind mount された個別ファイル** に対する rename が
 *    `EBUSY` で拒否される（マウントポイント自体を置換することになるため）。
 *    mbc-ai-01 では `~/.claude.json` がコンテナにファイル単位で bind mount
 *    されており、この経路が必須。
 *    fallback では partial write 耐性が無いが、ホスト側のロックで並列性は
 *    既に防いでいるため運用上の影響は限定的。
 *
 * いずれの経路でも書き込み後に明示的に `chmod 0o600` を呼ぶ。
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  // claude CLI と同じく minified で書く（差分ノイズを抑える）
  const json = JSON.stringify(data)

  // Path 1: tmp + rename を試す（atomic）
  const dir = path.dirname(targetPath)
  const tmpPath = path.join(dir, `.claude.json.tmp.${process.pid}.${Date.now()}`)
  let tmpWritten = false
  try {
    fs.writeFileSync(tmpPath, json, { mode: 0o600 })
    tmpWritten = true
    try {
      fs.chmodSync(tmpPath, 0o600)
    } catch {
      // chmod 失敗は致命的ではない
    }
    fs.renameSync(tmpPath, targetPath)
    tmpWritten = false // rename 成功 → tmp は無くなった
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'EBUSY' || error.code === 'EXDEV' || error.code === 'EPERM')) {
      // EBUSY: docker bind mount された file への rename (Linux の制約)
      // EXDEV: cross-device link (まず起きないが念のため)
      // EPERM: 一部 FS で rename 不可
      // → 直接 write にフォールバック
      logger.debug(
        `[claude-json-sync] rename failed (${error.code}); falling back to direct write (bind-mount path)`,
      )
      fs.writeFileSync(targetPath, json, { mode: 0o600 })
    } else {
      // 他のエラーは上位に伝播
      throw error
    }
  } finally {
    // tmp が残っていれば掃除
    if (tmpWritten) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // 既に消えていれば無視
      }
    }
  }

  // 最終的な target に対して mode を保証 (既存ファイルは writeFileSync の mode を無視するため)
  try {
    fs.chmodSync(targetPath, 0o600)
  } catch {
    // chmod 失敗は致命的ではない
  }
}

/**
 * envVarsOverride（Web 設定 CLAUDE_CODE# / ENV# 経由）と processEnvToken
 * （`process.env.CLAUDE_CODE_OAUTH_TOKEN`。`linux-service.ts` 等の
 * `docker run -e CLAUDE_CODE_OAUTH_TOKEN=<token>` 経由で渡る）のどちらから
 * トークンを採用するかを解決する。envVarsOverride が優先。
 *
 * トークン解決ロジックを独立させているのは、`ensureClaudeJsonOAuthAccount`
 * の書き込み結果（~/.claude.json）だけからは、どちらのソースが実際に
 * 採用されたかを直接観測できない（結果は常に同じ `oauthAccount: {}` になる）
 * ため。優先順位（`??` の分岐）自体を単体でテスト可能にする。
 */
export function resolveOAuthToken(
  envVarsOverride: Record<string, string> | undefined,
  processEnvToken: string | undefined,
): string | undefined {
  return envVarsOverride?.CLAUDE_CODE_OAUTH_TOKEN ?? processEnvToken
}

/**
 * envVarsOverride または process.env に `CLAUDE_CODE_OAUTH_TOKEN` が含まれていれば、
 * `~/.claude.json` を以下の状態にする:
 *
 * 1. `oauthAccount` キー（オブジェクト）を存在させる
 * 2. `hasCompletedOnboarding: true` を設定
 * 3. `lastOnboardingVersion` に claude CLI の実バージョンを設定
 *
 * 1 だけでは対話 (TTY) モードで claude が "Select login method:" を出す。
 * 2 + 3 を加えることで onboarding wizard を完全にスキップし、
 * `CLAUDE_CODE_OAUTH_TOKEN` env だけで対話 REPL が起動する。
 *
 * 動作詳細:
 * - 有効なトークンが (resolveOAuthToken 経由で) 見つからない場合は何もしない
 * - 並列 spawn での lost update を防ぐため lockfile で排他
 * - `~/.claude.json` が存在しない or 破損している場合は最小限の JSON で新規作成
 *   (破損時は `.claude.json.broken-<ts>` にバックアップを残す)
 * - トップレベルが object でない場合 (配列/プリミティブ) は corrupted 扱い
 * - 既に 3 つすべて有効な値で揃っていれば変更しない (no-op、mtime も変化しない)
 * - 不足キーのみを追加し、既存の正規メタデータ (実 OAuth login 由来の
 *   accountUuid 等) は温存
 * - atomic write + 明示的 chmod 0o600
 *
 * 失敗は warn してスキップ（spawn 自体は止めない）。
 */
export function ensureClaudeJsonOAuthAccount(
  envVarsOverride: Record<string, string> | undefined,
  ctx: { prefix: string },
): void {
  // envVarsOverride は Web 設定（CLAUDE_CODE# / ENV#）経由のトークンのみを含む。
  // `linux-service.ts` / `darwin-service.ts` / `win32-service.ts` は
  // `docker run -e CLAUDE_CODE_OAUTH_TOKEN=<token>` として実プロセス環境変数に
  // トークンを注入する（Web 設定を経由しない）ため、process.env もフォールバックで
  // 見ないと、この経路のトークンでは oauthAccount 同期が silently スキップされる。
  const token = resolveOAuthToken(envVarsOverride, process.env.CLAUDE_CODE_OAUTH_TOKEN)
  if (!isAcceptableToken(token)) return

  const claudeJsonPath = getClaudeJsonPath()
  const lockPath = getLockPath()
  try {
    const result = withLock(lockPath, () => {
      return syncOauthAccount(claudeJsonPath, ctx)
    })
    if (result === null) {
      logger.warn(
        `${ctx.prefix} Could not acquire lock on ${lockPath} after ${
          (LOCK_RETRY_INTERVAL_MS * LOCK_RETRY_MAX) / 1000
        }s; skipping oauthAccount sync (another agent process may be writing)`,
      )
    }
  } catch (error) {
    logger.warn(
      `${ctx.prefix} Failed to sync ~/.claude.json for OAuth login: ${getErrorMessage(error)}`,
    )
  }
}

/**
 * ロック取得済み前提で実行する同期本体。
 */
function syncOauthAccount(
  claudeJsonPath: string,
  ctx: { prefix: string },
): 'updated' | 'noop' | 'created' {
  let data: Record<string, unknown> = {}
  let needBackup = false

  if (fs.existsSync(claudeJsonPath)) {
    const raw = fs.readFileSync(claudeJsonPath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      needBackup = true
      parsed = null
    }
    if (isPlainObject(parsed)) {
      data = parsed
    } else if (parsed !== null) {
      // 配列 / 文字列 / 数値 / boolean 等のトップレベル値 → corrupted 扱い
      needBackup = true
    }
    if (needBackup) {
      // 破損データを後で確認できるよう退避
      try {
        const dumpPath = getBrokenDumpPath()
        fs.writeFileSync(dumpPath, raw, { mode: 0o600 })
        logger.warn(
          `${ctx.prefix} ~/.claude.json was corrupted or non-object; dumped to ${dumpPath} and recreating minimal file`,
        )
      } catch {
        logger.warn(
          `${ctx.prefix} ~/.claude.json was corrupted; recreating minimal file (backup dump failed)`,
        )
      }
      data = {}
    }
  }

  // 既に 3 つすべて揃っていれば no-op
  const oauthAccountValid = hasValidOauthAccount(data)
  const onboardingValid = hasValidOnboardingFlags(data)
  if (oauthAccountValid && onboardingValid) {
    return 'noop'
  }

  // 不足分を補完する diff を構築
  const next: Record<string, unknown> = { ...data }
  const changes: string[] = []

  if (!oauthAccountValid) {
    const wasPresent = 'oauthAccount' in data
    next.oauthAccount = {}
    changes.push(wasPresent ? 'replaced invalid oauthAccount' : 'added oauthAccount')
  }

  if (!onboardingValid) {
    next.hasCompletedOnboarding = true
    if (typeof data.lastOnboardingVersion !== 'string' || data.lastOnboardingVersion === '') {
      next.lastOnboardingVersion = detectClaudeVersion()
    }
    changes.push('set onboarding flags')
  }

  atomicWriteJson(claudeJsonPath, next)
  logger.info(
    `${ctx.prefix} Updated ~/.claude.json for CLAUDE_CODE_OAUTH_TOKEN authentication: ${changes.join(', ')}`,
  )
  return oauthAccountValid && onboardingValid ? 'noop' : 'updated'
}
