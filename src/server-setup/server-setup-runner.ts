/**
 * Runner for the `server_setup_exec` command.
 *
 * Fetches the target host's SSH private key Just-In-Time from the API,
 * writes it to a process-local temp directory, runs the bundled Ansible
 * playbook (`ansible/playbook.yml`) against it, and — critically — always
 * removes the temp directory (private key included) afterwards, whether the
 * run succeeded or failed. See admin-docs `docs/features/server-setup.md`
 * ("秘密鍵の受け渡し設計") for the full design and its security rationale.
 *
 * SECURITY: the SSH private key must never be logged, and the temp
 * directory holding it must never survive past this function's execution.
 */

import { execFile } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dump } from 'js-yaml'
import * as os from 'os'
import * as path from 'path'

import { ENV_VARS, TAILSCALE_SOCKS_PORT } from '../constants'
import { logger } from '../logger'
import {
  type CommandResult,
  errorResult,
  type ServerSetupCustomTaskMode,
  type ServerSetupExecPayload,
  type ServerSetupStep,
  type ServerSetupStepResult,
  type ServerSetupVariablesResponse,
  type SshExecCredential,
  successResult,
} from '../types'
import { getErrorMessage } from '../utils'

import { validateCustomTasksYaml } from './ansible-task-guard'
import { resolveKnownHostsPath } from './known-hosts-store'

import type { ApiClient } from '../api-client'

/** Valid values for `steps[].customTasksMode` (see `ServerSetupCustomTaskMode`). */
const ALLOWED_CUSTOM_TASK_MODES: ReadonlySet<string> = new Set(['append', 'replace'])

/** stepType values supported by the bundled Ansible roles (MVP scope). */
const ALLOWED_STEP_TYPES: ReadonlySet<string> = new Set([
  'os_init',
  'docker',
  'web_server',
  'database',
  'dns_tls',
])

/**
 * Allow-list of `params` keys accepted per `stepType`, matching exactly the
 * Jinja variables each bundled role (`ansible/roles/<stepType>/tasks/main.yml`)
 * reads. All `steps[].params` entries are merged into a single
 * `extra-vars.json` passed as `ansible-playbook -e @extra-vars.json`.
 * extra-vars has the *highest* variable precedence in Ansible — higher than
 * inventory vars — so without this allow-list a caller could smuggle in an
 * Ansible "magic variable" (e.g. `ansible_connection: "local"`,
 * `ansible_host`, `ansible_ssh_private_key_file`) as a step param and
 * redirect the whole `become: true` playbook run onto the agent host itself
 * instead of the intended target (see `isReservedOrMagicParamKey` for the
 * belt-and-suspenders check that also blocks any `ansible_`-prefixed key
 * regardless of this table).
 */
const ALLOWED_STEP_PARAMS: Readonly<Record<ServerSetupStep['stepType'], ReadonlySet<string>>> = {
  os_init: new Set(),
  docker: new Set(),
  web_server: new Set(['web_server_type']),
  database: new Set(['db_type', 'db_root_password']),
  dns_tls: new Set(['domain']),
}

/**
 * Enum-valued `params` keys: the bundled Ansible roles branch on these with a
 * plain string `when: x == 'y'` comparison (see `ansible/roles/database` and
 * `ansible/roles/web_server`), so a typo'd or otherwise-unrecognized value
 * (wrong case, extra whitespace, an unsupported db engine, ...) matches
 * *none* of the role's `when` conditions. Every task in that role is then
 * silently skipped, `ansible-playbook` still exits 0, and — without this
 * check — `runServerSetup` would report the step as a `successResult` even
 * though nothing was actually installed. Rejecting unrecognized values here,
 * before the command ever runs, turns that silent no-op into an explicit
 * validation error. `ansible/roles/database/tasks/main.yml` and
 * `ansible/roles/web_server/tasks/main.yml` also `assert` these same values
 * as a second, independent safety net in case this allow-list and the
 * Ansible roles ever drift apart.
 */
const STEP_PARAM_ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  db_type: new Set(['mysql', 'postgresql']),
  web_server_type: new Set(['nginx', 'apache']),
}

/**
 * `params` key that MUST be present for a given `stepType` (stepTypes not
 * listed here, e.g. `os_init`/`docker`, have no required param). Without
 * this, a step whose param *key* is entirely absent — e.g.
 * `{ stepType: 'database', params: {} }` — passes every other check (there
 * is no value at all to validate against `STEP_PARAM_ENUM_VALUES`) and
 * reaches the bundled Ansible role, where every task is gated on
 * `db_type == '...'`/`db_type is defined`
 * (`ansible/roles/database/tasks/main.yml`), so *all* of them silently skip
 * while `ansible-playbook` still exits 0 — `runServerSetup` would then
 * report the step as a `successResult` despite installing nothing. Rejecting
 * the missing key here, before the command ever runs, closes that gap the
 * same way `STEP_PARAM_ENUM_VALUES` closes it for a recognized-but-invalid
 * value.
 */
const REQUIRED_STEP_PARAMS: Readonly<Partial<Record<ServerSetupStep['stepType'], string>>> = {
  database: 'db_type',
  web_server: 'web_server_type',
  dns_tls: 'domain',
}

