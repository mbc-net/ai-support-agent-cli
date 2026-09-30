/**
 * Builds the command a terminal PTY runs when the session targets a host
 * registered in the project's remote-connection settings, instead of the
 * agent's own shell.
 *
 * The result is **pure data** (script text, files to materialize, extra env) so
 * the dangerous parts are unit-testable without touching the filesystem. The
 * caller (`TerminalSession`) writes the files into the per-session temp dir and
 * runs the script inside tmux, which is what makes reconnect/resume work: the
 * `ssh` process stays alive in the tmux session while the browser is away.
 *
 * Invariants worth stating, because breaking them is silent:
 *
 * - **Secrets go into files, never onto the command line.** A password in argv
 *   is readable via `ps` by every process on the host.
 * - **Every interpolated value is shell-quoted.** The script is shell text; an
 *   unquoted hostname containing `;` runs arbitrary commands as the agent.
 * - **Host key checking stays on** (TOFU against a persistent known_hosts).
 *   Disabling it silently accepts a changed host key after a route/DNS hijack.
 * - **An unsupported route or authType throws**; it never falls back to the key
 *   path (フォールバック禁止).
 */
import * as fs from 'fs'
import * as path from 'path'

import { isSupportedSshAuthType, unsupportedSshAuthTypeMessage } from '../types'
import type { SshCredentials } from '../types'
import { shellQuote } from '../utils/shell-quote'
import { normalizePemKey } from '../utils/pem-key'

/** Default SSH port when the host does not pin one. */
const DEFAULT_SSH_PORT = 22

/**
 * Shell variable the caller sets to the directory holding the plan's files.
 * The script refers to files through it so the plan text does not need to know
 * the per-session temp path.
 */
export const REMOTE_DIR_ENV_NAME = 'AIS_REMOTE_DIR'

/** A file the caller must materialize before running the script. */
export interface RemoteShellFile {
  /** File name inside the per-session directory. */
  name: string
  content: string
  /** POSIX mode. Secrets are 0600. */
  mode: number
}

/** Everything the caller needs to start the remote session. */
export interface RemoteShellPlan {
  /** `/bin/sh` script text. Runs `exec` so no wrapper process lingers. */
  script: string
  files: RemoteShellFile[]
  /** Extra environment for the PTY (never secrets on the command line). */
  env: Record<string, string>
}

/**
 * Quote a path that must still expand `${AIS_REMOTE_DIR}`.
 *
 * `shellQuote` would prevent the expansion, so the variable is left outside the
 * quotes: `"${AIS_REMOTE_DIR}"'/remote-key'` is one argument and expands.
 */
function remoteFileArg(name: string): string {
  return `'\${${REMOTE_DIR_ENV_NAME}}/${name}'`
}

/** Common ssh options. Order is irrelevant; every value is quoted. */
function sshCommonOptions(knownHostsPath: string): string[] {
  return [
    // TOFU: a *changed* host key is refused, a first-seen one is recorded.
    '-o',
    shellQuote('StrictHostKeyChecking=accept-new'),
    '-o',
    `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
  ]
}

export function buildRemoteShellPlan(
  credentials: SshCredentials,
  options: { knownHostsPath: string },
): RemoteShellPlan {
  const connectionType = credentials.connectionType ?? 'ssh'

  if (connectionType === 'tailscale') {
    // Reaching a tailnet host requires the tailscaled SOCKS5 sidecar that only
    // the server-setup oneshot task runs. Falling back to a direct ssh would
    // either fail to reach the host or bypass the intended network path.
    throw new Error(
      'Remote terminal over the tailscale route is not supported (requires the tailscaled sidecar)',
    )
  }

  if (connectionType === 'ssm') {
    const { instanceId, region, awsCredentials } = credentials as unknown as {
      instanceId?: string
      region?: string
      awsCredentials?: {
        accessKeyId?: string
        secretAccessKey?: string
        sessionToken?: string
      }
    }
    if (!instanceId || !region || !awsCredentials?.accessKeyId || !awsCredentials?.secretAccessKey) {
      throw new Error('SSM host is missing instanceId, region, or AWS credentials')
    }

    return {
      script: [
        '#!/bin/sh',
        'set -e',
        `exec aws ssm start-session --target ${shellQuote(instanceId)} --region ${shellQuote(region)}`,
        '',
      ].join('\n'),
      files: [],
      env: {
        AWS_ACCESS_KEY_ID: awsCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: awsCredentials.secretAccessKey,
        ...(awsCredentials.sessionToken
          ? { AWS_SESSION_TOKEN: awsCredentials.sessionToken }
          : {}),
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
      },
    }
  }

  const { hostname, username, authType, privateKey } = credentials
  if (!hostname || !username || !authType || !privateKey) {
    throw new Error(
      'Remote terminal over SSH requires hostname, username, authType, and credential material',
    )
  }
  // An unrecognized authType must never silently take the key path.
  if (!isSupportedSshAuthType(authType)) {
    throw new Error(unsupportedSshAuthTypeMessage(authType))
  }

  const port = credentials.port ?? DEFAULT_SSH_PORT
  const destination = shellQuote(`${username}@${hostname}`)
  const common = sshCommonOptions(options.knownHostsPath).join(' ')

  if (authType === 'password') {
    return {
      script: [
        '#!/bin/sh',
        'set -e',
        // sshpass reads the password from the file (-f); it never appears in argv.
        `exec sshpass -f ${remoteFileArg('remote-pass')} ssh -t ${common} ` +
          `-o ${shellQuote('PreferredAuthentications=password')} ` +
          `-o ${shellQuote('PubkeyAuthentication=no')} ` +
          `-p ${shellQuote(String(port))} ${destination}`,
        '',
      ].join('\n'),
      files: [
        // Trailing newline: sshpass -f reads the first line.
        { name: 'remote-pass', content: `${privateKey}\n`, mode: 0o600 },
      ],
      env: {},
    }
  }

  return {
    script: [
      '#!/bin/sh',
      'set -e',
      `exec ssh -t ${common} ` +
        `-o ${shellQuote('IdentitiesOnly=yes')} ` +
        `-i ${remoteFileArg('remote-key')} ` +
        `-p ${shellQuote(String(port))} ${destination}`,
      '',
    ].join('\n'),
    files: [
      // normalizePemKey terminates the key with a newline; OpenSSH otherwise
      // fails with an opaque "error in libcrypto".
      { name: 'remote-key', content: normalizePemKey(privateKey), mode: 0o600 },
    ],
    env: {},
  }
}

/** Name of the generated script inside the per-session directory. */
const SCRIPT_NAME = 'remote-shell'

/** What the caller runs, once the plan is on disk. */
export interface MaterializedRemoteShell {
  /** Absolute path of the generated script (mode 0700). */
  command: string
  /** Environment the PTY must carry (includes the directory reference). */
  env: Record<string, string>
}

/**
 * Write a plan into `dir` and return the command to run.
 *
 * `dir` must be the session's own temp directory: it holds key material and is
 * removed when the session ends. Modes come from the plan (0600 for secrets) —
 * a key readable by other users on the host defeats the point of fetching it
 * just-in-time.
 */
export function materializeRemoteShell(
  plan: RemoteShellPlan,
  dir: string,
): MaterializedRemoteShell {
  for (const file of plan.files) {
    fs.writeFileSync(path.join(dir, file.name), file.content, {
      mode: file.mode,
    })
  }

  const command = path.join(dir, SCRIPT_NAME)
  fs.writeFileSync(command, plan.script, { mode: 0o700 })

  return {
    command,
    env: { ...plan.env, [REMOTE_DIR_ENV_NAME]: dir },
  }
}
