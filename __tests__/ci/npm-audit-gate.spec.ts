import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * `.github/scripts/npm-audit-gate.js` の検証。
 *
 * `npm audit` には勧告単位の除外が無いため、CI ではこのスクリプトが
 * `npm audit --json` を解釈して「期限付き・勧告ID＋パッケージ名一致」の除外だけを許す。
 * ゲートの抜け道にならないよう、失敗側（fail closed）の分岐を中心に固定する。
 *
 * npm は実行しない。`main` に監査ランナーを注入し、npm audit v7+ と同じ形の
 * JSON（`vulnerabilities` マップ、`via` に文字列と勧告オブジェクトが混在）を与える。
 * 同様に、除外の前提条件を検査する 2 つのランナーも注入する:
 *   - `runAuditOmitDev`: `npm audit --omit=dev --json`（除外は dev 依存専用であることの検査）
 *   - `runRegistryVersions`: `npm view <pkg> versions --json`（修正版が未公開であることの検査）
 */

interface Advisory {
  id: string | null
  name: string
  severity: string
  title: string
  url: string
  range: string
}

type RunnerResult = { stdout: string; status: number | null }

interface Exclusion {
  id: string
  package: string
  reason: string
  expires: string
}

interface MainOptions {
  argv: string[]
  cwd: string
  now: Date
  runAudit: () => RunnerResult
  runAuditOmitDev: () => RunnerResult
  runRegistryVersions: (pkg: string) => RunnerResult
  log?: (msg: string) => void
  error?: (msg: string) => void
}

interface GateModule {
  parseArgs: (
    argv: string[],
    cwd: string,
  ) => { auditLevel: string; exclusionsPath: string; exclusionsExplicit: boolean }
  parseAuditReport: (stdout: string) => Record<string, any>
  collectAdvisories: (report: Record<string, any>) => Advisory[]
  validateExclusions: (data: unknown) => Exclusion[]
  evaluate: (input: {
    advisories: Advisory[]
    exclusions: Exclusion[]
    auditLevel: string
    now: Date
  }) => { excluded: Array<Advisory & { expires: string }>; violations: string[] }
  checkFixNotPublished: (
    advisory: Advisory,
    runRegistryVersions: (pkg: string) => RunnerResult,
  ) => string | null
  checkDevOnly: (
    excluded: Advisory[],
    runAuditOmitDev: () => RunnerResult,
  ) => string[]
  main: (options: MainOptions) => number
}

const gate = require('../../.github/scripts/npm-audit-gate.js') as GateModule

const NOW = new Date('2026-10-04T12:00:00Z')

const BRACES_ADVISORY = {
  source: 1240992,
  name: 'braces',
  dependency: 'braces',
  title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  severity: 'high',
  cwe: ['CWE-674'],
  range: '<=3.0.3',
}

/**
 * 実際の `npm audit --json`（auditReportVersion 2）と同じ形のレポートを組み立てる。
 *
 * `fixAvailable: true` は実測値をそのまま写している。braces には修正版が存在しない
 * （range `<=3.0.3`・公開済み最新が 3.0.3）にもかかわらず npm は true を返すため、
 * ゲートは `fixAvailable` を**意図的に無視**し、レジストリの公開バージョンで判定する。
 */
function report(extraAdvisories: Record<string, any>[] = []): Record<string, any> {
  const vulnerabilities: Record<string, any> = {
    braces: {
      name: 'braces',
      severity: 'high',
      isDirect: false,
      via: [BRACES_ADVISORY],
      effects: ['micromatch'],
      range: '<=3.0.3',
      nodes: ['node_modules/braces'],
      fixAvailable: true,
    },
    micromatch: {
      name: 'micromatch',
      severity: 'high',
      isDirect: false,
      via: ['braces'],
      effects: ['@jest/core'],
      range: '<=4.0.8',
      nodes: ['node_modules/micromatch'],
      fixAvailable: true,
    },
    '@jest/core': {
      name: '@jest/core',
      severity: 'high',
      isDirect: false,
      // 同じ勧告オブジェクトが別ノードの via にも現れる（重複排除の対象）
      via: ['micromatch', BRACES_ADVISORY],
      effects: ['jest'],
      range: '<=30.2.0',
      nodes: ['node_modules/@jest/core'],
      fixAvailable: true,
    },
  }
  for (const adv of extraAdvisories) {
    vulnerabilities[adv.name] = {
      name: adv.name,
      severity: adv.severity,
      isDirect: false,
      via: [adv],
      effects: [],
      range: adv.range,
      nodes: [`node_modules/${adv.name}`],
      fixAvailable: true,
    }
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { high: 3, total: 3 } },
  }
}

