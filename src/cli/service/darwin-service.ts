import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { loadConfig, getProjectList } from '../../config-manager'
import { t } from '../../i18n'
import { logger } from '../../logger'
import { escapeXml } from './escape-xml'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ServiceConfig, ServiceOptions, ServiceStatus, ServiceStrategy } from './types'

export { getCliEntryPoint, getNodePath }

const SERVICE_LABEL = 'com.ai-support-agent.cli'

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

function getLogDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'ai-support-agent')
}

// ---------------------------------------------------------------------------
// Per-project plist helpers
// ---------------------------------------------------------------------------

/** Returns the LaunchAgent label for a given project */
export function getProjectLabel(tenantCode: string, projectCode: string): string {
  const safeTenant = tenantCode.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const safeProject = projectCode.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  return `${SERVICE_LABEL}.${safeTenant}.${safeProject}`
}

/** Returns the plist file path for a given project */
export function getProjectPlistPath(tenantCode: string, projectCode: string): string {
  const label = getProjectLabel(tenantCode, projectCode)
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** Lists all per-project plist files under ~/Library/LaunchAgents */
export function getAllProjectPlists(): Array<{ label: string; plistPath: string }> {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const prefix = `${SERVICE_LABEL}.`
  const results: Array<{ label: string; plistPath: string }> = []
  try {
    const files = fs.readdirSync(launchAgentsDir)
    for (const file of files) {
      if (
        file.startsWith(prefix) &&
        file.endsWith('.plist') &&
        file !== `${SERVICE_LABEL}.plist`
      ) {
        const label = file.slice(0, -'.plist'.length)
        results.push({ label, plistPath: path.join(launchAgentsDir, file) })
      }
    }
  } catch {
    // LaunchAgents dir doesn't exist yet — return empty list
  }
  return results
}

/** Returns the host-side per-project config dir (mirrors what docker-runner uses) */
function getProjectConfigHostDir(tenantCode: string, projectCode: string): string {
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')
  return path.join(configDir, 'projects', tenantCode, projectCode, '.ai-support-agent')
}

/** Returns the services dir where wrapper scripts are stored */
function getServicesDir(): string {
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')
  return path.join(configDir, 'services')
}

// ---------------------------------------------------------------------------
// plist generation
// ---------------------------------------------------------------------------

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

/** Generate a per-project plist that runs a wrapper shell script */
export function generateProjectPlist(opts: {
  label: string
  wrapperScriptPath: string
  logDir: string
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label)}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${escapeXml(opts.wrapperScriptPath)}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(opts.logDir, 'agent.out.log'))}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(opts.logDir, 'agent.err.log'))}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${escapeXml(os.homedir())}</string>
    </dict>
</dict>
</plist>`
}

/** Convert localhost/127.0.0.1 to host.docker.internal for container use */
function toContainerApiUrl(apiUrl: string): string {
  return apiUrl.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?/,
    (_, scheme: string, _host: string, port?: string) => `${scheme}host.docker.internal${port ?? ''}`,
  )
}

/** Generate a bash wrapper script that runs docker for one project */
export function generateWrapperScript(opts: {
  imageTag: string
  tenantCode: string
  projectCode: string
  projectConfigHostDir: string
  projectDir?: string
  token: string
  apiUrl: string
  anthropicApiKey?: string
  claudeCodeOauthToken?: string
  verbose?: boolean
  updateScriptPath: string
}): string {
  const containerHome = '/home/node'
  const containerConfigDir = `${containerHome}/.ai-support-agent`
  const homeDir = os.homedir()
  const containerApiUrl = toContainerApiUrl(opts.apiUrl)

  const mountLines: string[] = [
    `  -v "${homeDir}/.claude:${containerHome}/.claude:rw" \\`,
    `  -v "${opts.projectConfigHostDir}:${containerConfigDir}:rw" \\`,
  ]
  // Mount .claude.json only if it's a regular file (not a directory)
  mountLines.push(`  -v "${homeDir}/.claude.json:${containerHome}/.claude.json:rw" \\`)

  if (opts.projectDir) {
    const containerProjectDir = `/workspace/projects/${opts.projectCode}`
    mountLines.push(`  -v "${opts.projectDir}:${containerProjectDir}:rw" \\`)
  }

  const envLines: string[] = [
    `  -e AI_SUPPORT_AGENT_IN_DOCKER=1 \\`,
    `  -e HOME=${containerHome} \\`,
    `  -e AI_SUPPORT_AGENT_CONFIG_DIR=${containerConfigDir} \\`,
    `  -e AI_SUPPORT_AGENT_TOKEN=${opts.token} \\`,
    `  -e AI_SUPPORT_AGENT_API_URL=${containerApiUrl} \\`,
  ]
  if (opts.anthropicApiKey) {
    envLines.push(`  -e ANTHROPIC_API_KEY=${opts.anthropicApiKey} \\`)
  }
  if (opts.claudeCodeOauthToken) {
    envLines.push(`  -e CLAUDE_CODE_OAUTH_TOKEN=${opts.claudeCodeOauthToken} \\`)
  }

  const containerArgs = [
    'ai-support-agent', 'start', '--no-docker',
    `--project ${opts.tenantCode}/${opts.projectCode}`,
  ]
  if (opts.verbose) containerArgs.push('--verbose')

  return `#!/bin/bash
