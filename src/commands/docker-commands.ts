import * as fs from 'fs'
import * as path from 'path'

import { Command } from 'commander'

import { getDockerfilePath, getConfigDockerfilePath } from '../docker/dockerfile-path'
import { loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { computeUnifiedDiff } from '../utils/unified-diff'

export function registerDockerCommands(program: Command): void {
  program
    .command('docker-diff-dockerfile')
    .description(t('cmd.dockerDiffDockerfile'))
    .argument('[path]', t('cmd.dockerDiffDockerfile.arg'))
    .action((customPath?: string) => {
      const config = loadConfig()

      // Resolve target: argument > config.dockerfilePath > configDir/Dockerfile
      let resolvedTarget: string | undefined
      if (customPath) {
        resolvedTarget = path.resolve(customPath)
      } else if (config?.dockerfilePath) {
        resolvedTarget = path.resolve(config.dockerfilePath)
      } else {
        const configDockerfile = getConfigDockerfilePath()
        if (fs.existsSync(configDockerfile)) {
          resolvedTarget = configDockerfile
        }
      }

      if (!resolvedTarget) {
        logger.error(t('docker.diffNoTarget'))
        return
      }

      if (!fs.existsSync(resolvedTarget)) {
        logger.error(t('docker.diffTargetNotFound', { path: resolvedTarget }))
        return
      }

      let defaultContent: string
      try {
        defaultContent = fs.readFileSync(getDockerfilePath(), 'utf-8')
      } catch (err) {
        logger.error(t('docker.diffDefaultError', { message: err instanceof Error ? err.message : String(err) }))
        return
      }

      const targetContent = fs.readFileSync(resolvedTarget, 'utf-8')

      if (defaultContent === targetContent) {
        logger.success(t('docker.diffIdentical'))
        return
      }

      const diff = computeUnifiedDiff(defaultContent, targetContent, 'bundled/Dockerfile', resolvedTarget)
      console.log(diff)
      logger.info(t('docker.diffDone'))
    })
}
