/**
 * Deployment manifest generation for multi-replica agent deployments.
 *
 * Produces a Kubernetes Deployment (+ Secret) or an ECS task definition (+
 * service definition) that runs N replicas of the agent CLI from **one** agent
 * token. All replicas register as the same logical agent and are told apart by
 * their instance id, so scaling out never means registering another agent.
 *
 * The generators are pure string builders with no filesystem or network access
 * so they can be unit-tested and reused verbatim by the web UI.
 */

import { ENV_VARS } from '../constants'

/** Container image used when the caller does not pass one. */
export const DEFAULT_AGENT_IMAGE = 'ghcr.io/mbc-net/ai-support-agent-cli:latest'

/** Kubernetes Secret / Deployment name used when the caller does not pass one. */
export const DEFAULT_K8S_NAME = 'ai-support-agent'

/** ECS task definition family used when the caller does not pass one. */
export const DEFAULT_ECS_FAMILY = 'ai-support-agent'

export interface ManifestInput {
  /** Tenant code (lower_snake_case). */
  tenantCode: string
  /** Project code (UPPER_SNAKE_CASE). */
  projectCode: string
  /** Agent token. Embedded in a Secret / Secrets Manager reference, never in args. */
  token: string
  /** API base URL the agent connects to. */
  apiUrl: string
  /** Desired replica count. */
  replicas: number
  /** Container image. */
  image?: string
  /** Resource name (Deployment / Secret / task family). */
  name?: string
}

export interface K8sManifestInput extends ManifestInput {
  namespace?: string
}

export interface EcsManifestInput extends ManifestInput {
  /** ECS cluster name (used in the service definition). */
  cluster: string
  subnets: string[]
  securityGroups: string[]
  /** CloudWatch Logs group for the awslogs driver. */
  logGroup?: string
  /** Task execution role ARN (required to pull images / write logs). */
  executionRoleArn?: string
  taskRoleArn?: string
  region?: string
  cpu?: string
  memory?: string
  assignPublicIp?: boolean
}

/** Thrown when the requested replica count is not allowed. */
export class ReplicaLimitExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly maxReplicas: number,
  ) {
    super(
      `Requested ${requested} replicas but the current plan allows at most ${maxReplicas}. ` +
        `Lower --replicas, or ask your administrator to raise the limit.`,
    )
    this.name = 'ReplicaLimitExceededError'
  }
}

/**
 * Validate a replica count against the plan limit.
 *
 * `maxReplicas === null` means unlimited. Generating a manifest that exceeds
 * the limit is refused up front rather than left to fail at runtime: the extra
 * replicas would start, be denied a slot, and sit in standby forever, which
 * looks like a broken deployment rather than a quota decision.
 */
export function assertReplicasWithinLimit(
  replicas: number,
  maxReplicas: number | null,
): void {
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error(`--replicas must be a positive integer (got ${replicas})`)
  }
  if (maxReplicas !== null && replicas > maxReplicas) {
    throw new ReplicaLimitExceededError(replicas, maxReplicas)
  }
}

/**
 * Quote a value as a YAML double-quoted scalar.
 *
 * Manifest inputs come from CLI flags / the admin UI, so values can contain
 * `:`, `#`, newlines, leading `*`/`&` etc. Interpolating them raw produces a
 * manifest that either fails to parse or — worse — parses into a different
 * structure than intended. JSON string syntax is a subset of YAML's
 * double-quoted scalar syntax, so `JSON.stringify` is a correct quoter here.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

/**
 * Kubernetes object names and namespaces must be DNS-1123 labels. They are
 * interpolated into several structural positions (metadata.name, label
 * selectors, the Secret reference), so an invalid value cannot be rescued by
 * quoting — it would produce a manifest `kubectl` rejects at apply time with a
 * message that does not point back to the flag that caused it. Fail early with
 * the offending value instead.
 */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function assertDns1123Label(value: string, field: string): string {
  if (value.length > 63 || !DNS_1123_LABEL.test(value)) {
    throw new Error(
      `Invalid ${field} "${value}": must be a lowercase DNS-1123 label ` +
        '(alphanumerics and "-", starting and ending with an alphanumeric, max 63 chars)',
    )
  }
  return value
}

/** Base64-encode a Secret value (Kubernetes `data` requires base64). */
function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

/**
 * Generate a Kubernetes Secret + Deployment.
 *
 * The token goes into a Secret (never into `args`, where it would be visible
 * in `kubectl get pod -o yaml` and in every process listing inside the node).
 * `AI_SUPPORT_AGENT_INSTANCE_ID` is bound to the Pod name via the downward API
 * so each replica has a stable, human-recognizable identity in the admin UI.
 */
