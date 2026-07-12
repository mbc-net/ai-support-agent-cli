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

import { runServerSetup } from '../../src/server-setup/server-setup-runner'
import { logger } from '../../src/logger'
import type { ApiClient } from '../../src/api-client'
import type { ServerSetupExecPayload, SshCredentials } from '../../src/types'

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

function makeClient(
  overrides: Partial<Record<'getServerSetupSshCredential' | 'getTenantCode', jest.Mock>> = {},
): ApiClient {
  return {
    getServerSetupSshCredential: overrides.getServerSetupSshCredential ?? jest.fn().mockResolvedValue(CREDENTIAL),
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
    resolveExecFile(0, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]))
    await runPromise

    expect(client.getServerSetupSshCredential).toHaveBeenCalledWith('cmd-1', '')
  })

  it('passes the agentId through when provided', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client, agentId: 'agent-42' })
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()

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
    await Promise.resolve()
    await Promise.resolve()
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
