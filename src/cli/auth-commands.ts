import type { Command } from 'commander'

import { ApiClient } from '../api-client'
import { startAuthServer } from '../auth-server'
import { DEFAULT_API_URL, DEFAULT_LOGIN_URL, PROJECT_CODE_DEFAULT } from '../constants'
import {
  addProject,
} from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import type { ProjectRegistration } from '../types'
import { exitWithError, getErrorMessage, validateApiUrl } from '../utils'
import { installAndStartProject } from './service-command'

function tryInstallAndStartProject(registration: ProjectRegistration): void {
  try {
    installAndStartProject(registration)
  } catch (error) {
    logger.warn(t('service.autoStartFailed', { message: getErrorMessage(error) }))
  }
}

async function performBrowserAuth(opts: {
  url: string
  apiUrl?: string
  port?: string
}): Promise<{ projectCode: string }> {
  const port = opts.port ? (() => {
    const parsed = parseInt(opts.port, 10)
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      exitWithError(t('auth.invalidPort', { port: opts.port }))
    }
    return parsed
  })() : undefined

  const urlError = validateApiUrl(opts.url)
  if (urlError) {
    exitWithError(t('auth.invalidProtocol'))
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
    exitWithError(t('auth.noApiUrl'))
  }

  if (!result.tenantCode) {
    exitWithError(t('auth.noTenantCode'))
  }
  const projectCode = result.projectCode ?? PROJECT_CODE_DEFAULT
  const registration: ProjectRegistration = { tenantCode: result.tenantCode, projectCode, token: result.token, apiUrl }
  addProject(registration)
  tryInstallAndStartProject(registration)
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
    exitWithError(t('auth.failed', { message: getErrorMessage(error) }))
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
        exitWithError(apiUrlError)
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
        exitWithError(t('config.resolveProjectFailed', { message: getErrorMessage(error) }))
      }

      if (!tenantCode) {
        exitWithError(t('config.resolveProjectFailed', { message: 'tenantCode not returned from API' }))
      }

      const registration: ProjectRegistration = {
        tenantCode,
        projectCode,
        token: opts.token,
        apiUrl: opts.apiUrl,
      }
      addProject(registration)
      tryInstallAndStartProject(registration)
      logger.success(t('config.projectSaved', { projectCode }))
    })
}