/**
 * Ansible "magic variables" / other reserved names that must never be
 * settable via `steps[].params`, no matter what `ALLOWED_STEP_PARAMS` says
 * for a given stepType. This is deliberately conservative and checked
 * independently of the per-stepType allow-list above.
 */
const RESERVED_PARAM_KEYS: ReadonlySet<string> = new Set([
  'hostvars',
  'groups',
  'group_names',
  'environment',
  'omit',
  'inventory_hostname',
  'inventory_hostname_short',
  'inventory_dir',
  'inventory_file',
  'playbook_dir',
  'play_hosts',
  'role_name',
  'role_names',
  'role_path',
])

/** True if `key` is an Ansible magic variable / connection-control name that must never be caller-controlled. */
function isReservedOrMagicParamKey(key: string): boolean {
  return key.startsWith('ansible_') || RESERVED_PARAM_KEYS.has(key)
}

/** Cap on buffered ansible-playbook stdout/stderr to avoid unbounded memory growth. */
const ANSIBLE_MAX_BUFFER_BYTES = 20 * 1024 * 1024

/**
 * Hard wall-clock cap on the whole `ansible-playbook` invocation (all
 * requested steps together). Without this, a hung target host (unreachable
 * SSH, an apt/dpkg lock held forever, etc.) would leave `runServerSetup`
 * pending forever: the resident agent's `processing` flag would stay stuck
 * and the temp directory holding the SSH private key would remain on disk
 * indefinitely. 30 minutes comfortably covers `os_init`'s `apt dist-upgrade`
 * (the slowest single step) plus every other role in one run.
 */
const ANSIBLE_TIMEOUT_MS = 30 * 60 * 1000

export interface RunServerSetupContext {
  commandId: string
  client: ApiClient
  agentId?: string
}

interface ValidatedServerSetupPayload {
  executionId: string
  sshHostId: string
  steps: ServerSetupStep[]
}

function validatePayload(p: ServerSetupExecPayload): ValidatedServerSetupPayload | string {
  const executionId = typeof p?.executionId === 'string' && p.executionId ? p.executionId : null
  if (!executionId) return 'executionId is required for server_setup_exec'

  const sshHostId = typeof p?.sshHostId === 'string' && p.sshHostId ? p.sshHostId : null
  if (!sshHostId) return 'sshHostId is required for server_setup_exec'

  if (!Array.isArray(p?.steps) || p.steps.length === 0) {
    return 'steps (non-empty array) is required for server_setup_exec'
  }

  const steps: ServerSetupStep[] = []
  for (let i = 0; i < p.steps.length; i++) {
    const raw = p.steps[i] as unknown
    if (typeof raw !== 'object' || raw === null) {
      return `steps[${i}] must be an object`
    }
    const stepType = (raw as { stepType?: unknown }).stepType
    if (typeof stepType !== 'string' || !ALLOWED_STEP_TYPES.has(stepType)) {
      return `steps[${i}].stepType must be one of: ${[...ALLOWED_STEP_TYPES].join(', ')}`
    }
    const rawParams = (raw as { params?: unknown }).params ?? {}
    if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
      return `steps[${i}].params must be an object`
    }
    const allowedParams = ALLOWED_STEP_PARAMS[stepType as ServerSetupStep['stepType']]
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        return `steps[${i}].params.${key} must be a string`
      }
      // Checked before the per-stepType allow-list so that a magic-variable
      // key is rejected with an unambiguous reason even if a future
      // ALLOWED_STEP_PARAMS entry were mistakenly made too permissive.
      if (isReservedOrMagicParamKey(key)) {
        return `steps[${i}].params.${key} is not allowed (reserved Ansible variable name)`
      }
      if (!allowedParams.has(key)) {
        return `steps[${i}].params.${key} is not an allowed parameter for stepType '${stepType}'`
      }
      const enumValues = STEP_PARAM_ENUM_VALUES[key]
      if (enumValues && !enumValues.has(value)) {
        return `steps[${i}].params.${key} must be one of: ${[...enumValues].join(', ')} (got ${JSON.stringify(value)})`
      }
      params[key] = value
    }
    const requiredParam = REQUIRED_STEP_PARAMS[stepType as ServerSetupStep['stepType']]
    if (requiredParam && !(requiredParam in params)) {
      return `steps[${i}].params.${requiredParam} is required for stepType '${stepType}'`
    }

    // Tenant-admin-authored custom Ansible tasks (admin-docs
    // docs/features/server-setup.md "カスタムAnsibleタスク"). The api side
    // (`ServerSetupRecipeService`) already runs `validateCustomTasksYaml` at
    // save time, but that check must not be trusted as the sole gate: a
    // payload reaching this agent could originate from a compromised/buggy
    // api build, a replayed/tampered command, or a future dispatch path that
    // forgot to call it. This is the *authoritative* re-validation —
    // rejecting here, before any SSH credential fetch or temp dir creation,
    // exactly like every other malformed-payload check above.
    let customTasksYaml: string | undefined
    const rawCustomTasksYaml = (raw as { customTasksYaml?: unknown }).customTasksYaml
    if (rawCustomTasksYaml !== undefined) {
      if (typeof rawCustomTasksYaml !== 'string') {
        return `steps[${i}].customTasksYaml must be a string`
      }
      customTasksYaml = rawCustomTasksYaml
    }

    let customTasksMode: ServerSetupCustomTaskMode | undefined
    const rawCustomTasksMode = (raw as { customTasksMode?: unknown }).customTasksMode
    if (rawCustomTasksMode !== undefined) {
      if (typeof rawCustomTasksMode !== 'string' || !ALLOWED_CUSTOM_TASK_MODES.has(rawCustomTasksMode)) {
        return `steps[${i}].customTasksMode must be one of: ${[...ALLOWED_CUSTOM_TASK_MODES].join(', ')}`
      }
      customTasksMode = rawCustomTasksMode as ServerSetupCustomTaskMode
    }

    if (customTasksYaml !== undefined) {
      // `secretVarNames` is deliberately empty here: this is a structural
      // pre-check (allowlist/forbidden-key/lookup/play-format/reserved-name)
      // that must reject before any network call is made. The real
      // `secretNames` (fetched via `fetchServerSetupVariables`, after the SSH
      // credential is confirmed valid) are applied in a second pass inside
      // `runServerSetup` to produce the final `no_log`-annotated tasks used
      // by `generatePlaybook` — see the call site there.
      const guardResult = validateCustomTasksYaml(customTasksYaml, stepType, new Set())
      if (!guardResult.ok) {
        return `server_setup_exec: custom task rejected: ${JSON.stringify(guardResult.violations)}`
      }
    }

    steps.push({
      stepType: stepType as ServerSetupStep['stepType'],
      params,
      ...(customTasksYaml !== undefined && { customTasksYaml }),
      ...(customTasksMode !== undefined && { customTasksMode }),
    })
  }

  return { executionId, sshHostId, steps }
}

