import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { loadConfig, getProjectList } from '../../config-manager'
import type { ProjectRegistration } from '../../types'
import type { ProjectStatus } from './types'
import { IMAGE_NAME } from '../../docker/docker-utils'
import { t } from '../../i18n'
import { logger } from '../../logger'
import { escapeXml } from './escape-xml'
import { getCliEntryPoint, getNodePath } from './node-paths'
import type { ServiceConfig, ServiceOptions, ServiceStatus, ServiceStrategy } from './types'
import { assertProjectCodeIsSafe, detectInstallCollisions, shellQuote, validateProjectDirForMount } from './wrapper-helpers'

export { getCliEntryPoint, getNodePath }

const SERVICE_LABEL = 'com.ai-support-agent.cli'

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
    <true/>

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

  // Project directory mount strategy: mirror the Linux wrapper. The metadata
  // dir (projectConfigHostDir) mounts to /home/node/.ai-support-agent for
  // hash files; the project dir itself mounts to /workspace/projects/<code>
  // and is pinned via AI_SUPPORT_AGENT_PROJECT_DIR_MAP so the agent does NOT
  // re-derive `<configDir>/projects/<t>/<p>` and double-nest the workspace
  // tree.
  const containerProjectDir = `/workspace/projects/${opts.projectCode}`
  // `||` (not `??`) so an empty string falls back to the default; an empty
  // hostProjectDir would emit `-v :/workspace/...:rw` which docker rejects.
  const hostProjectDir = opts.projectDir || path.dirname(opts.projectConfigHostDir)

  const mountLines: string[] = [
    `  -v "${homeDir}/.claude:${containerHome}/.claude:rw" \\`,
    `  -v "${opts.projectConfigHostDir}:${containerConfigDir}:rw" \\`,
  ]
  // Mount .claude.json only if it's a regular file (not a directory)
  mountLines.push(`  -v "${homeDir}/.claude.json:${containerHome}/.claude.json:rw" \\`)
  // New project-dir mount: shell-quote the user-supplied projectDir so a
  // host path containing `$` / backtick / space cannot expand at runtime
  // (the legacy `"..."` mounts above use raw double-quotes for back-compat).
  mountLines.push(`  -v ${shellQuote(`${hostProjectDir}:${containerProjectDir}:rw`)} \\`)

  const envLines: string[] = [
    `  -e AI_SUPPORT_AGENT_IN_DOCKER=1 \\`,
    `  -e HOME=${containerHome} \\`,
    `  -e AI_SUPPORT_AGENT_CONFIG_DIR=${containerConfigDir} \\`,
    `  -e AI_SUPPORT_AGENT_TOKEN=${opts.token} \\`,
    `  -e AI_SUPPORT_AGENT_API_URL=${containerApiUrl} \\`,
    // Shell-quote so neither projectCode nor containerProjectDir can be
    // shell-interpreted (projectCode is validated to [A-Za-z0-9_-] at
    // install time, but quoting is defense in depth).
    `  -e AI_SUPPORT_AGENT_PROJECT_DIR_MAP=${shellQuote(`${opts.projectCode}=${containerProjectDir}`)} \\`,
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

  // Sanitize tenant/project codes the same way buildContainerName does
  const sanitize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const containerName = `ai-${sanitize(opts.tenantCode)}-${sanitize(opts.projectCode)}`

  return `#!/bin/bash
set -uo pipefail

# Load nvm if available so that node/npm are on PATH when launched as a launchd service
export NVM_DIR="\${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "\${NVM_DIR}/nvm.sh" ] && source "\${NVM_DIR}/nvm.sh"
# Also try Homebrew node as fallback
export PATH="/opt/homebrew/bin:/usr/local/bin:\${PATH}"

REBUILD_MARKER="${opts.projectConfigHostDir}/docker-rebuild-needed"
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
IMAGE_TAG="${opts.imageName}:\${_INSTALLED_VERSION}"

# Auto-build Docker image if the required version does not exist locally
if ! docker image inspect "\$IMAGE_TAG" >/dev/null 2>&1; then
  echo "Docker image \$IMAGE_TAG not found — building..." >&2
  ai-support-agent docker-build || { echo "ERROR: docker-build failed — cannot start container" >&2; exit 1; }
fi

# Remove stale container if it exists (e.g. from a previous crash)
docker rm -f "${containerName}" 2>/dev/null || true

docker run --rm -i --name "${containerName}" \\
${mountLines.join('\n')}
${envLines.join('\n')}
  "\$IMAGE_TAG" \\
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

# Load nvm if available so that node/npm are on PATH when launched as a launchd service
export NVM_DIR="\${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "\${NVM_DIR}/nvm.sh" ] && source "\${NVM_DIR}/nvm.sh"
# Also try Homebrew node as fallback
export PATH="/opt/homebrew/bin:/usr/local/bin:\${PATH}"

LOG_PREFIX="[update-and-restart $(date -u '+%Y-%m-%dT%H:%M:%SZ')]"

# Best-effort secret redaction for command output that we echo to stderr.
# npm/login flows leak Bearer tokens, _authToken=..., and registry URLs with
# embedded basic-auth, all of which the agent log forwards to Sentry/heartbeat.
redact_secrets() {
  sed -E \\
    -e 's#(Bearer )[A-Za-z0-9._-]+#\\1***REDACTED***#gi' \\
    -e 's#(authToken[[:space:]]*[:=][[:space:]]*"?)[^"[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(_authToken[[:space:]]*[:=][[:space:]]*"?)[^"[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(X-Auth-Token:[[:space:]]*)[^[:space:]]+#\\1***REDACTED***#gi' \\
    -e 's#(https?://)[^/:[:space:]@]+:[^@/[:space:]]+@#\\1***REDACTED***@#gi'
}

# 1. Unload all per-project LaunchAgent services
for plist in "${launchAgentsDir}"/com.ai-support-agent.cli.*.plist; do
  [ -f "$plist" ] || continue
  launchctl unload "$plist" 2>/dev/null || true
done

# 2. Install new version if update-version.json exists.
# Capture npm/service-install stderr so the real cause (E403, EACCES, cache
# lock, ENOTFOUND, ...) reaches the user instead of being swallowed.
VERSION_FILE="${configDir}/update-version.json"
_INSTALL_OK=true
if [ -f "$VERSION_FILE" ]; then
  NEW_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VERSION_FILE','utf-8')).version||'')}catch(e){console.log('')}" 2>/dev/null || echo "")
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

# 3. Reload all per-project LaunchAgent services (always, even if install
# failed) with retry + post-load verification. The shared-host mac-studio has
# seen launchctl load silently no-op for individual plists during a fleet
# update; if we don't verify each label was actually registered, the service
# stays down until someone notices manually.
# Reload a single plist and verify the label was actually registered.
# Note: we never call launchctl unload inside the retry loop — once the agent
# is running, an unload sends SIGTERM to the long-lived run.sh child and would
# kill an in-flight command. launchctl load on an already-loaded plist is a
# safe no-op (it just prints "service already loaded" and exits non-zero),
# which is fine: the subsequent launchctl list check is the source of truth.
reload_plist() {
  local plist="$1"
  local label
  label=$(basename "$plist" .plist)
  local attempt
  for attempt in 1 2 3; do
    local out
    out=$(launchctl load "$plist" 2>&1)
    # Tolerate "service already loaded" — what matters is post-condition.
    if launchctl list "$label" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep "$attempt"
    fi
    echo "$LOG_PREFIX WARN: launchctl load attempt $attempt/3 for $label not yet registered: $out" >&2
  done
  echo "$LOG_PREFIX ERROR: launchctl load $label gave up after 3 attempts" >&2
  return 1
}

_RELOAD_FAILED=0
for plist in "${launchAgentsDir}"/com.ai-support-agent.cli.*.plist; do
  [ -f "$plist" ] || continue
  if ! reload_plist "$plist"; then
    _RELOAD_FAILED=$((_RELOAD_FAILED + 1))
  fi
done

if [ "$_RELOAD_FAILED" -gt 0 ]; then
  echo "$LOG_PREFIX ERROR: $_RELOAD_FAILED LaunchAgent(s) failed to reload" >&2
fi

if [ "$_INSTALL_OK" = "false" ] || [ "$_RELOAD_FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
`
}

