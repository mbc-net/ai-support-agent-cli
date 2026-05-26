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
 * 他フィールドは保持し、`oauthAccount` も既にあれば触らない (再 login 後の
 * 正規メタデータを上書きしないため)。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../logger'

/** ~/.claude.json のパスを返す */
function getClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

/**
 * envVarsOverride に `CLAUDE_CODE_OAUTH_TOKEN` が含まれていれば、
 * `~/.claude.json` に `oauthAccount` キーを存在させる。
 *
 * 動作:
 * - envVarsOverride に CLAUDE_CODE_OAUTH_TOKEN が無い場合は何もしない
 * - `~/.claude.json` が存在しない場合は最小限の JSON で新規作成
 * - 既に `oauthAccount` キーがあれば変更しない（既存値を温存）
 * - 無ければ `oauthAccount: {}` を追加してマージ書き込み
 *
 * 失敗は warn してスキップ（spawn 自体は止めない）。
 */
export function ensureClaudeJsonOAuthAccount(
  envVarsOverride: Record<string, string> | undefined,
  ctx: { prefix: string },
): void {
  if (!envVarsOverride?.CLAUDE_CODE_OAUTH_TOKEN) return

  const claudeJsonPath = getClaudeJsonPath()
  try {
    let data: Record<string, unknown> = {}
    if (fs.existsSync(claudeJsonPath)) {
      const raw = fs.readFileSync(claudeJsonPath, 'utf-8')
      try {
        data = JSON.parse(raw)
      } catch {
        // 既存ファイルが壊れている場合は最小限から作り直す
        logger.warn(
          `${ctx.prefix} ~/.claude.json is corrupted; recreating minimal file for OAuth login`,
        )
        data = {}
      }
    }

    // 既に oauthAccount が存在すれば触らない（再 login 済みの正規メタデータを温存）
    if (
      typeof data === 'object' &&
      data !== null &&
      'oauthAccount' in data &&
      data.oauthAccount !== null &&
      data.oauthAccount !== undefined
    ) {
      return
    }

    // oauthAccount: {} を追加して書き戻し
    const next = { ...data, oauthAccount: {} }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(next, null, 2), {
      mode: 0o600,
    })
    logger.info(
      `${ctx.prefix} Added oauthAccount placeholder to ~/.claude.json to enable Claude Code interactive mode with CLAUDE_CODE_OAUTH_TOKEN`,
    )
  } catch (error) {
    logger.warn(
      `${ctx.prefix} Failed to sync ~/.claude.json for OAuth login: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
