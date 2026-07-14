/**
 * Tests for src/server-setup/server-setup-runner.ts
 *
 * Covers payload validation, the SSH-credential JIT fetch, the
 * ansible-playbook invocation (args/env), stepResults parsing from the JSON
 * callback output, and — critically — that the temp directory holding the
 * private key is always removed, on both success and failure paths.
 *
 * `fs`'s sync methods are non-configurable getters under Jest's Node
 * environment, so `jest.spyOn(fs, 'mkdtempSync')` etc. throw
 * "Cannot redefine property". Instead the whole `fs` module is mocked with
 * pass-through jest.fn()s (real behavior by default, overridable per test),
 * following the same "mock-prefixed const declared before the import that
 * triggers the require" pattern used by the ecs_launch dispatch tests.
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockExecFile = jest.fn()
jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

const actualFs = jest.requireActual('fs') as typeof import('fs')
const mockMkdtempSync = jest.fn((...args: Parameters<typeof actualFs.mkdtempSync>) => actualFs.mkdtempSync(...args))
const mockWriteFileSync = jest.fn((...args: Parameters<typeof actualFs.writeFileSync>) => actualFs.writeFileSync(...args))
const mockRmSync = jest.fn((...args: Parameters<typeof actualFs.rmSync>) => actualFs.rmSync(...args))
const mockExistsSync = jest.fn((...args: Parameters<typeof actualFs.existsSync>) => actualFs.existsSync(...args))

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...(args as Parameters<typeof actual.mkdtempSync>)),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...(args as Parameters<typeof actual.writeFileSync>)),
    rmSync: (...args: unknown[]) => mockRmSync(...(args as Parameters<typeof actual.rmSync>)),
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as Parameters<typeof actual.existsSync>)),
  }
})

// known_hosts persistence itself is covered by known-hosts-store.spec.ts;
// here we only need to control/observe the path server-setup-runner.ts
// wires into the inventory, without touching the real persistent config dir.
const KNOWN_HOSTS_PATH = '/fake-config-dir/server-setup/known-hosts/acme__host-1'
const mockResolveKnownHostsPath = jest.fn().mockReturnValue(KNOWN_HOSTS_PATH)
jest.mock('../../src/server-setup/known-hosts-store', () => ({
  resolveKnownHostsPath: (...args: unknown[]) => mockResolveKnownHostsPath(...args),
}))

import { generatePlaybook, runServerSetup } from '../../src/server-setup/server-setup-runner'
import { logger } from '../../src/logger'
import type { ApiClient } from '../../src/api-client'
import type { ServerSetupExecPayload, ServerSetupVariablesResponse, SshCredentials } from '../../src/types'

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n'

const CREDENTIAL: SshCredentials = {
  hostId: 'host-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  authType: 'key',
  privateKey: PRIVATE_KEY,
}

function makePayload(overrides: Partial<ServerSetupExecPayload> = {}): ServerSetupExecPayload {
  return {
    executionId: 'exec-1',
    sshHostId: 'host-1',
    steps: [
      { stepType: 'os_init', params: {} },
      { stepType: 'docker', params: {} },
    ],
    ...overrides,
  }
}

const NO_VARIABLES: ServerSetupVariablesResponse = { variables: {}, secretNames: [] }

function makeClient(
  overrides: Partial<
    Record<'getServerSetupSshCredential' | 'getServerSetupVariables' | 'getTenantCode', jest.Mock>
  > = {},
): ApiClient {
  return {
    getServerSetupSshCredential: overrides.getServerSetupSshCredential ?? jest.fn().mockResolvedValue(CREDENTIAL),
    getServerSetupVariables: overrides.getServerSetupVariables ?? jest.fn().mockResolvedValue(NO_VARIABLES),
    getTenantCode: overrides.getTenantCode ?? jest.fn().mockReturnValue('acme'),
  } as unknown as ApiClient
}

function ansibleJsonOutput(tasks: Array<{ name: string; changed?: boolean; failed?: boolean; skipped?: boolean; msg?: string }>): string {
  return JSON.stringify({
    plays: [
      {
        tasks: tasks.map((t) => ({
          task: { name: t.name },
          hosts: {
            '203.0.113.10': {
              changed: t.changed ?? false,
              failed: t.failed ?? false,
              skipped: t.skipped ?? false,
              ...(t.msg !== undefined && { msg: t.msg }),
            },
          },
        })),
      },
    ],
  })
}

/** Resolve the execFile mock's callback with a fake ansible-playbook run. */
function resolveExecFile(exitCode: number, stdout: string, stderr = ''): void {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1]
  const callback = call[call.length - 1] as (error: unknown, stdout: string, stderr: string) => void
  if (exitCode === 0) {
    callback(null, stdout, stderr)
  } else {
    const error: NodeJS.ErrnoException & { code?: number } = Object.assign(new Error(`Command failed with code ${exitCode}`), { code: exitCode })
    callback(error, stdout, stderr)
  }
}

/**
 * Resolve the execFile mock's callback with an arbitrary raw error object —
 * used to simulate a `timeout`-triggered kill (`killed: true`) or a spawn
 * failure (a non-numeric `code` such as 'ENOENT'/'EACCES' with no output),
 * neither of which `resolveExecFile` above (a normal non-zero exit) can express.
 */
function resolveExecFileWithError(
  error: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null },
  stdout = '',
  stderr = '',
): void {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1]
  const callback = call[call.length - 1] as (error: unknown, stdout: string, stderr: string) => void
  callback(error, stdout, stderr)
}

