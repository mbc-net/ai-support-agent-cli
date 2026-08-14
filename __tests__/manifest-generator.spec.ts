import {
  assertReplicasWithinLimit,
  generateEcsManifest,
  generateK8sManifest,
  ReplicaLimitExceededError,
} from '../src/manifest/manifest-generator'
import { CONTAINER_START_ARGV } from '../src/docker/docker-args'
import { loadAll } from 'js-yaml'

/**
 * CLI の実行ファイル名。`args` / `command` の先頭はこれでなければならない。
 * package.json の `bin` から導出する（リテラル直書きだと bin 名の変更を検出できない）。
 */
const CLI_BIN = Object.keys(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../package.json').bin as Record<string, string>,
)[0]

const BASE = {
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  token: 'mbc:tok-1:secret-raw-token',
  apiUrl: 'https://api.example.com',
  replicas: 3,
}

describe('assertReplicasWithinLimit', () => {
  it('accepts a count within the limit', () => {
    expect(() => assertReplicasWithinLimit(2, 3)).not.toThrow()
  })

  it('accepts a count equal to the limit', () => {
    expect(() => assertReplicasWithinLimit(3, 3)).not.toThrow()
  })

  it('accepts any count when the limit is null (unlimited)', () => {
    expect(() => assertReplicasWithinLimit(99, null)).not.toThrow()
  })

  it('rejects a count above the limit with an actionable message', () => {
    expect(() => assertReplicasWithinLimit(2, 1)).toThrow(
      ReplicaLimitExceededError,
    )
    expect(() => assertReplicasWithinLimit(2, 1)).toThrow(/at most 1/)
  })

  it('rejects zero and negative counts', () => {
    expect(() => assertReplicasWithinLimit(0, null)).toThrow(/positive integer/)
    expect(() => assertReplicasWithinLimit(-1, null)).toThrow(/positive integer/)
  })

  it('rejects non-integer counts', () => {
    expect(() => assertReplicasWithinLimit(1.5, null)).toThrow(
      /positive integer/,
    )
  })
})

describe('generateK8sManifest', () => {
  it('sets the requested replica count', () => {
    expect(generateK8sManifest(BASE)).toContain('replicas: 3')
  })

  it('生成する Deployment は imagePullPolicy: Always を明示する', () => {
    // 未指定だと Kubernetes の既定が効き、タグが latest 以外のときは IfNotPresent に
    // なる。:beta のような移動タグでは rollout restart しても中身が更新されない。
    const deployment = loadAll(generateK8sManifest(BASE)).find(
      (doc): doc is Record<string, any> =>
        (doc as Record<string, unknown>)?.kind === 'Deployment',
    )
    expect(deployment?.spec.template.spec.containers[0].imagePullPolicy).toBe('Always')
  })

  it('複数プロジェクトでも各 Deployment に imagePullPolicy が入る', () => {
    const manifest = generateK8sManifest({
      tenantCode: BASE.tenantCode,
      apiUrl: BASE.apiUrl,
      projects: [
        { projectCode: 'MBC_01', name: 'agent-a', token: 'tok-a', replicas: 1 },
        { projectCode: 'MBC_02', name: 'agent-b', token: 'tok-b', replicas: 1 },
      ],
    })
    const deployments = loadAll(manifest).filter(
      (doc): doc is Record<string, any> =>
        (doc as Record<string, unknown>)?.kind === 'Deployment',
    )
    expect(deployments).toHaveLength(2)
    for (const deployment of deployments) {
      expect(deployment.spec.template.spec.containers[0].imagePullPolicy).toBe('Always')
    }
  })

  it('puts the token in a Secret (base64) and never in args', () => {
    const manifest = generateK8sManifest(BASE)
    const encoded = Buffer.from(BASE.token, 'utf-8').toString('base64')

    expect(manifest).toContain(`AI_SUPPORT_AGENT_TOKEN: ${encoded}`)
    // The raw token must not appear anywhere in the manifest.
    expect(manifest).not.toContain(BASE.token)
  })

  it('binds the instance id to the Pod name via the downward API', () => {
    const manifest = generateK8sManifest(BASE)

    expect(manifest).toContain('name: AI_SUPPORT_AGENT_INSTANCE_ID')
    expect(manifest).toContain('fieldPath: metadata.name')
  })

  it('passes the target project through --project', () => {
    expect(generateK8sManifest(BASE)).toContain('- "mbc/MBC_01"')
  })

  it('honors namespace, image and name overrides', () => {
    const manifest = generateK8sManifest({
      ...BASE,
      namespace: 'agents',
      image: 'registry.example.com/agent:v2',
      name: 'custom-agent',
    })

    expect(manifest).toContain('namespace: agents')
    expect(manifest).toContain('image: "registry.example.com/agent:v2"')
    expect(manifest).toContain('name: custom-agent')
    expect(manifest).toContain('name: custom-agent-token')
  })

  it('defaults namespace to default', () => {
    expect(generateK8sManifest(BASE)).toContain('namespace: default')
  })

  it('points the agent at the given API URL', () => {
    expect(generateK8sManifest(BASE)).toContain(
      'value: "https://api.example.com"',
    )
  })
})

