import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../../src/logger'
import {
  ensureProjectGuacdContainer,
  extractGuacdSystemCaBundle,
  GUACD_CONTAINER_NAME,
  GUACD_EXEC_TIMEOUT_MS,
  GUACD_NETWORK_NAME,
  invalidateProjectTrustStore,
  removeLegacySharedGuacd,
  removeProjectGuacdNetwork,
  removeProjectTrustStore,
  resolveProjectGuacdIdentity,
  stopProjectGuacdContainer,
  type ProjectGuacdIdentity,
} from '../../src/rdp/guacd-container'

jest.mock('../../src/logger')
// linkSync だけ差し替え可能にする（既定は本物）。
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    linkSync: jest.fn(actual.linkSync),
    rmSync: jest.fn(actual.rmSync),
    writeFileSync: jest.fn(actual.writeFileSync),
  }
})
jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('../../src/docker/docker-utils', () => ({
  getDockerPath: () => '/usr/bin/docker',
}))

/**
 * Docker 形態のプロジェクト別 guacd。
 *
 * 以前は全プロジェクトが 1 つの `ais-guacd`（`ais-rdp` ネットワーク）を共有して
 * いた。信頼する CA はプロジェクトごとに違うため、guacd の信頼ストア
 * （`SSL_CERT_FILE`）を分けるには guacd 自体を分けるしかない。
 */

const exec = execFileSync as jest.Mock
const calls = (): string[][] => exec.mock.calls.map((c) => c[1] as string[])
const callsFor = (sub: string): string[][] => calls().filter((a) => a[0] === sub)

const SYSTEM_BUNDLE = '-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n'

let configDir: string
let id: ProjectGuacdIdentity

/** docker inspect --format '{{json .}}' が返す形（必要な部分だけ）。 */
function inspected(
  overrides: {
    running?: boolean
    labels?: Record<string, string>
    env?: string[]
    mounts?: { Source: string; Destination: string }[]
  } = {},
): string {
  return JSON.stringify({
    State: { Running: overrides.running ?? true },
    Config: {
      Labels: overrides.labels ?? {
        'ai-support-agent.rdp.project': 'mbc/MBC_01',
        'ai-support-agent.rdp.layout': 'project-v1',
      },
      Env: 'env' in overrides ? overrides.env : ['PATH=/usr/bin', 'SSL_CERT_FILE=/run/ais-rdp-ca/bundle.pem'],
    },
    Mounts: overrides.mounts ?? [{ Source: id.caHostDir, Destination: '/run/ais-rdp-ca' }],
  })
}

/** inspect の応答を順に返す（最後の値を繰り返す）。'absent' は失敗させる。 */
function stubDocker(inspects: (string | 'absent')[], run?: () => void): void {
  let i = 0
  exec.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'inspect') {
      const answer = inspects[Math.min(i++, inspects.length - 1)]
      if (answer === 'absent') throw new Error(`Error: No such object: ${args[args.length - 1]}`)
      return answer
    }
    if (args[0] === 'run') run?.()
    return ''
  })
}

beforeEach(() => {
  exec.mockReset()
  jest.mocked(logger.warn).mockClear()
  jest.mocked(logger.info).mockClear()
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-guacd-project-'))
  id = resolveProjectGuacdIdentity({ tenantCode: 'mbc', projectCode: 'MBC_01' }, 'agent-1', configDir)
})

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
})

