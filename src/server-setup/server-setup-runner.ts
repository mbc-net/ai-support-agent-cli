/**
 * Runner for the `server_setup_exec` command (git-artifact-platform model).
 *
 * The payload is `{ executionId, sshHostId, body }` where `body` is a recipe
 * body: a top-level YAML **list of Ansible tasks** authored by a tenant admin
 * (built-in steps appear as `include_role` tasks referencing the 6 bundled
 * roles). This runner:
 *   1. re-validates `body` with the authoritative task guard
 *      (`validateAnsibleTasks`), route-aware (`ecs` strict / `resident`
 *      lenient) — see `resolveRouteMode`,
 *   2. fetches the target host's SSH private key Just-In-Time from the API,
 *   3. generates a single enclosing play (`hosts`/`become`/`gather_facts` all
 *      fixed by the agent, never by the caller) around system-generated
 *      precheck tasks (explicit fact-gathering, a NOPASSWD-sudo probe, and an
 *      OS check) plus the validated body tasks, and runs it with
 *      `ansible-playbook`,
 *   4. reports **per-task** results, and — critically — always removes the
 *      temp directory (private key included) afterwards, whether the run
 *      succeeded or failed.
 *
 * SECURITY: the SSH private key must never be logged, and the temp directory
 * holding it must never survive past this function's execution.
 */

import { execFile } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dump } from 'js-yaml'
import * as os from 'os'
import * as path from 'path'

import { AGENT_MODE_ONESHOT, ENV_VARS, ONESHOT_ENV_VARS, TAILSCALE_SOCKS_PORT } from '../constants'
import { logger } from '../logger'
import {
  type CommandResult,
  errorResult,
  isSupportedSshAuthType,
  type ServerSetupExecPayload,
  type ServerSetupTaskResult,
  type ServerSetupVariablesResponse,
  type SshExecCredential,
  successResult,
} from '../types'
import { getErrorMessage, sweepStaleEntries } from '../utils'
import { resolveKnownHostsPath } from '../utils/known-hosts-store'
import { redactSecretValues } from '../utils/secret-redaction'

import { type AnsibleTaskRouteMode, validateAnsibleTasks } from './ansible-task-guard'

import type { ApiClient } from '../api-client'

/** Cap on buffered ansible-playbook stdout/stderr to avoid unbounded memory growth. */
const ANSIBLE_MAX_BUFFER_BYTES = 20 * 1024 * 1024

/**
 * Hard wall-clock cap on the whole `ansible-playbook` invocation. Without
 * this, a hung target host (unreachable SSH, an apt/dpkg lock held forever,
 * etc.) would leave `runServerSetup` pending forever: the resident agent's
 * `processing` flag would stay stuck and the temp directory holding the SSH
 * private key would remain on disk indefinitely. 30 minutes comfortably covers
 * `os_init`'s `apt dist-upgrade` (the slowest single step) plus every other
 * role in one run.
 */
