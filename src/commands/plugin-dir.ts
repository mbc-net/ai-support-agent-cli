import * as fs from 'fs'
import * as path from 'path'

import { logger } from '../logger'

/**
 * 同梱の Claude Code プラグインディレクトリを解決する。
 * src/commands/ から見て src/plugin/（ビルド後は dist/commands/ から見て
 * dist/plugin/）を指す設計。
 */
export function resolveBundledPluginDir(): string {
  return path.join(__dirname, '..', 'plugin')
}

/**
 * 指定ディレクトリが有効な Claude Code プラグインかどうかを判定する。
 * `.claude-plugin/plugin.json` の存在有無で判定する。
 */
export function isPluginDirValid(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))
}

/**
 * 有効な同梱プラグインディレクトリを解決する。
 * ビルド成果物にプラグインが同梱されていない（ビルド不備）場合は警告を
 * ログ出力し null を返す。呼び出しごとに再評価する（キャッシュしない）。
 *
 * `dir` はテスト用の差し替えフック（省略時は resolveBundledPluginDir()）。
 */
export function resolveValidPluginDir(dir: string = resolveBundledPluginDir()): string | null {
  if (isPluginDirValid(dir)) {
    return dir
  }
  logger.warn(`[plugin-dir] bundled plugin not found at ${dir} (build defect) — skipping --plugin-dir`)
  return null
}
