/**
 * Tests for the agent-side read-only diagnostic catalog.
 *
 * The accept/reject tables below are ported from the api's
 * `src/alarm-ai-check/__tests__/readonly-diagnostic-catalog.spec.ts` and
 * `readonly-log-path.util.spec.ts`. Both sides implement the catalog
 * independently (defense in depth), so keep these tables in sync with the
 * api whenever a rule changes.
 */

import {
  buildLogTailPreflight,
  buildReadonlyDiagnostic,
  firstLines,
  isReadonlyDiagnosticId,
  READONLY_DIAGNOSTIC_CAPABILITY,
  READONLY_DIAGNOSTIC_IDS,
  READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES,
  READONLY_LOG_PATH_MAX_LENGTH,
  readonlyDiagnosticCommandText,
  type ReadonlyDiagnosticId,
  TOP_PROCESSES_OUTPUT_LINES,
  truncateUtf8,
  validateReadonlyLogPath,
  validateReadonlyLogRoot,
} from '../../src/commands/readonly-diagnostic-catalog'
import { validateCommand } from '../../src/security'

const ALLOWED = {
  allowedLogPaths: ['/var/log/syslog', '/var/log/nginx/error.log'],
} as const

/** Representative valid input for each id, with the expected argv / normalized params */
const VALID_CASES: ReadonlyArray<{
  id: ReadonlyDiagnosticId
  params?: Record<string, unknown>
  expectedParams: Record<string, string | number>
  argv: string[]
}> = [
  { id: 'uptime', expectedParams: {}, argv: ['uptime'] },
  { id: 'disk_usage', expectedParams: {}, argv: ['df', '-h'] },
  { id: 'memory', expectedParams: {}, argv: ['free', '-m'] },
  {
    id: 'failed_units',
    expectedParams: {},
    argv: ['systemctl', '--failed', '--no-pager', '--no-legend'],
  },
  {
    id: 'unit_status',
    params: { unit: 'nginx.service' },
    expectedParams: { unit: 'nginx.service' },
    argv: ['systemctl', 'status', '--no-pager', '--lines=50', 'nginx.service'],
  },
  {
    id: 'unit_journal',
    params: { unit: 'getty@tty1.service' },
    expectedParams: { unit: 'getty@tty1.service', lines: 100 },
    argv: ['journalctl', '-u', 'getty@tty1.service', '-n', '100', '--no-pager'],
  },
  {
    id: 'top_processes',
    expectedParams: {},
    argv: ['ps', '-eo', 'pid,user,pcpu,pmem,etime,comm', '--sort=-pcpu'],
  },
  { id: 'listening_ports', expectedParams: {}, argv: ['ss', '-tln'] },
  {
    id: 'log_tail',
    params: { path: '/var/log/nginx/error.log', lines: 50 },
    expectedParams: { path: '/var/log/nginx/error.log', lines: 50 },
    argv: ['tail', '-n', '50', '--', '/var/log/nginx/error.log'],
  },
]

