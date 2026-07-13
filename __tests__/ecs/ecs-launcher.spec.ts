/**
 * Tests for src/ecs/ecs-launcher.ts
 *
 * Covers ecs_launch (RunTask) and ecs_stop (StopTask) handlers:
 * payload validation, success/failure paths, and — critically — that the
 * oneshot token from containerEnv is never written to the logger.
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'
import { mockClient } from 'aws-sdk-client-mock'

import { ecsLaunch, ecsStop } from '../../src/ecs/ecs-launcher'
import { logger } from '../../src/logger'

const ecsMock = mockClient(ECSClient)

const SECRET_TOKEN = 'oneshot-secret-token-value'
const CLUSTER_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/my-cluster'
const TASK_DEF_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/ai-support-ecs-agent-mbc-ecs-abc:1'
const TASK_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:task/my-cluster/deadbeef'

function launchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskDefinitionArn: TASK_DEF_ARN,
    clusterArn: CLUSTER_ARN,
    subnetIds: ['subnet-1', 'subnet-2'],
    securityGroupIds: ['sg-1'],
    containerEnv: {
      AGENT_MODE: 'oneshot',
      COMMAND_ID: 'cmd-1',
      AGENT_ID: 'ecs-agent-1',
      TENANT_CODE: 'mbc',
      PROJECT_CODE: 'MBC_01',
      API_BASE_URL: 'https://api.example.com',
      AGENT_ONESHOT_TOKEN: SECRET_TOKEN,
    },
    ...overrides,
  }
}

/** Collect every string passed to any logger method. */
function allLoggedText(): string {
  const mocked = logger as unknown as Record<string, jest.Mock>
  return ['info', 'success', 'error', 'warn', 'debug']
    .flatMap((m) => mocked[m].mock.calls)
    .map((args) => args.map(String).join(' '))
    .join('\n')
}

beforeEach(() => {
  ecsMock.reset()
  jest.clearAllMocks()
})

