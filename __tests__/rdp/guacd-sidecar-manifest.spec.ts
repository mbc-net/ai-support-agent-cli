import * as yaml from 'js-yaml'

import { logger } from '../../src/logger'

import {
  DEFAULT_GUACD_IMAGE,
  generateEcsManifest,
  generateK8sManifest,
  GUACD_LOOPBACK_COMMAND,
} from '../../src/manifest/manifest-generator'

/**
 * guacd サイドカーの生成。
 *
 * ブラウザは RDP を直接扱えないため、プロトコル変換ゲートウェイ（guacd）を
 * エージェントと同じ Pod / タスクに置く。**エージェントからは localhost で
 * 到達する**構成にすることで、guacd をネットワークに露出させない。
 *
 * :::danger
 * guacd には認証が無い。到達できる者は誰でも任意のホストへ RDP 接続を張れる。
 * Pod / タスク内の localhost に閉じ込めることが唯一の防御線であり、Service や
 * ポートマッピングで外に出してはならない。
 * :::
 */

const BASE = {
  tenantCode: 'mbc',
  apiUrl: 'https://api.example.com',
  projectCode: 'MBC_01',
  token: 'agent-token',
}

/** 生成された YAML から Deployment を取り出す。 */
function deployment(manifest: string): Record<string, unknown> {
  const docs = yaml.loadAll(manifest) as Record<string, unknown>[]
  const found = docs.find((d) => d?.kind === 'Deployment')
  if (!found) throw new Error('Deployment が見つかりません')
  return found
}

/** Deployment の containers 配列。 */
function containers(manifest: string): Record<string, unknown>[] {
  const spec = deployment(manifest).spec as Record<string, unknown>
  const template = spec.template as Record<string, unknown>
  const podSpec = template.spec as Record<string, unknown>
  return podSpec.containers as Record<string, unknown>[]
}