describe('readonly-diagnostic-catalog', () => {
  it('pins the capability name and the catalog ids', () => {
    expect(READONLY_DIAGNOSTIC_CAPABILITY).toBe('readonly_diagnostic_v1')
    expect([...READONLY_DIAGNOSTIC_IDS].sort()).toEqual(
      [
        'disk_usage',
        'failed_units',
        'listening_ports',
        'log_tail',
        'memory',
        'top_processes',
        'unit_journal',
        'unit_status',
        'uptime',
      ].sort(),
    )
    expect(VALID_CASES.map((c) => c.id).sort()).toEqual([...READONLY_DIAGNOSTIC_IDS].sort())
    expect(TOP_PROCESSES_OUTPUT_LINES).toBe(21)
    expect(READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES).toBe(16384)
  })

  it('isReadonlyDiagnosticId only accepts catalog ids', () => {
    expect(isReadonlyDiagnosticId('uptime')).toBe(true)
    expect(isReadonlyDiagnosticId('rm')).toBe(false)
    expect(isReadonlyDiagnosticId('toString')).toBe(false)
    expect(isReadonlyDiagnosticId('__proto__')).toBe(false)
    expect(isReadonlyDiagnosticId('constructor')).toBe(false)
    expect(isReadonlyDiagnosticId(1)).toBe(false)
  })

  describe('argv for every id', () => {
    it.each(VALID_CASES)('$id', ({ id, params, expectedParams, argv }) => {
      expect(buildReadonlyDiagnostic(id, params, ALLOWED)).toEqual({
        id,
        params: expectedParams,
        argv,
      })
    })

    it('accepts an empty params object for ids without arguments', () => {
      expect(buildReadonlyDiagnostic('uptime', {}, ALLOWED)?.argv).toEqual(['uptime'])
    })

    it('defaults lines to 100 and accepts the bounds 1 and 200', () => {
      expect(buildReadonlyDiagnostic('log_tail', { path: '/var/log/syslog' }, ALLOWED)?.argv).toEqual([
        'tail', '-n', '100', '--', '/var/log/syslog',
      ])
      expect(
        buildReadonlyDiagnostic('unit_journal', { unit: 'sshd.service', lines: 1 }, ALLOWED)?.argv,
      ).toEqual(['journalctl', '-u', 'sshd.service', '-n', '1', '--no-pager'])
      expect(
        buildReadonlyDiagnostic('log_tail', { path: '/var/log/syslog', lines: 200 }, ALLOWED)?.params,
      ).toEqual({ path: '/var/log/syslog', lines: 200 })
    })

    it.each([
      'sshd.socket',
      'logrotate.timer',
      'home.mount',
      'multi-user.target',
      'a.b-c_d:e.service',
    ])('unit kind / charset: %s', (unit) => {
      expect(buildReadonlyDiagnostic('unit_status', { unit }, ALLOWED)).not.toBeNull()
    })

    it('returns a fresh argv array on every call (no shared mutable state)', () => {
      const a = buildReadonlyDiagnostic('uptime', undefined, ALLOWED)
      a?.argv.push('extra')
      expect(buildReadonlyDiagnostic('uptime', undefined, ALLOWED)?.argv).toEqual(['uptime'])
    })
  })

  describe('rejected input', () => {
    it.each<[string, unknown, unknown]>([
      ['unknown id', 'rm', undefined],
      ['free-form shell string as id', 'uptime; rm -rf /', undefined],
      ['prototype key', 'toString', undefined],
      ['__proto__', '__proto__', undefined],
      ['constructor', 'constructor', undefined],
      ['non-string id', 1, undefined],
      ['null id', null, undefined],
      ['params is an array', 'uptime', []],
      ['params is null', 'uptime', null],
      ['params is a string', 'uptime', 'df -h'],
      ['extra key (id without arguments)', 'uptime', { extra: 1 }],
      ['extra key (id that does not take lines)', 'disk_usage', { lines: 10 }],
      ['extra key (lines on unit_status)', 'unit_status', { unit: 'nginx.service', lines: 10 }],
      ['extra key (unit on log_tail)', 'log_tail', { path: '/var/log/syslog', unit: 'x.service' }],
      ['extra key (argv passed directly)', 'uptime', { argv: ['rm', '-rf', '/'] }],
      ['missing unit', 'unit_status', {}],
      ['shell metachar in unit: foo;rm', 'unit_status', { unit: 'foo;rm' }],
      ['shell metachar in unit: foo;rm.service', 'unit_status', { unit: 'foo;rm.service' }],
      ['whitespace in unit', 'unit_status', { unit: 'a b.service' }],
      ['$() in unit', 'unit_journal', { unit: '$(id).service' }],
      ['../ in unit', 'unit_status', { unit: '../x.service' }],
      ['unit starting with -', 'unit_status', { unit: '-H.service' }],
      ['unit starting with --', 'unit_journal', { unit: '--all.service' }],
      ['invalid unit kind', 'unit_status', { unit: 'nginx' }],
      ['invalid unit kind (.sh)', 'unit_status', { unit: 'evil.sh' }],
      ['unit too long', 'unit_status', { unit: `${'a'.repeat(200)}.service` }],
      ['numeric unit', 'unit_status', { unit: 1 }],
      ['newline in unit', 'unit_status', { unit: 'a.service\nb.service' }],
      ['lines=201', 'unit_journal', { unit: 'nginx.service', lines: 201 }],
      ['lines=0', 'log_tail', { path: '/var/log/syslog', lines: 0 }],
      ['negative lines', 'log_tail', { path: '/var/log/syslog', lines: -1 }],
      ['fractional lines', 'log_tail', { path: '/var/log/syslog', lines: 1.5 }],
      ['string lines (wrong type)', 'log_tail', { path: '/var/log/syslog', lines: '50' }],
      ['NaN lines', 'log_tail', { path: '/var/log/syslog', lines: Number.NaN }],
      ['null lines', 'log_tail', { path: '/var/log/syslog', lines: null }],
      ['missing path', 'log_tail', {}],
      ['array path (wrong type)', 'log_tail', { path: ['/var/log/syslog'] }],
      ['path containing ../', 'log_tail', { path: '/var/log/../../etc/shadow' }],
      ['path not in allowedLogPaths', 'log_tail', { path: '/var/log/messages' }],
      ['sensitive path', 'log_tail', { path: '/etc/shadow' }],
      ['metachar in path', 'log_tail', { path: '/var/log/syslog;rm' }],
      ['relative path', 'log_tail', { path: 'var/log/syslog' }],
    ])('%s', (_label, id, params) => {
      expect(buildReadonlyDiagnostic(id, params, ALLOWED)).toBeNull()
    })

    it('rejects non-plain params (class instance)', () => {
      class P {
        unit = 'nginx.service'
      }
      expect(buildReadonlyDiagnostic('unit_status', new P(), ALLOWED)).toBeNull()
    })

    it('accepts Object.create(null) params', () => {
      const p = Object.create(null) as Record<string, unknown>
      p.unit = 'nginx.service'
      expect(buildReadonlyDiagnostic('unit_status', p, ALLOWED)).not.toBeNull()
    })

    it('rejects params whose own __proto__ key was set via JSON', () => {
      const p = JSON.parse('{"__proto__": {"unit": "x.service"}}') as unknown
      expect(buildReadonlyDiagnostic('uptime', p, ALLOWED)).toBeNull()
    })
  })

  describe('log_tail and allowedLogPaths', () => {
    it('rejects a valid path that is not in allowedLogPaths', () => {
      expect(
        buildReadonlyDiagnostic('log_tail', { path: '/var/log/syslog' }, { allowedLogPaths: ['/var/log/messages'] }),
      ).toBeNull()
    })

    it('always rejects log_tail when allowedLogPaths is empty', () => {
      expect(buildReadonlyDiagnostic('log_tail', { path: '/var/log/syslog' }, { allowedLogPaths: [] })).toBeNull()
    })

    it('rejects sensitive paths even if they slipped into allowedLogPaths', () => {
      expect(
        buildReadonlyDiagnostic('log_tail', { path: '/etc/shadow' }, { allowedLogPaths: ['/etc/shadow'] }),
      ).toBeNull()
      expect(
        buildReadonlyDiagnostic(
          'log_tail',
          { path: '/var/log/../../etc/shadow' },
          { allowedLogPaths: ['/var/log/../../etc/shadow'] },
        ),
      ).toBeNull()
    })

    it('does not let allowedLogPaths affect other ids', () => {
      expect(buildReadonlyDiagnostic('uptime', undefined, { allowedLogPaths: [] })).not.toBeNull()
    })
  })

  describe('log_tail and allowedLogRoots', () => {
    const appLog = '/opt/myapp/logs/app.log'

    it('accepts a file under a configured root when it is also in allowedLogPaths', () => {
      expect(
        buildReadonlyDiagnostic(
          'log_tail',
          { path: appLog },
          { allowedLogPaths: [appLog], allowedLogRoots: ['/opt/myapp/'] },
        ),
      ).toEqual({ id: 'log_tail', params: { path: appLog, lines: 100 }, argv: ['tail', '-n', '100', '--', appLog] })
    })

    it('rejects the same file without the root (unset or empty)', () => {
      expect(buildReadonlyDiagnostic('log_tail', { path: appLog }, { allowedLogPaths: [appLog] })).toBeNull()
      expect(
        buildReadonlyDiagnostic('log_tail', { path: appLog }, { allowedLogPaths: [appLog], allowedLogRoots: [] }),
      ).toBeNull()
    })

    it('rejects a file under a root that is not in allowedLogPaths', () => {
      expect(
        buildReadonlyDiagnostic('log_tail', { path: appLog }, { allowedLogPaths: [], allowedLogRoots: ['/opt/myapp/'] }),
      ).toBeNull()
    })

    it('ignores invalid roots even if they slipped into allowedLogRoots', () => {
      expect(
        buildReadonlyDiagnostic(
          'log_tail',
          { path: '/etc/shadow' },
          { allowedLogPaths: ['/etc/shadow'], allowedLogRoots: ['/etc/'] },
        ),
      ).toBeNull()
    })
  })

  describe('passes the agent command blocklist (validateCommand)', () => {
    it.each(VALID_CASES)('$id', ({ id, params }) => {
      const built = buildReadonlyDiagnostic(id, params, ALLOWED)
      expect(built).not.toBeNull()
      expect(validateCommand(readonlyDiagnosticCommandText(built!.argv))).toBeNull()
    })

    it('passes at the upper argument bounds too', () => {
      const built = [
        buildReadonlyDiagnostic('unit_journal', { unit: 'nginx.service', lines: 200 }, ALLOWED),
        buildReadonlyDiagnostic('log_tail', { path: '/var/log/syslog', lines: 200 }, ALLOWED),
      ]
      for (const b of built) {
        expect(b).not.toBeNull()
        expect(validateCommand(readonlyDiagnosticCommandText(b!.argv))).toBeNull()
      }
    })
  })

  it('readonlyDiagnosticCommandText joins argv with single spaces', () => {
    expect(readonlyDiagnosticCommandText(['tail', '-n', '50', '--', '/var/log/syslog'])).toBe(
      'tail -n 50 -- /var/log/syslog',
    )
  })
})

