/**
 * dockerfile-sync against the real filesystem: config-dir copies that are
 * symlinks must never be followed, read or written through (design §7.7,
 * §12.3 #13). The decision table itself is covered, with a mocked fs, by
 * dockerfile-sync.spec.ts.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let configDir = ''
let bundleDir = ''

jest.mock('../../src/logger')
jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => configDir),
}))
jest.mock('../../src/docker/dockerfile-path', () => ({
  getDockerfilePath: jest.fn(() => path.join(bundleDir, 'docker', 'Dockerfile')),
  getDockerContextDir: jest.fn(() => bundleDir),
}))

import { hasUnmanagedConfigDockerfile, isDockerfileCustomized, syncDockerfileToConfigDir } from '../../src/docker/dockerfile-sync'
import { logger } from '../../src/logger'

const SECRET = '{"token":"SECRET-TOKEN-VALUE"}'

describe('dockerfile-sync never follows a symlink in the config dir', () => {
  let root: string
  let secretPath: string

  beforeEach(() => {
    jest.clearAllMocks()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerfile-sync-nofollow-'))
    configDir = path.join(root, 'config')
    bundleDir = path.join(root, 'bundle')
    fs.mkdirSync(configDir)
    fs.mkdirSync(path.join(bundleDir, 'docker'), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, 'docker', 'Dockerfile'), 'FROM ubuntu\n')
    fs.writeFileSync(path.join(bundleDir, 'docker', 'entrypoint.sh'), '#!/bin/sh\n')
    fs.writeFileSync(path.join(bundleDir, 'docker', 'tmux.conf'), 'set -g mouse on\n')
    secretPath = path.join(root, 'config.json')
    fs.writeFileSync(secretPath, SECRET)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('first run: replaces a symlinked Dockerfile with the bundled one, leaving its target alone', () => {
    fs.symlinkSync(secretPath, path.join(configDir, 'Dockerfile'))

    syncDockerfileToConfigDir()

    expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    expect(fs.lstatSync(path.join(configDir, 'Dockerfile')).isFile()).toBe(true)
    expect(fs.readFileSync(path.join(configDir, 'Dockerfile'), 'utf-8')).toBe('FROM ubuntu\n')
  })

  it('managed copy turned into a live symlink: never read or replaced, the sync is refused and says so', () => {
    syncDockerfileToConfigDir() // regular first sync, writes the hash file
    const dest = path.join(configDir, 'Dockerfile')
    fs.rmSync(dest)
    fs.symlinkSync(secretPath, dest)
    const hashBefore = fs.readFileSync(path.join(configDir, '.dockerfile-sync-hash'), 'utf-8')

    syncDockerfileToConfigDir()

    // logger.warn receives the i18n key (i18n is not initialised in tests).
    expect(logger.warn).toHaveBeenCalledWith('docker.dockerfileSyncFailed')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    expect(fs.readFileSync(path.join(configDir, '.dockerfile-sync-hash'), 'utf-8')).toBe(hashBefore)
  })

  it('managed copy turned into a dangling symlink: replaced by the bundled file (self-heal)', () => {
    syncDockerfileToConfigDir()
    const dest = path.join(configDir, 'Dockerfile')
    fs.rmSync(dest)
    fs.symlinkSync(path.join(root, 'nowhere'), dest)

    syncDockerfileToConfigDir()

    expect(fs.lstatSync(dest).isFile()).toBe(true)
    expect(fs.readFileSync(dest, 'utf-8')).toBe('FROM ubuntu\n')
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a symlinked hash file is refused, not read', () => {
    syncDockerfileToConfigDir()
    const hashFile = path.join(configDir, '.dockerfile-sync-hash')
    fs.rmSync(hashFile)
    fs.symlinkSync(secretPath, hashFile)

    syncDockerfileToConfigDir()

    // logger.warn receives the i18n key (i18n is not initialised in tests).
    expect(logger.warn).toHaveBeenCalledWith('docker.dockerfileSyncFailed')
    expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
  })

  it('a live symlinked asset is refused (not read, not replaced) and its target is not overwritten', () => {
    fs.mkdirSync(path.join(configDir, 'docker'))
    const asset = path.join(configDir, 'docker', 'tmux.conf')
    fs.symlinkSync(secretPath, asset)

    syncDockerfileToConfigDir()

    expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    expect(fs.lstatSync(asset).isSymbolicLink()).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith('docker.dockerAssetSyncFailed')
  })

  it('a dangling symlinked asset is replaced by a regular copy', () => {
    fs.mkdirSync(path.join(configDir, 'docker'))
    const asset = path.join(configDir, 'docker', 'tmux.conf')
    fs.symlinkSync(path.join(root, 'nowhere'), asset)

    syncDockerfileToConfigDir()

    expect(fs.lstatSync(asset).isFile()).toBe(true)
    expect(fs.readFileSync(asset, 'utf-8')).toBe('set -g mouse on\n')
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false)
  })

  it('does not write into a directory that a symlink below the config dir points to', () => {
    // A nested asset (docker/nvim/init.lua) as well: its directory must not
    // be created inside the symlink's target before the refusal.
    fs.mkdirSync(path.join(bundleDir, 'docker', 'nvim'))
    fs.writeFileSync(path.join(bundleDir, 'docker', 'nvim', 'init.lua'), '-- nvim\n')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(configDir, 'docker'))

    syncDockerfileToConfigDir()

    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('docker.dockerAssetSyncFailed')
    expect(logger.warn).toHaveBeenCalledWith('docker.dockerfileSyncFailed')
  })

  it('isDockerfileCustomized counts a symlinked config-dir copy as customised without following it, and says why', () => {
    fs.symlinkSync(secretPath, path.join(configDir, 'Dockerfile'))

    expect(isDockerfileCustomized()).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to read a non-regular file'))
  })

  it('isDockerfileCustomized counts an unreadable config-dir copy as customised, and says why', () => {
    fs.writeFileSync(path.join(configDir, 'Dockerfile'), Buffer.alloc(1024 * 1024 + 1))

    expect(isDockerfileCustomized()).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not compare the config-dir Docker files with the bundle'))
  })

  it('reads bundled files that are themselves symlinks (package layouts that symlink files) and keeps their modes', () => {
    const store = path.join(root, 'store')
    fs.mkdirSync(store)
    fs.renameSync(path.join(bundleDir, 'docker', 'entrypoint.sh'), path.join(store, 'entrypoint.sh'))
    fs.chmodSync(path.join(store, 'entrypoint.sh'), 0o755)
    fs.symlinkSync(path.join(store, 'entrypoint.sh'), path.join(bundleDir, 'docker', 'entrypoint.sh'))
    const old = process.umask(0o077)
    try {
      syncDockerfileToConfigDir()
    } finally {
      process.umask(old)
    }

    const synced = path.join(configDir, 'docker', 'entrypoint.sh')
    expect(fs.lstatSync(synced).isFile()).toBe(true)
    expect(fs.readFileSync(synced, 'utf-8')).toBe('#!/bin/sh\n')
    if (process.platform !== 'win32') expect(fs.statSync(synced).mode & 0o777).toBe(0o755)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('a dest whose symlink target cannot be checked (other than missing) stops the sync with a warning', () => {
    syncDockerfileToConfigDir()
    const dest = path.join(configDir, 'Dockerfile')
    fs.rmSync(dest)
    fs.symlinkSync(path.join(root, 'loop'), dest)
    fs.symlinkSync(dest, path.join(root, 'loop')) // ELOOP on stat

    syncDockerfileToConfigDir()

    expect(logger.warn).toHaveBeenCalledWith('docker.dockerfileSyncFailed')
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true)
  })

  it('still syncs regular files exactly as before', () => {
    syncDockerfileToConfigDir()

    expect(fs.readFileSync(path.join(configDir, 'Dockerfile'), 'utf-8')).toBe('FROM ubuntu\n')
    expect(fs.readFileSync(path.join(configDir, 'docker', 'entrypoint.sh'), 'utf-8')).toBe('#!/bin/sh\n')
    expect(fs.readFileSync(path.join(configDir, 'docker', 'tmux.conf'), 'utf-8')).toBe('set -g mouse on\n')
    expect(fs.existsSync(path.join(configDir, '.dockerfile-sync-hash'))).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('counts a dangling symlinked Dockerfile as present (unmanaged), so it is not overwritten blindly', () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(configDir, 'Dockerfile'))
    expect(hasUnmanagedConfigDockerfile()).toBe(true)
  })
})
