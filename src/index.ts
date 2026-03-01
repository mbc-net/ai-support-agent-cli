#!/usr/bin/env node

import { Command } from 'commander'

import { startAgent } from './agent-runner'
import { registerAuthCommands } from './cli/auth-commands'
import { registerStatusCommand } from './cli/status-command'
import { registerSetProjectDirCommand } from './commands/set-project-dir'
import { resolveProjectDir, getMetadataDir } from './project-dir'
import { parseIntervalOrExit, validateUpdateChannel } from './cli/validators'
import { AGENT_VERSION } from './constants'
import type { ReleaseChannel } from './types'
import * as fs from 'fs'

import {
  loadConfig,
  removeProject,
  saveConfig,
} from './config-manager'
import { initI18n, t } from './i18n'
import { logger } from './logger'

initI18n()

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
  .option('--no-auto-update', t('cmd.start.noAutoUpdate'))
  .option('--update-channel <channel>', t('cmd.start.updateChannel'))
  .option('--docker', t('cmd.start.docker'))
  .action(async (opts: {
    token?: string
    apiUrl?: string
    pollInterval: string
    heartbeatInterval: string
    verbose?: boolean
    autoUpdate?: boolean
    updateChannel?: string
    docker?: boolean
  }) => {
    if (opts.docker) {
      const { runInDocker } = await import('./docker/docker-runner')
      runInDocker({
        token: opts.token,
        apiUrl: opts.apiUrl,
        pollInterval: parseIntervalOrExit(opts.pollInterval, 'poll-interval'),
        heartbeatInterval: parseIntervalOrExit(opts.heartbeatInterval, 'heartbeat-interval'),
        verbose: opts.verbose,
        autoUpdate: opts.autoUpdate,
        updateChannel: opts.updateChannel,
      })
      return
    }
    const updateChannel = validateUpdateChannel(opts.updateChannel)
    await startAgent({
      token: opts.token,
      apiUrl: opts.apiUrl,
      pollInterval: parseIntervalOrExit(opts.pollInterval, 'poll-interval'),
      heartbeatInterval: parseIntervalOrExit(opts.heartbeatInterval, 'heartbeat-interval'),
      verbose: opts.verbose,
      autoUpdate: opts.autoUpdate,
      updateChannel: updateChannel as ReleaseChannel | undefined,
    })
  })

registerAuthCommands(program)

program
  .command('remove-project')
  .description(t('cmd.removeProject'))
  .argument('<projectCode>', t('cmd.removeProject.arg'))
  .action((projectCode: string) => {
    // Clean up .ai-support-agent/ metadata directory if project directory exists
    const config = loadConfig()
    const project = config?.projects?.find((p) => p.projectCode === projectCode)
    if (project?.projectDir || config?.defaultProjectDir) {
      try {
        const projectDir = resolveProjectDir(
          { projectCode, token: '', apiUrl: '', projectDir: project?.projectDir },
          config?.defaultProjectDir,
        )
        const metadataDir = getMetadataDir(projectDir)
        if (fs.existsSync(metadataDir)) {
          fs.rmSync(metadataDir, { recursive: true })
          logger.info(t('projectDir.cleaned', { metadataDir }))
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    const removed = removeProject(projectCode)
    if (removed) {
      logger.success(t('project.removed', { projectCode }))
    } else {
      logger.warn(t('project.notFound', { projectCode }))
    }
  })

program
  .command('set-language')
  .description(t('cmd.setLanguage'))
  .argument('<lang>', t('cmd.setLanguage.arg'))
  .action((lang: string) => {
    saveConfig({ language: lang })
    logger.success(t('config.languageSet', { lang }))
  })

registerStatusCommand(program)
registerSetProjectDirCommand(program)

program.parse()