describe('validateReadonlyLogPath', () => {
  // Every row below mirrors the api's readonly-log-path.util.spec.ts table.
  describe('accepts (files below /var/log)', () => {
    it.each([
      '/var/log/syslog',
      '/var/log/messages',
      '/var/log/nginx/error.log',
      '/var/log/httpd/error_log',
      '/var/log/app/app.log',
      '/var/log/app-1/logs/app.2026-11-22.log',
      '/var/log/a',
      `/var/log/${'a'.repeat(READONLY_LOG_PATH_MAX_LENGTH - '/var/log/'.length)}`,
    ])('%s', (path) => {
      expect(validateReadonlyLogPath(path)).toBe(path)
    })
  })

  describe('rejects paths outside /var/log (allowlist)', () => {
    it.each<[string, string]>([
      ['/var/log itself', '/var/log'],
      ['/var/log/ (directory)', '/var/log/'],
      ['prefix lookalike directory', '/var/logs/app.log'],
      ['prefix lookalike directory 2', '/var/log2/app.log'],
      ['directly under /var', '/var/app.log'],
      ['under /opt (no roots configured)', '/opt/app-1/logs/app.log'],
      ['under /devops', '/devops/app.log'],
      ['SSH host key', '/etc/ssh/ssh_host_ed25519_key'],
      ['AWS credentials', '/home/u/.aws/credentials'],
      ['app .env', '/app/.env.production'],
      ['/run/secrets', '/run/secrets/x'],
      ['/etc/shadow', '/etc/shadow'],
      ['under /etc/sudoers.d', '/etc/sudoers.d/admins'],
      ['under /root', '/root/app.log'],
      ['under /proc', '/proc/self/environ'],
      ['under /dev', '/dev/sda'],
    ])('%s', (_label, path) => {
      expect(validateReadonlyLogPath(path)).toBeNull()
    })
  })

  describe('rejects secret-looking names even below /var/log', () => {
    it.each<[string, string]>([
      ['.env.local', '/var/log/app/.env.local'],
      ['.env', '/var/log/app/.env'],
      ['.env (extension)', '/var/log/app/prod.env'],
      ['id_*', '/var/log/app/id_rsa'],
      ['id_* directory', '/var/log/id_keys/app.log'],
      ['*_key', '/var/log/app/server_key'],
      ['*.key', '/var/log/server.key'],
      ['*.pem', '/var/log/app/server.pem'],
      ['*.p12', '/var/log/app/cert.p12'],
      ['*.pfx', '/var/log/app/cert.pfx'],
      ['credentials', '/var/log/app/credentials'],
      ['credentials.*', '/var/log/app/credentials.json'],
      ['credentials.* directory', '/var/log/credentials.d/app.log'],
      ['*history', '/var/log/app/.bash_history'],
      ['history', '/var/log/history'],
      ['.aws', '/var/log/.aws/config'],
      ['.kube', '/var/log/app/.kube/config'],
      ['.docker', '/var/log/.docker/config.json'],
      ['.gnupg', '/var/log/.gnupg/pubring.kbx'],
      ['.ssh', '/var/log/app/.ssh/authorized_keys'],
      ['case mismatch (.KEY)', '/var/log/SERVER.KEY'],
      ['case mismatch (.ENV)', '/var/log/App/.ENV.local'],
      ['case mismatch (Credentials)', '/var/log/Credentials'],
      ['case mismatch (Credentials.JSON)', '/var/log/Credentials.JSON'],
    ])('%s', (_label, path) => {
      expect(validateReadonlyLogPath(path)).toBeNull()
    })
  })

  describe('keeps the format rules', () => {
    it.each<[string, unknown]>([
      ['empty string', ''],
      ['relative path', 'var/log/syslog'],
      ['root only', '/'],
      ['201 chars', `/var/log/${'a'.repeat(READONLY_LOG_PATH_MAX_LENGTH)}`],
      ['contains ..', '/var/log/../../etc/shadow'],
      ['.. inside a name', '/var/log/app..log'],
      ['. segment', '/var/log/./syslog'],
      ['contains //', '/var//log/syslog'],
      ['contains // below the root', '/var/log//syslog'],
      ['trailing /', '/var/log/nginx/'],
      ['wildcard *', '/var/log/*.log'],
      ['wildcard ?', '/var/log/syslo?'],
      ['brackets', '/var/log/[a]'],
      ['whitespace', '/var/log/my app.log'],
      ['newline', '/var/log/syslog\n'],
      ['NUL', '/var/log/syslog\u0000'],
      ['tab', '/var/log/\tsyslog'],
      ['semicolon', '/var/log/syslog;rm'],
      ['$', '/var/log/$HOME'],
      ['backtick', '/var/log/`id`'],
      ['tilde', '~/log'],
      ['non-ASCII', '/var/log/ログ.log'],
    ])('%s', (_label, path) => {
      expect(validateReadonlyLogPath(path)).toBeNull()
    })

    it.each<[string, unknown]>([
      ['undefined', undefined],
      ['null', null],
      ['number', 1],
      ['array', ['/var/log/syslog']],
      ['object', { path: '/var/log/syslog' }],
    ])('non-string value (%s)', (_label, value) => {
      expect(validateReadonlyLogPath(value)).toBeNull()
    })
  })

  it('does not over-reject logs whose names only partially resemble secrets', () => {
    for (const path of [
      '/var/log/apt/history.log',
      '/var/log/identity.log',
      '/var/log/monkey.log',
      '/var/log/environment.log',
      '/var/log/keys.log',
      '/var/log/root/app.log',
      '/var/log/proc.log',
      '/var/log/token-service/app.log',
      // CLI-side extras (consistent with the api rules)
      '/var/log/keystone/keystone.log',
      '/var/log/monkey_keys.log',
      '/var/log/credentials-service.log',
      '/var/log/mycredentials',
    ]) {
      expect(validateReadonlyLogPath(path)).toBe(path)
    }
  })
})

