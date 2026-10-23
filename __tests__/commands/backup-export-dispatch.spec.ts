jest.mock('../../src/logger', () => ({ logger: { info: jest.fn(), success: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../../src/backup/backup-export-command', () => ({ executeBackupExport: jest.fn().mockResolvedValue({ success: true, data: {} }) }))

import { executeCommand } from '../../src/commands'
import { executeBackupExport } from '../../src/backup/backup-export-command'
import type { AgentServerConfig } from '../../src/types'

beforeEach(() => jest.clearAllMocks())
it('dispatches export with the trusted command ID and explicit capability', async () => {
  const payload = { runId: 'command-1' }
  const serverConfig = { capabilities: { backup_executor: true } } as AgentServerConfig
  await executeCommand('backup_export', payload, { serverConfig, commandId: 'command-1' })
  expect(executeBackupExport).toHaveBeenCalledWith(payload, true, 'command-1')
})
it('does not infer a capability or command identity from the payload', async () => {
  const payload = { runId: 'command-1', backup_executor: true }
  await executeCommand('backup_export', payload)
  expect(executeBackupExport).toHaveBeenCalledWith(payload, false, undefined)
})