describe('generateK8sManifest — guacd サイドカー', () => {
  describe('既定（RDP 無効）', () => {
    it('エージェントだけを生成する', () => {
      const names = containers(generateK8sManifest(BASE)).map((c) => c.name)
      expect(names).toEqual(['agent'])
    })

    it('★ GUACD_HOST を設定しない（未配置なのに接続先があると誤認させない）', () => {
      const agent = containers(generateK8sManifest(BASE))[0]
      const env = (agent.env as Record<string, unknown>[]).map((e) => e.name)
      expect(env).not.toContain('GUACD_HOST')
      expect(env).not.toContain('AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN')
    })
  })

  describe('rdp: true', () => {
    const manifest = () => generateK8sManifest({ ...BASE, rdp: true })

    it('guacd サイドカーを追加する', () => {
      expect(containers(manifest()).map((c) => c.name)).toEqual([
        'agent',
        'guacd',
      ])
    })

    it('★ エージェントへ localhost の guacd を教える', () => {
      const agent = containers(manifest())[0]
      const env = agent.env as Record<string, unknown>[]
      expect(env).toContainEqual({ name: 'GUACD_HOST', value: '127.0.0.1' })
      expect(env).toContainEqual({ name: 'GUACD_PORT', value: '4822' })
    })

    it('★ RDP トンネル中継の待ち受けを loopback と明示する（Pod 内で guacd と名前空間を共有）', () => {
      const agent = containers(manifest())[0]
      const env = agent.env as Record<string, unknown>[]
      expect(env).toContainEqual({
        name: 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN',
        value: 'loopback',
      })
    })

    it('★ 待受を loopback に限定する（ポートを公開しないだけでは足りない）', () => {
      // guacamole/guacd の CMD は `guacd -b 0.0.0.0`。Pod 内のコンテナは
      // ネットワーク名前空間を共有するため、hostPort を付けなくても
      // **他 Pod から PodIP:4822 に到達できる**（実機で確認済み）。guacd には
      // 認証が無いので、これは同一クラスタ内の任意のワークロードが任意の
      // ホストへ RDP を張れる状態を意味する。
      const guacd = containers(manifest())[1]
      const cmdline = [
        ...((guacd.command ?? []) as string[]),
        ...((guacd.args ?? []) as string[]),
      ].join(' ')
      expect(cmdline).toContain('-b 127.0.0.1')
      expect(cmdline).not.toContain('0.0.0.0')
    })

    it('★ guacd のポートを Pod 外へ公開しない', () => {
      const guacd = containers(manifest())[1]
      // containerPort の宣言は情報提供に過ぎないが、hostPort が付くとノードの
      // ポートに露出する。guacd は無認証のため絶対に付けない。
      const ports = (guacd.ports ?? []) as Record<string, unknown>[]
      for (const port of ports) {
        expect(port).not.toHaveProperty('hostPort')
      }
    })

    it('guacd のイメージを版固定で指定する', () => {
      const guacd = containers(manifest())[1]
      expect(String(guacd.image)).toMatch(/^guacamole\/guacd:\d+\.\d+\.\d+$/)
    })

    it('イメージを上書きできる', () => {
      const custom = generateK8sManifest({
        ...BASE,
        rdp: true,
        guacdImage: 'registry.example.com/guacd:1.5.5',
      })
      expect(containers(custom)[1].image).toBe(
        'registry.example.com/guacd:1.5.5',
      )
    })

    it('★ guacd を essential 扱いにしない（落ちてもエージェントを巻き添えにしない）', () => {
      // K8s に essential 相当は無いが、restartPolicy は Pod 単位。guacd の
      // クラッシュでエージェントごと再起動されると、実行中のコマンドが中断する。
      // ここでは「guacd に独自の livenessProbe を付けない」ことで、guacd の
      // 不調が Pod 全体の再起動に直結しないようにする。
      const guacd = containers(manifest())[1]
      expect(guacd).not.toHaveProperty('livenessProbe')
    })

    it('guacd に読み取り専用ルートと非 root を強制する', () => {
      const guacd = containers(manifest())[1]
      const security = guacd.securityContext as Record<string, unknown>
      expect(security).toMatchObject({
        runAsNonRoot: true,
        readOnlyRootFilesystem: true,
        allowPrivilegeEscalation: false,
      })
    })

    it('★ 非 root を kubelet が検証できるよう数値の UID/GID を明示する（イメージの USER は名前 "guacd"）', () => {
      // runAsNonRoot だけだと、名前指定の USER を kubelet が検証できず
      // CreateContainerConfigError になる。
      const guacd = containers(manifest())[1]
      expect(guacd.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 })
    })

    it('複数プロジェクトでも各 Deployment にサイドカーが付く', () => {
      const multi = generateK8sManifest({
        tenantCode: 'mbc',
        apiUrl: 'https://api.example.com',
        rdp: true,
        projects: [
          // name はリソース名になるため一意が必須（重複は上書きになる）。
          { projectCode: 'P1', token: 't1', name: 'agent-p1' },
          { projectCode: 'P2', token: 't2', name: 'agent-p2' },
        ],
      })
      const docs = (yaml.loadAll(multi) as Record<string, unknown>[]).filter(
        (d) => d?.kind === 'Deployment',
      )
      expect(docs).toHaveLength(2)
      for (const doc of docs) {
        const spec = doc.spec as Record<string, unknown>
        const template = spec.template as Record<string, unknown>
        const podSpec = template.spec as Record<string, unknown>
        const names = (podSpec.containers as Record<string, unknown>[]).map(
          (c) => c.name,
        )
        expect(names).toEqual(['agent', 'guacd'])
      }
    })
  })
})