describe('validateReadonlyLogRoot', () => {
  // Mirrors the shared custom-log-roots rule table (API / CLI / web).
  describe('accepts', () => {
    it.each(['/opt/myapp/', '/srv/web/logs/', '/home/app/logs/', '/opt/app-1/logs/', '/opt/app-1/var_log.d/'])('%s', (root) => {
      expect(validateReadonlyLogRoot(root)).toBe(root)
    })

    it('accepts a 200-char root', () => {
      const root = `/opt/${'a'.repeat(200 - '/opt/'.length - 1)}/`
      expect(root).toHaveLength(200)
      expect(validateReadonlyLogRoot(root)).toBe(root)
    })
  })

  describe('rejects', () => {
    it.each<[string, unknown]>([
      ['/', '/'],
      ['single segment /opt/', '/opt/'],
      ['denied /etc/ subdirectory', '/etc/myapp/'],
      ['denied /var/lib/', '/var/lib/x/'],
      ['denied /tmp/', '/tmp/x/'],
      ['redundant /var/log/', '/var/log/'],
      ['secret segment .ssh', '/opt/app/.ssh/'],
      ['..', '/opt/../etc/'],
      ['no trailing slash', '/opt/myapp'],
      ['denied /root/', '/root/app/'],
      ['denied /proc/', '/proc/self/'],
      ['denied /sys/', '/sys/kernel/'],
      ['denied /dev/', '/dev/shm/'],
      ['denied /run/', '/run/secrets/'],
      ['denied /boot/', '/boot/grub/'],
      ['denied /usr/', '/usr/local/'],
      ['denied /bin/', '/bin/x/'],
      ['denied /sbin/', '/sbin/x/'],
      ['denied /lib/', '/lib/x/'],
      ['denied /lib32/', '/lib32/x/'],
      ['denied /lib64/', '/lib64/x/'],
      ['denied /libx32/', '/libx32/x/'],
      ['denied /var/run/', '/var/run/app/'],
      ['denied /var/spool/', '/var/spool/cron/'],
      ['denied /var/tmp/', '/var/tmp/app/'],
      ['denied /snap/', '/snap/app/'],
      ['denied /srv/secrets/', '/srv/secrets/app/'],
      ['denied prefix itself (/var/lib/)', '/var/lib/'],
      ['denied prefix itself (/srv/secrets/)', '/srv/secrets/'],
      ['denied deep below', '/etc/myapp/logs/'],
      ['secret segment .env', '/opt/.env/'],
      ['secret segment credentials', '/opt/credentials/'],
      ['secret segment *history (case)', '/opt/App_HISTORY/'],
      // Rows ported from the api's readonly-log-path.util.spec.ts table
      ['secret segment .aws', '/home/app/.aws/'],
      ['secret segment .env*', '/opt/app/.env.d/'],
      ['secret segment *_key', '/opt/app/server_key/'],
      ['secret segment history', '/opt/app/history/'],
      ['secret segment Credentials (case)', '/opt/Credentials/'],
      ['.. inside a name', '/opt/app..x/'],
      ['semicolon', '/opt/app;id/'],
      ['non-ASCII', '/opt/アプリ/'],
      ['. segment', '/opt/./myapp/'],
      ['//', '/opt//myapp/'],
      ['relative', 'opt/myapp/'],
      ['empty', ''],
      ['whitespace', '/opt/my app/'],
      ['wildcard', '/opt/*/'],
      ['201 chars', `/opt/${'a'.repeat(200 - '/opt/'.length)}/`],
      ['non-string', 1],
      ['undefined', undefined],
      ['array', ['/opt/myapp/']],
    ])('%s', (_label, root) => {
      expect(validateReadonlyLogRoot(root)).toBeNull()
    })
  })

  it('does not over-reject roots that only resemble denied prefixes', () => {
    for (const root of ['/etcetera/app/', '/var/library/app/', '/opt/etc/', '/tmpfs/app/', '/usrdata/app/', '/srv/secretsx/']) {
      expect(validateReadonlyLogRoot(root)).toBe(root)
    }
  })
})

