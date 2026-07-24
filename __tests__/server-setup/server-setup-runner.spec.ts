/**
 * Tests for src/server-setup/server-setup-runner.ts (git-artifact-platform model).
 *
 * The payload is now `{ executionId, sshHostId, body }` where `body` is a
 * top-level YAML list of Ansible tasks. Covers: payload validation + the
 * authoritative body guard, route-mode resolution (ecs strict / resident
 * lenient), the SSH-credential JIT fetch, the ansible-playbook invocation
 * (args/env), per-task result parsing, and — critically — that the temp
 * directory holding the private key is always removed on both success and
 * failure paths.
 *
 * `fs`'s sync methods are non-configurable getters under Jest's Node
 * environment, so the whole `fs` module is mocked with pass-through jest.fn()s
 * (real behavior by default, overridable per test).
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

const KNOWN_HOSTS_PATH = '/fake-config-dir/server-setup/known-hosts/acme__host-1'
const mockResolveKnownHostsPath = jest.fn().mockReturnValue(KNOWN_HOSTS_PATH)
jest.mock('../../src/utils/known-hosts-store', () => ({
  resolveKnownHostsPath: (...args: unknown[]) => mockResolveKnownHostsPath(...args),
}))

import { load } from 'js-yaml'

import {
  cleanupStaleServerSetupDirs,
  fetchServerSetupVariables,
  generatePlaybook,
  parseAnsibleOutput,
  redactSecretValues,
  resolveRouteMode,
  runServerSetup,
  SUDO_PROBE_REGISTER_VAR,
} from '../../src/server-setup/server-setup-runner'
import { logger } from '../../src/logger'
import type { ApiClient } from '../../src/api-client'
import type { ServerSetupExecPayload, ServerSetupVariablesResponse, SshCredentials } from '../../src/types'

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n'

// authType mirrors the real api enum (api/src/project/dto/ssh-config.dto.ts:
// `enum: ['password', 'privateKey']`) so tests reflect an actual server
// response shape rather than an arbitrary "not password" placeholder.
const CREDENTIAL: SshCredentials = {
  hostId: 'host-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  authType: 'privateKey',
  privateKey: PRIVATE_KEY,
}

// Two include_role built-in steps — valid in both ecs and resident modes.
// Task names are quoted because they contain a `: ` (YAML would otherwise
// parse that as a nested mapping).
const DEFAULT_BODY = `
- name: "os_init : Update apt cache"
  include_role:
    name: os_init
- name: "docker : Install Docker Engine and compose plugin"
  include_role:
    name: docker
`

function makePayload(overrides: Partial<ServerSetupExecPayload> = {}): ServerSetupExecPayload {
  return {
    executionId: 'exec-1',
    sshHostId: 'host-1',
    body: DEFAULT_BODY,
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

function ansibleJsonOutput(
  tasks: Array<{ name: string; changed?: boolean; failed?: boolean; skipped?: boolean; unreachable?: boolean; msg?: string }>,
): string {
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
              ...(t.unreachable !== undefined && { unreachable: t.unreachable }),
              ...(t.msg !== undefined && { msg: t.msg }),
            },
          },
        })),
      },
    ],
  })
}

/** Default happy-path ansible output: precheck + the two default body steps. */
function defaultOutput(): string {
  return ansibleJsonOutput([
    { name: 'precheck : Verify supported OS', skipped: true },
    { name: 'os_init : Update apt cache', changed: true },
    { name: 'docker : Install Docker Engine and compose plugin', changed: true },
  ])
}

function resolveExecFile(exitCode: number, stdout: string, stderr = ''): void {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1]
  const callback = call[call.length - 1] as (error: unknown, stdout: string, stderr: string) => void
  if (exitCode === 0) {
    callback(null, stdout, stderr)
  } else {
    const error: NodeJS.ErrnoException & { code?: number } = Object.assign(
      new Error(`Command failed with code ${exitCode}`),
      { code: exitCode },
    )
    callback(error, stdout, stderr)
  }
}

function resolveExecFileWithError(
  error: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null },
  stdout = '',
  stderr = '',
): void {
  const call = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1]
  const callback = call[call.length - 1] as (error: unknown, stdout: string, stderr: string) => void
  callback(error, stdout, stderr)
}

async function flushUntilExecFileCalled(): Promise<void> {
  for (let i = 0; i < 50 && mockExecFile.mock.calls.length === 0; i++) {
    await Promise.resolve()
  }
}

function allLoggedText(): string {
  const mocked = logger as unknown as Record<string, jest.Mock>
  return ['info', 'success', 'error', 'warn', 'debug']
    .flatMap((m) => mocked[m].mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n')
}

function writtenFile(suffix: string): string | undefined {
  const call = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith(suffix))
  return call?.[1] as string | undefined
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMkdtempSync.mockImplementation((...args: Parameters<typeof actualFs.mkdtempSync>) => actualFs.mkdtempSync(...args))
  mockWriteFileSync.mockImplementation((...args: Parameters<typeof actualFs.writeFileSync>) => actualFs.writeFileSync(...args))
  mockRmSync.mockImplementation((...args: Parameters<typeof actualFs.rmSync>) => actualFs.rmSync(...args))
  mockExistsSync.mockImplementation((...args: Parameters<typeof actualFs.existsSync>) => actualFs.existsSync(...args))
  mockResolveKnownHostsPath.mockReturnValue(KNOWN_HOSTS_PATH)
})

describe('resolveRouteMode', () => {
  // (1) Authoritative api dispatch hint always wins over the local env.
  it('maps payload.dispatchMode=resident_agent to the lenient "resident" mode', () => {
    expect(resolveRouteMode({ dispatchMode: 'resident_agent' }, {})).toBe('resident')
    // Wins even when AGENT_MODE would otherwise indicate ECS oneshot.
    expect(resolveRouteMode({ dispatchMode: 'resident_agent' }, { AGENT_MODE: 'oneshot' })).toBe(
      'resident',
    )
  })

  it('maps payload.dispatchMode=ecs_oneshot to the strict "ecs" mode', () => {
    expect(resolveRouteMode({ dispatchMode: 'ecs_oneshot' }, {})).toBe('ecs')
  })

  // (2) No dispatchMode: AGENT_MODE=oneshot still positively confirms ecs.
  it('falls back to AGENT_MODE=oneshot -> "ecs" when the payload carries no dispatchMode', () => {
    expect(resolveRouteMode({}, { AGENT_MODE: 'oneshot' })).toBe('ecs')
    expect(resolveRouteMode(undefined, { AGENT_MODE: 'oneshot' })).toBe('ecs')
  })

  // (3) Fail closed: anything not positively resolved to resident -> ecs.
  it('fails closed to "ecs" with no dispatchMode and an unset/non-oneshot AGENT_MODE', () => {
    expect(resolveRouteMode({}, {})).toBe('ecs')
    expect(resolveRouteMode(undefined, {})).toBe('ecs')
    expect(resolveRouteMode(null, {})).toBe('ecs')
    expect(resolveRouteMode({}, { AGENT_MODE: 'resident' })).toBe('ecs')
  })

  it('fails closed to "ecs" for an unknown dispatchMode value', () => {
    expect(
      resolveRouteMode(
        { dispatchMode: 'bogus' as unknown as 'ecs_oneshot' },
        { AGENT_MODE: 'oneshot' },
      ),
    ).toBe('ecs')
  })

  it('defaults to process.env when no env is passed', () => {
    expect(['ecs', 'resident']).toContain(resolveRouteMode())
  })
})

