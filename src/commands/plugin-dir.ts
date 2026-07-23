import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ENV_VARS } from '../constants'
import { logger } from '../logger'
import { toErrorMessage } from '../utils'

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

export function isCodexPluginDirValid(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.codex-plugin', 'plugin.json'))
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

export interface BundledCodexPluginProfile {
  profileName: string
  marketplaceName: string
  pluginName: string
  marketplaceRoot: string
}

const BUNDLED_CODEX_MARKETPLACE_NAME = 'ai-support-agent-bundled'
const BUNDLED_CODEX_PROFILE_NAME = 'ai-support-agent-bundled'

export function resolveCodexHome(): string {
  return process.env[ENV_VARS.CODEX_HOME] || path.join(os.homedir(), '.codex')
}

export function prepareBundledCodexPluginProfile(
  pluginDir: string = resolveBundledPluginDir(),
  codexHome: string = resolveCodexHome(),
): BundledCodexPluginProfile | null {
  try {
    if (!isCodexPluginDirValid(pluginDir)) {
      logger.warn(`[plugin-dir] bundled Codex plugin not found at ${pluginDir} (build defect) — skipping Codex plugin profile`)
      return null
    }

    const manifest = readCodexPluginManifest(pluginDir)
    const pluginName = manifest.name
    const version = manifest.version
    const marketplaceRoot = path.join(codexHome, 'plugins', 'bundled-marketplaces', BUNDLED_CODEX_MARKETPLACE_NAME)
    const materializedPluginDir = path.join(marketplaceRoot, 'plugins', pluginName)

    fs.mkdirSync(codexHome, { recursive: true })
    fs.rmSync(materializedPluginDir, { recursive: true, force: true })
    fs.cpSync(pluginDir, materializedPluginDir, { recursive: true })
    writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: BUNDLED_CODEX_MARKETPLACE_NAME,
      interface: {
        displayName: 'AI Support Agent Bundled',
      },
      plugins: [
        {
          name: pluginName,
          source: {
            source: 'local',
            path: `./plugins/${pluginName}`,
          },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: 'Productivity',
        },
      ],
    })

    const profilePath = path.join(codexHome, `${BUNDLED_CODEX_PROFILE_NAME}.config.toml`)
    fs.writeFileSync(profilePath, [
      `[marketplaces.${BUNDLED_CODEX_MARKETPLACE_NAME}]`,
      'last_updated = "1970-01-01T00:00:00Z"',
      'source_type = "local"',
      `source = ${toTomlString(marketplaceRoot)}`,
      '',
      `[plugins.${toTomlString(`${pluginName}@${BUNDLED_CODEX_MARKETPLACE_NAME}`)}]`,
      'enabled = true',
      '',
      `# Materialized from bundled ai-support-agent plugin version ${version}.`,
    ].join('\n'))

    return {
      profileName: BUNDLED_CODEX_PROFILE_NAME,
      marketplaceName: BUNDLED_CODEX_MARKETPLACE_NAME,
      pluginName,
      marketplaceRoot,
    }
  } catch (error) {
    logger.warn(`[plugin-dir] failed to prepare bundled Codex plugin profile: ${toErrorMessage(error)}`)
    return null
  }
}

function readCodexPluginManifest(pluginDir: string): { name: string; version: string } {
  const manifestPath = path.join(pluginDir, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name?: unknown; version?: unknown }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    throw new Error(`invalid Codex plugin manifest name at ${manifestPath}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`invalid Codex plugin manifest version at ${manifestPath}`)
  }
  return { name: manifest.name, version: manifest.version }
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

function toTomlString(value: string): string {
  return JSON.stringify(value)
}
