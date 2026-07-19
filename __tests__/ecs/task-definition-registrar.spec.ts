/**
 * Tests for src/ecs/task-definition-registrar.ts
 *
 * Verifies the registered task definition parameters (digest pin, awslogs,
 * NO environment variables) and idempotent log group creation.
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

import { CloudWatchLogsClient, CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs'
import { ECSClient, RegisterTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import { mockClient } from 'aws-sdk-client-mock'

import { ensureLogGroup, registerTaskDefinition } from '../../src/ecs/task-definition-registrar'

const logsMock = mockClient(CloudWatchLogsClient)
const ecsMock = mockClient(ECSClient)

const IMAGE_URI = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo@sha256:abc123'
const TASK_DEF_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/ai-support-ecs-agent-mbc-ecs-x:5'

function baseOptions() {
  return {
    family: 'ai-support-ecs-agent-mbc-ecs-x',
    imageUri: IMAGE_URI,
    cpu: 1024,
    memory: 2048,
    region: 'ap-northeast-1',
    logGroupName: '/ai-support-agent/ecs-agent',
  }
}

beforeEach(() => {
  logsMock.reset()
  ecsMock.reset()
  jest.clearAllMocks()
})

describe('ensureLogGroup', () => {
  it('creates the log group', async () => {
    logsMock.on(CreateLogGroupCommand).resolves({})

    await ensureLogGroup(new CloudWatchLogsClient({ region: 'ap-northeast-1' }), '/my/group')

    const input = logsMock.commandCalls(CreateLogGroupCommand)[0].args[0].input
    expect(input).toEqual({ logGroupName: '/my/group' })
  })

  it('tolerates ResourceAlreadyExistsException', async () => {
    const err = new Error('exists')
    err.name = 'ResourceAlreadyExistsException'
    logsMock.on(CreateLogGroupCommand).rejects(err)

    await expect(ensureLogGroup(new CloudWatchLogsClient({ region: 'ap-northeast-1' }), '/my/group'))
      .resolves.toBeUndefined()
  })

  it('rethrows other errors', async () => {
    const err = new Error('denied')
    err.name = 'AccessDeniedException'
    logsMock.on(CreateLogGroupCommand).rejects(err)

    await expect(ensureLogGroup(new CloudWatchLogsClient({ region: 'ap-northeast-1' }), '/my/group'))
      .rejects.toThrow('denied')
  })
})

describe('registerTaskDefinition', () => {
  it('registers a Fargate task definition pinned by digest with no environment variables', async () => {
    logsMock.on(CreateLogGroupCommand).resolves({})
    ecsMock.on(RegisterTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: TASK_DEF_ARN, family: 'ai-support-ecs-agent-mbc-ecs-x', revision: 5 },
    })

    const result = await registerTaskDefinition(baseOptions())

    expect(result).toEqual({
      taskDefinitionArn: TASK_DEF_ARN,
      family: 'ai-support-ecs-agent-mbc-ecs-x',
      revision: 5,
    })

    const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
    expect(input.family).toBe('ai-support-ecs-agent-mbc-ecs-x')
    expect(input.requiresCompatibilities).toEqual(['FARGATE'])
    expect(input.networkMode).toBe('awsvpc')
    expect(input.cpu).toBe('1024')
    expect(input.memory).toBe('2048')
    expect(input.executionRoleArn).toBeUndefined()
    expect(input.taskRoleArn).toBeUndefined()

    const container = input.containerDefinitions?.[0]
    expect(container?.name).toBe('app')
    expect(container?.image).toBe(IMAGE_URI)
    expect(container?.essential).toBe(true)
    // The task definition must not carry environment variables — they are
    // injected per run via containerOverrides at RunTask time.
    expect(container?.environment).toBeUndefined()
    expect(container?.secrets).toBeUndefined()
    expect(container?.logConfiguration).toEqual({
      logDriver: 'awslogs',
      options: {
        'awslogs-group': '/ai-support-agent/ecs-agent',
        'awslogs-region': 'ap-northeast-1',
        'awslogs-stream-prefix': 'ecs-agent',
      },
    })
  })

  it('creates the log group before registering (already-exists tolerated)', async () => {
    const err = new Error('exists')
    err.name = 'ResourceAlreadyExistsException'
    logsMock.on(CreateLogGroupCommand).rejects(err)
    ecsMock.on(RegisterTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: TASK_DEF_ARN },
    })

    const result = await registerTaskDefinition(baseOptions())

    expect(logsMock.commandCalls(CreateLogGroupCommand)).toHaveLength(1)
    // Fallbacks when the response omits family/revision
    expect(result.family).toBe('ai-support-ecs-agent-mbc-ecs-x')
    expect(result.revision).toBe(0)
  })

  it('passes execution and task role ARNs when provided', async () => {
    logsMock.on(CreateLogGroupCommand).resolves({})
    ecsMock.on(RegisterTaskDefinitionCommand).resolves({
      taskDefinition: { taskDefinitionArn: TASK_DEF_ARN },
    })

    await registerTaskDefinition({
      ...baseOptions(),
      executionRoleArn: 'arn:aws:iam::123456789012:role/exec-role',
      taskRoleArn: 'arn:aws:iam::123456789012:role/task-role',
    })

    const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
    expect(input.executionRoleArn).toBe('arn:aws:iam::123456789012:role/exec-role')
    expect(input.taskRoleArn).toBe('arn:aws:iam::123456789012:role/task-role')
  })

  it('throws when the response has no task definition ARN', async () => {
    logsMock.on(CreateLogGroupCommand).resolves({})
    ecsMock.on(RegisterTaskDefinitionCommand).resolves({})

    await expect(registerTaskDefinition(baseOptions()))
      .rejects.toThrow('no task definition ARN')
  })

  it('propagates log group creation failures (no registration attempted)', async () => {
    const err = new Error('denied')
    err.name = 'AccessDeniedException'
    logsMock.on(CreateLogGroupCommand).rejects(err)

    await expect(registerTaskDefinition(baseOptions())).rejects.toThrow('denied')
    expect(ecsMock.commandCalls(RegisterTaskDefinitionCommand)).toHaveLength(0)
  })

  describe('enableTailscale', () => {
    it('registers only the single main container when enableTailscale is omitted (back-compat)', async () => {
      logsMock.on(CreateLogGroupCommand).resolves({})
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: TASK_DEF_ARN, family: 'ai-support-ecs-agent-mbc-ecs-x', revision: 5 },
      })

      await registerTaskDefinition(baseOptions())

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      expect(input.containerDefinitions).toHaveLength(1)
      expect(input.containerDefinitions?.[0].name).toBe('app')
      expect(input.containerDefinitions?.[0].dependsOn).toBeUndefined()
    })

    it('registers only the single main container when enableTailscale is false (back-compat)', async () => {
      logsMock.on(CreateLogGroupCommand).resolves({})
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: TASK_DEF_ARN, family: 'ai-support-ecs-agent-mbc-ecs-x', revision: 5 },
      })

      await registerTaskDefinition({ ...baseOptions(), enableTailscale: false })

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      expect(input.containerDefinitions).toHaveLength(1)
    })

    it('adds a tailscale sidecar container and a HEALTHY dependsOn on the main container when enableTailscale is true', async () => {
      logsMock.on(CreateLogGroupCommand).resolves({})
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: TASK_DEF_ARN, family: 'ai-support-ecs-agent-mbc-ecs-x', revision: 5 },
      })

      await registerTaskDefinition({ ...baseOptions(), enableTailscale: true })

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      expect(input.containerDefinitions).toHaveLength(2)

      const mainContainer = input.containerDefinitions?.find((c) => c.name === 'app')
      expect(mainContainer).toBeDefined()
      expect(mainContainer?.dependsOn).toEqual([
        { containerName: 'tailscale', condition: 'HEALTHY' },
      ])

      const sidecar = input.containerDefinitions?.find((c) => c.name === 'tailscale')
      expect(sidecar).toBeDefined()
      expect(sidecar?.image).toBe('tailscale/tailscale')
      expect(sidecar?.command).toEqual([
        'tailscaled',
        '--tun=userspace-networking',
        '--socks5-server=localhost:1055',
      ])
      expect(sidecar?.healthCheck?.command).toEqual(['CMD-SHELL', 'tailscale status || exit 1'])
      expect(sidecar?.healthCheck?.retries).toBeGreaterThan(0)
      // Same awslogs group/region as the main container, but its own stream
      // prefix — shared via buildAwsLogsConfig so the two containers' log
      // configs cannot drift apart except for the prefix.
      expect(sidecar?.logConfiguration).toEqual({
        logDriver: 'awslogs',
        options: {
          'awslogs-group': mainContainer?.logConfiguration?.options?.['awslogs-group'],
          'awslogs-region': mainContainer?.logConfiguration?.options?.['awslogs-region'],
          'awslogs-stream-prefix': 'tailscale',
        },
      })
      // Never carries the authkey (or any environment variables) statically —
      // it is injected per-run via containerOverrides (ecs-launcher.ts), same
      // rationale as the main container's own environment omission above.
      expect(sidecar?.environment).toBeUndefined()
      expect(sidecar?.secrets).toBeUndefined()
    })
  })

  describe('ECS container isolation (server-setup hardening)', () => {
    beforeEach(() => {
      logsMock.on(CreateLogGroupCommand).resolves({})
      ecsMock.on(RegisterTaskDefinitionCommand).resolves({
        taskDefinition: { taskDefinitionArn: TASK_DEF_ARN, family: 'ai-support-ecs-agent-mbc-ecs-x', revision: 5 },
      })
    })

    it('adds no isolation fields and no task volumes by default (back-compat)', async () => {
      await registerTaskDefinition(baseOptions())

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      const container = input.containerDefinitions?.[0]
      expect(container?.readonlyRootFilesystem).toBeUndefined()
      expect(container?.user).toBeUndefined()
      expect(container?.linuxParameters).toBeUndefined()
      expect(container?.mountPoints).toBeUndefined()
      expect(input.volumes).toBeUndefined()
      // No read-only-rootfs hardening env when the FS stays writable.
      expect(container?.environment).toBeUndefined()
    })

    it('sets a read-only root filesystem and provisions writable /tmp and /workspace volumes', async () => {
      await registerTaskDefinition({ ...baseOptions(), readonlyRootFilesystem: true })

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      const container = input.containerDefinitions?.[0]
      expect(container?.readonlyRootFilesystem).toBe(true)

      const mountPaths = (container?.mountPoints ?? []).map((m) => m.containerPath).sort()
      expect(mountPaths).toEqual(['/tmp', '/workspace'])
      expect(container?.mountPoints?.every((m) => m.readOnly === false)).toBe(true)

      // Each mount is backed by a task-level ephemeral (Fargate scratch) volume.
      const volumeNames = (input.volumes ?? []).map((v) => v.name).sort()
      const mountVolumes = (container?.mountPoints ?? []).map((m) => m.sourceVolume).sort()
      expect(volumeNames).toEqual(mountVolumes)
      // Ephemeral: no host/config binding.
      expect(input.volumes?.every((v) => v.host === undefined)).toBe(true)
    })

    it('injects HOME=/workspace (and Ansible local temp) so $HOME-relative writes land on the writable volume', async () => {
      await registerTaskDefinition({ ...baseOptions(), readonlyRootFilesystem: true })

      const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions?.[0]
      const env = container?.environment ?? []
      const byName = Object.fromEntries(env.map((e) => [e.name, e.value]))
      // getConfigDir() -> $HOME/.ai-support-agent (known_hosts store) must be writable.
      expect(byName.HOME).toBe('/workspace')
      // Ansible controller-local temp dir redirected under the writable volume.
      expect(byName.ANSIBLE_LOCAL_TEMP).toBe('/workspace/.ansible/tmp')
      // Every injected value points under the writable /workspace mount.
      expect(env.every((e) => (e.value ?? '').startsWith('/workspace'))).toBe(true)
    })

    it('runs the container as a non-root user and drops Linux capabilities', async () => {
      await registerTaskDefinition({
        ...baseOptions(),
        user: '1000:1000',
        dropCapabilities: ['ALL'],
      })

      const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions?.[0]
      expect(container?.user).toBe('1000:1000')
      expect(container?.linuxParameters?.capabilities?.drop).toEqual(['ALL'])
    })

    it('omits linuxParameters when dropCapabilities is an empty array', async () => {
      await registerTaskDefinition({ ...baseOptions(), dropCapabilities: [] })

      const container = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input.containerDefinitions?.[0]
      expect(container?.linuxParameters).toBeUndefined()
    })

    it('combines isolation with the tailscale sidecar', async () => {
      await registerTaskDefinition({
        ...baseOptions(),
        readonlyRootFilesystem: true,
        user: 'appuser',
        dropCapabilities: ['ALL'],
        enableTailscale: true,
      })

      const input = ecsMock.commandCalls(RegisterTaskDefinitionCommand)[0].args[0].input
      expect(input.containerDefinitions).toHaveLength(2)
      const main = input.containerDefinitions?.find((c) => c.name === 'app')
      expect(main?.readonlyRootFilesystem).toBe(true)
      expect(main?.user).toBe('appuser')
      expect(main?.dependsOn).toEqual([{ containerName: 'tailscale', condition: 'HEALTHY' }])
    })
  })
})