describe('runServerSetup - payload validation', () => {
  it.each([
    ['executionId missing', { executionId: '' }, 'executionId is required for server_setup_exec'],
    ['sshHostId missing', { sshHostId: '' }, 'sshHostId is required for server_setup_exec'],
    ['body missing', { body: undefined as unknown as string }, 'body (non-empty Ansible task list YAML) is required for server_setup_exec'],
    ['body empty', { body: '   ' }, 'body (non-empty Ansible task list YAML) is required for server_setup_exec'],
  ])('rejects an invalid payload: %s', async (_label, overrides, expectedError) => {
    const client = makeClient()
    const result = await runServerSetup(makePayload(overrides), { commandId: 'cmd-1', client })

    expect(result).toEqual({ success: false, error: expectedError })
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('rejects a body that fails the guard (forbidden task key) before any credential fetch', async () => {
    const client = makeClient()
    const body = `
- name: Escape to another host
  ansible.builtin.debug:
    msg: hi
  delegate_to: localhost
`
    const result = await runServerSetup(makePayload({ body }), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('server_setup_exec: recipe body rejected')
      expect(result.error).toContain('delegate_to')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
    expect(client.getServerSetupVariables).not.toHaveBeenCalled()
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it('rejects a body that is a play (hosts/tasks), not a task list', async () => {
    const client = makeClient()
    const body = `
hosts: all
tasks:
  - name: x
    ansible.builtin.debug:
      msg: hi
`
    const result = await runServerSetup(makePayload({ body }), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('recipe body rejected')
      expect(result.error).toContain('top-level must be a list of tasks, not a play')
    }
  })

  it('rejects an include_role referencing a role outside the allowed bundled roles', async () => {
    const client = makeClient()
    const body = `
- name: rootkit
  include_role:
    name: rootkit
`
    const result = await runServerSetup(makePayload({ body }), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('recipe body rejected')
      expect(result.error).toContain('include_role name is not one of the allowed bundled roles')
    }
  })
})

describe('runServerSetup - route mode (ecs strict vs resident lenient)', () => {
  const ORIGINAL_ENV = process.env
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  // ansible.builtin.uri is on the resident-only extra allowlist.
  const URI_BODY = `
- name: Call an API
  ansible.builtin.uri:
    url: https://example.com
`

  it('rejects a resident-only module (uri) under dispatchMode=ecs_oneshot', async () => {
    delete process.env.AGENT_MODE
    const client = makeClient()
    const result = await runServerSetup(
      makePayload({ body: URI_BODY, dispatchMode: 'ecs_oneshot' }),
      { commandId: 'cmd-1', client },
    )

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('recipe body rejected')
      expect(result.error).toContain('module not in allowlist')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('fails closed: rejects a resident-only module (uri) when the payload carries no dispatchMode and AGENT_MODE is unset', async () => {
    // The previous env-derived default treated "no AGENT_MODE" as resident
    // (fail-open); it now fails closed to the strict ecs allowlist.
    delete process.env.AGENT_MODE
    const client = makeClient()
    const result = await runServerSetup(makePayload({ body: URI_BODY }), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('recipe body rejected')
      expect(result.error).toContain('module not in allowlist')
    }
    expect(client.getServerSetupSshCredential).not.toHaveBeenCalled()
  })

  it('accepts a resident-only module (uri) under dispatchMode=resident_agent', async () => {
    delete process.env.AGENT_MODE
    const client = makeClient()
    const runPromise = runServerSetup(
      makePayload({ body: URI_BODY, dispatchMode: 'resident_agent' }),
      { commandId: 'cmd-1', client },
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'precheck : Verify supported OS', skipped: true },
      { name: 'Call an API', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(client.getServerSetupSshCredential).toHaveBeenCalled()
  })
})

describe('runServerSetup - SSH credential fetch', () => {
  it('fetches the credential scoped to the commandId, using an empty agentId when none is provided', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    expect(client.getServerSetupSshCredential).toHaveBeenCalledWith('cmd-1', '')
  })

  it('passes the agentId through when provided', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client, agentId: 'agent-42' })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
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
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - SSH credential validation', () => {
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
    if (!result.success) expect(result.error).toContain('hostname')
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
    if (!result.success) expect(result.error).toContain('username')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([0, -1, 65536, 1.5])('rejects an out-of-range port %d', async (port) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, port }),
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('port')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - bundled roles resolution', () => {
  it('returns an error result when the bundled roles directory cannot be found', async () => {
    const client = makeClient()
    mockExistsSync.mockReturnValueOnce(false)
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Ansible roles directory not found')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error result when the bundled callback_plugins directory cannot be found (json stdout callback would otherwise be missing)', async () => {
    const client = makeClient()
    // roles/ exists (real check passes) but callback_plugins/ is missing —
    // packaging error must fail clearly before creating a temp dir / private key.
    // (Use `includes` so the bundled json.py under callback_plugins/ is also
    // treated as absent, matching a genuinely missing directory.)
    mockExistsSync.mockImplementation((...args: Parameters<typeof actualFs.existsSync>) => {
      const p = String(args[0])
      if (p.includes('callback_plugins')) return false
      return actualFs.existsSync(...args)
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('json stdout callback not found')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error result when callback_plugins/ exists but the bundled json.py callback file is missing (partial packaging must fail loudly, not after the temp dir/private key is created)', async () => {
    const client = makeClient()
    // The directory is present but the required json.py stdout callback file is
    // absent. Checking only the directory would let this through and reproduce
    // the original "Invalid callback for stdout specified: json" error after the
    // private key is already on disk. Guard must reject it up front.
    mockExistsSync.mockImplementation((...args: Parameters<typeof actualFs.existsSync>) => {
      const p = String(args[0])
      if (p.endsWith(`callback_plugins${require('path').sep}json.py`)) return false
      return actualFs.existsSync(...args)
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('json stdout callback not found')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - success path', () => {
  it('writes the private key 0600, invokes ansible-playbook with the right args/env, and removes the temp dir', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    // Mirrors the *actual* system task list generatePlaybook() prepends
    // (fact gather, sudo probe, sudo assert, OS precheck) ahead of the body,
    // rather than only the OS-precheck-plus-body subset `defaultOutput()`
    // uses elsewhere — this is the one test that also asserts on the real
    // generated-playbook.yml content below, so it should reflect the true
    // task list end to end.
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'precheck : Gather facts (no privilege escalation)', changed: false },
      { name: 'precheck : Probe passwordless sudo', changed: false },
      { name: 'precheck : Verify passwordless sudo', skipped: true },
      { name: 'precheck : Verify supported OS', skipped: true },
      { name: 'os_init : Update apt cache', changed: true },
      { name: 'docker : Install Docker Engine and compose plugin', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)

    expect(mockMkdtempSync).toHaveBeenCalledTimes(1)
    const tmpDir = mockMkdtempSync.mock.results[0].value as string

    // Private key: 0600.
    const keyWriteCall = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith('id_rsa'))
    expect(keyWriteCall?.[0]).toBe(`${tmpDir}/id_rsa`)
    expect(keyWriteCall?.[1]).toBe(PRIVATE_KEY)
    expect(keyWriteCall?.[2]).toEqual({ mode: 0o600 })

    // ansible-playbook via execFile (never a shell); NO --tags; generated playbook.
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const [cmd, args, options] = mockExecFile.mock.calls[0]
    expect(cmd).toBe('ansible-playbook')
    expect(args[0]).toBe('-i')
    expect(args[1]).toBe(`${tmpDir}/inventory.yml`)
    expect(args[2]).toBe(`${tmpDir}/generated-playbook.yml`)
    expect(args[3]).toBe('-e')
    expect(args[4]).toBe(`@${tmpDir}/extra-vars.json`)
    expect(args).not.toContain('--tags')
    const env = (options as { env: NodeJS.ProcessEnv }).env
    expect(env.ANSIBLE_STDOUT_CALLBACK).toBe('json')
    expect(env.ANSIBLE_ROLES_PATH).toMatch(/ansible[/\\]roles$/)
    // The bundled `json` stdout callback lives at ansible/callback_plugins/json.py.
    // Ansible auto-discovers callback plugins only from a callback_plugins/ dir
    // next to the *running* playbook — but the generated playbook runs from a
    // temp dir, so the runner MUST point ANSIBLE_CALLBACK_PLUGINS at the bundled
    // callback_plugins/ dir (mirroring ANSIBLE_ROLES_PATH). Without it,
    // ansible-playbook aborts with "Invalid callback for stdout specified: json".
    expect(env.ANSIBLE_CALLBACK_PLUGINS).toMatch(/ansible[/\\]callback_plugins$/)
    expect((options as { timeout: number }).timeout).toBeGreaterThan(0)

    // extra-vars.json = project variables only (empty here), 0600.
    const extraVarsCall = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith('extra-vars.json'))
    expect(JSON.parse(extraVarsCall?.[1] as string)).toEqual({})
    expect(extraVarsCall?.[2]).toEqual({ mode: 0o600 })

    // generated-playbook.yml: single play with precheck + the body tasks.
    const generatedYaml = writtenFile('generated-playbook.yml') as string
    expect(generatedYaml).toContain('precheck : Verify supported OS')
    expect(generatedYaml).toContain('include_role')
    expect(generatedYaml).toContain('os_init')
    const play = (load(generatedYaml) as Array<Record<string, unknown>>)[0]
    expect(play.hosts).toBe('all')
    expect(play.become).toBe(true)
    // Facts are gathered explicitly (become:false) by a system task instead —
    // see the `generatePlaybook` describe block below for why.
    expect(play.gather_facts).toBe(false)

    // inventory.yml references the fetched host/port/user/key path with TOFU.
    const inventoryJson = JSON.parse(writtenFile('inventory.yml') as string) as {
      target: { hosts: Record<string, Record<string, unknown>> }
    }
    const hostVars = inventoryJson.target.hosts[CREDENTIAL.hostname]
    expect(hostVars.ansible_host).toBe(CREDENTIAL.hostname)
    expect(hostVars.ansible_port).toBe(CREDENTIAL.port)
    expect(hostVars.ansible_user).toBe(CREDENTIAL.username)
    expect(hostVars.ansible_ssh_private_key_file).toBe(`${tmpDir}/id_rsa`)
    expect(hostVars.ansible_ssh_common_args).toContain('StrictHostKeyChecking=accept-new')
    expect(hostVars.ansible_ssh_common_args).toContain(`UserKnownHostsFile=${KNOWN_HOSTS_PATH}`)
    expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'host-1')

    // Per-task results (facts gathered, sudo verified, OS precheck skipped, the two body steps changed).
    expect(result.data).toEqual({
      stepResults: [
        { name: 'precheck : Gather facts (no privilege escalation)', status: 'ok', changed: false, message: 'precheck : Gather facts (no privilege escalation) completed' },
        { name: 'precheck : Probe passwordless sudo', status: 'ok', changed: false, message: 'precheck : Probe passwordless sudo completed' },
        { name: 'precheck : Verify passwordless sudo', status: 'skipped', changed: false, message: 'precheck : Verify passwordless sudo skipped' },
        { name: 'precheck : Verify supported OS', status: 'skipped', changed: false, message: 'precheck : Verify supported OS skipped' },
        { name: 'os_init : Update apt cache', status: 'ok', changed: true, message: 'os_init : Update apt cache completed' },
        { name: 'docker : Install Docker Engine and compose plugin', status: 'ok', changed: true, message: 'docker : Install Docker Engine and compose plugin completed' },
      ],
    })

    // Temp dir removed on the real filesystem; known_hosts (outside tmpDir) is not.
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
    expect(mockRmSync.mock.calls.some((c) => c[0] === KNOWN_HOSTS_PATH)).toBe(false)

    // Private key never logged.
    expect(allLoggedText()).not.toContain(PRIVATE_KEY)
  })

  it('reports an unreachable task as failed', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'precheck : Verify supported OS', skipped: true },
      { name: 'os_init : Update apt cache', unreachable: true, failed: true, msg: 'Connection timed out' },
      { name: 'docker : x', changed: true },
    ]))
    const result = await runPromise

    // exit 0 but a task marked failed → still success:true (exit code drives
    // overall success); the per-task entry carries the failure detail.
    expect(result.success).toBe(true)
    const stepResults = (result.data as { stepResults: Array<Record<string, unknown>> }).stepResults
    expect(stepResults[1]).toEqual({
      name: 'os_init : Update apt cache',
      status: 'failed',
      changed: false,
      message: 'Connection timed out',
    })
  })

  it('succeeds normally when passwordless sudo is configured (probe rc=0, assert skipped)', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'precheck : Gather facts (no privilege escalation)', changed: false },
      { name: 'precheck : Probe passwordless sudo', changed: false },
      { name: 'precheck : Verify passwordless sudo', skipped: true },
      { name: 'precheck : Verify supported OS', skipped: true },
      { name: 'os_init : Update apt cache', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    const stepResults = (result.data as { stepResults: Array<Record<string, unknown>> }).stepResults
    expect(stepResults.map((s) => s.name)).toEqual([
      'precheck : Gather facts (no privilege escalation)',
      'precheck : Probe passwordless sudo',
      'precheck : Verify passwordless sudo',
      'precheck : Verify supported OS',
      'os_init : Update apt cache',
    ])
    expect(stepResults.every((s) => s.status !== 'failed')).toBe(true)
  })

  it('fails the run when stdout is malformed (non-JSON), even though ansible-playbook exited 0', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
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
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('stdout')
      expect(result.error).toContain('was empty')
    }
  })

  it('fails the run when a 0 exit produced zero parsed tasks (truncated JSON stream)', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, JSON.stringify({ plays: [{ tasks: [] }] }))
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('produced no task output')
    }
  })
})

