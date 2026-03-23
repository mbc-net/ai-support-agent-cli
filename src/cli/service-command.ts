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

export function installService(options: { verbose?: boolean }): void {
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

export function registerServiceCommands(program: Command): void {
  program
    .command('install-service')
    .description(t('cmd.installService'))
    .option('--verbose', t('cmd.installService.verbose'))
    .action((opts: { verbose?: boolean }) => {
      installService(opts)
    })

  program
    .command('uninstall-service')
    .description(t('cmd.uninstallService'))
    .action(() => {
      uninstallService()
    })
}

// Re-export for backward compatibility
export { generatePlist }