const BRACES_EXCLUSION: Exclusion = {
  id: 'GHSA-vfj7-8cjw-p6xm',
  package: 'braces',
  reason: '修正版なし',
  expires: '2026-11-30',
}

function evaluateWith(
  rep: Record<string, any>,
  exclusions: Exclusion[],
  auditLevel = 'high',
  now = NOW,
) {
  return gate.evaluate({
    advisories: gate.collectAdvisories(rep),
    exclusions,
    auditLevel,
    now,
  })
}

describe('npm-audit-gate: 勧告の収集', () => {
  it('via のオブジェクトだけを勧告として集め、GHSA ID で重複排除する', () => {
    const advisories = gate.collectAdvisories(report())
    expect(advisories).toEqual([
      {
        id: 'GHSA-vfj7-8cjw-p6xm',
        name: 'braces',
        severity: 'high',
        title: BRACES_ADVISORY.title,
        url: BRACES_ADVISORY.url,
        range: '<=3.0.3',
      },
    ])
  })

  it('URL から GHSA ID を取れない勧告は id が null になる', () => {
    const advisories = gate.collectAdvisories(
      report([
        {
          source: 1,
          name: 'leftpad',
          title: 'npm 独自勧告',
          url: 'https://www.npmjs.com/advisories/1',
          severity: 'high',
          range: '*',
        },
      ]),
    )
    expect(advisories.find((a) => a.name === 'leftpad')?.id).toBeNull()
  })
})

describe('npm-audit-gate: 判定', () => {
  it('有効な除外（ID とパッケージ名が一致）の勧告は通過する', () => {
    const result = evaluateWith(report(), [BRACES_EXCLUSION])
    expect(result.violations).toEqual([])
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0]).toMatchObject({ id: 'GHSA-vfj7-8cjw-p6xm', expires: '2026-11-30' })
  })

  it('期限当日（UTC）はまだ有効', () => {
    const result = evaluateWith(report(), [BRACES_EXCLUSION], 'high', new Date('2026-11-30T23:59:59Z'))
    expect(result.violations).toEqual([])
  })

  it('同じ ID でもパッケージ名が違う除外では通過しない', () => {
    const result = evaluateWith(report(), [{ ...BRACES_EXCLUSION, package: 'micromatch' }])
    // 勧告そのものの違反と、使われていない除外の両方が出る
    expect(result.excluded).toEqual([])
    expect(result.violations).toHaveLength(2)
    expect(result.violations[0]).toContain('GHSA-vfj7-8cjw-p6xm braces [high]')
    expect(result.violations[1]).toMatch(/Unused exclusion GHSA-vfj7-8cjw-p6xm \(micromatch\)/)
  })

  it('除外されていない high の勧告は違反', () => {
    const extra = {
      source: 2,
      name: 'lodash',
      title: 'Prototype Pollution',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      severity: 'high',
      range: '<4.17.21',
    }
    const result = evaluateWith(report([extra]), [BRACES_EXCLUSION])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('GHSA-aaaa-bbbb-cccc')
    expect(result.violations[0]).toContain('lodash')
    expect(result.violations[0]).toContain('high')
    expect(result.violations[0]).toContain('Prototype Pollution')
    expect(result.violations[0]).toContain(extra.url)
  })

  it('critical も high レベルでは違反', () => {
    const extra = {
      source: 3,
      name: 'evil',
      title: 'RCE',
      url: 'https://github.com/advisories/GHSA-cccc-dddd-eeee',
      severity: 'critical',
      range: '*',
    }
    const result = evaluateWith(report([extra]), [BRACES_EXCLUSION])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('GHSA-cccc-dddd-eeee')
  })

  it('監査レベル未満（moderate）の勧告は除外なしでも通過する', () => {
    const extra = {
      source: 4,
      name: 'minor',
      title: 'ReDoS',
      url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
      severity: 'moderate',
      range: '*',
    }
    const result = evaluateWith(report([extra]), [BRACES_EXCLUSION])
    expect(result.violations).toEqual([])
  })

  it('期限切れの除外は（勧告に一致していても）違反', () => {
    const result = evaluateWith(report(), [{ ...BRACES_EXCLUSION, expires: '2026-10-01' }])
    expect(result.violations.some((v) => v.includes('2026-10-01') && v.includes('GHSA-vfj7-8cjw-p6xm'))).toBe(true)
    // 期限切れの除外は効かないので勧告自体も違反になる
    expect(result.excluded).toEqual([])
  })

  it('どの勧告にも一致しない有効な除外は「未使用」として違反', () => {
    const result = evaluateWith(report(), [
      BRACES_EXCLUSION,
      { id: 'GHSA-zzzz-yyyy-xxxx', package: 'gone', reason: '解消済み', expires: '2026-12-31' },
    ])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('GHSA-zzzz-yyyy-xxxx')
  })

  it('GHSA URL を持たない勧告は除外できない', () => {
    const extra = {
      source: 5,
      name: 'leftpad',
      title: 'npm 独自勧告',
      url: 'https://www.npmjs.com/advisories/5',
      severity: 'high',
      range: '*',
    }
    const result = evaluateWith(report([extra]), [BRACES_EXCLUSION])
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain('leftpad')
  })
})

