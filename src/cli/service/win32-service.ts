import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CLI_FLAG_VERBOSE, CLI_FLAG_NO_DOCKER, ENV_VARS } from '../../constants'
import { loadConfig, getProjectList } from '../../config-manager'
import { IMAGE_NAME } from '../../docker/docker-utils'
import { t } from '../../i18n'
import { logger } from '../../logger'
import type { ProjectRegistration } from '../../types'
import { getErrorMessage } from '../../utils'
import {
  getProjectConfigHostDir,
  getProjectLogDir,
  getProjectServiceDir,
  getServicesDir,
  getWin32LogDir,
  getWin32WrapperScriptPath,
} from '../../utils/path-utils'
import { escapeXml } from './escape-xml'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ProjectStatus, ServiceConfig, ServiceOptions, ServiceStatus, ServiceStrategy } from './types'
import {
  assertProjectCodeIsSafe,
  detectInstallCollisions,
  sanitizeServiceNameSegment,
  toContainerApiUrl,
  validateProjectDirForMount,
} from './wrapper-helpers'

export { getCliEntryPoint, getNodePath }

const TASK_PREFIX = 'AISupportAgent'

const getLogDir = getWin32LogDir

// ---------------------------------------------------------------------------
// Per-project task helpers
// ---------------------------------------------------------------------------

/**
 * Returns the scheduled-task name for a given project.
 * Format: AISupportAgent-{tenantCode}-{projectCode} (sanitized).
 *
 * The Windows Task Scheduler accepts backslashes as folder separators in task
 * names, so any backslash in a code would silently create a nested task folder.
 * sanitizeServiceNameSegment() already strips it (along with other non `[a-z0-9-]` chars).
 */
export function getProjectTaskName(tenantCode: string, projectCode: string): string {
  return `${TASK_PREFIX}-${sanitizeServiceNameSegment(tenantCode)}-${sanitizeServiceNameSegment(projectCode)}`
}

/**
 * Lists all per-project scheduled tasks registered by this CLI.
 *
 * Queries Task Scheduler for tasks whose name starts with `${TASK_PREFIX}-`.
 * Returns an empty list when schtasks is unavailable or no task matches.
 */
export function getAllProjectTasks(): Array<{ taskName: string }> {
  const prefix = `${TASK_PREFIX}-`
  const results: Array<{ taskName: string }> = []
  try {
    // /FO CSV /NH → bare rows; first column is "\TaskName" (leading backslash
    // = root folder). Strip the leading backslash and surrounding quotes.
    const output = execSync('schtasks /Query /FO CSV /NH', { stdio: 'pipe' }).toString()
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const firstCol = trimmed.split('","')[0].replace(/^"/, '').replace(/"$/, '')
      const name = firstCol.replace(/^\\/, '')
      if (name.startsWith(prefix) && !results.some((r) => r.taskName === name)) {
        results.push({ taskName: name })
      }
    }
  } catch {
    // schtasks unavailable / no tasks — return empty list
  }
  return results
}

// ---------------------------------------------------------------------------
// Task XML + wrapper generation
// ---------------------------------------------------------------------------

/**
 * Generate the scheduled-task XML that runs a per-project wrapper script.
 * The action invokes cmd.exe on the generated run.cmd so the wrapper can set
 * env vars and run `docker run` without leaking secrets onto the task's
 * command line (which is world-readable via `schtasks /Query /XML`).
 */
