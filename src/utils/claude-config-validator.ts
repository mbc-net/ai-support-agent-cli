import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { logger } from '../logger'

/**
 * .claude.json の整合性を検証し、破損していれば復元する。
 *
 * 処理フロー:
 * 1. ファイルが存在しなければスキップ
 * 2. JSON.parse で検証
 * 3. 有効なら .claude.json.backup にバックアップ
 * 4. 破損していたら:
 *    a. バックアップから復元
 *    b. バックアップも破損なら {} にリセット
 *
 * IO エラー（パーミッション不足、ディスクフル等）が発生した場合は
 * 警告ログを出力して処理を継続する（修復失敗でメイン処理を止めない）。
 */
export function ensureClaudeJsonIntegrity(): void {
  try {
    const home = os.homedir()
    const claudeJsonPath = path.join(home, '.claude.json')
    const backupPath = path.join(home, '.claude.json.backup')

    // 1. ファイルが存在しなければスキップ
    if (!fs.existsSync(claudeJsonPath)) {
      return
    }

    const content = fs.readFileSync(claudeJsonPath, 'utf-8')

    // 2. JSON.parse で検証
    try {
      JSON.parse(content)
      // 3. 有効なら バックアップ作成
      fs.writeFileSync(backupPath, content, { mode: 0o600 })
      return
    } catch {
      // 破損している
    }

    // 4. 破損時の復元
    if (fs.existsSync(backupPath)) {
      try {
        const backupContent = fs.readFileSync(backupPath, 'utf-8')
        JSON.parse(backupContent) // バックアップの検証
        fs.writeFileSync(claudeJsonPath, backupContent, { mode: 0o600 })
        return
      } catch {
        // バックアップも破損
      }
    }

    // バックアップも破損 or 不在 → {} にリセット
    fs.writeFileSync(claudeJsonPath, '{}', { mode: 0o600 })
  } catch (error) {
    logger.warn(`Failed to validate/repair .claude.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}
