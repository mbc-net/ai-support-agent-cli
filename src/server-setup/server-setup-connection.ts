import { TAILSCALE_SOCKS_PORT } from '../constants'
import {
  isSupportedSshAuthType,
  unsupportedSshAuthTypeMessage,
  type SshExecCredential,
} from '../types'
import { isValidPort } from '../utils/port'
import type { AnsibleTargetOs } from './ansible-task-guard'

/**
 * Plain hostname or dotted-decimal IPv4 address: letters/digits/hyphens/dots
 * only — no whitespace, quotes, `=`, or other characters that could be
 * (mis)parsed as an extra inventory variable assignment.
 */
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
/**
 * Portable username: letters/digits/underscore/dot/hyphen, not starting with
 * `-` (could be read as an option) or `.`. The dot admits the common Windows
 * `john.doe` form; the value only ever becomes `ansible_user`, which Ansible
 * passes to ssh as an argv `-o User=...` (never through a shell).
 */
const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/


/**
 * Reject a fetched SSH credential whose hostname/username/port isn't a plain,
 * unambiguous value. Without this, a hostname or username containing e.g. a
 * space or an embedded `ansible_connection=local` could — once written into
 * the inventory — be parsed as *additional* inventory variables for the host,
 * redirecting the `become: true` playbook run away from the intended target.
 *
 * When `connectionType === 'tailscale'`, `tailnetHostname` is what actually
 * gets written to `ansible_host` (see `buildInventory`), so it is held to the
 * exact same `HOSTNAME_RE` standard as `hostname`. `socksPort`, when present,
 * is validated as a port number the same way `port` already is.
 */
export function validateSshCredential(credential: SshExecCredential): string | null {
  if (!HOSTNAME_RE.test(credential.hostname)) {
    return `SSH credential hostname is not a valid hostname/IP address: ${JSON.stringify(credential.hostname)}`
  }
  if (!USERNAME_RE.test(credential.username)) {
    return `SSH credential username contains disallowed characters: ${JSON.stringify(credential.username)}`
  }
  if (!isValidPort(credential.port)) {
    return `SSH credential port is out of range: ${JSON.stringify(credential.port)}`
  }
  // `authType` decides whether `privateKey` (an overloaded field — see
  // `buildInventory`'s doc comment) is treated as SSH key material or a
  // plaintext password. An unrecognized value must never silently fall back
  // to the key path (フォールバック禁止) — that is exactly how a
  // password-authType host got its password written to disk as if it were
  // key material, producing `error in libcrypto` when OpenSSH tried to parse it.
  // Shared with commands/ssh-executor.ts's executeSshCommand via
  // isSupportedSshAuthType so the two guards cannot silently drift apart.
  if (!isSupportedSshAuthType(credential.authType)) {
    return unsupportedSshAuthTypeMessage(credential.authType)
  }
  if (!credential.privateKey) {
    return `SSH credential privateKey is empty for authType ${JSON.stringify(credential.authType)}`
  }
  if (credential.connectionType === 'tailscale') {
    if (typeof credential.tailnetHostname !== 'string' || !HOSTNAME_RE.test(credential.tailnetHostname)) {
      return `SSH credential tailnetHostname is not a valid hostname/IP address: ${JSON.stringify(credential.tailnetHostname)}`
    }
    if (credential.socksPort !== undefined && !isValidPort(credential.socksPort)) {
      return `SSH credential socksPort is out of range: ${JSON.stringify(credential.socksPort)}`
    }
  }
  return null
}

/**
 * Cross-check a fetched SSH credential against the target OS the run was
 * dispatched for (admin-docs `server-setup-windows-openssh.md` §4 ⑧ / §5.2).
 *
 * - The credential's `os` (absent = Linux) must equal `targetOs`. The api
 *   decides `targetOs` at dispatch time, but the credential is read later, so
 *   a host whose OS setting changed in between (TOCTOU) is caught here.
 * - Windows hosts are supported over direct SSH with public-key auth only:
 *   `authType` must be `privateKey`, and the credential must carry **no**
 *   `connectionType` key at all — the api puts it in the response only for
 *   Tailscale and SSM routes.
 *
 * Returns a user-facing reason, or `null` when the credential fits.
 */
export function validateCredentialForTargetOs(
  credential: SshExecCredential,
  targetOs: AnsibleTargetOs,
): string | null {
  const rawOs: unknown = credential.os
  if (rawOs !== undefined && rawOs !== 'linux' && rawOs !== 'windows') {
    return `SSH credential os is not supported: ${JSON.stringify(rawOs)} (expected "windows" or no value for Linux)`
  }
  const hostOs: AnsibleTargetOs = rawOs ?? 'linux'
  if (hostOs !== targetOs) {
    return `Target OS mismatch: this run was dispatched for target OS '${targetOs}', but SSH host `
      + `'${credential.hostId}' is now configured as '${hostOs}'. The host's OS setting may have changed `
      + 'after the run was started; check the host and recipe OS settings and start the run again.'
  }
  if (targetOs !== 'windows') return null
  if (credential.authType !== 'privateKey') {
    return `Server setup on Windows hosts requires public-key authentication, but SSH host `
      + `'${credential.hostId}' uses authType ${JSON.stringify(credential.authType)}. Switch the host to `
      + 'private key authentication and register the public key in C:\\ProgramData\\ssh\\administrators_authorized_keys.'
  }
  if (Object.prototype.hasOwnProperty.call(credential, 'connectionType')) {
    return 'Server setup on Windows hosts supports only a direct SSH connection, but the credential for SSH host '
      + `'${credential.hostId}' carries connectionType ${JSON.stringify(credential.connectionType)} `
      + '(Tailscale / SSM routes are not supported for Windows). Change the host to a direct SSH connection.'
  }
  return null
}