/**
 * Flush microtasks until `execFile` has been invoked (or a small tick budget
 * is exhausted), rather than a hardcoded `await Promise.resolve()` count.
 *
 * `runServerSetup` now awaits both the SSH credential fetch and the
 * server-setup-variables fetch (see `fetchServerSetupVariables`) before
 * reaching `ansible-playbook`'s `execFile` invocation, so the exact number of
 * microtask hops needed to get there is no longer a fixed constant tests can
 * hardcode — polling for the actual observable effect (execFile having been
 * called) is more robust than re-tuning a tick count by hand every time an
 * `await` is added/removed upstream.
 */
async function flushUntilExecFileCalled(): Promise<void> {
  for (let i = 0; i < 50 && mockExecFile.mock.calls.length === 0; i++) {
    await Promise.resolve()
  }
}

/** Collect every string passed to any logger method. */
function allLoggedText(): string {
  const mocked = logger as unknown as Record<string, jest.Mock>
  return ['info', 'success', 'error', 'warn', 'debug']
    .flatMap((m) => mocked[m].mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n')
}

beforeEach(() => {
  jest.clearAllMocks()
  // clearAllMocks() only clears call history, not implementations set via
  // mockReturnValue/mockImplementation from a previous test; restore the
  // pass-through default explicitly so tests don't leak overrides.
  mockMkdtempSync.mockImplementation((...args: Parameters<typeof actualFs.mkdtempSync>) => actualFs.mkdtempSync(...args))
  mockWriteFileSync.mockImplementation((...args: Parameters<typeof actualFs.writeFileSync>) => actualFs.writeFileSync(...args))
  mockRmSync.mockImplementation((...args: Parameters<typeof actualFs.rmSync>) => actualFs.rmSync(...args))
  mockExistsSync.mockImplementation((...args: Parameters<typeof actualFs.existsSync>) => actualFs.existsSync(...args))
  mockResolveKnownHostsPath.mockReturnValue(KNOWN_HOSTS_PATH)
})

describe('runServerSetup - payload validation', () => {
  it.each([
    ['executionId missing', { executionId: '' }, 'executionId is required for server_setup_exec'],
    ['sshHostId missing', { sshHostId: '' }, 'sshHostId is required for server_setup_exec'],
    ['steps missing', { steps: undefined as unknown as ServerSetupExecPayload['steps'] }, 'steps (non-empty array) is required for server_setup_exec'],
    ['steps empty', { steps: [] }, 'steps (non-empty array) is required for server_setup_exec'],
  ])('rejects an invalid payload: %s', async (_label, overrides, expectedError) => {
    const client = makeClient()
    const result = await runServerSetup(makePayload(overrides), { commandId: 'cmd-1', client })

    expect(result).toEqual({ success: false, error: expectedError })
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('rejects a step with an unsupported stepType', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'bogus' as never, params: {} }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('steps[0].stepType must be one of')
    }
  })

  it('rejects a step whose params contain a non-string value', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'os_init', params: { count: 3 as unknown as string } }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({ success: false, error: 'steps[0].params.count must be a string' })
  })

  it('rejects a step entry that is not an object', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: ['not-an-object' as unknown as ServerSetupExecPayload['steps'][number]] }),
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({ success: false, error: 'steps[0] must be an object' })
  })

  it('rejects a step whose params value is not an object', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'os_init', params: 'not-an-object' as unknown as Record<string, string> }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({ success: false, error: 'steps[0].params must be an object' })
  })
})

describe('runServerSetup - params allow-list per stepType', () => {
  // extra-vars.json (built from steps[].params) has the highest Ansible
  // variable precedence — higher than inventory vars — so a caller-supplied
  // magic variable here (e.g. `ansible_connection: "local"`) would silently
  // redirect the whole `become: true` playbook run onto the agent host
  // itself instead of the intended target. These tests lock in that no key
  // outside the fixed per-stepType allow-list is ever accepted, and that the
  // rejection happens before any credential fetch or ansible-playbook
  // invocation.

  it.each([
    ['os_init', { some_key: 'x' }],
    ['docker', { some_key: 'x' }],
    ['web_server', { web_server_type: 'nginx', extra: 'x' }],
    ['database', { db_type: 'mysql', not_allowed: 'x' }],
    ['dns_tls', { domain: 'example.com', not_allowed: 'x' }],
  ])('rejects a param key outside the %s allow-list', async (stepType, params) => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: stepType as ServerSetupExecPayload['steps'][number]['stepType'], params }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('is not an allowed parameter')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it.each([
    ['ansible_connection', 'local'],
    ['ansible_host', '127.0.0.1'],
    ['ansible_ssh_private_key_file', '/tmp/attacker-key'],
    ['ansible_become', 'false'],
    ['hostvars', 'x'],
    ['group_names', 'x'],
  ])('rejects the Ansible magic variable "%s" as a step param even for an otherwise-empty allow-list', async (key, value) => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'os_init', params: { [key]: value } }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('reserved Ansible variable name')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('accepts every documented param key for each stepType and merges them all into extra-vars.json', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({
        steps: [
          { stepType: 'web_server', params: { web_server_type: 'apache' } },
          { stepType: 'database', params: { db_type: 'postgresql', db_root_password: "p'ass\\word" } },
          { stepType: 'dns_tls', params: { domain: 'example.com' } },
        ],
      }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'web_server : Install Apache' },
      { name: 'database : Set PostgreSQL postgres user password' },
      { name: 'dns_tls : Generate Caddyfile' },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    const extraVarsCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('extra-vars.json'))
    expect(JSON.parse(extraVarsCall?.[1] as string)).toEqual({
      web_server_type: 'apache',
      db_type: 'postgresql',
      db_root_password: "p'ass\\word",
      domain: 'example.com',
    })
    // extra-vars.json may carry db_root_password in plaintext, so it's
    // written 0600 — same permission level as the private key and
    // known_hosts file alongside it in the temp dir.
    expect(extraVarsCall?.[2]).toEqual({ mode: 0o600 })
  })
})

