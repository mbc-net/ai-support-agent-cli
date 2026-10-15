jest.mock('../../src/logger', () => ({ logger: { info: jest.fn(), success: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../../src/backup/backup-verify-command', () => ({ executeBackupVerify: jest.fn().mockResolvedValue({ success: true, data: {} }) }))

import { executeCommand } from '../../src/commands'
import { executeBackupVerify } from '../../src/backup/backup-verify-command'
import type { AgentServerConfig } from '../../src/types'

beforeEach(() => jest.clearAllMocks())
it('dispatches verification with the trusted command ID and explicit capability', async () => {
  const payload = { verificationId: 'command-1' }
  const serverConfig = { capabilities: { backup_executor: true } } as AgentServerConfig
  await executeCommand('backup_verify', payload, { serverConfig, commandId: 'command-1' })
  expect(executeBackupVerify).toHaveBeenCalledWith(payload, true, 'command-1')
})
it('does not infer a capability or command identity from the payload', async () => {
  const payload = { verificationId: 'command-1', backup_executor: true }
  await executeCommand('backup_verify', payload)
  expect(executeBackupVerify).toHaveBeenCalledWith(payload, false, undefined)
})