const ANSIBLE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * System-generated OS precheck task, prepended to every generated play (before
 * the tenant admin's body tasks). Tagged `always` so it runs regardless of any
 * task-level tags a body task might carry. Ubuntu 22.04/24.04/26.04 LTS is the
 * MVP scope (matching the bundled roles' assumptions) — a fixed allowlist, not
 * a general ">= 22.04" rule, so a future LTS (e.g. 28.04) still needs an
 * explicit addition here before it is accepted.
 */
const PRECHECK_TASK: Record<string, unknown> = {
  name: 'precheck : Verify supported OS',
  'ansible.builtin.fail': {
    msg:
      'Unsupported OS: {{ ansible_distribution }} {{ ansible_distribution_version }}. '
      + 'Only Ubuntu 22.04/24.04/26.04 LTS are supported by server setup execution.',
  },
  when:
    "ansible_distribution != 'Ubuntu' or ansible_distribution_version not in ['22.04', '24.04', '26.04']",
  tags: 'always',
}

/**
 * System-generated fact-gathering task, run explicitly with `become: false`.
 * The play disables the implicit `gather_facts` (see `generatePlaybook`)
 * because that implicit task inherits the play's `become: true` — and the
 * fact-gathering module (`ansible.legacy.setup`) then fails outright on any
 * host whose SSH user lacks NOPASSWD sudo ("interactive authentication is
 * required"), before `PRECHECK_TASK` or any body task ever runs. The facts
 * this runner depends on (`ansible_distribution`/`ansible_distribution_version`,
 * read from `/etc/os-release`) do not require root, so gathering them without
 * privilege escalation is sufficient.
 */
const GATHER_FACTS_TASK: Record<string, unknown> = {
  name: 'precheck : Gather facts (no privilege escalation)',
  'ansible.builtin.setup': {},
  become: false,
  tags: 'always',
}

/**
 * `register` name for `SUDO_PRECHECK_PROBE_TASK`'s result. Ansible's `-e`
 * extra-vars (which is exactly how project `ANSIBLE#` variables reach the
 * play — see `runServerSetup`'s `extra-vars.json` write) **always** win over
 * a `register`ed variable, regardless of evaluation order. If a tenant admin
 * happened to name a project variable the same as this register target, its
 * value would silently shadow the probe result and corrupt
 * `SUDO_PRECHECK_ASSERT_TASK`'s `when` condition. This name is namespaced and
 * long enough to make an accidental collision practically impossible, and
 * `validateNoReservedVariableCollision` rejects the run outright (rather than
 * silently misbehaving) on the astronomically unlikely case a project
 * variable is named exactly this.
 */
export const SUDO_PROBE_REGISTER_VAR = '__ai_support_agent_server_setup_sudo_probe'

/**
 * Probes whether the SSH user can escalate via sudo without a password,
 * without itself escalating (`become: false`) and without failing the play
 * on a non-zero result (`failed_when: false`) — the result is inspected by
 * `SUDO_PRECHECK_ASSERT_TASK` instead, so the failure is reported with a
 * clear, actionable message rather than surfacing as an opaque module
 * execution failure.
 */
const SUDO_PRECHECK_PROBE_TASK: Record<string, unknown> = {
  name: 'precheck : Probe passwordless sudo',
  'ansible.builtin.command': { cmd: 'sudo -n true' },
  become: false,
  changed_when: false,
  failed_when: false,
  register: SUDO_PROBE_REGISTER_VAR,
  tags: 'always',
}

/**
 * Fails the play with an actionable message when `SUDO_PRECHECK_PROBE_TASK`
 * reported a non-zero return code (sudo required a password). Every bundled
 * role runs privileged tasks (apt/user/ufw/etc.), so NOPASSWD sudo is a hard
 * prerequisite for server setup — this is a deliberate design constraint, not
 * a feature this runner supports working around.
 */
const SUDO_PRECHECK_ASSERT_TASK: Record<string, unknown> = {
  name: 'precheck : Verify passwordless sudo',
  'ansible.builtin.fail': {
    msg:
      'Passwordless (NOPASSWD) sudo is required for server setup, but the SSH '
      + "user '{{ ansible_user }}' cannot escalate without a password on "
      + '{{ inventory_hostname }}. Grant NOPASSWD sudo to this user (e.g. a '
      + 'sudoers entry) and retry. Server setup does not support '
      + 'password-based sudo.',
  },
  when: `${SUDO_PROBE_REGISTER_VAR}.rc | default(1) != 0`,
  become: false,
  tags: 'always',
}

export interface RunServerSetupContext {
  commandId: string
  client: ApiClient
  agentId?: string
}

interface ValidatedServerSetupPayload {
  executionId: string
  sshHostId: string
  body: string
}

/**
 * Resolve the authoritative route mode for the guard, **fail-closed**.
 *
 * The lenient `resident` allowlist is only ever selected when the execution is
 * *positively* known to be the customer's own closed-network resident agent.
 * Anything else — including any state we cannot positively classify — uses the
 * strict `ecs` allowlist. Resolution order:
 *
 * 1. **`payload.dispatchMode` (authoritative)**: the api dispatch service
 *    (`ServerSetupDispatchService`) now stamps every `server_setup_exec`
 *    command with `dispatchMode`: `ecs_oneshot`=当社基盤 → strict `ecs`;
 *    `resident_agent`=顧客の自機・閉域 → lenient `resident`. When present it is
 *    always preferred over the local environment.
 * 2. **`AGENT_MODE` (fallback, only when `dispatchMode` is absent)**: a payload
 *    from an older/tampered api build may omit `dispatchMode`. The local
 *    `AGENT_MODE=oneshot` (set via `containerOverrides` on our ECS controller)
 *    still positively confirms the strict `ecs` route. `AGENT_MODE` is **never**
 *    a positive signal for `resident` — a resident agent has no env value that
 *    proves it is one — so it can only ever confirm `ecs`.
 * 3. **Fail closed**: an absent/unknown `dispatchMode` combined with a
 *    non-oneshot/unset `AGENT_MODE` cannot be positively resolved to
 *    `resident`, so it defaults to the strictest `ecs` allowlist. (The previous
 *    implementation defaulted the other way — to lenient `resident` — which
 *    fail-*open*ed the guard whenever the env was misconfigured or the payload
 *    tampered.)
 */
export function resolveRouteMode(
  payload?: Pick<ServerSetupExecPayload, 'dispatchMode'> | null,
  env: NodeJS.ProcessEnv = process.env,
): AnsibleTaskRouteMode {
  const dispatchMode = payload?.dispatchMode

  // (1) Authoritative api dispatch hint.
  if (dispatchMode === 'resident_agent') return 'resident'
  if (dispatchMode === 'ecs_oneshot') return 'ecs'

  // (2) No usable dispatchMode: AGENT_MODE=oneshot still positively confirms
  // the strict ECS oneshot route.
  if (dispatchMode === undefined && env[ONESHOT_ENV_VARS.AGENT_MODE] === AGENT_MODE_ONESHOT) {
    return 'ecs'
  }

  // (3) Fail closed: anything not positively resolved to `resident` above uses
  // the strictest allowlist.
  return 'ecs'
}

/**
 * Structural validation of the `server_setup_exec` payload plus an authoritative
 * pre-check of `body` with the task guard (empty secret set — the real
 * `secretNames` are applied in a second pass inside `runServerSetup`). Rejecting
 * here happens *before* any SSH credential fetch or temp dir creation, exactly
 * like every other malformed-payload check.
 */
function validatePayload(
  p: ServerSetupExecPayload,
  mode: AnsibleTaskRouteMode,
): ValidatedServerSetupPayload | string {
  const executionId = typeof p?.executionId === 'string' && p.executionId ? p.executionId : null
  if (!executionId) return 'executionId is required for server_setup_exec'

  const sshHostId = typeof p?.sshHostId === 'string' && p.sshHostId ? p.sshHostId : null
  if (!sshHostId) return 'sshHostId is required for server_setup_exec'

  const body = typeof p?.body === 'string' && p.body.trim() ? p.body : null
  if (!body) return 'body (non-empty Ansible task list YAML) is required for server_setup_exec'

  // Authoritative re-validation. The api side (`ServerSetupRecipeService`)
  // already runs the guard at save time, but that must not be trusted as the
  // sole gate: a payload reaching this agent could originate from a
  // compromised/buggy api build, a replayed/tampered command, or a future
  // dispatch path that forgot to call it. This is the *authoritative*
  // re-validation — rejecting here, before any SSH credential fetch or temp dir
  // creation, exactly like every other malformed-payload check above.
  const guardResult = validateAnsibleTasks(body, { mode })
  if (!guardResult.ok) {
    return `server_setup_exec: recipe body rejected: ${JSON.stringify(guardResult.violations)}`
  }

  return { executionId, sshHostId, body }
}

/**
 * Resolve the directory containing the bundled Ansible roles.
 * At runtime `__dirname` is `dist/server-setup` (npm-installed) or
 * `src/server-setup` (ts-node dev); the package root is two levels up in
 * both cases — the same depth used by `getDockerContextDir()` in
 * `src/docker/dockerfile-path.ts`.
 */
function resolveAnsibleDir(): string {
  return path.join(__dirname, '..', '..', 'ansible')
}

/**
 * Resolve the bundled `roles/` directory that `include_role` tasks in the body
 * resolve against (via `ANSIBLE_ROLES_PATH`). Its absence is a packaging error
 * — surfaced as a clear failure before any temp dir (and therefore private
 * key) is created.
 */
function resolveRolesPath(): string {
  const rolesPath = path.join(resolveAnsibleDir(), 'roles')
  if (!existsSync(rolesPath)) {
    throw new Error(`Ansible roles directory not found: ${rolesPath}`)
  }
  return rolesPath
}

/**
 * Resolve the bundled `callback_plugins/` directory that provides the `json`
 * stdout callback (`callback_plugins/json.py`) selected via
 * `ANSIBLE_STDOUT_CALLBACK=json`.
 *
 * ansible-core ships no `json` stdout callback of its own, so the agent bundles
 * one. Ansible auto-discovers callback plugins only from a `callback_plugins/`
 * directory next to the *running* playbook, but the generated playbook runs
 * from a per-run temp dir — not from `ansible/` — so the callback is never
 * adjacent to it. `ANSIBLE_CALLBACK_PLUGINS` must therefore point Ansible at
 * the bundled dir explicitly (mirroring how `ANSIBLE_ROLES_PATH` exposes the
 * bundled roles). Without it, ansible-playbook aborts before running anything
 * with `ERROR! Invalid callback for stdout specified: json`. Its absence is a
 * packaging error — surfaced as a clear failure before any temp dir (and
 * therefore private key) is created.
 */
function resolveCallbackPluginsPath(): string {
  const callbackPluginsPath = path.join(resolveAnsibleDir(), 'callback_plugins')
  // Check the actual json.py callback file, not just the directory: a partial
  // package (dir present, json.py missing) must fail here, up front, rather than
  // pass this guard and reproduce "Invalid callback for stdout specified: json"
  // only after the temp dir and SSH private key have been written to disk.
  const jsonCallbackFile = path.join(callbackPluginsPath, 'json.py')
  if (!existsSync(jsonCallbackFile)) {
    throw new Error(
      `Ansible json stdout callback not found: ${jsonCallbackFile}`,
    )
  }
  return callbackPluginsPath
}

/**
 * JIT fetch of project (`ANSIBLE#`-prefixed `ConfigSetting`) variables for this
 * `server_setup_exec` command's Ansible tasks. Thin wrapper around
 * `ApiClient.getServerSetupVariables` — kept as its own function (rather than
 * calling the client inline in `runServerSetup`) so it can be unit-tested in
 * isolation and so its call site reads the same way as
 * `getServerSetupSshCredential`'s.
 *
 * The returned `secretNames` feed both `validateAnsibleTasks`'s `no_log`
 * annotation and this module's post-execution redaction (see
 * `redactSecretValues`) — the belt-and-suspenders fallback for a task that
 * somehow still printed a secret's plaintext despite `no_log`.
 */
export async function fetchServerSetupVariables(
  client: ApiClient,
  commandId: string,
  agentId: string,
): Promise<ServerSetupVariablesResponse> {
  logger.debug(`Fetching server setup variables for command: ${commandId}`)
  return client.getServerSetupVariables(commandId, agentId)
}

/**
 * Build the playbook YAML for a run: a single play with agent-fixed
 * `hosts`/`become`/`gather_facts`, whose `tasks` are the system-generated
 * prechecks — explicit fact-gathering, a NOPASSWD-sudo probe/assert, then the
 * OS check — followed by the tenant admin's validated (+`no_log`-annotated)
 * body tasks. The caller never supplies play-level keys (the guard rejects
 * any `hosts`/`roles`/`vars_files` element), so the play here cannot be
 * hijacked.
 */
export function generatePlaybook(bodyTasks: readonly Record<string, unknown>[]): string {
  const playbook: Record<string, unknown>[] = [
    {
      name: 'AI Support Agent server setup',
      hosts: 'all',
      become: true,
      // The implicit gather_facts task would inherit become:true and fail on
      // any host lacking NOPASSWD sudo; facts are gathered explicitly instead
      // (see GATHER_FACTS_TASK below).
      gather_facts: false,
      tasks: [
        GATHER_FACTS_TASK,
        SUDO_PRECHECK_PROBE_TASK,
        SUDO_PRECHECK_ASSERT_TASK,
        PRECHECK_TASK,
        ...bodyTasks,
      ],
    },
  ]
  return dump(playbook)
}

// redactSecretValues moved to ../utils/secret-redaction (shared by claude-code-runner.ts /
// codex-runner.ts). Re-exported here (see import above) so existing imports from this
// module keep working.
export { redactSecretValues }

/**
 * Plain hostname or dotted-decimal IPv4 address: letters/digits/hyphens/dots
 * only — no whitespace, quotes, `=`, or other characters that could be
 * (mis)parsed as an extra inventory variable assignment.
 */
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
/** Portable username: letters/digits/underscore/hyphen only. */
const USERNAME_RE = /^[A-Za-z0-9_-]+$/

/** True when `value` is an integer in the valid TCP port range (1-65535). */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

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
function validateSshCredential(credential: SshExecCredential): string | null {
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
    return `SSH credential authType is not supported: ${JSON.stringify(credential.authType)}`
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
function buildInventory(credential: SshExecCredential, keyPath: string, knownHostsPath: string): string {
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
        },
      },
    },
  }
  return JSON.stringify(inventory)
}

