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

export function restartService(): void {
  const strategy = getStrategy()
  if (!strategy) {
    logger.error(t('service.unsupportedPlatform', { platform: process.platform }))
    return
  }
  strategy.restart()
}

export function registerServiceCommands(program: Command): void {
  program
    .command('install-service')
    .description(t('cmd.installService'))
    .option('--verbose', t('cmd.installService.verbose'))
    .option('--docker', t('cmd.installService.docker'))
    .action((opts: { verbose?: boolean; docker?: boolean }) => {
      installService(opts)
    })

  program
    .command('uninstall-service')
    .description(t('cmd.uninstallService'))
    .action(() => {
      uninstallService()
    })

  program
    .command('restart-service')
    .description(t('cmd.restartService'))
    .action(() => {
      restartService()
    })
}

// Re-export for backward compatibility
export { generatePlist }