describe('generateEcsManifest — guacd サイドカー', () => {
  const ECS_BASE = {
    ...BASE,
    cluster: 'c1',
    subnets: ['subnet-1'],
    securityGroups: ['sg-1'],
  }

  const definitions = (input: Parameters<typeof generateEcsManifest>[0]) =>
    (
      JSON.parse(generateEcsManifest(input).taskDefinition) as {
        containerDefinitions: Record<string, unknown>[]
      }
    ).containerDefinitions

  it('既定ではエージェントだけ', () => {
    expect(definitions(ECS_BASE).map((c) => c.name)).toEqual(['agent'])
  })

  it('rdp: true で guacd を追加する', () => {
    expect(
      definitions({ ...ECS_BASE, rdp: true }).map((c) => c.name),
    ).toEqual(['agent', 'guacd'])
  })

  it('★ awsvpc なのでエージェントは localhost で到達する', () => {
    const agent = definitions({ ...ECS_BASE, rdp: true })[0]
    const env = agent.environment as Record<string, unknown>[]
    expect(env).toContainEqual({ name: 'GUACD_HOST', value: '127.0.0.1' })
  })

  it('★ RDP トンネル中継の待ち受けを loopback と明示する（awsvpc で名前空間を共有）', () => {
    const agent = definitions({ ...ECS_BASE, rdp: true })[0]
    const env = agent.environment as Record<string, unknown>[]
    expect(env).toContainEqual({
      name: 'AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN',
      value: 'loopback',
    })
  })

  it('RDP 無効ならトンネル中継の待ち受けも設定しない', () => {
    const agent = definitions(ECS_BASE)[0]
    const names = (agent.environment as Record<string, unknown>[]).map((e) => e.name)
    expect(names).not.toContain('AI_SUPPORT_AGENT_RDP_TUNNEL_LISTEN')
  })

  it('★ guacd を essential にしない（落ちてもタスクを止めない）', () => {
    // essential: true にすると guacd のクラッシュでタスク全体が停止し、
    // 実行中のコマンドが中断する。RDP は付加機能であり、本体を巻き添えにしない。
    const guacd = definitions({ ...ECS_BASE, rdp: true })[1]
    expect(guacd.essential).toBe(false)
  })

  it('★ ポートを外へ公開しない', () => {
    const guacd = definitions({ ...ECS_BASE, rdp: true })[1]
    expect(guacd.portMappings ?? []).toEqual([])
  })

  it('★ 待受を loopback に限定する（portMappings: [] は待受を制限しない）', () => {
    // awsvpc ではタスク内の全コンテナが同じ ENI を共有するため、guacd が
    // 0.0.0.0 で待つと**タスクの ENI アドレス経由で VPC 内から到達できる**。
    // portMappings を空にしても待受アドレスは変わらない。
    const guacd = definitions({ ...ECS_BASE, rdp: true })[1]
    const cmdline = ((guacd.command ?? []) as string[]).join(' ')
    expect(cmdline).toContain('-b 127.0.0.1')
    expect(cmdline).not.toContain('0.0.0.0')
  })

  it('guacd のログも同じロググループへ送る', () => {
    const guacd = definitions({ ...ECS_BASE, rdp: true })[1]
    expect(guacd.logConfiguration).toBeDefined()
  })
})