describe('npm-audit-gate: 除外ファイルの検証', () => {
  it('正しい形式なら配列をそのまま返す', () => {
    expect(gate.validateExclusions([BRACES_EXCLUSION])).toEqual([BRACES_EXCLUSION])
  })

  it.each([
    ['配列でない', { id: 'GHSA-vfj7-8cjw-p6xm' }],
    ['ID の形式が違う', [{ ...BRACES_EXCLUSION, id: 'CVE-2024-4068' }]],
    ['package が空', [{ ...BRACES_EXCLUSION, package: '' }]],
    ['reason が無い', [{ id: BRACES_EXCLUSION.id, package: 'braces', expires: '2026-11-30' }]],
    ['expires が無い', [{ id: BRACES_EXCLUSION.id, package: 'braces', reason: 'x' }]],
    ['expires が日付形式でない', [{ ...BRACES_EXCLUSION, expires: '2026/11/30' }]],
    ['expires が存在しない日付', [{ ...BRACES_EXCLUSION, expires: '2026-02-30' }]],
    ['要素がオブジェクトでない', ['GHSA-vfj7-8cjw-p6xm']],
  ])('不正な除外（%s）は例外', (_label, data) => {
    expect(() => gate.validateExclusions(data)).toThrow()
  })
})

describe('npm-audit-gate: 修正版が未公開であることの検査', () => {
  const braces = (): Advisory => gate.collectAdvisories(report())[0]
  const versions = (list: unknown, status: number | null = 0) => (): RunnerResult => ({
    stdout: JSON.stringify(list),
    status,
  })

  it('脆弱範囲内の最古の版より新しい範囲外の安定版が無ければ通過（null）', () => {
    expect(gate.checkFixNotPublished(braces(), versions(['2.3.2', '3.0.2', '3.0.3']))).toBeNull()
  })

  it('プレリリースは修正版とみなさない', () => {
    expect(gate.checkFixNotPublished(braces(), versions(['3.0.3', '3.0.4-beta.1']))).toBeNull()
  })

  it('脆弱範囲外の版が公開済みなら違反（lockfile 更新と除外削除を促す）', () => {
    const v = gate.checkFixNotPublished(braces(), versions(['3.0.2', '3.0.3', '3.0.4']))
    expect(v).toContain('GHSA-vfj7-8cjw-p6xm')
    expect(v).toContain('braces')
    expect(v).toContain('3.0.4')
    expect(v).toMatch(/fixed version .*published/)
  })

  it('レジストリへ問い合わせるパッケージ名は勧告のパッケージ', () => {
    const run = jest.fn(versions(['3.0.3']))
    gate.checkFixNotPublished(braces(), run)
    expect(run).toHaveBeenCalledWith('braces')
  })

  it('単一バージョンの文字列出力も解釈する', () => {
    expect(gate.checkFixNotPublished(braces(), versions('3.0.3'))).toBeNull()
    // 唯一の公開版 4.0.0 は range `<=3.0.3` に入らない＝range がどの公開版にも一致しない → fail closed
    expect(gate.checkFixNotPublished(braces(), versions('4.0.0'))).toMatch(/matches no published/)
  })

  it('保守ラインの修正版も検出する（range `<3.0.4 || >=4.0.0`・公開 3.0.3/3.0.4/4.0.0 → 3.0.4）', () => {
    // 最上位の安定版 4.0.0 は再び脆弱範囲内だが、3.0.x ラインの 3.0.4 は修正版。
    const v = gate.checkFixNotPublished(
      { ...braces(), range: '<3.0.4 || >=4.0.0' },
      versions(['3.0.3', '3.0.4', '4.0.0']),
    )
    expect(v).not.toBeNull()
    expect(v).toContain('3.0.4')
    expect(v).toMatch(/fixed version .*published/)
  })

  it('脆弱性混入より前の版は修正版とみなさない（range `>=2.0.0 <=3.0.3`・公開 1.0.0/2.0.0/3.0.3 → 通過）', () => {
    expect(
      gate.checkFixNotPublished({ ...braces(), range: '>=2.0.0 <=3.0.3' }, versions(['1.0.0', '2.0.0', '3.0.3'])),
    ).toBeNull()
  })

  it('range がどの公開安定版にも一致しない勧告は違反（検証不能＝fail closed）', () => {
    const v = gate.checkFixNotPublished({ ...braces(), range: '>=9.0.0' }, versions(['1.0.0', '2.0.0', '3.0.3']))
    expect(v).not.toBeNull()
    expect(v).toContain('GHSA-vfj7-8cjw-p6xm')
    expect(v).toMatch(/matches no published/)
    expect(v).not.toMatch(/fixed version .*published/)
  })

  it.each([
    ['ランナーが例外', () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    }],
    ['非ゼロ終了', versions(['3.0.3'], 1)],
    ['JSON でない出力', () => ({ stdout: 'npm ERR! 404', status: 0 })],
    ['npm のエラー JSON', () => ({ stdout: JSON.stringify({ error: { code: 'E404' } }), status: 0 })],
    ['安定版が 1 つも無い', versions(['1.0.0-rc.1'])],
    ['配列でも文字列でもない', versions({ latest: '3.0.3' })],
  ])('レジストリ照会の失敗（%s）は違反（fail closed）', (_label, run) => {
    const v = gate.checkFixNotPublished(braces(), run as () => RunnerResult)
    expect(v).not.toBeNull()
    expect(v).toContain('GHSA-vfj7-8cjw-p6xm')
  })

  it.each([['不正な range', 'not a range!!'], ['range が空', '']])(
    '%s の勧告は違反（fail closed）',
    (_label, range) => {
      const v = gate.checkFixNotPublished({ ...braces(), range }, versions(['3.0.3']))
      expect(v).not.toBeNull()
      expect(v).toContain('range')
    },
  )
})