set -uo pipefail

REBUILD_MARKER="${opts.projectConfigHostDir}/docker-rebuild-needed"
if [ -f "$REBUILD_MARKER" ]; then
  rm -f "$REBUILD_MARKER"
  ai-support-agent docker-build 2>/dev/null || true
fi

docker run --rm -i \\
${mountLines.join('\n')}
${envLines.join('\n')}
  ${opts.imageTag} \\
  ${containerArgs.join(' ')}

EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 42 ]; then
  exec "${opts.updateScriptPath}"
fi

exit "$EXIT_CODE"
`
}

/** Generate the update-and-restart.sh script */
export function generateUpdateScript(): string {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')

  return `#!/bin/bash
set -uo pipefail

# 1. Unload all per-project LaunchAgent services
for plist in "${launchAgentsDir}"/com.ai-support-agent.cli.*.plist; do
  [ -f "$plist" ] || continue
  launchctl unload "$plist" 2>/dev/null || true
done

# 2. Install new version if update-version.json exists
VERSION_FILE="${configDir}/update-version.json"
if [ -f "$VERSION_FILE" ]; then
  NEW_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf-8')).version||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
  rm -f "$VERSION_FILE"
  if [ -n "$NEW_VERSION" ]; then
    npm install -g "@ai-support-agent/cli@$NEW_VERSION" --quiet 2>/dev/null || true
    ai-support-agent service install 2>/dev/null || true
  fi
fi

# 3. Reload all per-project LaunchAgent services
for plist in "${launchAgentsDir}"/com.ai-support-agent.cli.*.plist; do
  [ -f "$plist" ] || continue
  launchctl load "$plist" 2>/dev/null || true
done

