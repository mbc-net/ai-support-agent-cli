import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DOCKER_ASSET_MAX_BYTES,
  MARKER_FILE_MAX_BYTES,
  UnsafeFileError,
  assertRealDirectory,
  copyBundledFileNoFollow,
  copyRegularFileNoFollow,
  ensureRealDirectoryChain,
  isRegularFileNoFollow,
  pathExistsNoFollow,
  readMarkerFile,
  readRegularFileNoFollow,
  snapshotDockerfile,
  snapshotRegularFile,
  writeFileNoFollow,
} from '../../src/utils/marker-file'
import { logger } from '../../src/logger'

jest.mock('../../src/logger')

// These tests use the real filesystem on purpose: the point of this module is
// how it treats symlinks, FIFOs and oversized files, which a mocked `fs`
// cannot show (design §7.7, §12.3 #13).
const SECRET = 'SECRET-TOKEN-VALUE'
const canMakeFifo = process.platform !== 'win32'

describe('marker-file', () => {
  let dir: string
  let secretPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-file-test-'))
    secretPath = path.join(dir, 'config.json')
    fs.writeFileSync(secretPath, SECRET)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('readMarkerFile', () => {
    it('returns the trimmed file contents', () => {
      const p = path.join(dir, 'marker')
      fs.writeFileSync(p, '  abc123\n')
      expect(readMarkerFile(p)).toBe('abc123')
    })

    it('returns an empty string (not undefined) for a whitespace-only file', () => {
      const p = path.join(dir, 'blank')
      fs.writeFileSync(p, '   \n')
      expect(readMarkerFile(p)).toBe('')
    })

    it('returns undefined when the file does not exist', () => {
      expect(readMarkerFile(path.join(dir, 'missing'))).toBeUndefined()
    })

    it('returns undefined when the path is a directory', () => {
      expect(readMarkerFile(dir)).toBeUndefined()
    })

    it('does not follow a symlink to another file', () => {
      const p = path.join(dir, 'docker-built-hash')
      fs.symlinkSync(secretPath, p)
      expect(readMarkerFile(p)).toBeUndefined()
    })

    it('returns undefined for a file larger than the marker limit', () => {
      const p = path.join(dir, 'big')
      fs.writeFileSync(p, 'a'.repeat(MARKER_FILE_MAX_BYTES + 1))
      expect(readMarkerFile(p)).toBeUndefined()
    })

    it('reads a file exactly at the marker limit', () => {
      const p = path.join(dir, 'edge')
      fs.writeFileSync(p, 'a'.repeat(MARKER_FILE_MAX_BYTES))
      expect(readMarkerFile(p)).toHaveLength(MARKER_FILE_MAX_BYTES)
    })

    ;(canMakeFifo ? it : it.skip)('returns undefined for a FIFO without blocking', () => {
      const p = path.join(dir, 'fifo')
      execFileSync('mkfifo', [p])
      expect(readMarkerFile(p)).toBeUndefined()
    })
  })

  describe('readRegularFileNoFollow', () => {
    it('returns the bytes of a regular file', () => {
      const p = path.join(dir, 'f')
      fs.writeFileSync(p, Buffer.from([1, 2, 3]))
      expect(readRegularFileNoFollow(p, 10)).toEqual(Buffer.from([1, 2, 3]))
    })

    it('returns undefined when the file does not exist', () => {
      expect(readRegularFileNoFollow(path.join(dir, 'missing'), 10)).toBeUndefined()
    })

    it('throws UnsafeFileError for a symlink, even a dangling one', () => {
      const link = path.join(dir, 'link')
      fs.symlinkSync(secretPath, link)
      expect(() => readRegularFileNoFollow(link, 1024)).toThrow(UnsafeFileError)
      const dangling = path.join(dir, 'dangling')
      fs.symlinkSync(path.join(dir, 'nowhere'), dangling)
      expect(() => readRegularFileNoFollow(dangling, 1024)).toThrow(UnsafeFileError)
    })

    it('throws UnsafeFileError for a directory', () => {
      expect(() => readRegularFileNoFollow(dir, 1024)).toThrow(UnsafeFileError)
    })

    it('throws UnsafeFileError when the file exceeds the limit', () => {
      const p = path.join(dir, 'big')
      fs.writeFileSync(p, 'abcdef')
      expect(() => readRegularFileNoFollow(p, 5)).toThrow(UnsafeFileError)
    })

    it('rethrows unexpected lstat errors', () => {
      // A path through a regular file component gives ENOTDIR, not ENOENT.
      expect(() => readRegularFileNoFollow(path.join(secretPath, 'x'), 10)).toThrow(/ENOTDIR/)
    })
  })

  describe('readRegularFileNoFollow: races between the checks and the read', () => {
    // Spied through require: the module under test calls fs.<fn> at run time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realFs = require('fs') as typeof import('fs')
    let p: string

    beforeEach(() => {
      p = path.join(dir, 'raced')
      fs.writeFileSync(p, 'abcdefghij')
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    function openFailsWith(code: string): void {
      jest.spyOn(realFs, 'openSync').mockImplementationOnce(() => {
        throw Object.assign(new Error(code), { code })
      })
    }

    it('returns undefined when the file vanishes before open', () => {
      openFailsWith('ENOENT')
      expect(readRegularFileNoFollow(p, 100)).toBeUndefined()
    })

    it('refuses when the file became a symlink before open (ELOOP from O_NOFOLLOW)', () => {
      openFailsWith('ELOOP')
      expect(() => readRegularFileNoFollow(p, 100)).toThrow(UnsafeFileError)
    })

    it('rethrows other open errors', () => {
      openFailsWith('EACCES')
      expect(() => readRegularFileNoFollow(p, 100)).toThrow('EACCES')
    })

    it('refuses, and closes the descriptor, when a different file was opened', () => {
      const real = realFs.fstatSync
      jest.spyOn(realFs, 'fstatSync').mockImplementationOnce((fd: number) => {
        const st = real(fd)
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 })
      })
      const close = jest.spyOn(realFs, 'closeSync')
      expect(() => readRegularFileNoFollow(p, 100)).toThrow(/changed while it was opened/)
      expect(close).toHaveBeenCalledTimes(1)
    })

    it('reads every byte of a file that grew (within the limit) after fstat', () => {
      const real = realFs.fstatSync
      jest.spyOn(realFs, 'fstatSync').mockImplementationOnce((fd: number) => {
        const st = real(fd)
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 2 })
      })
      expect(readRegularFileNoFollow(p, 100)?.toString()).toBe('abcdefghij')
    })

    it('refuses a file that grew past the limit after fstat', () => {
      const real = realFs.fstatSync
      jest.spyOn(realFs, 'fstatSync').mockImplementationOnce((fd: number) => {
        const st = real(fd)
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 1 })
      })
      expect(() => readRegularFileNoFollow(p, 5)).toThrow(/exceeds 5 bytes/)
    })

    it('readMarkerFile logs an I/O error instead of reporting the file as absent silently', () => {
      openFailsWith('EACCES')
      expect(readMarkerFile(p)).toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to read .*raced: EACCES/))
    })

    it('copyRegularFileNoFollow takes the mode from the descriptor it read, not from a later lstat', () => {
      const real = realFs.fstatSync
      fs.chmodSync(p, 0o755)
      jest.spyOn(realFs, 'fstatSync').mockImplementationOnce((fd: number) => {
        const st = real(fd)
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: (st.mode & ~0o777) | 0o640 })
      })
      const lstat = jest.spyOn(realFs, 'lstatSync')
      const dst = path.join(dir, 'copied')
      expect(copyRegularFileNoFollow(p, dst, 100)).toBe(true)
      expect(lstat.mock.calls.filter((c) => c[0] === p)).toHaveLength(1)
      if (process.platform !== 'win32') {
        expect(fs.statSync(dst).mode & 0o777).toBe(0o640)
      }
    })

    it('refuses a file that grew past the limit after lstat', () => {
      const st = realFs.lstatSync(p)
      jest.spyOn(realFs, 'lstatSync').mockImplementationOnce(
        () => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 3 }),
      )
      expect(() => readRegularFileNoFollow(p, 5)).toThrow(/exceeds 5 bytes/)
    })
  })

  describe('isRegularFileNoFollow / pathExistsNoFollow', () => {
    it('distinguishes regular files, symlinks, directories and missing paths', () => {
      const link = path.join(dir, 'link')
      fs.symlinkSync(secretPath, link)
      expect(isRegularFileNoFollow(secretPath)).toBe(true)
      expect(isRegularFileNoFollow(link)).toBe(false)
      expect(isRegularFileNoFollow(dir)).toBe(false)
      expect(isRegularFileNoFollow(path.join(dir, 'missing'))).toBe(false)

      expect(pathExistsNoFollow(link)).toBe(true)
      expect(pathExistsNoFollow(path.join(dir, 'missing'))).toBe(false)
      const dangling = path.join(dir, 'dangling')
      fs.symlinkSync(path.join(dir, 'nowhere'), dangling)
      // existsSync would say false here; the link itself is still present.
      expect(pathExistsNoFollow(dangling)).toBe(true)
    })

    it('rethrows unexpected lstat errors', () => {
      expect(() => isRegularFileNoFollow(path.join(secretPath, 'x'))).toThrow(/ENOTDIR/)
      expect(() => pathExistsNoFollow(path.join(secretPath, 'x'))).toThrow(/ENOTDIR/)
    })
  })

  describe('assertRealDirectory', () => {
    it('accepts a directory and refuses a symlink to one, a file, or a missing path', () => {
      const link = path.join(dir, 'linkdir')
      fs.symlinkSync(os.tmpdir(), link)
      expect(() => assertRealDirectory(dir)).not.toThrow()
      expect(() => assertRealDirectory(link)).toThrow(UnsafeFileError)
      expect(() => assertRealDirectory(secretPath)).toThrow(UnsafeFileError)
      expect(() => assertRealDirectory(path.join(dir, 'missing'))).toThrow(UnsafeFileError)
    })
  })

  describe('copyRegularFileNoFollow', () => {
    it('copies a regular file and keeps the source permission bits', () => {
      const src = path.join(dir, 'src.sh')
      const dst = path.join(dir, 'dst.sh')
      fs.writeFileSync(src, 'echo hi')
      fs.chmodSync(src, 0o755)
      expect(copyRegularFileNoFollow(src, dst, DOCKER_ASSET_MAX_BYTES)).toBe(true)
      expect(fs.readFileSync(dst, 'utf-8')).toBe('echo hi')
      if (process.platform !== 'win32') {
        expect(fs.statSync(dst).mode & 0o777).toBe(0o755)
      }
    })

    it('returns false and writes nothing when the source does not exist', () => {
      const dst = path.join(dir, 'dst')
      expect(copyRegularFileNoFollow(path.join(dir, 'missing'), dst, 10)).toBe(false)
      expect(fs.existsSync(dst)).toBe(false)
    })

    it('replaces a symlinked destination instead of writing through it', () => {
      const src = path.join(dir, 'docker-customization-hash')
      const dst = path.join(dir, 'docker-built-hash')
      fs.writeFileSync(src, 'hash-1')
      fs.symlinkSync(secretPath, dst)
      expect(copyRegularFileNoFollow(src, dst, MARKER_FILE_MAX_BYTES)).toBe(true)
      expect(fs.lstatSync(dst).isFile()).toBe(true)
      expect(fs.readFileSync(dst, 'utf-8')).toBe('hash-1')
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    })

    it('refuses a symlinked source and leaves the destination untouched', () => {
      const src = path.join(dir, 'docker-customization-hash')
      const dst = path.join(dir, 'docker-built-hash')
      fs.symlinkSync(secretPath, src)
      fs.writeFileSync(dst, 'old')
      expect(() => copyRegularFileNoFollow(src, dst, MARKER_FILE_MAX_BYTES)).toThrow(UnsafeFileError)
      expect(fs.readFileSync(dst, 'utf-8')).toBe('old')
    })
  })

  describe('snapshotRegularFile', () => {
    it('copies the file into a private directory and removes it on cleanup', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const snap = snapshotRegularFile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))
      expect(snap).toBeDefined()
      expect(snap!.path).not.toBe(src)
      expect(path.basename(snap!.path)).toBe('Dockerfile')
      expect(fs.readFileSync(snap!.path, 'utf-8')).toBe('FROM scratch\n')
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.dirname(snap!.path)).mode & 0o777).toBe(0o700)
      }
      snap!.cleanup()
      expect(fs.existsSync(path.dirname(snap!.path))).toBe(false)
      // A second cleanup is harmless.
      expect(() => snap!.cleanup()).not.toThrow()
    })

    it('returns undefined when the file does not exist', () => {
      expect(snapshotRegularFile(path.join(dir, 'missing'), 10, path.join(dir, 'snaps'))).toBeUndefined()
    })

    it('removes the private directory when writing the copy fails', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require('fs') as typeof import('fs')
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const write = jest.spyOn(realFs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      const rm = jest.spyOn(realFs, 'rmSync')
      try {
        expect(() => snapshotRegularFile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))).toThrow('disk full')
        const removed = String(rm.mock.calls[0][0])
        expect(path.basename(removed)).toMatch(/^snapshot-/)
        expect(fs.existsSync(removed)).toBe(false)
      } finally {
        write.mockRestore()
        rm.mockRestore()
      }
    })

    it('logs, rather than throws, when the snapshot directory cannot be removed', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require('fs') as typeof import('fs')
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const snap = snapshotRegularFile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))!
      const rm = jest.spyOn(realFs, 'rmSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      })
      try {
        expect(() => snap.cleanup()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to remove the snapshot directory .*: EBUSY/))
      } finally {
        rm.mockRestore()
        snap.cleanup()
      }
    })

    it('refuses a symlinked Dockerfile, so the secret never reaches the build', () => {
      const link = path.join(dir, 'Dockerfile')
      fs.symlinkSync(secretPath, link)
      expect(() => snapshotRegularFile(link, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))).toThrow(UnsafeFileError)
    })
  })

  describe('snapshotDockerfile', () => {
    it('takes <Dockerfile>.dockerignore along into the snapshot, as 0600', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      fs.writeFileSync(`${src}.dockerignore`, 'secrets/\n')
      fs.chmodSync(`${src}.dockerignore`, 0o644)
      const snap = snapshotDockerfile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))!
      try {
        expect(fs.readFileSync(`${snap.path}.dockerignore`, 'utf-8')).toBe('secrets/\n')
        if (process.platform !== 'win32') {
          expect(fs.statSync(`${snap.path}.dockerignore`).mode & 0o777).toBe(0o600)
        }
      } finally {
        snap.cleanup()
      }
    })

    it('snapshots just the Dockerfile when there is no ignore file', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const snap = snapshotDockerfile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))!
      try {
        expect(fs.readdirSync(path.dirname(snap.path))).toEqual(['Dockerfile'])
      } finally {
        snap.cleanup()
      }
    })

    it('returns undefined when the Dockerfile does not exist', () => {
      expect(snapshotDockerfile(path.join(dir, 'missing'), 10, path.join(dir, 'snaps'))).toBeUndefined()
    })

    it('refuses a symlinked ignore file and removes the snapshot', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      fs.symlinkSync(secretPath, `${src}.dockerignore`)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mkdtemp = jest.spyOn(require('fs') as typeof import('fs'), 'mkdtempSync')
      try {
        expect(() => snapshotDockerfile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps'))).toThrow(UnsafeFileError)
        const created = String(mkdtemp.mock.results[0].value)
        expect(fs.existsSync(created)).toBe(false)
      } finally {
        mkdtemp.mockRestore()
      }
    })
  })

  describe('writeFileNoFollow', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realFs = require('fs') as typeof import('fs')

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('replaces a symlinked destination instead of writing through it', () => {
      const dst = path.join(dir, 'docker-build-error')
      fs.symlinkSync(secretPath, dst)
      writeFileNoFollow(dst, 'failed')
      expect(fs.lstatSync(dst).isFile()).toBe(true)
      expect(fs.readFileSync(dst, 'utf-8')).toBe('failed')
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    })

    it('ignores anything planted at the old predictable temp name, and leaves no temp file behind', () => {
      const dst = path.join(dir, 'docker-built-hash')
      fs.mkdirSync(`${dst}.tmp`)
      fs.symlinkSync(secretPath, path.join(`${dst}.tmp`, 'link'))
      writeFileNoFollow(dst, 'hash-1')
      expect(fs.readFileSync(dst, 'utf-8')).toBe('hash-1')
      expect(fs.readdirSync(dir).sort()).toEqual(['config.json', 'docker-built-hash', 'docker-built-hash.tmp'])
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    })

    it('applies the mode exactly, whatever the umask', () => {
      if (process.platform === 'win32') return
      const dst = path.join(dir, 'entrypoint.sh')
      const old = process.umask(0o077)
      try {
        writeFileNoFollow(dst, '#!/bin/sh\n', 0o755)
      } finally {
        process.umask(old)
      }
      expect(fs.statSync(dst).mode & 0o777).toBe(0o755)
    })

    it('removes its own temp file and rethrows when the rename fails', () => {
      const dst = path.join(dir, 'occupied')
      fs.mkdirSync(dst)
      fs.writeFileSync(path.join(dst, 'x'), '')
      expect(() => writeFileNoFollow(dst, 'data')).toThrow()
      expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    })

    it('removes its own temp file and rethrows when writing fails', () => {
      jest.spyOn(realFs, 'fchmodSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      })
      const dst = path.join(dir, 'out')
      expect(() => writeFileNoFollow(dst, 'data')).toThrow('EIO')
      expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
      expect(fs.existsSync(dst)).toBe(false)
    })
  })

  describe('copyBundledFileNoFollow', () => {
    it('reads a symlinked bundled source normally (package layouts that symlink files) and keeps its mode', () => {
      const real = path.join(dir, 'store-entrypoint.sh')
      fs.writeFileSync(real, '#!/bin/sh\n')
      fs.chmodSync(real, 0o755)
      const bundled = path.join(dir, 'entrypoint.sh')
      fs.symlinkSync(real, bundled)
      const dst = path.join(dir, 'copy.sh')
      copyBundledFileNoFollow(bundled, dst)
      expect(fs.readFileSync(dst, 'utf-8')).toBe('#!/bin/sh\n')
      if (process.platform !== 'win32') {
        expect(fs.statSync(dst).mode & 0o777).toBe(0o755)
      }
    })

    it('does not write through a symlinked destination', () => {
      const src = path.join(dir, 'tmux.conf')
      fs.writeFileSync(src, 'set -g mouse on\n')
      const dst = path.join(dir, 'dst.conf')
      fs.symlinkSync(secretPath, dst)
      copyBundledFileNoFollow(src, dst)
      expect(fs.lstatSync(dst).isFile()).toBe(true)
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe(SECRET)
    })
  })

  describe('readMarkerFile: repeated refusals', () => {
    it('logs a refusal once per path until the reason changes or a read succeeds', () => {
      const marker = path.join(dir, 'registered-agent-id')
      fs.symlinkSync(secretPath, marker)
      const warn = logger.warn as jest.Mock
      warn.mockClear()
      readMarkerFile(marker)
      readMarkerFile(marker)
      readMarkerFile(marker)
      expect(warn).toHaveBeenCalledTimes(1)

      fs.rmSync(marker)
      fs.writeFileSync(marker, 'agent-1')
      expect(readMarkerFile(marker)).toBe('agent-1')
      fs.rmSync(marker)
      fs.symlinkSync(secretPath, marker)
      readMarkerFile(marker)
      expect(warn).toHaveBeenCalledTimes(2)
    })
  })

  describe('ensureRealDirectoryChain', () => {
    it('creates missing levels as 0700 real directories', () => {
      const target = path.join(dir, 'projects', 't', 'P', '.ai-support-agent')
      ensureRealDirectoryChain(dir, target)
      expect(fs.lstatSync(target).isDirectory()).toBe(true)
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(dir, 'projects')).mode & 0o777).toBe(0o700)
      }
    })

    it('accepts an existing chain of real directories', () => {
      const target = path.join(dir, 'a', 'b')
      fs.mkdirSync(target, { recursive: true })
      expect(() => ensureRealDirectoryChain(dir, target)).not.toThrow()
    })

    it('refuses the final directory swapped for a symlink, and creates nothing through it', () => {
      const elsewhere = path.join(dir, 'host-config')
      fs.mkdirSync(elsewhere)
      const parent = path.join(dir, 'projects', 't', 'P')
      fs.mkdirSync(parent, { recursive: true })
      fs.symlinkSync(elsewhere, path.join(parent, '.ai-support-agent'))
      expect(() => ensureRealDirectoryChain(dir, path.join(parent, '.ai-support-agent'))).toThrow(UnsafeFileError)
      expect(fs.readdirSync(elsewhere)).toEqual([])
    })

    it('refuses an intermediate symlink before creating anything below it', () => {
      const elsewhere = path.join(dir, 'elsewhere')
      fs.mkdirSync(elsewhere)
      fs.symlinkSync(elsewhere, path.join(dir, 'projects'))
      expect(() => ensureRealDirectoryChain(dir, path.join(dir, 'projects', 't', 'P'))).toThrow(UnsafeFileError)
      expect(fs.readdirSync(elsewhere)).toEqual([])
    })

    it('refuses a file in the chain', () => {
      fs.writeFileSync(path.join(dir, 'file'), '')
      expect(() => ensureRealDirectoryChain(dir, path.join(dir, 'file', 'x'))).toThrow(UnsafeFileError)
    })

    it.each([
      ['the root itself', (d: string) => d],
      ['outside the root', (d: string) => path.join(d, '..', 'other')],
    ])('refuses %s', (_label, target) => {
      expect(() => ensureRealDirectoryChain(dir, target(dir))).toThrow(/Not below/)
    })
  })

  describe('snapshotRegularFile: the parent directory', () => {
    it('creates the parent directory when it is missing', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const parent = path.join(dir, 'snaps-new')
      const snap = snapshotRegularFile(src, DOCKER_ASSET_MAX_BYTES, parent)!
      try {
        expect(path.dirname(path.dirname(snap.path))).toBe(parent)
      } finally {
        snap.cleanup()
      }
    })

    it('refuses a parent directory that is a symlink', () => {
      const src = path.join(dir, 'Dockerfile')
      fs.writeFileSync(src, 'FROM scratch\n')
      const elsewhere = path.join(dir, 'elsewhere')
      fs.mkdirSync(elsewhere)
      fs.symlinkSync(elsewhere, path.join(dir, 'snaps-link'))
      expect(() => snapshotRegularFile(src, DOCKER_ASSET_MAX_BYTES, path.join(dir, 'snaps-link'))).toThrow(UnsafeFileError)
      expect(fs.readdirSync(elsewhere)).toEqual([])
    })
  })
})
