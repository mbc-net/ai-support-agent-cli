/**
 * ECS execution agent types (launcher-agent architecture).
 *
 * An ECS execution agent is an on-demand execution target: a container is
 * started via ECS RunTask, executes exactly one command (oneshot), submits
 * the result, and exits. The RunTask/StopTask calls are performed by a
 * resident agent (the "launcher agent") using its local AWS credentials;
 * the API never calls AWS directly.
 */

/** ecsConfig registered with the API for an ECS execution agent */
export interface EcsAgentConfig {
  /** Image URI pinned by digest (`<repo>@sha256:...`) */
  imageUri: string
  /** Tag used at publish time (display purposes) */
  imageTag: string
  /** Image digest (`sha256:...`) */
  imageDigest: string
  /** ECS task size */
  cpu: number
  memory: number
  /** Task definition registered by the publisher (launcher-side RegisterTaskDefinition) */
  taskDefinitionArn: string
  taskDefinitionFamily: string
  /** Target cluster and awsvpc network settings */
  clusterArn: string
  subnetIds: string[]
  securityGroupIds: string[]
  assignPublicIp?: boolean
  /** awslogs log group the container writes to */
  logGroupName: string
  /** Resident agent in charge of RunTask (auto-selected by capability when omitted) */
  launcherAgentId?: string
  /** Publisher agent id and timestamp */
  registeredBy: string
  registeredAt: string
}

/** Request body for POST /api/:tenantCode/agent/ecs-agents */
export interface EcsAgentRegistration {
  agentId: string
  displayName: string
  capabilities: string[]
  ecsConfig: EcsAgentConfig
}

/**
 * Environment variables injected into the oneshot container at RunTask time
 * via containerOverrides (never stored in the task definition).
 */
export interface OneshotContainerEnv {
  AGENT_MODE: string
  COMMAND_ID: string
  AGENT_ID: string
  TENANT_CODE: string
  PROJECT_CODE: string
  API_BASE_URL: string
  AGENT_ONESHOT_TOKEN: string
}

/** Payload of the `ecs_launch` launcher command */
export interface EcsLaunchPayload {
  taskDefinitionArn?: unknown
  clusterArn?: unknown
  subnetIds?: unknown
  securityGroupIds?: unknown
  assignPublicIp?: unknown
  containerEnv?: unknown
}

/** Payload of the `ecs_stop` launcher command */
export interface EcsStopPayload {
  clusterArn?: unknown
  taskArn?: unknown
}
