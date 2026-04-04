import type { Command } from 'commander'

import { ApiClient } from '../api-client'
import { startAuthServer } from '../auth-server'
import { DEFAULT_API_URL, DEFAULT_LOGIN_URL, PROJECT_CODE_DEFAULT } from '../constants'
import {
  addProject,
} from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { getErrorMessage, validateApiUrl } from '../utils'

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
  const webUrl = `${opts.url}/agent-callback?callbackUrl=${encodeURIComponent(callbackUrl)}&nonce=${nonce}`

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

  if (!result.tenantCode) {
    logger.error(t('auth.noTenantCode'))
    process.exit(1)
  }
  const projectCode = result.projectCode ?? PROJECT_CODE_DEFAULT
  addProject({ tenantCode: result.tenantCode, projectCode, token: result.token, apiUrl })
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

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description(t('cmd.login'))
    .option('--url <url>', t('cmd.login.url'), DEFAULT_LOGIN_URL)
    .option('--api-url <url>', t('cmd.login.apiUrl'))
    .option('--port <port>', t('cmd.login.port'))
    .action((opts: { url: string; apiUrl?: string; port?: string }) =>
      handleBrowserAuthCommand(opts, 'project.registered'),
    )

  program
    .command('add-project')
    .description(t('cmd.addProject'))
    .option('--url <url>', t('cmd.login.url'), DEFAULT_LOGIN_URL)
    .option('--api-url <url>', t('cmd.login.apiUrl'))
    .option('--port <port>', t('cmd.login.port'))
    .action((opts: { url: string; apiUrl?: string; port?: string }) =>
      handleBrowserAuthCommand(opts, 'project.added'),
    )

  program
    .command('configure')
    .description(t('cmd.configure'))
    .requiredOption('--token <token>', t('cmd.configure.token'))
    .option('--api-url <url>', t('cmd.configure.apiUrl'), DEFAULT_API_URL)
    .option('--project-code <code>', t('cmd.configure.projectCode'))
    .action(async (opts: { token: string; apiUrl: string; projectCode?: string }) => {
      const apiUrlError = validateApiUrl(opts.apiUrl)
      if (apiUrlError) {
        logger.error(apiUrlError)
        process.exit(1)
      }

      let projectCode = opts.projectCode
      let tenantCode: string | undefined
      // Always resolve tenantCode and optionally projectCode from API
      try {
        logger.info(t('config.resolvingProject'))
        const client = new ApiClient(opts.apiUrl, opts.token)
        const config = await client.getProjectConfig()
        if (!projectCode) {
          projectCode = config.project.projectCode
        }
        tenantCode = config.project.tenantCode
        logger.info(t('config.resolvedProject', { projectCode }))
      } catch (error) {
        logger.error(t('config.resolveProjectFailed', { message: getErrorMessage(error) }))
        process.exit(1)
      }

      if (!tenantCode) {
        logger.error(t('config.resolveProjectFailed', { message: 'tenantCode not returned from API' }))
        process.exit(1)
      }

      addProject({
        tenantCode,
        projectCode,
        token: opts.token,
        apiUrl: opts.apiUrl,
      })
      logger.success(t('config.projectSaved', { projectCode }))
    })
}
