/**
 * Local dev entry point for exercising a server-setup recipe **through the exact
 * production execution path**, without the API, the command-dispatch service,
 * JIT token issuance, or KMS.
 *
 * The whole point is fidelity: a recipe run locally must generate the same
 * enclosing play, pass through the same authoritative task guard, and invoke
 * `ansible-playbook` the same way a real `server_setup_exec` command does — so
 * this module assembles an `ExecuteServerSetupAnsibleInput` from local files /
 * flags and hands it to the shared core (`executeServerSetupAnsible`) that
 * `runServerSetup` also calls. It never re-implements play generation, the
 * guard, or the ansible invocation, and it never disables validation: the guard
 * re-runs inside `executeServerSetupAnsible` regardless of what this module
 * passes in.
 *
 * SECURITY: this reads a plaintext SSH private key (or password) from local
 * disk. It is a developer tool, deliberately NOT wired into `src/index.ts`'s
 * customer-facing commander surface (see `server-setup-local-run.cli.ts`).
 */

import { readFileSync } from 'fs'

import { load } from 'js-yaml'

import { type CommandResult, errorResult, isSupportedSshAuthType, type SshExecCredential } from '../types'
import { getErrorMessage } from '../utils'

import { type AnsibleTaskRouteMode } from './ansible-task-guard'
import { executeServerSetupAnsible, SUDO_PROBE_REGISTER_VAR, validateSshCredential } from './server-setup-runner'

/** Default SSH port when the caller does not specify one. */
const DEFAULT_SSH_PORT = 22

/** Default auth type — key-based, matching the common server-setup case. */
const DEFAULT_AUTH_TYPE = 'privateKey'

/**
 * `sshHostId` used to namespace the persistent local known_hosts file when the
 * caller does not supply one. Fixed (not per-run) so TOFU host-key checking
 * actually works across repeated local runs against the same host.
 */
const DEFAULT_LOCAL_SSH_HOST_ID = 'local-host'

/** Tenant segment for the local known_hosts namespace — local runs are not tenant-scoped. */
const LOCAL_TENANT_CODE = 'local'

/**
 * Options for a local server-setup run. Mirrors what `runServerSetup` would
 * otherwise obtain from the payload + JIT API fetches, but sourced from local
 * files / flags instead.
 */
export interface ServerSetupLocalRunOptions {
  /** Path to the recipe body: a file containing a top-level YAML list of Ansible tasks. */
  bodyPath: string
  /** Optional path to a JSON file of `ANSIBLE#` project variables (`Record<string, string>`). */
  extraVarsPath?: string
  /** Names within extra-vars that are secrets — drives `no_log` + output redaction. */
  secretNames?: string[]
  /** Target SSH hostname or IP. */
  hostname: string
  /** Target SSH username. */
  username: string
  /** Target SSH port (default 22). */
  port?: number
  /** SSH auth type: `'privateKey'` (default) or `'password'`. */
  authType?: string
  /**
   * Path to a file holding the private key material (key auth) or the password
   * (password auth). This file path is the ONLY way to supply the secret — an
   * inline `--key-inline` flag was deliberately removed so key material / the
   * password never appears in argv (`ps`, `/proc/<pid>/cmdline`, shell history).
   */
  privateKeyPath?: string
  /** When true, validate under the strict `ecs` allowlist instead of the default lenient `resident`. */
  strict?: boolean
  /** Overrides the known_hosts namespace host id (default `local-host`). */
  sshHostId?: string
}

/**
 * Parse the recipe body YAML and assert it is a top-level list — the shape the
 * task guard requires. Returns the parsed tasks so callers can report a count;
 * the *original* YAML string is what gets handed to the guard downstream, so
 * this is validation-only and never reshapes the body.
 *
 * @throws Error with an actionable message when the YAML is invalid or not a list.
 */
