/**
 * Dispatch tests for the ecs_launch / ecs_stop command handlers in
 * src/commands/index.ts (routing only — the launcher logic itself is
 * covered by __tests__/ecs/ecs-launcher.spec.ts).
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

const mockEcsLaunch = jest.fn()
const mockEcsStop = jest.fn()
jest.mock('../../src/ecs/ecs-launcher', () => ({
  ecsLaunch: (...args: unknown[]) => mockEcsLaunch(...args),
  ecsStop: (...args: unknown[]) => mockEcsStop(...args),
}))

import { executeCommand } from '../../src/commands'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('ecs_launch dispatch', () => {
  it('routes the payload to ecsLaunch and returns its result', async () => {
    mockEcsLaunch.mockResolvedValue({ success: true, data: { taskArn: 'arn:task' } })
    const payload = { taskDefinitionArn: 'arn:td', clusterArn: 'arn:cluster' }

    const result = await executeCommand('ecs_launch', payload)

    expect(mockEcsLaunch).toHaveBeenCalledWith(payload)
    expect(result).toEqual({ success: true, data: { taskArn: 'arn:task' } })
  })

  it('propagates a failed launch result', async () => {
    mockEcsLaunch.mockResolvedValue({ success: false, error: 'RunTask failed', data: { failures: [] } })

    const result = await executeCommand('ecs_launch', {})

    expect(result).toEqual({ success: false, error: 'RunTask failed', data: { failures: [] } })
  })
})

describe('ecs_stop dispatch', () => {
  it('routes the payload to ecsStop and returns its result', async () => {
    mockEcsStop.mockResolvedValue({ success: true, data: { stopped: true, taskArn: 'arn:task' } })
    const payload = { clusterArn: 'arn:cluster', taskArn: 'arn:task' }

    const result = await executeCommand('ecs_stop', payload)

    expect(mockEcsStop).toHaveBeenCalledWith(payload)
    expect(result).toEqual({ success: true, data: { stopped: true, taskArn: 'arn:task' } })
  })
})
