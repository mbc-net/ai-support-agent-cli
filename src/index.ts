#!/usr/bin/env node

import { Command } from 'commander'

import { startAgent } from './agent-runner'
import { startAuthServer } from './auth-server'
import { AGENT_VERSION, MAX_INTERVAL, MIN_INTERVAL, PROJECT_CODE_DEFAULT } from './constants'
import type { AgentConfig } from './types'
import {
  addProject,
  getProjectList,
  loadConfig,
  removeProject,
  saveConfig,
} from './config-manager'
import { initI18n, t } from './i18n'
import { logger } from './logger'
import { getErrorMessage, validateApiUrl } from './utils'

initI18n()

function parseIntervalOrExit(value: string, name: string): number {
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed < MIN_INTERVAL || parsed > MAX_INTERVAL) {
    logger.error(t('config.invalidInterval', { name, value, min: MIN_INTERVAL, max: MAX_INTERVAL }))
    process.exit(1)
  }
  return parsed
}

async function performBrowserAuth(opts: {
  url: string
  apiUrl?: string
  port?: string
}): Promise<{ projectCode: string }> {
  const port = opts.port ? (() => {
    const parsed = parseInt(opts.port, 10)
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      logger.error(t('auth.invalidPort', { port: opts.port }))
      process.exit(1)
    }
    return parsed
  })() : undefined

  const urlError = validateApiUrl(opts.url)
  if (urlError) {
    logger.error(t('auth.invalidProtocol'))
    process.exit(1)
  }
  const origin = new URL(opts.url).origin
  const { url: serverUrl, nonce, waitForCallback, stop } = await startAuthServer(port, origin)

  const callbackUrl = `${serverUrl}/callback`
  const webUrl = `${opts.url}/admin/agent-callback?callbackUrl=${encodeURIComponent(callbackUrl)}&nonce=${nonce}`

  logger.info(t('auth.openingBrowser'))
  logger.info(t('auth.url', { url: webUrl }))

  const open = (await import('open')).default
  await open(webUrl)

  logger.info(t('auth.selectProject'))

  const result = await waitForCallback()
  stop()

  const apiUrl = opts.apiUrl ?? result.apiUrl
  if (!apiUrl) {
    logger.error(t('auth.noApiUrl'))
    process.exit(1)
  }

  const projectCode = result.projectCode ?? PROJECT_CODE_DEFAULT
  addProject({ projectCode, token: result.token, apiUrl })
  return { projectCode }
}

async function handleBrowserAuthCommand(
  opts: { url: string; apiUrl?: string; port?: string },
  successMessageKey: string,
): Promise<void> {
  try {
    const { projectCode } = await performBrowserAuth(opts)
    logger.success(t(successMessageKey, { projectCode }))
  } catch (error) {
    logger.error(t('auth.failed', { message: getErrorMessage(error) }))
    process.exit(1)
  }
}

function formatStatus(config: AgentConfig): string {
  const projects = getProjectList(config)
  const lines: string[] = [
    '',
    `  ${t('status.header')}`,
    `    ${t('status.agentId', { agentId: config.agentId || t('status.notSet') })}`,
    `    ${t('status.lastConnected', { lastConnected: config.lastConnected || t('status.notConnected') })}`,
    '',
  ]

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

const program = new Command()

program
  .name('ai-support-agent')
  .description(t('cmd.description'))
  .version(AGENT_VERSION)
  .option('--lang <lang>', t('cmd.lang'))

program
  .command('start')
  .description(t('cmd.start'))
  .option('--token <token>', t('cmd.start.token'))
  .option('--api-url <url>', t('cmd.start.apiUrl'))
  .option('--poll-interval <ms>', t('cmd.start.pollInterval'), '3000')
  .option('--heartbeat-interval <ms>', t('cmd.start.heartbeatInterval'), '30000')
  .option('--verbose', t('cmd.start.verbose'))
  .action(async (opts: {
    token?: string
    apiUrl?: string
    pollInterval: string
    heartbeatInterval: string
    verbose?: boolean
  }) => {
    await startAgent({
      token: opts.token,
      apiUrl: opts.apiUrl,
      pollInterval: parseIntervalOrExit(opts.pollInterval, 'poll-interval'),
      heartbeatInterval: parseIntervalOrExit(opts.heartbeatInterval, 'heartbeat-interval'),
      verbose: opts.verbose,
    })
  })

program
  .command('login')
  .description(t('cmd.login'))
  .requiredOption('--url <url>', t('cmd.login.url'))
  .option('--api-url <url>', t('cmd.login.apiUrl'))
  .option('--port <port>', t('cmd.login.port'))
  .action((opts: { url: string; apiUrl?: string; port?: string }) =>
    handleBrowserAuthCommand(opts, 'project.registered'),
  )

program
  .command('add-project')
  .description(t('cmd.addProject'))
  .requiredOption('--url <url>', t('cmd.login.url'))
  .option('--api-url <url>', t('cmd.login.apiUrl'))
  .option('--port <port>', t('cmd.login.port'))
  .action((opts: { url: string; apiUrl?: string; port?: string }) =>
    handleBrowserAuthCommand(opts, 'project.added'),
  )

program
  .command('remove-project')
  .description(t('cmd.removeProject'))
  .argument('<projectCode>', t('cmd.removeProject.arg'))
  .action((projectCode: string) => {
    const removed = removeProject(projectCode)
    if (removed) {
      logger.success(t('project.removed', { projectCode }))
    } else {
      logger.warn(t('project.notFound', { projectCode }))
    }
  })

program
  .command('configure')
  .description(t('cmd.configure'))
  .requiredOption('--token <token>', t('cmd.configure.token'))
  .requiredOption('--api-url <url>', t('cmd.configure.apiUrl'))
  .option('--project-code <code>', t('cmd.configure.projectCode'))
  .action((opts: { token: string; apiUrl: string; projectCode?: string }) => {
    const apiUrlError = validateApiUrl(opts.apiUrl)
    if (apiUrlError) {
      logger.error(apiUrlError)
      process.exit(1)
    }
    const projectCode = opts.projectCode ?? PROJECT_CODE_DEFAULT
    addProject({
      projectCode,
      token: opts.token,
      apiUrl: opts.apiUrl,
    })
    logger.success(t('config.projectSaved', { projectCode }))
  })

program
  .command('set-language')
  .description(t('cmd.setLanguage'))
  .argument('<lang>', t('cmd.setLanguage.arg'))
  .action((lang: string) => {
    saveConfig({ language: lang })
    logger.success(t('config.languageSet', { lang }))
  })

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

program.parse()
