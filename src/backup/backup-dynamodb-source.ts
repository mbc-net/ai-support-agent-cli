import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import type { CompletedDynamoBackupExport } from './backup-dynamodb-export'
import type { BackupExportSource } from './backup-export-writer'
import { isScopedBackupResourceArn } from './backup-resource-selection'
import { streamBackupS3Object, type BackupS3Object } from './backup-s3-source'
import type { BackupTenantContext } from './backup-source-secrets'

const MAX_SUMMARY_BYTES = 1024 * 1024
const MAX_FILES_MANIFEST_BYTES = 16 * 1024 * 1024
const SAFE = new Set(['BACKUP_DYNAMODB_MANIFEST_INVALID', 'BACKUP_DYNAMODB_CHECKSUM_MISMATCH', 'BACKUP_EXPORT_SIZE_LIMIT', 'BACKUP_EXPORT_ABORTED'])
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function check(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED') }
function fail(error: unknown, signal?: AbortSignal): never {
  check(signal)
  throw new Error(error instanceof Error && SAFE.has(error.message) ? error.message : 'BACKUP_DYNAMODB_READ_FAILED')
}

/** Only a completed FULL_EXPORT is accepted. No source files are deleted here. */
export async function* enumerateDynamoBackupSources(
  s3: S3Client, expected: BackupTenantContext, input: CompletedDynamoBackupExport,
  limits: { maxFiles: number; maxObjectBytes: number }, signal?: AbortSignal,
): AsyncGenerator<BackupExportSource> {
  const context = { ...expected }; const exportInfo = { ...input }; const { maxFiles, maxObjectBytes } = limits
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region) ||
    !isScopedBackupResourceArn(exportInfo.tableArn, 'dynamodb', context) ||
    !exportInfo.exportArn.startsWith(`${exportInfo.tableArn}/export/`) ||
    !/^[A-Za-z0-9-]+$/.test(exportInfo.exportArn.slice(`${exportInfo.tableArn}/export/`.length)) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(exportInfo.bucket) ||
    typeof exportInfo.prefix !== 'string' || Buffer.byteLength(exportInfo.prefix) > 800 ||
    !Number.isFinite(Date.parse(exportInfo.exportTime)) || !Number.isSafeInteger(exportInfo.itemCount) || exportInfo.itemCount < 0 ||
    !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10000 ||
    !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 2 ** 36 - 32) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
  const exportId = exportInfo.exportArn.slice(`${exportInfo.tableArn}/export/`.length)
  const directory = `${exportInfo.prefix}/AWSDynamoDB/${exportId}/`
  if (exportInfo.manifestKey !== `${directory}manifest-summary.json`) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
  const describe = async (key: string, maxBytes: number, activeSignal?: AbortSignal): Promise<BackupS3Object> => {
    check(activeSignal)
    const head = await s3.send(new HeadObjectCommand({ Bucket: exportInfo.bucket, Key: key, ExpectedBucketOwner: context.accountId }), { abortSignal: activeSignal })
    check(activeSignal)
    if (!head.ETag || !Number.isSafeInteger(head.ContentLength) || head.ContentLength! < 0 || head.DeleteMarker) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
    if (head.ContentLength! > maxBytes) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
    return { bucket: exportInfo.bucket, accountId: context.accountId, key, etag: head.ETag, bytes: head.ContentLength! }
  }
  const read = async (key: string, maxBytes: number): Promise<Buffer> => {
    const reference = await describe(key, maxBytes, signal)
    const chunks: Buffer[] = []
    for await (const chunk of streamBackupS3Object(s3, reference, signal)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  try {
    check(signal)
    const summaryBytes = await read(exportInfo.manifestKey, MAX_SUMMARY_BYTES)
    let summary: unknown
    try { summary = JSON.parse(summaryBytes.toString('utf8')) } catch { throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID') }
    const filesKey = `${directory}manifest-files.json`
    if (!object(summary) || summary.version !== '2020-06-30' || summary.exportArn !== exportInfo.exportArn || summary.tableArn !== exportInfo.tableArn || summary.tableId !== exportInfo.tableId ||
      summary.s3Bucket !== exportInfo.bucket || summary.s3Prefix !== exportInfo.prefix || summary.s3SseAlgorithm !== 'AES256' ||
      summary.outputFormat !== 'DYNAMODB_JSON' || summary.exportType !== undefined || summary.filterSpecification !== undefined ||
      typeof summary.exportTime !== 'string' || Date.parse(summary.exportTime) !== Date.parse(exportInfo.exportTime) ||
      summary.manifestFilesS3Key !== filesKey || summary.itemCount !== exportInfo.itemCount) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
    const filesBytes = await read(filesKey, MAX_FILES_MANIFEST_BYTES)
    const files: { key: string; etag: string; md5: string }[] = []
    const seen = new Set<string>()
    let totalItems = 0
    for (const line of filesBytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID') }
      if (!object(value) || typeof value.dataFileS3Key !== 'string' || !value.dataFileS3Key.startsWith(`${directory}data/`) ||
        !/^[A-Za-z0-9_-]+\.json\.gz$/.test(value.dataFileS3Key.slice(`${directory}data/`.length)) ||
        !Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 0 || typeof value.etag !== 'string' || !/^[a-fA-F0-9]{32}(?:-\d+)?$/.test(value.etag) ||
        typeof value.md5Checksum !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value.md5Checksum) ||
        Buffer.from(value.md5Checksum, 'base64').toString('base64') !== value.md5Checksum || seen.has(value.dataFileS3Key)) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
      seen.add(value.dataFileS3Key)
      if (seen.size > maxFiles) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      totalItems += value.itemCount as number
      if (!Number.isSafeInteger(totalItems) || totalItems > exportInfo.itemCount) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
      files.push({ key: value.dataFileS3Key, etag: `"${value.etag}"`, md5: value.md5Checksum })
    }
    if (totalItems !== exportInfo.itemCount || !files.length) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
    for (const [name, bytes] of [[exportInfo.manifestKey, summaryBytes], [filesKey, filesBytes]] as const) {
      check(signal)
      yield { resourceArn: exportInfo.tableArn, name, format: 'dynamodb-manifest', open: async function* (activeSignal) { check(activeSignal); yield bytes; check(activeSignal) } }
    }
    for (const file of files) {
      check(signal)
      yield {
        resourceArn: exportInfo.tableArn, name: file.key, format: 'dynamodb-json-gzip',
        open: async function* (activeSignal) {
          try {
            const reference = await describe(file.key, maxObjectBytes, activeSignal)
            if (reference.etag !== file.etag) throw new Error('BACKUP_DYNAMODB_MANIFEST_INVALID')
            const md5 = createHash('md5')
            for await (const chunk of streamBackupS3Object(s3, reference, activeSignal)) { md5.update(chunk); yield chunk }
            check(activeSignal)
            if (md5.digest('base64') !== file.md5) throw new Error('BACKUP_DYNAMODB_CHECKSUM_MISMATCH')
          } catch (error) { fail(error, activeSignal) }
        },
      }
    }
  } catch (error) { fail(error, signal) }
}
