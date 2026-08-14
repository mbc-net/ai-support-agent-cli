import {
  K8S_MULTI_STRUCTURE_GOLDEN,
  K8S_STRUCTURE_GOLDEN,
  MULTI_PARITY_INPUT,
  PARITY_INPUT,
  SERVICE_GOLDEN,
  TASKDEF_GOLDEN,
  stripComments,
} from './fixtures/manifest-parity-golden'
import {
  generateEcsManifest,
  generateK8sManifest,
} from '../src/manifest/manifest-generator'

/**
 * web（`web/src/lib/agent-deploy-manifest.ts`）との生成規則の一致を守る。
 * 対になるテストは web リポジトリの `src/lib/__tests__/agent-deploy-manifest-parity.test.ts`。
 * 詳細は fixtures/manifest-parity-golden.ts のコメントを参照。
 */
describe('マニフェスト生成規則の web とのパリティ', () => {
  it('K8s マニフェストの構造がゴールデン値と一致する', () => {
    expect(stripComments(generateK8sManifest(PARITY_INPUT))).toBe(
      K8S_STRUCTURE_GOLDEN,
    )
  })

  it('ECS タスク定義がゴールデン値と一致する', () => {
    const manifest = generateEcsManifest({
      ...PARITY_INPUT,
      cluster: 'c',
      subnets: ['s'],
      securityGroups: ['g'],
    })

    expect(JSON.parse(manifest.taskDefinition)).toEqual(TASKDEF_GOLDEN)
  })

  it('ECS サービス定義がゴールデン値と一致する', () => {
    const manifest = generateEcsManifest({
      ...PARITY_INPUT,
      cluster: 'c',
      subnets: ['s'],
      securityGroups: ['g'],
    })

    expect(JSON.parse(manifest.service)).toEqual(SERVICE_GOLDEN)
  })

  it('複数プロジェクトの K8s マニフェストがゴールデン値と一致する', () => {
    expect(stripComments(generateK8sManifest(MULTI_PARITY_INPUT))).toBe(
      K8S_MULTI_STRUCTURE_GOLDEN,
    )
  })
})
