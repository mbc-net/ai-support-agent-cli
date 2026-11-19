/**
 * installUpdateAndRestart against the real filesystem: update-version.json is
 * written by the container into its project config dir, so the host reads it
 * without following a symlink and without blocking on a FIFO (design §7.7).
 */
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let globalDir = ''

jest.mock('../../src/logger')
jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => globalDir),
}))
jest.mock('../../src/update-checker', () => ({
  performUpdate: jest.fn().mockResolvedValue({ success: true }),
  reExecProcess: jest.fn(),
}))
jest.mock('../../src/docker/version-manager', () => ({
  resetInstalledVersionCache: jest.fn(),
}))

import { installUpdateAndRestart } from '../../src/docker/update-handler'
import { performUpdate, reExecProcess } from '../../src/update-checker'

describe('installUpdateAndRestart never follows a symlinked update-version.json', () => {
  let root: string
  let projectDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-handler-nofollow-'))
    globalDir = path.join(root, 'global')
    projectDir = path.join(root, 'project')
    fs.mkdirSync(globalDir)
    fs.mkdirSync(projectDir)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads a regular file as before, and removes it', async () => {
    fs.writeFileSync(path.join(projectDir, 'update-version.json'), JSON.stringify({ version: '1.2.3' }))
    await installUpdateAndRestart(projectDir)
    expect(performUpdate).toHaveBeenCalledWith('1.2.3', 'global')
    expect(fs.existsSync(path.join(projectDir, 'update-version.json'))).toBe(false)
  })

  it('does not follow a symlink: the linked version is not installed, and the link is removed (not its target)', async () => {
    const target = path.join(root, 'elsewhere.json')
    fs.writeFileSync(target, JSON.stringify({ version: '6.6.6' }))
    fs.symlinkSync(target, path.join(projectDir, 'update-version.json'))

    await installUpdateAndRestart(projectDir)

    expect(performUpdate).not.toHaveBeenCalled()
    expect(fs.existsSync(target)).toBe(true)
    expect(reExecProcess).toHaveBeenCalled()
  })

  ;(process.platform === 'win32' ? it.skip : it)('does not block on a FIFO planted in its place', async () => {
    execFileSync('mkfifo', [path.join(projectDir, 'update-version.json')])
    await installUpdateAndRestart(projectDir)
    expect(performUpdate).not.toHaveBeenCalled()
    expect(reExecProcess).toHaveBeenCalled()
  }, 5000)
})
