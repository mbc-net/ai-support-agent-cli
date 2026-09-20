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
