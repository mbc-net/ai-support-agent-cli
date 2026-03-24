import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ServiceConfig, ServiceOptions, ServiceStatus, ServiceStrategy } from './types'

const SERVICE_NAME = 'ai-support-agent.service'

function getServiceFilePath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME)
}

function getLogDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'ai-support-agent', 'logs')
}

export function generateServiceUnit(options: ServiceConfig): string {
  const { nodePath, entryPoint, logDir, verbose, docker } = options
  const execArgs = [nodePath, entryPoint, 'start']
  if (!docker) {
    execArgs.push('--no-docker')
  }
  if (verbose) {
    execArgs.push('--verbose')
  }

  return `[Unit]
Description=AI Support Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execArgs.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${os.homedir()}
StandardOutput=append:${path.join(logDir, 'agent.out.log')}
StandardError=append:${path.join(logDir, 'agent.err.log')}

[Install]
WantedBy=default.target
`
}

export class LinuxServiceStrategy implements ServiceStrategy {
  install(options: ServiceOptions): void {
    const serviceFilePath = getServiceFilePath()
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

    const systemdDir = path.dirname(serviceFilePath)
    if (!fs.existsSync(systemdDir)) {
      fs.mkdirSync(systemdDir, { recursive: true })
    }

    if (fs.existsSync(serviceFilePath)) {
      logger.info(t('service.overwriting', { path: serviceFilePath }))
    }

    const unit = generateServiceUnit({
      nodePath,
      entryPoint,
      logDir,
      verbose: options.verbose,
      docker: options.docker,
    })
    fs.writeFileSync(serviceFilePath, unit, 'utf-8')

    logger.success(t('service.installed.linux', { path: serviceFilePath }))
    logger.info(t('service.loadHint.linux'))
    logger.info(t('service.logDir', { path: logDir }))
    logger.info(t('service.noLogRotation'))
  }

  uninstall(): void {
    const serviceFilePath = getServiceFilePath()

    if (!fs.existsSync(serviceFilePath)) {
      logger.warn(t('service.notInstalled.linux'))
      return
    }

    logger.info(t('service.unloadHint.linux'))

    fs.unlinkSync(serviceFilePath)
    logger.success(t('service.uninstalled.linux'))
  }

  start(): void {
    const serviceFilePath = getServiceFilePath()

    if (!fs.existsSync(serviceFilePath)) {
      logger.error(t('service.notInstalled.linux'))
      return
    }

    try {
      const serviceName = SERVICE_NAME.replace('.service', '')
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
      execSync(`systemctl --user start ${serviceName}`, { stdio: 'pipe' })
      logger.success(t('service.started'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.startFailed', { message }))
    }
  }

  stop(): void {
    const serviceFilePath = getServiceFilePath()

    if (!fs.existsSync(serviceFilePath)) {
      logger.error(t('service.notInstalled.linux'))
      return
    }

    try {
      const serviceName = SERVICE_NAME.replace('.service', '')
      execSync(`systemctl --user stop ${serviceName}`, { stdio: 'pipe' })
      logger.success(t('service.stopped'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.stopFailed', { message }))
    }
  }

  restart(): void {
    const serviceFilePath = getServiceFilePath()

    if (!fs.existsSync(serviceFilePath)) {
      logger.error(t('service.notInstalled.linux'))
      return
    }

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
      const serviceName = SERVICE_NAME.replace('.service', '')
      execSync(`systemctl --user restart ${serviceName}`, { stdio: 'pipe' })
      logger.success(t('service.restarted'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.restartFailed', { message }))
    }
  }

  status(): ServiceStatus {
    const serviceFilePath = getServiceFilePath()
    const logDir = getLogDir()
    if (!fs.existsSync(serviceFilePath)) {
      return { installed: false, running: false }
    }

    try {
      const serviceName = SERVICE_NAME.replace('.service', '')
      const output = execSync(`systemctl --user show ${serviceName} --property=ActiveState,MainPID --no-pager`, { stdio: 'pipe' }).toString()
      const activeMatch = output.match(/ActiveState=(\w+)/)
      const pidMatch = output.match(/MainPID=(\d+)/)
      const active = activeMatch?.[1] === 'active'
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined
      return { installed: true, running: active, pid: active ? pid : undefined, logDir }
    } catch {
      return { installed: true, running: false, logDir }
    }
  }
}
