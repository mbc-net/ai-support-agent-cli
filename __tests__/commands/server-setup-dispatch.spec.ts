/**
 * Dispatch tests for the server_setup_exec command handler in
 * src/commands/index.ts (routing only — the runner logic itself is covered
 * by __tests__/server-setup/server-setup-runner.spec.ts).
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

const mockRunServerSetup = jest.fn()
jest.mock('../../src/server-setup/server-setup-runner', () => ({
  runServerSetup: (...args: unknown[]) => mockRunServerSetup(...args),
}))

import { executeCommand } from '../../src/commands'
import type { ApiClient } from '../../src/api-client'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('server_setup_exec dispatch', () => {
  it('routes the payload to runServerSetup with the command context and returns its result', async () => {
    mockRunServerSetup.mockResolvedValue({ success: true, data: { stepResults: [] } })
    const client = {} as ApiClient
    const payload = { executionId: 'exec-1', sshHostId: 'host-1', steps: [] }

    const result = await executeCommand('server_setup_exec', payload, {
      commandId: 'cmd-1',
      client,
      agentId: 'agent-1',
    })

    expect(mockRunServerSetup).toHaveBeenCalledWith(payload, {
      commandId: 'cmd-1',
      client,
      agentId: 'agent-1',
    })
    expect(result).toEqual({ success: true, data: { stepResults: [] } })
  })

  it('propagates a failed run result', async () => {
    mockRunServerSetup.mockResolvedValue({ success: false, error: 'ansible-playbook exited with code 2' })
    const client = {} as ApiClient

    const result = await executeCommand(
      'server_setup_exec',
      { executionId: 'exec-1', sshHostId: 'host-1', steps: [] },
      { commandId: 'cmd-1', client },
    )

    expect(result).toEqual({ success: false, error: 'ansible-playbook exited with code 2' })
  })

  it('requires commandId and client, without invoking runServerSetup', async () => {
    const resultNoClient = await executeCommand(
      'server_setup_exec',
      { executionId: 'exec-1', sshHostId: 'host-1', steps: [] },
      { commandId: 'cmd-1' },
    )
    expect(resultNoClient).toEqual({ success: false, error: 'server_setup_exec requires client context' })

    const resultNoCommandId = await executeCommand(
      'server_setup_exec',
      { executionId: 'exec-1', sshHostId: 'host-1', steps: [] },
      { client: {} as ApiClient },
    )
    expect(resultNoCommandId).toEqual({ success: false, error: 'server_setup_exec requires client context' })

    expect(mockRunServerSetup).not.toHaveBeenCalled()
  })
})
