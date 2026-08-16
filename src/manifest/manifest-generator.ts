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

import { ENV_VARS, SHUTDOWN_GRACE_PERIOD_SECONDS } from '../constants'
import { CONTAINER_START_ARGV } from '../docker/docker-args'

/**
 * `terminationGracePeriodSeconds` for the generated Kubernetes Deployment.
 * Derived from SHUTDOWN_DRAIN_TIMEOUT_MS (via the shared
 * SHUTDOWN_GRACE_PERIOD_SECONDS constant in constants.ts, also used by
 * docker-supervisor.ts's `docker stop --time`) rather than a bare literal so
 * the two deployment modes' grace periods cannot silently drift apart from
 * each other or from the drain timeout. Equals 320 with the current
 * constants (300s drain + 20s margin).
 */
const TERMINATION_GRACE_PERIOD_SECONDS = SHUTDOWN_GRACE_PERIOD_SECONDS

/**
 * Argument vector that starts the agent *inside* a container.
 *
 * `args` (Kubernetes) and `command` (ECS) are NOT a CLI argument list: they map
 * to Docker's CMD and are appended to the image's ENTRYPOINT. The published
 * image declares `ENTRYPOINT ["/entrypoint.sh"]` with no CMD, and entrypoint.sh
 * ends in `exec "$@"`, so the first element has to be an executable. Starting
 * with a subcommand makes the container run `exec start --project ...`, which
 * exits 127 (`start: not found`) and lands the Pod in CrashLoopBackOff.
 *
 * `--no-docker` is equally required. Commander's negated option leaves
 * `opts.docker === true` when the flag is absent, so the CLI would enter
 * `runInDocker()` *inside* the container and abort on the missing Docker socket
 * — trading exit 127 for a different startup failure.
 *
 * Both requirements are already encoded in {@link CONTAINER_START_ARGV}, which
 * `docker-supervisor.ts` uses to launch the very same image. Reusing it here
 * keeps one source of truth: a change to how the agent is started in a
 * container cannot silently diverge from what the generated manifests say.
 *
 * The ENTRYPOINT is deliberately left in place — it registers git
 * safe.directory entries and a passwd entry before handing over — so the fix is
 * to prepend to the argument vector, not to override entryPoint.
 */
const CONTAINER_ARGV: readonly string[] = CONTAINER_START_ARGV

/** Container image used when the caller does not pass one. */
export const DEFAULT_AGENT_IMAGE = 'ghcr.io/mbc-net/ai-support-agent-cli:latest'

/** Kubernetes Secret / Deployment name used when the caller does not pass one. */
export const DEFAULT_K8S_NAME = 'ai-support-agent'

/** ECS task definition family used when the caller does not pass one. */
export const DEFAULT_ECS_FAMILY = 'ai-support-agent'

/**
 * One project's deployment unit.
 *
 * Each project needs its own token: the agentId is derived from the token's
 * tokenId (see resolveAgentId in agent-runner.ts), so sharing one token across
 * projects makes their agentIds collide and the server's TOFU binding rejects
 * the connection.
 */
export interface ManifestProject {
  /** Project code (UPPER_SNAKE_CASE). */
  projectCode: string
  /** Agent token for this project. Embedded in a Secret, never in args. */
  token: string
  /** Resource name. Defaults to the shared default; duplicates are rejected. */
  name?: string
  /** Desired replica count. Defaults to 1. */
  replicas?: number
}

export interface ManifestInput {
  /** Tenant code (lower_snake_case). */
  tenantCode: string
  /** API base URL the agent connects to. */
  apiUrl: string
  /** Container image. */
  image?: string
  /** Resource name (Deployment / Secret / task family). */
  name?: string

  // --- Single project ---
  /** Project code (UPPER_SNAKE_CASE). */
  projectCode?: string
  /** Agent token. Embedded in a Secret / Secrets Manager reference, never in args. */
  token?: string
  /** Desired replica count. */
  replicas?: number

  // --- Multiple projects (one project = one Deployment) ---
  /**
   * Mutually exclusive with projectCode/token. Specifying both makes it
   * impossible to tell which form produced the output, so it is an error
   * rather than a silent precedence rule.
   */
  projects?: ManifestProject[]
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

/**
 * Thrown when a Kubernetes object name is not a DNS-1123 label.
 *
 * A named class (rather than a bare Error) so tests can assert the failure
 * reason. `toThrow(SomeUndefinedImport)` silently degrades to "threw
 * anything", which lets a test pass while verifying nothing — the web side
 * (agent-deploy-manifest.ts) already exports the same class for this reason.
 */
export class InvalidManifestNameError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `Invalid ${field} "${value}": must be a lowercase DNS-1123 label ` +
        '(alphanumerics and "-", starting and ending with an alphanumeric, max 63 chars)',
    )
    this.name = 'InvalidManifestNameError'
  }
}

function assertDns1123Label(value: string, field: string): string {
  if (value.length > 63 || !DNS_1123_LABEL.test(value)) {
    throw new InvalidManifestNameError(field, value)
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
export class ManifestProjectSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestProjectSelectionError'
  }
}

/**
 * Normalize the single and multi project forms into one list.
 *
 * Mirrors vars/main.yml of the ai_support_agent_k8s Ansible role. If the two
 * diverge, a manifest generated here and a deployment produced by server setup
 * stop matching.
 */