describe('resolveProjectGuacdIdentity', () => {
  it('★ sha256("tenant/project/agentId") の先頭 16 hex で名前を決める', () => {
    const key = createHash('sha256').update('mbc/MBC_01/agent-1').digest('hex').slice(0, 16)
    expect(id).toEqual({
      key,
      containerName: `ais-guacd-${key}`,
      networkName: `ais-rdp-${key}`,
      caHostDir: path.join(configDir, 'rdp-trusted-ca', key),
      projectRef: 'mbc/MBC_01',
    })
  })

  it('★ 区切り位置だけが違うプロジェクトを衝突させない', () => {
    const a = resolveProjectGuacdIdentity({ tenantCode: 'a_b', projectCode: 'C' }, 'x', configDir)
    const b = resolveProjectGuacdIdentity({ tenantCode: 'a', projectCode: 'B_C' }, 'x', configDir)
    expect(a.key).not.toBe(b.key)
  })

  it('★ 同じプロジェクトでもエージェントが違えば別の guacd（互いに作り直さない）', () => {
    const other = resolveProjectGuacdIdentity({ tenantCode: 'mbc', projectCode: 'MBC_01' }, 'agent-2', configDir)
    expect(other.key).not.toBe(id.key)
    expect(other.containerName).not.toBe(id.containerName)
    expect(other.caHostDir).not.toBe(id.caHostDir)
  })

  it('agentId が無ければ空として扱う', () => {
    const none = resolveProjectGuacdIdentity({ tenantCode: 'mbc', projectCode: 'MBC_01' }, undefined, configDir)
    expect(none.key).toBe(createHash('sha256').update('mbc/MBC_01/').digest('hex').slice(0, 16))
  })

  it('決定的（同じ入力は同じ名前）', () => {
    expect(resolveProjectGuacdIdentity({ tenantCode: 'mbc', projectCode: 'MBC_01' }, 'agent-1', configDir)).toEqual(id)
  })

  it('既定の設定ディレクトリを使う', () => {
    const def = resolveProjectGuacdIdentity({ tenantCode: 'mbc', projectCode: 'MBC_01' }, 'agent-1')
    expect(def.caHostDir.endsWith(path.join('rdp-trusted-ca', id.key))).toBe(true)
    expect(path.isAbsolute(def.caHostDir)).toBe(true)
  })
})

describe('ensureProjectGuacdContainer', () => {
  it('★ 無ければネットワークを作り、ラベル・SSL_CERT_FILE・信頼ストア（:ro）付きで起動する', () => {
    stubDocker(['absent'])
    const endpoint = ensureProjectGuacdContainer(id, 'guacamole/guacd:1.5.5')
    expect(endpoint).toEqual({ host: id.containerName, port: 4822 })
    expect(callsFor('network')).toEqual([['network', 'create', id.networkName]])
    expect(callsFor('rm')).toEqual([])
    expect(callsFor('run')).toEqual([
      [
        'run', '-d', '--rm',
        '--name', id.containerName,
        '--network', id.networkName,
        '--label', 'ai-support-agent.rdp.project=mbc/MBC_01',
        '--label', 'ai-support-agent.rdp.layout=project-v1',
        '-e', 'SSL_CERT_FILE=/run/ais-rdp-ca/bundle.pem',
        '-v', `${id.caHostDir}:/run/ais-rdp-ca:ro`,
        'guacamole/guacd:1.5.5',
      ],
    ])
  })

  it('★ ポートを公開しない', () => {
    stubDocker(['absent'])
    ensureProjectGuacdContainer(id)
    expect(callsFor('run')[0]).not.toContain('-p')
  })

  it('既定イメージは版固定', () => {
    stubDocker(['absent'])
    ensureProjectGuacdContainer(id)
    expect(callsFor('run')[0].at(-1)).toBe('guacamole/guacd:1.5.5')
  })

  it('★ 起動より先に信頼ストアのディレクトリを 0755 で作る', () => {
    stubDocker(['absent'], () => {
      expect(fs.statSync(id.caHostDir).isDirectory()).toBe(true)
    })
    ensureProjectGuacdContainer(id)
    expect(fs.statSync(id.caHostDir).mode & 0o777).toBe(0o755)
  })

  it('★ 構成が一致する稼働中のコンテナは再利用する', () => {
    stubDocker([inspected()])
    expect(ensureProjectGuacdContainer(id)).toEqual({ host: id.containerName, port: 4822 })
    expect(callsFor('run')).toEqual([])
    expect(callsFor('rm')).toEqual([])
  })

  it.each([
    ['ラベルが違う', { labels: { 'ai-support-agent.rdp.project': 'other/P' } }],
    ['レイアウトが古い', { labels: { 'ai-support-agent.rdp.project': 'mbc/MBC_01' } }],
    ['SSL_CERT_FILE が無い', { env: ['PATH=/usr/bin'] }],
    ['Env が null', { env: null as unknown as string[] }],
    ['マウント元が違う', { mounts: [{ Source: '/elsewhere', Destination: '/run/ais-rdp-ca' }] }],
    ['マウントが無い', { mounts: [] }],
  ])('★ 稼働中でも構成が違えば（%s）作り直す', (_label, overrides) => {
    stubDocker([inspected(overrides)])
    ensureProjectGuacdContainer(id)
    expect(callsFor('rm')).toEqual([['rm', '-f', id.containerName]])
    expect(callsFor('run')).toHaveLength(1)
  })

  it('停止した同名コンテナは消してから起動する', () => {
    stubDocker([inspected({ running: false })])
    ensureProjectGuacdContainer(id)
    expect(callsFor('rm')).toEqual([['rm', '-f', id.containerName]])
    expect(callsFor('run')).toHaveLength(1)
  })

  it('inspect の出力が読めなければ作り直す', () => {
    stubDocker(['not json'])
    ensureProjectGuacdContainer(id)
    expect(callsFor('rm')).toHaveLength(1)
    expect(callsFor('run')).toHaveLength(1)
  })

  const nameConflict = (name: string): Error =>
    Object.assign(new Error('docker run failed with exit code 125'), {
      stderr: Buffer.from(
        `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "abc".`,
      ),
    })

  it('★ 名前の衝突は、相手が一致する構成で稼働中なら採用する', () => {
    stubDocker(['absent', inspected()], () => {
      throw nameConflict(id.containerName)
    })
    expect(ensureProjectGuacdContainer(id)).toEqual({ host: id.containerName, port: 4822 })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Adopted'))
  })

  it('★ 名前の衝突でも相手の構成が違えば投げる', () => {
    stubDocker(['absent', inspected({ env: [] })], () => {
      throw nameConflict(id.containerName)
    })
    expect(() => ensureProjectGuacdContainer(id)).toThrow(/Failed to start guacd/)
  })

  it('★ 起動に失敗したら投げる', () => {
    stubDocker(['absent'], () => {
      throw new Error('pull access denied')
    })
    expect(() => ensureProjectGuacdContainer(id)).toThrow(/pull access denied/)
  })
})

