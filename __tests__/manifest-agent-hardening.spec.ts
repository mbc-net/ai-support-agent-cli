import * as yaml from 'js-yaml'

import { generateEcsManifest, generateK8sManifest } from '../src/manifest/manifest-generator'

/**
 * エージェントコンテナの堅牢化（NET_RAW を外す）。
 *
 * RDP の中継は 127.0.0.1（K8s / ECS では guacd と名前空間を共有）で待ち受ける。
 * NET_RAW があると、同じ名前空間の中で生ソケットを使った偽装・盗聴ができる。
 * runAsNonRoot は付けない（既存イメージの起動に影響するため、別途判断）。
 */

const BASE = {
  tenantCode: 'mbc',
  apiUrl: 'https://api.example.com',
  projectCode: 'MBC_01',
  token: 'agent-token',
}

function agentContainer(manifest: string): Record<string, unknown> {
  const docs = yaml.loadAll(manifest) as Record<string, unknown>[]
  const deployment = docs.find((d) => d?.kind === 'Deployment') as Record<string, any>
  return (deployment.spec.template.spec.containers as Record<string, unknown>[]).find(
    (c) => c.name === 'agent',
  ) as Record<string, unknown>
}

describe('K8s: agent コンテナの securityContext', () => {
  it.each([
    ['RDP 無効', false],
    ['RDP 有効', true],
  ])('★ %s でも NET_RAW だけを外す（allowPrivilegeEscalation は付けない）', (_name, rdp) => {
    // allowPrivilegeEscalation: false は、Codex サンドボックスの手順（agent に
    // SYS_ADMIN を add）と組み合わせると K8s の API 検証で拒否される。
    const agent = agentContainer(generateK8sManifest({ ...BASE, rdp }))
    expect(agent.securityContext).toEqual({
      capabilities: { drop: ['NET_RAW'] },
    })
  })

  it('runAsNonRoot は付けない', () => {
    const agent = agentContainer(generateK8sManifest({ ...BASE, rdp: true }))
    expect(agent.securityContext).not.toHaveProperty('runAsNonRoot')
  })
})

describe('ECS: guacd サイドカーの linuxParameters', () => {
  const ECS_BASE = { ...BASE, cluster: 'c1', subnets: ['subnet-1'], securityGroups: ['sg-1'] }

  it('★ K8s の guacd（capabilities.drop: ALL）とそろえて、全ケーパビリティを外す', () => {
    const defs = (
      JSON.parse(generateEcsManifest({ ...ECS_BASE, rdp: true }).taskDefinition) as {
        containerDefinitions: Record<string, unknown>[]
      }
    ).containerDefinitions
    const guacd = defs.find((c) => c.name === 'guacd') as Record<string, unknown>
    expect(guacd.linuxParameters).toEqual({ capabilities: { drop: ['ALL'] } })
  })
})

describe('ECS: agent コンテナの linuxParameters', () => {
  const ECS_BASE = { ...BASE, cluster: 'c1', subnets: ['subnet-1'], securityGroups: ['sg-1'] }

  it.each([
    ['RDP 無効', false],
    ['RDP 有効', true],
  ])('★ %s でも NET_RAW を外す', (_name, rdp) => {
    const defs = (
      JSON.parse(generateEcsManifest({ ...ECS_BASE, rdp }).taskDefinition) as {
        containerDefinitions: Record<string, unknown>[]
      }
    ).containerDefinitions
    const agent = defs.find((c) => c.name === 'agent') as Record<string, unknown>
    expect(agent.linuxParameters).toEqual({ capabilities: { drop: ['NET_RAW'] } })
  })
})
