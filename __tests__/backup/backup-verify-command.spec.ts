import { performance } from 'perf_hooks'
import { executeBackupVerify } from '../../src/backup/backup-verify-command'
import { parseBackupVerifyRequest } from '../../src/backup/backup-verify-request'
import { createBackupStorageClient } from '../../src/backup/backup-storage-client'
import { verifyBackupExport } from '../../src/backup/backup-verifier'

jest.mock('../../src/backup/backup-verify-request')
jest.mock('../../src/backup/backup-storage-client')
jest.mock('../../src/backup/backup-verifier')
const request = {
  verificationId: 'verify-1', awsAccountId: '123456789012', region: 'ap-northeast-1',
  destination: { provider: 'wasabi', endpoint: 'https://s3.wasabisys.com', region: 'us-east-1', writeCredentialSecretArn: 'secret', bucket: 'bucket', prefix: '' },
  reference: { runId: 'export-1', attemptId: 'attempt', objectCount: 1, manifest: {} as any },
  limits: { maxObjects: 100, maxTotalCiphertextBytes: 10000, minimumRetainUntil: new Date('2099-01-01'), timeoutMs: 60000 },
}
const destroy = jest.fn()
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(parseBackupVerifyRequest).mockReturnValue(request)
  jest.mocked(createBackupStorageClient).mockResolvedValue({ destroy } as any)
})
it('requires explicit capability and the trusted verification command ID before credentials', async () => {
  expect(await executeBackupVerify({}, false, 'verify-1')).toEqual({ success: false, error: 'BACKUP_CAPABILITY_DISABLED' })
  expect(parseBackupVerifyRequest).not.toHaveBeenCalled()
  for (const id of [undefined, 'export-1', 'other']) {
    expect(await executeBackupVerify({}, true, id)).toEqual({ success: false, error: 'BACKUP_INVALID_REQUEST' })
  }
  expect(createBackupStorageClient).not.toHaveBeenCalled()
})
it('verifies the saved reference with a bounded deadline and disposes its client', async () => {
  const verified = { version: 1, runId: 'export-1' } as any
  jest.mocked(verifyBackupExport).mockResolvedValue(verified)
  expect(await executeBackupVerify({}, true, 'verify-1')).toEqual({ success: true, data: { verificationId: 'verify-1', verification: verified } })
  expect(createBackupStorageClient).toHaveBeenCalledWith(request.destination, { accountId: request.awsAccountId, region: request.region }, expect.any(AbortSignal))
  expect(verifyBackupExport).toHaveBeenCalledWith(expect.anything(), request.reference, expect.objectContaining({ maxObjects: 100, maxTotalCiphertextBytes: 10000 }), expect.any(AbortSignal))
  expect(destroy).toHaveBeenCalledTimes(1)
})
it.each(['BACKUP_VERIFY_DIGEST_MISMATCH', 'BACKUP_VERIFY_OBJECT_MISMATCH', 'BACKUP_VERIFY_SIZE_LIMIT'])('preserves fixed verifier errors (%s)', async code => {
  jest.mocked(verifyBackupExport).mockRejectedValue(new Error(code))
  expect(await executeBackupVerify({}, true, 'verify-1')).toEqual({ success: false, error: code })
  expect(destroy).toHaveBeenCalledTimes(1)
})
it('sanitizes arbitrary provider failures', async () => {
  jest.mocked(createBackupStorageClient).mockRejectedValue(new Error('private credential stderr'))
  expect(await executeBackupVerify({}, true, 'verify-1')).toEqual({ success: false, error: 'BACKUP_VERIFY_FAILED' })
  expect(verifyBackupExport).not.toHaveBeenCalled()
})
it('sanitizes disposal failures even after successful verification', async () => {
  destroy.mockImplementation(() => { throw new Error('private disposal message') })
  expect(await executeBackupVerify({}, true, 'verify-1')).toEqual({ success: false, error: 'BACKUP_VERIFY_CLEANUP_FAILED' })
})
it('includes credential retrieval in the deadline', async () => {
  jest.useFakeTimers()
  try {
    jest.mocked(createBackupStorageClient).mockImplementation(async (_destination, _context, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('private timeout')), { once: true })
    }))
    const result = executeBackupVerify({}, true, 'verify-1')
    await jest.advanceTimersByTimeAsync(60001)
    expect(await result).toEqual({ success: false, error: 'BACKUP_VERIFY_TIMEOUT' })
    expect(verifyBackupExport).not.toHaveBeenCalled()
  } finally { jest.useRealTimers() }
})
it('detects a deadline exceeded while the timer callback is delayed', async () => {
  jest.mocked(parseBackupVerifyRequest).mockReturnValue({ ...request, limits: { ...request.limits, timeoutMs: 1 } })
  jest.mocked(createBackupStorageClient).mockImplementation(async () => {
    const start = performance.now()
    while (performance.now() - start < 5) { /* synchronous credential work */ }
    return { destroy } as any
  })
  expect(await executeBackupVerify({}, true, 'verify-1')).toEqual({ success: false, error: 'BACKUP_VERIFY_TIMEOUT' })
  expect(verifyBackupExport).not.toHaveBeenCalled()
  expect(destroy).toHaveBeenCalledTimes(1)
})