describe('runServerSetup - required step params', () => {
  // A step's params can pass every other check (object shape, allow-listed
  // keys, no reserved/magic keys) while still being missing the one key its
  // bundled Ansible role actually branches on (e.g. `db_type` for
  // `database`). Every task in that role is gated on that variable being
  // defined/equal to a specific value, so an entirely-absent key makes
  // *every* task silently skip while `ansible-playbook` still exits 0 —
  // these tests lock in that the missing key is rejected as a validation
  // error before the command (and any credential fetch) ever runs.

  it.each([
    ['database', {}, 'db_type'],
    ['database', { db_root_password: 'x' }, 'db_type'],
    ['web_server', {}, 'web_server_type'],
    ['dns_tls', {}, 'domain'],
  ])('rejects a %s step missing its required param (%o)', async (stepType, params, requiredKey) => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: stepType as ServerSetupExecPayload['steps'][number]['stepType'], params }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe(`steps[0].params.${requiredKey} is required for stepType '${stepType}'`)
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it.each([
    ['os_init', {}],
    ['docker', {}],
  ])('does not require any param for %s', async (stepType, params) => {
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({ steps: [{ stepType: stepType as ServerSetupExecPayload['steps'][number]['stepType'], params }] }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: `${stepType} : did something` }]))
    const result = await runPromise

    expect(result.success).toBe(true)
  })
})

describe('runServerSetup - enum-valued step params', () => {
  // `db_type` / `web_server_type` are compared with a plain `when: x == 'y'`
  // string equality in the bundled Ansible roles (ansible/roles/database,
  // ansible/roles/web_server). An unrecognized value (typo, wrong case, an
  // unsupported engine) would match none of those conditions, silently
  // skipping every task in the role while ansible-playbook still exits 0 —
  // so these must be rejected as a validation error before the command ever
  // runs, the same as any other malformed payload.

  it.each([
    ['MYSQL (wrong case)', 'MYSQL'],
    ['oracle (unsupported engine)', 'oracle'],
    ['', ''],
  ])('rejects db_type = %s', async (_label, value) => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'database', params: { db_type: value } }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('steps[0].params.db_type must be one of: mysql, postgresql')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it.each([
    ['IIS (unsupported)', 'IIS'],
    ['Apache (wrong case)', 'Apache'],
  ])('rejects web_server_type = %s', async (_label, value) => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'web_server', params: { web_server_type: value } }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('steps[0].params.web_server_type must be one of: nginx, apache')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it.each([
    ['database', { db_type: 'mysql' }],
    ['database', { db_type: 'postgresql' }],
    ['web_server', { web_server_type: 'nginx' }],
    ['web_server', { web_server_type: 'apache' }],
  ])('accepts the documented enum values for %s', async (stepType, params) => {
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({ steps: [{ stepType: stepType as ServerSetupExecPayload['steps'][number]['stepType'], params }] }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: `${stepType} : did something` }]))
    const result = await runPromise

    expect(result.success).toBe(true)
  })
})