// ---------------------------------------------------------------------------
// DarwinServiceStrategy
// ---------------------------------------------------------------------------

function getUpdateScriptPath(): string {
  const configDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    ? path.resolve(process.env.AI_SUPPORT_AGENT_CONFIG_DIR)
    : path.join(os.homedir(), '.ai-support-agent')
  return path.join(configDir, 'update-and-restart.sh')
}

/**
 * Write run.sh and plist for a single project. Does NOT launchctl load.
 * Returns the plist path.
 *
 * NOTE: This function does NOT generate update-and-restart.sh. Callers that
 * invoke this directly (not via installAndStartProject or install()) are
 * responsible for ensuring update-and-restart.sh exists at getUpdateScriptPath().
 */
export function writeProjectServiceFiles(
  project: ProjectRegistration,
  options: { verbose?: boolean } = {},
): string {
  const { tenantCode, projectCode } = project
  // Reject codes whose characters would break the PROJECT_DIR_MAP env format
  // (`;` separator, `=` key/value).
  assertProjectCodeIsSafe(projectCode)
  assertProjectCodeIsSafe(tenantCode)
  const projectKey = `${tenantCode}-${projectCode.toLowerCase()}`

  const logDir = getLogDir()
  const projectLogDir = path.join(logDir, projectKey)
  if (!fs.existsSync(projectLogDir)) {
    fs.mkdirSync(projectLogDir, { recursive: true, mode: 0o700 })
  }

  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true })
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

  // Validate project.projectDir same way the Linux wrapper does. If
  // missing, empty, or blocked (e.g. `/etc`, `~/.ssh`), drop it so
  // generateWrapperScript falls back to the safe default mount.
  const validatedProjectDir = validateProjectDirForMount(project.projectDir)

  const updateScriptPath = getUpdateScriptPath()
  const wrapperScriptPath = path.join(projectServiceDir, 'run.sh')
  const wrapperScript = generateWrapperScript({
    imageName: IMAGE_NAME,
    tenantCode,
    projectCode,
    projectConfigHostDir,
    projectDir: validatedProjectDir,
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
  const plist = generateProjectPlist({ label, wrapperScriptPath, logDir: projectLogDir })
  fs.writeFileSync(plistPath, plist, 'utf-8')

  return plistPath
}

/**
 * Install service files and immediately start a single project via launchctl.
 * Idempotent: unloads any existing service before loading so that token/config
 * updates take effect immediately.
 */
export function installAndStartProject(
  project: ProjectRegistration,
  options: { verbose?: boolean } = {},
): void {
  const updateScriptPath = getUpdateScriptPath()
  const updateScript = generateUpdateScript()
  fs.writeFileSync(updateScriptPath, updateScript, { mode: 0o700 })

  const plistPath = writeProjectServiceFiles(project, options)
  const label = getProjectLabel(project.tenantCode, project.projectCode)

  // Unload first so that updated run.sh / token changes take effect.
  // Ignore errors — the service may not be loaded yet.
  try { execSync(`launchctl remove "${label}"`, { stdio: 'pipe' }) } catch { /* not loaded */ }

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(t('service.loadWarning', { label: `${label}: ${message}` }))
    return
  }

  // Verify the service actually registered after load
  try {
    execSync(`launchctl list "${label}"`, { stdio: 'pipe' })
  } catch {
    logger.warn(t('service.loadWarning', { label }))
  }
}

