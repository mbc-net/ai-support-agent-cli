import { parseBackupVerificationManifest } from '../../src/backup/backup-verification-manifest'

const runId = 'export-run'
const attemptId = '113f0496-349c-4df0-8802-d12c535fc217'
const root = `daily/${runId}/${attemptId}/`
const object = (name: string) => ({ bucket: 'backup-bucket', key: root + name, versionId: 'version-1', bytes: 100, sha256: 'a'.repeat(64), retainUntil: '2026-12-01T00:00:00.000Z' })
const expected = () => ({ runId, attemptId, objectCount: 1, manifest: object('manifest.json') })
const manifest = () => ({ version: 1, runId, attemptId, completedAt: '2026-10-15T01:00:00.000Z', objects: [{ id: '000000', ...object('000000.enc') }], catalog: object('catalog.enc') })
const limits = { maxObjects: 10, maxTotalCiphertextBytes: 1000, minimumRetainUntil: new Date('2026-11-01T00:00:00.000Z') }
const now = new Date('2026-10-15T02:00:00Z')
const parse = (value: unknown) => parseBackupVerificationManifest(value, expected(), limits, now)

describe('verification manifest trust boundary', () => {
  it('accepts an exact export manifest and returns a defensive copy', () => {
    const input = manifest(); const result = parse(input)
    expect(result).toEqual(input)
    input.objects[0].key = 'changed'
    expect(result.objects[0].key).toBe(root + '000000.enc')
  })
  it.each(['run', 'attempt', 'bucket', 'key', 'catalog', 'id', 'duplicate', 'count', 'extra'])(
    'rejects an untrusted %s reference before any object can be fetched', (kind) => {
      const value = manifest()
      if (kind === 'run') value.runId = 'other'
      if (kind === 'attempt') value.attemptId = 'other'
      if (kind === 'bucket') value.objects[0].bucket = 'other-bucket'
      if (kind === 'key') value.objects[0].key = 'outside/data.enc'
      if (kind === 'catalog') value.catalog.key = root + '000000.enc'
      if (kind === 'id') value.objects[0].id = '000001'
      if (kind === 'duplicate') value.objects.push(value.objects[0])
      if (kind === 'count') value.objects = []
      if (kind === 'extra') Object.assign(value.objects[0], { endpoint: 'https://other.invalid' })
      expect(() => parse(value)).toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
    },
  )
  it.each(['nullVersion', 'digest', 'fractionalBytes', 'expired', 'shortRetention', 'futureCompletion'])(
    'rejects invalid %s metadata', (kind) => {
      const value = manifest()
      if (kind === 'nullVersion') value.catalog.versionId = 'null'
      if (kind === 'digest') value.catalog.sha256 = 'bad'
      if (kind === 'fractionalBytes') value.catalog.bytes = 1.5
      if (kind === 'expired') value.catalog.retainUntil = '2026-01-01T00:00:00.000Z'
      if (kind === 'shortRetention') value.catalog.retainUntil = '2026-10-20T00:00:00.000Z'
      if (kind === 'futureCompletion') value.completedAt = '2026-10-16T00:00:00.000Z'
      expect(() => parse(value)).toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
    },
  )
  it('bounds total ciphertext including the public manifest and encrypted catalog', () => {
    expect(() => parseBackupVerificationManifest(manifest(), expected(), { ...limits, maxTotalCiphertextBytes: 299 }, now)).toThrow('BACKUP_VERIFY_SIZE_LIMIT')
    expect(() => parseBackupVerificationManifest(manifest(), expected(), { ...limits, maxTotalCiphertextBytes: 300 }, now)).not.toThrow()
  })
  it('rejects an excessive object count and invalid trusted limits', () => {
    expect(() => parseBackupVerificationManifest(manifest(), { ...expected(), objectCount: 11 }, limits, now)).toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
    expect(() => parseBackupVerificationManifest(manifest(), expected(), { ...limits, maxObjects: 0 }, now)).toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
  })
  it('requires a complete run directory, not just a matching key suffix', () => {
    const reference = expected()
    reference.manifest.key = `daily/not-${runId}/${attemptId}/manifest.json`
    const value = manifest()
    value.objects[0].key = `daily/not-${runId}/${attemptId}/000000.enc`
    value.catalog.key = `daily/not-${runId}/${attemptId}/catalog.enc`
    expect(() => parseBackupVerificationManifest(value, reference, limits, now)).toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
  })

})
