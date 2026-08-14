/**
 * Tests for src/server-setup/server-setup-local-run.ts and the extracted core
 * `executeServerSetupAnsible` (src/server-setup/server-setup-runner.ts).
 *
 * The local-run path deliberately reuses the *real* production core
 * (`executeServerSetupAnsible`) — same play generation, same authoritative task
 * guard, same `ansible-playbook` invocation — with only the external boundaries
 * mocked: `child_process.execFile` (no real ansible spawn), `fs` (temp dir /
 * inputs), and the known_hosts store. There is no ApiClient / dispatch / KMS in
 * this path at all, which these tests assert by exercising it end-to-end without
 * any API object.
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

// Per-test virtual input files, keyed by path suffix; unmatched reads fall
// through to the real fs (nothing else reads via readFileSync during a run).
let virtualFiles: Record<string, string> = {}
const virtualReadFileSync = (...args: Parameters<typeof actualFs.readFileSync>): string | Buffer => {
  const p = String(args[0])
  for (const [suffix, content] of Object.entries(virtualFiles)) {
    if (p.endsWith(suffix)) return content
  }
  return actualFs.readFileSync(...args)
}
const mockReadFileSync = jest.fn(virtualReadFileSync)

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    mkdtempSync: (...args: unknown[]) => mockMkdtempSync(...(args as Parameters<typeof actual.mkdtempSync>)),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...(args as Parameters<typeof actual.writeFileSync>)),
    rmSync: (...args: unknown[]) => mockRmSync(...(args as Parameters<typeof actual.rmSync>)),
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as Parameters<typeof actual.existsSync>)),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...(args as Parameters<typeof actual.readFileSync>)),
  }
})

const KNOWN_HOSTS_PATH = '/fake-config-dir/server-setup/known-hosts/local__local-host'
const mockResolveKnownHostsPath = jest.fn().mockReturnValue(KNOWN_HOSTS_PATH)
jest.mock('../../src/utils/known-hosts-store', () => ({
  resolveKnownHostsPath: (...args: unknown[]) => mockResolveKnownHostsPath(...args),
}))

const mockStageSharedFiles = jest.fn().mockResolvedValue(undefined)
jest.mock('../../src/server-setup/shared-file-staging', () => ({
  ...jest.requireActual('../../src/server-setup/shared-file-staging'),
  stageSharedFiles: (...args: unknown[]) => mockStageSharedFiles(...args),
}))

import { load } from 'js-yaml'

import {
  buildLocalCredential,
  formatLocalRunResult,
  parseBodyTasks,
  parseExtraVars,
  parseLocalRunArgs,
  runServerSetupLocalRun,
  warnIfSecretsUnmasked,
  type ServerSetupLocalRunOptions,
} from '../../src/server-setup/server-setup-local-run'
import { executeServerSetupAnsible, SUDO_PROBE_REGISTER_VAR } from '../../src/server-setup/server-setup-runner'
import type { SshExecCredential } from '../../src/types'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n'

// include_role built-in steps — allowed in both ecs and resident modes.
const VALID_BODY = `
- name: "os_init : Update apt cache"
  include_role:
    name: os_init
- name: "docker : Install Docker Engine and compose plugin"
  include_role:
    name: docker
`

// include_role to a role NOT in the allowlist — rejected by the real guard.
const REJECTED_BODY = `
- name: "evil"
  include_role:
    name: not_a_real_role
`

function baseOptions(overrides: Partial<ServerSetupLocalRunOptions> = {}): ServerSetupLocalRunOptions {
  return {
    bodyPath: '/tmp/recipe.yml',
    hostname: '203.0.113.10',
    username: 'ubuntu',
    privateKeyPath: '/tmp/key.pem',
    ...overrides,
  }
}

function ansibleJsonOutput(
  tasks: Array<{ name: string; changed?: boolean; failed?: boolean; skipped?: boolean; msg?: string }>,
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
              ...(t.msg !== undefined && { msg: t.msg }),
            },
          },
        })),
      },
    ],
  })
}

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

async function flushUntilExecFileCalled(): Promise<void> {
  for (let i = 0; i < 50 && mockExecFile.mock.calls.length === 0; i++) {
    await Promise.resolve()
  }
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
  mockReadFileSync.mockImplementation(virtualReadFileSync)
  mockResolveKnownHostsPath.mockReturnValue(KNOWN_HOSTS_PATH)
  virtualFiles = {
    'recipe.yml': VALID_BODY,
    'key.pem': KEY,
    'vars.json': JSON.stringify({ FOO: 'bar' }),
  }
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseBodyTasks', () => {
  it('returns the parsed task list for a top-level YAML array', () => {
    const tasks = parseBodyTasks(VALID_BODY)
    expect(tasks).toHaveLength(2)
  })

  it('throws when the YAML is not a top-level list', () => {
    expect(() => parseBodyTasks('foo: bar')).toThrow('top-level YAML list')
  })

  it('mentions null explicitly for a YAML null document', () => {
    expect(() => parseBodyTasks('null')).toThrow('got null')
  })

  it('reports the actual type for a non-null scalar (empty document is undefined)', () => {
    expect(() => parseBodyTasks('')).toThrow('got undefined')
  })

  it('throws a clear error on invalid YAML', () => {
    expect(() => parseBodyTasks('- a\n  b: [')).toThrow('not valid YAML')
  })
})

describe('parseExtraVars', () => {
  it('parses a flat object of string values', () => {
    expect(parseExtraVars('{"A":"1","B":"2"}')).toEqual({ A: '1', B: '2' })
  })

  it('throws on invalid JSON', () => {
    expect(() => parseExtraVars('{bad')).toThrow('not valid JSON')
  })

  it('throws when the top-level value is an array', () => {
    expect(() => parseExtraVars('["a"]')).toThrow('object of string values')
  })

  it('throws when the top-level value is null', () => {
    expect(() => parseExtraVars('null')).toThrow('object of string values')
  })

  it('throws when a value is not a string', () => {
    expect(() => parseExtraVars('{"A":1}')).toThrow("value for 'A' must be a string")
  })
})

describe('buildLocalCredential', () => {
  it('builds a key-auth credential with defaults (port 22, privateKey)', () => {
    const cred = buildLocalCredential(baseOptions())
    expect(cred).toMatchObject({
      hostId: 'local-host',
      hostname: '203.0.113.10',
      port: 22,
      username: 'ubuntu',
      authType: 'privateKey',
      privateKey: KEY,
    })
  })

  it('supports password auth (privateKey field holds the password read from the key file)', () => {
    virtualFiles['pw.txt'] = 'pw'
    const cred = buildLocalCredential(baseOptions({ authType: 'password', privateKeyPath: '/tmp/pw.txt' }))
    expect(cred.authType).toBe('password')
    expect(cred.privateKey).toBe('pw')
  })

  it('honors an explicit sshHostId and port', () => {
    const cred = buildLocalCredential(baseOptions({ sshHostId: 'my-host', port: 2222 }))
    expect(cred.hostId).toBe('my-host')
    expect(cred.port).toBe(2222)
  })

  it('throws when hostname is missing', () => {
    expect(() => buildLocalCredential(baseOptions({ hostname: '' }))).toThrow('hostname is required')
  })

  it('throws when username is missing', () => {
    expect(() => buildLocalCredential(baseOptions({ username: '' }))).toThrow('username is required')
  })

  it('throws on an unsupported auth type (no silent fallback to key path)', () => {
    expect(() => buildLocalCredential(baseOptions({ authType: 'kerberos' }))).toThrow('Unsupported SSH auth type')
  })

  it('throws when no key file path is provided (no inline fallback)', () => {
    expect(() => buildLocalCredential(baseOptions({ privateKeyPath: undefined }))).toThrow(
      'SSH private key / password file path is required (--key',
    )
  })

  it('throws when the key file is empty', () => {
    virtualFiles['key.pem'] = ''
    expect(() => buildLocalCredential(baseOptions())).toThrow("file '/tmp/key.pem' is empty")
  })

  it('throws a path-qualified error when the key file cannot be read', () => {
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    expect(() => buildLocalCredential(baseOptions())).toThrow("Failed to read SSH key/password file '/tmp/key.pem'")
  })
})

describe('parseLocalRunArgs', () => {
  it('maps every flag to its option', () => {
    const opts = parseLocalRunArgs([
      '--body', 'b.yml',
      '--extra-vars', 'v.json',
      '--secret-names', 'A, B ,,C',
      '--host', 'h',
      '--user', 'u',
      '--port', '2222',
      '--auth-type', 'password',
      '--key', 'k',
      '--ssh-host-id', 'host-x',
      '--strict',
    ])
    expect(opts).toEqual({
      bodyPath: 'b.yml',
      extraVarsPath: 'v.json',
      secretNames: ['A', 'B', 'C'],
      hostname: 'h',
      username: 'u',
      port: 2222,
      authType: 'password',
      privateKeyPath: 'k',
      sshHostId: 'host-x',
      strict: true,
    })
  })

  it('throws on an unknown flag', () => {
    expect(() => parseLocalRunArgs(['--nope', 'x'])).toThrow('Unknown argument: --nope')
  })

  it('rejects the removed --key-inline flag as unknown (secret must come from a file, never argv)', () => {
    expect(() => parseLocalRunArgs(['--key-inline', 'SECRET-MATERIAL'])).toThrow(
      'Unknown argument: --key-inline',
    )
  })

  it('throws when a flag is missing its value', () => {
    expect(() => parseLocalRunArgs(['--body'])).toThrow('Missing value for --body')
  })
})

describe('formatLocalRunResult', () => {
  it('renders task results and a SUCCESS line on success', () => {
    const text = formatLocalRunResult({
      success: true,
      data: { stepResults: [{ name: 'os_init', status: 'ok', changed: true, message: 'done' }] },
    })
    expect(text).toContain('Task results:')
    expect(text).toContain('[ok] os_init (changed) — done')
    expect(text).toContain('SUCCESS')
  })

  it('renders a FAILED line with the error on failure', () => {
    const text = formatLocalRunResult({ success: false, error: 'boom' })
    expect(text).toContain('FAILED — boom')
  })

  it('omits the task-results block when there are none', () => {
    const text = formatLocalRunResult({ success: true, data: {} })
    expect(text).not.toContain('Task results:')
    expect(text).toContain('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// runServerSetupLocalRun — end-to-end through the real production core
// ---------------------------------------------------------------------------

describe('runServerSetupLocalRun - success path', () => {
  it('runs ansible-playbook via the real core and reports per-task results (default resident mode)', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions())
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as { stepResults: Array<{ name: string; status: string }> }
      expect(data.stepResults.map((s) => s.name)).toContain('os_init : Update apt cache')
    }
    // Real ansible invocation reached (no ApiClient anywhere in this path).
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('local', 'local-host')
    // Temp dir (private key holder) removed on the success path.
    expect(mockRmSync).toHaveBeenCalled()
  })

  it('writes the SSH key file content read from disk into the generated inventory (privateKey path)', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions())
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const idRsa = writtenFile('id_rsa')
    expect(idRsa).toContain('FAKE-KEY-MATERIAL')
  })

  it('passes extra-vars read from disk through to extra-vars.json', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions({ extraVarsPath: '/tmp/vars.json' }))
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const extraVars = writtenFile('extra-vars.json')
    expect(extraVars).toBeDefined()
    expect(JSON.parse(extraVars as string)).toEqual({ FOO: 'bar' })
  })

  it('defaults extra-vars.json to {} when no extra-vars file is given', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions())
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    expect(JSON.parse(writtenFile('extra-vars.json') as string)).toEqual({})
  })

  it('redacts secret variable values (from secretNames) out of the ansible output', async () => {
    virtualFiles['vars.json'] = JSON.stringify({ TOKEN: 'super-secret-value' })
    const runPromise = runServerSetupLocalRun(
      baseOptions({ extraVarsPath: '/tmp/vars.json', secretNames: ['TOKEN'] }),
    )
    await flushUntilExecFileCalled()
    // A failed task surfaces its `msg` in the reported result, and a non-zero
    // exit surfaces stderr — both must be redacted before the caller sees them.
    resolveExecFile(
      2,
      ansibleJsonOutput([{ name: 'leaky', failed: true, msg: 'saw super-secret-value here' }]),
      'stderr leaked super-secret-value',
    )
    const result = await runPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).not.toContain('super-secret-value')
      expect(result.error).toContain('***')
      const data = result.data as { stepResults: Array<{ message: string }> }
      const joined = data.stepResults.map((s) => s.message).join(' ')
      expect(joined).not.toContain('super-secret-value')
      expect(joined).toContain('***')
    }
  })

  it('validates under the strict ecs allowlist when strict is set', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions({ strict: true }))
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise
    expect(result.success).toBe(true)
    // Playbook arg order/shape is asserted below via the generated playbook.
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('generates a playbook whose enclosing play is agent-fixed (hosts:all, become:true)', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions())
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise

    const playbook = writtenFile('generated-playbook.yml')
    expect(playbook).toBeDefined()
    const parsed = load(playbook as string) as Array<{ hosts: string; become: boolean }>
    expect(parsed[0].hosts).toBe('all')
    expect(parsed[0].become).toBe(true)
  })
})

describe('runServerSetupLocalRun - guard is never bypassed', () => {
  it('rejects a body whose include_role targets a non-allowlisted role, before spawning ansible', async () => {
    virtualFiles['recipe.yml'] = REJECTED_BODY
    const result = await runServerSetupLocalRun(baseOptions())

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('rejected at execution time')
    }
    // Guard rejection must happen without ever invoking ansible-playbook.
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetupLocalRun - input errors (no fallback)', () => {
  it('returns an error when the body path is empty', async () => {
    const result = await runServerSetupLocalRun(baseOptions({ bodyPath: '' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('recipe body file path is required')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error when the body file cannot be read', async () => {
    delete virtualFiles['recipe.yml']
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    const result = await runServerSetupLocalRun(baseOptions())
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain("Failed to read recipe body file '/tmp/recipe.yml'")
  })

  it('returns an error when the body YAML is not a top-level list', async () => {
    virtualFiles['recipe.yml'] = 'not: a-list'
    const result = await runServerSetupLocalRun(baseOptions())
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('top-level YAML list')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error when the extra-vars JSON is malformed', async () => {
    virtualFiles['vars.json'] = '{bad json'
    const result = await runServerSetupLocalRun(baseOptions({ extraVarsPath: '/tmp/vars.json' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('not valid JSON')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error when connection info (key material) is missing', async () => {
    const result = await runServerSetupLocalRun(baseOptions({ privateKeyPath: undefined }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('SSH private key / password file path is required')
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runServerSetupLocalRun — production-parity validation (credential guard,
// reserved variable, known_hosts, secret-masking warning)
// ---------------------------------------------------------------------------

describe('runServerSetupLocalRun - credential validation (production validateSshCredential)', () => {
  it.each([
    ['NaN (--port 22x)', Number('22x')],
    ['zero', 0],
    ['above the TCP range', 70000],
    ['non-integer', 22.5],
  ])('rejects an invalid port: %s, before spawning ansible', async (_label, port) => {
    const result = await runServerSetupLocalRun(baseOptions({ port }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('port')
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })

  it('rejects a hostname containing whitespace (inventory-injection guard)', async () => {
    const result = await runServerSetupLocalRun(baseOptions({ hostname: 'evil host' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('hostname')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('rejects a username containing whitespace / disallowed characters', async () => {
    const result = await runServerSetupLocalRun(baseOptions({ username: 'root ansible_become=true' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('username')
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('runServerSetupLocalRun - reserved variable name (SUDO_PROBE_REGISTER_VAR)', () => {
  it('rejects an extra-var whose name collides with the internal sudo-probe register var, before spawning ansible', async () => {
    virtualFiles['vars.json'] = JSON.stringify({ [SUDO_PROBE_REGISTER_VAR]: 'x' })
    const result = await runServerSetupLocalRun(baseOptions({ extraVarsPath: '/tmp/vars.json' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain(SUDO_PROBE_REGISTER_VAR)
      expect(result.error).toContain('reserved')
    }
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(mockMkdtempSync).not.toHaveBeenCalled()
  })
})

describe('runServerSetupLocalRun - known_hosts resolution failure (via the core)', () => {
  it('returns an error and never creates a temp dir when known_hosts cannot be resolved', async () => {
    mockResolveKnownHostsPath.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    const result = await runServerSetupLocalRun(baseOptions())
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Failed to resolve known_hosts file')
      expect(result.error).toContain('EACCES: permission denied')
    }
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('warnIfSecretsUnmasked', () => {
  let errSpy: jest.SpyInstance

  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  it('warns when extra-vars are non-empty but no secret names were given', () => {
    warnIfSecretsUnmasked({ FOO: 'bar' }, [])
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0][0])).toContain('--secret-names')
  })

  it('does not warn when secret names are provided', () => {
    warnIfSecretsUnmasked({ FOO: 'bar' }, ['FOO'])
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('does not warn when there are no extra-vars', () => {
    warnIfSecretsUnmasked({}, [])
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('is triggered by a full local run with extra-vars and no --secret-names', async () => {
    const runPromise = runServerSetupLocalRun(baseOptions({ extraVarsPath: '/tmp/vars.json' }))
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise
    expect(result.success).toBe(true)
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0][0])).toContain('--secret-names')
  })

  it('is NOT triggered by a full local run when --secret-names is provided', async () => {
    const runPromise = runServerSetupLocalRun(
      baseOptions({ extraVarsPath: '/tmp/vars.json', secretNames: ['FOO'] }),
    )
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    await runPromise
    expect(errSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// executeServerSetupAnsible — the extracted production core, directly
// ---------------------------------------------------------------------------

describe('executeServerSetupAnsible - extracted core', () => {
  const credential: SshExecCredential = {
    hostId: 'host-1',
    hostname: '203.0.113.10',
    port: 22,
    username: 'ubuntu',
    authType: 'privateKey',
    privateKey: KEY,
  }

  it('runs the playbook and reports success given a fully-resolved input', async () => {
    const runPromise = executeServerSetupAnsible({
      executionId: 'exec-direct',
      body: VALID_BODY,
      mode: 'resident',
      credential,
      variables: {},
      secretNames: [],
      tenantCode: 'local',
      sshHostId: 'host-1',
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(mockRmSync).toHaveBeenCalled()
    // The core (not the caller) resolves known_hosts from tenantCode + sshHostId.
    expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('local', 'host-1')
  })

  describe('共有ファイルの配布（shared_file ロール）', () => {
    const SHARED_FILE_BODY = `
- name: place cert
  include_role:
    name: shared_file
  vars:
    shared_file_src: certs/server.pem
    shared_file_dest: /etc/ssl/app/server.pem
`

    const fakeClient = () => ({}) as never

    it('shared_file を使う body では、実行前にステージングを行う', async () => {
      const runPromise = executeServerSetupAnsible({
        executionId: 'exec-shared',
        body: SHARED_FILE_BODY,
        mode: 'resident',
        credential,
        variables: {},
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
        client: fakeClient(),
      })
      await flushUntilExecFileCalled()
      resolveExecFile(0, defaultOutput())
      await runPromise

      expect(mockStageSharedFiles).toHaveBeenCalledWith(
        expect.objectContaining({ sources: ['certs/server.pem'] }),
      )
    })

    it('ステージング先を extra-vars でロールへ渡す', async () => {
      const runPromise = executeServerSetupAnsible({
        executionId: 'exec-shared',
        body: SHARED_FILE_BODY,
        mode: 'resident',
        credential,
        variables: {},
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
        client: fakeClient(),
      })
      await flushUntilExecFileCalled()
      resolveExecFile(0, defaultOutput())
      await runPromise

      const extraVarsWrite = mockWriteFileSync.mock.calls.find((call) =>
        String(call[0]).endsWith('extra-vars.json'),
      )
      expect(extraVarsWrite).toBeDefined()
      const extraVars = JSON.parse(String(extraVarsWrite![1])) as Record<string, string>
      expect(extraVars.shared_file_staging_dir).toEqual(expect.any(String))
      expect(extraVars.shared_file_staging_dir.length).toBeGreaterThan(0)
    })

    it('テナント変数はステージング先の extra-var を上書きできない', async () => {
      const runPromise = executeServerSetupAnsible({
        executionId: 'exec-shared',
        body: SHARED_FILE_BODY,
        mode: 'resident',
        credential,
        // レシピ作成者が同名の ANSIBLE# 変数を作っても、配布元を差し替えられては困る。
        variables: { shared_file_staging_dir: '/etc' },
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
        client: fakeClient(),
      })
      await flushUntilExecFileCalled()
      resolveExecFile(0, defaultOutput())
      await runPromise

      const extraVarsWrite = mockWriteFileSync.mock.calls.find((call) =>
        String(call[0]).endsWith('extra-vars.json'),
      )
      const extraVars = JSON.parse(String(extraVarsWrite![1])) as Record<string, string>
      expect(extraVars.shared_file_staging_dir).not.toBe('/etc')
    })

    it('API クライアントが無い経路で shared_file を使うと、ansible を起動せず失敗させる', async () => {
      // ローカル実行（開発用）には共有ファイルを取り寄せる手段が無い。黙って
      // 素通りさせると「ファイルが無い」という分かりにくい失敗になる。
      const result = await executeServerSetupAnsible({
        executionId: 'exec-shared',
        body: SHARED_FILE_BODY,
        mode: 'resident',
        credential,
        variables: {},
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
      })

      expect(result.success).toBe(false)
      expect(String(result.error)).toMatch(/shared file/i)
      expect(mockStageSharedFiles).not.toHaveBeenCalled()
    })

    it('ステージングに失敗したら、ansible を起動せず失敗させる', async () => {
      mockStageSharedFiles.mockRejectedValueOnce(new Error('boom: quota exceeded'))

      const result = await executeServerSetupAnsible({
        executionId: 'exec-shared',
        body: SHARED_FILE_BODY,
        mode: 'resident',
        credential,
        variables: {},
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
        client: fakeClient(),
      })

      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('boom: quota exceeded')
    })

    it('shared_file を使わない body ではステージングを行わない', async () => {
      const runPromise = executeServerSetupAnsible({
        executionId: 'exec-plain',
        body: VALID_BODY,
        mode: 'resident',
        credential,
        variables: {},
        secretNames: [],
        tenantCode: 'local',
        sshHostId: 'host-1',
        client: fakeClient(),
      })
      await flushUntilExecFileCalled()
      resolveExecFile(0, defaultOutput())
      await runPromise

      expect(mockStageSharedFiles).not.toHaveBeenCalled()
      const extraVarsWrite = mockWriteFileSync.mock.calls.find((call) =>
        String(call[0]).endsWith('extra-vars.json'),
      )
      const extraVars = JSON.parse(String(extraVarsWrite![1])) as Record<string, string>
      expect(extraVars.shared_file_staging_dir).toBeUndefined()
    })
  })

  it('returns an error and never spawns ansible when the roles directory is missing', async () => {
    mockExistsSync.mockReturnValueOnce(false)
    const result = await executeServerSetupAnsible({
      executionId: 'exec-direct',
      body: VALID_BODY,
      mode: 'resident',
      credential,
      variables: {},
      secretNames: [],
      tenantCode: 'local',
      sshHostId: 'host-1',
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Ansible roles directory not found')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('returns an error and never creates a temp dir when known_hosts resolution fails', async () => {
    mockResolveKnownHostsPath.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    const result = await executeServerSetupAnsible({
      executionId: 'exec-direct',
      body: VALID_BODY,
      mode: 'resident',
      credential,
      variables: {},
      secretNames: [],
      tenantCode: 'local',
      sshHostId: 'host-1',
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Failed to resolve known_hosts file')
    expect(mockMkdtempSync).not.toHaveBeenCalled()
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('does not write an id_rsa key file for password auth (password goes to the inventory instead)', async () => {
    const runPromise = executeServerSetupAnsible({
      executionId: 'exec-direct',
      body: VALID_BODY,
      mode: 'resident',
      credential: { ...credential, authType: 'password', privateKey: 'the-password' },
      variables: {},
      secretNames: [],
      tenantCode: 'local',
      sshHostId: 'host-1',
    })
    await flushUntilExecFileCalled()
    resolveExecFile(0, defaultOutput())
    const result = await runPromise

    expect(result.success).toBe(true)
    expect(writtenFile('id_rsa')).toBeUndefined()
    const inventory = writtenFile('inventory.yml')
    expect(JSON.parse(inventory as string).target.hosts['203.0.113.10'].ansible_ssh_pass).toBe('the-password')
  })
})