export class DarwinServiceStrategy implements ServiceStrategy {
  async install(options: ServiceOptions): Promise<void> {
    // Load project list from config
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

    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    if (!fs.existsSync(launchAgentsDir)) {
      fs.mkdirSync(launchAgentsDir, { recursive: true })
    }

    const updateScriptPath = getUpdateScriptPath()
    const updateScript = generateUpdateScript()
    fs.writeFileSync(updateScriptPath, updateScript, { mode: 0o700 })

    // Detect sanitize() collisions where two valid projectCodes map to the
    // same plist label (e.g. `MBC_01` and `MBC-01` → `com.ai-support-agent.cli.<t>.mbc-01`).
    // Shared helper guarantees identical semantics with the Linux wrapper.
    const collisions = detectInstallCollisions(projects, getProjectLabel)
    // Dedup collision/duplicate error logs so an N-times-listed entry
    // doesn't produce N identical error lines.
    const reportedCollisionLabels = new Set<string>()

    let installedCount = 0
    let failedCount = 0
    for (const project of projects) {
      const { projectCode } = project
      const label = getProjectLabel(project.tenantCode, projectCode)
      const fqn = `${project.tenantCode}/${projectCode}`
      const collision = collisions.get(fqn)
      if (collision) {
        if (!reportedCollisionLabels.has(collision.name)) {
          const messageKey = collision.others.length === 0
            ? 'service.projectDuplicateEntry'
            : 'service.projectUnitNameCollision'
          logger.error(t(messageKey, {
            projectCode,
            unitName: collision.name,
            others: collision.others.join(', '),
          }))
          reportedCollisionLabels.add(collision.name)
        }
        failedCount += 1
        continue
      }
      // Per-project failures must not abort the loop — log and continue so
      // the remaining valid projects still get their plists written. See
      // the Linux wrapper for the same pattern.
      try {
        const plistPath = writeProjectServiceFiles(project, { verbose: options.verbose })
        logger.success(t('service.projectInstalled', { projectCode, path: plistPath }))
        installedCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(t('service.projectInstallFailed', { projectCode, message }))
        failedCount += 1
      }
      // Suppress unused-var lint — `label` is reserved for future use
      // (e.g. richer success message). The collision lookup above already
      // uses it via the `getProjectLabel` call.
      void label
    }
    const anyInstallFailed = failedCount > 0

    // Hide the "now run `service start`" hint when nothing was installed —
    // misleading the user to start services that don't exist.
    if (installedCount > 0) {
      logger.info(t('service.loadHintMulti'))
      logger.info(t('service.logDir', { path: logDir }))
      logger.info(t('service.noLogRotation'))
    }

    // Surface a summary line with counts so scripts wrapping
    // `service install` (or operators scanning a long log) can tell that
    // SOME project was refused, even when other projects logged success.
    // The Linux wrapper communicates this via the `!anyInstallFailed`
    // orphan-cleanup skip; Darwin has no orphan cleanup, so we emit an
    // explicit summary instead.
    if (anyInstallFailed) {
      logger.warn(t('service.partialInstallSummary', {
        failed: String(failedCount),
        total: String(projects.length),
        succeeded: String(installedCount),
      }))
    }
  }