describe('runServerSetup - failure path', () => {
  it('returns a failed result (with per-task stepResults + failed task detail) and removes the temp dir on non-zero exit', async () => {
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
      expect(result.error).toContain('E: Unable to locate package docker-ce')
      expect(result.data).toEqual({
        stepResults: [
          { name: 'os_init : Update apt cache', status: 'ok', changed: true, message: 'os_init : Update apt cache completed' },
          { name: 'docker : Install Docker Engine and compose plugin', status: 'failed', changed: false, message: 'E: Unable to locate package docker-ce' },
        ],
      })
    }

    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('surfaces the precheck "Unsupported OS" failure message in the top-level error', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([
        {
          name: 'precheck : Verify supported OS',
          failed: true,
          msg: 'Unsupported OS: Debian 12. Only Ubuntu 22.04/24.04/26.04 LTS are supported by server setup execution.',
        },
      ]),
      'fatal!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('Unsupported OS: Debian 12')
    }
  })

  it('surfaces a clear, actionable error when the target host lacks NOPASSWD sudo (regression: previously this bubbled up as the opaque "ansible.legacy.setup" gather_facts failure)', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([
        { name: 'precheck : Gather facts (no privilege escalation)', changed: false },
        { name: 'precheck : Probe passwordless sudo', changed: false },
        {
          name: 'precheck : Verify passwordless sudo',
          failed: true,
          msg:
            "Passwordless (NOPASSWD) sudo is required for server setup, but the SSH user 'deploy' "
            + 'cannot escalate without a password on 203.0.113.10. Grant NOPASSWD sudo to this user '
            + '(e.g. a sudoers entry) and retry. Server setup does not support password-based sudo.',
        },
      ]),
      'fatal!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('Passwordless (NOPASSWD) sudo is required')
      expect(result.error).not.toContain('ansible.legacy.setup')
    }
  })

  it('does not include a failed-task suffix when nothing failed at task level', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(2, ansibleJsonOutput([{ name: 'os_init : Update apt cache', changed: true }]), 'fatal!')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe('ansible-playbook exited with code 2: fatal!')
    }
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

  it('marks the overall result as failed (even though the run succeeded) when temp-dir cleanup fails', async () => {
    const client = makeClient()
    mockRmSync.mockImplementationOnce(() => {
      throw new Error('EBUSY: resource busy')
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to remove temp dir')
      expect(result.error).toContain('SSH private key')
    }
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
    resolveExecFile(2, ansibleJsonOutput([{ name: 'os_init : Update apt cache', failed: true, msg: 'E: apt lock held' }]), 'fatal!')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 2')
      expect(result.error).toContain('Failed to remove temp dir')
    }
  })
})