describe('runServerSetup - SSH credential fetch', () => {
  it('fetches the credential scoped to the commandId, using an empty agentId when none is provided', async () => {
    const client = makeClient()

    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    // Let the credential fetch settle before resolving execFile.
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    await runPromise

    expect(client.getServerSetupSshCredential).toHaveBeenCalledWith('cmd-1', '')
  })

  it('passes the agentId through when provided', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client, agentId: 'agent-42' })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    expect(client.getServerSetupSshCredential).toHaveBeenCalledWith('cmd-1', 'agent-42')
  })

  it('returns an error result and never invokes ansible-playbook when the credential fetch fails', async () => {
    const client = makeClient({ getServerSetupSshCredential: jest.fn().mockRejectedValue(new Error('403 forbidden')) })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to fetch SSH credential')
      expect(result.error).toContain('403 forbidden')
    }
    expect(mockExecFile).not.toHaveBeenCalled()
    // No temp dir (and therefore no private key on disk) is ever created
    // when the credential fetch itself fails.
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - SSH credential validation', () => {
  // A hostname/username containing whitespace or `key=value`-shaped text
  // could, once written into the inventory, be parsed as *extra* Ansible
  // inventory variables for the host — so these are rejected before any
  // temp dir (and therefore private key) is ever created.

  it.each([
    ['contains a space', 'evil host'],
    ['contains an embedded inventory variable', 'host ansible_connection=local'],
    ['contains a quote', "host'name"],
    ['is empty', ''],
  ])('rejects a hostname that %s', async (_label, hostname) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, hostname }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('hostname')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([
    ['contains a space', 'evil user'],
    ['contains an embedded inventory variable', 'root ansible_become=true'],
  ])('rejects a username that %s', async (_label, username) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, username }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('username')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([0, -1, 65536, 1.5])('rejects an out-of-range port %d', async (port) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, port }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('port')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - playbook resolution', () => {
  it('returns an error result when the bundled playbook cannot be found', async () => {
    const client = makeClient()
    mockExistsSync.mockReturnValueOnce(false)

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Ansible playbook not found')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - success path', () => {
  it('writes the private key with 0600 permissions, invokes ansible-playbook with the right args/env, and removes the temp dir', async () => {
    const client = makeClient()

    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)

    // 1. Temp dir was created, and the private key written with 0600 mode.
    expect(mockMkdtempSync).toHaveBeenCalledTimes(1)
    const tmpDir = mockMkdtempSync.mock.results[0].value as string

    const keyWriteCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('id_rsa'))
    expect(keyWriteCall).toBeDefined()
    expect(keyWriteCall?.[0]).toBe(`${tmpDir}/id_rsa`)
    expect(keyWriteCall?.[1]).toBe(PRIVATE_KEY)
    expect(keyWriteCall?.[2]).toEqual({ mode: 0o600 })

    // 2. ansible-playbook invoked via execFile (never a shell) with the
    //    expected arguments, ANSIBLE_STDOUT_CALLBACK=json, and a bounded
    //    timeout so a hung target host can't wedge this promise forever.
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = mockExecFile.mock.calls[0]
    expect(cmd).toBe('ansible-playbook')
    expect(args[0]).toBe('-i')
    expect(args[1]).toBe(`${tmpDir}/inventory.yml`)
    expect(args[2]).toMatch(/ansible\/playbook\.yml$/)
    expect(args[3]).toBe('--tags')
    expect(args[4]).toBe('os_init,docker')
    expect(args[5]).toBe('-e')
    expect(args[6]).toBe(`@${tmpDir}/extra-vars.json`)
    expect((options as { env: NodeJS.ProcessEnv }).env.ANSIBLE_STDOUT_CALLBACK).toBe('json')
    expect((options as { timeout: number }).timeout).toBeGreaterThan(0)

    // 3. extra-vars.json merges every step's params (this default payload's
    //    steps carry no params; the dedicated merge test below covers a
    //    multi-key merge).
    const extraVarsCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('extra-vars.json'))
    expect(extraVarsCall).toBeDefined()
    expect(JSON.parse(extraVarsCall?.[1] as string)).toEqual({})

    // 4. inventory.yml (JSON, valid YAML) references the fetched
    //    host/port/user/key path, and pins accept-new (TOFU) host key
    //    checking against a per-run known_hosts file rather than disabling
    //    host key checking outright.
    const inventoryCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('inventory.yml'))
    expect(inventoryCall).toBeDefined()
    const inventoryContent = inventoryCall?.[1] as string
    const inventoryJson = JSON.parse(inventoryContent) as {
      target: { hosts: Record<string, Record<string, unknown>> }
    }
    const hostVars = inventoryJson.target.hosts[CREDENTIAL.hostname]
    expect(hostVars).toBeDefined()
    expect(hostVars.ansible_host).toBe(CREDENTIAL.hostname)
    expect(hostVars.ansible_port).toBe(CREDENTIAL.port)
    expect(hostVars.ansible_user).toBe(CREDENTIAL.username)
    expect(hostVars.ansible_ssh_private_key_file).toBe(`${tmpDir}/id_rsa`)
    expect(hostVars.ansible_ssh_common_args).toContain('StrictHostKeyChecking=accept-new')
    expect(hostVars.ansible_ssh_common_args).toContain(`UserKnownHostsFile=${KNOWN_HOSTS_PATH}`)
    expect(hostVars.ansible_ssh_common_args).not.toContain('StrictHostKeyChecking=no')

    // 4b. known_hosts is resolved via the persistent, tenant/host-namespaced
    //     store (known-hosts-store.ts) rather than written fresh into tmpDir
    //     on every run — that's what makes TOFU (StrictHostKeyChecking=accept-new)
    //     actually detect a later host-key change instead of trusting every
    //     run as a "first use". See known-hosts-store.spec.ts for the
    //     persistence behavior itself.
    expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'host-1')
    expect(mockWriteFileSync.mock.calls.some((call) => String(call[0]).endsWith('known_hosts'))).toBe(false)

    // 5. stepResults parsed correctly.
    expect(result.data).toEqual({
      stepResults: [
        { stepType: 'os_init', status: 'ok', changed: true, message: 'os_init completed' },
        { stepType: 'docker', status: 'ok', changed: true, message: 'docker completed' },
      ],
    })

    // 6. The temp dir (private key included) is removed — on the real
    //    filesystem, not just as a mock call. The persistent known_hosts
    //    path is NOT removed — it lives outside tmpDir precisely so it
    //    survives across runs.
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
    expect(mockRmSync.mock.calls.some((call) => call[0] === KNOWN_HOSTS_PATH)).toBe(false)

    // 7. The private key value is never logged.
    expect(allLoggedText()).not.toContain(PRIVATE_KEY)
  })

  it('fails the whole run when a requested step produced no task output at all, even though ansible-playbook exited 0', async () => {
    // Regression test: previously this reported `success: true` with the
    // step marked "skipped", which is indistinguishable from an intentional
    // --tags-based skip. Zero task output for a *requested* stepType should
    // never happen for a well-formed run (every bundled role has at least
    // one always-present task for its tag) so it must be treated as a
    // failure, not silently folded into a green result.
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({ steps: [{ stepType: 'database', params: { db_type: 'mysql' } }] }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('produced no task output for requested step(s): database')
      expect(result.data).toEqual({
        stepResults: [
          { stepType: 'database', status: 'skipped', changed: false, message: 'No task output found for database' },
        ],
      })
    }
  })

  it('fails the whole run (not just the affected step) when only one of several requested steps produced no task output', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({
        steps: [
          { stepType: 'os_init', params: {} },
          { stepType: 'database', params: { db_type: 'mysql' } },
        ],
      }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('produced no task output for requested step(s): database')
    }
  })

  it('marks a step "skipped" when every task for it was skipped', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({ steps: [{ stepType: 'docker', params: {} }] }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'docker : Install Docker Engine and compose plugin', skipped: true }]))
    const result = await runPromise

    expect(result.data).toEqual({
      stepResults: [{ stepType: 'docker', status: 'skipped', changed: false, message: 'docker skipped' }],
    })
  })

  it('fails the run (rather than reporting success with "skipped" steps) when stdout is malformed (non-JSON), even though ansible-playbook exited 0', async () => {
    // Regression test: previously malformed stdout was silently treated as
    // "no task output" and, combined with a 0 exit code, reported as an
    // overall success — exactly the fail-open scenario this fix closes
    // (e.g. the json stdout callback failing to load, or a future
    // ansible-core version changing its output format).
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, 'not valid json {{{')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('could not be parsed as JSON')
      expect(result.data).toBeUndefined()
    }
  })

  it('fails the run when stdout is empty, even though ansible-playbook exited 0', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('stdout')
      expect(result.error).toContain('was empty')
    }
  })
})