export function generateK8sManifest(input: K8sManifestInput): string {
  const name = assertDns1123Label(input.name ?? DEFAULT_K8S_NAME, 'name')
  const namespace = assertDns1123Label(
    input.namespace ?? 'default',
    'namespace',
  )
  const image = input.image ?? DEFAULT_AGENT_IMAGE
  const secretName = assertDns1123Label(`${name}-token`, 'secret name')

  return `# Generated by ai-support-agent-cli \`manifest k8s\`.
# One agent token runs ${input.replicas} replica(s) of the same logical agent:
# every Pod registers with the same token and is distinguished by
# ${ENV_VARS.INSTANCE_ID} (bound to the Pod name below). Scaling out does not
# require registering another agent.
#
# Replicas beyond the plan limit are not rejected outright — they stay in
# standby and take over automatically when a running replica stops.
#
# SECURITY: the Secret below carries the agent token. The 'data' field is base64,
# which is an encoding, not encryption — anyone who can read this file can
# recover the token. Do not commit it. To keep the token out of the file
# entirely, delete the Secret block and point secretKeyRef at a Secret you create
# out-of-band (kubectl create secret generic ... --from-literal=...) or at an
# ExternalSecret.
apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
type: Opaque
data:
  AI_SUPPORT_AGENT_TOKEN: ${b64(input.token)}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app: ${name}
spec:
  replicas: ${input.replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
        - name: agent
          image: ${yamlScalar(image)}
          args:
            - start
            - --project
            - ${yamlScalar(`${input.tenantCode}/${input.projectCode}`)}
          env:
            - name: ${ENV_VARS.TOKEN}
              valueFrom:
                secretKeyRef:
                  name: ${secretName}
                  key: AI_SUPPORT_AGENT_TOKEN
            - name: ${ENV_VARS.API_URL}
              value: ${yamlScalar(input.apiUrl)}
            # Replica identity. The Pod name is stable for the Pod's lifetime,
            # which is exactly the lifetime of one replica slot.
            - name: ${ENV_VARS.INSTANCE_ID}
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
`
}

/**
 * Generate an ECS task definition and a service definition.
 *
 * Returned as two JSON documents so they can be fed to
 * \`aws ecs register-task-definition --cli-input-json\` and
 * \`aws ecs create-service --cli-input-json\` respectively.
 *
 * The token is passed via \`secrets\` (Secrets Manager / SSM) rather than
 * \`environment\` so it never appears in \`aws ecs describe-task-definition\`
 * output. The caller stores the token and passes the resulting ARN.
 */
export function generateEcsManifest(input: EcsManifestInput): {
  taskDefinition: string
  service: string
} {
  const family = input.name ?? DEFAULT_ECS_FAMILY
  const image = input.image ?? DEFAULT_AGENT_IMAGE
  const region = input.region ?? 'ap-northeast-1'
  const logGroup = input.logGroup ?? `/ecs/${family}`

  const taskDefinition = {
    family,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: input.cpu ?? '1024',
    memory: input.memory ?? '2048',
    // 生成物は常に Secrets Manager 参照と awslogs を使うため、execution role は
    // **必須**。未指定でも省略せず、cluster / subnets と同じく置換が必要と分かる
    // プレースホルダーを出す。省略すると一見正しい JSON のまま RunTask が
    // 起動時に失敗し、原因がタスク定義側にあると気づきにくい。
    executionRoleArn:
      input.executionRoleArn ?? 'REPLACE_WITH_EXECUTION_ROLE_ARN',
    // task role はコンテナ自身が AWS API を呼ぶ場合のみ必要（任意）。
    ...(input.taskRoleArn && { taskRoleArn: input.taskRoleArn }),
    containerDefinitions: [
      {
        name: 'agent',
        image,
        essential: true,
        command: ['start', '--project', `${input.tenantCode}/${input.projectCode}`],
        environment: [
          { name: ENV_VARS.API_URL, value: input.apiUrl },
          // Not set here: AI_SUPPORT_AGENT_INSTANCE_ID. The agent derives the
          // replica identity from ECS_CONTAINER_METADATA_URI_V4 (the task id),
          // which ECS injects automatically and which is unique per task.
        ],
        secrets: [
          {
            name: ENV_VARS.TOKEN,
            // Replace with the ARN of a Secrets Manager secret (or SSM
            // parameter) holding the agent token.
            valueFrom: 'REPLACE_WITH_SECRET_ARN',
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroup,
            'awslogs-region': region,
            'awslogs-stream-prefix': 'agent',
            'awslogs-create-group': 'true',
          },
        },
      },
    ],
  }

  const service = {
    cluster: input.cluster,
    serviceName: family,
    taskDefinition: family,
    // Replicas beyond the plan limit stay in standby rather than failing, so a
    // too-large desiredCount wastes compute without breaking the deployment.
    desiredCount: input.replicas,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: input.subnets,
        securityGroups: input.securityGroups,
        assignPublicIp: input.assignPublicIp ? 'ENABLED' : 'DISABLED',
      },
    },
  }

  return {
    taskDefinition: JSON.stringify(taskDefinition, null, 2),
    service: JSON.stringify(service, null, 2),
  }
}
