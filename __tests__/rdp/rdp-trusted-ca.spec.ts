import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ENV_VARS } from '../../src/constants'
import { logger } from '../../src/logger'
import {
  RDP_TRUSTED_CA_BUNDLE_FILE,
  RDP_TRUSTED_CA_MAX_COUNT,
  RDP_TRUSTED_CA_MOUNT_PATH,
  RDP_TRUSTED_CA_PEM_MAX_LENGTH,
  RDP_TRUSTED_CA_SYSTEM_FILE,
  RDP_TRUSTED_CA_SYSTEM_MAX_BYTES,
  AGENT_SYSTEM_CA_BUNDLE_PATH,
  RdpTrustedCaStore,
  configuredRdpTrustedCaDir,
  prepareRdpTrustedCaStore,
  parseTrustedCaCertificates,
  resolveRdpTrustedCaDir,
} from '../../src/rdp/rdp-trusted-ca'
import {
  TEST_CA2_PEM,
  TEST_CA_PEM,
  TEST_LEAF_PEM,
  TEST_PRIVATE_KEY_PEM,
} from '../fixtures/rdp-trusted-ca-pems'

jest.mock('../../src/logger')

// linkSync だけ差し替え可能にする（既定は本物）。
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return { ...actual, linkSync: jest.fn(actual.linkSync) }
})

// 一時ファイル名の乱数を固定できるようにする（既定は本物）。
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto')
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) }
})

/**
 * プロジェクトに登録された社内 CA を guacd の信頼ストアへ反映する部分。
 *
 * guacd は `SSL_CERT_FILE=<dir>/bundle.pem` で起動しており、エージェントは
 * guacd イメージの標準バンドル（`system-ca.pem`）に登録 CA を足したものを
 * `bundle.pem` として**原子的に**置き換える。
 */

const SYSTEM_BUNDLE = '-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n'