/**
 * Resolve the directory containing the bundled `playbook.yml` and roles.
 * At runtime `__dirname` is `dist/server-setup` (npm-installed) or
 * `src/server-setup` (ts-node dev); the package root is two levels up in
 * both cases — the same depth used by `getDockerContextDir()` in
 * `src/docker/dockerfile-path.ts`.
 */
function resolveAnsibleDir(): string {
  return path.join(__dirname, '..', '..', 'ansible')
}

function resolvePlaybookPath(): string {
  const playbookPath = path.join(resolveAnsibleDir(), 'playbook.yml')
  if (!existsSync(playbookPath)) {
    throw new Error(`Ansible playbook not found: ${playbookPath}`)
  }
  return playbookPath
}

/**
 * JIT fetch of project (`ANSIBLE#`-prefixed `ConfigSetting`) variables for
 * this `server_setup_exec` command's custom Ansible tasks (admin-docs
 * docs/features/server-setup.md "カスタムAnsibleタスク"). Thin wrapper around
 * `ApiClient.getServerSetupVariables` — kept as its own function (rather than
 * calling the client inline in `runServerSetup`) so it can be unit-tested in
 * isolation and so its call site reads the same way as
 * `getServerSetupSshCredential`'s.
 *
 * The returned `secretNames` feed both `validateCustomTasksYaml`'s `no_log`
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

/** One requested step's data as needed by {@link generatePlaybook}. */
export interface GeneratePlaybookStep {
  stepType: string
  customTasksMode?: string
  normalizedTasks?: Record<string, unknown>[]
}

/**
 * Build a playbook YAML string for a run that includes at least one step
 * with custom Ansible tasks (`steps[].customTasksYaml`).
 *
 * Mirrors the bundled `ansible/playbook.yml`'s structure (same precheck
 * task, transcribed verbatim below rather than read from disk so this
 * function has no filesystem dependency of its own) but adds each step's
 * `normalizedTasks` (already validated + `no_log`-annotated by
 * `validateCustomTasksYaml`) as a tagged `post_tasks` block:
 *
 * - `customTasksMode !== 'replace'` (i.e. unset or `'append'`): the bundled
 *   role for that stepType is kept in `roles:` (runs first, tagged
 *   `stepType`), and — if `normalizedTasks` is present — the custom tasks
 *   run afterwards as a `post_tasks` block with the same tag.
 * - `customTasksMode === 'replace'`: the bundled role is *not* included; only
 *   the `post_tasks` block (if any) runs for that stepType's tag.
 *
 * `--tags <stepType,...>` (built the same way as for the bundled playbook)
 * still selects which of these run: `roles:` and `post_tasks:` entries are
 * independently tagged per step, so `--tags` continues to work unmodified
 * whether or not a step carries custom tasks.
 */
export function generatePlaybook(validatedSteps: readonly GeneratePlaybookStep[]): string {
  const roles = validatedSteps
    .filter((step) => step.customTasksMode !== 'replace')
    .map((step) => ({ role: step.stepType, tags: step.stepType }))

  const postTasks = validatedSteps
    .filter((step) => Array.isArray(step.normalizedTasks) && step.normalizedTasks.length > 0)
    .map((step) => ({ block: step.normalizedTasks, tags: step.stepType }))

  const playbook: Record<string, unknown>[] = [
    {
      name: 'AI Support Agent server setup (custom tasks)',
      hosts: 'all',
      become: true,
      gather_facts: true,
      tasks: [
        // Transcribed verbatim from ansible/playbook.yml's "precheck" task —
        // see resolvePlaybookPath()'s doc comment and admin-docs
        // docs/features/server-setup.md. Keeping this in sync manually (not
        // read from disk) means the bundled playbook.yml and this generated
        // one must be kept in sync by hand if the precheck task ever changes.
        {
          name: 'precheck : Verify supported OS',
          'ansible.builtin.fail': {
            msg:
              'Unsupported OS: {{ ansible_distribution }} {{ ansible_distribution_version }}. '
              + 'Only Ubuntu 22.04/24.04 LTS are supported by server setup execution.',
          },
          when:
            "ansible_distribution != 'Ubuntu' or ansible_distribution_version not in ['22.04', '24.04']",
          tags: 'always',
        },
      ],
      ...(roles.length > 0 && { roles }),
      ...(postTasks.length > 0 && { post_tasks: postTasks }),
    },
  ]

  return dump(playbook)
}