describe('guacd イメージの前提', () => {
  it('★ 起動指定が依存しているイメージのタグを固定する', () => {
    // マニフェストは待受を loopback に絞るため、イメージの既定 CMD を
    // `['/bin/sh','-c','...']` で丸ごと置き換えている。この形が成立するのは
    // **このイメージに ENTRYPOINT が無い**（`command` がそのまま argv になる）
    // ためである。ENTRYPOINT を持つイメージへ差し替えると、`/bin/sh` `-c`
    // `<script>` が本体の引数として渡り、guacd は不正引数で終了する。
    //
    // 実機で確認済み（2026-08-31, guacamole/guacd:1.5.5）:
    //   docker image inspect → Entrypoint: null
    //   docker run <image> /bin/sh -c '... -b 127.0.0.1 ...'
    //     → "Listening on host 127.0.0.1, port 4822" / 127.0.0.1:4822 で LISTEN
    //
    // **タグを上げるときは、上記 2 点を実機で取り直してからこのテストを更新すること。**
    expect(DEFAULT_GUACD_IMAGE).toBe('guacamole/guacd:1.5.5')
  })

  it('★ 起動指定はシェル経由の形（ENTRYPOINT 無しのイメージを前提とする）', () => {
    const command = GUACD_LOOPBACK_COMMAND
    expect(command.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(command).toHaveLength(3)
    expect(command[2]).toContain('-b 127.0.0.1')
    expect(command[2]).not.toContain('0.0.0.0')
  })
})

describe('★ カスタムイメージ指定時の警告', () => {
  const ECS_BASE_FOR_WARN = {
    ...BASE,
    cluster: 'c1',
    subnets: ['subnet-1'],
    securityGroups: ['sg-1'],
  }

  /**
   * :::danger
   * **`command` の上書きは「イメージに ENTRYPOINT が無い」ことが前提。**
   * 既定の `guacamole/guacd:1.5.5` は実機で確認済みだが、`--guacd-image` で
   * ENTRYPOINT を持つイメージを指定されると `/bin/sh -c <script>` が本体の
   * 引数として渡り、guacd は不正引数で終了する。`essential: false` のため
   * 他機能は動き続け、**Web RDP だけが黙って使えなくなる**。
   * :::
   */
  it('既定以外のイメージを指定したら警告を残す', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      generateEcsManifest({
        ...ECS_BASE_FOR_WARN,
        rdp: true,
        guacdImage: 'registry.example.com/custom-guacd:1',
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENTRYPOINT'))
    } finally {
      warn.mockRestore()
    }
  })

  it('★ K8s では guacd が UID/GID 1000 で動くことを警告に含める', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      generateK8sManifest({ ...BASE, rdp: true, guacdImage: 'registry.example.com/custom-guacd:1' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENTRYPOINT'))
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/On Kubernetes, guacd runs as UID\/GID 1000/),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('既定のイメージでは警告を出さない', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      generateEcsManifest({ ...ECS_BASE_FOR_WARN, rdp: true })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('RDP の信頼 CA（guacd と共有する信頼ストア）', () => {
  const CA_DIR_ENV = 'AI_SUPPORT_AGENT_RDP_TRUSTED_CA_DIR'
  const MOUNT = '/run/ais-rdp-ca'

  it('★ guacd の起動コマンドは信頼ストアに書かない（guacd は読むだけ）', () => {
    const script = GUACD_LOOPBACK_COMMAND[2]
    expect(script).not.toContain(MOUNT)
    expect(script).not.toContain('ca-certificates.crt')
    expect(script).toMatch(/^\/opt\/guacamole\/sbin\/guacd -b 127\.0\.0\.1 /)
  })

  describe('K8s', () => {
    const podSpec = (input: Record<string, unknown> = {}): Record<string, unknown> => {
      const spec = deployment(generateK8sManifest({ ...BASE, rdp: true, ...input })).spec as Record<string, unknown>
      return (spec.template as Record<string, unknown>).spec as Record<string, unknown>
    }

    it('★ Pod に emptyDir の共有ボリュームを置く', () => {
      expect(podSpec().volumes).toEqual([
        { name: 'rdp-trusted-ca', emptyDir: { sizeLimit: '16Mi' } },
      ])
    })

    it('★ initContainer を置かない（guacd イメージが取得できなくてもエージェントを起動させる）', () => {
      // 標準 CA の配置はエージェント自身が起動時に行う（prepareRdpTrustedCaStore）。
      const pod = podSpec()
      expect(pod).not.toHaveProperty('initContainers')
      expect(generateK8sManifest({ ...BASE, rdp: true })).not.toContain('rdp-trusted-ca-init')
    })

    it('★ guacd は SSL_CERT_FILE で bundle.pem を読み、共有ボリュームを読み取り専用でマウントする', () => {
      const guacd = (podSpec().containers as Record<string, unknown>[])[1]
      expect(guacd.env).toEqual([{ name: 'SSL_CERT_FILE', value: `${MOUNT}/bundle.pem` }])
      expect(guacd.volumeMounts).toEqual([{ name: 'rdp-trusted-ca', mountPath: MOUNT, readOnly: true }])
      expect(guacd.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        readOnlyRootFilesystem: true,
      })
    })

    it('★ エージェントへ共有ディレクトリを教え、同じボリュームを書き込み可能でマウントする', () => {
      const agent = (podSpec().containers as Record<string, unknown>[])[0]
      expect(agent.env).toEqual(expect.arrayContaining([{ name: CA_DIR_ENV, value: MOUNT }]))
      expect(agent.volumeMounts).toEqual([{ name: 'rdp-trusted-ca', mountPath: MOUNT }])
    })

    it('RDP 無効なら共有ボリューム・env を出さない', () => {
      const manifest = generateK8sManifest(BASE)
      const spec = deployment(manifest).spec as Record<string, unknown>
      const pod = (spec.template as Record<string, unknown>).spec as Record<string, unknown>
      expect(pod).not.toHaveProperty('volumes')
      expect(pod).not.toHaveProperty('initContainers')
      expect(manifest).not.toContain(CA_DIR_ENV)
      expect(manifest).not.toContain('rdp-trusted-ca')
    })
  })

  describe('ECS', () => {
    const ECS_BASE = {
      ...BASE,
      cluster: 'c1',
      subnets: ['subnet-1'],
      securityGroups: ['sg-1'],
    }
    const taskDefinition = (rdp: boolean, extra: Record<string, unknown> = {}) =>
      JSON.parse(generateEcsManifest({ ...ECS_BASE, rdp, ...extra }).taskDefinition) as {
        volumes?: unknown[]
        containerDefinitions: Record<string, unknown>[]
      }
    const byName = (td: ReturnType<typeof taskDefinition>, name: string) =>
      td.containerDefinitions.find((c) => c.name === name)

    it('★ 初期化コンテナを置かず、agent と guacd だけ', () => {
      expect(taskDefinition(true).containerDefinitions.map((c) => c.name)).toEqual(['agent', 'guacd'])
      expect(JSON.stringify(taskDefinition(true))).not.toContain('rdp-trusted-ca-init')
    })

    it('★ guacd は共有ボリュームを読み取り専用でマウントし、何も待たない', () => {
      const guacd = byName(taskDefinition(true), 'guacd')
      expect(guacd?.mountPoints).toEqual([
        { sourceVolume: 'rdp-trusted-ca', containerPath: MOUNT, readOnly: true },
      ])
      expect(guacd?.environment).toEqual([{ name: 'SSL_CERT_FILE', value: `${MOUNT}/bundle.pem` }])
      expect(guacd).not.toHaveProperty('dependsOn')
    })

    it('★ エージェントは共有ボリュームを書き込み可能でマウントし、共有ディレクトリを教わる（何も待たない）', () => {
      const td = taskDefinition(true)
      expect(td.volumes).toEqual([{ name: 'rdp-trusted-ca' }])
      const agent = byName(td, 'agent')
      expect(agent?.mountPoints).toEqual([
        { sourceVolume: 'rdp-trusted-ca', containerPath: MOUNT, readOnly: false },
      ])
      expect(agent?.environment).toEqual(expect.arrayContaining([{ name: CA_DIR_ENV, value: MOUNT }]))
      expect(agent).not.toHaveProperty('dependsOn')
    })

    it('RDP 無効なら共有ボリューム・env を出さない', () => {
      const td = taskDefinition(false)
      expect(td.containerDefinitions.map((c) => c.name)).toEqual(['agent'])
      expect(td).not.toHaveProperty('volumes')
      expect(td.containerDefinitions[0]).not.toHaveProperty('mountPoints')
      expect(JSON.stringify(td)).not.toContain(CA_DIR_ENV)
    })
  })
})