describe('ecsLaunch', () => {
  it('runs the task and returns the taskArn', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }], failures: [] })

    const result = await ecsLaunch(launchPayload())

    expect(result).toEqual({ success: true, data: { taskArn: TASK_ARN } })
    const call = ecsMock.commandCalls(RunTaskCommand)[0]
    const input = call.args[0].input
    expect(input.cluster).toBe(CLUSTER_ARN)
    expect(input.taskDefinition).toBe(TASK_DEF_ARN)
    expect(input.launchType).toBe('FARGATE')
    expect(input.count).toBe(1)
    expect(input.networkConfiguration?.awsvpcConfiguration).toEqual({
      subnets: ['subnet-1', 'subnet-2'],
      securityGroups: ['sg-1'],
      assignPublicIp: 'DISABLED',
    })
    const containerOverride = input.overrides?.containerOverrides?.[0]
    expect(containerOverride?.name).toBe('app')
    expect(containerOverride?.environment).toEqual(expect.arrayContaining([
      { name: 'AGENT_MODE', value: 'oneshot' },
      { name: 'COMMAND_ID', value: 'cmd-1' },
      { name: 'AGENT_ONESHOT_TOKEN', value: SECRET_TOKEN },
    ]))
  })

  it('sets assignPublicIp ENABLED when the payload requests it', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }] })

    await ecsLaunch(launchPayload({ assignPublicIp: true }))

    const input = ecsMock.commandCalls(RunTaskCommand)[0].args[0].input
    expect(input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe('ENABLED')
  })

  it('never logs the oneshot token value', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }] })

    await ecsLaunch(launchPayload())

    expect(allLoggedText()).not.toContain(SECRET_TOKEN)
  })

  it('returns a failed result carrying RunTask failures details', async () => {
    ecsMock.on(RunTaskCommand).resolves({
      tasks: [],
      failures: [
        { arn: TASK_DEF_ARN, reason: 'RESOURCE:MEMORY', detail: 'insufficient memory' },
        { arn: TASK_DEF_ARN, reason: 'MISSING' },
      ],
    })

    const result = await ecsLaunch(launchPayload())

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('RESOURCE:MEMORY (insufficient memory)')
      expect(result.error).toContain('MISSING')
      expect(result.data).toEqual({
        failures: [
          { arn: TASK_DEF_ARN, reason: 'RESOURCE:MEMORY', detail: 'insufficient memory' },
          { arn: TASK_DEF_ARN, reason: 'MISSING' },
        ],
      })
    }
    expect(allLoggedText()).not.toContain(SECRET_TOKEN)
  })

  it('handles a failure entry without a reason', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [{ arn: TASK_DEF_ARN }] })

    const result = await ecsLaunch(launchPayload())

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('unknown')
    }
  })

  it('returns an error when RunTask reports no task and no failures', async () => {
    ecsMock.on(RunTaskCommand).resolves({ tasks: [], failures: [] })

    const result = await ecsLaunch(launchPayload())

    expect(result).toEqual({ success: false, error: 'ECS RunTask returned no task' })
  })

  it('returns a failed result when RunTask throws and never logs the token', async () => {
    ecsMock.on(RunTaskCommand).rejects(new Error('AccessDeniedException'))

    const result = await ecsLaunch(launchPayload())

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('AccessDeniedException')
    }
    expect(allLoggedText()).not.toContain(SECRET_TOKEN)
  })

  it.each([
    ['taskDefinitionArn', { taskDefinitionArn: undefined }, 'taskDefinitionArn is required for ecs_launch'],
    ['clusterArn', { clusterArn: '' }, 'clusterArn is required for ecs_launch'],
    ['subnetIds missing', { subnetIds: undefined }, 'subnetIds (non-empty string array) is required for ecs_launch'],
    ['subnetIds empty', { subnetIds: [] }, 'subnetIds (non-empty string array) is required for ecs_launch'],
    ['subnetIds non-string', { subnetIds: [123] }, 'subnetIds (non-empty string array) is required for ecs_launch'],
    ['securityGroupIds', { securityGroupIds: undefined }, 'securityGroupIds (non-empty string array) is required for ecs_launch'],
    ['containerEnv missing', { containerEnv: undefined }, 'containerEnv (object) is required for ecs_launch'],
    ['containerEnv array', { containerEnv: ['x'] }, 'containerEnv (object) is required for ecs_launch'],
    ['containerEnv null', { containerEnv: null }, 'containerEnv (object) is required for ecs_launch'],
  ])('rejects an invalid payload: %s', async (_label, overrides, expectedError) => {
    const result = await ecsLaunch(launchPayload(overrides))
    expect(result).toEqual({ success: false, error: expectedError })
    expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0)
  })

  it('rejects a containerEnv with a non-string value', async () => {
    const result = await ecsLaunch(launchPayload({ containerEnv: { COMMAND_ID: 42 } }))
    expect(result).toEqual({ success: false, error: 'containerEnv.COMMAND_ID must be a string' })
  })

  it('rejects a clusterArn whose region cannot be determined', async () => {
    const result = await ecsLaunch(launchPayload({ clusterArn: 'not-an-arn' }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Could not determine region')
    }
  })

  describe('sidecarEnv (Tailscale authkey injection)', () => {
    const SIDECAR_AUTHKEY = 'tskey-auth-secret-value'

    it('adds a second containerOverrides entry scoped to the tailscale sidecar when sidecarEnv is present', async () => {
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }], failures: [] })

      await ecsLaunch(launchPayload({ sidecarEnv: { TS_AUTHKEY: SIDECAR_AUTHKEY, TS_HOSTNAME: 'oneshot-abc' } }))

      const input = ecsMock.commandCalls(RunTaskCommand)[0].args[0].input
      const overrides = input.overrides?.containerOverrides ?? []
      expect(overrides).toHaveLength(2)

      const mainOverride = overrides.find((o) => o.name === 'app')
      expect(mainOverride?.environment).toEqual(expect.arrayContaining([
        { name: 'AGENT_MODE', value: 'oneshot' },
      ]))

      const sidecarOverride = overrides.find((o) => o.name === 'tailscale')
      expect(sidecarOverride).toBeDefined()
      expect(sidecarOverride?.environment).toEqual(expect.arrayContaining([
        { name: 'TS_AUTHKEY', value: SIDECAR_AUTHKEY },
        { name: 'TS_HOSTNAME', value: 'oneshot-abc' },
      ]))
    })

    it('does not add a sidecar containerOverrides entry when sidecarEnv is absent (back-compat)', async () => {
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }], failures: [] })

      await ecsLaunch(launchPayload())

      const input = ecsMock.commandCalls(RunTaskCommand)[0].args[0].input
      expect(input.overrides?.containerOverrides).toHaveLength(1)
    })

    it('rejects a sidecarEnv with a non-string value', async () => {
      const result = await ecsLaunch(launchPayload({ sidecarEnv: { TS_AUTHKEY: 42 } }))
      expect(result).toEqual({ success: false, error: 'sidecarEnv.TS_AUTHKEY must be a string' })
      expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0)
    })

    it('rejects an array sidecarEnv', async () => {
      const result = await ecsLaunch(launchPayload({ sidecarEnv: ['x'] }))
      expect(result).toEqual({ success: false, error: 'sidecarEnv (object) must not be an array' })
      expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0)
    })

    it('rejects a non-object, non-array sidecarEnv (e.g. a string)', async () => {
      const result = await ecsLaunch(launchPayload({ sidecarEnv: 'not-an-object' }))
      expect(result).toEqual({ success: false, error: 'sidecarEnv (object) is required for ecs_launch' })
      expect(ecsMock.commandCalls(RunTaskCommand)).toHaveLength(0)
    })

    it('never logs the sidecar authkey value', async () => {
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }], failures: [] })

      await ecsLaunch(launchPayload({ sidecarEnv: { TS_AUTHKEY: SIDECAR_AUTHKEY } }))

      expect(allLoggedText()).not.toContain(SIDECAR_AUTHKEY)
    })
  })
})