/**
 * Replace every occurrence of each (non-empty) secret value with `***` in
 * `text`. Belt-and-suspenders redaction applied to `ansible-playbook`'s raw
 * stdout/stderr (and, transitively, every `ServerSetupStepResult.message`
 * derived from it) — the last line of defense for a secret value that leaked
 * into command output despite `no_log: true` having been applied wherever
 * `validateCustomTasksYaml` detected a `{{ secretVarName }}` reference.
 *
 * Empty-string values are skipped: replacing every occurrence of `''` would
 * corrupt the text (a global regex match on an empty string matches between
 * every character).
 */
export function redactSecretValues(text: string, secretValues: readonly string[]): string {
  let redacted = text
  for (const value of secretValues) {
    if (!value) continue
    redacted = redacted.split(value).join('***')
  }
  return redacted
}

/**
 * Plain hostname or dotted-decimal IPv4 address: letters/digits/hyphens/dots
 * only — no whitespace, quotes, `=`, or other characters that could be
 * (mis)parsed as an extra inventory variable assignment.
 */
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
/** Portable username: letters/digits/underscore/hyphen only. */
const USERNAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * Reject a fetched SSH credential whose hostname/username/port isn't a
 * plain, unambiguous value. Without this, a hostname or username containing
 * e.g. a space or an embedded `ansible_connection=local` could — once
 * written into the inventory — be parsed as *additional* inventory
 * variables for the host, redirecting the `become: true` playbook run away
 * from the intended target.
 *
 * When `connectionType === 'tailscale'` (admin-docs
 * docs/specifications/ssh-tailscale-support.md, section 3), `tailnetHostname`
 * is what actually gets written to `ansible_host` (see `buildInventory`), so
 * it is held to the exact same `HOSTNAME_RE` standard as `hostname` — an
 * unvalidated `tailnetHostname` would open the identical inventory-variable-
 * injection risk. `socksPort`, when present, is validated as a port number
 * the same way `port` already is.
 */
function validateSshCredential(credential: SshExecCredential): string | null {
  if (!HOSTNAME_RE.test(credential.hostname)) {
    return `SSH credential hostname is not a valid hostname/IP address: ${JSON.stringify(credential.hostname)}`
  }
  if (!USERNAME_RE.test(credential.username)) {
    return `SSH credential username contains disallowed characters: ${JSON.stringify(credential.username)}`
  }
  if (!Number.isInteger(credential.port) || credential.port < 1 || credential.port > 65535) {
    return `SSH credential port is out of range: ${JSON.stringify(credential.port)}`
  }
  if (credential.connectionType === 'tailscale') {
    if (typeof credential.tailnetHostname !== 'string' || !HOSTNAME_RE.test(credential.tailnetHostname)) {
      return `SSH credential tailnetHostname is not a valid hostname/IP address: ${JSON.stringify(credential.tailnetHostname)}`
    }
    if (
      credential.socksPort !== undefined
      && (!Number.isInteger(credential.socksPort) || credential.socksPort < 1 || credential.socksPort > 65535)
    ) {
      return `SSH credential socksPort is out of range: ${JSON.stringify(credential.socksPort)}`
    }
  }
  return null
}

/**
 * Build a minimal single-host Ansible inventory as JSON — written with a
 * `.yml` extension because plain JSON is valid YAML, so ansible-core's
 * bundled `yaml` inventory plugin (which matches by extension) parses it
 * unambiguously. This avoids the previous hand-built INI line, where an
 * unvalidated hostname/username containing whitespace or `key=value` text
 * could have been parsed as extra `ansible_*` inventory variables.
 *
 * `StrictHostKeyChecking=accept-new` (TOFU): the host key is trusted and
 * recorded on first connection, but a *later* run against the same
 * `credential.hostname` with a *different* key is rejected — unlike the
 * previous `StrictHostKeyChecking=no`, which accepted any key on every
 * connection and made a DNS/route hijack of the target silently forward the
 * private key and `extra-vars.json` (which may include `db_root_password`)
 * to an attacker-controlled host.
 *
 * Tailscale routing (admin-docs docs/specifications/ssh-tailscale-support.md,
 * section 2/3): when `credential.connectionType === 'tailscale'`, the actual
 * destination is `credential.tailnetHostname`, reached through the ECS
 * oneshot task's `tailscaled --socks5-server` sidecar — `credential.hostname`
 * is kept only as this inventory's host *key* (dictionary label), never as
 * the connection target, matching the field's documented "still required,
 * but not used to connect" status. `ansible_ssh_common_args` gets an
 * additional `ProxyCommand` routing the SSH TCP stream through
 * `127.0.0.1:<socksPort>` via `nc`'s SOCKS5 client mode (`-X 5 -x`) — the
 * same sidecar hop the chat-side `ssh-executor.ts` makes natively in Node
 * via the `socks` package's `SocksClient`, expressed here as an OpenSSH
 * `ProxyCommand` because Ansible's `ssh` connection plugin shells out to the
 * system `ssh` binary rather than opening the socket itself. No fallback: if
 * the sidecar/tailnet hop fails, `ssh`/`ansible-playbook` simply fails to
 * connect — there is no code path here that falls back to a direct,
 * non-Tailscale connection (see CLAUDE.md's "フォールバック禁止ルール").
 */
