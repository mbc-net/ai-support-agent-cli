#!/usr/bin/env node

import { Command } from 'commander'

import { startAgent } from './agent-runner'
import { registerAuthCommands } from './cli/auth-commands'
import { registerEcsCommands } from './cli/ecs-publish-command'
import { registerLogRotateCommand } from './cli/log-rotate-command'
import { registerServiceCommands } from './cli/service-command'
import { registerStatusCommand } from './cli/status-command'
import { registerSetProjectDirCommand } from './commands/set-project-dir'
import { registerDockerCommands } from './commands/docker-commands'
import { resolveProjectDir, getMetadataDir } from './project-dir'
import { parseIntervalOrExit, validateUpdateChannel } from './cli/validators'
import {
  AGENT_MODE_ONESHOT,
  AGENT_VERSION,
  CLI_FLAG_VERBOSE,
  CLI_FLAG_NO_AUTO_UPDATE,
  CLI_FLAG_NO_DOCKER,
  CLI_FLAG_NO_DOCKERFILE_SYNC,
  ONESHOT_ENV_VARS,
} from './constants'
import type { ReleaseChannel } from './types'
import * as fs from 'fs'

import {
  loadConfig,
  removeProject,
  saveConfig,
} from './config-manager'
import { initI18n, t } from './i18n'
import { logger } from './logger'
import { toErrorMessage } from './utils'

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
  .option('--poll-interval <ms>', `${t('cmd.start.pollInterval')} (deprecated)`, '3000')
  .option('--heartbeat-interval <ms>', t('cmd.start.heartbeatInterval'), '60000')
  .option(CLI_FLAG_VERBOSE, t('cmd.start.verbose'))
  .option(CLI_FLAG_NO_AUTO_UPDATE, t('cmd.start.noAutoUpdate'))
  .option('--update-channel <channel>', t('cmd.start.updateChannel'))
  .option(CLI_FLAG_NO_DOCKER, t('cmd.start.noDocker'))
  .option('--dockerfile <path>', t('cmd.start.dockerfile'))
  .option(CLI_FLAG_NO_DOCKERFILE_SYNC, t('cmd.start.noDockerfileSync'))
  .option('--project <tenantCode/projectCode>', t('cmd.start.project'))
  .action(async (opts: {
    token?: string
    apiUrl?: string
    pollInterval: string
    heartbeatInterval: string
    verbose?: boolean
    autoUpdate?: boolean
    updateChannel?: string
    docker: boolean
    dockerfile?: string
    dockerfileSync: boolean
    project?: string
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
        dockerfile: opts.dockerfile,
        dockerfileSync: opts.dockerfileSync,
        project: opts.project,
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
      project: opts.project,
    })
  })

program
  .command('stop')
  .description(t('cmd.stop'))
  .action(async () => {
    const { stopAgent } = await import('./commands/stop-agent')
    await stopAgent()
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
          { tenantCode: project?.tenantCode ?? 'unknown', projectCode, token: '', apiUrl: '', projectDir: project?.projectDir },
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

program
  .command('set-auto-update')
  .description(t('cmd.setAutoUpdate'))
  .option('--enable', t('cmd.setAutoUpdate.enable'))
  .option('--disable', t('cmd.setAutoUpdate.disable'))
  .option('--channel <channel>', t('cmd.setAutoUpdate.channel'))
  .action((opts: { enable?: boolean; disable?: boolean; channel?: string }) => {
    if (!opts.enable && !opts.disable && !opts.channel) {
      logger.warn(t('autoUpdate.usageHint'))
      return
    }

    const config = loadConfig()
    const current = config?.autoUpdate ?? { enabled: true, autoRestart: true, channel: 'latest' as ReleaseChannel }

    if (opts.enable && opts.disable) {
      logger.warn(t('autoUpdate.conflictFlags'))
      return
    }

    const channel = opts.channel ? validateUpdateChannel(opts.channel) as ReleaseChannel | undefined : undefined
    if (opts.channel && !channel) {
      return
    }

    const updated = {
      ...current,
      ...(opts.enable && { enabled: true }),
      ...(opts.disable && { enabled: false }),
      ...(channel && { channel }),
    }

    saveConfig({ autoUpdate: updated })

    if (opts.disable) {
      logger.success(t('autoUpdate.disabled'))
    } else if (opts.enable) {
      logger.success(t('autoUpdate.enabled', { channel: updated.channel }))
    }
    if (channel) {
      logger.success(t('autoUpdate.channelSet', { channel }))
    }
  })

program
  .command('docker-login')
  .description(t('cmd.dockerLogin'))
  .action(async () => {
    const { dockerLogin } = await import('./docker/docker-runner')
    dockerLogin()
  })

registerDockerCommands(program)

registerStatusCommand(program)
registerServiceCommands(program)
registerSetProjectDirCommand(program)
registerLogRotateCommand(program)
registerEcsCommands(program)

// ECS container mode: AGENT_MODE=oneshot (injected via RunTask
// containerOverrides) bypasses the CLI entirely and runs exactly one command
// (getCommand -> execute -> submitResult -> exit). See src/oneshot-runner.ts.
if (process.env[ONESHOT_ENV_VARS.AGENT_MODE] === AGENT_MODE_ONESHOT) {
  // A rejection escaping here (e.g. the dynamic import itself failing) would
  // otherwise leave the ECS container hanging with no exit — always exit 1.
  import('./oneshot-runner')
    .then(({ runOneshotFromEnv }) => runOneshotFromEnv())
    .catch((error: unknown) => {
      logger.error(`[oneshot] Fatal startup error: ${toErrorMessage(error)}`)
      process.exit(1)
    })
} else {
  program.parse()
}
