import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { escapeXml } from './escape-xml'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ServiceConfig, ServiceOptions, ServiceStrategy } from './types'

export { getCliEntryPoint, getNodePath }

const SERVICE_LABEL = 'com.ai-support-agent.cli'

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

function getLogDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'ai-support-agent')
}

const PASSTHROUGH_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'AI_SUPPORT_AGENT_TOKEN',
  'AI_SUPPORT_AGENT_API_URL',
]

function generateEnvVarEntries(): string {
  const entries: string[] = []
  for (const key of PASSTHROUGH_ENV_VARS) {
    const value = process.env[key]
    if (value) {
      entries.push(
        `\n        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`,
      )
    }
  }
  return entries.join('')
}

export function generatePlist(options: ServiceConfig): string {
  const { nodePath, entryPoint, logDir, verbose, docker } = options
  const args = [nodePath, entryPoint, 'start']
  if (!docker) {
    args.push('--no-docker')
  }
  if (verbose) {
    args.push('--verbose')
  }

  const programArgs = args
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(logDir, 'agent.out.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(logDir, 'agent.err.log'))}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>${generateEnvVarEntries()}
    </dict>
</dict>
</plist>`
}

export class DarwinServiceStrategy implements ServiceStrategy {
  install(options: ServiceOptions): void {
    const plistPath = getPlistPath()
    const logDir = getLogDir()
    const nodePath = getNodePath()
    const entryPoint = getCliEntryPoint()

    if (!fs.existsSync(entryPoint)) {
      logger.error(t('service.entryPointNotFound', { path: entryPoint }))
      return
    }

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    const launchAgentsDir = path.dirname(plistPath)
    if (!fs.existsSync(launchAgentsDir)) {
      fs.mkdirSync(launchAgentsDir, { recursive: true })
    }

    if (fs.existsSync(plistPath)) {
      logger.info(t('service.overwriting', { path: plistPath }))
    }

    const plist = generatePlist({
      nodePath,
      entryPoint,
      logDir,
      verbose: options.verbose,
      docker: options.docker,
    })
    fs.writeFileSync(plistPath, plist, 'utf-8')

    logger.success(t('service.installed', { path: plistPath }))
    logger.info(t('service.loadHint', { path: plistPath }))
    logger.info(t('service.logDir', { path: logDir }))
    logger.info(t('service.noLogRotation'))
  }

  uninstall(): void {
    const plistPath = getPlistPath()

    if (!fs.existsSync(plistPath)) {
      logger.warn(t('service.notInstalled'))
      return
    }

    logger.info(t('service.unloadHint', { label: SERVICE_LABEL }))

    fs.unlinkSync(plistPath)
    logger.success(t('service.uninstalled'))
  }

  restart(): void {
    const plistPath = getPlistPath()

    if (!fs.existsSync(plistPath)) {
      logger.error(t('service.notInstalled'))
      return
    }

    try {
      try {
        execSync(`launchctl remove ${SERVICE_LABEL}`, { stdio: 'pipe' })
      } catch {
        // Service may not be loaded — ignore
      }
      execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' })
      logger.success(t('service.restarted'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.restartFailed', { message }))
    }
  }
}
