import type { Command } from 'commander'

import {
  getProjectList,
  loadConfig,
} from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import type { AgentConfig } from '../types'

export function formatStatus(config: AgentConfig): string {
  const projects = getProjectList(config)
  const lines: string[] = [
    '',
    `  ${t('status.header')}`,
    `    ${t('status.agentId', { agentId: config.agentId || t('status.notSet') })}`,
    `    ${t('status.lastConnected', { lastConnected: config.lastConnected || t('status.notConnected') })}`,
  ]

  // Auto-update status
  const autoUpdate = config.autoUpdate
  // 自動アップデートは opt-in。ローカル設定が無い＝無効なので、明示的に true の
  // ときだけ「有効」と表示する（未設定を有効と表示すると、実際には動かないのに
  // 動くと誤解させる）。なお管理画面側の設定は別レイヤであり、ここには現れない。
  if (autoUpdate?.enabled !== true) {
    lines.push(`    ${t('status.autoUpdate', { status: t('update.disabled') })}`)
  } else {
    const autoRestart = autoUpdate?.autoRestart !== false ? 'true' : 'false'
    lines.push(`    ${t('status.autoUpdate', { status: t('update.enabled', { autoRestart }) })}`)
    lines.push(`    ${t('status.updateChannel', { channel: autoUpdate?.channel ?? 'latest' })}`)
  }

  lines.push('')

  if (projects.length === 0) {
    lines.push(`  ${t('status.noProjects')}`)
  } else {
    lines.push(`  ${t('status.projectCount', { count: projects.length })}`)
    for (const p of projects) {
      const tokenPreview = p.token.length > 4
        ? p.token.substring(0, 4) + '****'
        : '****'
      lines.push(`    - ${p.projectCode}`)
      lines.push(`        ${t('status.apiUrl', { apiUrl: p.apiUrl })}`)
      lines.push(`        ${t('status.token', { token: tokenPreview })}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description(t('cmd.status'))
    .action(() => {
      const config = loadConfig()
      if (!config) {
        logger.warn(t('status.noConfig'))
        return
      }
      console.log(formatStatus(config))
    })
}