describe('extractGuacdSystemCaBundle', () => {
  beforeEach(() => {
    fs.mkdirSync(id.caHostDir, { recursive: true })
  })

  it('★ 稼働中の guacd から標準バンドルを取り出し system-ca.pem に置く', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    expect(calls()).toEqual([
      ['exec', id.containerName, 'cat', '/etc/ssl/certs/ca-certificates.crt'],
    ])
    // 固まった docker exec で起動経路を止めない。
    expect(GUACD_EXEC_TIMEOUT_MS).toBe(30_000)
    expect(exec.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: GUACD_EXEC_TIMEOUT_MS }))
    const file = path.join(id.caHostDir, 'system-ca.pem')
    expect(fs.readFileSync(file, 'utf8')).toBe(SYSTEM_BUNDLE)
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(fs.readdirSync(id.caHostDir).sort()).toEqual(['bundle.pem', 'system-ca.pem'])
  })

  it('★ bundle.pem が無ければ標準バンドルと同じ内容で作る（0644）', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    const bundle = path.join(id.caHostDir, 'bundle.pem')
    expect(fs.readFileSync(bundle, 'utf8')).toBe(SYSTEM_BUNDLE)
    expect(fs.statSync(bundle).mode & 0o777).toBe(0o644)
  })

  it('★ bundle.pem が既にあれば上書きしない（エージェントが書いた登録 CA を消さない）', () => {
    const bundle = path.join(id.caHostDir, 'bundle.pem')
    fs.writeFileSync(bundle, 'AGENT-WRITTEN')
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    expect(fs.readFileSync(bundle, 'utf8')).toBe('AGENT-WRITTEN')
    expect(fs.readFileSync(path.join(id.caHostDir, 'system-ca.pem'), 'utf8')).toBe(SYSTEM_BUNDLE)
    expect(fs.readdirSync(id.caHostDir).sort()).toEqual(['bundle.pem', 'system-ca.pem'])
  })

  it('bundle.pem を作れなければ一時ファイルを残さず投げる', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    jest.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(() => extractGuacdSystemCaBundle(id)).toThrow(/EPERM/)
    expect(fs.readdirSync(id.caHostDir)).toEqual(['system-ca.pem'])
  })

  it('★ 確認の後に bundle.pem が置かれても上書きしない（EEXIST は完了扱い）', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    const bundle = path.join(id.caHostDir, 'bundle.pem')
    jest.mocked(fs.linkSync).mockImplementationOnce(() => {
      // existsSync の後・link の前にエージェントが書いた状況
      fs.writeFileSync(bundle, 'AGENT-WRITTEN')
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    })
    expect(() => extractGuacdSystemCaBundle(id)).not.toThrow()
    expect(fs.readFileSync(bundle, 'utf8')).toBe('AGENT-WRITTEN')
    expect(fs.readdirSync(id.caHostDir).sort()).toEqual(['bundle.pem', 'system-ca.pem'])
  })

  it('★ 証明書を含まない出力は置かない', () => {
    exec.mockReturnValue('')
    expect(() => extractGuacdSystemCaBundle(id)).toThrow(/no certificates/)
    expect(fs.existsSync(path.join(id.caHostDir, 'system-ca.pem'))).toBe(false)
  })

  it('★ exec がタイムアウトしたら投げる（呼び出し元は抽出失敗として扱う）', () => {
    exec.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync /usr/bin/docker ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })
    expect(() => extractGuacdSystemCaBundle(id)).toThrow(/ETIMEDOUT/)
    expect(fs.existsSync(path.join(id.caHostDir, 'system-ca.pem'))).toBe(false)
  })

  it('exec に失敗したら投げる', () => {
    exec.mockImplementation(() => {
      throw new Error('container is not running')
    })
    expect(() => extractGuacdSystemCaBundle(id)).toThrow(/container is not running/)
  })

  it('書けなければ一時ファイルを残さず投げる', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    fs.mkdirSync(path.join(id.caHostDir, 'system-ca.pem', 'occupied'), { recursive: true })
    expect(() => extractGuacdSystemCaBundle(id)).toThrow()
    expect(fs.readdirSync(id.caHostDir)).toEqual(['system-ca.pem'])
  })
})

