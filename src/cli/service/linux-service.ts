import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { loadConfig, getProjectList } from '../../config-manager'
import { IMAGE_NAME } from '../../docker/docker-utils'
import { t } from '../../i18n'
import { logger } from '../../logger'
import type { ProjectRegistration } from '../../types'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type {
  ProjectStatus,
  ServiceConfig,
  ServiceOptions,
  ServiceStatus,
  ServiceStrategy,
} from './types'

export { getCliEntryPoint, getNodePath }

const SERVICE_NAME = 'ai-support-agent.service'
const SERVICE_PREFIX = 'ai-support-agent'

function getSystemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user')
}

function getLogDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'ai-support-agent', 'logs')
}

// ---------------------------------------------------------------------------
// Per-project unit helpers
// ---------------------------------------------------------------------------

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

/**
 * POSIX shell single-quote a value so it can be safely interpolated into a
 * bash script. Wraps the value in single quotes and escapes any embedded
 * single quote as `'\''`. The result is always exactly one shell argument.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Write a file with content and enforce mode. `fs.writeFileSync({ mode })`
 * only applies the mode when the file is *created*; overwriting an existing
 * file inherits the prior permissions, so a previously world-readable
 * wrapper script (e.g. left by an older install or an out-of-band edit)
 * would retain its lax mode despite containing bearer tokens. Explicit
 * chmod after write guarantees the desired permissions either way.
 */
function writeFileEnsuringMode(filePath: string, content: string, mode: number): void {
  fs.writeFileSync(filePath, content, { mode })
  fs.chmodSync(filePath, mode)
}

/**
 * Escape a value for use inside a systemd unit (ExecStart, Environment, etc.).
 * Per `man 5 systemd.service`, `man 5 systemd.exec` and `man 5 systemd.unit`:
 * - Backslash is the escape character; the literal backslash must be written
 *   as `\\`.
 * - `$` in command lines triggers Environment variable expansion (`$FOO`); the
 *   literal dollar sign must be written as `$$`.
 * - `%` triggers specifier expansion (`%h`, `%u`, etc.); the literal percent
 *   sign must be written as `%%`.
 * - Whitespace separates argv tokens and must be escaped as `\x20`.
 * - Double-quote, tab, and newline also need backslash escaping.
 *
 * Ordering matters: backslash MUST be doubled first so that the backslashes
 * we subsequently introduce (e.g. `\"`, `\x20`) are not themselves re-doubled.
 * `$` → `$$` and `%` → `%%` are independent of the backslash pass because
 * they don't introduce a backslash. In JS replace strings, `$$` denotes a
 * literal `$`, so `'$$$$'` produces `$$` and `'%%'` produces `%%`.
 */
function systemdEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/ /g, '\\x20')
}

/** Returns the systemd unit name for a given project (without .service suffix) */
export function getProjectUnitName(tenantCode: string, projectCode: string): string {
  return `${SERVICE_PREFIX}-${sanitize(tenantCode)}-${sanitize(projectCode)}`
}

/** Returns the .service file path for a given project */
export function getProjectUnitFilePath(tenantCode: string, projectCode: string): string {
  return path.join(getSystemdUserDir(), `${getProjectUnitName(tenantCode, projectCode)}.service`)
}

