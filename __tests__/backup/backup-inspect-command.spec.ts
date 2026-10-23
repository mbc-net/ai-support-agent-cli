import { executeBackupInspect } from '../../src/backup/backup-inspect-command'
import { buildCapabilityReport } from '../../src/capability/capability-report'
import { createBackupInspectionClient } from '../../src/backup/backup-aws-client'
import { inspectBackup } from '../../src/backup/backup-inspector'

jest.mock('../../src/backup/backup-aws-client')
jest.mock('../../src/backup/backup-inspector')

const payload = {
  awsAccountId: '123456789012', region: 'ap-northeast-1', planName: 'plan',
  vaults: [{ name: 'vault', minRetentionDays: 7, maxRetentionDays: 30 }],
  selectionNames: ['selection'], resourceTypes: ['DynamoDB'], lookbackHours: 24,
}

describe('backup_inspect command', () => {
  const close = jest.fn()
  beforeEach(() => {
    jest.resetAllMocks()
    jest.mocked(createBackupInspectionClient).mockReturnValue({ close } as ReturnType<typeof createBackupInspectionClient>)
  })
  it('refuses commands without an explicit capability before creating credentials', async () => {
    expect(await executeBackupInspect(payload, false)).toEqual({ success: false, error: 'BACKUP_CAPABILITY_DISABLED' })
    expect(createBackupInspectionClient).not.toHaveBeenCalled()
  })
  it('validates input before creating AWS clients', async () => {
    expect(await executeBackupInspect({}, true)).toEqual({ success: false, error: 'BACKUP_INVALID_REQUEST' })
    expect(createBackupInspectionClient).not.toHaveBeenCalled()
  })
  it('returns the inspection and always closes clients', async () => {
    const result = { issues: [] } as unknown as Awaited<ReturnType<typeof inspectBackup>>
    jest.mocked(inspectBackup).mockResolvedValue(result)
    expect(await executeBackupInspect(payload, true)).toEqual({ success: true, data: result })
    expect(inspectBackup).toHaveBeenCalledWith(payload, { close })
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('does not leak AWS error messages or credentials', async () => {
    jest.mocked(inspectBackup).mockRejectedValue(new Error('sensitive content'))
    expect(await executeBackupInspect(payload, true)).toEqual({ success: false, error: 'BACKUP_INSPECTION_FAILED' })
    expect(close).toHaveBeenCalledTimes(1)
  })
  it.each([{}, { AI_SUPPORT_AGENT_IN_DOCKER: '1' }, { KUBERNETES_SERVICE_HOST: 'cluster' }, { ECS_CONTAINER_METADATA_URI_V4: 'ecs' }])('reports the declared capability without requiring a sidecar (%#)', (env) => {
    expect(buildCapabilityReport({ declaration: { backup_executor: true }, env })).toEqual([
      expect.objectContaining({ key: 'backup_executor', state: 'active' }),
    ])
    expect(buildCapabilityReport({ declaration: { backup_executor: false }, env })).toEqual([])
  })
})
