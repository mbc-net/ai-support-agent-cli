import {
  parseRdpTunnel,
  RDP_TUNNEL_KINDS,
  RdpTunnelRejectedError,
  rdpTunnelSecrets,
} from '../../src/rdp/rdp-tunnel-message'

/**
 * `rdp_open.tunnel` の検証（api ⇔ agent 実装契約 1）。
 *
 * api が組み立てた値でも、エージェントは kind と via の形の一致・必須値を
 * 自分で確かめる。形が崩れた指示でトンネルを張ると、意図しない宛先へ
 * 資格情報を持って接続しに行くことになるため。
 *
 * :::danger
 * 拒否理由に**値を載せない**。via には秘密鍵・パスワード・AWS の秘密鍵・
 * Tailscale の authkey が入っており、理由はそのまま API とブラウザへ届く。
 * :::
 */

const SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-SSH\n-----END OPENSSH PRIVATE KEY-----'
const AWS_SECRET = 'aws-secret-access-key-value'
const AWS_TOKEN = 'aws-session-token-value'
const TS_KEY = 'tskey-auth-secretvalue'

const ssh = (overrides: Record<string, unknown> = {}, via: Record<string, unknown> = {}) => ({
  kind: 'ssh',
  target: { host: 'localhost', port: 3389 },
  via: {
    hostId: 'win-1',
    hostname: 'win.example.com',
    port: 22,
    username: 'admin',
    authType: 'privateKey',
    credential: SSH_KEY,
    ...via,
  },
  ...overrides,
})

const ssm = (overrides: Record<string, unknown> = {}, via: Record<string, unknown> = {}) => ({
  kind: 'ssm',
  target: { host: '10.0.1.20', port: 3389 },
  via: {
    hostId: 'bastion-1',
    instanceId: 'i-0123456789abcdef0',
    region: 'ap-northeast-1',
    awsCredentials: {
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: AWS_SECRET,
      sessionToken: AWS_TOKEN,
    },
    ...via,
  },
  ...overrides,
})

const tailscale = (overrides: Record<string, unknown> = {}, via: Record<string, unknown> = {}) => ({
  kind: 'tailscale',
  target: { host: 'win-desktop.tail1234.ts.net', port: 3389 },
  via: { hostId: 'win-2', authKey: TS_KEY, ...via },
  ...overrides,
})

/** 拒否されること、かつ理由に秘匿値が載っていないこと。 */
function expectRejected(raw: unknown, pattern: RegExp): void {
  let caught: unknown
  try {
    parseRdpTunnel(raw)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RdpTunnelRejectedError)
  const message = (caught as Error).message
  expect(message).toMatch(pattern)
  for (const secret of [SSH_KEY, AWS_SECRET, AWS_TOKEN, TS_KEY]) {
    expect(message).not.toContain(secret)
  }
}

describe('RDP_TUNNEL_KINDS', () => {
  it('★ 契約の 3 値（api の RDP_TUNNEL_KINDS と同じ）', () => {
    expect([...RDP_TUNNEL_KINDS]).toEqual(['ssh', 'ssm', 'tailscale'])
  })
})

describe('parseRdpTunnel — 受理', () => {
  it('ssh（パスワード認証・自ホスト経由）', () => {
    const parsed = parseRdpTunnel(ssh({}, { authType: 'password', credential: 'p@ss' }))
    expect(parsed).toEqual({
      kind: 'ssh',
      target: { host: 'localhost', port: 3389 },
      via: {
        hostId: 'win-1',
        hostname: 'win.example.com',
        port: 22,
        username: 'admin',
        authType: 'password',
        credential: 'p@ss',
      },
    })
  })

  it('ssm（sessionToken あり）', () => {
    const parsed = parseRdpTunnel(ssm())
    expect(parsed.kind).toBe('ssm')
    expect(parsed.via).toEqual(
      expect.objectContaining({
        instanceId: 'i-0123456789abcdef0',
        awsCredentials: {
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: AWS_SECRET,
          sessionToken: AWS_TOKEN,
        },
      }),
    )
  })

  it('ssm（sessionToken なし・マネージドインスタンス mi-）', () => {
    const parsed = parseRdpTunnel(
      ssm({}, {
        instanceId: 'mi-0123456789abcdef0',
        awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET },
      }),
    )
    expect(parsed.via).toEqual(
      expect.objectContaining({
        awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET },
      }),
    )
  })

  it('tailscale（IPv4 の tailnet アドレスも可）', () => {
    const parsed = parseRdpTunnel(tailscale({ target: { host: '100.64.0.7', port: 3390 } }))
    expect(parsed).toEqual({
      kind: 'tailscale',
      target: { host: '100.64.0.7', port: 3390 },
      via: { hostId: 'win-2', authKey: TS_KEY },
    })
  })

  it('返り値は入力と別オブジェクト（余計なキーを持ち込まない）', () => {
    const raw = ssh({ extra: 'x' })
    const parsed = parseRdpTunnel(raw) as unknown as Record<string, unknown>
    expect(parsed).not.toBe(raw)
    expect(parsed.extra).toBeUndefined()
  })
})

