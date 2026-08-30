import * as yaml from 'js-yaml'

import {
  generateEcsManifest,
  generateK8sManifest,
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

  it('guacd のログも同じロググループへ送る', () => {
    const guacd = definitions({ ...ECS_BASE, rdp: true })[1]
    expect(guacd.logConfiguration).toBeDefined()
  })
})