function resolveProjects(input: ManifestInput): Required<ManifestProject>[] {
  // OR ではなく AND で判定する。片方だけ指定を「単数指定あり」と扱うと、
  // 非null断定（!）を通って `--project mbc/undefined` のようにテンプレートへ
  // undefined が文字列として埋め込まれる。TypeScript は `!` の先を追跡しない。
  const hasProjectCode = input.projectCode !== undefined
  const hasToken = input.token !== undefined
  if (hasProjectCode !== hasToken) {
    throw new ManifestProjectSelectionError(
      'projectCode and token must be specified together for a single project',
    )
  }
  const hasSingle = hasProjectCode && hasToken
  const hasMulti = (input.projects?.length ?? 0) > 0
  if (hasSingle && hasMulti) {
    throw new ManifestProjectSelectionError(
      'projectCode/token (single project) and projects (multiple projects) are mutually exclusive; specify exactly one form',
    )
  }
  if (!hasSingle && !hasMulti) {
    throw new ManifestProjectSelectionError(
      'at least one project is required: set projectCode/token or projects',
    )
  }
  const list = hasMulti
    ? input.projects!
    : [
        {
          projectCode: input.projectCode!,
          token: input.token!,
          name: input.name,
          replicas: input.replicas,
        },
      ]
  const resolved = list.map((p) => ({
    projectCode: p.projectCode,
    token: p.token,
    name: p.name ?? input.name ?? DEFAULT_K8S_NAME,
    replicas: p.replicas ?? 1,
  }))
  const names = resolved.map((p) => p.name)
  if (new Set(names).size !== names.length) {
    throw new ManifestProjectSelectionError(
      `each project needs a unique name (it becomes the resource and Secret name; duplicates silently overwrite each other): ${names.join(', ')}`,
    )
  }
  return resolved
}

export function generateK8sManifest(input: K8sManifestInput): string {
  const namespace = assertDns1123Label(
    input.namespace ?? 'default',
    'namespace',
  )
  const image = input.image ?? DEFAULT_AGENT_IMAGE
  const projects = resolveProjects(input)

  const header =
    projects.length === 1
      ? `# Generated by ai-support-agent-cli \`manifest k8s\`.
# One agent token runs ${projects[0].replicas} replica(s) of the same logical agent:
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
# ExternalSecret.`
      : `# Generated by ai-support-agent-cli \`manifest k8s\`.
# ${projects.length} projects, each with its own Secret and Deployment: tokens
# differ per project, so the Secret cannot be shared and the Deployments split
# accordingly.
#
# Within one Deployment, replicas share a token and are distinguished by
# ${ENV_VARS.INSTANCE_ID} (bound to the Pod name below).
#
# Replicas beyond the plan limit are not rejected outright — they stay in
# standby and take over automatically when a running replica stops.
#
# SECURITY: the Secrets below carry the agent tokens. The 'data' field is base64,
# which is an encoding, not encryption — anyone who can read this file can
# recover the tokens. Do not commit it. To keep the tokens out of the file
# entirely, delete the Secret blocks and point each secretKeyRef at a Secret you
# create out-of-band (kubectl create secret generic ... --from-literal=...) or at
# an ExternalSecret.`

  const docs = projects.map((project) => {
    const name = assertDns1123Label(project.name, 'name')
    const secretName = assertDns1123Label(`${name}-token`, 'secret name')
    return `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
type: Opaque
data:
  AI_SUPPORT_AGENT_TOKEN: ${b64(project.token)}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app: ${name}
spec:
  replicas: ${project.replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # Derived from SHUTDOWN_DRAIN_TIMEOUT_MS (the in-flight-command drain)
      # plus SHUTDOWN_GRACE_PERIOD_MARGIN_SECONDS for the releaseSelf()
      # call and process exit overhead. Without this, Kubernetes' 30s default
      # would SIGKILL the Pod mid-drain, which would abandon a still-running
      # command and let the server re-assign (and re-execute) it on another
      # replica before this one's slot is actually released.
      terminationGracePeriodSeconds: ${TERMINATION_GRACE_PERIOD_SECONDS}
      containers:
        - name: agent
          image: ${yamlScalar(image)}
          # 明示しないと Kubernetes の既定が効き、タグが latest 以外のときは
          # IfNotPresent になる。:beta のような移動タグでは、タグを動かして
          # rollout restart してもノード上のキャッシュを使い回すため、更新した
          # つもりで中身が変わらない。版固定タグでは digest が変わらないので
          # レイヤの再取得は起きない。
          imagePullPolicy: Always
          args:
${CONTAINER_ARGV.map((a) => `            - ${a}`).join('\n')}
            - --project
            - ${yamlScalar(`${input.tenantCode}/${project.projectCode}`)}
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
            #
            # NOTE: metadata.name is unique only *within this cluster*. A
            # Deployment's Pod names already carry a random suffix, so this is
            # safe as-is here. If you change this workload to a StatefulSet
            # (predictable Pod names like agent-0, agent-1, ...) and run the
            # same token in more than one cluster, Pod names can collide
            # across clusters (e.g. "agent-0" in both) and the server would
            # see what looks like the same replica reconnecting from two
            # places at once. In that case, set ${ENV_VARS.INSTANCE_ID}
            # explicitly to a value that includes the cluster name instead of
            # relying on metadata.name.
            - name: ${ENV_VARS.INSTANCE_ID}
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
`
  })

  return `${header}\n${docs.join('---\n')}`
}

export function generateEcsManifest(input: EcsManifestInput): {
  taskDefinition: string
  service: string
} {
  // Unlike K8s, an ECS task/service definition file cannot hold several
  // definitions. Silently taking the first project would hide the fact that the
  // rest never start, so reject it instead.
  const projects = resolveProjects(input)
  if (projects.length > 1) {
    throw new ManifestProjectSelectionError(
      `ECS manifests describe exactly one project per task definition; got ${projects.length}. Generate one manifest per project.`,
    )
  }
  const project = projects[0]
  const family = project.name
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
        command: [
          ...CONTAINER_ARGV,
          '--project',
          `${input.tenantCode}/${project.projectCode}`,
        ],
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
    desiredCount: project.replicas,
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