export function parseBodyTasks(rawYaml: string): Record<string, unknown>[] {
  let parsed: unknown
  try {
    parsed = load(rawYaml)
  } catch (error) {
    throw new Error(`Recipe body is not valid YAML: ${getErrorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Recipe body must be a top-level YAML list of Ansible tasks '
      + `(got ${parsed === null ? 'null' : typeof parsed}).`,
    )
  }
  return parsed as Record<string, unknown>[]
}

/**
 * Parse the extra-vars JSON into the `Record<string, string>` shape the
 * production path uses for `extra-vars.json`. Strict — no coercion of non-string
 * values (フォールバック禁止): a malformed file fails loudly rather than
 * silently injecting a value ansible would render differently than intended.
 *
 * @throws Error with an actionable message when the JSON is invalid or not a
 *   flat object of string values.
 */
export function parseExtraVars(rawJson: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    throw new Error(`Extra-vars file is not valid JSON: ${getErrorMessage(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Extra-vars must be a JSON object of string values (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}).`,
    )
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`Extra-vars value for '${key}' must be a string (got ${typeof value}).`)
    }
    result[key] = value
  }
  return result
}

/** Read a file as UTF-8 text, throwing a clear, path-qualified error on failure. */
function readTextFile(label: string, filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`Failed to read ${label} file '${filePath}': ${getErrorMessage(error)}`)
  }
}

/**
 * Resolve the SSH key material / password by reading the `--key` file. The
 * `privateKey` field is overloaded exactly as in production (see
 * `server-setup-runner.ts`'s `buildInventory`): key material for key auth, the
 * plaintext password for password auth.
 *
 * File-only by design (フォールバック禁止 + secret hygiene): there is no inline
 * flag, so the secret is never passed on the command line where it would leak
 * into `ps` / `/proc/<pid>/cmdline` / shell history.
 *
 * @throws Error when no key file path is given or the file is empty/unreadable.
 */
function resolveKeyMaterial(options: ServerSetupLocalRunOptions): string {
  if (!options.privateKeyPath) {
    throw new Error('An SSH private key / password file path is required (--key <path>).')
  }
  const material = readTextFile('SSH key/password', options.privateKeyPath)
  if (!material) {
    throw new Error(`SSH key/password file '${options.privateKeyPath}' is empty.`)
  }
  return material
}

/**
 * Assemble the `SshExecCredential` from local options, validating the auth type
 * up front (フォールバック禁止 — an unknown auth type must not silently take the
 * key path). Connection-field shape (hostname/username/port) is NOT validated
 * here — `runServerSetupLocalRun` runs the shared production
 * `validateSshCredential` (`HOSTNAME_RE`/`USERNAME_RE`/`isValidPort`) on the
 * assembled credential before handing it to the core, exactly as
 * `runServerSetup` does, so this only handles what is specific to the local
 * sourcing.
 *
 * @throws Error on missing required connection fields, unsupported auth type, or
 *   unresolvable key material.
 */
export function buildLocalCredential(options: ServerSetupLocalRunOptions): SshExecCredential {
  if (!options.hostname) {
    throw new Error('SSH hostname is required.')
  }
  if (!options.username) {
    throw new Error('SSH username is required.')
  }
  const authType = options.authType ?? DEFAULT_AUTH_TYPE
  if (!isSupportedSshAuthType(authType)) {
    throw new Error(`Unsupported SSH auth type '${authType}' (supported: password, privateKey).`)
  }
  const privateKey = resolveKeyMaterial(options)
  return {
    hostId: options.sshHostId ?? DEFAULT_LOCAL_SSH_HOST_ID,
    hostname: options.hostname,
    port: options.port ?? DEFAULT_SSH_PORT,
    username: options.username,
    authType,
    privateKey,
  }
}

/**
 * Warn (to stderr) when extra-vars are supplied but no `--secret-names` were
 * given. Without `--secret-names`, none of the extra-vars values are treated as
 * secrets, so they are NOT `no_log`-annotated and are NOT redacted from the
 * console output — a plaintext value could surface in a task message / stderr.
 * This is non-fatal (a dev tool intentionally keeps running), but the warning
 * makes the exposure explicit so the developer can add `--secret-names`.
 */
export function warnIfSecretsUnmasked(
  variables: Record<string, string>,
  secretNames: readonly string[],
): void {
  if (Object.keys(variables).length > 0 && secretNames.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      '警告: --secret-names が未指定です。--extra-vars 内の値は no_log / マスキングの対象外となり、'
      + 'コンソール出力に平文で現れる可能性があります。機微値がある場合は --secret-names を指定してください。',
    )
  }
}

/**
 * Run a server-setup recipe locally through the production core
 * (`executeServerSetupAnsible`). Reads the body / extra-vars from disk, builds
 * and validates the credential, and delegates everything downstream (known_hosts
 * resolution, play generation, guard re-validation, ansible invocation,
 * redaction, temp-dir cleanup) to the shared core.
 *
 * Returns an `errorResult` (never throws) for every expected user error —
 * missing/invalid files, bad connection info — so the caller always gets a
 * `CommandResult`.
 */
export async function runServerSetupLocalRun(options: ServerSetupLocalRunOptions): Promise<CommandResult> {
  let body: string
  let variables: Record<string, string>
  let credential: SshExecCredential
  try {
    if (!options.bodyPath) {
      throw new Error('A recipe body file path is required.')
    }
    body = readTextFile('recipe body', options.bodyPath)
    // Validate the body is a top-level task list before running; the original
    // string (not a re-dump) is what the guard downstream parses.
    parseBodyTasks(body)

    variables = options.extraVarsPath
      ? parseExtraVars(readTextFile('extra-vars', options.extraVarsPath))
      : {}

    // Reserved-variable-name collision check — mirror production
    // `runServerSetup`: a project variable named exactly SUDO_PROBE_REGISTER_VAR
    // would (extra-vars always outrank a `register`ed var in Ansible) silently
    // shadow the sudo-probe result and corrupt the NOPASSWD precheck. Fail
    // closed with the same message instead of misbehaving.
    if (Object.prototype.hasOwnProperty.call(variables, SUDO_PROBE_REGISTER_VAR)) {
      throw new Error(
        `Project variable name '${SUDO_PROBE_REGISTER_VAR}' is reserved for server setup's internal `
        + 'passwordless-sudo precheck and cannot be used. Rename this project variable and retry.',
      )
    }

    credential = buildLocalCredential(options)
  } catch (error) {
    return errorResult(getErrorMessage(error))
  }

  // Re-validate the assembled credential exactly as production `runServerSetup`
  // does (HOSTNAME_RE / USERNAME_RE / isValidPort), so a bad --port (NaN /
  // out-of-range), or whitespace/injection characters in --host / --user, are
  // rejected up front here rather than surfacing as an opaque ansible failure.
  const credentialError = validateSshCredential(credential)
  if (credentialError) {
    return errorResult(credentialError)
  }

  warnIfSecretsUnmasked(variables, options.secretNames ?? [])

  const mode: AnsibleTaskRouteMode = options.strict ? 'ecs' : 'resident'

  return executeServerSetupAnsible({
    executionId: 'local-run',
    body,
    mode,
    credential,
    variables,
    secretNames: options.secretNames ?? [],
    tenantCode: LOCAL_TENANT_CODE,
    sshHostId: options.sshHostId ?? DEFAULT_LOCAL_SSH_HOST_ID,
  })
}

