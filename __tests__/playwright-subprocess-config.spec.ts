import * as path from 'path'

describe('playwright subprocess config', () => {
  it('uses /tmp as testDir because generated specs are written there', () => {
    const config = require('../playwright.subprocess.config.js') as {
      testDir?: string
    }

    expect(path.resolve(config.testDir ?? '')).toBe('/tmp')
  })
})
