/**
 * Dispatch tests for the `readonly_diagnostic` command handler in
 * src/commands/index.ts. The catalog itself is covered by
 * readonly-diagnostic-catalog.spec.ts; SSH execution by ssh-executor.spec.ts.
 */

const mockLogger = {
  info: jest.fn(),
  success: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}
jest.mock('../../src/logger', () => ({ logger: mockLogger }))

const mockExecuteSshCommand = jest.fn()
const mockExecuteSshCommandStreaming = jest.fn()
jest.mock('../../src/commands/ssh-executor', () => ({
  executeSshCommand: (...args: unknown[]) => mockExecuteSshCommand(...args),
  executeSshCommandStreaming: (...args: unknown[]) => mockExecuteSshCommandStreaming(...args),
}))

const mockValidateCommand = jest.fn()
jest.mock('../../src/security', () => {
  const actual = jest.requireActual('../../src/security')
  return {
    ...actual,
    validateCommand: (command: string) => mockValidateCommand(command),
  }
})

// Isolate the persistent config dir (server-setup known_hosts files live under
// it) the same way __tests__/utils/known-hosts-store.spec.ts does.
jest.mock('../../src/constants', () => {
  const actual = jest.requireActual('../../src/constants')
  return { ...actual, CONFIG_DIR: '.ai-support-agent-test-readonly-diag-' + process.pid }
})
jest.mock('os', () => {
  const originalOs = jest.requireActual('os')
  return { ...originalOs, homedir: () => require('os').tmpdir() }
})

import { createHash, createHmac, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { executeCommand } from '../../src/commands'
import type { ApiClient } from '../../src/api-client'
import type { ReadonlyDiagnosticPayload } from '../../src/types'
import { knownHostsDir } from '../../src/utils/known-hosts-store'

const TEST_CONFIG_DIR = path.join(os.tmpdir(), '.ai-support-agent-test-readonly-diag-' + process.pid)

const SECRET = 'SECRET-PRIVATE-KEY-MATERIAL'
const API_FINGERPRINT = `SHA256:${createHash('sha256').update('api-pinned-key').digest('base64').replace(/=+$/, '')}`
const CREDENTIAL = {
  hostId: 'asset-1',
  hostname: 'db1.internal',
  port: 22,
  username: 'readonly',
  authType: 'private_key',
  privateKey: SECRET,
  hostKeyFingerprint: API_FINGERPRINT,
}

const mockGetCredential = jest.fn()
const CLIENT = {
  getReadonlyDiagnosticCredential: mockGetCredential,
  getTenantCode: () => '00000009',
} as unknown as ApiClient
const OPTS = { client: CLIENT, commandId: 'cmd-1', agentId: 'agent-1' }

function payload(overrides: Partial<ReadonlyDiagnosticPayload> = {}): Record<string, unknown> {
  return {
    assetUid: 'asset-1',
    connectionUid: 'conn-1',
    connectionFingerprint: 'fp-1',
    catalogId: 'log_tail',
    params: { path: '/var/log/syslog', lines: 50 },
    expectedCommand: 'tail -n 50 -- /var/log/syslog',
    allowedLogPaths: ['/var/log/syslog'],
    timeoutSeconds: 25,
    maxOutputBytes: 16384,
    ...overrides,
  }
}

function run(p: Record<string, unknown>, opts: Record<string, unknown> = OPTS) {
  return executeCommand('readonly_diagnostic', p, opts)
}

/**
 * Route the mocked SSH executor by command: the log_tail preflight checks
 * (`readlink -e` echoes the path back, `test -f` succeeds with no output) and
 * the diagnostic itself (returns `output`).
 */
function sshReturns(output: string): void {
  mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) => {
    if (command.startsWith('readlink ')) return `${command.split(' ').pop()}\n`
    if (command.startsWith('test ')) return ''
    return output
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  const actual = jest.requireActual('../../src/security') as typeof import('../../src/security')
  mockValidateCommand.mockImplementation(actual.validateCommand)
  mockGetCredential.mockResolvedValue(CREDENTIAL)
  sshReturns('log line\n')
})