describe('parseRdpTunnel — 拒否', () => {
  it.each([
    ['null', null],
    ['文字列', 'ssh'],
    ['配列', []],
  ])('オブジェクトでない（%s）', (_name, raw) => {
    expectRejected(raw, /tunnel/)
  })

  it('★ 未知の kind', () => {
    expectRejected(ssh({ kind: 'wireguard' }), /kind/)
  })

  it.each([
    ['target なし', { target: undefined }],
    ['host 空', { target: { host: '', port: 3389 } }],
    ['port 0', { target: { host: 'localhost', port: 0 } }],
    ['port 65536', { target: { host: 'localhost', port: 65536 } }],
    ['port 小数', { target: { host: 'localhost', port: 3389.5 } }],
    ['port 文字列', { target: { host: 'localhost', port: '3389' } }],
  ])('target の形が不正（%s）', (_name, overrides) => {
    expectRejected(ssh(overrides), /target/)
  })

  it('★ target.host に区切り文字を含む（SSM の --parameters へ注入させない）', () => {
    // SSM は host=...,portNumber=... の形で渡すため、カンマ入りの host を
    // 通すと宛先ポート等を差し替えられる。
    expectRejected(
      ssm({ target: { host: '10.0.0.1,portNumber=22', port: 3389 } }),
      /target\.host/,
    )
  })

  it('target.host が長すぎる', () => {
    expectRejected(ssh({ target: { host: 'a'.repeat(254), port: 3389 } }), /target\.host/)
  })

  it('via がオブジェクトでない', () => {
    expectRejected(ssh({ via: 'x' }), /via/)
  })

  it('★ kind と via の形が一致しない（ssh に ssm の via）', () => {
    expectRejected({ ...ssm(), kind: 'ssh' }, /via/)
  })

  it('★ kind と via の形が一致しない（tailscale の via に余計な credential）', () => {
    expectRejected(tailscale({}, { credential: SSH_KEY }), /via/)
  })

  it.each([
    ['hostId', { hostId: '' }],
    ['hostname', { hostname: '' }],
    ['hostname 区切り文字', { hostname: 'a b' }],
    ['port', { port: 0 }],
    ['username', { username: '' }],
    ['authType', { authType: 'keyboard-interactive' }],
    ['credential', { credential: '' }],
  ])('ssh の必須値（%s）', (field, via) => {
    expectRejected(ssh({}, via), new RegExp(`via\\.${field.split(' ')[0]}`))
  })

  it.each([
    ['instanceId', { instanceId: '' }],
    ['instanceId', { instanceId: 'i-xyz; rm -rf /' }],
    ['region', { region: '' }],
    ['region', { region: 'ap northeast' }],
    ['awsCredentials', { awsCredentials: null }],
    ['awsCredentials.accessKeyId', { awsCredentials: { accessKeyId: '', secretAccessKey: AWS_SECRET } }],
    ['awsCredentials.secretAccessKey', { awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: '' } }],
    [
      'awsCredentials.sessionToken',
      { awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET, sessionToken: 5 } },
    ],
    [
      'awsCredentials',
      { awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET, extra: 'x' } },
    ],
  ])('ssm の必須値（%s）', (field, via) => {
    expectRejected(ssm({}, via), new RegExp(`via\\.${field.replace('.', '\\.')}`))
  })

  it.each([
    ['hostId', { hostId: 1 }],
    ['authKey', { authKey: '' }],
  ])('tailscale の必須値（%s）', (field, via) => {
    expectRejected(tailscale({}, via), new RegExp(`via\\.${field}`))
  })
})

describe('rdpTunnelSecrets', () => {
  it('ssh: credential', () => {
    expect(rdpTunnelSecrets(parseRdpTunnel(ssh()))).toEqual([SSH_KEY])
  })

  it('ssm: secretAccessKey と sessionToken（accessKeyId は秘匿値ではない）', () => {
    expect(rdpTunnelSecrets(parseRdpTunnel(ssm()))).toEqual([AWS_SECRET, AWS_TOKEN])
  })

  it('ssm: sessionToken なし', () => {
    expect(
      rdpTunnelSecrets(
        parseRdpTunnel(
          ssm({}, { awsCredentials: { accessKeyId: 'AKIA', secretAccessKey: AWS_SECRET } }),
        ),
      ),
    ).toEqual([AWS_SECRET])
  })

  it('tailscale: authKey', () => {
    expect(rdpTunnelSecrets(parseRdpTunnel(tailscale()))).toEqual([TS_KEY])
  })
})