exit 0
`
}

// ---------------------------------------------------------------------------
// DarwinServiceStrategy
// ---------------------------------------------------------------------------

export class DarwinServiceStrategy implements ServiceStrategy {
  async install(options: ServiceOptions): Promise<void> {
    // Load project list from config
    const config = loadConfig()
    const projects = config ? getProjectList(config) : []

    if (projects.length === 0) {
      // Fallback: legacy single-plist mode (no registered projects with tenantCode)
      this.installLegacy(options)
      return
    }

    // Per-project mode: generate one plist + wrapper script per project
    const { ensureImage } = await import('../../docker/docker-runner')
    const imageTag = `ai-support-agent:${ensureImage()}`

    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    if (!fs.existsSync(launchAgentsDir)) {
      fs.mkdirSync(launchAgentsDir, { recursive: true })
    }

    // Warn about legacy plist if it still exists
    const legacyPlistPath = getPlistPath()
    if (fs.existsSync(legacyPlistPath)) {
      logger.warn(t('service.legacyPlistFound', { path: legacyPlistPath }))
    }

    const servicesDir = getServicesDir()
    const updateScriptPath = path.join(
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR
        ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
        : path.join(os.homedir(), '.ai-support-agent'),
      'update-and-restart.sh',
    )

    // Generate update-and-restart.sh
    const updateScript = generateUpdateScript()
    fs.writeFileSync(updateScriptPath, updateScript, { mode: 0o700 })

    for (const project of projects) {
      const { tenantCode, projectCode } = project
      const projectKey = `${tenantCode}-${projectCode.toLowerCase()}`
      const projectServiceDir = path.join(servicesDir, projectKey)
      if (!fs.existsSync(projectServiceDir)) {
        fs.mkdirSync(projectServiceDir, { recursive: true, mode: 0o700 })
      }

      const projectConfigHostDir = getProjectConfigHostDir(tenantCode, projectCode)
      if (!fs.existsSync(projectConfigHostDir)) {
        fs.mkdirSync(projectConfigHostDir, { recursive: true, mode: 0o700 })
      }

      const wrapperScriptPath = path.join(projectServiceDir, 'run.sh')
      const wrapperScript = generateWrapperScript({
        imageTag,
        tenantCode,
        projectCode,
        projectConfigHostDir,
        projectDir: project.projectDir,
        token: project.token,
        apiUrl: project.apiUrl,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        verbose: options.verbose,
        updateScriptPath,
      })
      fs.writeFileSync(wrapperScriptPath, wrapperScript, { mode: 0o700 })

      const label = getProjectLabel(tenantCode, projectCode)
      const plistPath = getProjectPlistPath(tenantCode, projectCode)
      const projectLogDir = path.join(logDir, projectKey)
      if (!fs.existsSync(projectLogDir)) {
        fs.mkdirSync(projectLogDir, { recursive: true })
      }

      const plist = generateProjectPlist({ label, wrapperScriptPath, logDir: projectLogDir })
      fs.writeFileSync(plistPath, plist, 'utf-8')

      logger.success(t('service.projectInstalled', { projectCode, path: plistPath }))
    }

    logger.info(t('service.loadHintMulti'))
    logger.info(t('service.logDir', { path: logDir }))
    logger.info(t('service.noLogRotation'))
  }

  private installLegacy(options: ServiceOptions): void {
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
    let removed = false

    // Remove all per-project plists
    const projectPlists = getAllProjectPlists()
    for (const { plistPath } of projectPlists) {
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath)
        removed = true
      }
    }

    // Remove legacy plist if present
    const legacyPlistPath = getPlistPath()
    if (fs.existsSync(legacyPlistPath)) {
      logger.info(t('service.unloadHint', { label: SERVICE_LABEL }))
      fs.unlinkSync(legacyPlistPath)
      removed = true
    }

    if (!removed) {
      logger.warn(t('service.notInstalled'))
      return
    }

    logger.success(t('service.uninstalled'))
  }

  start(): void {
    const projectPlists = getAllProjectPlists()

    if (projectPlists.length === 0) {
      // Fallback to legacy
      const plistPath = getPlistPath()
      if (!fs.existsSync(plistPath)) {
        logger.error(t('service.notInstalled'))
        return
      }
      try {
        execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' })
        logger.success(t('service.started'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.startFailed', { message }))
      }
      return
    }

    let failed = false
    for (const { plistPath } of projectPlists) {
      try {
        execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.startFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.started'))
    }
  }

  stop(): void {
    const projectPlists = getAllProjectPlists()

    if (projectPlists.length === 0) {
      // Fallback to legacy
      const plistPath = getPlistPath()
      if (!fs.existsSync(plistPath)) {
        logger.error(t('service.notInstalled'))
        return
      }
      try {
        execSync(`launchctl remove ${SERVICE_LABEL}`, { stdio: 'pipe' })
        logger.success(t('service.stopped'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.stopFailed', { message }))
      }
      return
    }

    let failed = false
    for (const { label } of projectPlists) {
      try {
        execSync(`launchctl remove ${label}`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.stopFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.stopped'))
    }
  }

  restart(): void {
    const projectPlists = getAllProjectPlists()

    if (projectPlists.length === 0) {
      // Fallback to legacy
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
      return
    }

    let failed = false
    for (const { label, plistPath } of projectPlists) {
      try {
        try {
          execSync(`launchctl remove ${label}`, { stdio: 'pipe' })
        } catch {
          // Service may not be loaded — ignore
        }
        execSync(`launchctl load ${plistPath}`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.restartFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.restarted'))
    }
  }

  status(): ServiceStatus {
    const projectPlists = getAllProjectPlists()
    const logDir = getLogDir()

    if (projectPlists.length === 0) {
      // Fallback to legacy
      const plistPath = getPlistPath()
      if (!fs.existsSync(plistPath)) {
        return { installed: false, running: false }
      }
      try {
        const output = execSync(`launchctl list ${SERVICE_LABEL}`, { stdio: 'pipe' }).toString()
        const pidMatch = output.match(/"PID"\s*=\s*(\d+)/)
        const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined
        return { installed: true, running: pid !== undefined, pid, logDir }
      } catch {
        return { installed: true, running: false, logDir }
      }
    }

    // Multi-project mode: report overall status
    let anyRunning = false
    let anyInstalled = false
    let firstPid: number | undefined

    for (const { label } of projectPlists) {
      anyInstalled = true
      try {
        const output = execSync(`launchctl list ${label}`, { stdio: 'pipe' }).toString()
        const pidMatch = output.match(/"PID"\s*=\s*(\d+)/)
        if (pidMatch) {
          anyRunning = true
          if (!firstPid) firstPid = parseInt(pidMatch[1], 10)
        }
      } catch {
        // Not loaded
      }
    }

    if (!anyInstalled) {
      return { installed: false, running: false }
    }
    return { installed: true, running: anyRunning, pid: firstPid, logDir }
  }
}
