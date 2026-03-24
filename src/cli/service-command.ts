import type { Command } from 'commander'

import { t } from '../i18n'
import { logger } from '../logger'
import { DarwinServiceStrategy, generatePlist } from './service/darwin-service'
import { LinuxServiceStrategy } from './service/linux-service'
import type { ServiceStrategy } from './service/types'
import { Win32ServiceStrategy } from './service/win32-service'

function getStrategy(): ServiceStrategy | null {
  switch (process.platform) {
    case 'darwin':
      return new DarwinServiceStrategy()
    case 'linux':
      return new LinuxServiceStrategy()
    case 'win32':
      return new Win32ServiceStrategy()
    default:
      return null
  }
}

export function installService(options: { verbose?: boolean; docker?: boolean }): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.install(options)
}

export function uninstallService(): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.uninstall()
}

export function startService(): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.start()
}

export function stopService(): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.stop()
}

export function restartService(): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.restart()
}

export function serviceStatus(options: { verbose?: boolean }): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  const status = strategy.status()

  if (!status.installed) {
    logger.warn(t('service.status.notInstalled'))
    return
  }

  if (status.running) {
    logger.success(t('service.status.running', { pid: String(status.pid ?? '?') }))
  } else {
    logger.warn(t('service.status.stopped'))
  }

  if (status.logDir) {
    logger.info(t('service.logDir', { path: status.logDir }))
  }

  if (options.verbose && status.logDir) {
    logger.info(t('service.status.logHint', {
      outLog: `${status.logDir}/agent.out.log`,
      errLog: `${status.logDir}/agent.err.log`,
    }))
  }
}

export function registerServiceCommands(program: Command): void {
  const service = program
    .command('service')
    .description(t('cmd.service'))

  service
    .command('install')
    .description(t('cmd.service.install'))
    .option('--verbose', t('cmd.service.install.verbose'))
    .option('--no-docker', t('cmd.service.install.noDocker'))
    .action((opts: { verbose?: boolean; docker?: boolean }) => {
      installService(opts)
    })

  service
    .command('uninstall')
    .description(t('cmd.service.uninstall'))
    .action(() => {
      uninstallService()
    })

  service
    .command('start')
    .description(t('cmd.service.start'))
    .action(() => {
      startService()
    })

  service
    .command('stop')
    .description(t('cmd.service.stop'))
    .action(() => {
      stopService()
    })

  service
    .command('restart')
    .description(t('cmd.service.restart'))
    .action(() => {
      restartService()
    })

  service
    .command('status')
    .description(t('cmd.service.status'))
    .option('--verbose', t('cmd.service.status.verbose'))
    .action((opts: { verbose?: boolean }) => {
      serviceStatus(opts)
    })

  // Legacy aliases (backward compatibility)
  program
    .command('install-service')
    .description(t('cmd.service.install'))
    .option('--verbose', t('cmd.service.install.verbose'))
    .option('--no-docker', t('cmd.service.install.noDocker'))
    .action((opts: { verbose?: boolean; docker?: boolean }) => {
      installService(opts)
    })

  program
    .command('uninstall-service')
    .description(t('cmd.service.uninstall'))
    .action(() => {
      uninstallService()
    })

  program
    .command('restart-service')
    .description(t('cmd.service.restart'))
    .action(() => {
      restartService()
    })
}

// Re-export for backward compatibility
export { generatePlist }
