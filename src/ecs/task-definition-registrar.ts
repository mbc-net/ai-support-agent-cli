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
import type { ContainerDefinition } from '@aws-sdk/client-ecs'

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
}

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
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': options.logGroupName,
        'awslogs-region': options.region,
        'awslogs-stream-prefix': 'tailscale',
      },
    },
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

  const mainContainer: ContainerDefinition = {
    name: ECS_AGENT_CONTAINER_NAME,
    image: options.imageUri,
    essential: true,
    // No environment variables here: they are injected at RunTask time
    // via containerOverrides so secrets never persist in the definition.
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': options.logGroupName,
        'awslogs-region': options.region,
        'awslogs-stream-prefix': 'ecs-agent',
      },
    },
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
