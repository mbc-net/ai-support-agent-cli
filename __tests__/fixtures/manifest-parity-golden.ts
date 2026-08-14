/**
 * web と agent CLI のマニフェスト生成規則が一致していることを保証するゴールデン値。
 *
 * マニフェスト生成は web（`src/lib/agent-deploy-manifest.ts`）と
 * agent CLI（`src/manifest/manifest-generator.ts`）に**意図的に重複実装**されている
 * （web は管理画面から、CLI は手元から生成できる必要があり、リポジトリを跨いで
 * import できないため）。片方だけを直すと生成物が黙って乖離する。
 *
 * このファイルは**両リポジトリで一字一句同じ内容**でなければならない:
 *   - web:   src/lib/__fixtures__/manifest-parity-golden.ts
 *   - agent: __tests__/fixtures/manifest-parity-golden.ts
 * 生成規則を変えるときは、両方の実装とこのゴールデン値を同時に更新すること。
 * 片方だけ変更すると、そのリポジトリのパリティテストが落ちる。
 *
 * 先頭のコメント行は対象外（web は日本語、CLI は英語で利用者向け説明を出すため）。
 * 比較するのは構造だけである。
 */

/** コメント行と空行を除いた K8s マニフェスト */
export const K8S_STRUCTURE_GOLDEN = `apiVersion: v1
kind: Secret
metadata:
  name: ai-support-agent-token
  namespace: default
type: Opaque
data:
  AI_SUPPORT_AGENT_TOKEN: dG9r
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ai-support-agent
  namespace: default
  labels:
    app: ai-support-agent
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ai-support-agent
  template:
    metadata:
      labels:
        app: ai-support-agent
    spec:
      containers:
        - name: agent
          image: "ghcr.io/mbc-net/ai-support-agent-cli:latest"
          imagePullPolicy: Always
          args:
            - ai-support-agent
            - start
            - --no-docker
            - --project
            - "mbc/MBC_01"
          env:
            - name: AI_SUPPORT_AGENT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ai-support-agent-token
                  key: AI_SUPPORT_AGENT_TOKEN
            - name: AI_SUPPORT_AGENT_API_URL
              value: "https://api.example.com"
            - name: AI_SUPPORT_AGENT_INSTANCE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name`

/**
 * 複数プロジェクト指定（1プロジェクト = 1 Deployment）のゴールデン値。
 *
 * 単数指定と違い、この経路は Secret と Deployment の組をプロジェクト数だけ
 * 並べる。片方のリポジトリだけ並び順や Secret 名の導出を変えると、画面から
 * コピーしたマニフェストと CLI が出すマニフェストが黙って食い違う。
 */
export const K8S_MULTI_STRUCTURE_GOLDEN = `apiVersion: v1
kind: Secret
metadata:
  name: agent-mbc01-token
  namespace: default
type: Opaque
data:
  AI_SUPPORT_AGENT_TOKEN: dG9r
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-mbc01
  namespace: default
  labels:
    app: agent-mbc01
spec:
  replicas: 2
  selector:
    matchLabels:
      app: agent-mbc01
  template:
    metadata:
      labels:
        app: agent-mbc01
    spec:
      containers:
        - name: agent
          image: "ghcr.io/mbc-net/ai-support-agent-cli:latest"
          imagePullPolicy: Always
          args:
            - ai-support-agent
            - start
            - --no-docker
            - --project
            - "mbc/MBC_01"
          env:
            - name: AI_SUPPORT_AGENT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: agent-mbc01-token
                  key: AI_SUPPORT_AGENT_TOKEN
            - name: AI_SUPPORT_AGENT_API_URL
              value: "https://api.example.com"
            - name: AI_SUPPORT_AGENT_INSTANCE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
---
apiVersion: v1
kind: Secret
metadata:
  name: agent-mbc02-token
  namespace: default
type: Opaque
data:
  AI_SUPPORT_AGENT_TOKEN: dG9rMg==
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-mbc02
  namespace: default
  labels:
    app: agent-mbc02
spec:
  replicas: 1
  selector:
    matchLabels:
      app: agent-mbc02
  template:
    metadata:
      labels:
        app: agent-mbc02
    spec:
      containers:
        - name: agent
          image: "ghcr.io/mbc-net/ai-support-agent-cli:latest"
          imagePullPolicy: Always
          args:
            - ai-support-agent
            - start
            - --no-docker
            - --project
            - "mbc/MBC_02"
          env:
            - name: AI_SUPPORT_AGENT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: agent-mbc02-token
                  key: AI_SUPPORT_AGENT_TOKEN
            - name: AI_SUPPORT_AGENT_API_URL
              value: "https://api.example.com"
            - name: AI_SUPPORT_AGENT_INSTANCE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name`

/** 複数プロジェクトのゴールデン値を生成する共通の入力 */
export const MULTI_PARITY_INPUT = {
  tenantCode: 'mbc',
  apiUrl: 'https://api.example.com',
  projects: [
    { projectCode: 'MBC_01', token: 'tok', name: 'agent-mbc01', replicas: 2 },
    { projectCode: 'MBC_02', token: 'tok2', name: 'agent-mbc02' },
  ],
}

/** ゴールデン値を生成する共通の入力 */
export const PARITY_INPUT = {
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  token: 'tok',
  apiUrl: 'https://api.example.com',
  replicas: 2,
}

/** ECS タスク定義（パース後の JSON） */
export const TASKDEF_GOLDEN = {
  family: 'ai-support-agent',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: '1024',
  memory: '2048',
  executionRoleArn: 'REPLACE_WITH_EXECUTION_ROLE_ARN',
  containerDefinitions: [
    {
      name: 'agent',
      image: 'ghcr.io/mbc-net/ai-support-agent-cli:latest',
      essential: true,
      command: ['ai-support-agent', 'start', '--no-docker', '--project', 'mbc/MBC_01'],
      environment: [
        {
          name: 'AI_SUPPORT_AGENT_API_URL',
          value: 'https://api.example.com',
        },
      ],
      secrets: [
        {
          name: 'AI_SUPPORT_AGENT_TOKEN',
          valueFrom: 'REPLACE_WITH_SECRET_ARN',
        },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/ai-support-agent',
          'awslogs-region': 'ap-northeast-1',
          'awslogs-stream-prefix': 'agent',
          'awslogs-create-group': 'true',
        },
      },
    },
  ],
}

/** ECS サービス定義（パース後の JSON） */
export const SERVICE_GOLDEN = {
  cluster: 'c',
  serviceName: 'ai-support-agent',
  taskDefinition: 'ai-support-agent',
  desiredCount: 2,
  launchType: 'FARGATE',
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: ['s'],
      securityGroups: ['g'],
      assignPublicIp: 'DISABLED',
    },
  },
}

/** コメント行・空行を除去する（利用者向け説明文はリポジトリごとに異なるため） */
export function stripComments(manifest: string): string {
  return manifest
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && line.trim() !== '')
    .join('\n')
}
