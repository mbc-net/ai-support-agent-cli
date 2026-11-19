import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

/**
 * Safe reads and writes of the small marker/state files, the Dockerfile and
 * the hash files that the host supervisor and CLI handle in directories a
 * container can write to (design §7.7, review finding R7-H3).
 *
 * A container could replace one of these files with a symlink to the host's
 * `~/.ai-support-agent/config.json` (which holds every project's token) and
 * then ask for a rebuild. Following that link would copy the token into a
 * place the container can read, or feed it to `docker build`, whose output is
 * uploaded as the build log. So every function here:
 *   - checks with `lstat` that the final path component is a regular file,
 *   - opens it with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO cannot hang the
 *     supervisor), then `fstat`s the descriptor and requires the same inode,
 *   - reads at most a fixed number of bytes,
 *   - writes through a temporary file with an unpredictable name, created
 *     exclusively, then `rename`s it over the destination, which replaces a
 *     symlink there instead of writing through it (`writeFileNoFollow`).
 * Regular files keep behaving exactly as before.
 */

/** Upper bound for marker and hash files (design §7.7). */
export const MARKER_FILE_MAX_BYTES = 64 * 1024

/** Upper bound for the Dockerfile and the other build assets (design §7.7). */
export const DOCKER_ASSET_MAX_BYTES = 1024 * 1024

/** The path exists but is not a regular file, changed while it was opened, or is too large. */
export class UnsafeFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeFileError'
  }
}

/** `O_NOFOLLOW` and `O_NONBLOCK` are not defined on Windows; there the lstat/fstat checks remain. */
function openFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** `lstat`, with `undefined` for a missing path. Other errors propagate. */
function lstatOrUndefined(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * True when something (of any type, including a dangling symlink) exists at
 * `filePath`. Unlike `fs.existsSync`, never follows the final symlink.
 */
export function pathExistsNoFollow(filePath: string): boolean {
  return lstatOrUndefined(filePath) !== undefined
}

/**
 * Throw `UnsafeFileError` unless `dirPath` itself is a directory (a symlink to
 * a directory is refused). For the directory a file is about to be written
 * into, since the no-follow checks only cover the final path component.
 */
export function assertRealDirectory(dirPath: string): void {
  if (lstatOrUndefined(dirPath)?.isDirectory() !== true) {
    throw new UnsafeFileError(`Not a real directory: ${dirPath}`)
  }
}

/**
 * Make sure every directory from just below `root` down to `dir` is a real
 * directory, creating missing ones (0700) one level at a time. Throws
 * `UnsafeFileError` when one of them is a symlink or not a directory, or when
 * `dir` is not below `root`. `root` itself is the host user's choice.
 *
 * For a directory the host is about to read from, write into or bind-mount
 * while a container can write to its parent: the no-follow file helpers only
 * cover the final path component, and a recursive `mkdir` or `docker run -v`
 * would follow a directory swapped for a symlink.
 */
export function ensureRealDirectoryChain(root: string, dir: string): void {
  const relative = path.relative(root, dir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeFileError(`Not below ${root}: ${dir}`)
  }
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    if (!pathExistsNoFollow(current)) {
      try {
        fs.mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      }
    }
    assertRealDirectory(current)
  }
}

/** True only when `filePath` itself is a regular file (a symlink is not). */
export function isRegularFileNoFollow(filePath: string): boolean {
  return lstatOrUndefined(filePath)?.isFile() === true
}

/**
 * Read a regular file without following a symlink at `filePath`.
 *
 * Returns `undefined` when nothing exists at the path (also when it vanishes
 * between the checks). Throws `UnsafeFileError` for a symlink, directory,
 * FIFO, device or socket, for a file swapped between `lstat` and `open`, and
 * for a file larger than `maxBytes`. Other I/O errors propagate.
 */
export function readRegularFileNoFollow(filePath: string, maxBytes: number): Buffer | undefined {
  return readRegularFileWithModeNoFollow(filePath, maxBytes)?.content
}