/**
 * Normalize private-key material before it is written to the on-disk `id_rsa`
 * file that ansible hands to the OpenSSH `ssh` client.
 *
 * OpenSSH's key parser is strict about framing: an OpenSSH-format key (ed25519
 * and modern RSA) whose file lacks a trailing newline, or that carries CRLF
 * line endings, is rejected with `Load key "...": error in libcrypto`, after
 * which the connection falls back to `Permission denied (publickey,password)`.
 * The store→retrieve path (web Textarea → JSON.stringify → KMS → JSON.parse)
 * preserves newlines losslessly and never *adds* one, so a key an admin pasted
 * without a final newline reaches this writer without one. This normalizes to
 * LF-only line endings terminated by exactly one `\n`, regardless of how the
 * key was pasted. Applied only to key material — a plaintext password
 * (`authType === 'password'`) is never written to this file (see
 * `buildInventory`'s doc comment) and must not be reshaped.
 *
 * `\r\n?` (not a bare `\r` delete) converts both CRLF and lone-CR line endings
 * to LF: CR-only line endings are valid PEM per RFC 7468, so deleting bare CRs
 * would *join* those lines and corrupt the key. Sibling util `normalizePemKey`
 * (src/utils/pem-key.ts, used by ssh-config-setup) also guarantees a trailing
 * newline; keep the two in sync if either is changed.
 */
export function normalizePrivateKeyMaterial(privateKey: string): string {
  return privateKey.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n'
}

/** Inventory variables added for Windows hosts (admin-docs `server-setup-windows-openssh.md` §5.3). */
const WINDOWS_CONNECTION_VARS = {
  ansible_connection: 'ssh',
  ansible_shell_type: 'powershell',
} as const

/**
 * Build a minimal single-host Ansible inventory as JSON — written with a
 * `.yml` extension because plain JSON is valid YAML, so ansible-core's bundled
 * `yaml` inventory plugin (which matches by extension) parses it unambiguously.
 *
 * `StrictHostKeyChecking=accept-new` (TOFU): the host key is trusted and
 * recorded on first connection, but a *later* run against the same
 * `credential.hostname` with a *different* key is rejected.
 *
 * Tailscale routing: when `credential.connectionType === 'tailscale'`, the
 * actual destination is `credential.tailnetHostname`, reached through the ECS
 * oneshot task's `tailscaled --socks5-server` sidecar; `ansible_ssh_common_args`
 * gets an additional `ProxyCommand` routing the SSH TCP stream through
 * `127.0.0.1:<socksPort>` via `nc`'s SOCKS5 client mode.
 *
 * Auth: `credential.privateKey` is an overloaded field (see
 * `commands/ssh-executor.ts`'s doc comment) that holds either SSH key
 * material or a plaintext password, depending on `credential.authType`.
 * `authType === 'password'` sets `ansible_ssh_pass` (consumed by Ansible's
 * `ssh` connection plugin via the `sshpass` binary) and omits
 * `ansible_ssh_private_key_file` entirely — `keyPath` is only meaningful, and
 * only written to disk by the caller, in the key case.
 */
export function buildInventory(
  credential: SshExecCredential,
  keyPath: string,
  knownHostsPath: string,
  targetOs: AnsibleTargetOs,
): string {
  const isTailscale = credential.connectionType === 'tailscale'
  const ansibleHost = isTailscale ? (credential.tailnetHostname as string) : credential.hostname
  const socksPort = credential.socksPort ?? TAILSCALE_SOCKS_PORT
  const proxyCommandArg = isTailscale
    ? ` -o ProxyCommand="nc -X 5 -x 127.0.0.1:${socksPort} %h %p"`
    : ''
  const commonArgs = `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsPath}${proxyCommandArg}`
  const authVars = credential.authType === 'password'
    ? { ansible_ssh_pass: credential.privateKey }
    : { ansible_ssh_private_key_file: keyPath }
  const inventory = {
    target: {
      hosts: {
        [credential.hostname]: {
          ansible_host: ansibleHost,
          ansible_port: credential.port,
          ansible_user: credential.username,
          ...authVars,
          ansible_ssh_common_args: commonArgs,
          // Windows OpenSSH with PowerShell as the default shell (a host
          // prerequisite). Fixed by the agent; `ansible_*` stays reserved in
          // the guard, so a recipe cannot change it.
          ...(targetOs === 'windows' ? WINDOWS_CONNECTION_VARS : {}),
        },
      },
    },
  }
  return JSON.stringify(inventory)
}
