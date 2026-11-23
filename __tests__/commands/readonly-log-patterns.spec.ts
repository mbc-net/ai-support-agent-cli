/**
 * Tests for the log file pattern rules of the read-only diagnostic catalog
 * (shared spec "Log file patterns, log_list / log_grep, rotated & .gz files";
 * API / CLI / web must accept and reject exactly the same set):
 * validateReadonlyLogPattern, isAllowedLogFile, quoteArg, the log_list /
 * log_tail (.gz) / log_grep argv, log_list output filtering and the
 * last-N-lines ring buffer.
 */

import {
  buildLogDirPreflight,
  buildReadonlyDiagnostic,
  filterLogListOutput,
  isAllowedLogFile,
  LastLines,
  quoteArg,
  READONLY_LOG_LIST_MAX_LINES,
  READONLY_LOG_STREAM_MAX_BYTES,
  readonlyDiagnosticCommandText,
  splitReadonlyLogPattern,
  validateReadonlyLogPattern,
} from '../../src/commands/readonly-diagnostic-catalog'
import { validateCommand } from '../../src/security'

const ROOTS = ['/opt/myapp/', '/mnt/disk1/app/logs/'] as const

describe('validateReadonlyLogPattern', () => {
  describe('accepts', () => {
    it.each<[string, readonly string[]]>([
      ['/var/log/syslog', []],
      ['/var/log/app/release_error.log*', []],
      ['/var/log/app/app-????-??-??.log', []],
      ['/var/log/app/*.log', []],
      ['/var/log/app/*', []],
      ['/var/log/*', []],
      ['/var/log/nginx/access.log.*.gz', []],
      ['/opt/myapp/logs/app-*.log', ROOTS],
      ['/opt/myapp/*.log', ROOTS],
      ['/mnt/disk1/app/logs/batch_*.log', ROOTS],
      ['/var/log/app/history.log*', []],
      ['/var/log/app/*identity*', []],
      ['/var/log/app/passwordless-*.log', []],
    ])('%s', (pattern, roots) => {
      expect(validateReadonlyLogPattern(pattern, roots)).toBe(pattern)
    })

    it('accepts a 200-char pattern', () => {
      const pattern = `/var/log/${'a'.repeat(200 - '/var/log/'.length - 1)}*`
      expect(pattern).toHaveLength(200)
      expect(validateReadonlyLogPattern(pattern)).toBe(pattern)
    })
  })

  describe('rejects', () => {
    it.each<[string, unknown, readonly string[]]>([
      ['wildcard in the directory', '/var/log/*/app.log', []],
      ['? in the directory', '/var/log/ap?/app.log', []],
      ['** (globstar)', '/var/log/app/**', []],
      ['** inside the name', '/var/log/app/a**b.log', []],
      ['brackets', '/var/log/app/[ab].log', []],
      ['braces', '/var/log/app/{a,b}.log', []],
      ['whitespace', '/var/log/app/my *.log', []],
      ['semicolon', '/var/log/app/*.log;rm', []],
      ['quote', "/var/log/app/'*.log", []],
      ['$', '/var/log/app/$x*', []],
      ['outside /var/log without roots', '/opt/myapp/logs/*.log', []],
      ['outside /var/log and roots', '/srv/other/*.log', ROOTS],
      ['/var/log itself as a directory with a wildcard name only', '/var/log*', []],
      ['/var/log2 lookalike', '/var/log2/*.log', []],
      ['trailing /', '/var/log/app/', []],
      ['.. in the directory', '/var/log/../etc/*', []],
      ['.. inside the name', '/var/log/app/*..log', []],
      ['. segment', '/var/log/./*.log', []],
      ['//', '/var/log//*.log', []],
      ['relative', 'var/log/*.log', []],
      ['empty', '', []],
      ['201 chars', `/var/log/${'a'.repeat(200 - '/var/log/'.length)}*`, []],
      ['secret directory', '/var/log/.ssh/*', []],
      ['secret directory under a root', '/opt/myapp/.aws/*', ROOTS],
      ['secret-only name *.pem', '/var/log/app/*.pem', []],
      ['secret-only name id_*', '/var/log/app/id_*', []],
      ['secret-only name .env*', '/var/log/app/.env*', []],
      ['secret-only name *history', '/var/log/app/*history', []],
      ['secret-only name *_key', '/var/log/app/*_key', []],
      ['secret-only name shadow*', '/var/log/shadow*', []],
      ['secret-only name credentials.*', '/var/log/app/credentials.*', []],
      ['secret-only name *.KEY (case)', '/var/log/app/*.KEY', []],
      ['secret after removing ?', '/var/log/app/id_?sa', []],
      ['denied root is ignored', '/etc/*.conf', ['/etc/']],
      ['non-string', 1, []],
      ['undefined', undefined, []],
      ['array', ['/var/log/*'], []],
    ])('%s', (_label, pattern, roots) => {
      expect(validateReadonlyLogPattern(pattern, roots)).toBeNull()
    })
  })

  it('a pattern without wildcards follows validateReadonlyLogPath', () => {
    expect(validateReadonlyLogPattern('/var/log/app/server.pem')).toBeNull()
    expect(validateReadonlyLogPattern('/var/log/app/app.log')).toBe('/var/log/app/app.log')
  })

  it('splits a pattern into directory (with trailing /) and last segment', () => {
    expect(splitReadonlyLogPattern('/var/log/app/release_error.log*')).toEqual({
      dir: '/var/log/app/',
      name: 'release_error.log*',
    })
    expect(splitReadonlyLogPattern('/var/log/*')).toEqual({ dir: '/var/log/', name: '*' })
  })
})