function buildInventory(credential: SshExecCredential, keyPath: string, knownHostsPath: string): string {
  const isTailscale = credential.connectionType === 'tailscale'
  const ansibleHost = isTailscale ? (credential.tailnetHostname as string) : credential.hostname
  const socksPort = credential.socksPort ?? TAILSCALE_SOCKS_PORT
  const proxyCommandArg = isTailscale
    ? ` -o ProxyCommand="nc -X 5 -x 127.0.0.1:${socksPort} %h %p"`
    : ''
  const commonArgs = `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownHostsPath}${proxyCommandArg}`
  const inventory = {
    target: {
      hosts: {
        [credential.hostname]: {
          ansible_host: ansibleHost,
          ansible_port: credential.port,
          ansible_user: credential.username,
          ansible_ssh_private_key_file: keyPath,
          ansible_ssh_common_args: commonArgs,
        },
      },
    },
  }
  return JSON.stringify(inventory)
}

interface AnsibleRunResult {
  /** Process exit code. `0` on success; best-effort `1` when no numeric code is available (e.g. a caught throw). */
  code: number
  stdout: string
  stderr: string
  /** True when the process was killed for exceeding `ANSIBLE_TIMEOUT_MS`. */
  timedOut: boolean
  /**
   * Set when `ansible-playbook` itself could not be started (e.g. `ENOENT`
   * if the binary is missing, `EACCES` if it isn't executable) — as opposed
   * to starting and exiting non-zero. Distinguishing this matters because
   * stdout/stderr are necessarily empty in this case, so there is no
   * `--tags`-scoped step output to report as "skipped".
   */
  spawnError: string | null
}

/**
 * Parse an optional uid/gid override from an environment variable value.
 * Returns `undefined` for an unset/empty/non-numeric value so the caller can
 * omit the corresponding `execFile` option entirely (preserving the current
 * "run as whatever user the agent process itself runs as" behavior) rather
 * than passing e.g. `NaN` through to Node's `child_process` uid/gid options.
 */