describe('runServerSetup - known_hosts resolution failure', () => {
  it('returns an error and never creates the temp dir when known_hosts cannot be resolved', async () => {
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
  it('returns a timeout error without stepResults, and still removes the temp dir', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    const timeoutError = Object.assign(new Error('Command timed out after 1800000ms'), {
      killed: true,
      signal: 'SIGTERM' as const,
    })
    resolveExecFileWithError(timeoutError, '', '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.toLowerCase()).toContain('timed out')
      expect(result.data).toBeUndefined()
    }
    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('passes a positive timeout option to execFile', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect((options as { timeout: number }).timeout).toBeGreaterThanOrEqual(60_000)
  })
})

describe('runServerSetup - ansible-playbook spawn failure', () => {
  it('surfaces the spawn error message and omits stepResults when ansible-playbook cannot start (ENOENT)', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    const spawnError = Object.assign(new Error('spawn ansible-playbook ENOENT'), { code: 'ENOENT' })
    resolveExecFileWithError(spawnError, '', '')
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('spawn ansible-playbook ENOENT')
      expect(result.data).toBeUndefined()
    }
    const tmpDir = mockMkdtempSync.mock.results[0].value as string
    expect(mockRmSync).toHaveBeenCalledWith(tmpDir, { recursive: true, force: true })
    expect(actualFs.existsSync(tmpDir)).toBe(false)
  })

  it('treats a numeric-but-nonzero exit with empty output as a normal failed run, not a spawn failure', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(1, '', '')
    const result = await runPromise

    // Empty stdout on a non-zero exit: no task output to parse, so
    // stepResults is an empty array (not omitted) and the error is the
    // exit-code message.
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('ansible-playbook exited with code 1')
      expect(result.data).toEqual({ stepResults: [] })
    }
  })
})