describe('readonly_diagnostic dispatch', () => {
  it('accepts the discriminated-union form', async () => {
    const result = await executeCommand(
      { type: 'readonly_diagnostic', payload: payload() as ReadonlyDiagnosticPayload },
      OPTS,
    )
    expect(result.success).toBe(true)
  })

  it('requires client context', async () => {
    expect(await run(payload(), {})).toEqual({
      success: false,
      error: 'readonly_diagnostic requires client context',
    })
    expect(await run(payload(), { client: CLIENT })).toEqual({
      success: false,
      error: 'readonly_diagnostic requires client context',
    })
    expect(mockGetCredential).not.toHaveBeenCalled()
  })

  describe('rejects before fetching the credential', () => {
    it.each<[string, Record<string, unknown>]>([
      ['unknown catalog id', { catalogId: 'rm', params: {}, expectedCommand: 'rm' }],
      ['__proto__ catalog id', { catalogId: '__proto__', params: {}, expectedCommand: '' }],
      ['non-string catalog id', { catalogId: 1 }],
      ['lines=201', { params: { path: '/var/log/syslog', lines: 201 }, expectedCommand: 'tail -n 201 -- /var/log/syslog' }],
      ['wrong param type', { params: { path: '/var/log/syslog', lines: '50' } }],
      ['extra param key', { params: { path: '/var/log/syslog', lines: 50, extra: 'x' } }],
      ['path with ..', { params: { path: '/var/log/../../etc/shadow' }, expectedCommand: 'tail -n 100 -- /var/log/../../etc/shadow' }],
      ['path not in allowedLogPaths', { allowedLogPaths: ['/var/log/messages'] }],
      ['sensitive path even if allowed', {
        params: { path: '/etc/shadow' },
        expectedCommand: 'tail -n 100 -- /etc/shadow',
        allowedLogPaths: ['/etc/shadow'],
      }],
      ['metachar in unit', {
        catalogId: 'unit_status',
        params: { unit: 'foo;rm.service' },
        expectedCommand: 'systemctl status --no-pager --lines=50 foo;rm.service',
      }],
      ['unit starting with -', {
        catalogId: 'unit_status',
        params: { unit: '-H.service' },
        expectedCommand: 'systemctl status --no-pager --lines=50 -H.service',
      }],
      ['missing allowedLogPaths', { allowedLogPaths: undefined }],
      ['non-array allowedLogPaths', { allowedLogPaths: '/var/log/syslog' }],
      ['non-string entry in allowedLogPaths', { allowedLogPaths: ['/var/log/syslog', 1] }],
      ['non-array allowedLogRoots', { allowedLogRoots: '/opt/myapp/' }],
      ['non-string entry in allowedLogRoots', { allowedLogRoots: ['/opt/myapp/', 1] }],
      ['invalid root in allowedLogRoots', { allowedLogRoots: ['/opt/myapp/', '/etc/'] }],
      ['more than 10 allowedLogRoots', {
        allowedLogRoots: Array.from({ length: 11 }, (_, i) => `/opt/app${i}/`),
      }],
      ['custom-root file without allowedLogRoots', {
        params: { path: '/opt/myapp/logs/app.log', lines: 50 },
        expectedCommand: 'tail -n 50 -- /opt/myapp/logs/app.log',
        allowedLogPaths: ['/opt/myapp/logs/app.log'],
      }],
      ['custom-root file under a different root', {
        params: { path: '/opt/myapp/logs/app.log', lines: 50 },
        expectedCommand: 'tail -n 50 -- /opt/myapp/logs/app.log',
        allowedLogPaths: ['/opt/myapp/logs/app.log'],
        allowedLogRoots: ['/opt/other/'],
      }],
    ])('%s', async (_label, overrides) => {
      const result = await run(payload(overrides))
      expect(result).toEqual({ success: false, error: 'readonly_diagnostic rejected: invalid catalog request' })
      expect(mockGetCredential).not.toHaveBeenCalled()
      expect(mockExecuteSshCommand).not.toHaveBeenCalled()
    })

    it.each<[string, unknown]>([
      ['appended shell command', 'tail -n 50 -- /var/log/syslog; rm -rf /'],
      ['different lines', 'tail -n 51 -- /var/log/syslog'],
      ['extra whitespace', 'tail  -n 50 -- /var/log/syslog'],
      ['missing', undefined],
      ['non-string', ['tail', '-n', '50', '--', '/var/log/syslog']],
    ])('expectedCommand mismatch: %s', async (_label, expectedCommand) => {
      const result = await run(payload({ expectedCommand }))
      expect(result).toEqual({ success: false, error: 'readonly_diagnostic rejected: command mismatch' })
      expect(mockGetCredential).not.toHaveBeenCalled()
      expect(mockExecuteSshCommand).not.toHaveBeenCalled()
    })

    it('runs the rebuilt command through validateCommand and stops when it is blocked', async () => {
      mockValidateCommand.mockReturnValue('Command blocked: contains a prohibited pattern')
      const result = await run(payload())
      expect(mockValidateCommand).toHaveBeenCalledWith('tail -n 50 -- /var/log/syslog')
      expect(result).toEqual({
        success: false,
        error: 'readonly_diagnostic rejected: Command blocked: contains a prohibited pattern',
      })
      expect(mockGetCredential).not.toHaveBeenCalled()
    })
  })

  it('fetches the credential once and executes exactly the rebuilt command', async () => {
    const result = await run(payload())
    expect(mockValidateCommand).toHaveBeenCalledWith('tail -n 50 -- /var/log/syslog')
    expect(mockGetCredential).toHaveBeenCalledTimes(1)
    expect(mockGetCredential).toHaveBeenCalledWith('cmd-1', 'agent-1')
    expect(mockExecuteSshCommand.mock.calls).toEqual([
      [CREDENTIAL, 'readlink -e -- /var/log/syslog', 25],
      [CREDENTIAL, 'test -f /var/log/syslog', 25],
      [CREDENTIAL, 'tail -n 50 -- /var/log/syslog', 25],
    ])
    expect(result).toEqual({
      success: true,
      data: { command: 'tail -n 50 -- /var/log/syslog', output: 'log line\n', truncated: false },
    })
  })

  it('passes an empty agentId when none is set', async () => {
    await run(payload(), { client: CLIENT, commandId: 'cmd-1' })
    expect(mockGetCredential).toHaveBeenCalledWith('cmd-1', '')
  })

  it.each([
    ['uptime', {}, 'uptime'],
    ['disk_usage', {}, 'df -h'],
    ['memory', {}, 'free -m'],
    ['failed_units', {}, 'systemctl --failed --no-pager --no-legend'],
    ['unit_status', { unit: 'nginx.service' }, 'systemctl status --no-pager --lines=50 nginx.service'],
    ['unit_journal', { unit: 'nginx.service', lines: 20 }, 'journalctl -u nginx.service -n 20 --no-pager'],
    ['top_processes', {}, 'ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu'],
    ['listening_ports', {}, 'ss -tln'],
  ])('executes catalog id %s', async (catalogId, params, expectedCommand) => {
    const result = await run(payload({ catalogId, params, expectedCommand, allowedLogPaths: [] }))
    expect(result.success).toBe(true)
    expect(mockExecuteSshCommand.mock.calls).toEqual([[CREDENTIAL, expectedCommand, 25]])
  })

  it.each<[unknown, number]>([
    [undefined, 30],
    ['25', 30],
    [Number.NaN, 30],
    [1, 5],
    [1000, 60],
    [12, 12],
  ])('clamps timeoutSeconds %p to %p', async (timeoutSeconds, expected) => {
    await run(payload({ catalogId: 'uptime', params: {}, expectedCommand: 'uptime', timeoutSeconds }))
    expect(mockExecuteSshCommand).toHaveBeenCalledWith(CREDENTIAL, 'uptime', expected)
  })

  it('cuts top_processes output to 21 lines', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `row${i}`)
    sshReturns(lines.join('\n'))
    const result = await run(payload({
      catalogId: 'top_processes',
      params: {},
      expectedCommand: 'ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu',
    }))
    const data = (result as { data: { output: string } }).data
    expect(data.output).toBe(lines.slice(0, 21).join('\n'))
  })

  it('does not cut other ids by line count', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `row${i}`).join('\n')
    sshReturns(text)
    const result = await run(payload())
    expect((result as { data: { output: string } }).data.output).toBe(text)
  })

  it('truncates output to maxOutputBytes', async () => {
    sshReturns('0123456789abcdef')
    const result = await run(payload({ maxOutputBytes: 10 }))
    expect(result).toEqual({
      success: true,
      data: { command: 'tail -n 50 -- /var/log/syslog', output: '0123456789', truncated: true },
    })
  })

  it('caps maxOutputBytes at 16384', async () => {
    sshReturns('x'.repeat(20000))
    const result = await run(payload({ maxOutputBytes: 100000 }))
    const data = (result as { data: { output: string; truncated: boolean } }).data
    expect(Buffer.byteLength(data.output, 'utf8')).toBe(16384)
    expect(data.truncated).toBe(true)
  })

  it.each<[unknown]>([[undefined], [0], [-1], [1.5], ['10']])(
    'falls back to 16384 for an invalid maxOutputBytes (%p)',
    async (maxOutputBytes) => {
      sshReturns('x'.repeat(20000))
      const result = await run(payload({ maxOutputBytes }))
      const data = (result as { data: { output: string } }).data
      expect(data.output).toHaveLength(16384)
    },
  )

  it('never splits a multibyte character when truncating', async () => {
    sshReturns('ログログ')
    const result = await run(payload({ maxOutputBytes: 7 }))
    const data = (result as { data: { output: string; truncated: boolean } }).data
    expect(data.output).toBe('ログ')
    expect(data.truncated).toBe(true)
  })

  describe('log_tail symlink / regular-file preflight', () => {
    function routeSsh(resolved: string, regularFile: string): void {
      mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) => {
        if (command.startsWith('readlink ')) return resolved
        if (command.startsWith('test ')) return regularFile
        return 'SHOULD-NOT-BE-READ'
      })
    }

    it.each<[string, string]>([
      ['a symlink to another log', '/var/log/other.log\n'],
      ['a symlink leaving the allowlist', '/etc/shadow\n'],
      ['a missing path (readlink -e fails)', 'Exit code: 1\nSTDOUT:\n'],
      ['an empty answer', ''],
      ['the path without the trailing newline', '/var/log/syslog'],
      ['the path followed by extra output', '/var/log/syslog\n/var/log/syslog\n'],
    ])('rejects %s without tailing', async (_label, resolved) => {
      routeSsh(resolved, '')
      const result = await run(payload())
      expect(result).toEqual({
        success: false,
        error: 'readonly_diagnostic rejected: log path is not a plain file under the allowlist (symlink or missing)',
      })
      expect(mockExecuteSshCommand).toHaveBeenCalledTimes(1)
      expect(mockGetCredential).toHaveBeenCalledTimes(1)
    })

    it.each<[string, string]>([
      ['test -f fails', 'Exit code: 1\nSTDOUT:\n'],
      ['test -f prints something unexpected', 'noise'],
    ])('rejects a non-regular file (%s) without tailing', async (_label, regularFile) => {
      routeSsh('/var/log/syslog\n', regularFile)
      const result = await run(payload())
      expect(result).toEqual({
        success: false,
        error: 'readonly_diagnostic rejected: log path is not a regular file',
      })
      expect(mockExecuteSshCommand).toHaveBeenCalledTimes(2)
    })

    describe('custom log roots', () => {
      const APP_LOG = '/opt/myapp/logs/app.log'
      const rootPayload = (overrides: Partial<ReadonlyDiagnosticPayload> = {}) =>
        payload({
          params: { path: APP_LOG, lines: 50 },
          expectedCommand: `tail -n 50 -- ${APP_LOG}`,
          allowedLogPaths: [APP_LOG],
          allowedLogRoots: ['/opt/myapp/'],
          ...overrides,
        })

      it('reads a file under a configured root after the preflight checks', async () => {
        const result = await run(rootPayload())
        expect(mockExecuteSshCommand.mock.calls).toEqual([
          [CREDENTIAL, `readlink -e -- ${APP_LOG}`, 25],
          [CREDENTIAL, `test -f ${APP_LOG}`, 25],
          [CREDENTIAL, `tail -n 50 -- ${APP_LOG}`, 25],
        ])
        expect(result).toEqual({
          success: true,
          data: { command: `tail -n 50 -- ${APP_LOG}`, output: 'log line\n', truncated: false },
        })
      })

      it('accepts exactly 10 roots', async () => {
        const roots = [...Array.from({ length: 9 }, (_, i) => `/opt/app${i}/`), '/opt/myapp/']
        const result = await run(rootPayload({ allowedLogRoots: roots }))
        expect(result.success).toBe(true)
      })

      it.each<[string, string]>([
        ['a symlink leaving the root', '/etc/shadow\n'],
        ['a symlink to another file under the root', '/opt/myapp/logs/other.log\n'],
      ])('rejects %s without tailing', async (_label, resolved) => {
        routeSsh(resolved, '')
        const result = await run(rootPayload())
        expect(result).toEqual({
          success: false,
          error: 'readonly_diagnostic rejected: log path is not a plain file under the allowlist (symlink or missing)',
        })
        expect(mockExecuteSshCommand).toHaveBeenCalledTimes(1)
      })
    })

    it('reuses the single-use credential for every SSH call', async () => {
      await run(payload())
      expect(mockGetCredential).toHaveBeenCalledTimes(1)
      expect(mockExecuteSshCommand).toHaveBeenCalledTimes(3)
      for (const call of mockExecuteSshCommand.mock.calls) expect(call[0]).toBe(CREDENTIAL)
    })

    it('runs every preflight command through validateCommand', async () => {
      await run(payload())
      expect(mockValidateCommand.mock.calls.map((c) => c[0])).toEqual([
        'tail -n 50 -- /var/log/syslog',
        'readlink -e -- /var/log/syslog',
        'test -f /var/log/syslog',
      ])
    })

    it('shares one timeout budget across the SSH calls', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
      try {
        mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) => {
          if (command.startsWith('readlink ')) {
            now.mockReturnValue(1_010_000) // 10s spent
            return '/var/log/syslog\n'
          }
          if (command.startsWith('test ')) {
            now.mockReturnValue(1_030_000) // budget (25s) exhausted
            return ''
          }
          return 'unreachable'
        })
        const result = await run(payload())
        expect(mockExecuteSshCommand.mock.calls.map((c) => c[2])).toEqual([25, 15])
        expect(result).toEqual({ success: false, error: 'readonly_diagnostic timed out' })
      } finally {
        now.mockRestore()
      }
    })
  })

  it('returns an error result when the credential fetch fails (and does not retry)', async () => {
    mockGetCredential.mockRejectedValue(new Error('[409] Read-only diagnostic command is not running'))
    const result = await run(payload())
    expect(result).toEqual({
      success: false,
      error: 'Failed to fetch read-only diagnostic credential: [409] Read-only diagnostic command is not running',
    })
    expect(mockGetCredential).toHaveBeenCalledTimes(1)
    expect(mockExecuteSshCommand).not.toHaveBeenCalled()
  })

  it('returns an error result when SSH execution fails', async () => {
    mockExecuteSshCommand.mockRejectedValue(new Error('SSH command timed out after 25s'))
    const result = await run(payload())
    expect(result).toEqual({ success: false, error: 'SSH command timed out after 25s' })
  })

  it('never puts the credential into logs or results', async () => {
    await run(payload())
    mockExecuteSshCommand.mockRejectedValue(new Error('connection reset'))
    const failed = await run(payload())
    mockGetCredential.mockRejectedValue(new Error('[409] already fetched'))
    const fetchFailed = await run(payload())

    const everything = JSON.stringify([
      failed,
      fetchFailed,
      mockLogger.info.mock.calls,
      mockLogger.warn.mock.calls,
      mockLogger.error.mock.calls,
      mockLogger.debug.mock.calls,
      mockLogger.success.mock.calls,
    ])
    expect(everything).not.toContain(SECRET)
  })

  it('never logs the command output', async () => {
    sshReturns('SENSITIVE-OUTPUT-LINE')
    const result = await run(payload())
    expect(result.success).toBe(true)
    const logged = JSON.stringify(Object.values(mockLogger).map((fn) => fn.mock.calls))
    expect(logged).not.toContain('SENSITIVE-OUTPUT-LINE')
  })

  describe('log patterns: log_list / rotated files / .gz tail / log_grep', () => {
    const PATTERN = '/var/log/app/release_error.log*'
    const listLine = (name: string) => `  12 8 -rw-r----- 1 app adm 4096 Nov 22 10:00 /var/log/app/${name}`

    /** Stream `lines` to the onLine callback and resolve with `result`. */
    function streamReturns(lines: string[], result: { exitCode: number | null; stderr?: string; truncated?: boolean }): void {
      mockExecuteSshCommandStreaming.mockImplementation(
        async (_cred: unknown, _command: string, _timeout: number, options: { onLine: (l: string) => void }) => {
          for (const l of lines) options.onLine(l)
          return { exitCode: result.exitCode, stderr: result.stderr ?? '', truncated: result.truncated ?? false }
        },
      )
    }

    it('log_list checks the directory with readlink -e and filters secret names from the output', async () => {
      sshReturns([listLine('release_error.log'), listLine('release_error.log.pem'), listLine('release_error.log.1.gz'), ''].join('\n'))
      const command = "find /var/log/app -maxdepth 1 -type f -name 'release_error.log*' -ls"
      const result = await run(payload({
        catalogId: 'log_list',
        params: { pattern: PATTERN },
        expectedCommand: command,
        allowedLogPaths: [PATTERN],
      }))
      expect(mockExecuteSshCommand.mock.calls).toEqual([
        [CREDENTIAL, 'readlink -e -- /var/log/app', 25],
        [CREDENTIAL, command, 25],
      ])
      expect(mockValidateCommand.mock.calls.map((c) => c[0])).toEqual([command, 'readlink -e -- /var/log/app'])
      expect(result).toEqual({
        success: true,
        data: {
          command,
          output: [listLine('release_error.log'), listLine('release_error.log.1.gz'), ''].join('\n'),
          truncated: false,
        },
      })
    })

    it.each<[string, string]>([
      ['a symlinked directory', '/data/app\n'],
      ['a missing directory', 'Exit code: 1\nSTDOUT:\n'],
    ])('log_list rejects %s without listing', async (_label, resolved) => {
      mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) =>
        command.startsWith('readlink ') ? resolved : 'SHOULD-NOT-RUN',
      )
      const result = await run(payload({
        catalogId: 'log_list',
        params: { pattern: PATTERN },
        expectedCommand: "find /var/log/app -maxdepth 1 -type f -name 'release_error.log*' -ls",
        allowedLogPaths: [PATTERN],
      }))
      expect(result).toEqual({
        success: false,
        error: 'readonly_diagnostic rejected: log directory is not a plain directory under the allowlist (symlink or missing)',
      })
      expect(mockExecuteSshCommand).toHaveBeenCalledTimes(1)
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[readonly_diagnostic] rejected commandId=cmd-1 catalogId=log_list reason=log_dir_not_plain',
      )
    })

    it('log_list rejects an unquoted expectedCommand', async () => {
      const result = await run(payload({
        catalogId: 'log_list',
        params: { pattern: PATTERN },
        expectedCommand: 'find /var/log/app -maxdepth 1 -type f -name release_error.log* -ls',
        allowedLogPaths: [PATTERN],
      }))
      expect(result).toEqual({ success: false, error: 'readonly_diagnostic rejected: command mismatch' })
      expect(mockGetCredential).not.toHaveBeenCalled()
    })

    it('log_tail reads a rotated .1 file after the preflight on that concrete file', async () => {
      const path = '/var/log/app/release_error.log.1'
      const result = await run(payload({
        params: { path, lines: 50 },
        expectedCommand: `tail -n 50 -- ${path}`,
        allowedLogPaths: [PATTERN],
      }))
      expect(mockExecuteSshCommand.mock.calls).toEqual([
        [CREDENTIAL, `readlink -e -- ${path}`, 25],
        [CREDENTIAL, `test -f ${path}`, 25],
        [CREDENTIAL, `tail -n 50 -- ${path}`, 25],
      ])
      expect(result.success).toBe(true)
    })

    it('log_tail rejects a file the pattern does not match', async () => {
      const result = await run(payload({
        params: { path: '/var/log/app/other.log', lines: 50 },
        expectedCommand: 'tail -n 50 -- /var/log/app/other.log',
        allowedLogPaths: [PATTERN],
      }))
      expect(result).toEqual({ success: false, error: 'readonly_diagnostic rejected: invalid catalog request' })
      expect(mockGetCredential).not.toHaveBeenCalled()
    })

    describe('.gz tail', () => {
      const GZ = '/var/log/app/release_error.log.2.gz'
      const gzPayload = () => payload({
        params: { path: GZ, lines: 3 },
        expectedCommand: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`,
        allowedLogPaths: [PATTERN],
      })

      it('streams gzip -dc after the preflight and keeps only the last N lines', async () => {
        streamReturns(['l1', 'l2', 'l3', 'l4', 'l5'], { exitCode: 0 })
        const result = await run(gzPayload())
        expect(mockExecuteSshCommand.mock.calls).toEqual([
          [CREDENTIAL, `readlink -e -- ${GZ}`, 25],
          [CREDENTIAL, `test -f ${GZ}`, 25],
        ])
        expect(mockExecuteSshCommandStreaming).toHaveBeenCalledTimes(1)
        const [cred, command, timeout, options] = mockExecuteSshCommandStreaming.mock.calls[0]
        expect([cred, command, timeout]).toEqual([CREDENTIAL, `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`, 25])
        expect(options).toEqual({ onLine: expect.any(Function), maxBytes: 256 * 1024 * 1024 })
        expect(result).toEqual({
          success: true,
          data: { command: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`, output: 'l3\nl4\nl5\n', truncated: false },
        })
      })

      it('marks truncated when the 256 MiB cap stopped the stream and returns the last lines seen', async () => {
        streamReturns(['l1', 'l2'], { exitCode: null, truncated: true })
        const result = await run(gzPayload())
        expect(result).toEqual({
          success: true,
          data: { command: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`, output: 'l1\nl2\n', truncated: true },
        })
      })

      it('treats exit 124 (remote timeout 60) as success with truncated=true and the last lines seen', async () => {
        streamReturns(['l1', 'l2', 'l3', 'l4'], { exitCode: 124, stderr: 'Terminated\n' })
        const result = await run(gzPayload())
        expect(result).toEqual({
          success: true,
          data: { command: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`, output: 'l2\nl3\nl4\n', truncated: true },
        })
      })

      it('reports a non-zero exit like the plain executor does', async () => {
        streamReturns(['l1'], { exitCode: 1, stderr: 'gzip: unexpected end of file\n' })
        const result = await run(gzPayload())
        expect(result).toEqual({
          success: true,
          data: {
            command: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${GZ}`,
            output: 'Exit code: 1\nSTDOUT:\nl1\n\nSTDERR:\ngzip: unexpected end of file\n',
            truncated: false,
          },
        })
      })

      it('rejects a symlinked .gz file without reading it', async () => {
        mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) =>
          command.startsWith('readlink ') ? '/etc/shadow\n' : '',
        )
        const result = await run(gzPayload())
        expect(result.success).toBe(false)
        expect(mockExecuteSshCommandStreaming).not.toHaveBeenCalled()
      })

      it('passes the pinned host-key algorithms to the streaming executor', async () => {
        streamReturns([], { exitCode: 0 })
        const result = await run(gzPayload())
        expect(result.success).toBe(true)
        // The default CREDENTIAL carries its own fingerprint, so no algorithms are restricted.
        expect(mockExecuteSshCommandStreaming.mock.calls[0][3].hostKeyAlgorithms).toBeUndefined()
      })

      it('shares the timeout budget with the preflight', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
          mockExecuteSshCommand.mockImplementation(async (_cred: unknown, command: string) => {
            if (command.startsWith('readlink ')) return `${GZ}\n`
            now.mockReturnValue(1_010_000)
            return ''
          })
          streamReturns([], { exitCode: 0 })
          await run(gzPayload())
          expect(mockExecuteSshCommandStreaming.mock.calls[0][2]).toBe(15)
        } finally {
          now.mockRestore()
        }
      })
    })

    describe('log_grep', () => {
      const grepPayload = (path: string, text: string, lines = 2, expectedCommand?: string) => payload({
        catalogId: 'log_grep',
        params: { path, text, lines },
        expectedCommand: expectedCommand ?? `timeout 60 nice -n 19 ionice -c 3 ${path.endsWith('.gz') ? 'zgrep' : 'grep'} -F -n -e '${text}' -- ${path}`,
        allowedLogPaths: [PATTERN],
      })

      it('keeps the last N matching lines', async () => {
        streamReturns(['1:a x', '5:a y', '9:a z'], { exitCode: 0 })
        const result = await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        expect(mockExecuteSshCommand.mock.calls.map((c) => c[1])).toEqual([
          'readlink -e -- /var/log/app/release_error.log',
          'test -f /var/log/app/release_error.log',
        ])
        expect(mockExecuteSshCommandStreaming.mock.calls[0][1]).toBe("timeout 60 nice -n 19 ionice -c 3 grep -F -n -e 'a x' -- /var/log/app/release_error.log")
        expect(result).toEqual({
          success: true,
          data: { command: "timeout 60 nice -n 19 ionice -c 3 grep -F -n -e 'a x' -- /var/log/app/release_error.log", output: '5:a y\n9:a z\n', truncated: false },
        })
      })

      it('uses zgrep for .gz files', async () => {
        streamReturns(['3:boom'], { exitCode: 0 })
        const path = '/var/log/app/release_error.log.4.gz'
        const result = await run(grepPayload(path, 'boom', 2, `timeout 60 nice -n 19 ionice -c 3 zgrep -F -n -e boom -- ${path}`))
        expect(result).toEqual({
          success: true,
          data: { command: `timeout 60 nice -n 19 ionice -c 3 zgrep -F -n -e boom -- ${path}`, output: '3:boom\n', truncated: false },
        })
      })

      it('treats exit code 1 (no match) as success with empty output', async () => {
        streamReturns([], { exitCode: 1 })
        const result = await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        expect(result).toEqual({
          success: true,
          data: { command: "timeout 60 nice -n 19 ionice -c 3 grep -F -n -e 'a x' -- /var/log/app/release_error.log", output: '', truncated: false },
        })
      })

      it('reports exit code 2 (error) with stderr', async () => {
        streamReturns([], { exitCode: 2, stderr: 'grep: read error\n' })
        const result = await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        expect((result as { data: { output: string } }).data.output).toBe('Exit code: 2\nSTDOUT:\n\nSTDERR:\ngrep: read error\n')
      })

      it('treats a grep exit 124 (remote timeout) as success with truncated=true', async () => {
        streamReturns(['1:a x'], { exitCode: 124 })
        const result = await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        expect(result).toEqual({
          success: true,
          data: {
            command: "timeout 60 nice -n 19 ionice -c 3 grep -F -n -e 'a x' -- /var/log/app/release_error.log",
            output: '1:a x\n',
            truncated: true,
          },
        })
      })

      it('passes a search text starting with - as the -e value', async () => {
        streamReturns([], { exitCode: 1 })
        const command = "timeout 60 nice -n 19 ionice -c 3 grep -F -n -e '-x (code=500)' -- /var/log/app/release_error.log"
        const result = await run(grepPayload('/var/log/app/release_error.log', '-x (code=500)', 2, command))
        expect(result.success).toBe(true)
        expect(mockExecuteSshCommandStreaming.mock.calls[0][1]).toBe(command)
      })

      it('marks truncated when the stream cap was hit', async () => {
        streamReturns(['1:a'], { exitCode: null, truncated: true })
        const result = await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        expect((result as { data: { truncated: boolean } }).data.truncated).toBe(true)
      })

      it('rejects a search text the command blocklist refuses, before fetching the credential', async () => {
        const result = await run(grepPayload('/var/log/app/release_error.log', 'sudo', 2, 'timeout 60 nice -n 19 ionice -c 3 grep -F -n -e sudo -- /var/log/app/release_error.log'))
        expect(result).toEqual({
          success: false,
          error: 'readonly_diagnostic rejected: Command blocked: contains a prohibited pattern',
        })
        expect(mockGetCredential).not.toHaveBeenCalled()
      })

      it('never logs the matched lines', async () => {
        streamReturns(['1:SENSITIVE-MATCH'], { exitCode: 0 })
        await run(grepPayload('/var/log/app/release_error.log', 'a x'))
        const logged = JSON.stringify(Object.values(mockLogger).map((fn) => fn.mock.calls))
        expect(logged).not.toContain('SENSITIVE-MATCH')
      })
    })
  })

  describe('host key pin', () => {
    const ASSET_UID = '01M7WSFAK2W2V29AX1T7KMPG2F'
    const NOT_PINNED = 'readonly_diagnostic rejected: host key is not pinned for this asset; run a server setup recipe against it first'
    const UPTIME = { catalogId: 'uptime', params: {}, expectedCommand: 'uptime', allowedLogPaths: [], assetUid: ASSET_UID }
    const { hostKeyFingerprint: _omit, ...unpinned } = CREDENTIAL
    const LEDGER_CREDENTIAL = { ...unpinned, hostId: ASSET_UID }

    function sshString(value: Buffer | string): Buffer {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const len = Buffer.alloc(4)
      len.writeUInt32BE(body.length)
      return Buffer.concat([len, body])
    }
    function ed25519Blob(): Buffer {
      return Buffer.concat([sshString('ssh-ed25519'), sshString(randomBytes(32))])
    }
    function fingerprintOf(blob: Buffer): string {
      return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
    }
    function hashedHost(name: string): string {
      const salt = randomBytes(20)
      return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`
    }
    // Server setup's file for (tenant 00000009, sshHostId = asset UID), named
    // exactly like production: 00000009__01m7wsfak2w2v29ax1t7kmpg2f.
    const pinFile = () => path.join(knownHostsDir(), '00000009__01m7wsfak2w2v29ax1t7kmpg2f')
    function writePins(lines: string[]): void {
      fs.mkdirSync(knownHostsDir(), { recursive: true })
      fs.writeFileSync(pinFile(), `${lines.join('\n')}\n`)
    }
    const line = (hosts: string, blob: Buffer, marker = '') =>
      `${marker ? `${marker} ` : ''}${hosts} ssh-ed25519 ${blob.toString('base64')}`

    function expectRejectedWithoutSsh(result: unknown, error: string, reason: string): void {
      expect(result).toEqual({ success: false, error })
      expect(mockGetCredential).toHaveBeenCalledTimes(1)
      expect(mockExecuteSshCommand).not.toHaveBeenCalled()
      expect(mockLogger.info).toHaveBeenCalledWith(
        `[readonly_diagnostic] rejected commandId=cmd-1 catalogId=uptime reason=${reason}`,
      )
    }

    beforeEach(() => {
      mockGetCredential.mockResolvedValue(LEDGER_CREDENTIAL)
    })
    afterEach(() => {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
    })

    it('uses a fingerprint the credential already carries, unchanged, without touching known_hosts', async () => {
      mockGetCredential.mockResolvedValue({ ...CREDENTIAL, hostId: ASSET_UID })
      const result = await run(payload(UPTIME))
      expect(result.success).toBe(true)
      expect(mockExecuteSshCommand.mock.calls).toEqual([[{ ...CREDENTIAL, hostId: ASSET_UID }, 'uptime', 25]])
      expect(fs.existsSync(TEST_CONFIG_DIR)).toBe(false)
    })

    it('rejects a malformed fingerprint on the credential', async () => {
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, hostKeyFingerprint: 'SHA256:short' })
      expectRejectedWithoutSsh(
        await run(payload(UPTIME)),
        'readonly_diagnostic rejected: credential host key fingerprint is malformed',
        'host_key_fingerprint_malformed',
      )
    })

    it('pins the key server setup recorded for the asset and restricts negotiation to its type', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.internal', blob)])
      const result = await run(payload(UPTIME))
      expect(result.success).toBe(true)
      expect(mockExecuteSshCommand.mock.calls).toEqual([[
        { ...LEDGER_CREDENTIAL, hostKeyFingerprint: fingerprintOf(blob) },
        'uptime',
        25,
        { hostKeyAlgorithms: ['ssh-ed25519'] },
      ]])
    })

    it('uses the pinned key for every SSH call of a log_tail run', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.internal', blob)])
      await run(payload({ assetUid: ASSET_UID }))
      expect(mockExecuteSshCommand).toHaveBeenCalledTimes(3)
      for (const call of mockExecuteSshCommand.mock.calls) {
        expect(call[0]).toEqual({ ...LEDGER_CREDENTIAL, hostKeyFingerprint: fingerprintOf(blob) })
        expect(call[3]).toEqual({ hostKeyAlgorithms: ['ssh-ed25519'] })
      }
    })

    it('uses the pinned key for the preflight and the streaming read of a .gz tail', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.internal', blob)])
      const gz = '/var/log/app/release_error.log.1.gz'
      mockExecuteSshCommandStreaming.mockResolvedValue({ exitCode: 0, stderr: '', truncated: false })
      const result = await run(payload({
        assetUid: ASSET_UID,
        params: { path: gz, lines: 10 },
        expectedCommand: `timeout 60 nice -n 19 ionice -c 3 gzip -dc -- ${gz}`,
        allowedLogPaths: ['/var/log/app/release_error.log*'],
      }))
      expect(result.success).toBe(true)
      const pinned = { ...LEDGER_CREDENTIAL, hostKeyFingerprint: fingerprintOf(blob) }
      expect(mockExecuteSshCommand.mock.calls.map((c) => [c[0], c[3]])).toEqual([
        [pinned, { hostKeyAlgorithms: ['ssh-ed25519'] }],
        [pinned, { hostKeyAlgorithms: ['ssh-ed25519'] }],
      ])
      const [cred, , , options] = mockExecuteSshCommandStreaming.mock.calls[0]
      expect(cred).toEqual(pinned)
      expect(options.hostKeyAlgorithms).toEqual(['ssh-ed25519'])
    })

    it('matches a hashed [host]:port entry for a non-22 port', async () => {
      const blob = ed25519Blob()
      writePins([line(hashedHost('[db1.internal]:2222'), blob)])
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, port: 2222 })
      const result = await run(payload(UPTIME))
      expect(result.success).toBe(true)
      expect(mockExecuteSshCommand.mock.calls[0][0].hostKeyFingerprint).toBe(fingerprintOf(blob))
    })

    it('matches a plain [host]:port entry inside a comma list', async () => {
      const blob = ed25519Blob()
      writePins([line('other.internal,[db1.internal]:2222', blob)])
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, port: 2222 })
      expect((await run(payload(UPTIME))).success).toBe(true)
      expect(mockExecuteSshCommand.mock.calls[0][0].hostKeyFingerprint).toBe(fingerprintOf(blob))
    })

    it('rejects when no known_hosts file exists, and never creates it', async () => {
      expectRejectedWithoutSsh(await run(payload(UPTIME)), NOT_PINNED, 'host_key_not_pinned')
      expect(fs.existsSync(knownHostsDir())).toBe(false)
      fs.mkdirSync(knownHostsDir(), { recursive: true })
      await run(payload(UPTIME))
      expect(fs.readdirSync(knownHostsDir())).toEqual([])
    })

    it('rejects when the file pins only other hosts / ports', async () => {
      writePins([line('db2.internal', ed25519Blob()), line('[db1.internal]:2222', ed25519Blob())])
      expectRejectedWithoutSsh(await run(payload(UPTIME)), NOT_PINNED, 'host_key_not_pinned')
    })

    it('never trusts a @revoked key', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.internal', blob), line('*', blob, '@revoked')])
      expectRejectedWithoutSsh(await run(payload(UPTIME)), NOT_PINNED, 'host_key_not_pinned')
    })

    it('rejects two different pinned keys of the same type as ambiguous', async () => {
      writePins([line('db1.internal', ed25519Blob()), line(hashedHost('db1.internal'), ed25519Blob())])
      expectRejectedWithoutSsh(
        await run(payload(UPTIME)),
        'readonly_diagnostic rejected: several different host keys are pinned for this asset; remove the stale entry from its server-setup known_hosts file',
        'host_key_ambiguous',
      )
    })

    it('looks up a tailscale credential by its tailnet hostname, like server setup', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.tail1234.ts.net', blob)])
      const tailscale = { ...LEDGER_CREDENTIAL, connectionType: 'tailscale', tailnetHostname: 'db1.tail1234.ts.net' }
      mockGetCredential.mockResolvedValue(tailscale)
      expect((await run(payload(UPTIME))).success).toBe(true)
      expect(mockExecuteSshCommand.mock.calls[0][0]).toEqual({ ...tailscale, hostKeyFingerprint: fingerprintOf(blob) })
    })

    it('does not accept a tailscale credential pinned only under its ledger hostname', async () => {
      writePins([line('db1.internal', ed25519Blob())])
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, connectionType: 'tailscale', tailnetHostname: 'db1.tail1234.ts.net' })
      expectRejectedWithoutSsh(await run(payload(UPTIME)), NOT_PINNED, 'host_key_not_pinned')
    })

    it('rejects a tailscale credential without a tailnet hostname', async () => {
      writePins([line('db1.internal', ed25519Blob())])
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, connectionType: 'tailscale' })
      expectRejectedWithoutSsh(
        await run(payload(UPTIME)),
        'readonly_diagnostic rejected: credential host or port is invalid',
        'credential_host_invalid',
      )
    })

    it('rejects as not pinned when the client has no tenant code', async () => {
      writePins([line('db1.internal', ed25519Blob())])
      const result = await run(payload(UPTIME), { ...OPTS, client: { ...CLIENT, getTenantCode: () => '' } })
      expectRejectedWithoutSsh(result, NOT_PINNED, 'tenant_code_missing')
    })

    it('rejects a credential issued for another host id', async () => {
      writePins([line('db1.internal', ed25519Blob())])
      mockGetCredential.mockResolvedValue({ ...LEDGER_CREDENTIAL, hostId: 'someone-else' })
      expectRejectedWithoutSsh(
        await run(payload(UPTIME)),
        'readonly_diagnostic rejected: credential does not belong to this asset',
        'credential_asset_mismatch',
      )
    })

    it.each<[string, unknown]>([['missing', undefined], ['empty', ''], ['non-string', 1]])(
      'rejects a %s assetUid before fetching the credential',
      async (_label, assetUid) => {
        const result = await run(payload({ ...UPTIME, assetUid }))
        expect(result).toEqual({ success: false, error: 'readonly_diagnostic rejected: invalid asset' })
        expect(mockGetCredential).not.toHaveBeenCalled()
        expect(mockLogger.info).toHaveBeenCalledWith(
          '[readonly_diagnostic] rejected commandId=cmd-1 catalogId=uptime reason=invalid_asset',
        )
      },
    )

    it('logs earlier rejections with only the commandId and catalogId', async () => {
      await run(payload({ expectedCommand: 'tail -n 51 -- /var/log/syslog' }))
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[readonly_diagnostic] rejected commandId=cmd-1 catalogId=log_tail reason=command_mismatch',
      )
      await run(payload({ catalogId: 'rm\nINJECTED', params: {}, expectedCommand: 'rm' }))
      expect(mockLogger.info).toHaveBeenLastCalledWith(
        '[readonly_diagnostic] rejected commandId=cmd-1 catalogId=invalid reason=invalid_catalog_request',
      )
    })

    it('never logs key material, the credential or the known_hosts path contents', async () => {
      const blob = ed25519Blob()
      writePins([line('db1.internal', blob)])
      await run(payload(UPTIME))
      writePins([line('db1.internal', blob), line('db1.internal', ed25519Blob())])
      await run(payload(UPTIME))
      const logged = JSON.stringify(Object.values(mockLogger).map((fn) => fn.mock.calls))
      expect(logged).not.toContain(SECRET)
      expect(logged).not.toContain(blob.toString('base64'))
      expect(logged).not.toContain(fingerprintOf(blob))
    })
  })
})
