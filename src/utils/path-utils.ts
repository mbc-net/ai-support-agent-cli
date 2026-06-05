import * as os from 'os'
import * as path from 'path'

import { getConfigDir } from '../config-manager'

// ---------------------------------------------------------------------------
// Shared service path helpers (used by both darwin-service and linux-service)
// ---------------------------------------------------------------------------

/**
 * Returns the per-project config dir on the host side.
 * Maps to the container's ~/.ai-support-agent via docker bind-mount.
 */
export function getProjectConfigHostDir(tenantCode: string, projectCode: string): string {
  return path.join(getConfigDir(), 'projects', tenantCode, projectCode, '.ai-support-agent')
}

/** Returns the services dir where per-project wrapper scripts are stored. */
export function getServicesDir(): string {
  return path.join(getConfigDir(), 'services')
}

/** Returns the path of the update-and-restart.sh script. */
export function getUpdateScriptPath(): string {
  return path.join(getConfigDir(), 'update-and-restart.sh')
}

/** Returns the per-project subdirectory inside the log root. */
export function getProjectLogDir(logRootDir: string, projectKey: string): string {
  return path.join(logRootDir, projectKey)
}

/** Returns the per-project wrapper script directory inside servicesDir. */
export function getProjectServiceDir(servicesDir: string, projectKey: string): string {
  return path.join(servicesDir, projectKey)
}

/** Returns the run.sh wrapper script path inside a project service directory. */
export function getWrapperScriptPath(projectServiceDir: string): string {
  return path.join(projectServiceDir, 'run.sh')
}

/** Returns the run.cmd wrapper script path inside a project service directory (Windows). */
export function getWin32WrapperScriptPath(projectServiceDir: string): string {
  return path.join(projectServiceDir, 'run.cmd')
}

/** Returns the agent stdout log path. */
export function getAgentOutLog(logDir: string): string {
  return path.join(logDir, 'agent.out.log')
}

/** Returns the agent stderr log path. */
export function getAgentErrLog(logDir: string): string {
  return path.join(logDir, 'agent.err.log')
}

/** Returns the wrapper stdout log path (used by the service supervisor). */
export function getWrapperOutLog(logDir: string): string {
  return path.join(logDir, 'wrapper.out.log')
}

/** Returns the wrapper stderr log path (used by the service supervisor). */
export function getWrapperErrLog(logDir: string): string {
  return path.join(logDir, 'wrapper.err.log')
}

// ---------------------------------------------------------------------------
// macOS (Darwin) specific path helpers
// ---------------------------------------------------------------------------

/** Returns the macOS log directory for the agent. */
export function getDarwinLogDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'ai-support-agent')
}

/** Returns the macOS LaunchAgents directory. */
export function getDarwinLaunchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents')
}

// ---------------------------------------------------------------------------
// Linux specific path helpers
// ---------------------------------------------------------------------------

/** Returns the systemd user unit directory on Linux. */
export function getLinuxSystemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user')
}

/** Returns the log directory for the agent on Linux. */
export function getLinuxLogDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'ai-support-agent', 'logs')
}

// ---------------------------------------------------------------------------
// Windows (win32) specific path helpers
// ---------------------------------------------------------------------------

/** Returns the log directory for the agent on Windows (%LOCALAPPDATA%). */
export function getWin32LogDir(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'ai-support-agent', 'logs')
}