describe('npm-audit-gate: 除外は dev 依存専用であることの検査', () => {
  const excluded = (): Advisory[] => gate.collectAdvisories(report())
  const omitDev = (rep: Record<string, any>) => (): RunnerResult => ({
    stdout: JSON.stringify(rep),
    status: 0,
  })

  it('本番依存のレポートに現れなければ違反なし', () => {
    expect(gate.checkDevOnly(excluded(), omitDev({ auditReportVersion: 2, vulnerabilities: {} }))).toEqual([])
  })

  it('除外した勧告が本番依存のレポートにも現れたら違反', () => {
    const v = gate.checkDevOnly(excluded(), omitDev(report()))
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('GHSA-vfj7-8cjw-p6xm')
    expect(v[0]).toContain('braces')
    expect(v[0]).toMatch(/production dependencies/)
  })

  it('同じ ID でもパッケージが違えば一致しない', () => {
    const other = {
      ...BRACES_ADVISORY,
      name: 'not-braces',
      dependency: 'not-braces',
    }
    const rep = { auditReportVersion: 2, vulnerabilities: { 'not-braces': { name: 'not-braces', via: [other] } } }
    expect(gate.checkDevOnly(excluded(), omitDev(rep))).toEqual([])
  })

  it.each([
    ['ランナーが例外', () => {
      throw new Error('spawn npm ENOENT')
    }],
    ['JSON でない出力', () => ({ stdout: 'oops', status: 1 })],
    ['npm のエラー JSON', () => ({ stdout: JSON.stringify({ error: { code: 'ENOLOCK' } }), status: 1 })],
    ['vulnerabilities が無い', () => ({ stdout: JSON.stringify({}), status: 0 })],
  ])('--omit=dev 監査の失敗（%s）は違反（fail closed）', (_label, run) => {
    const v = gate.checkDevOnly(excluded(), run as () => RunnerResult)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/omit=dev/)
  })
})