describe('stopProjectGuacdContainer', () => {
  it('★ そのプロジェクトの guacd コンテナだけを止める（ネットワークは別に消す）', () => {
    exec.mockReturnValue('')
    expect(stopProjectGuacdContainer(id)).toBe(true)
    expect(calls()).toEqual([['stop', id.containerName]])
  })

  it('既に無いコンテナは止まっているものとして扱う', () => {
    exec.mockImplementation(() => {
      throw new Error(`Error response from daemon: No such container: ${id.containerName}`)
    })
    expect(stopProjectGuacdContainer(id)).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('★ 止め損ねたら、どのプロジェクトのものか分かる warn を残して false（投げない）', () => {
    exec.mockImplementation(() => {
      throw new Error('daemon unavailable')
    })
    expect(stopProjectGuacdContainer(id)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(id.containerName))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mbc/MBC_01'))
  })
})

describe('removeProjectGuacdNetwork', () => {
  it('★ 専用ネットワークを消す', () => {
    exec.mockReturnValue('')
    expect(removeProjectGuacdNetwork(id)).toBe(true)
    expect(calls()).toEqual([['network', 'rm', id.networkName]])
  })

  it('既に無ければ消えたものとして扱う', () => {
    exec.mockImplementation(() => {
      throw new Error(`Error response from daemon: network ${id.networkName} not found`)
    })
    expect(removeProjectGuacdNetwork(id)).toBe(true)
  })

  it('消せなければ false（warn にしない。後で再試行する）', () => {
    exec.mockImplementation(() => {
      throw new Error('error while removing network: network has active endpoints')
    })
    expect(removeProjectGuacdNetwork(id)).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('removeProjectTrustStore', () => {
  it('★ そのプロジェクトの信頼ストアのディレクトリを消す', () => {
    fs.mkdirSync(id.caHostDir, { recursive: true })
    fs.writeFileSync(path.join(id.caHostDir, 'bundle.pem'), 'x')
    expect(removeProjectTrustStore(id)).toBe(true)
    expect(fs.existsSync(id.caHostDir)).toBe(false)
    // 他のプロジェクトのものが並ぶ親ディレクトリは残す。
    expect(fs.existsSync(path.dirname(id.caHostDir))).toBe(true)
  })

  it('無くても成功扱い', () => {
    expect(removeProjectTrustStore(id)).toBe(true)
  })

  it.each([
    ['rdp-trusted-ca 配下でない', (d: string) => path.join(d, 'elsewhere', id.key)],
    ['末尾が key でない', (d: string) => path.join(d, 'rdp-trusted-ca', 'other')],
    ['親そのもの', (d: string) => path.join(d, 'rdp-trusted-ca')],
    ['相対パス', () => path.join('rdp-trusted-ca', id.key)],
  ])('★ 想定外の場所（%s）は消さない', (_label, target) => {
    const dir = target(configDir)
    // 相対パスは作業ディレクトリを汚さないよう作らない（消そうとしないことだけ見る）。
    if (path.isAbsolute(dir)) fs.mkdirSync(dir, { recursive: true })
    expect(removeProjectTrustStore({ ...id, caHostDir: dir })).toBe(false)
    if (path.isAbsolute(dir)) expect(fs.existsSync(dir)).toBe(true)
    expect(fs.rmSync).not.toHaveBeenCalledWith(dir, expect.anything())
    expect(logger.warn).toHaveBeenCalled()
  })

  it('消せなければ warn を残して false', () => {
    fs.mkdirSync(id.caHostDir, { recursive: true })
    const rm = jest.mocked(fs.rmSync)
    rm.mockImplementationOnce(() => {
      throw new Error('EBUSY')
    })
    expect(removeProjectTrustStore(id)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
  })
})

describe('removeLegacySharedGuacd', () => {
  const legacy = (
    networks: Record<string, unknown>,
    bindings: Record<string, unknown> | null,
    labels: Record<string, string> | null = null,
  ) =>
    JSON.stringify({
      State: { Running: true },
      Config: { Labels: labels },
      HostConfig: { PortBindings: bindings },
      NetworkSettings: { Networks: networks },
    })

  /** ais-rdp に接続しているのが旧 guacd だけ。 */
  const onlyGuacd = { abc123: { Name: GUACD_CONTAINER_NAME } }

  /**
   * docker CLI の応答。`network inspect` は `endpoints`（'fail' なら失敗）、
   * `failRm` / `failNetworkRm` でそれぞれ失敗させる。
   */
  function stubLegacy(
    container: string | 'absent',
    endpoints: Record<string, { Name: string }> | null | 'fail' = onlyGuacd,
    opts: { failRm?: boolean; failNetworkRm?: boolean } = {},
  ): void {
    exec.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'inspect') {
        if (container === 'absent') throw new Error('No such object: ais-guacd')
        return container
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (endpoints === 'fail') throw new Error('network ais-rdp not found')
        return JSON.stringify(endpoints)
      }
      if (args[0] === 'rm' && opts.failRm) throw new Error('daemon unavailable')
      if (args[0] === 'network' && args[1] === 'rm' && opts.failNetworkRm) {
        throw new Error('network ais-rdp has active endpoints')
      }
      return ''
    })
  }
  const netCalls = (sub: string): string[][] => callsFor('network').filter((a) => a[1] === sub)

  it('★ 旧 Docker 形態（ais-rdp に所属・ポート公開なし・ラベル無し・他に接続なし）の共有 guacd を撤去する', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}))
    removeLegacySharedGuacd()
    expect(netCalls('inspect')).toEqual([
      ['network', 'inspect', '--format', '{{json .Containers}}', GUACD_NETWORK_NAME],
    ])
    expect(callsFor('rm')).toEqual([['rm', '-f', GUACD_CONTAINER_NAME]])
    expect(netCalls('rm')).toEqual([['network', 'rm', GUACD_NETWORK_NAME]])
  })

  it('PortBindings が null でも旧 Docker 形態として扱う', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, null))
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toHaveLength(1)
  })

  it('★ 旧版と新版が同居: 旧版のエージェントが ais-rdp に接続して使っている共有 guacd は残す', () => {
    // 別の設定ディレクトリ・別ユーザーで旧版エージェントがまだ動いている。
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}), {
      abc123: { Name: GUACD_CONTAINER_NAME },
      def456: { Name: 'ai-mbc-proj_a-old-agent' },
    })
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
    expect(netCalls('rm')).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('still connected'))
  })

  it('★ 接続状況を確かめられなければ残す', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}), 'fail')
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
    expect(netCalls('rm')).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('could not confirm'))
  })

  it('接続状況の出力が読めなければ残す', () => {
    exec.mockImplementation((_c: string, args: string[]) => {
      if (args[0] === 'inspect') return legacy({ [GUACD_NETWORK_NAME]: {} }, {})
      if (args[0] === 'network' && args[1] === 'inspect') return 'not json'
      return ''
    })
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('could not confirm'))
  })

  it('接続が 1 つも無い（null）ことは確認できたものとして撤去する', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}), null)
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toHaveLength(1)
  })

  it('★ 現行の legacy fallback が起動した共有 guacd（shared-v1 ラベル付き）は撤去しない', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}, { 'ai-support-agent.rdp.layout': 'shared-v1' }))
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
    // 使用中のネットワークも消しにいかない。
    expect(callsFor('network')).toEqual([])
  })

  it('★ host 形態（127.0.0.1:4822 公開）の guacd は残す', () => {
    stubLegacy(legacy({ bridge: {} }, { '4822/tcp': [{ HostIp: '127.0.0.1', HostPort: '4822' }] }))
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
    expect(callsFor('network')).toEqual([])
  })

  it('★ ais-rdp に所属していてもポートを公開していれば残す', () => {
    stubLegacy(
      legacy({ [GUACD_NETWORK_NAME]: {} }, { '4822/tcp': [{ HostIp: '127.0.0.1', HostPort: '4822' }] }),
    )
    removeLegacySharedGuacd()
    expect(callsFor('rm')).toEqual([])
  })

  it('Networks が無い inspect 結果でも投げない', () => {
    stubLegacy(JSON.stringify({ State: { Running: true } }))
    expect(() => removeLegacySharedGuacd()).not.toThrow()
    expect(callsFor('rm')).toEqual([])
  })

  it('★ 旧 guacd が無ければネットワークにも触れない（legacy fallback の network create と docker run の間を壊さない）', () => {
    stubLegacy('absent')
    expect(() => removeLegacySharedGuacd()).not.toThrow()
    expect(callsFor('rm')).toEqual([])
    expect(callsFor('network')).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('撤去したあとのネットワーク削除に失敗しても投げない', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}), onlyGuacd, { failNetworkRm: true })
    expect(() => removeLegacySharedGuacd()).not.toThrow()
    expect(netCalls('rm')).toEqual([['network', 'rm', GUACD_NETWORK_NAME]])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('撤去に失敗したら warn を残す（投げない）', () => {
    stubLegacy(legacy({ [GUACD_NETWORK_NAME]: {} }, {}), onlyGuacd, { failRm: true })
    expect(() => removeLegacySharedGuacd()).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(GUACD_CONTAINER_NAME))
    // 撤去できていないのでネットワークも消さない。
    expect(netCalls('rm')).toEqual([])
  })
})

