import { executeBackupExport } from '../../src/backup/backup-export-command'
import { parseBackupExportRequest } from '../../src/backup/backup-export-request'
import { createBackupResourceClient } from '../../src/backup/backup-resource-client'
import { resolveBackupResources } from '../../src/backup/backup-resource-selection'
import { loadBackupExportConfiguration } from '../../src/backup/backup-source-secrets'
import { createBackupStorageClient } from '../../src/backup/backup-storage-client'
import { writeBackupExport } from '../../src/backup/backup-export-writer'
import { enumerateBackupExportSources } from '../../src/backup/backup-export-sources'

jest.mock('../../src/backup/backup-export-request')
jest.mock('../../src/backup/backup-resource-client')
jest.mock('../../src/backup/backup-resource-selection')
jest.mock('../../src/backup/backup-source-secrets')
jest.mock('../../src/backup/backup-storage-client')
jest.mock('../../src/backup/backup-export-writer')
jest.mock('../../src/backup/backup-export-sources')
const request = {
  runId: 'command-1', awsAccountId: '123456789012', region: 'ap-northeast-1', targets: [],
  exportConfigurationSecretArn: 'config-secret', exportTime: new Date('2026-01-01'), publicKeyPem: 'public-key',
  destination: { provider: 'wasabi', endpoint: 'https://s3.wasabisys.com', region: 'us-east-1', writeCredentialSecretArn: 'storage-secret', bucket: 'backup-bucket', prefix: 'daily' },
  retentionDays: 30, limits: { maxObjects: 100, maxObjectBytes: 1024, maxTotalBytes: 10240, timeoutMs: 60000 },
}
const close = jest.fn(); const destroy = jest.fn()
const resources = [{ type: 's3' as const, arn: 'arn:aws:s3:::source', bucket: 'source' }]
const configuration = { version: 1 as const, databases: [] }
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(parseBackupExportRequest).mockReturnValue(request)
  jest.mocked(createBackupResourceClient).mockReturnValue({ close } as any)
  jest.mocked(resolveBackupResources).mockResolvedValue({ resources, nativeOnlyTypes: ['ec2'] })
  jest.mocked(loadBackupExportConfiguration).mockResolvedValue(configuration)
  jest.mocked(createBackupStorageClient).mockResolvedValue({ destroy } as any)
  jest.mocked(enumerateBackupExportSources).mockImplementation(async function* () {})
})
it('requires the capability and a matching command ID before acquiring credentials', async () => {
  expect(await executeBackupExport({}, false, 'command-1')).toEqual({ success: false, error: 'BACKUP_CAPABILITY_DISABLED' })
  expect(parseBackupExportRequest).not.toHaveBeenCalled()
  expect(await executeBackupExport({}, true, 'other-command')).toEqual({ success: false, error: 'BACKUP_INVALID_REQUEST' })
  expect(await executeBackupExport({}, true)).toEqual({ success: false, error: 'BACKUP_INVALID_REQUEST' })
  expect(createBackupResourceClient).not.toHaveBeenCalled()
})
it('connects sources to the writer and returns only its receipt and native-only types', async () => {
  const receipt = { runId: 'command-1', objectCount: 1 } as any
  jest.mocked(writeBackupExport).mockImplementation(async (_client, enumerate, options, signal) => {
    for await (const _item of enumerate(signal!)) { /* consume */ }
    expect(options.retainUntil.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000)
    expect(options).not.toHaveProperty('writeCredentialSecretArn')
    return receipt
  })
  expect(await executeBackupExport({}, true, 'command-1')).toEqual({ success: true, data: { version: 1, receipt, nativeOnlyTypes: ['ec2'] } })
  expect(enumerateBackupExportSources).toHaveBeenCalledWith({ accountId: request.awsAccountId, region: request.region }, resources, configuration, expect.anything(), expect.objectContaining({ exportTime: request.exportTime, runId: 'command-1' }), expect.any(AbortSignal))
  expect(close).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1)
})
it('does not expose provider messages or acquire storage keys after selection failure', async () => {
  jest.mocked(resolveBackupResources).mockRejectedValue(new Error('private credential process stderr'))
  expect(await executeBackupExport({}, true, 'command-1')).toEqual({ success: false, error: 'BACKUP_EXPORT_FAILED' })
  expect(createBackupStorageClient).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1)
})
it('closes both clients on writer failure and preserves fixed cleanup errors', async () => {
  jest.mocked(writeBackupExport).mockRejectedValue(new Error('BACKUP_DUMP_CLEANUP_FAILED'))
  expect(await executeBackupExport({}, true, 'command-1')).toEqual({ success: false, error: 'BACKUP_DUMP_CLEANUP_FAILED' })
  expect(close).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1)
})
it('covers credential lookup with the common deadline', async () => {
  jest.useFakeTimers()
  try {
    jest.mocked(loadBackupExportConfiguration).mockImplementation(async (_arn, _ctx, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('private timeout')), { once: true })
    }))
    const result = executeBackupExport({}, true, 'command-1')
    await jest.advanceTimersByTimeAsync(60001)
    expect(await result).toEqual({ success: false, error: 'BACKUP_EXPORT_TIMEOUT' })
    expect(createBackupStorageClient).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1)
  } finally { jest.useRealTimers() }
})