describe('runServerSetup - Tailscale connectionType', () => {
  const TAILSCALE_CREDENTIAL = {
    ...CREDENTIAL,
    connectionType: 'tailscale' as const,
    tailnetHostname: 'db-server-1.tailnet-abc.ts.net',
  }

  function inventoryHostVars(hostKey: string): Record<string, unknown> {
    const inventoryJson = JSON.parse(writtenFile('inventory.yml') as string) as {
      target: { hosts: Record<string, Record<string, unknown>> }
    }
    return inventoryJson.target.hosts[hostKey]
  }

  it('uses tailnetHostname as ansible_host and adds a SOCKS5 ProxyCommand', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue(TAILSCALE_CREDENTIAL),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    const hostVars = inventoryHostVars(TAILSCALE_CREDENTIAL.hostname)
    expect(hostVars.ansible_host).toBe(TAILSCALE_CREDENTIAL.tailnetHostname)
    const commonArgs = String(hostVars.ansible_ssh_common_args)
    expect(commonArgs).toContain('ProxyCommand')
    expect(commonArgs).toContain('127.0.0.1:1055')
    expect(commonArgs).toContain('StrictHostKeyChecking=accept-new')
  })

  it('uses a custom socksPort in the ProxyCommand when provided', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...TAILSCALE_CREDENTIAL, socksPort: 2080 }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const commonArgs = String(inventoryHostVars(TAILSCALE_CREDENTIAL.hostname).ansible_ssh_common_args)
    expect(commonArgs).toContain('127.0.0.1:2080')
    expect(commonArgs).not.toContain('127.0.0.1:1055')
  })

  it('does not add a ProxyCommand for a plain ssh connectionType', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, connectionType: 'ssh' as const }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
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
    if (!result.success) expect(result.error).toContain('tailnetHostname')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it.each([0, -1, 65536, 1.5])('rejects an out-of-range socksPort %s', async (socksPort) => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...TAILSCALE_CREDENTIAL, socksPort }),
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('socksPort')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

// Regression coverage for the bug where a password-authenticated SSH host
// (authType: 'password') had its plaintext password written to a temp
// `id_rsa` file and pointed to by `ansible_ssh_private_key_file` — the same
// mistake `commands/ssh-executor.ts` already avoids (it branches on
// `credential.authType === 'password'` for `ssh_exec`). OpenSSH cannot parse
// a plaintext password as PEM/OpenSSH key material, so the target host
// rejected the connection with "Load key ...: error in libcrypto" /
// "Permission denied (publickey,password)".
describe('runServerSetup - password authentication (authType)', () => {
  const PASSWORD_CREDENTIAL = {
    ...CREDENTIAL,
    authType: 'password' as const,
    privateKey: 's3cret-pw', // overloaded field: holds the password when authType === 'password'
  }

  function inventoryHostVars(hostKey: string): Record<string, unknown> {
    const inventoryJson = JSON.parse(writtenFile('inventory.yml') as string) as {
      target: { hosts: Record<string, Record<string, unknown>> }
    }
    return inventoryJson.target.hosts[hostKey]
  }

  it('uses ansible_ssh_pass (not a private key file) and never writes id_rsa for a password credential', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue(PASSWORD_CREDENTIAL),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(writtenFile('id_rsa')).toBeUndefined()
    const hostVars = inventoryHostVars(PASSWORD_CREDENTIAL.hostname)
    expect(hostVars.ansible_ssh_pass).toBe('s3cret-pw')
    expect(hostVars.ansible_ssh_private_key_file).toBeUndefined()
  })

  it('still writes id_rsa (0600) and sets ansible_ssh_private_key_file, with no ansible_ssh_pass, for a key credential', async () => {
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(writtenFile('id_rsa')).toBe(PRIVATE_KEY)
    const idRsaCall = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith('id_rsa'))
    expect(idRsaCall?.[2]).toEqual({ mode: 0o600 })
    const hostVars = inventoryHostVars(CREDENTIAL.hostname)
    expect(hostVars.ansible_ssh_private_key_file).toEqual(expect.stringContaining('id_rsa'))
    expect(hostVars.ansible_ssh_pass).toBeUndefined()
  })

  it('rejects a password credential with an empty password before any temp dir is created', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...PASSWORD_CREDENTIAL, privateKey: '' }),
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('privateKey')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it('rejects a credential with an unsupported authType before any temp dir is created', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({ ...CREDENTIAL, authType: 'kerberos' }),
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('authType')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it('combines password auth with a Tailscale ProxyCommand (ansible_ssh_pass set, no private key, ProxyCommand present)', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({
        ...PASSWORD_CREDENTIAL,
        connectionType: 'tailscale' as const,
        tailnetHostname: 'db-server-1.tailnet-abc.ts.net',
      }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    const hostVars = inventoryHostVars(PASSWORD_CREDENTIAL.hostname)
    expect(hostVars.ansible_ssh_pass).toBe('s3cret-pw')
    expect(hostVars.ansible_ssh_private_key_file).toBeUndefined()
    expect(String(hostVars.ansible_ssh_common_args)).toContain('ProxyCommand')
  })
})