interface AnsibleRunResult {
  /** Process exit code. `0` on success; best-effort `1` when no numeric code is available. */
  code: number
  stdout: string
  stderr: string
  /** True when the process was killed for exceeding `ANSIBLE_TIMEOUT_MS`. */
  timedOut: boolean
  /**
   * Set when `ansible-playbook` itself could not be started (e.g. `ENOENT` if
   * the binary is missing, `EACCES` if it isn't executable) — as opposed to
   * starting and exiting non-zero.
   */
  spawnError: string | null
}

/**
 * Parse an optional uid/gid override from an environment variable value.
 * Returns `undefined` for an unset/empty/non-numeric value so the caller can
 * omit the corresponding `execFile` option entirely.
 */
function parseOptionalUidOrGid(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Run `ansible-playbook` via execFile (never a shell) so body content (which
 * flows into files, not shell arguments) cannot be used for shell injection.
 * Resolves rather than rejects on a non-zero exit so callers can still parse
 * the JSON callback output produced before the failure. A hard `timeout` (see
 * `ANSIBLE_TIMEOUT_MS`) guards against a hung target host.
 *
 * Opt-in non-root execution: when `AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID`
 * / `_GID` are set, `ansible-playbook` itself is spawned under that uid/gid —
 * an additional containment layer for a compromised custom task running *on the
 * agent host* (e.g. via allow-listed `ansible.builtin.command`/`shell`),
 * independent of `become: true`'s escalation on the *target* host over SSH.
 */
function runAnsiblePlaybook(args: string[], env: NodeJS.ProcessEnv): Promise<AnsibleRunResult> {
  const uid = parseOptionalUidOrGid(process.env[ENV_VARS.SERVER_SETUP_ANSIBLE_UID])
  const gid = parseOptionalUidOrGid(process.env[ENV_VARS.SERVER_SETUP_ANSIBLE_GID])
  return new Promise((resolve) => {
    execFile(
      'ansible-playbook',
      args,
      {
        env,
        maxBuffer: ANSIBLE_MAX_BUFFER_BYTES,
        timeout: ANSIBLE_TIMEOUT_MS,
        ...(uid !== undefined && { uid }),
        ...(gid !== undefined && { gid }),
      },
      (error, stdout, stderr) => {
        const stdoutStr = stdout ? stdout.toString() : ''
        const stderrStr = stderr ? stderr.toString() : ''

        if (!error) {
          resolve({ code: 0, stdout: stdoutStr, stderr: stderrStr, timedOut: false, spawnError: null })
          return
        }

        const err = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: NodeJS.Signals | null }
        // Node sets `killed: true` (with the `killSignal`, SIGTERM by default)
        // when execFile's own `timeout` option fires.
        const timedOut = err.killed === true
        const numericCode = typeof err.code === 'number' ? err.code : null
        // A non-numeric `code` (e.g. the string 'ENOENT'/'EACCES') combined
        // with no captured output at all means execFile failed to spawn the
        // process — as opposed to the process starting and exiting non-zero.
        const spawnError = !timedOut && numericCode === null && !stdoutStr && !stderrStr ? getErrorMessage(error) : null

        resolve({
          code: numericCode ?? 1,
          stdout: stdoutStr,
          stderr: stderrStr,
          timedOut,
          spawnError,
        })
      },
    )
  })
}