/**
 * `readRegularFileNoFollow`, also returning the permission bits taken from the
 * `fstat` of the descriptor that was read (never from a second `lstat`, which
 * would see a symlink swapped in after the read).
 */
function readRegularFileWithModeNoFollow(
  filePath: string,
  maxBytes: number,
): { content: Buffer; mode: number } | undefined {
  const before = lstatOrUndefined(filePath)
  if (!before) return undefined
  if (!before.isFile()) throw new UnsafeFileError(`Refusing to read a non-regular file: ${filePath}`)
  if (before.size > maxBytes) throw new UnsafeFileError(`File exceeds ${maxBytes} bytes: ${filePath}`)

  let fd: number
  try {
    fd = fs.openSync(filePath, openFlags())
  } catch (error) {
    if (isNotFound(error)) return undefined
    // ELOOP: the path became a symlink after the lstat above.
    if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') {
      throw new UnsafeFileError(`Refusing to follow a symlink: ${filePath}`)
    }
    throw error
  }
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new UnsafeFileError(`File changed while it was opened: ${filePath}`)
    }
    // Sized from fstat (one spare byte to notice growth), grown only if the
    // file keeps growing, and never past maxBytes + 1: one byte past the
    // limit is enough to detect a file that grew over it.
    const limit = maxBytes + 1
    let buffer = Buffer.alloc(Math.min(opened.size + 1, limit))
    let length = 0
    for (;;) {
      if (length === buffer.length) {
        if (buffer.length === limit) break
        const grown = Buffer.alloc(Math.min(buffer.length * 2, limit))
        buffer.copy(grown, 0, 0, length)
        buffer = grown
      }
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null)
      if (read === 0) break
      length += read
    }
    if (length > maxBytes) throw new UnsafeFileError(`File exceeds ${maxBytes} bytes: ${filePath}`)
    return { content: buffer.subarray(0, length), mode: opened.mode & 0o777 }
  } finally {
    fs.closeSync(fd)
  }
}

/** The last logged read failure per marker path (see readMarkerFile). Bounded by the few marker paths. */
const lastMarkerReadFailure = new Map<string, string>()

/**
 * Read a small marker/state file (docker-built-hash, registered-agent-id, ...)
 * and return its content `trim()`med.
 *
 * Returns `undefined` when the file is missing, unreadable, or refused
 * (symlink, directory, FIFO, over `MARKER_FILE_MAX_BYTES`); a refusal is
 * logged. An empty file returns `''` (not `undefined`), so callers can still
 * tell "not read" from "empty".
 */
export function readMarkerFile(filePath: string): string | undefined {
  try {
    const content = readRegularFileNoFollow(filePath, MARKER_FILE_MAX_BYTES)?.toString('utf-8').trim()
    lastMarkerReadFailure.delete(filePath)
    return content
  } catch (error) {
    // A missing file is not an error (readRegularFileNoFollow returns
    // undefined for it). A refusal or an I/O error (EACCES, EIO, ...) is
    // logged, so "unreadable" never looks like "absent" to the operator.
    const message = error instanceof UnsafeFileError
      ? error.message
      : `Failed to read ${filePath}: ${getErrorMessage(error)}`
    // Logged once per path until the reason changes or a read succeeds: the
    // supervisor reads markers on every fs.watch event, and the container
    // controls how often those fire.
    if (lastMarkerReadFailure.get(filePath) !== message) {
      lastMarkerReadFailure.set(filePath, message)
      logger.warn(`[docker] ${message}`)
    }
    return undefined
  }
}

/**
 * Replace `filePath` with `content` without following a symlink there.
 *
 * The temporary file sits in the same directory under a random name and is
 * created exclusively (`wx`: never through an existing name or symlink), so a
 * container cannot plant anything at it in advance. `mode` is applied with
 * `fchmod`, so the umask cannot strip bits. `rename` then replaces whatever is
 * at `filePath` (a symlink included) without writing through it. On failure
 * only the temporary file this call created is removed.
 */