describe('validateReadonlyLogPath with roots', () => {
  const ROOTS = ['/opt/myapp/'] as const

  it('accepts a file under a configured root', () => {
    expect(validateReadonlyLogPath('/opt/myapp/logs/app.log', ROOTS)).toBe('/opt/myapp/logs/app.log')
    expect(validateReadonlyLogPath('/opt/myapp/app.log', ROOTS)).toBe('/opt/myapp/app.log')
  })

  it('rejects the same file without roots', () => {
    expect(validateReadonlyLogPath('/opt/myapp/logs/app.log')).toBeNull()
    expect(validateReadonlyLogPath('/opt/myapp/logs/app.log', [])).toBeNull()
  })

  it('still accepts /var/log files when roots are given', () => {
    expect(validateReadonlyLogPath('/var/log/syslog', ROOTS)).toBe('/var/log/syslog')
  })

  it.each<[string, string]>([
    ['secret file under a root', '/opt/myapp/.env'],
    ['the root directory itself', '/opt/myapp/'],
    ['the root without trailing slash', '/opt/myapp'],
    ['prefix lookalike', '/opt/myapp2/app.log'],
    ['.. escaping the root', '/opt/myapp/../../etc/shadow'],
    ['secret directory under a root', '/opt/myapp/.ssh/authorized_keys'],
    ['trailing / under a root', '/opt/myapp/logs/'],
  ])('rejects %s', (_label, path) => {
    expect(validateReadonlyLogPath(path, ROOTS)).toBeNull()
  })

  it('ignores roots that fail validateReadonlyLogRoot', () => {
    expect(validateReadonlyLogPath('/etc/shadow', ['/etc/'])).toBeNull()
    expect(validateReadonlyLogPath('/opt/app.log', ['/opt/'])).toBeNull()
    expect(validateReadonlyLogPath('/opt/myapp/app.log', ['/opt/myapp'])).toBeNull()
  })
})

