import { parseBackupInspectionRequest } from '../../src/backup/backup-inspect-request'

const valid = () => ({
  awsAccountId: '123456789012', region: 'ap-northeast-1', planName: 'plan',
  vaults: [{ name: 'vault', minRetentionDays: 7, maxRetentionDays: 30 }],
  selectionNames: ['selection'], resourceTypes: ['DynamoDB'], lookbackHours: 24,
})

describe('parseBackupInspectionRequest', () => {
  it('accepts a bounded inspection without secret material', () => {
    expect(parseBackupInspectionRequest(valid())).toEqual(valid())
  })
  it.each([
    null, [], {}, { ...valid(), credentials: {} },
    { ...valid(), awsAccountId: 'other' }, { ...valid(), region: 'https://example.com' },
    { ...valid(), vaults: [] }, { ...valid(), vaults: [{ name: 'x', minRetentionDays: 30, maxRetentionDays: 7 }] },
    { ...valid(), vaults: [{ ...valid().vaults[0], accessKeyId: 'secret' }] },
    { ...valid(), lookbackHours: 0 }, { ...valid(), lookbackHours: 337 },
    { ...valid(), resourceTypes: ['Unsupported'] }, { ...valid(), selectionNames: ['x', 'x'] },
    { ...valid(), selectionNames: [] }, { ...valid(), planName: '../plan' },
  ])('rejects malformed or unexpected input (%#)', (input) => {
    expect(() => parseBackupInspectionRequest(input)).toThrow('BACKUP_INVALID_REQUEST')
  })
})