describe('isAllowedLogFile', () => {
  const PATTERNS = [
    '/var/log/app/release_error.log*',
    '/var/log/app/app-????-??-??.log',
    '/var/log/syslog',
    '/opt/myapp/logs/*.log',
  ]

  it.each([
    '/var/log/app/release_error.log',
    '/var/log/app/release_error.log.1',
    '/var/log/app/release_error.log.12.gz',
    '/var/log/app/release_error.log-20261122',
    '/var/log/app/app-2026-11-22.log',
    '/var/log/syslog',
    '/opt/myapp/logs/batch.log',
  ])('accepts %s', (path) => {
    expect(isAllowedLogFile(path, PATTERNS, ['/opt/myapp/'])).toBe(true)
  })

  it.each<[string, unknown]>([
    ['other directory with the same name', '/var/log/release_error.log'],
    ['subdirectory of the pattern directory', '/var/log/app/old/release_error.log'],
    ['prefix only', '/var/log/app/release_error.lo'],
    ['? needs exactly one char', '/var/log/app/app-2026-11-2.log'],
    ['? does not match more chars', '/var/log/app/app-2026-11-222.log'],
    ['case-sensitive match', '/var/log/app/RELEASE_ERROR.log'],
    ['exact pattern matches only itself', '/var/log/syslog.1'],
    ['secret name matched by a broad pattern', '/var/log/app/release_error.log.pem'],
    ['secret name matched by *', '/opt/myapp/logs/id_rsa.log'],
    ['concrete path must not contain *', '/var/log/app/release_error.log*'],
    ['concrete path must not contain ?', '/var/log/app/app-????-??-??.log'],
    ['.. in the path', '/var/log/app/../app/release_error.log'],
    ['root missing', '/opt/myapp/logs/x.log'],
    ['non-string', 1],
  ])('rejects %s', (label, path) => {
    const roots = label === 'root missing' ? [] : ['/opt/myapp/']
    expect(isAllowedLogFile(path, PATTERNS, roots)).toBe(false)
  })

  it('ignores invalid patterns', () => {
    expect(isAllowedLogFile('/var/log/app/server.pem', ['/var/log/app/*.pem'])).toBe(false)
    expect(isAllowedLogFile('/var/log/x/a.log', ['/var/log/*/a.log'])).toBe(false)
    expect(isAllowedLogFile('/etc/hosts', ['/etc/*'], ['/etc/'])).toBe(false)
  })

  it('does not backtrack catastrophically on many stars', () => {
    const pattern = `/var/log/${'a*'.repeat(40)}b`
    const started = Date.now()
    expect(isAllowedLogFile(`/var/log/${'a'.repeat(150)}`, [pattern])).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('quoteArg', () => {
  it.each<[string, string | null]>([
    ['tail', 'tail'],
    ['/var/log/app/x.log', '/var/log/app/x.log'],
    ['--sort=-pcpu', '--sort=-pcpu'],
    ['pid,user', 'pid,user'],
    ['release_error.log*', "'release_error.log*'"],
    ['app-????.log', "'app-????.log'"],
    ['upstream timed out', "'upstream timed out'"],
    ['#123', "'#123'"],
    ['100%', "'100%'"],
    ['f(x)', "'f(x)'"],
    ["it's", null],
    ['a"b', null],
    ['a\\b', null],
    ['$HOME', null],
    ['`id`', null],
    ['a;b', null],
    ['a|b', null],
    ['a&b', null],
    ['a<b', null],
    ['a>b', null],
    ['a\nb', null],
    ['a\tb', null],
    ['~', null],
    ['', null],
  ])('%p -> %p', (arg, expected) => {
    expect(quoteArg(arg)).toBe(expected)
  })
})

describe('log_list / log_tail / log_grep argv', () => {
  const OPTIONS = {
    allowedLogPaths: ['/var/log/app/release_error.log*', '/var/log/syslog', '/opt/myapp/logs/*.log'],
    allowedLogRoots: ['/opt/myapp/'],
  }

  it.each<[string, Record<string, unknown>, Record<string, string | number>, string[], string]>([
    [
      'log_list',
      { pattern: '/var/log/app/release_error.log*' },
      { pattern: '/var/log/app/release_error.log*' },
      ['find', '/var/log/app', '-maxdepth', '1', '-type', 'f', '-name', 'release_error.log*', '-ls'],
      "find /var/log/app -maxdepth 1 -type f -name 'release_error.log*' -ls",
    ],
    [
      'log_list',
      { pattern: '/opt/myapp/logs/*.log' },
      { pattern: '/opt/myapp/logs/*.log' },
      ['find', '/opt/myapp/logs', '-maxdepth', '1', '-type', 'f', '-name', '*.log', '-ls'],
      "find /opt/myapp/logs -maxdepth 1 -type f -name '*.log' -ls",
    ],
    [
      'log_tail',
      { path: '/var/log/app/release_error.log.1', lines: 20 },
      { path: '/var/log/app/release_error.log.1', lines: 20 },
      ['tail', '-n', '20', '--', '/var/log/app/release_error.log.1'],
      'tail -n 20 -- /var/log/app/release_error.log.1',
    ],
    [
      'log_tail',
      { path: '/var/log/app/release_error.log.2.gz', lines: 20 },
      { path: '/var/log/app/release_error.log.2.gz', lines: 20 },
      ['gzip', '-dc', '--', '/var/log/app/release_error.log.2.gz'],
      'gzip -dc -- /var/log/app/release_error.log.2.gz',
    ],
    [
      'log_grep',
      { path: '/var/log/syslog', text: 'Out of memory' },
      { path: '/var/log/syslog', text: 'Out of memory', lines: 100 },
      ['grep', '-F', '-n', '-e', 'Out of memory', '--', '/var/log/syslog'],
      "grep -F -n -e 'Out of memory' -- /var/log/syslog",
    ],
    [
      'log_grep',
      { path: '/var/log/app/release_error.log.3.gz', text: 'ERROR', lines: 5 },
      { path: '/var/log/app/release_error.log.3.gz', text: 'ERROR', lines: 5 },
      ['zgrep', '-F', '-n', '-e', 'ERROR', '--', '/var/log/app/release_error.log.3.gz'],
      'zgrep -F -n -e ERROR -- /var/log/app/release_error.log.3.gz',
    ],
    [
      'log_grep',
      { path: '/opt/myapp/logs/a.log', text: 'user@example.com (id=1) 100% #2 a:b/c,d+e-f' },
      { path: '/opt/myapp/logs/a.log', text: 'user@example.com (id=1) 100% #2 a:b/c,d+e-f', lines: 100 },
      ['grep', '-F', '-n', '-e', 'user@example.com (id=1) 100% #2 a:b/c,d+e-f', '--', '/opt/myapp/logs/a.log'],
      "grep -F -n -e 'user@example.com (id=1) 100% #2 a:b/c,d+e-f' -- /opt/myapp/logs/a.log",
    ],
  ])('%s %j', (id, params, expectedParams, argv, command) => {
    const built = buildReadonlyDiagnostic(id, params, OPTIONS)
    expect(built).toEqual({ id, params: expectedParams, argv })
    expect(readonlyDiagnosticCommandText(built!.argv)).toBe(command)
    expect(validateCommand(command)).toBeNull()
  })

  it.each<[string, string, Record<string, unknown>]>([
    ['log_list pattern not configured', 'log_list', { pattern: '/var/log/app/*' }],
    ['log_list concrete file instead of the pattern', 'log_list', { pattern: '/var/log/app/release_error.log' }],
    ['log_list extra key', 'log_list', { pattern: '/var/log/syslog', lines: 10 }],
    ['log_list missing pattern', 'log_list', {}],
    ['log_list non-string pattern', 'log_list', { pattern: 1 }],
    ['log_tail with a pattern as path', 'log_tail', { path: '/var/log/app/release_error.log*' }],
    ['log_tail file not matching', 'log_tail', { path: '/var/log/app/other.log' }],
    ['log_tail secret name matched by a pattern', 'log_tail', { path: '/var/log/app/release_error.log.key' }],
    ['log_grep missing text', 'log_grep', { path: '/var/log/syslog' }],
    ['log_grep empty text', 'log_grep', { path: '/var/log/syslog', text: '' }],
    ['log_grep 101-char text', 'log_grep', { path: '/var/log/syslog', text: 'a'.repeat(101) }],
    ['log_grep quote in text', 'log_grep', { path: '/var/log/syslog', text: "it's" }],
    ['log_grep * in text', 'log_grep', { path: '/var/log/syslog', text: 'a*' }],
    ['log_grep ? in text', 'log_grep', { path: '/var/log/syslog', text: 'a?' }],
    ['log_grep $ in text', 'log_grep', { path: '/var/log/syslog', text: '$HOME' }],
    ['log_grep ; in text', 'log_grep', { path: '/var/log/syslog', text: 'a;b' }],
    ['log_grep | in text', 'log_grep', { path: '/var/log/syslog', text: 'a|b' }],
    ['log_grep backslash in text', 'log_grep', { path: '/var/log/syslog', text: 'a\\b' }],
    ['log_grep newline in text', 'log_grep', { path: '/var/log/syslog', text: 'a\nb' }],
    ['log_grep tab in text', 'log_grep', { path: '/var/log/syslog', text: 'a\tb' }],
    ['log_grep non-string text', 'log_grep', { path: '/var/log/syslog', text: 1 }],
    ['log_grep lines=0', 'log_grep', { path: '/var/log/syslog', text: 'a', lines: 0 }],
    ['log_grep lines=201', 'log_grep', { path: '/var/log/syslog', text: 'a', lines: 201 }],
    ['log_grep path not allowed', 'log_grep', { path: '/var/log/auth.log', text: 'a' }],
    ['log_grep extra key', 'log_grep', { path: '/var/log/syslog', text: 'a', pattern: 'x' }],
  ])('rejects %s', (_label, id, params) => {
    expect(buildReadonlyDiagnostic(id, params, OPTIONS)).toBeNull()
  })

  it('accepts a 100-char grep text and the lines bounds', () => {
    expect(buildReadonlyDiagnostic('log_grep', { path: '/var/log/syslog', text: 'a'.repeat(100), lines: 200 }, OPTIONS)).not.toBeNull()
    expect(buildReadonlyDiagnostic('log_grep', { path: '/var/log/syslog', text: 'a', lines: 1 }, OPTIONS)).not.toBeNull()
  })

  it('log_list for a literal pattern lists exactly that name', () => {
    expect(buildReadonlyDiagnostic('log_list', { pattern: '/var/log/syslog' }, OPTIONS)?.argv).toEqual([
      'find', '/var/log', '-maxdepth', '1', '-type', 'f', '-name', 'syslog', '-ls',
    ])
  })

  it('rejects log_list when the configured pattern is invalid', () => {
    expect(
      buildReadonlyDiagnostic('log_list', { pattern: '/var/log/app/*.pem' }, { allowedLogPaths: ['/var/log/app/*.pem'] }),
    ).toBeNull()
    expect(
      buildReadonlyDiagnostic('log_list', { pattern: '/opt/myapp/logs/*.log' }, { allowedLogPaths: ['/opt/myapp/logs/*.log'] }),
    ).toBeNull()
  })

  it('grep text that hits the command blocklist is still built (the handler rejects it via validateCommand)', () => {
    const built = buildReadonlyDiagnostic('log_grep', { path: '/var/log/syslog', text: 'sudo' }, OPTIONS)
    expect(validateCommand(readonlyDiagnosticCommandText(built!.argv)!)).not.toBeNull()
  })
})

describe('buildLogDirPreflight', () => {
  it('builds readlink -e for the pattern directory (without trailing /)', () => {
    expect(buildLogDirPreflight('/var/log/app/release_error.log*')).toEqual({
      dir: '/var/log/app',
      resolve: ['readlink', '-e', '--', '/var/log/app'],
    })
    expect(buildLogDirPreflight('/var/log/*')).toEqual({ dir: '/var/log', resolve: ['readlink', '-e', '--', '/var/log'] })
    expect(buildLogDirPreflight('/opt/myapp/logs/*.log', ['/opt/myapp/'])).toEqual({
      dir: '/opt/myapp/logs',
      resolve: ['readlink', '-e', '--', '/opt/myapp/logs'],
    })
  })

  it('refuses an invalid pattern', () => {
    expect(buildLogDirPreflight('/opt/myapp/logs/*.log')).toBeNull()
    expect(buildLogDirPreflight('/var/log/*/x')).toBeNull()
  })

  it('produces a command that passes validateCommand', () => {
    expect(validateCommand(readonlyDiagnosticCommandText(buildLogDirPreflight('/var/log/*')!.resolve)!)).toBeNull()
  })
})

describe('filterLogListOutput', () => {
  const line = (name: string) => `  1234   8 -rw-r----- 1 syslog adm  4096 Nov 22 10:00 /var/log/app/${name}`

  it('keeps ordinary lines and drops lines whose file name looks secret', () => {
    const text = [
      line('release_error.log'),
      line('release_error.log.pem'),
      line('id_rsa'),
      line('release_error.log.1'),
      line('.ENV.local'),
      '',
    ].join('\n')
    expect(filterLogListOutput(text)).toBe([line('release_error.log'), line('release_error.log.1'), ''].join('\n'))
  })

  it('drops secret names inside error messages too', () => {
    const text = [
      'Exit code: 1',
      'STDOUT:',
      line('a.log'),
      'STDERR:',
      "find: '/var/log/app/server.pem': Permission denied",
      "find: '/var/log/app/b.log': Permission denied",
    ].join('\n')
    expect(filterLogListOutput(text)).toBe(
      ['Exit code: 1', 'STDOUT:', line('a.log'), 'STDERR:', "find: '/var/log/app/b.log': Permission denied"].join('\n'),
    )
  })

  it(`cuts to ${READONLY_LOG_LIST_MAX_LINES} lines`, () => {
    const text = Array.from({ length: 300 }, (_, i) => line(`a${i}.log`)).join('\n')
    expect(filterLogListOutput(text).split('\n')).toHaveLength(200)
  })
})

describe('LastLines', () => {
  it('keeps only the last N lines', () => {
    const ring = new LastLines(3)
    for (let i = 0; i < 10; i++) ring.push(`l${i}`)
    expect(ring.text()).toBe('l7\nl8\nl9\n')
  })

  it('returns everything when fewer lines arrived', () => {
    const ring = new LastLines(3)
    ring.push('a')
    expect(ring.text()).toBe('a\n')
    expect(new LastLines(3).text()).toBe('')
  })

  it('pins the 256 MiB stream cap', () => {
    expect(READONLY_LOG_STREAM_MAX_BYTES).toBe(256 * 1024 * 1024)
  })
})