describe('npm-audit-gate: 引数', () => {
  it('--audit-level と既定の除外ファイルパスを解釈する', () => {
    expect(gate.parseArgs(['--audit-level=high'], '/repo')).toEqual({
      auditLevel: 'high',
      exclusionsPath: join('/repo', '.github', 'npm-audit-exclusions.json'),
      exclusionsExplicit: false,
    })
  })

  it('--exclusions を明示できる', () => {
    expect(gate.parseArgs(['--audit-level=critical', '--exclusions=x/y.json'], '/repo')).toEqual({
      auditLevel: 'critical',
      exclusionsPath: join('/repo', 'x', 'y.json'),
      exclusionsExplicit: true,
    })
  })

  it.each([[[]], [['--audit-level=severe']], [['--audit-level=high', '--bogus']], [['--audit-level=']]])(
    '不正な引数 %j は例外',
    (argv) => {
      expect(() => gate.parseArgs(argv, '/repo')).toThrow()
    },
  )
})

describe('npm-audit-gate: 監査出力の解釈', () => {
  it('解釈できない出力は例外', () => {
    expect(() => gate.parseAuditReport('npm WARN something\nnot json')).toThrow()
  })

  it('error フィールドを持つ出力は例外', () => {
    expect(() =>
      gate.parseAuditReport(JSON.stringify({ error: { code: 'ENOLOCK', summary: 'no lockfile' } })),
    ).toThrow(/ENOLOCK|no lockfile/)
  })

  it('vulnerabilities が無い出力は例外', () => {
    expect(() => gate.parseAuditReport(JSON.stringify({ auditReportVersion: 2 }))).toThrow()
  })

  it('勧告ゼロ（空の vulnerabilities）は正常', () => {
    expect(gate.parseAuditReport(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }))).toEqual({
      auditReportVersion: 2,
      vulnerabilities: {},
    })
  })
})