interface AnsibleJsonHostResult {
  failed?: boolean
  changed?: boolean
  skipped?: boolean
  unreachable?: boolean
  msg?: string
}

interface AnsibleJsonTask {
  task?: { name?: string }
  hosts?: Record<string, AnsibleJsonHostResult>
}

interface AnsibleJsonPlay {
  tasks?: AnsibleJsonTask[]
}

interface AnsibleJsonOutput {
  plays?: AnsibleJsonPlay[]
}

interface ParsedAnsibleOutput {
  taskResults: ServerSetupTaskResult[]
  /**
   * True when `rawOutput` was empty or not valid JSON at all — as opposed to
   * parsing successfully into an object that merely lacks tasks.
   * `runServerSetup` must never report `successResult` on top of this: an
   * empty/unparseable stdout despite a `0` exit code means the `json` callback
   * plugin never ran, so there is no reliable signal that anything actually
   * happened.
   */
  outputUnparseable: boolean
}

/**
 * Derive one `ServerSetupTaskResult` from a task's per-host results.
 * `unreachable` is folded into `failed` (with a sensible default message), so
 * the reported status set stays `ok`/`failed`/`skipped`.
 */
function taskResultFrom(name: string, results: AnsibleJsonHostResult[]): ServerSetupTaskResult {
  const changed = results.some((r) => r.changed === true)
  const failedResult = results.find((r) => r.failed === true || r.unreachable === true)
  if (failedResult) {
    const message =
      failedResult.msg ?? (failedResult.unreachable === true ? 'host unreachable' : `${name} failed`)
    return { name, status: 'failed', changed, message }
  }
  if (results.length > 0 && results.every((r) => r.skipped === true)) {
    return { name, status: 'skipped', changed: false, message: `${name} skipped` }
  }
  return { name, status: 'ok', changed, message: `${name} completed` }
}

