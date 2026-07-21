/**
 * Tests for src/cli/ecs-publish-command.ts
 *
 * Covers project resolution, option parsing (commander), the publish
 * orchestration (image push -> task definition -> API registration -> config
 * persistence), and agentId reuse on re-publish.
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

jest.mock('../../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string) => key,
}))

const mockLoadConfig = jest.fn()
const mockAddProject = jest.fn()
jest.mock('../../src/config-manager', () => {
  const actual = jest.requireActual('../../src/config-manager')
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    addProject: (...args: unknown[]) => mockAddProject(...args),
  }
})

const mockPublishImage = jest.fn()
jest.mock('../../src/ecs/ecr-publisher', () => ({
  publishImage: (...args: unknown[]) => mockPublishImage(...args),
}))

const mockRegisterTaskDefinition = jest.fn()
jest.mock('../../src/ecs/task-definition-registrar', () => ({
  registerTaskDefinition: (...args: unknown[]) => mockRegisterTaskDefinition(...args),
}))

const mockRegisterEcsAgent = jest.fn()
const mockSetTenantCode = jest.fn()
const mockSetProjectCode = jest.fn()
const mockApiClientCtor = jest.fn()
jest.mock('../../src/api-client', () => ({
  ApiClient: class {
    registerEcsAgent = mockRegisterEcsAgent
    setTenantCode = mockSetTenantCode
    setProjectCode = mockSetProjectCode
    constructor(...args: unknown[]) {
      mockApiClientCtor(...args)
    }
  },
}))

import { Command } from 'commander'

import {
  type EcsPublishCliOptions,
  parseRunAsUser,
  registerEcsCommands,
  resolveTargetProject,
  runEcsPublish,
} from '../../src/cli/ecs-publish-command'
import { logger } from '../../src/logger'
import type { ProjectRegistration } from '../../src/types'

const REPO_URI = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo'
const CLUSTER_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/my-cluster'
const DIGEST = 'sha256:abc123'
const TASK_DEF_ARN = 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/fam:1'

function makeProject(overrides: Partial<ProjectRegistration> = {}): ProjectRegistration {
  return {
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    token: 'mbc:token-id:secret',
    apiUrl: 'https://api.example.com',
    ...overrides,
  }
}

function makeConfig(projects: ProjectRegistration[]) {
  return { agentId: 'publisher-agent', createdAt: '2026-01-01T00:00:00.000Z', projects }
}

function baseOpts(overrides: Partial<EcsPublishCliOptions> = {}): EcsPublishCliOptions {
  return {
    repositoryUri: REPO_URI,
    tag: 'v1',
    cluster: CLUSTER_ARN,
    subnets: ['subnet-1', 'subnet-2'],
    securityGroups: ['sg-1'],
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLoadConfig.mockReturnValue(makeConfig([makeProject()]))
  mockPublishImage.mockResolvedValue({
    imageUri: `${REPO_URI}@${DIGEST}`,
    imageTag: 'v1',
    imageDigest: DIGEST,
  })
  mockRegisterTaskDefinition.mockResolvedValue({
    taskDefinitionArn: TASK_DEF_ARN,
    family: 'fam',
    revision: 1,
  })
  mockRegisterEcsAgent.mockResolvedValue(undefined)
})

describe('resolveTargetProject', () => {
  it('throws when no project is registered', () => {
    expect(() => resolveTargetProject([])).toThrow('No project is registered')
  })

  it('returns the single project when --project is omitted', () => {
    const project = makeProject()
    expect(resolveTargetProject([project])).toBe(project)
  })

  it('throws when multiple projects exist and --project is omitted', () => {
    const projects = [makeProject(), makeProject({ projectCode: 'MBC_02' })]
    expect(() => resolveTargetProject(projects)).toThrow('Specify one with --project')
  })

  it('throws for a malformed --project flag', () => {
    expect(() => resolveTargetProject([makeProject()], 'no-slash'))
      .toThrow('"tenantCode/projectCode" format')
  })

  it('selects the matching project by tenantCode/projectCode', () => {
    const target = makeProject({ projectCode: 'MBC_02' })
    const projects = [makeProject(), target]
    expect(resolveTargetProject(projects, 'mbc/MBC_02')).toBe(target)
  })

  it('throws when the flagged project is not found', () => {
    expect(() => resolveTargetProject([makeProject()], 'mbc/OTHER'))
      .toThrow('Project not found: mbc/OTHER')
  })
})

describe('parseRunAsUser', () => {
  it('returns undefined for an unset value', () => {
    expect(parseRunAsUser(undefined)).toBeUndefined()
  })

  it.each(['1000', '1000:1000', 'appuser', 'app-user_1'])('accepts %s', (value) => {
    expect(parseRunAsUser(value)).toBe(value)
  })

  it.each(['bad user', '1000:', ':1000', 'a:b:c', ''])('rejects %s', (value) => {
    expect(() => parseRunAsUser(value)).toThrow('--run-as-user must be a uid')
  })
})

describe('runEcsPublish', () => {
  it('publishes the image, registers the task definition and the agent, then persists the agentId', async () => {
    await runEcsPublish(baseOpts({ name: 'My ECS Agent', assignPublicIp: true, launcherAgentId: 'launcher-1' }))

    expect(mockPublishImage).toHaveBeenCalledWith({
      repositoryUri: REPO_URI,
      tag: 'v1',
      dockerfile: undefined,
      image: undefined,
    })

    // Task definition: digest pin, family format, defaults for cpu/memory/log group
    const tdOptions = mockRegisterTaskDefinition.mock.calls[0][0]
    expect(tdOptions.imageUri).toBe(`${REPO_URI}@${DIGEST}`)
    expect(tdOptions.family).toMatch(/^ai-support-ecs-agent-mbc-ecs-[0-9a-f-]{36}$/)
    expect(tdOptions.cpu).toBe(1024)
    expect(tdOptions.memory).toBe(2048)
    expect(tdOptions.region).toBe('ap-northeast-1')
    expect(tdOptions.logGroupName).toBe('/ai-support-agent/ecs-agent')

    // API registration with the agent Bearer token
    expect(mockApiClientCtor).toHaveBeenCalledWith('https://api.example.com', 'mbc:token-id:secret')
    expect(mockSetTenantCode).toHaveBeenCalledWith('mbc')
    const registration = mockRegisterEcsAgent.mock.calls[0][0]
    expect(registration.agentId).toMatch(/^ecs-[0-9a-f-]{36}$/)
    expect(registration.displayName).toBe('My ECS Agent')
    // ECS execution agents advertise the server-setup custom-tasks capability
    // so the api will dispatch body-carrying recipes to them.
    expect(registration.capabilities).toEqual(['server_setup_custom_tasks'])
    expect(registration.ecsConfig).toMatchObject({
      imageUri: `${REPO_URI}@${DIGEST}`,
      imageTag: 'v1',
      imageDigest: DIGEST,
      cpu: 1024,
      memory: 2048,
      taskDefinitionArn: TASK_DEF_ARN,
      taskDefinitionFamily: 'fam',
      clusterArn: CLUSTER_ARN,
      subnetIds: ['subnet-1', 'subnet-2'],
      securityGroupIds: ['sg-1'],
      assignPublicIp: true,
      logGroupName: '/ai-support-agent/ecs-agent',
      launcherAgentId: 'launcher-1',
      registeredBy: 'publisher-agent',
    })
    expect(typeof registration.ecsConfig.registeredAt).toBe('string')

    // agentId persisted keyed by repository URI
    expect(mockAddProject).toHaveBeenCalledWith(expect.objectContaining({
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
      ecsAgents: { [REPO_URI]: registration.agentId },
    }))
  })

  it('uses a default display name of repository:tag when --name is omitted', async () => {
    await runEcsPublish(baseOpts())
    expect(mockRegisterEcsAgent.mock.calls[0][0].displayName).toBe('my-repo:v1')
  })

  it('reuses the persisted agentId on re-publish (same repository URI)', async () => {
    const project = makeProject({ ecsAgents: { [REPO_URI]: 'ecs-11111111-1111-1111-1111-111111111111' } })
    mockLoadConfig.mockReturnValue(makeConfig([project]))

    await runEcsPublish(baseOpts())

    const registration = mockRegisterEcsAgent.mock.calls[0][0]
    expect(registration.agentId).toBe('ecs-11111111-1111-1111-1111-111111111111')
    expect(mockRegisterTaskDefinition.mock.calls[0][0].family)
      .toBe('ai-support-ecs-agent-mbc-ecs-11111111-1111-1111-1111-111111111111')
    expect(mockAddProject).toHaveBeenCalledWith(expect.objectContaining({
      ecsAgents: { [REPO_URI]: 'ecs-11111111-1111-1111-1111-111111111111' },
    }))
  })

  it('passes custom cpu/memory/log group/roles/dockerfile through', async () => {
    await runEcsPublish(baseOpts({
      cpu: '512',
      memory: '1024',
      logGroup: '/custom/group',
      executionRole: 'arn:aws:iam::123456789012:role/exec',
      taskRole: 'arn:aws:iam::123456789012:role/task',
      dockerfile: 'Dockerfile.custom',
    }))

    expect(mockPublishImage).toHaveBeenCalledWith(expect.objectContaining({ dockerfile: 'Dockerfile.custom' }))
    const tdOptions = mockRegisterTaskDefinition.mock.calls[0][0]
    expect(tdOptions.cpu).toBe(512)
    expect(tdOptions.memory).toBe(1024)
    expect(tdOptions.logGroupName).toBe('/custom/group')
    expect(tdOptions.executionRoleArn).toBe('arn:aws:iam::123456789012:role/exec')
    expect(tdOptions.taskRoleArn).toBe('arn:aws:iam::123456789012:role/task')
    const config = mockRegisterEcsAgent.mock.calls[0][0].ecsConfig
    expect(config.cpu).toBe(512)
    expect(config.memory).toBe(1024)
    expect(config.logGroupName).toBe('/custom/group')
    // assignPublicIp not specified -> omitted from the registration
    expect('assignPublicIp' in config).toBe(false)
  })

  it('does not pass any ECS isolation fields by default (back-compat)', async () => {
    await runEcsPublish(baseOpts())
    const tdOptions = mockRegisterTaskDefinition.mock.calls[0][0]
    expect('readonlyRootFilesystem' in tdOptions).toBe(false)
    expect('user' in tdOptions).toBe(false)
    expect('dropCapabilities' in tdOptions).toBe(false)
  })

  it('passes opt-in ECS isolation fields through to the registrar', async () => {
    await runEcsPublish(baseOpts({
      readonlyRootfs: true,
      runAsUser: '1000:1000',
      dropCapabilities: ['ALL'],
    }))
    const tdOptions = mockRegisterTaskDefinition.mock.calls[0][0]
    expect(tdOptions.readonlyRootFilesystem).toBe(true)
    expect(tdOptions.user).toBe('1000:1000')
    expect(tdOptions.dropCapabilities).toEqual(['ALL'])
  })

  it('omits an empty --drop-capabilities list', async () => {
    await runEcsPublish(baseOpts({ dropCapabilities: [] }))
    expect('dropCapabilities' in mockRegisterTaskDefinition.mock.calls[0][0]).toBe(false)
  })

  it('rejects an invalid --run-as-user before publishing anything', async () => {
    await expect(runEcsPublish(baseOpts({ runAsUser: 'bad user!' })))
      .rejects.toThrow('--run-as-user must be a uid')
    expect(mockPublishImage).not.toHaveBeenCalled()
  })

  it('throws when no configuration exists', async () => {
    mockLoadConfig.mockReturnValue(null)
    await expect(runEcsPublish(baseOpts())).rejects.toThrow('No agent configuration found')
  })

  it('throws for an invalid cluster ARN', async () => {
    await expect(runEcsPublish(baseOpts({ cluster: 'not-an-arn' })))
      .rejects.toThrow('Invalid cluster ARN')
    expect(mockPublishImage).not.toHaveBeenCalled()
  })

  it('throws for an invalid ECR repository URI', async () => {
    await expect(runEcsPublish(baseOpts({ repositoryUri: 'docker.io/nginx' })))
      .rejects.toThrow('Invalid ECR repository URI')
  })

  it.each([
    ['cpu', { cpu: 'abc' }],
    ['cpu', { cpu: '-1' }],
    ['memory', { memory: '0' }],
  ])('throws for a non-positive-integer --%s', async (label, overrides) => {
    await expect(runEcsPublish(baseOpts(overrides))).rejects.toThrow(`--${label} must be a positive integer`)
  })

  it('does not register the agent when the image publish fails', async () => {
    mockPublishImage.mockRejectedValue(new Error('push failed'))
    await expect(runEcsPublish(baseOpts())).rejects.toThrow('push failed')
    expect(mockRegisterTaskDefinition).not.toHaveBeenCalled()
    expect(mockRegisterEcsAgent).not.toHaveBeenCalled()
    expect(mockAddProject).not.toHaveBeenCalled()
  })

  it('does not persist the agentId when the API registration fails', async () => {
    mockRegisterEcsAgent.mockRejectedValue(new Error('403'))
    await expect(runEcsPublish(baseOpts())).rejects.toThrow('403')
    expect(mockAddProject).not.toHaveBeenCalled()
  })
})

describe('registerEcsCommands (commander wiring)', () => {
  const originalExitCode = process.exitCode

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  function makeProgram(): Command {
    const program = new Command()
    program.exitOverride()
    registerEcsCommands(program)
    // Propagate exitOverride to the nested ecs/publish commands so missing
    // required options throw instead of calling process.exit.
    for (const cmd of program.commands) {
      cmd.exitOverride()
      cmd.configureOutput({ writeErr: () => {} })
      for (const sub of cmd.commands) {
        sub.exitOverride()
        sub.configureOutput({ writeErr: () => {} })
      }
    }
    return program
  }

  it('parses all options and runs the publish flow', async () => {
    const program = makeProgram()

    await program.parseAsync([
      'node', 'ai-support-agent', 'ecs', 'publish',
      '--repository-uri', REPO_URI,
      '--tag', 'v9',
      '--cluster', CLUSTER_ARN,
      '--subnets', 'subnet-a', 'subnet-b',
      '--security-groups', 'sg-a', 'sg-b',
      '--cpu', '256',
      '--memory', '512',
      '--name', 'From CLI',
      '--assign-public-ip',
      '--log-group', '/cli/group',
      '--project', 'mbc/MBC_01',
    ])

    expect(mockPublishImage).toHaveBeenCalledWith(expect.objectContaining({ repositoryUri: REPO_URI, tag: 'v9' }))
    const registration = mockRegisterEcsAgent.mock.calls[0][0]
    expect(registration.displayName).toBe('From CLI')
    expect(registration.ecsConfig).toMatchObject({
      clusterArn: CLUSTER_ARN,
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupIds: ['sg-a', 'sg-b'],
      cpu: 256,
      memory: 512,
      assignPublicIp: true,
      logGroupName: '/cli/group',
    })
    expect(process.exitCode).toBe(originalExitCode)
  })

  it('rejects when a required option is missing', async () => {
    const program = makeProgram()

    await expect(program.parseAsync([
      'node', 'ai-support-agent', 'ecs', 'publish',
      '--tag', 'v1',
      '--cluster', CLUSTER_ARN,
      '--subnets', 'subnet-a',
      '--security-groups', 'sg-a',
    ])).rejects.toThrow(/repository-uri/)

    expect(mockPublishImage).not.toHaveBeenCalled()
  })

  it('logs the failure and sets a non-zero exit code when publishing fails', async () => {
    mockPublishImage.mockRejectedValue(new Error('boom'))
    const program = makeProgram()

    await program.parseAsync([
      'node', 'ai-support-agent', 'ecs', 'publish',
      '--repository-uri', REPO_URI,
      '--tag', 'v1',
      '--cluster', CLUSTER_ARN,
      '--subnets', 'subnet-a',
      '--security-groups', 'sg-a',
    ])

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(process.exitCode).toBe(1)
  })
})
