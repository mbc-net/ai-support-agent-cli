import * as fs from 'fs'
import * as path from 'path'

import { Command } from 'commander'

import { getDockerfilePath, getConfigDockerfilePath } from '../docker/dockerfile-path'
import { loadConfig } from '../config-manager'
import { AGENT_VERSION, CLI_FLAG_NO_IMAGE_PULL } from '../constants'
import { t } from '../i18n'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'
import { computeUnifiedDiff } from '../utils/unified-diff'
import {
  DOCKER_ASSET_MAX_BYTES,
  pathExistsNoFollow,
  readRegularFileNoFollow,
} from '../utils/marker-file'

export function registerDockerCommands(program: Command): void {
  program
    .command('docker-build')
    .description(t('cmd.dockerBuild'))
    .option('--dockerfile <path>', t('cmd.dockerBuild.dockerfile'))
    .action(async (opts: { dockerfile?: string }) => {
      const { buildImage } = await import('../docker/docker-runner')
      const dockerfilePath = opts.dockerfile ? path.resolve(opts.dockerfile) : undefined
      logger.info(t('docker.building'))
      try {
        // Refuses a ~/.ai-support-agent/Dockerfile that is not a regular file
        // (design §7.7); that and any other build failure fail the command.
        buildImage(AGENT_VERSION, dockerfilePath)
      } catch (err: unknown) {
        logger.error(getErrorMessage(err))
        process.exitCode = 1
        return
      }
      logger.success(t('docker.buildComplete', { version: AGENT_VERSION }))
    })

  program
    .command('docker-ensure-image')
    .description(t('cmd.dockerEnsureImage'))
    .option('--dockerfile <path>', t('cmd.dockerBuild.dockerfile'))
    .option(CLI_FLAG_NO_IMAGE_PULL, t('cmd.start.noImagePull'))
    .action(async (opts: { dockerfile?: string; imagePull?: boolean }) => {
      const { ensureImage, syncDockerfileToConfigDir, hasUnmanagedConfigDockerfile } =
        await import('../docker/docker-runner')
      const config = loadConfig()
      // Sync first, exactly as runInDocker does. The service wrappers run the
      // container directly and never reach runInDocker, so without this the
      // config-dir Dockerfile stays at whatever version last synced it. After a
      // CLI update that stale copy differs from the new bundle, ensureImage()
      // would read it as "customised" and build locally forever. Syncing
      // refreshes an unmodified copy and still leaves a genuinely customised
      // one untouched (it only warns).
      //
      // Except when the config-dir Dockerfile has no sync hash beside it: the
      // sync would treat that as a first run and overwrite it, destroying a
      // Dockerfile the user placed there by hand. Skipping leaves it in place,
      // and ensureImage() then builds from it instead of pulling.
      if (config?.dockerfileSync !== false && !hasUnmanagedConfigDockerfile()) {
        syncDockerfileToConfigDir()
      }
      // Same precedence as runInDocker: CLI flag > config > default (pull).
      const dockerfilePath = opts.dockerfile ? path.resolve(opts.dockerfile) : config?.dockerfilePath
      const allowPull = opts.imagePull !== false && config?.dockerImagePull !== 'never'
      // ensureImage() resolves the npm-installed version itself, which is the
      // same version the service wrapper used to decide the image was missing.
      try {
        // A local build refuses a ~/.ai-support-agent/Dockerfile that is not a
        // regular file (buildImage, design §7.7); an existing image or a pull
        // does not read it at all.
        ensureImage(dockerfilePath, allowPull)
      } catch (err: unknown) {
        logger.error(getErrorMessage(err))
        process.exitCode = 1
      }
    })

  program
    .command('docker-diff-dockerfile')
    .description(t('cmd.dockerDiffDockerfile'))
    .argument('[path]', t('cmd.dockerDiffDockerfile.arg'))
    .action((customPath?: string) => {
      const config = loadConfig()

      // Resolve target: argument > config.dockerfilePath > configDir/Dockerfile
      let resolvedTarget: string | undefined
      // Only the config-dir copy is read without following a symlink: a path
      // the user names explicitly (argument or config) is their own choice.
      let targetIsConfigCopy = false
      if (customPath) {
        resolvedTarget = path.resolve(customPath)
      } else if (config?.dockerfilePath) {
        resolvedTarget = path.resolve(config.dockerfilePath)
      } else {
        const configDockerfile = getConfigDockerfilePath()
        let present: boolean
        try {
          present = pathExistsNoFollow(configDockerfile)
        } catch (err: unknown) {
          logger.error(t('docker.diffTargetUnreadable', { path: configDockerfile, message: getErrorMessage(err) }))
          process.exitCode = 1
          return
        }
        if (present) {
          resolvedTarget = configDockerfile
          targetIsConfigCopy = true
        }
      }

      if (!resolvedTarget) {
        logger.error(t('docker.diffNoTarget'))
        return
      }

      if (!targetIsConfigCopy && !fs.existsSync(resolvedTarget)) {
        logger.error(t('docker.diffTargetNotFound', { path: resolvedTarget }))
        return
      }

      let defaultContent: string
      try {
        defaultContent = fs.readFileSync(getDockerfilePath(), 'utf-8')
      } catch (err: unknown) {
        logger.error(t('docker.diffDefaultError', { message: getErrorMessage(err) }))
        return
      }

      let targetContent: string
      if (targetIsConfigCopy) {
        try {
          const content = readRegularFileNoFollow(resolvedTarget, DOCKER_ASSET_MAX_BYTES)
          if (content === undefined) {
            logger.error(t('docker.diffTargetNotFound', { path: resolvedTarget }))
            return
          }
          targetContent = content.toString('utf-8')
        } catch (err: unknown) {
          logger.error(t('docker.diffTargetUnreadable', { path: resolvedTarget, message: getErrorMessage(err) }))
          process.exitCode = 1
          return
        }
      } else {
        targetContent = fs.readFileSync(resolvedTarget, 'utf-8')
      }

      if (defaultContent === targetContent) {
        logger.success(t('docker.diffIdentical'))
        return
      }

      const diff = computeUnifiedDiff(defaultContent, targetContent, 'bundled/Dockerfile', resolvedTarget)
      console.log(diff)
      logger.info(t('docker.diffDone'))
    })
}
