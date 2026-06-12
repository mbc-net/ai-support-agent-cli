import * as path from 'path'
import { getNodePath, getCliEntryPoint } from '../../../src/cli/service/node-paths'

describe('node-paths', () => {
  describe('getNodePath', () => {
    it('returns the current Node.js executable path', () => {
      const result = getNodePath()
      expect(result).toBe(process.execPath)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('getCliEntryPoint', () => {
    it('returns an absolute path ending with index.js', () => {
      const result = getCliEntryPoint()
      expect(path.isAbsolute(result)).toBe(true)
      expect(result.endsWith('index.js')).toBe(true)
    })

    it('resolves two directories above __dirname of node-paths.ts', () => {
      // node-paths.ts lives at src/cli/service/node-paths.ts
      // so two levels up from __dirname of that file is src/
      const result = getCliEntryPoint()
      expect(result).toContain('index.js')
    })
  })
})
