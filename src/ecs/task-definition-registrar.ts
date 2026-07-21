/**
 * ECS task definition registrar for `ecs publish`.
 *
 * Registers a Fargate task definition for the ECS execution agent:
 * - image pinned by digest (`<repo>@sha256:...`)
 * - awslogs log driver (log group created when missing)
 * - NO environment variables in the task definition — COMMAND_ID, the
 *   oneshot token, etc. are injected per run via containerOverrides.
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { ECSClient, RegisterTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import type { ContainerDefinition, MountPoint, Volume } from '@aws-sdk/client-ecs'

import {
  ECS_AGENT_CONTAINER_NAME,
  TAILSCALE_SIDECAR_CONTAINER_NAME,
  TAILSCALE_SIDECAR_IMAGE,
  TAILSCALE_SOCKS_PORT,
} from '../constants'
import { logger } from '../logger'

export interface RegisterEcsTaskDefinitionOptions {
  /** Task definition family: ai-support-ecs-agent-{tenantCode}-{agentId} */
  family: string
  /** Digest-pinned image URI */
  imageUri: string
  cpu: number
  memory: number
  region: string
  logGroupName: string
  /** Task execution role (required by Fargate for ECR pull / awslogs) */
  executionRoleArn?: string
  /** Task role assumed by the container itself */
  taskRoleArn?: string
  /**
   * When true, adds a `tailscale` sidecar container (see admin-docs
   * docs/specifications/ssh-tailscale-support.md, section 2) that the main
   * (`ECS_AGENT_CONTAINER_NAME`) container depends on being `HEALTHY` before
   * it starts. Required for ECS execution agents that may run
   * `ssh_exec`/`server_setup_exec` against a `connectionType: 'tailscale'`
   * host. Defaults to `false` — omitting it (or passing `false`) registers
   * the exact same single-container task definition as before, unchanged.
   */
  enableTailscale?: boolean
  /**
   * When true, registers the main container with a read-only root filesystem
   * and provisions two writable ephemeral (Fargate scratch) volumes mounted at
   * `/tmp` and `/workspace` so the agent's temp dir (SSH key JIT) and the
   * ansible workspace still work. Opt-in server-setup hardening — omitting it
   * leaves the container fully writable as before.
   */
  readonlyRootFilesystem?: boolean
  /** Non-root user (uid, `uid:gid`, or username) to run the main container as. */
  user?: string
  /** Linux capabilities to drop from the main container (e.g. `['ALL']`). */
  dropCapabilities?: string[]
}

/**
 * Build the `awslogs` log driver configuration shared by both containers
 * registered in the task definition (main + optional Tailscale sidecar) —
 * only the stream prefix differs between them.
 */
function buildAwsLogsConfig(
  options: Pick<RegisterEcsTaskDefinitionOptions, 'logGroupName' | 'region'>,
  streamPrefix: string,
): NonNullable<ContainerDefinition['logConfiguration']> {
  return {
    logDriver: 'awslogs',
    options: {
      'awslogs-group': options.logGroupName,
      'awslogs-region': options.region,
      'awslogs-stream-prefix': streamPrefix,
    },
  }
}

/** Writable workspace mount path (one of {@link ISOLATION_VOLUMES}). */
const ISOLATION_WORKSPACE_PATH = '/workspace'

/** Ephemeral (Fargate scratch) volumes provisioned when `readonlyRootFilesystem` is set. */
const ISOLATION_VOLUMES: readonly { name: string; containerPath: string }[] = [
  { name: 'agent-tmp', containerPath: '/tmp' },
  { name: 'agent-workspace', containerPath: ISOLATION_WORKSPACE_PATH },
]

/**
 * Static environment injected into the read-only-rootfs main container so that
 * everything the agent writes relative to `$HOME` lands on the writable
 * `/workspace` volume instead of the now read-only root filesystem.
 *
 * Without this, a `readonlyRootFilesystem: true` container running as a
 * non-root `user` (whose home is on the read-only root FS) cannot write:
 * - the agent's persistent config dir — `getConfigDir()` resolves to
 *   `$HOME/.ai-support-agent`, which holds the per-host `known_hosts` file
 *   (`known-hosts-store.ts`) that every `server_setup_exec` TOFU check needs, and
 * - Ansible's own controller-local temp dir (`$HOME/.ansible/tmp`, overridden
 *   here explicitly via `ANSIBLE_LOCAL_TEMP`).
 * so every `server_setup_exec` would fail with an EROFS/permission error.
 *
 * These are non-secret, static hardening values — unlike the per-run secrets
 * (COMMAND_ID, oneshot token, …) injected via `containerOverrides` at RunTask
 * time, with which they merge (distinct names, no collision). Only added when
 * `readonlyRootFilesystem` is set, so the default (fully-writable) container is
 * unchanged and still carries no task-definition environment.
 */
const READONLY_ROOTFS_ENV: readonly { name: string; value: string }[] = [
  { name: 'HOME', value: ISOLATION_WORKSPACE_PATH },
  { name: 'ANSIBLE_LOCAL_TEMP', value: `${ISOLATION_WORKSPACE_PATH}/.ansible/tmp` },
]

