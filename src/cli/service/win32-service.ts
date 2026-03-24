import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { t } from '../../i18n'
import { logger } from '../../logger'
import { escapeXml } from './escape-xml'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ServiceConfig, ServiceOptions, ServiceStatus, ServiceStrategy } from './types'

const TASK_NAME = 'AISupportAgent'

function getLogDir(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'ai-support-agent', 'logs')
}

export function generateTaskXml(options: ServiceConfig): string {
  const { nodePath, entryPoint, verbose, docker } = options
  const args = [entryPoint, 'start']
  if (!docker) {
    args.push('--no-docker')
  }
  if (verbose) {
    args.push('--verbose')
  }

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(nodePath)}</Command>
      <Arguments>${escapeXml(args.join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>`
}

export class Win32ServiceStrategy implements ServiceStrategy {
  install(options: ServiceOptions): void {
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

    const xml = generateTaskXml({
      nodePath,
      entryPoint,
      logDir,
      verbose: options.verbose,
      docker: options.docker,
    })

    const tmpXmlPath = path.join(os.tmpdir(), `${TASK_NAME}-task.xml`)
    try {
      fs.writeFileSync(tmpXmlPath, xml, 'utf-8')
      execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXmlPath}" /F`, {
        stdio: 'pipe',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.schtasksFailed', { message }))
      return
    } finally {
      if (fs.existsSync(tmpXmlPath)) {
        fs.unlinkSync(tmpXmlPath)
      }
    }

    logger.success(t('service.installed.win32', { taskName: TASK_NAME }))
    logger.info(t('service.loadHint.win32', { taskName: TASK_NAME }))
    logger.info(t('service.logDir', { path: logDir }))
    logger.info(t('service.noLogRotation'))
  }

  uninstall(): void {
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' })
    } catch {
      logger.warn(t('service.notInstalled.win32'))
      return
    }

    logger.info(t('service.unloadHint.win32', { taskName: TASK_NAME }))

    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.schtasksFailed', { message }))
      return
    }

    logger.success(t('service.uninstalled.win32'))
  }

  start(): void {
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' })
    } catch {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    try {
      execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe' })
      logger.success(t('service.started'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.startFailed', { message }))
    }
  }

  stop(): void {
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' })
    } catch {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    try {
      execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' })
      logger.success(t('service.stopped'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.stopFailed', { message }))
    }
  }

  restart(): void {
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' })
    } catch {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    try {
      execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' })
    } catch {
      // Task may not be running — ignore
    }

    try {
      execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe' })
      logger.success(t('service.restarted'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('service.restartFailed', { message }))
    }
  }

  status(): ServiceStatus {
    const logDir = getLogDir()
    try {
      const output = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`, { stdio: 'pipe' }).toString()
      const running = output.includes('Running')
      return { installed: true, running, logDir }
    } catch {
      return { installed: false, running: false }
    }
  }
}