export function writeFileNoFollow(filePath: string, content: string | Buffer, mode = 0o600): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(8).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    try {
      fs.writeFileSync(fd, content)
      fs.fchmodSync(fd, mode)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filePath)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Copy `src` to `dst` without following a symlink at either end, keeping the
 * permission bits of `src` exactly. Returns `false` (and writes nothing) when
 * `src` does not exist. Throws `UnsafeFileError` when `src` is refused.
 */
export function copyRegularFileNoFollow(src: string, dst: string, maxBytes: number): boolean {
  const read = readRegularFileWithModeNoFollow(src, maxBytes)
  if (read === undefined) return false
  writeFileNoFollow(dst, read.content, read.mode)
  return true
}

/**
 * Copy a trusted source (a file inside the installed npm package, which no
 * container can write) to `dst` without following a symlink at `dst`. The
 * source is read normally, so package layouts that symlink individual files
 * (Nix, Bazel rules_js, ...) keep working; its permission bits are kept.
 */
export function copyBundledFileNoFollow(src: string, dst: string): void {
  writeFileNoFollow(dst, fs.readFileSync(src), fs.statSync(src).mode & 0o777)
}

/** A private copy of a file, made for a consumer that would follow symlinks. */
export interface FileSnapshot {
  path: string
  cleanup: () => void
}

/**
 * Copy `filePath` into a new private (0700) directory created inside
 * `parentDir` (which must be a real directory, and is created if missing),
 * under the same base name, after the same checks as `readRegularFileNoFollow`.
 *
 * Used to hand the project Dockerfile to `docker build`, which would follow a
 * symlink planted at the original path. Returns `undefined` when the file
 * does not exist; throws `UnsafeFileError` when it is refused.
 */
/** Name prefix of the directories made by snapshotRegularFile. */
export const SNAPSHOT_DIR_PREFIX = 'snapshot-'

export function snapshotRegularFile(filePath: string, maxBytes: number, parentDir: string): FileSnapshot | undefined {
  const content = readRegularFileNoFollow(filePath, maxBytes)
  if (content === undefined) return undefined
  if (!pathExistsNoFollow(parentDir)) {
    try {
      fs.mkdirSync(parentDir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
  }
  assertRealDirectory(parentDir)
  const dir = fs.mkdtempSync(path.join(parentDir, SNAPSHOT_DIR_PREFIX))
  // Best effort: a leftover private 0700 directory is harmless, and a throw
  // from a `finally` would hide the build result it follows.
  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      logger.warn(`[docker] Failed to remove the snapshot directory ${dir}: ${getErrorMessage(error)}`)
    }
  }
  try {
    fs.chmodSync(dir, 0o700)
    const snapshotPath = path.join(dir, path.basename(filePath))
    fs.writeFileSync(snapshotPath, content, { mode: 0o600, flag: 'wx' })
    return { path: snapshotPath, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

/**
 * `snapshotRegularFile` for a Dockerfile, taking its `<Dockerfile>.dockerignore`
 * along (BuildKit reads that file from beside the `-f` path, so a snapshot
 * without it would silently widen the build context). The ignore file gets the
 * same checks and limit; a refused one throws `UnsafeFileError` and removes the
 * snapshot. Both copies are 0600 regardless of the source modes.
 */
export function snapshotDockerfile(dockerfilePath: string, maxBytes: number, parentDir: string): FileSnapshot | undefined {
  const snapshot = snapshotRegularFile(dockerfilePath, maxBytes, parentDir)
  if (!snapshot) return undefined
  try {
    const ignore = readRegularFileNoFollow(`${dockerfilePath}.dockerignore`, maxBytes)
    if (ignore !== undefined) {
      fs.writeFileSync(`${snapshot.path}.dockerignore`, ignore, { mode: 0o600, flag: 'wx' })
    }
    return snapshot
  } catch (error) {
    snapshot.cleanup()
    throw error
  }
}