describe('ecsStop', () => {
  it('stops the task and returns the stopped status', async () => {
    ecsMock.on(StopTaskCommand).resolves({ task: { taskArn: TASK_ARN, lastStatus: 'STOPPING' } })

    const result = await ecsStop({ clusterArn: CLUSTER_ARN, taskArn: TASK_ARN })

    expect(result).toEqual({
      success: true,
      data: { stopped: true, taskArn: TASK_ARN, lastStatus: 'STOPPING' },
    })
    const input = ecsMock.commandCalls(StopTaskCommand)[0].args[0].input
    expect(input.cluster).toBe(CLUSTER_ARN)
    expect(input.task).toBe(TASK_ARN)
    expect(input.reason).toContain('ai-support-agent')
  })

  it('returns lastStatus undefined when the response has no task', async () => {
    ecsMock.on(StopTaskCommand).resolves({})

    const result = await ecsStop({ clusterArn: CLUSTER_ARN, taskArn: TASK_ARN })

    expect(result).toEqual({
      success: true,
      data: { stopped: true, taskArn: TASK_ARN, lastStatus: undefined },
    })
  })

  it('requires clusterArn', async () => {
    const result = await ecsStop({ taskArn: TASK_ARN })
    expect(result).toEqual({ success: false, error: 'clusterArn is required for ecs_stop' })
  })

  it('requires taskArn', async () => {
    const result = await ecsStop({ clusterArn: CLUSTER_ARN, taskArn: '' })
    expect(result).toEqual({ success: false, error: 'taskArn is required for ecs_stop' })
  })

  it('rejects a clusterArn whose region cannot be determined', async () => {
    const result = await ecsStop({ clusterArn: 'bogus', taskArn: TASK_ARN })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('Could not determine region')
    }
  })

  it('returns a failed (best-effort) result when StopTask throws', async () => {
    ecsMock.on(StopTaskCommand).rejects(new Error('TaskNotFound'))

    const result = await ecsStop({ clusterArn: CLUSTER_ARN, taskArn: TASK_ARN })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain('TaskNotFound')
      expect(result.data).toEqual({ stopped: false, taskArn: TASK_ARN })
    }
  })
})