describe('runServerSetup - server setup variables (project ANSIBLE# vars)', () => {
  it('fetches variables scoped to commandId/agentId and merges them into extra-vars.json', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({ variables: { DB_HOST: '10.0.0.5' }, secretNames: [] }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client, agentId: 'agent-9' })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(client.getServerSetupVariables).toHaveBeenCalledWith('cmd-1', 'agent-9')
    expect(JSON.parse(writtenFile('extra-vars.json') as string)).toEqual({ DB_HOST: '10.0.0.5' })
  })

  it('returns an error and never creates a temp dir when the variables fetch fails', async () => {
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

  it('rejects a project variable whose name collides with the internal sudo-probe register variable, before any temp dir is created (extra-vars always outrank a registered var in Ansible, which would silently corrupt the NOPASSWD precheck)', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { [SUDO_PROBE_REGISTER_VAR]: 'attacker-controlled-or-accidental-value' },
        secretNames: [],
      }),
    })
    const result = await runServerSetup(makePayload(), { commandId: 'cmd-1', client })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain(SUDO_PROBE_REGISTER_VAR)
      expect(result.error).toContain('reserved')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetup - secret redaction and no_log', () => {
  const SECRET_BODY = `
- name: Configure db password
  ansible.builtin.lineinfile:
    path: /etc/app.conf
    line: "password={{ DB_PASSWORD }}"
`

  it('annotates a secret-referencing task with no_log in the generated playbook', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_PASSWORD: 'sup3r-s3cr3t-value' },
        secretNames: ['DB_PASSWORD'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ body: SECRET_BODY }), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, ansibleJsonOutput([
      { name: 'precheck : Verify supported OS', skipped: true },
      { name: 'Configure db password', changed: true },
    ]))
    const result = await runPromise

    expect(result.success).toBe(true)
    const generatedYaml = writtenFile('generated-playbook.yml') as string
    expect(generatedYaml).toContain('no_log: true')
  })

  it('redacts a secret value that leaks into a step message via stdout', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_PASSWORD: 'sup3r-s3cr3t-value' },
        secretNames: ['DB_PASSWORD'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ body: SECRET_BODY }), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'Configure db password', failed: true, msg: 'leaked plaintext: sup3r-s3cr3t-value' }]),
      'fatal!',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(JSON.stringify(result.data)).not.toContain('sup3r-s3cr3t-value')
      expect(JSON.stringify(result.data)).toContain('***')
    }
  })

  it('redacts a secret value that leaks into stderr (surfaced in the top-level error)', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({
        variables: { DB_PASSWORD: 'sup3r-s3cr3t-value' },
        secretNames: ['DB_PASSWORD'],
      }),
    })
    const runPromise = runServerSetup(makePayload({ body: SECRET_BODY }), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'Configure db password', failed: true, msg: 'boom' }]),
      'fatal: password was sup3r-s3cr3t-value',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).not.toContain('sup3r-s3cr3t-value')
      expect(result.error).toContain('***')
    }
  })

  // Regression: the SSH password (credential.privateKey for authType:
  // 'password') never appears in secretNames (that only covers tenant
  // ANSIBLE# project variables), so it was previously excluded from the
  // belt-and-suspenders stdout/stderr redaction entirely — a leaked
  // ansible_ssh_pass value (e.g. via a task's fail_msg) would have surfaced
  // in plaintext in the top-level error.
  it('redacts the SSH password from a leaked message even though it is absent from secretNames', async () => {
    const client = makeClient({
      getServerSetupSshCredential: jest.fn().mockResolvedValue({
        ...CREDENTIAL,
        authType: 'password' as const,
        privateKey: 'sup3r-s3cr3t-ssh-password',
      }),
    })
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'Leak connection secret', failed: true, msg: 'boom' }]),
      'fatal: password was sup3r-s3cr3t-ssh-password',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).not.toContain('sup3r-s3cr3t-ssh-password')
      expect(result.error).toContain('***')
    }
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
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect(options as Record<string, unknown>).not.toHaveProperty('uid')
    expect(options as Record<string, unknown>).not.toHaveProperty('gid')
  })

  it('sets uid/gid on execFile options when the opt-in env vars are set', async () => {
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID = '1500'
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_GID = '1500'
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect((options as { uid?: number }).uid).toBe(1500)
    expect((options as { gid?: number }).gid).toBe(1500)
  })

  it('ignores a non-numeric uid override and omits the option entirely', async () => {
    process.env.AI_SUPPORT_AGENT_SERVER_SETUP_ANSIBLE_UID = 'not-a-number'
    const client = makeClient()
    const runPromise = runServerSetup(makePayload(), { commandId: 'cmd-1', client })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const [, , options] = mockExecFile.mock.calls[0]
    expect(options as Record<string, unknown>).not.toHaveProperty('uid')
  })
})

describe('fetchServerSetupVariables', () => {
  it("delegates to the client's getServerSetupVariables with the given commandId/agentId", async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockResolvedValue({ variables: { FOO: 'bar' }, secretNames: [] }),
    })
    const result = await fetchServerSetupVariables(client, 'cmd-1', 'agent-1')

    expect(result).toEqual({ variables: { FOO: 'bar' }, secretNames: [] })
    expect(client.getServerSetupVariables).toHaveBeenCalledWith('cmd-1', 'agent-1')
  })

  it('propagates a rejection from the client', async () => {
    const client = makeClient({
      getServerSetupVariables: jest.fn().mockRejectedValue(new Error('network error')),
    })
    await expect(fetchServerSetupVariables(client, 'cmd-1', 'agent-1')).rejects.toThrow('network error')
  })
})