describe('runServerSetup - failure path', () => {
  it('returns a failed result and still removes the temp dir when ansible-playbook exits non-zero', async () => {
    const client = makeClient()

    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([
        { name: 'os_init : Update apt cache', changed: true },
        { name: 'docker : Install Docker Engine and compose plugin', failed: true, msg: 'E: Unable to locate package docker-ce' },
      ]),
      'fatal: [203.0.113.10]: FAILED!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('fatal: [203.0.113.10]: FAILED!')
      expect(result.data).toEqual({
        stepResults: [
          { stepType: 'os_init', status: 'ok', changed: true, message: 'os_init completed' },
          { stepType: 'docker', status: 'failed', changed: false, message: 'E: Unable to locate package docker-ce' },
        ],
      })
    }

    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('removes the temp dir even when an unexpected error is thrown mid-execution', async () => {
    const client = makeClient()
    mockWriteFileSync.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Server setup execution failed')
      expect(result.error).toContain('disk full')
    }
    expect(mockExecFile).not.toHaveBeenCalled()

    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('never logs the private key value even when the run fails', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(1, ansibleJsonOutput([{ name: 'os_init : Update apt cache', failed: true, msg: 'boom' }]), 'boom')
    await runPromise

    expect(allLoggedText()).not.toContain(PRIVATE_KEY)
  })

  it('marks the overall result as failed (even though the run itself succeeded) when temp-dir cleanup fails', async () => {
    // Design choice (see attachCleanupFailure's doc comment in
    // server-setup-runner.ts): a failed best-effort removal of the temp dir
    // means the SSH private key and extra-vars.json's db_root_password may
    // still be sitting on disk. That's a security incident in its own
    // right, independent of whether ansible-playbook itself succeeded, so
    // it must not be masked behind an otherwise-green `success: true`
    // result that a caller checking only the top-level flag would miss.
    const client = makeClient()
    mockRmSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy')
    })

    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to remove temp dir')
      expect(result.error).toContain('SSH private key')
    }
    // ...and the failure is also surfaced via the logger rather than
    // silently swallowed.
    expect(allLoggedText()).toContain('Failed to remove temp dir')
    expect(allLoggedText()).toContain('EBUSY: resource busy')
  })

  it('combines the ansible failure and the cleanup failure into one error when both fail', async () => {
    const client = makeClient()
    mockRmSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy')
    })

    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'os_init : Update apt cache', failed: true, msg: 'E: apt lock held' }]),
      'fatal: [203.0.113.10]: FAILED!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('Failed to remove temp dir')
    }
  })
})

describe('runServerSetup - unmatched failing tasks (precheck / Gathering Facts)', () => {
  // `precheck` (tagged `always`) and the implicit `Gathering Facts` task
  // don't belong to any requested ServerSetupStepType, so a failure there
  // (unsupported OS, unreachable host, ...) would otherwise vanish
  // entirely: every requested step would just read "skipped: No task
  // output found", silently discarding the real reason the whole run
  // failed.

  it('surfaces the precheck "Unsupported OS" failure message in the top-level error', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([
        {
          name: 'precheck : Verify supported OS',
          failed: true,
          msg: 'Unsupported OS: Debian 12. Only Ubuntu 22.04/24.04 LTS are supported by server setup execution.',
        },
      ]),
      'fatal: [203.0.113.10]: FAILED!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('Unsupported OS: Debian 12')
      // Still parsed as a normal (if unhelpfully "skipped") per-step result.
      expect(result.data).toEqual({
        stepResults: [{ stepType: 'os_init', status: 'skipped', changed: false, message: 'No task output found for os_init' }],
      })
    }
  })

  it('surfaces an unreachable-host failure from the implicit "Gathering Facts" task', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      4,
      JSON.stringify({
        plays: [
          {
            tasks: [
              {
                task: { name: 'Gathering Facts' },
                hosts: {
                  '203.0.113.10': {
                    unreachable: true,
                    failed: true,
                    skipped: false,
                    changed: false,
                    msg: 'Failed to connect to the host via ssh: Connection timed out',
                  },
                },
              },
            ],
          },
        ],
      }),
      'fatal: [203.0.113.10]: UNREACHABLE!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to connect to the host via ssh')
    }
  })

  it('does not include an unmatched-failure suffix when there is nothing outside the requested steps', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'os_init : Update apt cache', failed: true, msg: 'E: package not found' }]),
      'fatal!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('ansible-playbook exited with code 2: fatal!')
    }
  })

  it('falls back to a generic "host unreachable" reason when an unmatched unreachable result has no msg', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      4,
      JSON.stringify({
        plays: [
          {
            tasks: [
              {
                task: { name: 'Gathering Facts' },
                hosts: { '203.0.113.10': { unreachable: true, failed: true, skipped: false, changed: false } },
              },
            ],
          },
        ],
      }),
      '',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Gathering Facts: host unreachable')
    }
  })

  it('falls back to a generic "<group> failed" reason when an unmatched (non-unreachable) failure has no msg', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'precheck : Verify supported OS', failed: true }]),
      '',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('precheck: precheck failed')
    }
  })
})