/**
 * Build the `tailscale` sidecar container definition. The sidecar only runs
 * `tailscaled` itself (no static `command`-embedded authkey or hostname —
 * those are injected per-run via RunTask `containerOverrides`, see
 * `ecs-launcher.ts`'s `sidecarEnv` handling and
 * `TAILSCALE_AUTHKEY_ENV_VAR`). The health check gates the main container's
 * startup (via its `dependsOn: HEALTHY`) on `tailscale status` succeeding,
 * i.e. the sidecar having already authenticated to the tailnet.
 */
function buildTailscaleSidecarContainer(options: RegisterEcsTaskDefinitionOptions): ContainerDefinition {
  return {
    name: TAILSCALE_SIDECAR_CONTAINER_NAME,
    image: TAILSCALE_SIDECAR_IMAGE,
    essential: true,
    command: [
      'tailscaled',
      '--tun=userspace-networking',
      `--socks5-server=localhost:${TAILSCALE_SOCKS_PORT}`,
    ],
    healthCheck: {
      command: ['CMD-SHELL', 'tailscale status || exit 1'],
      interval: 10,
      timeout: 5,
      retries: 6,
      startPeriod: 20,
    },
    logConfiguration: buildAwsLogsConfig(options, 'tailscale'),
  }
}

export interface RegisteredTaskDefinition {
  taskDefinitionArn: string
  family: string
  revision: number
}

/**
 * Create the awslogs log group when it does not exist.
 * ResourceAlreadyExistsException is tolerated (idempotent).
 */
export async function ensureLogGroup(
  client: CloudWatchLogsClient,
  logGroupName: string,
): Promise<void> {
  try {
    await client.send(new CreateLogGroupCommand({ logGroupName }))
    logger.info(`[ecs] Created log group: ${logGroupName}`)
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'ResourceAlreadyExistsException') {
      logger.debug(`[ecs] Log group already exists: ${logGroupName}`)
      return
    }
    throw error
  }
}

/**
 * Register the Fargate task definition and return its ARN.
 */
export async function registerTaskDefinition(
  options: RegisterEcsTaskDefinitionOptions,
): Promise<RegisteredTaskDefinition> {
  const logsClient = new CloudWatchLogsClient({ region: options.region })
  await ensureLogGroup(logsClient, options.logGroupName)

  const ecsClient = new ECSClient({ region: options.region })

  const mountPoints: MountPoint[] | undefined = options.readonlyRootFilesystem
    ? ISOLATION_VOLUMES.map((v) => ({ sourceVolume: v.name, containerPath: v.containerPath, readOnly: false }))
    : undefined
  // Task-level ephemeral volumes (no `host`/`configuredAtLaunch` = Fargate
  // scratch space) backing the read-only-rootfs container's writable paths.
  const volumes: Volume[] | undefined = options.readonlyRootFilesystem
    ? ISOLATION_VOLUMES.map((v) => ({ name: v.name }))
    : undefined

  const mainContainer: ContainerDefinition = {
    name: ECS_AGENT_CONTAINER_NAME,
    image: options.imageUri,
    essential: true,
    // No environment variables here: they are injected at RunTask time
    // via containerOverrides so secrets never persist in the definition.
    logConfiguration: buildAwsLogsConfig(options, 'ecs-agent'),
    ...(options.readonlyRootFilesystem && { readonlyRootFilesystem: true }),
    // Redirect $HOME-relative writes (config dir known_hosts, Ansible temp) to
    // the writable /workspace volume when the root FS is read-only.
    ...(options.readonlyRootFilesystem && { environment: [...READONLY_ROOTFS_ENV] }),
    ...(options.user && { user: options.user }),
    ...(options.dropCapabilities && options.dropCapabilities.length > 0 && {
      linuxParameters: { capabilities: { drop: options.dropCapabilities } },
    }),
    ...(mountPoints && { mountPoints }),
    ...(options.enableTailscale && {
      dependsOn: [{ containerName: TAILSCALE_SIDECAR_CONTAINER_NAME, condition: 'HEALTHY' }],
    }),
  }

  const containerDefinitions: ContainerDefinition[] = options.enableTailscale
    ? [mainContainer, buildTailscaleSidecarContainer(options)]
    : [mainContainer]

  const response = await ecsClient.send(new RegisterTaskDefinitionCommand({
    family: options.family,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: String(options.cpu),
    memory: String(options.memory),
    ...(options.executionRoleArn && { executionRoleArn: options.executionRoleArn }),
    ...(options.taskRoleArn && { taskRoleArn: options.taskRoleArn }),
    containerDefinitions,
    ...(volumes && { volumes }),
  }))

  const taskDefinition = response.taskDefinition
  if (!taskDefinition?.taskDefinitionArn) {
    throw new Error('ECS RegisterTaskDefinition returned no task definition ARN')
  }
  logger.success(`[ecs] Registered task definition: ${taskDefinition.taskDefinitionArn}`)
  return {
    taskDefinitionArn: taskDefinition.taskDefinitionArn,
    family: taskDefinition.family ?? options.family,
    revision: taskDefinition.revision ?? 0,
  }
}