export function generateProjectTaskXml(opts: { wrapperScriptPath: string }): string {
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
      <Command>cmd.exe</Command>
      <Arguments>/c ${escapeXml(`"${opts.wrapperScriptPath}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>`
}

/**
 * Windows batch (cmd.exe) cannot reliably escape every metacharacter the way a
 * POSIX shell can with single quotes. Rather than risk a broken or injectable
 * `set "VAR=value"` line, reject values containing characters that have special
 * meaning to cmd.exe so the user fixes the bad value instead of silently
 * generating a broken wrapper. Tokens / URLs / API keys never legitimately
 * contain these. (No fallback — see the project "no fallback" rule.)
 */
// Forbid cmd.exe metacharacters: % (var expansion), ! (delayed expansion),
// " (quote), CR/LF, ^ (escape/continuation), & (command separator), <>| (redir
// /pipe), and ()  (block grouping — harmless inside `set "..."` but rejected as
// defense in depth). A leading/trailing space is rejected separately below
// because `set " VAR=..."` would create a space-prefixed variable name that the
// `-e VAR` inherit line could never match.
const CMD_FORBIDDEN_RE = /[%!"\r\n^&<>|()]/

function assertCmdSafe(value: string, field: string): void {
  if (CMD_FORBIDDEN_RE.test(value) || value !== value.trim()) {
    throw new Error(t('service.invalidWin32Value', { field }))
  }
}

/**
 * Generate a cmd.exe batch wrapper that runs docker for one project.
 *
 * Mirrors the Linux/Darwin wrappers: bind-mounts the per-project config dir and
 * project dir, passes the token / api url / API keys as `-e` env vars, resolves
 * the installed CLI version at runtime, auto-builds the image if missing, and
 * removes any stale container before `docker run`.
 */
export function generateWin32WrapperScript(opts: {
  imageName: string
  tenantCode: string
  projectCode: string
  projectConfigHostDir: string
  projectDir?: string
  token: string
  apiUrl: string
  anthropicApiKey?: string
  claudeCodeOauthToken?: string
  codexApiKey?: string
  codexAccessToken?: string
  verbose?: boolean
}): string {
  const containerHome = '/home/node'
  const containerConfigDir = `${containerHome}/.ai-support-agent`
  const homeDir = os.homedir()
  const containerApiUrl = toContainerApiUrl(opts.apiUrl)

  // Reject codes whose characters would break container naming / the dir map.
  assertProjectCodeIsSafe(opts.projectCode)
  assertProjectCodeIsSafe(opts.tenantCode)
  // Reject secret/url values that cmd.exe cannot safely carry.
  assertCmdSafe(opts.token, 'token')
  assertCmdSafe(containerApiUrl, 'apiUrl')
  if (opts.anthropicApiKey) assertCmdSafe(opts.anthropicApiKey, 'anthropicApiKey')
  if (opts.claudeCodeOauthToken) assertCmdSafe(opts.claudeCodeOauthToken, 'claudeCodeOauthToken')
  if (opts.codexApiKey) assertCmdSafe(opts.codexApiKey, 'codexApiKey')
  if (opts.codexAccessToken) assertCmdSafe(opts.codexAccessToken, 'codexAccessToken')

  const containerProjectDir = `/workspace/projects/${opts.projectCode}`
  // `||` (not `??`) so an empty projectDir falls back to the default; an empty
  // host path would emit `-v :/workspace/...:rw` which docker rejects.
  const hostProjectDir = opts.projectDir || path.dirname(opts.projectConfigHostDir)

  const containerName = `ai-${sanitizeServiceNameSegment(opts.tenantCode)}-${sanitizeServiceNameSegment(opts.projectCode)}`

  // docker run argument lines. Host paths are wrapped in double quotes so a
  // space in the Windows home dir (e.g. C:\Users\First Last) does not split the
  // -v argument. The values were validated above to contain no `"`.
  const mountLines: string[] = [
    `  -v "${homeDir}\\.claude:${containerHome}/.claude:rw" ^`,
    `  -v "${homeDir}\\.codex:${containerHome}/.codex:rw" ^`,
    `  -v "${opts.projectConfigHostDir}:${containerConfigDir}:rw" ^`,
    `  -v "${homeDir}\\.claude.json:${containerHome}/.claude.json:rw" ^`,
    `  -v "${hostProjectDir}:${containerProjectDir}:rw" ^`,
  ]

  const envLines: string[] = [
    `  -e AI_SUPPORT_AGENT_IN_DOCKER=1 ^`,
    `  -e HOME=${containerHome} ^`,
    `  -e CODEX_HOME=${containerHome}/.codex ^`,
    `  -e AI_SUPPORT_AGENT_CONFIG_DIR=${containerConfigDir} ^`,
    // `-e NAME` (no value) tells docker to inherit the value from the wrapper's
    // own environment, which we set via `set` below. This keeps secrets off the
    // `docker run` argument vector.
    `  -e AI_SUPPORT_AGENT_TOKEN ^`,
    `  -e AI_SUPPORT_AGENT_API_URL ^`,
    `  -e AI_SUPPORT_AGENT_PROJECT_DIR_MAP ^`,
  ]
  if (opts.anthropicApiKey) envLines.push(`  -e ANTHROPIC_API_KEY ^`)
  if (opts.claudeCodeOauthToken) envLines.push(`  -e CLAUDE_CODE_OAUTH_TOKEN ^`)
  if (opts.codexApiKey) envLines.push(`  -e CODEX_API_KEY ^`)
  if (opts.codexAccessToken) envLines.push(`  -e CODEX_ACCESS_TOKEN ^`)

  const containerArgs = [
    'ai-support-agent', 'start', CLI_FLAG_NO_DOCKER,
    `--project ${opts.tenantCode}/${opts.projectCode}`,
  ]
  if (opts.verbose) containerArgs.push(CLI_FLAG_VERBOSE)

  const setLines: string[] = [
    `set "AI_SUPPORT_AGENT_TOKEN=${opts.token}"`,
    `set "AI_SUPPORT_AGENT_API_URL=${containerApiUrl}"`,
    `set "AI_SUPPORT_AGENT_PROJECT_DIR_MAP=${opts.projectCode}=${containerProjectDir}"`,
  ]
  if (opts.anthropicApiKey) setLines.push(`set "ANTHROPIC_API_KEY=${opts.anthropicApiKey}"`)
  if (opts.claudeCodeOauthToken) setLines.push(`set "CLAUDE_CODE_OAUTH_TOKEN=${opts.claudeCodeOauthToken}"`)
  if (opts.codexApiKey) setLines.push(`set "CODEX_API_KEY=${opts.codexApiKey}"`)
  if (opts.codexAccessToken) setLines.push(`set "CODEX_ACCESS_TOKEN=${opts.codexAccessToken}"`)

  const dockerRun = [
    `docker run --rm -i --name "${containerName}" ^`,
    mountLines.join('\r\n'),
    envLines.join('\r\n'),
    `  "%IMAGE_TAG%" ^`,
    `  ${containerArgs.join(' ')}`,
  ].join('\r\n')

  // NOTE: `setlocal` scopes the `set` secrets to this wrapper invocation so
  // they never leak into the parent environment. EnableExtensions is needed for
  // the `if` blocks. We deliberately do NOT enable delayed expansion so a `!`
  // in a value cannot trigger expansion (and `!` is rejected above anyway).
  const lines = [
    `@echo off`,
    `setlocal EnableExtensions`,
    ``,
    `rem Resolve the installed CLI version at runtime so the image stays current after npm updates.`,
    `rem usebackq lets the command be wrapped in backquotes so the inner node -p`,
    `rem double quotes don't confuse for /f's parser, and a space in the npm root`,
    `rem path (e.g. C:\\Program Files\\...) stays inside the JS string literal.`,
    `for /f "usebackq delims=" %%R in (\`npm root -g 2^>nul\`) do set "_NPM_ROOT=%%R"`,
    `if not defined _NPM_ROOT (`,
    `  echo ERROR: Could not determine npm global root 1>&2`,
    `  exit /b 1`,
    `)`,
    `for /f "usebackq delims=" %%V in (\`node -p "require('%_NPM_ROOT:\\=/%/@ai-support-agent/cli/package.json').version" 2^>nul\`) do set "_INSTALLED_VERSION=%%V"`,
    `if not defined _INSTALLED_VERSION (`,
    `  echo ERROR: Could not determine installed version of @ai-support-agent/cli 1>&2`,
    `  exit /b 1`,
    `)`,
    `set "IMAGE_TAG=${opts.imageName}:%_INSTALLED_VERSION%"`,
    ``,
    `rem Auto-build the image if the required version does not exist locally`,
    `docker image inspect "%IMAGE_TAG%" >nul 2>&1`,
    `if errorlevel 1 (`,
    `  echo Docker image %IMAGE_TAG% not found - building... 1>&2`,
    `  call ai-support-agent docker-build`,
    `  if errorlevel 1 (`,
    `    echo ERROR: docker-build failed - cannot start container 1>&2`,
    `    exit /b 1`,
    `  )`,
    `)`,
    ``,
    `rem Remove any stale container from a previous crash`,
    `docker rm -f "${containerName}" >nul 2>&1`,
    ``,
    ...setLines,
    ``,
    dockerRun,
    ``,
    `endlocal`,
  ]
  return lines.join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// Service file writing
// ---------------------------------------------------------------------------

/**
 * Write the run.cmd wrapper and register/refresh the scheduled task for one
 * project. Idempotent: deletes any existing task with the same name first so
 * token/config updates take effect.
 */
export function writeAndRegisterProjectTask(
  project: ProjectRegistration,
  options: { verbose?: boolean } = {},
): void {
  const { tenantCode, projectCode } = project
  assertProjectCodeIsSafe(projectCode)
  assertProjectCodeIsSafe(tenantCode)
  const projectKey = `${tenantCode}-${projectCode.toLowerCase()}`

  // mode 0o700 keeps the per-project metadata, services, and logs owner-only.
  // The run.cmd wrapper written below contains the token in plaintext, so the
  // service dir must not be world-readable. On Windows the POSIX mode bits are
  // only partially honored, but we set them for parity with darwin/linux and so
  // the wrapper is at least not group/other-writable on filesystems that map
  // them (e.g. WSL/SMB shares).
  const logDir = getLogDir()
  const projectLogDir = getProjectLogDir(logDir, projectKey)
  if (!fs.existsSync(projectLogDir)) {
    fs.mkdirSync(projectLogDir, { recursive: true, mode: 0o700 })
  }

  const servicesDir = getServicesDir()
  const projectServiceDir = getProjectServiceDir(servicesDir, projectKey)
  if (!fs.existsSync(projectServiceDir)) {
    fs.mkdirSync(projectServiceDir, { recursive: true, mode: 0o700 })
  }

  const projectConfigHostDir = getProjectConfigHostDir(tenantCode, projectCode)
  if (!fs.existsSync(projectConfigHostDir)) {
    fs.mkdirSync(projectConfigHostDir, { recursive: true, mode: 0o700 })
  }

  const validatedProjectDir = validateProjectDirForMount(project.projectDir)

  const wrapperScriptPath = getWin32WrapperScriptPath(projectServiceDir)
  const wrapperScript = generateWin32WrapperScript({
    imageName: IMAGE_NAME,
    tenantCode,
    projectCode,
    projectConfigHostDir,
    projectDir: validatedProjectDir,
    token: project.token,
    apiUrl: project.apiUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeCodeOauthToken: process.env[ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN],
    codexApiKey: process.env.CODEX_API_KEY,
    codexAccessToken: process.env.CODEX_ACCESS_TOKEN,
    verbose: options.verbose,
  })
  // The wrapper holds the token in plaintext — write it owner-only.
  fs.writeFileSync(wrapperScriptPath, wrapperScript, { encoding: 'utf-8', mode: 0o700 })

  const taskName = getProjectTaskName(tenantCode, projectCode)
  const xml = generateProjectTaskXml({ wrapperScriptPath })
  const tmpXmlPath = path.join(os.tmpdir(), `${taskName}-task.xml`)
  try {
    fs.writeFileSync(tmpXmlPath, xml, 'utf-8')
    // /F overwrites an existing task so token/config updates take effect.
    execSync(`schtasks /Create /TN "${taskName}" /XML "${tmpXmlPath}" /F`, { stdio: 'pipe' })
  } finally {
    if (fs.existsSync(tmpXmlPath)) {
      fs.unlinkSync(tmpXmlPath)
    }
  }
}

export class Win32ServiceStrategy implements ServiceStrategy {
  install(options: ServiceOptions): void {
    const config = loadConfig()
    const projects = config ? getProjectList(config) : []

    if (projects.length === 0) {
      logger.error(t('service.noProjectsConfigured'))
      return
    }

    const entryPoint = getCliEntryPoint()
    if (!fs.existsSync(entryPoint)) {
      logger.error(t('service.entryPointNotFound', { path: entryPoint }))
      return
    }

    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    // Detect sanitizeServiceNameSegment() collisions where two valid codes map to the same task
    // name. Shared helper guarantees identical semantics with linux/darwin.
    const { collisions } = detectInstallCollisions(projects, getProjectTaskName)
    const reportedCollisionLabels = new Set<string>()

    let installedCount = 0
    let failedCount = 0
    for (const project of projects) {
      const { projectCode } = project
      const fqn = `${project.tenantCode}/${projectCode}`
      const collision = collisions.get(fqn)
      if (collision) {
        const messageKey = collision.isDuplicate
          ? 'service.projectDuplicateEntry'
          : 'service.projectUnitNameCollision'
        const dedupKey = `${collision.name}\x00${messageKey}`
        if (!reportedCollisionLabels.has(dedupKey)) {
          logger.error(t(messageKey, {
            projectCode,
            unitName: collision.name,
            others: collision.others.join(', '),
          }))
          reportedCollisionLabels.add(dedupKey)
        }
        failedCount += 1
        continue
      }
      try {
        writeAndRegisterProjectTask(project, { verbose: options.verbose })
        logger.success(t('service.projectInstalled', { projectCode, path: getProjectTaskName(project.tenantCode, projectCode) }))
        installedCount += 1
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('service.projectInstallFailed', { projectCode, message }))
        failedCount += 1
      }
    }

    if (installedCount > 0) {
      logger.info(t('service.loadHintMulti'))
      logger.info(t('service.logDir', { path: logDir }))
      logger.info(t('service.noLogRotation'))
    }

    if (failedCount > 0) {
      logger.warn(t('service.partialInstallSummary', {
        failed: String(failedCount),
        total: String(projects.length),
        succeeded: String(installedCount),
      }))
    }
  }

  uninstall(): void {
    const projectTasks = getAllProjectTasks()

    if (projectTasks.length === 0) {
      logger.warn(t('service.notInstalled.win32'))
      return
    }

    let failed = false
    for (const { taskName } of projectTasks) {
      try {
        execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'pipe' })
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('service.schtasksFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.uninstalled.win32'))
    }
  }

  start(): void {
    const projectTasks = getAllProjectTasks()

    if (projectTasks.length === 0) {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    let failed = false
    for (const { taskName } of projectTasks) {
      try {
        execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('service.startFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.started'))
    }
  }

  stop(): void {
    const projectTasks = getAllProjectTasks()

    if (projectTasks.length === 0) {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    let failed = false
    for (const { taskName } of projectTasks) {
      try {
        execSync(`schtasks /End /TN "${taskName}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('service.stopFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.stopped'))
    }
  }

  restart(): void {
    const projectTasks = getAllProjectTasks()

    if (projectTasks.length === 0) {
      logger.error(t('service.notInstalled.win32'))
      return
    }

    let failed = false
    for (const { taskName } of projectTasks) {
      try {
        try {
          execSync(`schtasks /End /TN "${taskName}"`, { stdio: 'pipe' })
        } catch {
          // Task may not be running — ignore
        }
        execSync(`schtasks /Run /TN "${taskName}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('service.restartFailed', { message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.restarted'))
    }
  }

  status(): ServiceStatus {
    const projectTasks = getAllProjectTasks()
    const logDir = getLogDir()

    if (projectTasks.length === 0) {
      return { installed: false, running: false }
    }

    // Build a reverse map from task name → original projectCode using config.
    // sanitizeServiceNameSegment() collapses `_` and other chars to `-`, so splitting the task
    // name on `-` is lossy when tenant/project codes contain those characters
    // (and the tenant/project boundary is ambiguous) — config is the source of
    // truth. Mirrors the Linux strategy.
    const config = loadConfig()
    const projectByTaskName = new Map<string, string>()
    if (config) {
      for (const project of getProjectList(config)) {
        projectByTaskName.set(
          getProjectTaskName(project.tenantCode, project.projectCode),
          project.projectCode,
        )
      }
    }

    const projects: ProjectStatus[] = []
    let isAnyRunning = false

    for (const { taskName } of projectTasks) {
      // Prefer the canonical projectCode from config. For orphaned tasks no
      // longer in config, fall back to the task name with the brand prefix
      // stripped so users still see something close to the original code.
      const projectCode = projectByTaskName.get(taskName)
        ?? (taskName.startsWith(`${TASK_PREFIX}-`) ? taskName.slice(TASK_PREFIX.length + 1) : taskName)
      let running = false
      try {
        const output = execSync(`schtasks /Query /TN "${taskName}" /FO CSV /NH`, { stdio: 'pipe' }).toString()
        if (output.includes('Running')) {
          running = true
          isAnyRunning = true
        }
      } catch {
        // Not registered / query failed — running stays false
      }
      projects.push({ label: taskName, projectCode, running })
    }

    return { installed: true, running: isAnyRunning, logDir, projects }
  }
}

// Backward-compat: keep generateTaskXml exported for any external callers.
// Generates a single-task XML (legacy single-project form) — no longer used by
// the multi-project install path above.
export function generateTaskXml(options: ServiceConfig): string {
  const { nodePath, entryPoint, verbose, docker } = options
  const args = [entryPoint, 'start']
  if (!docker) args.push(CLI_FLAG_NO_DOCKER)
  if (verbose) args.push(CLI_FLAG_VERBOSE)

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