describe('buildLogTailPreflight', () => {
  it('accepts a file under a configured root only with that root', () => {
    expect(buildLogTailPreflight('/opt/myapp/logs/app.log', ['/opt/myapp/'])).toEqual({
      resolve: ['readlink', '-e', '--', '/opt/myapp/logs/app.log'],
      regularFile: ['test', '-f', '/opt/myapp/logs/app.log'],
    })
    expect(buildLogTailPreflight('/opt/myapp/logs/app.log')).toBeNull()
  })

  it('builds SAFE_ARG-only argv for the symlink and regular-file checks', () => {
    expect(buildLogTailPreflight('/var/log/nginx/error.log')).toEqual({
      resolve: ['readlink', '-e', '--', '/var/log/nginx/error.log'],
      regularFile: ['test', '-f', '/var/log/nginx/error.log'],
    })
  })

  it('refuses a path that fails the allowlist', () => {
    expect(buildLogTailPreflight('/etc/shadow')).toBeNull()
    expect(buildLogTailPreflight('/var/log/a b')).toBeNull()
  })

  it('produces commands that pass validateCommand', () => {
    const preflight = buildLogTailPreflight('/var/log/syslog')!
    expect(validateCommand(readonlyDiagnosticCommandText(preflight.resolve))).toBeNull()
    expect(validateCommand(readonlyDiagnosticCommandText(preflight.regularFile))).toBeNull()
  })
})

describe('output shaping helpers', () => {
  it('firstLines keeps only the first N lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
    expect(firstLines(text, TOP_PROCESSES_OUTPUT_LINES).split('\n')).toHaveLength(21)
    expect(firstLines('a\nb', 21)).toBe('a\nb')
  })

  it('truncateUtf8 returns the text untouched when it fits', () => {
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })

  it('truncateUtf8 cuts at the byte limit', () => {
    expect(truncateUtf8('abcdef', 4)).toEqual({ text: 'abcd', truncated: true })
  })

  it('truncateUtf8 never splits a multibyte character', () => {
    // 'あ' is 3 bytes in UTF-8; a 4-byte limit must keep only one character.
    const result = truncateUtf8('あああ', 4)
    expect(result).toEqual({ text: 'あ', truncated: true })
    expect(result.text).not.toContain('�')
    // 4-byte emoji (surrogate pair) must not be split either.
    expect(truncateUtf8('a😀', 3)).toEqual({ text: 'a', truncated: true })
  })
})