describe('invalidateProjectTrustStore', () => {
  it('★ 登録 CA 入りの bundle.pem と標準バンドルを消す（guacd に古い信頼ストアを読ませない）', () => {
    fs.mkdirSync(id.caHostDir, { recursive: true })
    fs.writeFileSync(path.join(id.caHostDir, 'bundle.pem'), 'OLD')
    fs.writeFileSync(path.join(id.caHostDir, 'system-ca.pem'), 'SYS')
    expect(invalidateProjectTrustStore(id)).toBe(true)
    expect(fs.readdirSync(id.caHostDir)).toEqual([])
  })

  it('無くても成功扱い', () => {
    expect(invalidateProjectTrustStore(id)).toBe(true)
  })

  it('消せなければ false', () => {
    fs.mkdirSync(id.caHostDir, { recursive: true })
    jest.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(invalidateProjectTrustStore(id)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
  })
})

describe('★ 共有ディレクトリに置かれたシンボリックリンクをホスト側がたどらない', () => {
  // caHostDir はエージェントのコンテナへ :rw でマウントされる。コンテナ内の処理が
  // 置いたシンボリックリンクをホストの監督プロセスがたどって書くと、ホスト上の
  // 任意のファイルを上書き・権限変更できてしまう（コンテナ → ホストの書き込み昇格）。
  let outside: string
  const secret = (): string => path.join(outside, 'host-secret')
  const secretDir = (): string => path.join(outside, 'host-dir')

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-host-outside-'))
    fs.writeFileSync(secret(), 'HOST-SECRET', { mode: 0o600 })
    fs.mkdirSync(secretDir())
    fs.writeFileSync(path.join(secretDir(), 'keep'), 'KEEP')
    fs.mkdirSync(id.caHostDir, { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const untouched = (): void => {
    expect(fs.readFileSync(secret(), 'utf8')).toBe('HOST-SECRET')
    expect(fs.statSync(secret()).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(secretDir(), 'keep'), 'utf8')).toBe('KEEP')
  }
  const plant = (name: string, target = secret()): void => {
    fs.symlinkSync(target, path.join(id.caHostDir, name))
  }

  it('★ 予測できる一時ファイル名・system-ca.pem・bundle.pem をリンクにされても外部ファイルを変えない', () => {
    for (const name of [
      `.system-ca.pem.${process.pid}.tmp`,
      `.bundle.pem.${process.pid}.seed.tmp`,
      'system-ca.pem',
      'bundle.pem',
    ]) {
      plant(name)
    }
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    untouched()
    // system-ca.pem はリンクごと置き換わる（rename はリンク先をたどらない）。
    const system = path.join(id.caHostDir, 'system-ca.pem')
    expect(fs.lstatSync(system).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(system, 'utf8')).toBe(SYSTEM_BUNDLE)
  })

  it('★ 一時ファイルは共有ディレクトリではなく、ホストだけが触れる 0700 の場所で作る', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    jest.mocked(fs.writeFileSync).mockClear()
    extractGuacdSystemCaBundle(id)
    const written = jest.mocked(fs.writeFileSync).mock.calls.map((c) => String(c[0]))
    const staging = path.join(configDir, 'rdp-trusted-ca', '.staging', id.key)
    expect(written.length).toBeGreaterThan(0)
    for (const p of written) {
      expect(p.startsWith(staging + path.sep)).toBe(true)
    }
    expect(fs.statSync(staging).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(staging)).toEqual([])
  })

  it('★ bundle.pem がリンクなら種まきしない（リンク先へ書かない）', () => {
    plant('bundle.pem', path.join(outside, 'does-not-exist'))
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    expect(fs.existsSync(path.join(outside, 'does-not-exist'))).toBe(false)
  })

  it('★ invalidateProjectTrustStore はリンクを消すだけで、リンク先を消さない', () => {
    plant('bundle.pem')
    plant('system-ca.pem', secretDir())
    expect(invalidateProjectTrustStore(id)).toBe(true)
    untouched()
    expect(fs.readdirSync(id.caHostDir)).toEqual([])
  })

  it('★ removeProjectTrustStore は中のリンクをたどらない', () => {
    plant('bundle.pem')
    plant('dir-link', secretDir())
    expect(removeProjectTrustStore(id)).toBe(true)
    untouched()
    expect(fs.existsSync(id.caHostDir)).toBe(false)
  })

  it('★ removeProjectTrustStore はホスト専用の一時ディレクトリも片付ける', () => {
    exec.mockReturnValue(SYSTEM_BUNDLE)
    extractGuacdSystemCaBundle(id)
    const staging = path.join(configDir, 'rdp-trusted-ca', '.staging', id.key)
    expect(fs.existsSync(staging)).toBe(true)
    expect(removeProjectTrustStore(id)).toBe(true)
    expect(fs.existsSync(staging)).toBe(false)
  })

  it('★ caHostDir 自体がリンクなら使わない（権限を変えない・起動しない）', () => {
    fs.rmSync(id.caHostDir, { recursive: true, force: true })
    fs.symlinkSync(secretDir(), id.caHostDir)
    fs.chmodSync(secretDir(), 0o700)
    stubDocker(['absent'])
    expect(() => ensureProjectGuacdContainer(id)).toThrow(/not a directory/)
    expect(fs.statSync(secretDir()).mode & 0o777).toBe(0o700)
    expect(callsFor('run')).toEqual([])
    exec.mockReturnValue(SYSTEM_BUNDLE)
    expect(() => extractGuacdSystemCaBundle(id)).toThrow(/not a directory/)
    untouched()
    expect(removeProjectTrustStore(id)).toBe(false)
    untouched()
    expect(invalidateProjectTrustStore(id)).toBe(false)
    untouched()
  })
})
