jest.mock('../../src/logger', () => ({ logger: { info: jest.fn(), success: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../../src/backup/backup-inspect-command', () => ({ executeBackupInspect: jest.fn().mockResolvedValue({ success: true, data: {} }) }))

import { executeCommand } from '../../src/commands'
import { executeBackupInspect } from '../../src/backup/backup-inspect-command'
import type { AgentServerConfig } from '../../src/types'

describe('backup_inspect dispatch', () => {
  beforeEach(() => jest.clearAllMocks())
  it('forwards the payload with the explicit declaration', async () => {
    const payload = { planName: 'plan' }
    const serverConfig = { capabilities: { backup_executor: true } } as AgentServerConfig
    await executeCommand('backup_inspect', payload, { serverConfig })
    expect(executeBackupInspect).toHaveBeenCalledWith(payload, true)
  })
  it('does not infer a capability from the payload', async () => {
    await executeCommand('backup_inspect', { backup_executor: true })
    expect(executeBackupInspect).toHaveBeenCalledWith({ backup_executor: true }, false)
  })
})