describe('runServerSetup - known_hosts resolution failure', () => {
  it('returns an error result and never creates the temp dir when the persistent known_hosts file cannot be resolved', async () => {
    const client = makeClient()
    mockResolveKnownHostsPath.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to resolve known_hosts file')
      expect(result.error).toContain('EACCES: permission denied')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - ansible-playbook timeout', () => {
  it('returns a timeout error result, without stepResults, when execFile is killed for exceeding the timeout', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()

    const timeoutError: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null } = Object.assign(
      new Error('Command timed out after 1800000ms'),
      { killed: true, signal: 'SIGTERM' as const },
    )
    resolveExecFileWithError(timeoutError, '', '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.toLowerCase()).toContain('timed out')
      expect(result.data).toBeUndefined()
    }

    // The temp dir (private key included) is still removed.
    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('passes a positive timeout option to execFile so ansible-playbook cannot hang forever', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect((options as { timeout: number }).timeout).toBeGreaterThanOrEqual(60_000)
  })
})

describe('runServerSetup - ansible-playbook spawn failure', () => {
  it('surfaces the underlying spawn error message and omits stepResults when ansible-playbook cannot be started (ENOENT)', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()

    const spawnError: NodeJS.ErrnoException = Object.assign(
      new Error('spawn ansible-playbook ENOENT'),
      { code: 'ENOENT' },
    )
    resolveExecFileWithError(spawnError, '', '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('spawn ansible-playbook ENOENT')
      // Deliberately not reported as a "skipped" step: that would read as an
      // intentional --tags skip rather than an environment failure.
      expect(result.data).toBeUndefined()
    }

    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('treats a numeric-but-nonzero exit as a normal failed run, not a spawn failure, even with empty stdout/stderr', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(1, '', '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 1')
      // A real (if degenerate) step-parse result, not the spawn-failure path.
      expect(result.data).toEqual({
        stepResults: [
          { stepType: 'os_init', status: 'skipped', changed: false, message: 'No task output found for os_init' },
          { stepType: 'docker', status: 'skipped', changed: false, message: 'No task output found for docker' },
        ],
      })
    }
  })
})

// Tailscale connectionType support (admin-docs
// docs/specifications/ssh-tailscale-support.md, section 2/3): `server_setup_exec`
// shares the same JIT SSH credential shape (`SshExecCredential`) as `ssh_exec`'s
// ssh-executor.ts. When `connectionType === 'tailscale'`, Ansible must be routed
// through the ECS oneshot task's Tailscale sidecar SOCKS5 proxy instead of
// connecting directly to `hostname`.
describe('runServerSetup - Tailscale connectionType', () => {
  const TAILSCALE_CREDENTIAL = {
    ...CREDENTIAL,
    connectionType: 'tailscale' as const,
    tailnetHostname: 'db-server-1.tailnet-abc.ts.net',
  }

  function inventoryHostVars(hostKey: string): Record<string, unknown> {
    const inventoryCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('inventory.yml'))
    expect(inventoryCall).toBeDefined()
    const inventoryJson = JSON.parse(inventoryCall?.[1] as string) as {
      target: { hosts: Record<string, Record<string, unknown>> }
    }
    return inventoryJson.target.hosts[hostKey]
  }

  it('uses tailnetHostname (not hostname) as ansible_host when connectionType is tailscale', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue(TAILSCALE_CREDENTIAL),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    const hostVars = inventoryHostVars(TAILSCALE_CREDENTIAL.hostname)
    expect(hostVars.ansible_host).toBe(TAILSCALE_CREDENTIAL.tailnetHostname)
    expect(hostVars.ansible_host).not.toBe(TAILSCALE_CREDENTIAL.hostname)
  })

  it('adds a SOCKS5 ProxyCommand (default port 1055) to ansible_ssh_common_args when connectionType is tailscale', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue(TAILSCALE_CREDENTIAL),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    await runPromise

    const hostVars = inventoryHostVars(TAILSCALE_CREDENTIAL.hostname)
    const commonArgs = String(hostVars.ansible_ssh_common_args)
    expect(commonArgs).toContain('ProxyCommand')
    expect(commonArgs).toContain('127.0.0.1:1055')
    // Existing TOFU host-key-checking settings are preserved, not replaced.
    expect(commonArgs).toContain('StrictHostKeyChecking=accept-new')
    expect(commonArgs).toContain(`UserKnownHostsFile=${KNOWN_HOSTS_PATH}`)
  })

  it('uses a custom socksPort in the ProxyCommand when provided', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...TAILSCALE_CREDENTIAL, socksPort: 2080 }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    await runPromise

    const hostVars = inventoryHostVars(TAILSCALE_CREDENTIAL.hostname)
    const commonArgs = String(hostVars.ansible_ssh_common_args)
    expect(commonArgs).toContain('127.0.0.1:2080')
    expect(commonArgs).not.toContain('127.0.0.1:1055')
  })

  it('does not add a ProxyCommand when connectionType is ssh (or unset) — existing behavior unchanged', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, connectionType: 'ssh' as const }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    await runPromise

    const hostVars = inventoryHostVars(CREDENTIAL.hostname)
    expect(hostVars.ansible_host).toBe(CREDENTIAL.hostname)
    expect(String(hostVars.ansible_ssh_common_args)).not.toContain('ProxyCommand')
  })

  it('rejects a tailscale credential with a missing tailnetHostname before any temp dir is created', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({
        ...CREDENTIAL,
        connectionType: 'tailscale' as const,
        tailnetHostname: undefined,
      }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('tailnetHostname')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([
    ['contains a space', 'evil host.ts.net'],
    ['contains an embedded inventory variable', 'host.ts.net ansible_connection=local'],
    ['contains a quote', "host'name.ts.net"],
    ['is empty', ''],
  ])('rejects a tailnetHostname that %s', async (_label, tailnetHostname) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({
        ...TAILSCALE_CREDENTIAL,
        tailnetHostname,
      }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('tailnetHostname')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([0, -1, 65536, 1.5])('rejects an out-of-range socksPort %s', async (socksPort) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...TAILSCALE_CREDENTIAL, socksPort }),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('socksPort')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

// Custom Ansible tasks (admin-docs docs/features/server-setup.md「カスタム
// Ansibleタスク」): tenant admins can attach a `customTasksYaml` (+
// `customTasksMode`) to a step. The agent is the *authoritative* defense
// boundary re-validating this YAML (see ansible-task-guard.spec.ts for the
// guard's own exhaustive test coverage) — these tests cover only the
// runner's wiring: rejecting a malformed/malicious payload before any
// network call, and, on the happy path, generating a playbook that embeds
// the normalized (no_log-annotated) custom tasks.
describe('runServerSetup - custom Ansible tasks payload validation', () => {
  it('rejects a step whose customTasksYaml fails the guard (forbidden task key), before any credential fetch', async () => {
    const client = makeClient()
    const yaml = `
- name: Escape to another host
  ansible.builtin.debug:
    msg: hi
  delegate_to: localhost
`
    const result = await runServerSetup(
      makePayload({ steps: [{ stepType: 'os_init', params: {}, customTasksYaml: yaml }] }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('server_setup_exec: custom task rejected')
      expect(result.error).toContain('delegate_to')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
    expect(client.getServerSetupVariables).not.toHaveBeenCalled()
  })

  it('rejects a step whose customTasksYaml is not a string', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({
        steps: [{ stepType: 'os_init', params: {}, customTasksYaml: 123 as unknown as string }],
      }),
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({ success: false, error: 'steps[0].customTasksYaml must be a string' })
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('rejects a step whose customTasksMode is not append/replace', async () => {
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({
        steps: [{ stepType: 'os_init', params: {}, customTasksMode: 'delete' as unknown as 'append' }],
      }),
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({
      success: false,
      error: 'steps[0].customTasksMode must be one of: append, replace',
    })
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('accepts a step with valid customTasksYaml and customTasksMode and proceeds to fetch credentials', async () => {
    const client = makeClient()
    const yaml = `
- name: Write a marker file
  ansible.builtin.copy:
    content: "hello"
    dest: /tmp/marker
`
    const runPromise = runServerSetup(
      makePayload({
        steps: [{ stepType: 'os_init', params: {}, customTasksYaml: yaml, customTasksMode: 'append' }],
      }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(client.getServerSetupSshCredential).toHaveBeenCalled()
  })
})

describe('runServerSetup - server setup variables (project ANSIBLE# vars)', () => {
  it('fetches server setup variables scoped to the commandId/agentId and merges them into extra-vars.json', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_HOST: '10.0.0.5' },
        secretNames: [],
      }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client, agentId: 'agent-9' })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(client.getServerSetupVariables).toHaveBeenCalledWith('cmd-1', 'agent-9')
    const extraVarsCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('extra-vars.json'))
    expect(JSON.parse(extraVarsCall?.[1] as string)).toEqual({ DB_HOST: '10.0.0.5' })
  })

  it("step params override a same-named project variable on conflict", async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { domain: 'from-project-vars.example.com' },
        secretNames: [],
      }),
    })
    const runPromise = runServerSetup(
      makePayload({ steps: [{ stepType: 'dns_tls', params: { domain: 'from-step-params.example.com' } }] }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'dns_tls : Generate Caddyfile' }]))
    await runPromise

    const extraVarsCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('extra-vars.json'))
    expect(JSON.parse(extraVarsCall?.[1] as string)).toEqual({ domain: 'from-step-params.example.com' })
  })

  it('returns an error result and never creates a temp dir when the variables fetch fails', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockRejectedValue(new Error('503 unavailable')),
    })

    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to fetch server setup variables')
      expect(result.error).toContain('503 unavailable')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - ANSIBLE_ROLES_PATH', () => {
  it('always sets ANSIBLE_ROLES_PATH to <ansibleDir>/roles, even without custom tasks', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    const rolesPath = (options as { env: NodeJS.ProcessEnv }).env.ANSIBLE_ROLES_PATH
    expect(rolesPath).toBeDefined()
    expect(rolesPath).toMatch(/ansible[/\\]roles$/)
  })
})