describe('generatePlaybook', () => {
  it('always prepends the precheck task tagged "always"', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    expect(yaml).toContain('precheck : Verify supported OS')
    expect(yaml).toContain('tags: always')
  })

  // Regression: every bundled role that switches to an unprivileged
  // `become_user` (nvm/claude_cli/codex/ai_support_agent/database) fails with
  // "Failed to set permissions on the temporary files Ansible needs to create
  // when becoming an unprivileged user ... chmod: invalid operator ... found A"
  // unless `setfacl` (from the `acl` package) is available on the target. A
  // fresh Ubuntu host does not ship `acl`, and the runner sets no
  // pipelining/world-readable fallback, so the generated play MUST install
  // `acl` (as root, before the body) so the setfacl-based temp-file handoff
  // works for every subsequent become_user task, regardless of which roles the
  // recipe body includes.
  it('installs the `acl` package (as root) before the body tasks so become_user temp-file handoff works', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>

    const aclIndex = tasks.findIndex((t) => t.name === 'precheck : Ensure acl (setfacl) is installed')
    expect(aclIndex).toBeGreaterThanOrEqual(0)

    const aclTask = tasks[aclIndex]
    // apt install, name=acl, state=present. update_cache + cache_valid_time so
    // a role that already refreshed the cache in the same run (os_init/nvm)
    // isn't forced to `apt update` again.
    expect(aclTask['ansible.builtin.apt']).toEqual({
      name: 'acl',
      state: 'present',
      update_cache: true,
      cache_valid_time: 3600,
    })
    // Runs as root: it must inherit the play's become:true rather than carry
    // its own become key — the no-escalation precheck tasks set `become: false`,
    // so an absent become key here is what keeps this task at root (the level
    // the NOPASSWD-sudo assert above already verified is possible).
    expect(aclTask.become).toBeUndefined()
    expect(aclTask.tags).toBe('always')

    // Must run AFTER the OS precheck (so we never apt-install on an
    // unsupported OS) and BEFORE the first body task (so setfacl exists before
    // any body become_user step).
    const osPrecheckIndex = tasks.findIndex((t) => t.name === 'precheck : Verify supported OS')
    const bodyIndex = tasks.findIndex((t) => t.name === 'x')
    expect(osPrecheckIndex).toBeGreaterThanOrEqual(0)
    expect(aclIndex).toBeGreaterThan(osPrecheckIndex)
    expect(aclIndex).toBeLessThan(bodyIndex)
  })

  it('wraps the body tasks in a single play with fixed hosts/become, and disables the implicit gather_facts', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    expect(play.hosts).toBe('all')
    expect(play.become).toBe(true)
    // The implicit gather_facts task would run under become:true — which
    // fails outright (ansible.legacy.setup "interactive authentication is
    // required") on a host whose SSH user lacks NOPASSWD sudo. Facts are
    // gathered explicitly instead (see the system tasks below), so the play
    // itself must not gather facts implicitly.
    expect(play.gather_facts).toBe(false)
    const tasks = play.tasks as Array<Record<string, unknown>>
    // system tasks first (fact gather, then NOPASSWD sudo precheck, then OS
    // precheck, then the acl install), then the body task.
    expect(tasks[0].name).toBe('precheck : Gather facts (no privilege escalation)')
    expect(tasks[1].name).toBe('precheck : Probe passwordless sudo')
    expect(tasks[2].name).toBe('precheck : Verify passwordless sudo')
    expect(tasks[3].name).toBe('precheck : Verify supported OS')
    expect(tasks[4].name).toBe('precheck : Ensure acl (setfacl) is installed')
    expect(tasks[5].name).toBe('x')
  })

  it('gathers facts explicitly without privilege escalation (become:false), so gathering does not require NOPASSWD sudo', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>
    const gatherTask = tasks[0]
    expect(gatherTask['ansible.builtin.setup']).toBeDefined()
    expect(gatherTask.become).toBe(false)
    expect(gatherTask.tags).toBe('always')
  })

  it('probes passwordless sudo without privilege escalation and never fails the play by itself', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>
    const probeTask = tasks[1]
    expect(probeTask['ansible.builtin.command']).toEqual({ cmd: 'sudo -n true' })
    expect(probeTask.become).toBe(false)
    expect(probeTask.failed_when).toBe(false)
    expect(probeTask.changed_when).toBe(false)
    expect(probeTask.register).toBe(SUDO_PROBE_REGISTER_VAR)
    expect(probeTask.tags).toBe('always')
  })

  it('fails with a clear, actionable message when the passwordless-sudo probe reports a non-zero rc', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>
    const assertTask = tasks[2]
    const fail = assertTask['ansible.builtin.fail'] as { msg: string }
    expect(fail.msg).toContain('Passwordless (NOPASSWD) sudo is required')
    expect(fail.msg).toContain('password-based sudo')
    expect(assertTask.when).toBe(`${SUDO_PROBE_REGISTER_VAR}.rc | default(1) != 0`)
    expect(assertTask.become).toBe(false)
    expect(assertTask.tags).toBe('always')
  })

  it('produces valid, parseable YAML for an empty body', () => {
    const yaml = generatePlaybook([])
    const loaded = load(yaml) as unknown[]
    expect(Array.isArray(loaded)).toBe(true)
    const play = (loaded as Array<Record<string, unknown>>)[0]
    // 3 system precheck tasks (fact gather, sudo probe, sudo assert) + the OS
    // precheck + the acl install.
    expect((play.tasks as unknown[]).length).toBe(5)
  })

  it('allows Ubuntu 22.04, 24.04, and 26.04 in the OS precheck (fixed allowlist, not a general ">=22.04 LTS" rule)', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>
    const osPrecheckTask = tasks[3]
    expect(osPrecheckTask.name).toBe('precheck : Verify supported OS')
    const when = osPrecheckTask.when as string
    expect(when).toContain("not in ['22.04', '24.04', '26.04']")
  })

  it('still rejects an Ubuntu version outside the fixed allowlist (e.g. 27.04) via the OS precheck condition', () => {
    const yaml = generatePlaybook([{ name: 'x', 'ansible.builtin.debug': { msg: 'hi' } }])
    const play = (load(yaml) as Array<Record<string, unknown>>)[0]
    const tasks = play.tasks as Array<Record<string, unknown>>
    const osPrecheckTask = tasks[3]
    const when = osPrecheckTask.when as string
    // '27.04' must not appear among the allowed values.
    expect(when).not.toContain("'27.04'")
    const fail = osPrecheckTask['ansible.builtin.fail'] as { msg: string }
    expect(fail.msg).toContain('Only Ubuntu 22.04/24.04/26.04 LTS are supported')
  })

  it('keeps the unused static ansible/playbook.yml\'s OS precheck in sync with generatePlaybook()\'s (a prior fix — PR #605 — let these drift once already)', () => {
    const path = require('path') as typeof import('path')
    const staticPlaybookYaml = actualFs.readFileSync(
      path.join(__dirname, '../../ansible/playbook.yml'),
      'utf-8',
    )
    const staticPlay = (load(staticPlaybookYaml) as Array<Record<string, unknown>>)[0]
    const staticOsPrecheck = (staticPlay.tasks as Array<Record<string, unknown>>).find(
      (t) => t.name === 'precheck : Verify supported OS',
    )
    expect(staticOsPrecheck).toBeDefined()

    const generatedYaml = generatePlaybook([])
    const generatedPlay = (load(generatedYaml) as Array<Record<string, unknown>>)[0]
    const generatedOsPrecheck = (generatedPlay.tasks as Array<Record<string, unknown>>).find(
      (t) => t.name === 'precheck : Verify supported OS',
    )
    expect(generatedOsPrecheck).toBeDefined()

    expect((staticOsPrecheck as Record<string, unknown>)['ansible.builtin.fail']).toEqual(
      (generatedOsPrecheck as Record<string, unknown>)['ansible.builtin.fail'],
    )
    expect((staticOsPrecheck as Record<string, unknown>).when).toBe(
      (generatedOsPrecheck as Record<string, unknown>).when,
    )
    expect((staticOsPrecheck as Record<string, unknown>).tags).toBe(
      (generatedOsPrecheck as Record<string, unknown>).tags,
    )
  })
})