/**
 * Parse the `ansible-playbook --stdout-callback=json`-style output into one
 * result **per task** (the previous per-stepType grouping is gone). Tasks with
 * no name and no host results are skipped entirely.
 */
export function parseAnsibleOutput(rawOutput: string): ParsedAnsibleOutput {
  let parsed: AnsibleJsonOutput | null = null
  let outputUnparseable = false
  if (!rawOutput || !rawOutput.trim()) {
    outputUnparseable = true
  } else {
    try {
      parsed = JSON.parse(rawOutput) as AnsibleJsonOutput
    } catch {
      parsed = null
      outputUnparseable = true
    }
  }

  const taskResults: ServerSetupTaskResult[] = []
  for (const play of parsed?.plays ?? []) {
    for (const task of play.tasks ?? []) {
      const name = task.task?.name ?? ''
      const hostResults = Object.values(task.hosts ?? {})
      // A task with neither a name nor any host result carries no information.
      if (!name && hostResults.length === 0) continue
      taskResults.push(taskResultFrom(name || 'task', hostResults))
    }
  }

  return { taskResults, outputUnparseable }
}

/** Prefix shared by every per-run temp dir `runServerSetup` creates via `mkdtempSync`. */
const SERVER_SETUP_TMP_PREFIX = 'ai-support-agent-server-setup-'