describe('rdp-trusted-ca', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rdp-ca-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const dockerEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    [ENV_VARS.IN_DOCKER]: '1',
    [ENV_VARS.RDP_TRUSTED_CA_DIR]: dir,
    ...extra,
  })

  it('定数は全層で揃えた名前', () => {
    expect(ENV_VARS.RDP_TRUSTED_CA_DIR).toBe('AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR')
    expect(RDP_TRUSTED_CA_MOUNT_PATH).toBe('/run/ais-rdp-ca')
    expect(RDP_TRUSTED_CA_SYSTEM_FILE).toBe('system-ca.pem')
    expect(RDP_TRUSTED_CA_BUNDLE_FILE).toBe('bundle.pem')
    expect(RDP_TRUSTED_CA_MAX_COUNT).toBe(10)
    expect(RDP_TRUSTED_CA_PEM_MAX_LENGTH).toBe(16384)
  })

  describe('resolveRdpTrustedCaDir', () => {
    it('★ system-ca.pem があるときだけディレクトリを返す', () => {
      expect(resolveRdpTrustedCaDir(dockerEnv())).toBeUndefined()
      fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), SYSTEM_BUNDLE)
      expect(resolveRdpTrustedCaDir(dockerEnv())).toBe(dir)
    })

    it('環境変数が無ければ undefined', () => {
      fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), SYSTEM_BUNDLE)
      expect(resolveRdpTrustedCaDir({ [ENV_VARS.IN_DOCKER]: '1' })).toBeUndefined()
      expect(resolveRdpTrustedCaDir(dockerEnv({ [ENV_VARS.RDP_TRUSTED_CA_DIR]: '' }))).toBeUndefined()
    })

    it('相対パスは受けない', () => {
      expect(
        resolveRdpTrustedCaDir(dockerEnv({ [ENV_VARS.RDP_TRUSTED_CA_DIR]: 'run/ais-rdp-ca' })),
      ).toBeUndefined()
    })

    it('★ host（CLI 直起動）形態では設定があっても申告しない', () => {
      fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), SYSTEM_BUNDLE)
      expect(resolveRdpTrustedCaDir({ [ENV_VARS.RDP_TRUSTED_CA_DIR]: dir })).toBeUndefined()
    })

    it('既定では process.env を読む', () => {
      const saved = { ...process.env }
      try {
        delete process.env[ENV_VARS.RDP_TRUSTED_CA_DIR]
        expect(resolveRdpTrustedCaDir()).toBeUndefined()
      } finally {
        process.env = saved
      }
    })
  })

  describe('parseTrustedCaCertificates', () => {
    it('★ CA 証明書を正規化した PEM で返す', () => {
      const parsed = parseTrustedCaCertificates([TEST_CA_PEM, `\n${TEST_CA2_PEM}\n\n`])
      expect(parsed).toHaveLength(2)
      expect(parsed[0]).toMatch(/^-----BEGIN CERTIFICATE-----\n/)
      expect(parsed[0].trim()).toBe(TEST_CA_PEM.trim())
      expect(parsed[1].trim()).toBe(TEST_CA2_PEM.trim())
    })

    it('空配列はそのまま', () => {
      expect(parseTrustedCaCertificates([])).toEqual([])
    })

    it.each([
      ['配列でない', 'x', /must be an array/],
      ['null', null, /must be an array/],
      ['件数超過', Array(11).fill(TEST_CA_PEM), /at most 10/],
      ['文字列でない要素', [42], /\[0\] must be a string/],
      ['長すぎる要素', ['x'.repeat(16385)], /\[0\] is longer than 16384/],
      ['証明書でない', ['hello'], /\[0\] must contain exactly one CERTIFICATE block/],
      ['秘密鍵', [TEST_PRIVATE_KEY_PEM], /\[0\] must contain exactly one CERTIFICATE block/],
      ['証明書＋秘密鍵', [TEST_CA_PEM + TEST_PRIVATE_KEY_PEM], /\[0\] must contain exactly one CERTIFICATE block/],
      ['2 ブロック', [TEST_CA_PEM + TEST_CA2_PEM], /\[0\] must contain exactly one CERTIFICATE block/],
      [
        '壊れた証明書',
        ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
        /\[0\] is not a valid X\.509 certificate/,
      ],
      ['CA でない', [TEST_CA_PEM, TEST_LEAF_PEM], /\[1\] is not a CA certificate/],
    ])('%s は拒否する', (_label, raw, pattern) => {
      expect(() => parseTrustedCaCertificates(raw)).toThrow(pattern)
    })

    it('★ エラー文言に入力の中身を載せない', () => {
      try {
        parseTrustedCaCertificates([TEST_CA_PEM + TEST_PRIVATE_KEY_PEM])
        throw new Error('should have thrown')
      } catch (error) {
        expect((error as Error).message).not.toContain('QUFB')
      }
    })
  })

  describe('RdpTrustedCaStore.apply', () => {
    const bundlePath = (): string => path.join(dir, RDP_TRUSTED_CA_BUNDLE_FILE)
    const writeSystem = (): void =>
      fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), SYSTEM_BUNDLE)

    it('★ 標準バンドル＋登録 CA を bundle.pem に書く（0644）', () => {
      writeSystem()
      new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM, TEST_CA2_PEM])
      const bundle = fs.readFileSync(bundlePath(), 'utf8')
      expect(bundle.startsWith(SYSTEM_BUNDLE)).toBe(true)
      expect(bundle).toContain(TEST_CA_PEM.trim())
      expect(bundle).toContain(TEST_CA2_PEM.trim())
      expect(bundle.endsWith('\n')).toBe(true)
      expect(fs.statSync(bundlePath()).mode & 0o777).toBe(0o644)
    })

    it('★ 空配列は標準バンドルのみへ戻す（前回の CA を残さない）', () => {
      writeSystem()
      const store = new RdpTrustedCaStore(() => dir)
      store.apply([TEST_CA_PEM])
      store.apply([])
      expect(fs.readFileSync(bundlePath(), 'utf8')).toBe(SYSTEM_BUNDLE)
    })

    it('末尾に改行の無い標準バンドルでも証明書がつながらない', () => {
      fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), SYSTEM_BUNDLE.trimEnd())
      new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])
      expect(fs.readFileSync(bundlePath(), 'utf8')).toContain(
        '-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----',
      )
    })

    it('★ 一時ファイルを残さない', () => {
      writeSystem()
      new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])
      expect(fs.readdirSync(dir).sort()).toEqual([
        RDP_TRUSTED_CA_BUNDLE_FILE,
        RDP_TRUSTED_CA_SYSTEM_FILE,
      ])
    })

    it('★ 不正な入力は rdp_trusted_ca_invalid で断り、bundle.pem に触れない', () => {
      writeSystem()
      expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_LEAF_PEM])).toThrow(
        /^rdp_trusted_ca_invalid: /,
      )
      expect(fs.existsSync(bundlePath())).toBe(false)
    })

    it('★ 信頼ストアの無い形態で CA を渡されたら rdp_trusted_ca_unsupported', () => {
      expect(() => new RdpTrustedCaStore(() => undefined).apply([TEST_CA_PEM])).toThrow(
        /^rdp_trusted_ca_unsupported: /,
      )
    })

    it('信頼ストアの無い形態でも空配列なら何もしない', () => {
      expect(() => new RdpTrustedCaStore(() => undefined).apply([])).not.toThrow()
    })

    it('★ 標準バンドルが読めなければ rdp_trusted_ca_unavailable', () => {
      expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])).toThrow(
        /^rdp_trusted_ca_unavailable: /,
      )
    })

    it('書き込めなければ rdp_trusted_ca_unavailable で、一時ファイルを片付ける', () => {
      writeSystem()
      // bundle.pem の位置に中身のあるディレクトリを置き、rename を失敗させる。
      fs.mkdirSync(path.join(bundlePath(), 'occupied'), { recursive: true })
      expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])).toThrow(
        /^rdp_trusted_ca_unavailable: could not prepare the trust store: /,
      )
      expect(fs.readdirSync(dir).sort()).toEqual([
        RDP_TRUSTED_CA_BUNDLE_FILE,
        RDP_TRUSTED_CA_SYSTEM_FILE,
      ])
    })

    describe('★ 標準バンドル（system-ca.pem）を信用しすぎない（guacd 側が差し替え得る前提）', () => {
      // guacd が乗っ取られて system-ca.pem を /proc/self/environ などへのリンクに
      // 差し替えても、エージェントの秘密が bundle.pem（guacd が読む）へ写らないこと。
      const SECRET = 'AI_SUPPORT_AGENT_TOKEN=super-secret-token'
      let outside: string
      const secretFile = (): string => path.join(outside, 'environ')
      beforeEach(() => {
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rdp-ca-outside-'))
        fs.writeFileSync(secretFile(), `PATH=/usr/bin\0${SECRET}\0`, { mode: 0o600 })
      })
      afterEach(() => {
        fs.rmSync(outside, { recursive: true, force: true })
      })
      const expectNoLeak = (): void => {
        const bundle = bundlePath()
        const content = fs.existsSync(bundle) ? fs.readFileSync(bundle, 'utf8') : ''
        expect(content).not.toContain('super-secret-token')
        expect(fs.readFileSync(secretFile(), 'utf8')).toBe(`PATH=/usr/bin\0${SECRET}\0`)
        expect(fs.statSync(secretFile()).mode & 0o777).toBe(0o600)
      }

      it('★ system-ca.pem が秘密ファイルへのリンクなら rdp_trusted_ca_unavailable（写さない）', () => {
        fs.symlinkSync(secretFile(), path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE))
        expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])).toThrow(
          /^rdp_trusted_ca_unavailable: /,
        )
        expectNoLeak()
      })

      it('★ 中身が正しい証明書でもリンクなら読まない', () => {
        const real = path.join(outside, 'ca.pem')
        fs.writeFileSync(real, SYSTEM_BUNDLE)
        fs.symlinkSync(real, path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE))
        expect(() => new RdpTrustedCaStore(() => dir).apply([])).toThrow(/^rdp_trusted_ca_unavailable: /)
      })

      it.each([
        ['証明書でない内容', () => `${SECRET}\n`],
        ['証明書の後ろに別の内容', () => `${SYSTEM_BUNDLE}${SECRET}\n`],
        ['証明書の前に別の内容', () => `${SECRET}\n${SYSTEM_BUNDLE}`],
        ['証明書ブロックの中に別の文字', () => `-----BEGIN CERTIFICATE-----\n${SECRET}\n-----END CERTIFICATE-----\n`],
        ['閉じていないブロック', () => `-----BEGIN CERTIFICATE-----\nQUFB\n`],
        ['中身の無いブロック', () => `-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n`],
        ['空', () => ''],
        ['秘密鍵のブロック', () => TEST_PRIVATE_KEY_PEM],
      ])('★ %s の system-ca.pem は rdp_trusted_ca_unavailable（写さない）', (_label, content) => {
        fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), content())
        expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])).toThrow(
          /^rdp_trusted_ca_unavailable: /,
        )
        expectNoLeak()
      })

      it('複数の証明書と空行・CRLF は受け付ける', () => {
        const two = `${SYSTEM_BUNDLE}\n${SYSTEM_BUNDLE.replace(/\n/g, '\r\n')}`
        fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), two)
        new RdpTrustedCaStore(() => dir).apply([])
        expect(fs.readFileSync(bundlePath(), 'utf8')).toBe(two)
      })

      it('★ 上限を超える大きさは読まない', () => {
        expect(RDP_TRUSTED_CA_SYSTEM_MAX_BYTES).toBe(4 * 1024 * 1024)
        const line = 'QUFB'.repeat(16) + '\n'
        const body = line.repeat(Math.ceil(RDP_TRUSTED_CA_SYSTEM_MAX_BYTES / line.length) + 1)
        fs.writeFileSync(
          path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE),
          `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----\n`,
        )
        expect(() => new RdpTrustedCaStore(() => dir).apply([])).toThrow(/^rdp_trusted_ca_unavailable: .*too large/)
      })

      it('通常ファイルでなければ（ディレクトリ）読まない', () => {
        fs.mkdirSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE))
        expect(() => new RdpTrustedCaStore(() => dir).apply([])).toThrow(/^rdp_trusted_ca_unavailable: .*regular file/)
      })

      it('★ 一時ファイル名にリンクが先置きされていても、リンク先へ書かない', () => {
        writeSystem()
        const suffix = Buffer.from('0011223344556677', 'hex')
        jest.mocked(crypto.randomBytes).mockImplementationOnce((() => suffix) as never)
        const planted = path.join(dir, `.${RDP_TRUSTED_CA_BUNDLE_FILE}.${suffix.toString('hex')}.tmp`)
        fs.symlinkSync(secretFile(), planted)
        expect(() => new RdpTrustedCaStore(() => dir).apply([TEST_CA_PEM])).toThrow(
          /^rdp_trusted_ca_unavailable: /,
        )
        expectNoLeak()
        expect(fs.readFileSync(secretFile(), 'utf8')).not.toContain('BEGIN CERTIFICATE')
      })

      it('★ 一時ファイル名は予測できない（毎回違う）', () => {
        writeSystem()
        const store = new RdpTrustedCaStore(() => dir)
        jest.mocked(crypto.randomBytes).mockClear()
        store.apply([])
        store.apply([])
        const names = jest.mocked(crypto.randomBytes).mock.results.map((r) => (r.value as Buffer).toString('hex'))
        expect(names).toHaveLength(2)
        expect(names[0]).not.toBe(names[1])
        expect(jest.mocked(crypto.randomBytes).mock.calls[0][0]).toBeGreaterThanOrEqual(8)
      })
    })

    describe('★ 信頼ストアが設定済みなのに標準バンドルが使えないとき、古い bundle.pem を残さない', () => {
      // AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR は設定済みだが system-ca.pem が欠落・破損し、
      // 前回の登録 CA 入りの bundle.pem だけが残っている。guacd はそれを読み続けるため、
      // CA を全件削除しても削除済みの CA を信頼し続けてしまう。
      const env = (): NodeJS.ProcessEnv => dockerEnv()
      const staleBundle = (): void => {
        fs.writeFileSync(bundlePath(), `${SYSTEM_BUNDLE}${TEST_CA_PEM}`)
      }
      const defaultStore = (): RdpTrustedCaStore =>
        new RdpTrustedCaStore(
          () => resolveRdpTrustedCaDir(env()),
          () => configuredRdpTrustedCaDir(env()),
        )

      it('★ system-ca.pem が無い: apply([]) は古い bundle.pem を消して成功する', () => {
        staleBundle()
        defaultStore().apply([])
        expect(fs.existsSync(bundlePath())).toBe(false)
      })

      it('★ system-ca.pem が無い: CA ありは従来どおり断り、古い bundle.pem も消す', () => {
        staleBundle()
        expect(() => defaultStore().apply([TEST_CA_PEM])).toThrow(/^rdp_trusted_ca_unsupported: /)
        expect(fs.existsSync(bundlePath())).toBe(false)
      })

      it('★ system-ca.pem が壊れている: 断り、古い bundle.pem も消す', () => {
        staleBundle()
        fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), 'not a certificate\n')
        expect(() => defaultStore().apply([])).toThrow(/^rdp_trusted_ca_unavailable: /)
        expect(fs.existsSync(bundlePath())).toBe(false)
      })

      it('★ bundle.pem がリンクならリンク自体を消し、リンク先に触れない', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rdp-ca-stale-'))
        try {
          const target = path.join(outside, 'keep')
          fs.writeFileSync(target, 'KEEP')
          fs.symlinkSync(target, bundlePath())
          defaultStore().apply([])
          expect(() => fs.lstatSync(bundlePath())).toThrow()
          expect(fs.readFileSync(target, 'utf8')).toBe('KEEP')
        } finally {
          fs.rmSync(outside, { recursive: true, force: true })
        }
      })

      it('★ 標準バンドルが壊れていて古い bundle.pem も消せないとき、両方の理由を伝える', () => {
        fs.writeFileSync(path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE), 'not a certificate\n')
        fs.mkdirSync(path.join(bundlePath(), 'occupied'), { recursive: true })
        let caught: Error | undefined
        try {
          defaultStore().apply([])
        } catch (error) {
          caught = error as Error
        }
        expect(caught?.message).toMatch(/^rdp_trusted_ca_unavailable: /)
        // 元の失敗理由（標準バンドルが不正）
        expect(caught?.message).toContain('is not a PEM bundle of certificates only')
        // 片付けの失敗
        expect(caught?.message).toContain('could not remove the previous trust store')
        // 片付けの失敗そのものは cause に保持する。
        expect(caught?.cause).toBeDefined()
        // 中身は載せない
        expect(caught?.message).not.toContain('not a certificate')
      })

      it('古い bundle.pem を消せなければ rdp_trusted_ca_unavailable（信頼し得る状態を残して成功しない）', () => {
        // bundle.pem の位置に中身のあるディレクトリ（rm で消えない）。
        fs.mkdirSync(path.join(bundlePath(), 'occupied'), { recursive: true })
        expect(() => defaultStore().apply([])).toThrow(/^rdp_trusted_ca_unavailable: /)
      })

      it('env が未設定（非対応形態）なら従来どおり何もしない', () => {
        staleBundle()
        new RdpTrustedCaStore(
          () => resolveRdpTrustedCaDir({ [ENV_VARS.IN_DOCKER]: '1' }),
          () => configuredRdpTrustedCaDir({ [ENV_VARS.IN_DOCKER]: '1' }),
        ).apply([])
        expect(fs.existsSync(bundlePath())).toBe(true)
      })

      it('configuredRdpTrustedCaDir は system-ca.pem の有無を問わない（host 形態・相対パスは除く）', () => {
        expect(configuredRdpTrustedCaDir(env())).toBe(dir)
        expect(configuredRdpTrustedCaDir({ [ENV_VARS.RDP_TRUSTED_CA_DIR]: dir })).toBeUndefined()
        expect(
          configuredRdpTrustedCaDir(dockerEnv({ [ENV_VARS.RDP_TRUSTED_CA_DIR]: 'relative' })),
        ).toBeUndefined()
      })
    })

    it('既定の解決は環境変数から', () => {
      const saved = { ...process.env }
      try {
        process.env[ENV_VARS.IN_DOCKER] = '1'
        process.env[ENV_VARS.RDP_TRUSTED_CA_DIR] = dir
        writeSystem()
        new RdpTrustedCaStore().apply([TEST_CA_PEM])
        expect(fs.existsSync(bundlePath())).toBe(true)
      } finally {
        process.env = saved
      }
    })
  })

  describe('prepareRdpTrustedCaStore（K8s / ECS: エージェント自身が起動時に標準バンドルを置く）', () => {
    // guacd イメージの初期化コンテナに頼ると、そのイメージが取得できないだけで
    // エージェントまで起動しなくなる。エージェント自身のイメージの標準バンドルを置く。
    let source: string
    let outside: string
    const k8sEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      KUBERNETES_SERVICE_HOST: '10.43.0.1',
      [ENV_VARS.RDP_TRUSTED_CA_DIR]: dir,
      ...extra,
    })
    const systemPath = (): string => path.join(dir, RDP_TRUSTED_CA_SYSTEM_FILE)
    const bundle = (): string => path.join(dir, RDP_TRUSTED_CA_BUNDLE_FILE)

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-rdp-ca-src-'))
      source = path.join(outside, 'ca-certificates.crt')
      fs.writeFileSync(source, SYSTEM_BUNDLE)
      jest.mocked(logger.warn).mockClear()
    })
    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true })
    })

    it('既定の標準バンドルはエージェントイメージ（Debian の ca-certificates）のもの', () => {
      expect(AGENT_SYSTEM_CA_BUNDLE_PATH).toBe('/etc/ssl/certs/ca-certificates.crt')
    })

    it.each([
      ['K8s', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
      ['ECS', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' }],
    ])('★ %s: system-ca.pem と bundle.pem（0644）を置き、信頼ストアとして使える', (_label, runtime) => {
      const env = { ...runtime, [ENV_VARS.RDP_TRUSTED_CA_DIR]: dir }
      expect(prepareRdpTrustedCaStore(env, source)).toBe(true)
      expect(fs.readFileSync(systemPath(), 'utf8')).toBe(SYSTEM_BUNDLE)
      expect(fs.readFileSync(bundle(), 'utf8')).toBe(SYSTEM_BUNDLE)
      // guacd（UID 1000、別ユーザー）が読めること。
      expect(fs.statSync(systemPath()).mode & 0o777).toBe(0o644)
      expect(fs.statSync(bundle()).mode & 0o777).toBe(0o644)
      expect(resolveRdpTrustedCaDir(env)).toBe(dir)
      // 一時ファイルを残さない。
      expect(fs.readdirSync(dir).sort()).toEqual([RDP_TRUSTED_CA_BUNDLE_FILE, RDP_TRUSTED_CA_SYSTEM_FILE])
    })

    it('★ 既存の bundle.pem は上書きしない（エージェントが書いた登録 CA を消さない）', () => {
      fs.writeFileSync(bundle(), 'AGENT-WRITTEN')
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(true)
      expect(fs.readFileSync(bundle(), 'utf8')).toBe('AGENT-WRITTEN')
      expect(fs.readFileSync(systemPath(), 'utf8')).toBe(SYSTEM_BUNDLE)
    })

    it('★ 確認の後に bundle.pem が置かれても上書きしない（EEXIST は完了扱い、一時ファイルを残さない）', () => {
      jest.mocked(fs.linkSync).mockImplementationOnce(() => {
        fs.writeFileSync(bundle(), 'AGENT-WRITTEN')
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      })
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(true)
      expect(fs.readFileSync(bundle(), 'utf8')).toBe('AGENT-WRITTEN')
      expect(fs.readdirSync(dir).sort()).toEqual([RDP_TRUSTED_CA_BUNDLE_FILE, RDP_TRUSTED_CA_SYSTEM_FILE])
    })

    it('bundle.pem を置けなければ置かずに warn（一時ファイルも残さない）', () => {
      jest.mocked(fs.linkSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      })
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(false)
      expect(fs.readdirSync(dir)).toEqual([])
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EPERM'))
    })

    it('既存の system-ca.pem は新しい標準バンドルで置き換える', () => {
      fs.writeFileSync(systemPath(), 'OLD')
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(true)
      expect(fs.readFileSync(systemPath(), 'utf8')).toBe(SYSTEM_BUNDLE)
    })

    it.each([
      ['無い', () => fs.rmSync(source)],
      ['証明書でない', () => fs.writeFileSync(source, 'AI_SUPPORT_AGENT_TOKEN=secret\n')],
      ['大きすぎる', () => fs.writeFileSync(source, 'x'.repeat(RDP_TRUSTED_CA_SYSTEM_MAX_BYTES + 1))],
    ])('★ 標準バンドルが%sなら置かずに warn（rdpTrustedCa を申告しない＝fail-closed）', (_label, breakIt) => {
      breakIt()
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(false)
      expect(fs.existsSync(systemPath())).toBe(false)
      expect(fs.existsSync(bundle())).toBe(false)
      expect(resolveRdpTrustedCaDir(k8sEnv())).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Registered RDP CAs are unavailable'))
      // guacd の SSL_CERT_FILE は bundle.pem 固定なので、検証を有効にした接続は公開 CA でも
      // 失敗し得る。検証しない接続には影響しない。
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'RDP connections without certificate verification are unaffected; connections with ' +
            'certificate verification enabled (including ones needing a registered CA) may fail ' +
            'until the agent restarts with a valid CA bundle',
        ),
      )
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('RDP itself stays available'))
      expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('secret')
    })

    it('★ 置けなかったとき、前回の system-ca.pem と bundle.pem を残さない（リンクはたどらない）', () => {
      const keep = path.join(outside, 'keep')
      fs.writeFileSync(keep, 'KEEP')
      fs.writeFileSync(systemPath(), SYSTEM_BUNDLE)
      fs.symlinkSync(keep, bundle())
      fs.rmSync(source)
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(false)
      expect(fs.existsSync(systemPath())).toBe(false)
      expect(() => fs.lstatSync(bundle())).toThrow()
      expect(fs.readFileSync(keep, 'utf8')).toBe('KEEP')
    })

    it('★ 一時ファイル名に置いたリンクをたどらない（失敗して warn、リンク先は変わらない）', () => {
      const secret = path.join(outside, 'secret')
      fs.writeFileSync(secret, 'SECRET', { mode: 0o600 })
      const suffix = Buffer.from('8899aabbccddeeff', 'hex')
      jest.mocked(crypto.randomBytes).mockImplementationOnce((() => suffix) as never)
      fs.symlinkSync(secret, path.join(dir, `.${RDP_TRUSTED_CA_SYSTEM_FILE}.${suffix.toString('hex')}.tmp`))
      expect(prepareRdpTrustedCaStore(k8sEnv(), source)).toBe(false)
      expect(fs.readFileSync(secret, 'utf8')).toBe('SECRET')
      expect(fs.statSync(secret).mode & 0o777).toBe(0o600)
      expect(logger.warn).toHaveBeenCalled()
    })

    it.each([
      ['env 未設定', { KUBERNETES_SERVICE_HOST: '10.43.0.1' }],
      ['Docker 形態（ホストが置く）', { [ENV_VARS.IN_DOCKER]: '1' }],
      ['host 形態', {}],
    ])('%s では何もしない', (_label, base) => {
      const env: NodeJS.ProcessEnv = { ...base }
      if (_label !== 'env 未設定') env[ENV_VARS.RDP_TRUSTED_CA_DIR] = dir
      expect(prepareRdpTrustedCaStore(env, source)).toBe(false)
      expect(fs.readdirSync(dir)).toEqual([])
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('既定では process.env と既定のパスを使う', () => {
      const saved = { ...process.env }
      try {
        delete process.env[ENV_VARS.RDP_TRUSTED_CA_DIR]
        expect(prepareRdpTrustedCaStore()).toBe(false)
      } finally {
        process.env = saved
      }
    })
  })
})