  uninstall(): void {
    const projectPlists = getAllProjectPlists()

    if (projectPlists.length === 0) {
      logger.warn(t('service.notInstalled'))
      return
    }

    for (const { plistPath } of projectPlists) {
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath)
      }
    }

    logger.success(t('service.uninstalled'))
  }

  start(): void {
    const projectPlists = getAllProjectPlists()

    if (projectPlists.length === 0) {
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    for (const { plistPath } of projectPlists) {
      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' })
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
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    for (const { label } of projectPlists) {
      try {
        execSync(`launchctl remove "${label}"`, { stdio: 'pipe' })
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
      logger.error(t('service.notInstalled'))
      return
    }

    let failed = false
    for (const { label, plistPath } of projectPlists) {
      try {
        try {
          execSync(`launchctl remove "${label}"`, { stdio: 'pipe' })
        } catch {
          // Service may not be loaded — ignore
        }
        execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' })
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
      return { installed: false, running: false }
    }

    const projects: ProjectStatus[] = []
    let anyRunning = false
    let firstPid: number | undefined

    for (const { label } of projectPlists) {
      // Extract projectCode from label: com.ai-support-agent.cli.{tenant}.{project}
      const parts = label.split('.')
      const projectCode = parts.slice(4).join('.').toUpperCase().replace(/-/g, '_')
      let running = false
      let pid: number | undefined
      try {
        const output = execSync(`launchctl list "${label}"`, { stdio: 'pipe' }).toString()
        const pidMatch = output.match(/"PID"\s*=\s*(\d+)/)
        if (pidMatch) {
          running = true
          pid = parseInt(pidMatch[1], 10)
          anyRunning = true
          if (!firstPid) firstPid = pid
        }
      } catch {
        // Not loaded — running stays false
      }
      projects.push({ label, projectCode, running, pid })
    }

    return { installed: true, running: anyRunning, pid: firstPid, logDir, projects }
  }
}