function parseOptionalUidOrGid(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Run `ansible-playbook` via execFile (never a shell) so step params
 * (which flow into `-e @extra-vars.json`, not shell arguments) cannot be
 * used for shell injection. Resolves rather than rejects on a non-zero exit
 * so callers can still parse the JSON callback output that was produced
 * before the failure. A hard `timeout` (see `ANSIBLE_TIMEOUT_MS`) guards
 * against a hung target host or a stuck apt/dpkg lock leaving this promise
 * (and the caller's temp dir / private key) pending forever.
 *
 * Opt-in non-root execution: when `AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID`
 * / `_GID` (see `ENV_VARS.SERVER_SETUP_ANSIBLE_UID`/`_GID`) are set,
 * `ansible-playbook` itself is spawned under that uid/gid instead of the
 * agent process's own user — an additional containment layer for a
 * compromised/malicious custom Ansible task running *on the agent host*
 * (e.g. via `ansible.builtin.command`/`shell`, both allow-listed), independent
 * of `become: true`'s privilege escalation on the *target* host over SSH.
 * Left unset by default: the agent process is often already running as a
 * dedicated non-root service user in production, and forcing a uid/gid here
 * unconditionally could break environments where the agent itself must run
 * as root (e.g. to read `/etc/` config or bind privileged ports) — hence the
 * opt-in design rather than an unconditional drop.
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
        // Node sets `killed: true` (with the `killSignal`, SIGTERM by
        // default) when execFile's own `timeout` option fires.
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
  stepResults: ServerSetupStepResult[]
  /**
   * Failure/unreachable messages from task groups that don't correspond to
   * any *requested* step — e.g. the `precheck` "Verify supported OS" task
   * (tagged `always`, so it always runs) or the implicit `Gathering Facts`
   * task ansible-core runs before it. Neither belongs to any `ServerSetupStepType`,
   * so without this, a failure there (unsupported OS, SSH unreachable, ...)
   * would otherwise vanish entirely: every *requested* step would show up as
   * "skipped: No task output found", which reads as an intentional
   * `--tags`-based skip rather than the real reason the whole run failed.
   */
  unmatchedFailureMessages: string[]
  /**
   * True when `rawOutput` was empty or not valid JSON at all — as opposed to
   * parsing successfully into an object that merely lacks results for some
   * step. `runServerSetup` must never report `successResult` on top of this:
   * an empty/unparseable stdout despite a `0` exit code means the `json`
   * callback plugin never ran (not loaded, output corrupted, a future
   * ansible-core version changing its stdout-callback output shape, ...), so
   * there is no reliable signal that any requested step actually did
   * anything.
   */
  outputUnparseable: boolean
  /**
   * Requested step types with *zero* task results anywhere in a
   * successfully-parsed output — distinct from a step whose tasks all
   * legitimately evaluated to `skipped: true` (which still produce a host
   * entry via `v2_runner_on_skipped`, see `ansible/callback_plugins/json.py`).
   * Every bundled role has at least one always-present task for its
   * `stepType` tag, so zero entries at all means `--tags <stepType>` matched
   * nothing in the play — a tag/task-name drift or a truncated JSON stream —
   * which must never be silently reported as `successResult`.
   */
  missingStepTypes: string[]
}

/**
 * Parse the `ansible-playbook --stdout-callback=json`-style output into one
 * result per requested step, plus any failure messages from task groups
 * outside the requested steps (see `ParsedAnsibleOutput.unmatchedFailureMessages`).
 * Task names in the bundled roles are prefixed `"<stepType> : <description>"`
 * (see `ansible/roles/<name>/tasks/main.yml`) so task outcomes can be
 * grouped back to the step that produced them.
 */
function parseAnsibleOutput(steps: ServerSetupStep[], rawOutput: string): ParsedAnsibleOutput {
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

  const resultsByStep = new Map<string, AnsibleJsonHostResult[]>()
  for (const play of parsed?.plays ?? []) {
    for (const task of play.tasks ?? []) {
      const name = task.task?.name ?? ''
      const stepType = name.split(':')[0]?.trim()
      if (!stepType) continue
      const hostResults = Object.values(task.hosts ?? {})
      const existing = resultsByStep.get(stepType) ?? []
      resultsByStep.set(stepType, existing.concat(hostResults))
    }
  }

  const requestedStepTypes = new Set<string>(steps.map((step) => step.stepType))
  const unmatchedFailureMessages: string[] = []
  for (const [groupName, results] of resultsByStep.entries()) {
    if (requestedStepTypes.has(groupName)) continue
    for (const r of results) {
      if (r.failed !== true) continue
      const reason = r.msg ?? (r.unreachable === true ? 'host unreachable' : `${groupName} failed`)
      unmatchedFailureMessages.push(`${groupName}: ${reason}`)
    }
  }

  const stepResults = steps.map((step): ServerSetupStepResult => {
    const results = resultsByStep.get(step.stepType) ?? []
    const failedResult = results.find((r) => r.failed === true)
    if (failedResult) {
      return {
        stepType: step.stepType,
        status: 'failed',
        changed: results.some((r) => r.changed === true),
        message: failedResult.msg ?? `${step.stepType} failed`,
      }
    }
    if (results.length === 0) {
      return {
        stepType: step.stepType,
        status: 'skipped',
        changed: false,
        message: `No task output found for ${step.stepType}`,
      }
    }
    if (results.every((r) => r.skipped === true)) {
      return { stepType: step.stepType, status: 'skipped', changed: false, message: `${step.stepType} skipped` }
    }
    return {
      stepType: step.stepType,
      status: 'ok',
      changed: results.some((r) => r.changed === true),
      message: `${step.stepType} completed`,
    }
  })

  const missingStepTypes = outputUnparseable
    ? []
    : steps.map((step) => step.stepType).filter((stepType) => !resultsByStep.has(stepType))

  return { stepResults, unmatchedFailureMessages, outputUnparseable, missingStepTypes }
}

/**
 * Execute a `server_setup_exec` command: fetch the SSH credential, run the
 * bundled playbook, and report per-step results. The temp directory holding
 * the private key is always removed, on every exit path.
 */
export async function runServerSetup(
  payload: ServerSetupExecPayload,
  ctx: RunServerSetupContext,
): Promise<CommandResult> {
  const validated = validatePayload(payload)
  if (typeof validated === 'string') {
    return errorResult(validated)
  }

  let credential: SshExecCredential
  try {
    credential = await ctx.client.getServerSetupSshCredential(ctx.commandId, ctx.agentId ?? '')
  } catch (error) {
    return errorResult(`Failed to fetch SSH credential: ${getErrorMessage(error)}`)
  }

  const credentialError = validateSshCredential(credential)
  if (credentialError) {
    return errorResult(credentialError)
  }

  // JIT fetch of project (`ANSIBLE#`) variables for custom Ansible tasks.
  // Fetched unconditionally (not only when a step carries `customTasksYaml`)
  // so its `secretNames` are available for redaction (see below) regardless
  // of which step ends up producing output, and so its `variables` are
  // available to be merged into extra-vars.json the same way step `params`
  // are. Placed before any temp dir is created — like the SSH credential
  // fetch above — so a failure here never leaves a private-key-holding temp
  // dir behind.
  let serverSetupVariables: ServerSetupVariablesResponse
  try {
    serverSetupVariables = await fetchServerSetupVariables(ctx.client, ctx.commandId, ctx.agentId ?? '')
  } catch (error) {
    return errorResult(`Failed to fetch server setup variables: ${getErrorMessage(error)}`)
  }

  let playbookPath: string
  try {
    playbookPath = resolvePlaybookPath()
  } catch (error) {
    return errorResult(getErrorMessage(error))
  }

  // Persistent (not per-run) known_hosts file, namespaced by tenant + SSH
  // host, so `StrictHostKeyChecking=accept-new` (TOFU) actually detects a
  // host key change across runs instead of trusting every run as a "first
  // use" — see known-hosts-store.ts's doc comment. Resolved before the temp
  // dir is created so a failure here (e.g. an unwritable config dir) never
  // leaves a private-key-holding temp dir behind.
  let knownHostsPath: string
  try {
    knownHostsPath = resolveKnownHostsPath(ctx.client.getTenantCode(), validated.sshHostId)
  } catch (error) {
    return errorResult(`Failed to resolve known_hosts file: ${getErrorMessage(error)}`)
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ss-'))
  // Every exit path below assigns `result` (in the `try` body or the `catch`
  // clause), but keep a safe default so TypeScript's definite-assignment
  // analysis (and any future refactor that adds an early path) can't leave
  // it unset by the time `finally` reads it.
  let result: CommandResult = errorResult('server_setup_exec: no result was produced')
  try {
    result = await (async (): Promise<CommandResult> => {
      const keyPath = path.join(tmpDir, 'id_rsa')
      // 0600: only the current user may read/write the private key.
      writeFileSync(keyPath, credential.privateKey, { mode: 0o600 })

      // Written with a .yml extension (JSON is valid YAML) so ansible-core's
      // bundled `yaml` inventory plugin — matched by file extension — parses
      // it unambiguously; see buildInventory's doc comment.
      const inventoryPath = path.join(tmpDir, 'inventory.yml')
      writeFileSync(inventoryPath, buildInventory(credential, keyPath, knownHostsPath))

      // Project (`ANSIBLE#`) variables merged first so that an explicit
      // step `param` (from the fixed per-stepType allow-list) always wins on
      // a name collision, rather than a tenant-admin-defined project
      // variable silently overriding a built-in role's own variable.
      const extraVars: Record<string, string> = { ...serverSetupVariables.variables }
      for (const step of validated.steps) {
        Object.assign(extraVars, step.params)
      }
      const extraVarsPath = path.join(tmpDir, 'extra-vars.json')
      // 0600: extra-vars.json may carry db_root_password (and now ANSIBLE#
      // project secret values) in plaintext — same permission level as the
      // private key and known_hosts file in this directory.
      writeFileSync(extraVarsPath, JSON.stringify(extraVars), { mode: 0o600 })

      // Steps carrying `customTasksYaml` are re-validated here (rather than
      // reusing validatePayload's earlier, structural-only pass) using the
      // *real* `secretNames` just fetched, so `normalizedTasks` carries
      // accurate `no_log: true` annotations. `validatePayload` already
      // proved this YAML passes the guard with an empty secret set, so a
      // rejection here would mean the guard's own behavior is
      // non-deterministic across calls — treated as an internal error
      // (fail-closed) rather than silently falling back to the bundled
      // playbook.
      const secretNameSet = new Set(serverSetupVariables.secretNames)
      const playbookSteps: GeneratePlaybookStep[] = []
      for (const step of validated.steps) {
        if (!step.customTasksYaml) {
          playbookSteps.push({ stepType: step.stepType, customTasksMode: step.customTasksMode })
          continue
        }
        const guardResult = validateCustomTasksYaml(step.customTasksYaml, step.stepType, secretNameSet)
        if (!guardResult.ok) {
          logger.error(
            `[server-setup] custom task guard re-validation failed unexpectedly for step ${step.stepType}: ${JSON.stringify(guardResult.violations)}`,
          )
          return errorResult(
            `server_setup_exec: custom task rejected at execution time: ${JSON.stringify(guardResult.violations)}`,
          )
        }
        playbookSteps.push({
          stepType: step.stepType,
          customTasksMode: step.customTasksMode,
          normalizedTasks: guardResult.normalizedTasks,
        })
      }

      const hasCustomTasks = validated.steps.some((step) => Boolean(step.customTasksYaml))
      let effectivePlaybookPath = playbookPath
      if (hasCustomTasks) {
        effectivePlaybookPath = path.join(tmpDir, 'generated-playbook.yml')
        writeFileSync(effectivePlaybookPath, generatePlaybook(playbookSteps))
      }

      const tags = validated.steps.map((s) => s.stepType).join(',')
      const args = ['-i', inventoryPath, effectivePlaybookPath, '--tags', tags, '-e', `@${extraVarsPath}`]

      logger.info(`[server-setup] Running ansible-playbook: executionId=${validated.executionId} tags=${tags}`)
      const { code, stdout: rawStdout, stderr: rawStderr, timedOut, spawnError } = await runAnsiblePlaybook(args, {
        ...process.env,
        ANSIBLE_STDOUT_CALLBACK: 'json',
        // Lets the generated playbook (written to tmpDir, outside
        // ansible/roles/) resolve the bundled roles by name via `roles:`
        // entries. Always set (harmless when the bundled playbook — which
        // sits alongside its own roles/ directory — is used instead).
        ANSIBLE_ROLES_PATH: path.join(resolveAnsibleDir(), 'roles'),
      })

      // Belt-and-suspenders redaction (see redactSecretValues's doc
      // comment): applied to the raw stdout/stderr *before* anything else
      // reads them, so every downstream use — the `stderr`-derived `detail`
      // in the code!==0 branch, `unmatchedFailureMessages`, and every
      // `ServerSetupStepResult.message` parsed out of `stdout` — is already
      // redacted.
      const secretValues = Object.entries(serverSetupVariables.variables)
        .filter(([name]) => secretNameSet.has(name))
        .map(([, value]) => value)
      const stdout = redactSecretValues(rawStdout, secretValues)
      const stderr = redactSecretValues(rawStderr, secretValues)

      if (timedOut) {
        logger.error(
          `[server-setup] ansible-playbook timed out after ${ANSIBLE_TIMEOUT_MS}ms: executionId=${validated.executionId}`,
        )
        return errorResult(`ansible-playbook execution timed out after ${Math.floor(ANSIBLE_TIMEOUT_MS / 1000)}s`)
      }

      if (spawnError) {
        // The process never started (e.g. `ansible-playbook` missing from
        // PATH or not executable) — there is no `--tags`-scoped task output
        // to parse, so `stepResults` is deliberately omitted rather than
        // reported as "skipped", which would misleadingly read as an
        // intentional tag-based skip instead of an environment failure.
        logger.error(`[server-setup] Failed to start ansible-playbook: ${spawnError}`)
        return errorResult(`Failed to start ansible-playbook: ${spawnError}`)
      }

      const { stepResults, unmatchedFailureMessages, outputUnparseable, missingStepTypes } = parseAnsibleOutput(
        validated.steps,
        stdout,
      )

      if (code !== 0) {
        const detail = stderr ? stderr.substring(0, 2000) : ''
        // Surfaces failures from task groups outside the requested steps —
        // e.g. the `precheck` "Unsupported OS" fail or an unreachable host —
        // which would otherwise never reach the caller: every requested
        // step would just show up as "skipped: No task output found",
        // silently discarding the actual reason the whole run failed.
        const unmatchedDetail = unmatchedFailureMessages.length ? ` | ${unmatchedFailureMessages.join('; ')}` : ''
        logger.error(`[server-setup] ansible-playbook exited with code ${code}`)
        return errorResult(
          `ansible-playbook exited with code ${code}${detail ? `: ${detail}` : ''}${unmatchedDetail}`,
          { stepResults },
        )
      }

      // Reaching here means ansible-playbook exited 0 — but a `0` exit code
      // alone is not sufficient evidence that the requested steps actually
      // ran (see ParsedAnsibleOutput's `outputUnparseable`/`missingStepTypes`
      // doc comments): a stdout callback that silently failed to load, an
      // ansible-core output-format change, or a tag/task-name mismatch would
      // otherwise all be reported as a quiet successResult. Both checks are
      // deliberately evaluated regardless of the (here, always-0) exit code,
      // so this fail-closed behavior does not silently regress if a future
      // change moves either check earlier.
      if (outputUnparseable) {
        logger.error(
          `[server-setup] ansible-playbook exited 0 but stdout was ${stdout.trim() ? 'not valid JSON' : 'empty'}: executionId=${validated.executionId}`,
        )
        return errorResult(
          `ansible-playbook exited 0 but its stdout ${stdout.trim() ? 'could not be parsed as JSON' : 'was empty'} — unable to confirm any requested step actually ran (json stdout callback not loaded, or an unexpected ansible-core output format)`,
        )
      }

      if (missingStepTypes.length > 0) {
        logger.error(
          `[server-setup] ansible-playbook exited 0 but produced no task output for: ${missingStepTypes.join(', ')}: executionId=${validated.executionId}`,
        )
        return errorResult(
          `ansible-playbook exited 0 but produced no task output for requested step(s): ${missingStepTypes.join(', ')} — treating the run as failed rather than silently reporting success`,
          { stepResults },
        )
      }

      logger.success(`[server-setup] Completed: executionId=${validated.executionId}`)
      return successResult({ stepResults })
    })()
  } catch (error) {
    result = errorResult(`Server setup execution failed: ${getErrorMessage(error)}`)
  } finally {
    // Must run on every exit path (success, failed step, thrown error): the
    // private key must never remain on disk after this function returns.
    // The removal itself is best-effort-logged rather than left to throw
    // silently past the function's return: an rmSync failure here would
    // otherwise leave the private key (and extra-vars.json's
    // db_root_password) on disk with no signal to the caller — see
    // `attachCleanupFailure`, which folds this into `result` below.
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
 * extra-vars.json, which may contain `db_root_password`) into the command
 * result.
 *
 * Design choice: rather than adding a `cleanupFailed: true` flag buried
 * inside an otherwise-`success: true` result's `data` — which a caller that
 * only checks the top-level `success` flag would silently miss — this
 * deliberately turns the *whole* command result into a failure, regardless
 * of whether the ansible-playbook run itself succeeded. Leaving secret
 * material behind on disk is a security incident in its own right; masking
 * that behind an otherwise-green result risks it going unnoticed and
 * unremediated, which is a worse outcome than an ansible run that
 * technically "succeeded" being reported as failed.
 */
function attachCleanupFailure(result: CommandResult, tmpDir: string): CommandResult {
  const note = `Failed to remove temp dir ${tmpDir} after server setup execution; it may still contain the SSH private key and db_root_password — manual cleanup of that directory is required.`
  if (result.success) {
    return errorResult(note, result.data)
  }
  return errorResult(`${result.error} | ${note}`, result.data)
}