/**
 * Sweep orphaned server-setup temp dirs (SSH private key, inventory,
 * extra-vars.json, generated playbook — see `runServerSetup`'s doc comment).
 *
 * `runServerSetup` always removes its own temp dir in a `finally` block, but
 * that `finally` never runs if the resident agent process itself is
 * SIGKILL'd / OOM-killed / crashes / is forcibly restarted mid-run — the
 * private-key-holding dir is then orphaned in `/tmp` forever. Over a resident
 * agent's long uptime these accumulate and can exhaust `/tmp`, causing
 * `mkdtempSync` itself to fail with ENOSPC (same failure mode already fixed
 * for `terminal-sandbox-*` dirs by `TerminalSession.cleanupStaleSandboxes`
 * and for per-command MCP config files by `cleanupStaleCommandMcpConfigs` —
 * this mirrors that same pattern here).
 *
 * Defaults to only dirs at least 24h old so a concurrently in-flight
 * `runServerSetup` call on another process is never touched. `maxAgeMs=0`
 * removes all matching dirs regardless of age.
 *
 * A dedicated, fully-namespaced prefix (rather than a short generic one) is
 * used so this sweep can never mistake an unrelated app's `/tmp` entry for
 * one of ours. Individual removal failures (e.g. a permissions error) are
 * logged rather than silently swallowed, since the resource at stake is a
 * plaintext SSH private key.
 *
 * @param maxAgeMs delete dirs at least this old (ms); 0 removes all
 * @param baseDir directory to scan, overridable so tests never sweep the
 *   real `/tmp` (defaults to `os.tmpdir()`)
 * @returns number of dirs removed
 */
export function cleanupStaleServerSetupDirs(
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  baseDir: string = os.tmpdir(),
): number {
  return sweepStaleEntries(baseDir, (name) => name.startsWith(SERVER_SETUP_TMP_PREFIX), {
    maxAgeMs,
    recursive: true,
    onError: (name, error) => {
      logger.warn(`[server-setup] Failed to clean up stale server-setup dir ${name}: ${getErrorMessage(error)}`)
    },
  })
}

/**
 * Execute a `server_setup_exec` command: re-validate the body, fetch the SSH
 * credential and project variables, generate + run the playbook, and report
 * per-task results. The temp directory holding the private key is always
 * removed, on every exit path.
 */