describe('runServerSetup - custom task playbook generation (execution)', () => {
  it('writes a generated playbook to the temp dir and points ansible-playbook at it when a step carries customTasksYaml', async () => {
    const client = makeClient()
    const yaml = `
- name: Write a marker file
  ansible.builtin.copy:
    content: "hello"
    dest: /tmp/marker
`
    const runPromise = runServerSetup(
      makePayload({
        steps: [{ stepType: 'os_init', params: {}, customTasksYaml: yaml, customTasksMode: 'append' }],
      }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(true)
    const [, args] = mockExecFile.mock.calls[0]
    const playbookArg = (args as string[])[2]
    expect(playbookArg).toMatch(/generated-playbook\.yml$/)

    const generatedCall = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('generated-playbook.yml'))
    expect(generatedCall).toBeDefined()
    const generatedYaml = generatedCall?.[1] as string
    expect(generatedYaml).toContain('precheck : Verify supported OS')
    expect(generatedYaml).toContain('role: os_init')
    expect(generatedYaml).toContain('Write a marker file')
  })

  it('uses the bundled playbook.yml path (unchanged behavior) when no step carries customTasksYaml', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, args] = mockExecFile.mock.calls[0]
    const playbookArg = (args as string[])[2]
    expect(playbookArg).toMatch(/ansible\/playbook\.yml$/)
    expect(mockWriteFileSync.mock.calls.some((call) => String(call[0]).endsWith('generated-playbook.yml'))).toBe(false)
  })
})