/** Lists all per-project unit files under ~/.config/systemd/user */
export function getAllProjectUnits(): Array<{ unitName: string; unitPath: string }> {
  const systemdDir = getSystemdUserDir()
  const prefix = `${SERVICE_PREFIX}-`
  const results: Array<{ unitName: string; unitPath: string }> = []
  try {
    const files = fs.readdirSync(systemdDir)
    for (const file of files) {
      if (
        file.startsWith(prefix) &&
        file.endsWith('.service') &&
        file !== SERVICE_NAME
      ) {
        const unitName = file.slice(0, -'.service'.length)
        results.push({ unitName, unitPath: path.join(systemdDir, file) })
      }
    }
  } catch {
    // systemd user dir doesn't exist yet — return empty list
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

function getUpdateScriptPath(): string {
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')
  return path.join(configDir, 'update-and-restart.sh')
}

// ---------------------------------------------------------------------------
// Legacy single-unit generation (kept for backward compatibility / tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-project unit generation
// ---------------------------------------------------------------------------

/** Generate a systemd unit that runs a wrapper shell script for one project */
export function generateProjectServiceUnit(opts: {
  unitName: string
  wrapperScriptPath: string
  logDir: string
}): string {
  const escapedWrapper = systemdEscape(opts.wrapperScriptPath)
  const escapedHome = systemdEscape(os.homedir())
  const escapedOutLog = systemdEscape(path.join(opts.logDir, 'agent.out.log'))
  const escapedErrLog = systemdEscape(path.join(opts.logDir, 'agent.err.log'))
  return `[Unit]
Description=AI Support Agent (${opts.unitName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash ${escapedWrapper}
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${escapedHome}
StandardOutput=append:${escapedOutLog}
StandardError=append:${escapedErrLog}

[Install]
WantedBy=default.target
`
}

/** Convert localhost/127.0.0.1 to host.docker.internal for container use */
function toContainerApiUrl(apiUrl: string): string {
  // The host portion must be terminated by `:`, `/`, or end-of-string;
  // otherwise URLs like `http://localhost.example.com` would partially match
  // and produce `http://host.docker.internal.example.com` (a different host).
  return apiUrl.replace(
    /^(https?:\/\/)(localhost|127\.0\.0\.1)(?=$|[:/])/,
    (_, scheme: string) => `${scheme}host.docker.internal`,
  )
}

/** Generate a bash wrapper script that runs docker for one project */
export function generateWrapperScript(opts: {
  imageName: string
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

  // All user-supplied values (paths, tokens, URLs, API keys) are interpolated
  // into a generated bash script. Shell-quote every value to defend against
  // whitespace, shell metacharacters (`$`, backticks, `"`), and outright
  // injection from a malicious or malformed token / env var.
  const qProjectConfig = shellQuote(opts.projectConfigHostDir)
  const qContainerHome = shellQuote(containerHome)
  const qContainerConfigDir = shellQuote(containerConfigDir)
  const qToken = shellQuote(opts.token)
  const qApiUrl = shellQuote(containerApiUrl)
  const qImageName = shellQuote(opts.imageName)
  const qUpdateScriptPath = shellQuote(opts.updateScriptPath)
  // tenant/project are sanitized to [a-z0-9-] for container name and the
  // --project value, so they're shell-safe; still quote for defense in depth.
  const containerName = `ai-${sanitize(opts.tenantCode)}-${sanitize(opts.projectCode)}`
  const qContainerName = shellQuote(containerName)
  const qProjectArg = shellQuote(`${opts.tenantCode}/${opts.projectCode}`)

  const mountLines: string[] = [
    `  -v ${shellQuote(`${homeDir}/.claude:${containerHome}/.claude:rw`)} \\`,
    `  -v ${shellQuote(`${opts.projectConfigHostDir}:${containerConfigDir}:rw`)} \\`,
    `  -v ${shellQuote(`${homeDir}/.claude.json:${containerHome}/.claude.json:rw`)} \\`,
  ]

  if (opts.projectDir) {
    const containerProjectDir = `/workspace/projects/${opts.projectCode}`
    mountLines.push(`  -v ${shellQuote(`${opts.projectDir}:${containerProjectDir}:rw`)} \\`)
  }

  const envLines: string[] = [
    `  -e AI_SUPPORT_AGENT_IN_DOCKER=1 \\`,
    `  -e HOME=${qContainerHome} \\`,
    `  -e AI_SUPPORT_AGENT_CONFIG_DIR=${qContainerConfigDir} \\`,
    `  -e AI_SUPPORT_AGENT_TOKEN=${qToken} \\`,
    `  -e AI_SUPPORT_AGENT_API_URL=${qApiUrl} \\`,
  ]
  if (opts.anthropicApiKey) {
    envLines.push(`  -e ANTHROPIC_API_KEY=${shellQuote(opts.anthropicApiKey)} \\`)
  }
  if (opts.claudeCodeOauthToken) {
    envLines.push(`  -e CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(opts.claudeCodeOauthToken)} \\`)
  }

  const containerArgs = [
    'ai-support-agent', 'start', '--no-docker',
    `--project ${qProjectArg}`,
  ]
  if (opts.verbose) containerArgs.push('--verbose')

  return `#!/bin/bash
set -uo pipefail

# Load nvm if available so that node/npm are on PATH when launched as a systemd service
export NVM_DIR="\${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "\${NVM_DIR}/nvm.sh" ] && source "\${NVM_DIR}/nvm.sh"
# Also try common system locations as fallback
export PATH="/usr/local/bin:/usr/bin:/bin:\${PATH}"

REBUILD_MARKER=${qProjectConfig}/docker-rebuild-needed
if [ -f "$REBUILD_MARKER" ]; then
  rm -f "$REBUILD_MARKER"
  ai-support-agent docker-build 2>/dev/null || true
fi

# Resolve the installed version at runtime so the image stays current after npm updates
_NPM_ROOT=$(npm root -g 2>/dev/null)
_CLI_PKG_JSON="\${_NPM_ROOT}/@ai-support-agent/cli/package.json"
_INSTALLED_VERSION=$(node -p "require('\${_CLI_PKG_JSON}').version" 2>/dev/null || echo "")
if [ -z "$_INSTALLED_VERSION" ]; then
  echo "ERROR: Could not determine installed version of @ai-support-agent/cli" >&2
  exit 1
fi
IMAGE_TAG=${qImageName}:\${_INSTALLED_VERSION}

# Auto-build Docker image if the required version does not exist locally
if ! docker image inspect "\$IMAGE_TAG" >/dev/null 2>&1; then
  echo "Docker image \$IMAGE_TAG not found — building..." >&2
  ai-support-agent docker-build || { echo "ERROR: docker-build failed — cannot start container" >&2; exit 1; }
fi

# Remove stale container if it exists (e.g. from a previous crash)
docker rm -f ${qContainerName} 2>/dev/null || true

# Run the container as the invoking user so that bind-mounted host
# directories (token wrapper, project config, .claude state) remain
# writable inside the container. The docker image's entrypoint adds
# the runtime UID to /etc/passwd dynamically so unknown UIDs still
# get a usable home. Without --user, root inside the container can't
# write to host paths owned by the unprivileged service user under
# rootless docker / userns-remap setups (EACCES on mkdir).
_DOCKER_UID=$(id -u)
_DOCKER_GID=$(id -g)

docker run --rm -i --name ${qContainerName} \\
  --user "\${_DOCKER_UID}:\${_DOCKER_GID}" \\
${mountLines.join('\n')}
${envLines.join('\n')}
  "\$IMAGE_TAG" \\
  ${containerArgs.join(' ')}

EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 42 ]; then
  exec ${qUpdateScriptPath}
fi

exit "$EXIT_CODE"
`
}

/** Generate the update-and-restart.sh script for systemd */
export function generateUpdateScript(): string {
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')

  // Quote interpolated paths so a HOME / config dir containing whitespace
  // or shell metacharacters doesn't word-split the generated script.
  const qSystemdDir = shellQuote(getSystemdUserDir())
  const qVersionFile = shellQuote(path.join(configDir, 'update-version.json'))

  return `#!/bin/bash
set -uo pipefail
shopt -s nullglob

# Load nvm if available so that node/npm are on PATH when launched from systemd
export NVM_DIR="\${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "\${NVM_DIR}/nvm.sh" ] && source "\${NVM_DIR}/nvm.sh"
export PATH="/usr/local/bin:/usr/bin:/bin:\${PATH}"

LOG_PREFIX="[update-and-restart $(date -u '+%Y-%m-%dT%H:%M:%SZ')]"

# Best-effort secret redaction for command output that we echo to stderr.
redact_secrets() {
  sed -E \\
    -e 's#(Bearer )[A-Za-z0-9._-]+#\\1***REDACTED***#gi' \\
    -e 's#(authToken[[:space:]]*[:=][[:space:]]*"?)[^"[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(_authToken[[:space:]]*[:=][[:space:]]*"?)[^"[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(X-Auth-Token:[[:space:]]*)[^[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(https?://)[^/:[:space:]@]+:[^@/[:space:]]+@#\\1***REDACTED***@#gi'
}

SYSTEMD_USER_DIR=${qSystemdDir}

# 1. Stop all per-project systemd services. systemctl does not glob unit
# names itself, so expand via the shell and stop each unit individually.
for unit_path in "$SYSTEMD_USER_DIR"/${SERVICE_PREFIX}-*.service; do
  [ -f "$unit_path" ] || continue
  unit_name=$(basename "$unit_path")
  # Skip the legacy aggregate unit if it happens to match the prefix.
  if [ "$unit_name" = "${SERVICE_NAME}" ]; then
    continue
  fi
  systemctl --user stop "$unit_name" 2>/dev/null || true
done

# 2. Install new version if update-version.json exists.
VERSION_FILE=${qVersionFile}
_INSTALL_OK=true
if [ -f "$VERSION_FILE" ]; then
  # Pass the path via env var so an apostrophe (or other JS string metachar) in
  # HOME or AI_SUPPORT_AGENT_CONFIG_DIR cannot break the JS string literal.
  NEW_VERSION=$(VERSION_FILE="$VERSION_FILE" node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.VERSION_FILE,'utf-8')).version||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
  rm -f "$VERSION_FILE"
  if [ -n "$NEW_VERSION" ]; then
    NPM_OUTPUT=$(npm install -g "@ai-support-agent/cli@$NEW_VERSION" --quiet 2>&1)
    NPM_STATUS=$?
    if [ "$NPM_STATUS" -ne 0 ]; then
      echo "$LOG_PREFIX ERROR: npm install -g @ai-support-agent/cli@$NEW_VERSION failed (exit $NPM_STATUS)" >&2
      printf '%s\\n' "$NPM_OUTPUT" | redact_secrets >&2
      _INSTALL_OK=false
    else
      SI_OUTPUT=$(ai-support-agent service install 2>&1)
      SI_STATUS=$?
      if [ "$SI_STATUS" -ne 0 ]; then
        echo "$LOG_PREFIX ERROR: ai-support-agent service install failed (exit $SI_STATUS)" >&2
        printf '%s\\n' "$SI_OUTPUT" | redact_secrets >&2
        _INSTALL_OK=false
      fi
    fi
  fi
fi

# 3. Reload systemd and restart all per-project services (always, even if install failed)
systemctl --user daemon-reload || true

_RELOAD_FAILED=0
for unit_path in "$SYSTEMD_USER_DIR"/${SERVICE_PREFIX}-*.service; do
  [ -f "$unit_path" ] || continue
  unit_name=$(basename "$unit_path")
  # Skip the legacy aggregate unit
  if [ "$unit_name" = "${SERVICE_NAME}" ]; then
    continue
  fi
  if ! systemctl --user start "$unit_name" 2>&1; then
    echo "$LOG_PREFIX ERROR: systemctl --user start $unit_name failed" >&2
    _RELOAD_FAILED=$((_RELOAD_FAILED + 1))
  fi
done

if [ "$_RELOAD_FAILED" -gt 0 ]; then
  echo "$LOG_PREFIX ERROR: $_RELOAD_FAILED systemd unit(s) failed to restart" >&2
fi

if [ "$_INSTALL_OK" = "false" ] || [ "$_RELOAD_FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
`
}

// ---------------------------------------------------------------------------
// Per-project file writing
// ---------------------------------------------------------------------------

/**
 * Write run.sh and systemd unit for a single project. Does NOT systemctl start.
 * Returns the unit file path.
 */
export function writeProjectServiceFiles(
  project: ProjectRegistration,
  options: { verbose?: boolean } = {},
): string {
  const { tenantCode, projectCode } = project
  const projectKey = `${sanitize(tenantCode)}-${sanitize(projectCode)}`

  const logDir = getLogDir()
  const projectLogDir = path.join(logDir, projectKey)
  if (!fs.existsSync(projectLogDir)) {
    fs.mkdirSync(projectLogDir, { recursive: true, mode: 0o700 })
  }

  const systemdDir = getSystemdUserDir()
  if (!fs.existsSync(systemdDir)) {
    fs.mkdirSync(systemdDir, { recursive: true })
  }

  const servicesDir = getServicesDir()
  const projectServiceDir = path.join(servicesDir, projectKey)
  if (!fs.existsSync(projectServiceDir)) {
    fs.mkdirSync(projectServiceDir, { recursive: true, mode: 0o700 })
  }

  const projectConfigHostDir = getProjectConfigHostDir(tenantCode, projectCode)
  if (!fs.existsSync(projectConfigHostDir)) {
    fs.mkdirSync(projectConfigHostDir, { recursive: true, mode: 0o700 })
  }

  const updateScriptPath = getUpdateScriptPath()
  const wrapperScriptPath = path.join(projectServiceDir, 'run.sh')
  const wrapperScript = generateWrapperScript({
    imageName: IMAGE_NAME,
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
  // 0o700 — wrapper embeds the agent token (and optionally ANTHROPIC_API_KEY
  // / CLAUDE_CODE_OAUTH_TOKEN) as shell-quoted literals. See writeFileEnsuringMode.
  writeFileEnsuringMode(wrapperScriptPath, wrapperScript, 0o700)

  const unitName = getProjectUnitName(tenantCode, projectCode)
  const unitPath = getProjectUnitFilePath(tenantCode, projectCode)
  const unit = generateProjectServiceUnit({ unitName, wrapperScriptPath, logDir: projectLogDir })
  fs.writeFileSync(unitPath, unit, 'utf-8')

  return unitPath
}

/**
 * Install service files and immediately start a single project via systemctl.
 * Idempotent: stops any existing service before starting so that token/config
 * updates take effect immediately.
 */
export function installAndStartProject(
  project: ProjectRegistration,
  options: { verbose?: boolean } = {},
): void {
  const updateScriptPath = getUpdateScriptPath()
  const updateScript = generateUpdateScript()
  writeFileEnsuringMode(updateScriptPath, updateScript, 0o700)

  writeProjectServiceFiles(project, options)
  const unitName = getProjectUnitName(project.tenantCode, project.projectCode)
  const unitFile = `${unitName}.service`

  // Reload systemd so the new/updated unit is recognised. Use the same
  // diagnostic key as the strategy install() so support logs can correlate.
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(t('service.daemonReloadFailed', { message }))
    return
  }

  // Stop first so that updated run.sh / token changes take effect.
  try { execSync(`systemctl --user stop "${unitFile}"`, { stdio: 'pipe' }) } catch { /* not running */ }

  // Enable so the service starts on login. Warn (don't fail) on errors —
  // common cases are missing user instance (linger off on shared hosts),
  // which still allows start to succeed for the current session.
  try {
    execSync(`systemctl --user enable "${unitFile}"`, { stdio: 'pipe' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(t('service.enableFailed', { unit: unitFile, message }))
  }

  try {
    execSync(`systemctl --user start "${unitFile}"`, { stdio: 'pipe' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(t('service.loadWarning', { label: `${unitName}: ${message}` }))
    return
  }

  // Verify the service is actually active after start.
  try {
    const out = execSync(`systemctl --user is-active "${unitFile}"`, { stdio: 'pipe' }).toString().trim()
    if (out !== 'active') {
      logger.warn(t('service.loadWarning', { label: unitName }))
    }
  } catch {
    logger.warn(t('service.loadWarning', { label: unitName }))
  }
}

// ---------------------------------------------------------------------------
// LinuxServiceStrategy
// ---------------------------------------------------------------------------

export class LinuxServiceStrategy implements ServiceStrategy {
  install(options: ServiceOptions): void {
    const config = loadConfig()
    const projects = config ? getProjectList(config) : []

    if (projects.length === 0) {
      logger.error(t('service.noProjectsConfigured'))
      return
    }

    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    const systemdDir = getSystemdUserDir()
    if (!fs.existsSync(systemdDir)) {
      fs.mkdirSync(systemdDir, { recursive: true })
    }

    const updateScriptPath = getUpdateScriptPath()
    const updateScript = generateUpdateScript()
    writeFileEnsuringMode(updateScriptPath, updateScript, 0o700)

    const writtenUnits: Array<{ projectCode: string; unitPath: string; unitFile: string }> = []
    const expectedUnitNames = new Set<string>()
    for (const project of projects) {
      const unitPath = writeProjectServiceFiles(project, { verbose: options.verbose })
      const unitName = getProjectUnitName(project.tenantCode, project.projectCode)
      expectedUnitNames.add(unitName)
      writtenUnits.push({
        projectCode: project.projectCode,
        unitPath,
        unitFile: `${unitName}.service`,
      })
    }

    // Remove orphaned per-project units for projects that are no longer in
    // config. Without this, `service start` / `status` would keep iterating
    // over stale units with outdated tokens because getAllProjectUnits()
    // walks the filesystem, not the config.
    for (const { unitName, unitPath } of getAllProjectUnits()) {
      if (expectedUnitNames.has(unitName)) continue
      const orphanUnitFile = `${unitName}.service`
      try {
        execSync(`systemctl --user disable --now "${orphanUnitFile}"`, { stdio: 'pipe' })
      } catch { /* not loaded — ignore */ }
      try {
        if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(t('service.orphanUnitRemoveFailed', { unit: orphanUnitFile, message }))
      }
    }

    // Reload systemd so the new/updated units are recognised, then enable
    // each so they auto-start at next login/boot. Failures to enable surface
    // as warnings (lingering may not be configured) — the unit file itself
    // is still on disk and a subsequent `service start` will run it for the
    // current session, so we still emit the per-project "installed" line
    // after attempting enable. The warning makes clear that auto-start may
    // not work until linger is enabled.
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(t('service.daemonReloadFailed', { message }))
    }
    for (const { projectCode, unitPath, unitFile } of writtenUnits) {
      try {
        execSync(`systemctl --user enable "${unitFile}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(t('service.enableFailed', { unit: unitFile, message }))
      }
      logger.success(t('service.projectInstalled', { projectCode, path: unitPath }))
    }

    logger.info(t('service.loadHintMulti'))
    logger.info(t('service.logDir', { path: logDir }))
    logger.info(t('service.noLogRotation'))
  }

  uninstall(): void {
    const projectUnits = getAllProjectUnits()

    if (projectUnits.length === 0) {
      logger.warn(t('service.notInstalled'))
      return
    }

    for (const { unitName, unitPath } of projectUnits) {
      const unitFile = `${unitName}.service`
      // Stop and disable; ignore failures (may not be loaded)
      try { execSync(`systemctl --user disable --now "${unitFile}"`, { stdio: 'pipe' }) } catch { /* not loaded */ }
      if (fs.existsSync(unitPath)) {
        fs.unlinkSync(unitPath)
      }
    }

    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }) } catch { /* tolerate */ }

    logger.success(t('service.uninstalled'))
  }

  start(): void {
    const projectUnits = getAllProjectUnits()

    if (projectUnits.length === 0) {
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
    } catch {
      // tolerate — start may still work
    }

    for (const { unitName } of projectUnits) {
      const unit = `${unitName}.service`
      try {
        execSync(`systemctl --user start "${unit}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Include unit name so operators can identify the failing project
        // when start runs over N units.
        logger.error(t('service.unitStartFailed', { unit, message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.started'))
    }
  }

  stop(): void {
    const projectUnits = getAllProjectUnits()

    if (projectUnits.length === 0) {
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    for (const { unitName } of projectUnits) {
      const unit = `${unitName}.service`
      try {
        execSync(`systemctl --user stop "${unit}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.unitStopFailed', { unit, message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.stopped'))
    }
  }

  restart(): void {
    const projectUnits = getAllProjectUnits()

    if (projectUnits.length === 0) {
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
    } catch {
      // tolerate
    }

    for (const { unitName } of projectUnits) {
      const unit = `${unitName}.service`
      try {
        execSync(`systemctl --user restart "${unit}"`, { stdio: 'pipe' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.unitRestartFailed', { unit, message }))
        failed = true
      }
    }
    if (!failed) {
      logger.success(t('service.restarted'))
    }
  }

  status(): ServiceStatus {
    const projectUnits = getAllProjectUnits()
    const logDir = getLogDir()

    if (projectUnits.length === 0) {
      return { installed: false, running: false }
    }

    // Build a reverse map from unit name → original projectCode using the
    // user's config. sanitize() collapses `_` and other chars to `-`, so
    // splitting the unit name on `-` is lossy when tenant/project codes
    // contain those characters; the config is the source of truth.
    const config = loadConfig()
    const projectByUnitName = new Map<string, string>()
    if (config) {
      for (const project of getProjectList(config)) {
        projectByUnitName.set(
          getProjectUnitName(project.tenantCode, project.projectCode),
          project.projectCode,
        )
      }
    }

    const projects: ProjectStatus[] = []
    let anyRunning = false
    let firstPid: number | undefined

    for (const { unitName } of projectUnits) {
      // Prefer the canonical projectCode from config. For orphaned units no
      // longer in config, fall back to the unit name with the brand prefix
      // stripped so users can see something close to the original code.
      const fallback = unitName.startsWith(`${SERVICE_PREFIX}-`)
        ? unitName.slice(SERVICE_PREFIX.length + 1)
        : unitName
      const projectCode = projectByUnitName.get(unitName) ?? fallback

      let running = false
      let pid: number | undefined
      try {
        const output = execSync(
          `systemctl --user show "${unitName}.service" --property=ActiveState,MainPID --no-pager`,
          { stdio: 'pipe' },
        ).toString()
        const activeMatch = output.match(/ActiveState=(\w+)/)
        const pidMatch = output.match(/MainPID=(\d+)/)
        if (activeMatch?.[1] === 'active') {
          running = true
          if (pidMatch && pidMatch[1] !== '0') {
            pid = parseInt(pidMatch[1], 10)
            if (!firstPid) firstPid = pid
          }
          anyRunning = true
        }
      } catch {
        // Not loaded — running stays false
      }
      projects.push({ label: unitName, projectCode, running, pid })
    }

    return { installed: true, running: anyRunning, pid: firstPid, logDir, projects }
  }
}