/**
 * Map raw CLI arguments (`process.argv.slice(2)`) to
 * `ServerSetupLocalRunOptions`. Kept here (not in the thin CLI bootstrap) so it
 * is unit-testable. Unknown flags fail loudly rather than being ignored.
 *
 * @throws Error on an unknown flag or a flag missing its value.
 */
export function parseLocalRunArgs(argv: readonly string[]): ServerSetupLocalRunOptions {
  const options: Partial<ServerSetupLocalRunOptions> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const takeValue = (): string => {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`)
      }
      i++
      return value
    }
    switch (arg) {
      case '--body':
        options.bodyPath = takeValue()
        break
      case '--extra-vars':
        options.extraVarsPath = takeValue()
        break
      case '--secret-names':
        options.secretNames = takeValue().split(',').map((s) => s.trim()).filter((s) => s.length > 0)
        break
      case '--host':
        options.hostname = takeValue()
        break
      case '--user':
        options.username = takeValue()
        break
      case '--port':
        options.port = Number(takeValue())
        break
      case '--auth-type':
        options.authType = takeValue()
        break
      case '--key':
        options.privateKeyPath = takeValue()
        break
      case '--ssh-host-id':
        options.sshHostId = takeValue()
        break
      case '--strict':
        options.strict = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options as ServerSetupLocalRunOptions
}

/** Render a `CommandResult` from a local run as a human-readable, multi-line string. */
export function formatLocalRunResult(result: CommandResult): string {
  const lines: string[] = []
  const data = result.data as { stepResults?: Array<{ name: string; status: string; changed: boolean; message: string }> } | undefined
  const stepResults = data?.stepResults
  if (stepResults && stepResults.length > 0) {
    lines.push('Task results:')
    for (const step of stepResults) {
      const changed = step.changed ? ' (changed)' : ''
      lines.push(`  [${step.status}] ${step.name}${changed} — ${step.message}`)
    }
  }
  if (result.success) {
    lines.push('Server setup local run: SUCCESS')
  } else {
    lines.push(`Server setup local run: FAILED — ${result.error}`)
  }
  return lines.join('\n')
}