describe('generateEcsManifest', () => {
  const ecsInput = {
    ...BASE,
    cluster: 'agents-cluster',
    subnets: ['subnet-a', 'subnet-b'],
    securityGroups: ['sg-1'],
  }

  it('sets desiredCount to the requested replica count', () => {
    const { service } = generateEcsManifest(ecsInput)
    expect(JSON.parse(service).desiredCount).toBe(3)
  })

  it('passes the token via secrets, not environment', () => {
    const { taskDefinition } = generateEcsManifest(ecsInput)
    const parsed = JSON.parse(taskDefinition)
    const container = parsed.containerDefinitions[0]

    expect(container.secrets).toEqual([
      { name: 'AI_SUPPORT_AGENT_TOKEN', valueFrom: 'REPLACE_WITH_SECRET_ARN' },
    ])
    expect(taskDefinition).not.toContain(BASE.token)
    expect(
      container.environment.some(
        (e: { name: string }) => e.name === 'AI_SUPPORT_AGENT_TOKEN',
      ),
    ).toBe(false)
  })

  it('does not set an explicit instance id (ECS task id is derived at runtime)', () => {
    const { taskDefinition } = generateEcsManifest(ecsInput)
    const container = JSON.parse(taskDefinition).containerDefinitions[0]

    expect(
      container.environment.some(
        (e: { name: string }) => e.name === 'AI_SUPPORT_AGENT_INSTANCE_ID',
      ),
    ).toBe(false)
  })

  it('wires the network configuration from the given subnets and groups', () => {
    const { service } = generateEcsManifest(ecsInput)
    const awsvpc = JSON.parse(service).networkConfiguration.awsvpcConfiguration

    expect(awsvpc.subnets).toEqual(['subnet-a', 'subnet-b'])
    expect(awsvpc.securityGroups).toEqual(['sg-1'])
    expect(awsvpc.assignPublicIp).toBe('DISABLED')
  })

  it('enables a public IP when requested', () => {
    const { service } = generateEcsManifest({
      ...ecsInput,
      assignPublicIp: true,
    })

    expect(
      JSON.parse(service).networkConfiguration.awsvpcConfiguration
        .assignPublicIp,
    ).toBe('ENABLED')
  })

  it('applies cpu/memory/region/log group overrides', () => {
    const { taskDefinition } = generateEcsManifest({
      ...ecsInput,
      cpu: '2048',
      memory: '4096',
      region: 'us-east-1',
      logGroup: '/ecs/custom',
      executionRoleArn: 'arn:aws:iam::1:role/exec',
      taskRoleArn: 'arn:aws:iam::1:role/task',
    })
    const parsed = JSON.parse(taskDefinition)

    expect(parsed.cpu).toBe('2048')
    expect(parsed.memory).toBe('4096')
    expect(parsed.executionRoleArn).toBe('arn:aws:iam::1:role/exec')
    expect(parsed.taskRoleArn).toBe('arn:aws:iam::1:role/task')
    const logOptions =
      parsed.containerDefinitions[0].logConfiguration.options
    expect(logOptions['awslogs-region']).toBe('us-east-1')
    expect(logOptions['awslogs-group']).toBe('/ecs/custom')
  })

  it('emits an execution role placeholder when not provided, and omits the optional task role', () => {
    // 生成物は常に Secrets Manager 参照と awslogs を使うため execution role は必須。
    // 省略すると一見正しい JSON のまま RunTask が起動時に失敗する。
    const parsed = JSON.parse(generateEcsManifest(ecsInput).taskDefinition)

    expect(parsed.executionRoleArn).toBe('REPLACE_WITH_EXECUTION_ROLE_ARN')
    expect(parsed.taskRoleArn).toBeUndefined()
  })

  it('passes the target project through the container command', () => {
    const parsed = JSON.parse(generateEcsManifest(ecsInput).taskDefinition)

    expect(parsed.containerDefinitions[0].command).toEqual([
      CLI_BIN,
      'start',
      '--no-docker',
      '--project',
      'mbc/MBC_01',
    ])
  })
})

