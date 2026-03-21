import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.mock('fs')
jest.mock('os', () => ({
  ...jest.requireActual<typeof os>('os'),
  homedir: jest.fn(() => '/home/testuser'),
}))
jest.mock('../../src/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
  },
}))

import { ensureAllowedToolsInSettings } from '../../src/utils/claude-settings'
import { logger } from '../../src/logger'

const mockedFs = fs as jest.Mocked<typeof fs>

describe('claude-settings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('ensureAllowedToolsInSettings', () => {
    it('should do nothing when allowedTools is empty', () => {
      ensureAllowedToolsInSettings([])
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('should create settings.json with permissions.allow when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      ensureAllowedToolsInSettings(['WebFetch', 'WebSearch'])

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join('/home/testuser', '.claude'),
        { recursive: true, mode: 0o700 },
      )
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        path.join('/home/testuser', '.claude', 'settings.json'),
        expect.stringContaining('"WebFetch"'),
        { mode: 0o600 },
      )
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string)
      expect(written.permissions.allow).toEqual(['WebFetch', 'WebSearch'])
    })

    it('should add missing tools to existing settings.json', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({
        permissions: { allow: ['Read', 'Write'] },
      }))

      ensureAllowedToolsInSettings(['Read', 'WebFetch', 'Bash'])

      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string)
      expect(written.permissions.allow).toEqual(['Read', 'Write', 'WebFetch', 'Bash'])
    })

    it('should not write when all tools are already present', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({
        permissions: { allow: ['WebFetch', 'Read'] },
      }))

      ensureAllowedToolsInSettings(['WebFetch', 'Read'])

      expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('should preserve existing settings when adding tools', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({
        someOtherSetting: true,
        permissions: {
          allow: ['Read'],
          deny: ['Bash(rm -rf *)'],
        },
      }))

      ensureAllowedToolsInSettings(['WebFetch'])

      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string)
      expect(written.someOtherSetting).toBe(true)
      expect(written.permissions.deny).toEqual(['Bash(rm -rf *)'])
      expect(written.permissions.allow).toEqual(['Read', 'WebFetch'])
    })

    it('should handle corrupted settings.json', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue('not valid json')

      ensureAllowedToolsInSettings(['WebFetch'])

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('corrupted'))
      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string)
      expect(written.permissions.allow).toEqual(['WebFetch'])
    })

    it('should handle settings with no permissions key', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }))

      ensureAllowedToolsInSettings(['WebFetch'])

      const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string)
      expect(written.theme).toBe('dark')
      expect(written.permissions.allow).toEqual(['WebFetch'])
    })

    it('should handle write errors gracefully', () => {
      mockedFs.existsSync.mockReturnValue(false)
      mockedFs.mkdirSync.mockImplementation(() => { throw new Error('Permission denied') })

      ensureAllowedToolsInSettings(['WebFetch'])

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to update'))
    })
  })
})