describe('parseAnsibleOutput', () => {
  it('produces one result per task (ok/changed/skipped/failed)', () => {
    const { taskResults, outputUnparseable } = parseAnsibleOutput(ansibleJsonOutput([
      { name: 'a', changed: true },
      { name: 'b', skipped: true },
      { name: 'c', failed: true, msg: 'boom' },
    ]))
    expect(outputUnparseable).toBe(false)
    expect(taskResults).toEqual([
      { name: 'a', status: 'ok', changed: true, message: 'a completed' },
      { name: 'b', status: 'skipped', changed: false, message: 'b skipped' },
      { name: 'c', status: 'failed', changed: false, message: 'boom' },
    ])
  })

  it('folds unreachable into failed with a default message when no msg', () => {
    const { taskResults } = parseAnsibleOutput(JSON.stringify({
      plays: [{ tasks: [{ task: { name: 'Gathering Facts' }, hosts: { h: { unreachable: true, failed: true } } }] }] }))
    expect(taskResults[0]).toEqual({
      name: 'Gathering Facts',
      status: 'failed',
      changed: false,
      message: 'host unreachable',
    })
  })

  it('falls back to a generic "<name> failed" message for a failed task without msg', () => {
    const { taskResults } = parseAnsibleOutput(ansibleJsonOutput([{ name: 'setup step', failed: true }]))
    expect(taskResults[0].message).toBe('setup step failed')
  })

  it('names an unnamed task "task"', () => {
    const { taskResults } = parseAnsibleOutput(JSON.stringify({
      plays: [{ tasks: [{ hosts: { h: { changed: true } } }] }] }))
    expect(taskResults[0].name).toBe('task')
  })

  it('skips a task with neither a name nor host results', () => {
    const { taskResults } = parseAnsibleOutput(JSON.stringify({ plays: [{ tasks: [{}] }] }))
    expect(taskResults).toEqual([])
  })

  it('flags empty output as unparseable', () => {
    expect(parseAnsibleOutput('').outputUnparseable).toBe(true)
    expect(parseAnsibleOutput('   ').outputUnparseable).toBe(true)
  })

  it('flags non-JSON output as unparseable', () => {
    expect(parseAnsibleOutput('not json {{{').outputUnparseable).toBe(true)
  })
})

describe('redactSecretValues', () => {
  it('replaces every occurrence of each non-empty secret value with ***', () => {
    expect(redactSecretValues('a=SECRET and b=SECRET', ['SECRET'])).toBe('a=*** and b=***')
  })

  it('skips empty-string secret values (would corrupt the text)', () => {
    expect(redactSecretValues('hello', [''])).toBe('hello')
  })

  it('returns the text unchanged when there are no secrets', () => {
    expect(redactSecretValues('hello', [])).toBe('hello')
  })
})

// cleanupStaleServerSetupDirs の挙動を unit テストする。実ファイル操作は fs を
// spy する形ではなく、実ディレクトリを作って検証する（TerminalSession.
// cleanupStaleSandboxes と同じ設計）。ただし実行中の常駐エージェントが同一
// ホスト上で保持している本物の /tmp エントリを誤って巻き込まないよう、
// os.tmpdir() 配下に隔離用の scratch ディレクトリを都度作成し、baseDir引数
// でそこだけを対象にする（本物の /tmp は一切走査しない）。
const SERVER_SETUP_TMP_PREFIX = 'ai-support-agent-server-setup-'

describe('cleanupStaleServerSetupDirs', () => {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')

  let baseDir: string

  beforeEach(() => {
    baseDir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-stale-server-setup-test-'))
  })

  afterEach(() => {
    actualFs.rmSync(baseDir, { recursive: true, force: true })
  })

  function makeStaleDir(name: string, mtimeMs: number): string {
    const fullPath = path.join(baseDir, name)
    actualFs.mkdirSync(fullPath, { recursive: true })
    // mtime を過去にする
    const t = new Date(mtimeMs)
    actualFs.utimesSync(fullPath, t, t)
    return fullPath
  }

  it('24 時間以上古いものを削除する', () => {
    const oldPath = makeStaleDir(
      SERVER_SETUP_TMP_PREFIX + 'jest-old-' + Math.random().toString(36).slice(2),
      Date.now() - 25 * 60 * 60 * 1000,
    )

    const removed = cleanupStaleServerSetupDirs(24 * 60 * 60 * 1000, baseDir)
    expect(removed).toBe(1)
    expect(actualFs.existsSync(oldPath)).toBe(false)
  })

  it('新しいもの (24 時間以内) は残す', () => {
    const freshPath = makeStaleDir(
      SERVER_SETUP_TMP_PREFIX + 'jest-fresh-' + Math.random().toString(36).slice(2),
      Date.now() - 1000, // 1 秒前
    )

    cleanupStaleServerSetupDirs(24 * 60 * 60 * 1000, baseDir)
    expect(actualFs.existsSync(freshPath)).toBe(true)
  })

  it('maxAgeMs=0 で全削除する', () => {
    const freshPath = makeStaleDir(
      SERVER_SETUP_TMP_PREFIX + 'jest-all-' + Math.random().toString(36).slice(2),
      Date.now() - 1000,
    )

    const removed = cleanupStaleServerSetupDirs(0, baseDir)
    expect(removed).toBe(1)
    expect(actualFs.existsSync(freshPath)).toBe(false)
  })

  it('プレフィックスが一致しないエントリには触れない', () => {
    const unrelatedPath = makeStaleDir(
      'unrelated-app-dir-' + Math.random().toString(36).slice(2),
      Date.now() - 25 * 60 * 60 * 1000,
    )

    const removed = cleanupStaleServerSetupDirs(24 * 60 * 60 * 1000, baseDir)
    expect(removed).toBe(0)
    expect(actualFs.existsSync(unrelatedPath)).toBe(true)
  })

  it('baseDir の readdirSync が失敗したら 0 を返す', () => {
    const nonexistentDir = path.join(baseDir, 'does-not-exist')
    expect(cleanupStaleServerSetupDirs(24 * 60 * 60 * 1000, nonexistentDir)).toBe(0)
  })

  it('個別の削除失敗はログに記録し、他のディレクトリの削除は継続する', () => {
    const badPath = makeStaleDir(
      SERVER_SETUP_TMP_PREFIX + 'jest-bad-' + Math.random().toString(36).slice(2),
      Date.now() - 25 * 60 * 60 * 1000,
    )
    const goodPath = makeStaleDir(
      SERVER_SETUP_TMP_PREFIX + 'jest-good-' + Math.random().toString(36).slice(2),
      Date.now() - 25 * 60 * 60 * 1000,
    )

    mockRmSync.mockImplementation((...args: Parameters<typeof actualFs.rmSync>) => {
      if (args[0] === badPath) {
        throw new Error('EACCES: permission denied')
      }
      return actualFs.rmSync(...args)
    })

    const removed = cleanupStaleServerSetupDirs(24 * 60 * 60 * 1000, baseDir)

    expect(removed).toBe(1)
    expect(actualFs.existsSync(badPath)).toBe(true)
    expect(actualFs.existsSync(goodPath)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EACCES: permission denied'),
    )
  })
})