/**
 * コンテナ起動契約の回帰テスト。
 *
 * `args`（Kubernetes）と `command`（ECS）は CLI の引数リストではなく、Docker の
 * **CMD** にマップされてイメージの ENTRYPOINT に連結される引数列である。
 * 配布イメージは `ENTRYPOINT ["/entrypoint.sh"]` のみ（CMD なし）を持ち、
 * entrypoint.sh は末尾で `exec "$@"` するため、先頭がサブコマンド名だと
 * `exec start --project ...` となり `start: not found`（exit 127）で
 * CrashLoopBackOff になる（最小再現で実測）。
 *
 * bin 名は package.json から導出する。リテラル直書きにすると、将来 bin 名を
 * 変えたときにこのテストが「古い名前で通り続ける」ため。
 */
describe('コンテナ起動契約（ENTRYPOINT に連結される引数列）', () => {
  const ecsInput = {
    ...BASE,
    cluster: 'agents-cluster',
    subnets: ['subnet-a', 'subnet-b'],
    securityGroups: ['sg-1'],
  }

  /**
   * 期待する起動引数列。コンテナ内でエージェントを起動する既存の契約
   * （docker-supervisor.ts の `[...CONTAINER_START_ARGV, '--project', key]`）と
   * 同一でなければならない。
   *
   * `--no-docker` は必須。Commander の negated option は未指定時に
   * `opts.docker === true` となり（index.ts:57 で定義、:74 で分岐）、コンテナの
   * 中でさらに `runInDocker()` へ入って `checkDockerAvailable()` が Docker
   * ソケット不在で `exitWithError` する。実行ファイル名だけ足しても、exit 127 が
   * 別の起動失敗に置き換わるだけで「適用しても起動しない」は解消しない。
   */
  const EXPECTED_ARGV = [...CONTAINER_START_ARGV, '--project', 'mbc/MBC_01']

  it('Kubernetes の args がコンテナ起動契約と完全に一致する', () => {
    const manifest = generateK8sManifest(BASE)
    // 先頭数要素だけの部分検証にすると、途中のフラグ欠落を見逃す。
    const deployment = loadAll(manifest).find(
      (doc): doc is Record<string, any> =>
        (doc as Record<string, unknown>)?.kind === 'StatefulSet' ||
        (doc as Record<string, unknown>)?.kind === 'Deployment',
    )
    expect(deployment?.spec.template.spec.containers[0].args).toEqual(EXPECTED_ARGV)
  })

  it('ECS の command がコンテナ起動契約と完全に一致する', () => {
    const parsed = JSON.parse(generateEcsManifest(ecsInput).taskDefinition)

    expect(parsed.containerDefinitions[0].command).toEqual(EXPECTED_ARGV)
  })

  it('起動引数は CONTAINER_START_ARGV を単一の出所とする（契約の二重定義を防ぐ）', () => {
    expect(CONTAINER_START_ARGV).toEqual([CLI_BIN, 'start', '--no-docker'])
  })

  it('ECS はイメージの ENTRYPOINT を上書きしない（entryPoint を設定しない）', () => {
    // entryPoint を設定すると entrypoint.sh の初期化（git safe.directory 登録等）が
    // 丸ごと飛ぶ。command の先頭に bin 名を置く方式はこれを前提にしている。
    const parsed = JSON.parse(generateEcsManifest(ecsInput).taskDefinition)
    expect(parsed.containerDefinitions[0].entryPoint).toBeUndefined()
  })
})

describe('generateK8sManifest の YAML エスケープ', () => {
  const BASE = {
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    token: 'tok',
    apiUrl: 'https://api.example.com',
    replicas: 1,
  }

  it('コロンを含むイメージ名を引用してマッピング誤認を防ぐ', () => {
    // `image: registry:5000/agent:v2` は YAML のマッピング区切りと衝突する。
    const manifest = generateK8sManifest({
      ...BASE,
      image: 'registry:5000/agent:v2',
    })

    expect(manifest).toContain('image: "registry:5000/agent:v2"')
  })

  it('DNS-1123 ラベルでない namespace は生成時に落とす', () => {
    // metadata.name / ラベルセレクター / Secret 参照の複数箇所に展開されるため、
    // 引用符では救済できない。kubectl apply まで持ち越さず即座に失敗させる。
    expect(() =>
      generateK8sManifest({ ...BASE, namespace: 'team: prod' }),
    ).toThrow(/Invalid namespace/)
  })

  it('DNS-1123 ラベルでない name は生成時に落とす', () => {
    expect(() => generateK8sManifest({ ...BASE, name: 'My Agent' })).toThrow(
      /Invalid name/,
    )
  })

  it('64 文字以上の name は落とす（Kubernetes のラベル長上限）', () => {
    expect(() =>
      generateK8sManifest({ ...BASE, name: 'a'.repeat(64) }),
    ).toThrow(/Invalid name/)
  })
})
