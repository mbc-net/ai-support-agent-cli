import * as fs from 'fs'
import * as path from 'path'

const mockHomedir = jest.fn()

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}))

jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: (...args: Parameters<typeof actual.homedir>) => mockHomedir(...args),
  }
})

jest.mock('../../src/logger')

const mockFs = jest.mocked(fs)

describe('ensureClaudeJsonIntegrity', () => {
  const MOCK_HOME = '/mock/home'
  const CLAUDE_JSON_PATH = path.join(MOCK_HOME, '.claude.json')
  const BACKUP_PATH = path.join(MOCK_HOME, '.claude.json.backup')

  let ensureClaudeJsonIntegrity: () => void

  beforeAll(async () => {
    mockHomedir.mockReturnValue(MOCK_HOME)
    const mod = await import('../../src/utils/claude-config-validator')
    ensureClaudeJsonIntegrity = mod.ensureClaudeJsonIntegrity
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockHomedir.mockReturnValue(MOCK_HOME)
  })

  it('should skip when .claude.json does not exist', () => {
    mockFs.existsSync.mockReturnValue(false)

    ensureClaudeJsonIntegrity()

    expect(mockFs.existsSync).toHaveBeenCalledWith(CLAUDE_JSON_PATH)
    expect(mockFs.readFileSync).not.toHaveBeenCalled()
    expect(mockFs.writeFileSync).not.toHaveBeenCalled()
  })

  it('should create backup when .claude.json is valid JSON', () => {
    const validJson = '{"key":"value"}'
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(validJson)

    ensureClaudeJsonIntegrity()

    expect(mockFs.readFileSync).toHaveBeenCalledWith(CLAUDE_JSON_PATH, 'utf-8')
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1)
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(BACKUP_PATH, validJson, { mode: 0o600 })
  })

  it('should restore from backup when .claude.json is corrupted and backup is valid', () => {
    const corruptedContent = '{invalid json'
    const validBackup = '{"restored":true}'
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      if (p === CLAUDE_JSON_PATH) return true
      if (p === BACKUP_PATH) return true
      return false
    })
    mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p === CLAUDE_JSON_PATH) return corruptedContent
      if (p === BACKUP_PATH) return validBackup
      return ''
    })

    ensureClaudeJsonIntegrity()

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(CLAUDE_JSON_PATH, validBackup, { mode: 0o600 })
  })

  it('should reset to {} when .claude.json is corrupted and backup is also corrupted', () => {
    const corruptedContent = '{invalid'
    const corruptedBackup = '{also invalid'
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      if (p === CLAUDE_JSON_PATH) return true
      if (p === BACKUP_PATH) return true
      return false
    })
    mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p === CLAUDE_JSON_PATH) return corruptedContent
      if (p === BACKUP_PATH) return corruptedBackup
      return ''
    })

    ensureClaudeJsonIntegrity()

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(CLAUDE_JSON_PATH, '{}', { mode: 0o600 })
  })

  it('should reset to {} when .claude.json is corrupted and no backup exists', () => {
    const corruptedContent = '{invalid'
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      if (p === CLAUDE_JSON_PATH) return true
      if (p === BACKUP_PATH) return false
      return false
    })
    mockFs.readFileSync.mockReturnValue(corruptedContent)

    ensureClaudeJsonIntegrity()

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(CLAUDE_JSON_PATH, '{}', { mode: 0o600 })
  })

  it('should not throw when readFileSync throws IO error', () => {
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    expect(() => ensureClaudeJsonIntegrity()).not.toThrow()
  })

  it('should not throw when writeFileSync throws IO error', () => {
    const validJson = '{"key":"value"}'
    mockFs.existsSync.mockReturnValue(true)
    mockFs.readFileSync.mockReturnValue(validJson)
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    expect(() => ensureClaudeJsonIntegrity()).not.toThrow()
  })
})