describe('npm-audit-gate: main（監査ランナー注入）', () => {
  let dir: string
  const logs: string[] = []
  const errors: string[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'))
    logs.length = 0
    errors.length = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeExclusions(data: unknown, rel = join('.github', 'npm-audit-exclusions.json')): void {
    const full = join(dir, rel)
    require('fs').mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data))
  }

  const EMPTY_REPORT = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} })
  /** 既定: 本番依存には勧告なし・braces の公開済み最新はまだ脆弱（3.0.3）。 */
  const okOmitDev = (): RunnerResult => ({ stdout: EMPTY_REPORT, status: 0 })
  const okRegistry = (): RunnerResult => ({ stdout: JSON.stringify(['3.0.2', '3.0.3']), status: 0 })

  function run(
    argv: string[],
    stdout: string,
    status: number | null = 1,
    overrides: Partial<Pick<MainOptions, 'runAuditOmitDev' | 'runRegistryVersions'>> = {},
  ): number {
    return gate.main({
      argv,
      cwd: dir,
      now: NOW,
      runAudit: () => ({ stdout, status }),
      runAuditOmitDev: okOmitDev,
      runRegistryVersions: okRegistry,
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
      ...overrides,
    })
  }

  it('除外が効けば npm の非ゼロ終了でも 0 を返し、除外内容を表示する', () => {
    writeExclusions([BRACES_EXCLUSION])
    expect(run(['--audit-level=high'], JSON.stringify(report()))).toBe(0)
    expect(logs.join('\n')).toContain('GHSA-vfj7-8cjw-p6xm')
    expect(logs.join('\n')).toContain('2026-11-30')
  })

  it('除外が無ければ 1', () => {
    writeExclusions([])
    expect(run(['--audit-level=high'], JSON.stringify(report()))).toBe(1)
    expect(errors.join('\n')).toContain('GHSA-vfj7-8cjw-p6xm')
  })

  it('既定パスの除外ファイルが無ければ空扱い（勧告があれば 1、無ければ 0）', () => {
    expect(run(['--audit-level=high'], JSON.stringify(report()))).toBe(1)
    expect(run(['--audit-level=high'], JSON.stringify({ vulnerabilities: {} }), 0)).toBe(0)
  })

  it('明示した除外ファイルが無ければ 1', () => {
    expect(
      run(['--audit-level=high', '--exclusions=missing.json'], JSON.stringify({ vulnerabilities: {} }), 0),
    ).toBe(1)
    expect(errors.join('\n')).toContain('missing.json')
  })

  it('壊れた除外ファイル（JSON 不正）は 1', () => {
    writeExclusions('[{"id": ')
    expect(run(['--audit-level=high'], JSON.stringify({ vulnerabilities: {} }), 0)).toBe(1)
  })

  it('スキーマ不正な除外ファイルは 1', () => {
    writeExclusions([{ ...BRACES_EXCLUSION, expires: 'someday' }])
    expect(run(['--audit-level=high'], JSON.stringify(report()))).toBe(1)
  })

  it('npm のエラー JSON は 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    expect(
      run(['--audit-level=high'], JSON.stringify({ error: { code: 'EAUDITNOLOCK', summary: 'x' } })),
    ).toBe(1)
  })

  it('解釈できない監査出力は 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    expect(run(['--audit-level=high'], '')).toBe(1)
  })

  it('不正な --audit-level は 1（監査を実行しない）', () => {
    const runAudit = jest.fn(() => ({ stdout: '{}', status: 0 }))
    const code = gate.main({
      argv: ['--audit-level=hihg'],
      cwd: dir,
      now: NOW,
      runAudit,
      runAuditOmitDev: okOmitDev,
      runRegistryVersions: okRegistry,
      log: () => undefined,
      error: (m) => errors.push(m),
    })
    expect(code).toBe(1)
    expect(runAudit).not.toHaveBeenCalled()
  })

  it('監査ランナーが例外を投げたら 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    const code = gate.main({
      argv: ['--audit-level=high'],
      cwd: dir,
      now: NOW,
      runAudit: () => {
        throw new Error('spawn npm ENOENT')
      },
      runAuditOmitDev: okOmitDev,
      runRegistryVersions: okRegistry,
      log: () => undefined,
      error: (m) => errors.push(m),
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('ENOENT')
  })
  it('除外した勧告の修正版が公開済みなら 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    const code = run(['--audit-level=high'], JSON.stringify(report()), 1, {
      runRegistryVersions: () => ({ stdout: JSON.stringify(['3.0.3', '3.0.4']), status: 0 }),
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('3.0.4')
  })

  it('レジストリ照会に失敗したら 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    const code = run(['--audit-level=high'], JSON.stringify(report()), 1, {
      runRegistryVersions: () => {
        throw new Error('ETIMEDOUT')
      },
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('ETIMEDOUT')
  })

  it('除外した勧告が本番依存にも現れたら 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    const code = run(['--audit-level=high'], JSON.stringify(report()), 1, {
      runAuditOmitDev: () => ({ stdout: JSON.stringify(report()), status: 1 }),
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/production dependencies/)
  })

  it('--omit=dev 監査が失敗したら 1', () => {
    writeExclusions([BRACES_EXCLUSION])
    const code = run(['--audit-level=high'], JSON.stringify(report()), 1, {
      runAuditOmitDev: () => ({ stdout: '', status: 1 }),
    })
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/omit=dev/)
  })

  it('除外が使われないときは前提条件の検査（追加の npm 実行）を行わない', () => {
    writeExclusions([])
    const runAuditOmitDev = jest.fn(okOmitDev)
    const runRegistryVersions = jest.fn(okRegistry)
    expect(run(['--audit-level=high'], EMPTY_REPORT, 0, { runAuditOmitDev, runRegistryVersions })).toBe(0)
    expect(runAuditOmitDev).not.toHaveBeenCalled()
    expect(runRegistryVersions).not.toHaveBeenCalled()
  })
})