// Redaction (belt-and-suspenders): even if a custom task somehow leaked a
// secret value into ansible-playbook's stdout/stderr without `no_log` having
// been applied, the runner must scrub the plaintext value before it reaches
// the returned CommandResult (which is later persisted verbatim as
// executionLogs — see server-setup-runner.ts's redactSecretValues doc
// comment).
describe('runServerSetup - secret redaction in ansible-playbook output', () => {
  it('redacts a secret value that leaks into a step message via stdout', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_PASSWORD: 'sup3r-s3cr3t-value' },
        secretNames: ['DB_PASSWORD'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([
        {
          name: 'os_init : Update apt cache',
          failed: true,
          msg: 'leaked plaintext: sup3r-s3cr3t-value',
        },
      ]),
      'fatal!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(JSON.stringify(result.data)).not.toContain('sup3r-s3cr3t-value')
      expect(JSON.stringify(result.data)).toContain('***')
    }
  })

  it('redacts a secret value that leaks into stderr (surfaced in the top-level error message)', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_PASSWORD: 'sup3r-s3cr3t-value' },
        secretNames: ['DB_PASSWORD'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'os_init : Update apt cache', failed: true, msg: 'boom' }]),
      'fatal: password was sup3r-s3cr3t-value',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).not.toContain('sup3r-s3cr3t-value')
      expect(result.error).toContain('***')
    }
  })

  it('does not attempt to redact an empty-string secret value (would corrupt output)', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { EMPTY_SECRET: '' },
        secretNames: ['EMPTY_SECRET'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      stepResults: [{ stepType: 'os_init', status: 'ok', changed: true, message: 'os_init completed' }],
    })
  })

  it('does not redact anything when there are no secret names', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      stepResults: [{ stepType: 'os_init', status: 'ok', changed: true, message: 'os_init completed' }],
    })
  })
})

describe('runServerSetup - opt-in non-root ansible-playbook execution', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('does not set uid/gid on execFile options by default', async () => {
    delete process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID
    delete process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_GID
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect(options as Record<string, unknown>).not.toHaveProperty('uid')
    expect(options as Record<string, unknown>).not.toHaveProperty('gid')
  })

  it('sets uid/gid on execFile options when the opt-in env vars are set', async () => {
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID = '1500'
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_GID = '1500'
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect((options as { uid?: number }).uid).toBe(1500)
    expect((options as { gid?: number }).gid).toBe(1500)
  })

  it('ignores a non-numeric uid/gid override and omits the option entirely', async () => {
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID = 'not-a-number'
    const client = makeClient()
    const runPromise = runServerSetup(makePayload({ steps: [{ stepType: 'os_init', params: {} }] }), {
      commandId: 'cmd-1',
      client,
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache' }]))
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect(options as Record<string, unknown>).not.toHaveProperty('uid')
  })
})

describe('fetchServerSetupVariables', () => {
  it("delegates to the client's getServerSetupVariables with the given commandId/agentId", async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { FOO: 'bar' },
        secretNames: [],
      }),
    })

    const { fetchServerSetupVariables } = await import('../../src/server-setup/server-setup-runner')
    const result = await fetchServerSetupVariables(client, 'cmd-1', 'agent-1')

    expect(result).toEqual({ variables: { FOO: 'bar' }, secretNames: [] })
    expect(client.getServerSetupVariables).toHaveBeenCalledWith('cmd-1', 'agent-1')
  })

  it('propagates a rejection from the client', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockRejectedValue(new Error('network error')),
    })

    const { fetchServerSetupVariables } = await import('../../src/server-setup/server-setup-runner')
    await expect(fetchServerSetupVariables(client, 'cmd-1', 'agent-1')).rejects.toThrow('network error')
  })
})

describe('generatePlaybook', () => {
  it('always includes the precheck task tagged "always"', () => {
    const yaml = generatePlaybook([{ stepType: 'os_init' }])
    expect(yaml).toContain('precheck : Verify supported OS')
    expect(yaml).toContain('tags: always')
  })

  it('includes a role entry for a step without customTasksMode (defaults to append behavior)', () => {
    const yaml = generatePlaybook([{ stepType: 'docker' }])
    expect(yaml).toMatch(/role:\s*docker/)
  })

  it('omits the role entry for a step with customTasksMode "replace"', () => {
    const yaml = generatePlaybook([{ stepType: 'docker', customTasksMode: 'replace', normalizedTasks: [{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }] }])
    expect(yaml).not.toMatch(/role:\s*docker/)
    expect(yaml).toContain('post_tasks')
  })

  it('includes both the role and a post_tasks block for a step with customTasksMode "append" and normalizedTasks', () => {
    const yaml = generatePlaybook([
      { stepType: 'web_server', customTasksMode: 'append', normalizedTasks: [{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }] },
    ])
    expect(yaml).toMatch(/role:\s*web_server/)
    expect(yaml).toContain('post_tasks')
  })

  it('omits post_tasks entirely when no step has normalizedTasks', () => {
    const yaml = generatePlaybook([{ stepType: 'os_init' }, { stepType: 'docker' }])
    expect(yaml).not.toContain('post_tasks')
  })

  it('produces valid, parseable YAML', () => {
    const yaml = generatePlaybook([
      { stepType: 'os_init' },
      { stepType: 'database', customTasksMode: 'replace', normalizedTasks: [{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }] },
    ])
    const loaded = jest.requireActual('js-yaml').load(yaml) as unknown[]
    expect(Array.isArray(loaded)).toBe(true)
  })

  describe('snapshot: append/replace mode across every stepType', () => {
    const STEP_TYPES = ['os_init', 'docker', 'web_server', 'database', 'dns_tls'] as const

    it.each(STEP_TYPES)('append mode for %s', (stepType) => {
      const yaml = generatePlaybook([
        {
          stepType,
          customTasksMode: 'append',
          normalizedTasks: [{ name: `${stepType} : custom marker`, 'ansible.builtin.debug': { msg: 'hi' } }],
        },
      ])
      expect(yaml).toMatchSnapshot()
    })

    it.each(STEP_TYPES)('replace mode for %s', (stepType) => {
      const yaml = generatePlaybook([
        {
          stepType,
          customTasksMode: 'replace',
          normalizedTasks: [{ name: `${stepType} : custom marker`, 'ansible.builtin.debug': { msg: 'hi' } }],
        },
      ])
      expect(yaml).toMatchSnapshot()
    })
  })
})