export async function runServerSetup(
  payload: ServerSetupExecPayload,
  ctx: RunServerSetupContext,
): Promise<CommandResult> {
  const mode = resolveRouteMode(payload)
  const validated = validatePayload(payload, mode)
  if (typeof validated === 'string') {
    return errorResult(validated)
  }

  // The SSH credential and the project (`ANSIBLE#`) variables come from two
  // independent API calls, so fetch them concurrently rather than paying
  // both round trips back-to-back. Each settles on its own so a failure in
  // one still surfaces its own specific error message (credential error
  // takes priority when both fail, matching the previous sequential order).
  const [credentialSettled, variablesSettled] = await Promise.allSettled([
    ctx.client.getServerSetupSshCredential(ctx.commandId, ctx.agentId ?? ''),
    // JIT fetch of project variables. Fetched unconditionally so its
    // `secretNames` are available for redaction and its `variables` for
    // extra-vars.json. Placed before any temp dir is created — like the SSH
    // credential fetch — so a failure here never leaves a private-key-
    // holding temp dir behind.
    fetchServerSetupVariables(ctx.client, ctx.commandId, ctx.agentId ?? ''),
  ])

  if (credentialSettled.status === 'rejected') {
    return errorResult(`Failed to fetch SSH credential: ${getErrorMessage(credentialSettled.reason)}`)
  }
  const credential: SshExecCredential = credentialSettled.value

  const credentialError = validateSshCredential(credential)
  if (credentialError) {
    return errorResult(credentialError)
  }

  if (variablesSettled.status === 'rejected') {
    return errorResult(`Failed to fetch server setup variables: ${getErrorMessage(variablesSettled.reason)}`)
  }
  const serverSetupVariables: ServerSetupVariablesResponse = variablesSettled.value

  // Extra-vars always outrank a `register`ed variable in Ansible's precedence
  // order, so a project variable that happened to share SUDO_PROBE_REGISTER_VAR's
  // name would silently shadow the sudo probe's result. Fail closed with a
  // clear message instead of letting the precheck misbehave.
  if (Object.prototype.hasOwnProperty.call(serverSetupVariables.variables, SUDO_PROBE_REGISTER_VAR)) {
    return errorResult(
      `Project variable name '${SUDO_PROBE_REGISTER_VAR}' is reserved for server setup's internal `
      + 'passwordless-sudo precheck and cannot be used. Rename this project variable and retry.',
    )
  }

  let rolesPath: string
  let callbackPluginsPath: string
  try {
    rolesPath = resolveRolesPath()
    callbackPluginsPath = resolveCallbackPluginsPath()
  } catch (error) {
    return errorResult(getErrorMessage(error))
  }

  // Persistent (not per-run) known_hosts file, namespaced by tenant + SSH host,
  // so `StrictHostKeyChecking=accept-new` (TOFU) actually detects a host key
  // change across runs. Resolved before the temp dir is created so a failure
  // here never leaves a private-key-holding temp dir behind.
  let knownHostsPath: string
  try {
    knownHostsPath = resolveKnownHostsPath(ctx.client.getTenantCode(), validated.sshHostId)
  } catch (error) {
    return errorResult(`Failed to resolve known_hosts file: ${getErrorMessage(error)}`)
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), SERVER_SETUP_TMP_PREFIX))
  // Every exit path below assigns `result`, but keep a safe default so
  // TypeScript's definite-assignment analysis can't leave it unset by the time
  // `finally` reads it.
  let result: CommandResult = errorResult('server_setup_exec: no result was produced')
  try {
    result = await (async (): Promise<CommandResult> => {
      // `credential.privateKey` only holds actual key material when
      // authType !== 'password' (see buildInventory's doc comment) — writing
      // a plaintext password here as if it were a key file is what caused
      // OpenSSH's "error in libcrypto" (it can't parse a password as PEM/
      // OpenSSH key data).
      const keyPath = path.join(tmpDir, 'id_rsa')
      if (credential.authType !== 'password') {
        // 0600: only the current user may read/write the private key.
        writeFileSync(keyPath, credential.privateKey, { mode: 0o600 })
      }

      // Written with a .yml extension (JSON is valid YAML) so ansible-core's
      // bundled `yaml` inventory plugin — matched by file extension — parses it
      // unambiguously; see buildInventory's doc comment.
      // 0600: for a password credential this file carries the plaintext
      // password (ansible_ssh_pass) — same permission level as id_rsa/
      // extra-vars.json alongside it.
      const inventoryPath = path.join(tmpDir, 'inventory.yml')
      writeFileSync(inventoryPath, buildInventory(credential, keyPath, knownHostsPath), { mode: 0o600 })

      // Project (`ANSIBLE#`) variables are the entire extra-vars set now that
      // per-step params are gone; body tasks reference them via `{{ VAR }}`.
      const extraVarsPath = path.join(tmpDir, 'extra-vars.json')
      // 0600: extra-vars.json may carry ANSIBLE# project secret values in
      // plaintext — same permission level as the private key alongside it.
      writeFileSync(extraVarsPath, JSON.stringify(serverSetupVariables.variables), { mode: 0o600 })

      // Re-validate the body with the *real* `secretNames` just fetched, so the
      // normalized tasks carry accurate `no_log: true` annotations.
      // `validatePayload` already proved the body passes the guard with an
      // empty secret set, so a rejection here would mean the guard's own
      // behavior is non-deterministic across calls — treated as an internal
      // error (fail-closed) rather than silently proceeding.
      const secretNameSet = new Set(serverSetupVariables.secretNames)
      const guardResult = validateAnsibleTasks(validated.body, { mode, secretVarNames: secretNameSet })
      if (!guardResult.ok || !guardResult.normalizedTasks) {
        logger.error(
          `[server-setup] recipe body guard re-validation failed unexpectedly: ${JSON.stringify(guardResult.violations)}`,
        )
        return errorResult(
          `server_setup_exec: recipe body rejected at execution time: ${JSON.stringify(guardResult.violations)}`,
        )
      }

      const playbookPath = path.join(tmpDir, 'generated-playbook.yml')
      writeFileSync(playbookPath, generatePlaybook(guardResult.normalizedTasks))

      const args = ['-i', inventoryPath, playbookPath, '-e', `@${extraVarsPath}`]

      logger.info(
        `[server-setup] Running ansible-playbook: executionId=${validated.executionId} mode=${mode} tasks=${guardResult.normalizedTasks.length}`,
      )
      const { code, stdout: rawStdout, stderr: rawStderr, timedOut, spawnError } = await runAnsiblePlaybook(args, {
        ...process.env,
        ANSIBLE_STDOUT_CALLBACK: 'json',
        // Lets the generated playbook (written to tmpDir, outside
        // ansible/roles/) resolve the 6 bundled roles by name via `include_role`.
        ANSIBLE_ROLES_PATH: rolesPath,
        // Exposes the bundled `json` stdout callback (callback_plugins/json.py)
        // to Ansible. The generated playbook runs from tmpDir, not from
        // ansible/, so Ansible's playbook-adjacent auto-discovery can't find it;
        // without this the run aborts with "Invalid callback for stdout
        // specified: json".
        ANSIBLE_CALLBACK_PLUGINS: callbackPluginsPath,
      })

      // Belt-and-suspenders redaction (see redactSecretValues's doc comment):
      // applied to the raw stdout/stderr *before* anything else reads them.
      // The SSH password (credential.privateKey when authType === 'password')
      // is included unconditionally — it never appears in secretNameSet
      // (that only covers tenant ANSIBLE# project variables) but is exactly
      // as sensitive, and `ansible-task-guard`'s no_log annotation is a
      // first line of defense, not the only one.
      const secretValues = Object.entries(serverSetupVariables.variables)
        .filter(([name]) => secretNameSet.has(name))
        .map(([, value]) => value)
      if (credential.authType === 'password') {
        secretValues.push(credential.privateKey)
      }
      const stdout = redactSecretValues(rawStdout, secretValues)
      const stderr = redactSecretValues(rawStderr, secretValues)

      if (timedOut) {
        logger.error(
          `[server-setup] ansible-playbook timed out after ${ANSIBLE_TIMEOUT_MS}ms: executionId=${validated.executionId}`,
        )
        return errorResult(`ansible-playbook execution timed out after ${Math.floor(ANSIBLE_TIMEOUT_MS / 1000)}s`)
      }

      if (spawnError) {
        // The process never started (e.g. `ansible-playbook` missing from PATH)
        // — there is no task output to parse, so `stepResults` is deliberately
        // omitted rather than reported as anything misleading.
        logger.error(`[server-setup] Failed to start ansible-playbook: ${spawnError}`)
        return errorResult(`Failed to start ansible-playbook: ${spawnError}`)
      }

      const { taskResults, outputUnparseable } = parseAnsibleOutput(stdout)

      if (code !== 0) {
        const detail = stderr ? stderr.substring(0, 2000) : ''
        // Surface each failing task's own message so the reason a run failed
        // (unsupported OS from the precheck, an unreachable host, a body task
        // error) is never lost behind a bare exit code.
        const failedTasks = taskResults.filter((t) => t.status === 'failed')
        const failedDetail = failedTasks.length ? ` | ${failedTasks.map((t) => `${t.name}: ${t.message}`).join('; ')}` : ''
        logger.error(`[server-setup] ansible-playbook exited with code ${code}`)
        return errorResult(
          `ansible-playbook exited with code ${code}${detail ? `: ${detail}` : ''}${failedDetail}`,
          { stepResults: taskResults },
        )
      }

      // Reaching here means ansible-playbook exited 0 — but a `0` exit code
      // alone is not sufficient evidence that the tasks actually ran: a stdout
      // callback that silently failed to load, or an ansible-core output-format
      // change, would otherwise be reported as a quiet successResult.
      if (outputUnparseable) {
        logger.error(
          `[server-setup] ansible-playbook exited 0 but stdout was ${stdout.trim() ? 'not valid JSON' : 'empty'}: executionId=${validated.executionId}`,
        )
        return errorResult(
          `ansible-playbook exited 0 but its stdout ${stdout.trim() ? 'could not be parsed as JSON' : 'was empty'} — unable to confirm the recipe actually ran (json stdout callback not loaded, or an unexpected ansible-core output format)`,
        )
      }

      // A well-formed run always produces at least the always-tagged precheck
      // task's output. Zero parsed tasks despite a 0 exit means the JSON stream
      // was truncated or the callback misbehaved — fail closed rather than
      // silently report success.
      if (taskResults.length === 0) {
        logger.error(
          `[server-setup] ansible-playbook exited 0 but produced no task output: executionId=${validated.executionId}`,
        )
        return errorResult(
          'ansible-playbook exited 0 but produced no task output — treating the run as failed rather than silently reporting success',
        )
      }

      logger.success(`[server-setup] Completed: executionId=${validated.executionId}`)
      return successResult({ stepResults: taskResults })
    })()
  } catch (error) {
    result = errorResult(`Server setup execution failed: ${getErrorMessage(error)}`)
  } finally {
    // Must run on every exit path: the private key must never remain on disk
    // after this function returns.
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch (cleanupError) {
      const message = getErrorMessage(cleanupError)
      logger.error(`[server-setup] Failed to remove temp dir ${tmpDir}: ${message}`)
      result = attachCleanupFailure(result, tmpDir)
    }
  }
  return result
}

/**
 * Fold a failed best-effort removal of the temp dir (SSH private key and
 * extra-vars.json, which may contain secret values) into the command result.
 *
 * Design choice: rather than adding a `cleanupFailed: true` flag buried inside
 * an otherwise-`success: true` result's `data`, this deliberately turns the
 * *whole* command result into a failure. Leaving secret material behind on disk
 * is a security incident in its own right; masking it behind a green result
 * risks it going unnoticed and unremediated.
 */
function attachCleanupFailure(result: CommandResult, tmpDir: string): CommandResult {
  const note = `Failed to remove temp dir ${tmpDir} after server setup execution; it may still contain the SSH private key and project secret values — manual cleanup of that directory is required.`
  if (result.success) {
    return errorResult(note, result.data)
  }
  return errorResult(`${result.error} | ${note}`, result.data)
}
