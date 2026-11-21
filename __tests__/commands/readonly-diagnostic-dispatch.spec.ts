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
jest.mock('../../src/commands/ssh-executor', () => ({
  executeSshCommand: (...args: unknown[]) => mockExecuteSshCommand(...args),
}))

const mockValidateCommand = jest.fn()
jest.mock('../../src/security', () => {
  const actual = jest.requireActual('../../src/security')
  return {
    ...actual,
    validateCommand: (command: string) => mockValidateCommand(command),
  }
})

import { executeCommand } from '../../src/commands'
import type { ApiClient } from '../../src/api-client'
import type { ReadonlyDiagnosticPayload } from '../../src/types'

const SECRET = 'SECRET-PRIVATE-KEY-MATERIAL'
const CREDENTIAL = {
  hostId: 'asset-1',
  hostname: 'db1.internal',
  port: 22,
  username: 'readonly',
  authType: 'private_key',
  privateKey: SECRET,
}

const mockGetCredential = jest.fn()
const CLIENT = { getReadonlyDiagnosticCredential: mockGetCredential } as unknown as ApiClient
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
})
