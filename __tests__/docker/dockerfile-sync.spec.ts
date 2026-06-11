/**
 * Dedicated tests for src/docker/dockerfile-sync.ts
 *
 * syncDockerfileToConfigDir treats the Dockerfile + entrypoint.sh pair as one
 * sync unit and uses a hash file (.dockerfile-sync-hash) holding a combined
 * SHA-256 over the pair to decide whether to overwrite the config-dir copies:
 *
 *   1. Hash file absent (first-run / existing user) or any config-side file
 *      of the pair missing → overwrite the pair unconditionally + write hash
 *   2. Hash file present, saved hash === current config hash (not customised)
 *      a. Bundled pair differs (Dockerfile or entrypoint.sh) → overwrite + update hash
 *      b. Bundled pair is identical → no-op
 *   3. Hash file present, saved hash !== current config hash (customised
 *      Dockerfile or entrypoint.sh) → warn only, do NOT overwrite
 *
 * entrypoint.sh may be absent from the bundle, in which case the Dockerfile
 * alone forms the sync unit.
 */

jest.mock('fs')
jest.mock('../../src/logger')
jest.mock('../../src/i18n', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      let msg = key
      for (const [k, v] of Object.entries(params)) {
        msg = msg.replace(`{{${k}}}`, String(v))
      }
      return msg
    }
    return key
  },
  initI18n: jest.fn(),
}))

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => '/mock/config-dir'),
}))

jest.mock('../../src/docker/dockerfile-path', () => ({
  getDockerfilePath: jest.fn(() => '/mock/docker/Dockerfile'),
  getDockerContextDir: jest.fn(() => '/mock'),
}))

jest.mock('../../src/utils', () => ({
  getErrorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  // The real atomicWriteFile writes the content to a temp file and renames it
  // onto the target path. These tests only care that the hash content lands at
  // the target path, so forward to the mocked fs.writeFileSync.
  atomicWriteFile: jest.fn((filePath: string, content: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(filePath, content, 'utf-8')
  }),
}))

import * as crypto from 'crypto'
import * as fs from 'fs'
import { syncDockerfileToConfigDir } from '../../src/docker/dockerfile-sync'
import { getDockerfilePath } from '../../src/docker/dockerfile-path'
import { logger } from '../../src/logger'

const mockedFs = jest.mocked(fs)
const mockedGetDockerfilePath = jest.mocked(getDockerfilePath)

/** Compute the combined SHA-256 hex digest (mirrors the production helper). */
function combinedSha256(...contents: string[]): string {
  const hash = crypto.createHash('sha256')
  for (const content of contents) {
    const buf = Buffer.from(content)
    // Length prefix mirrors the production domain separation between files
    hash.update(`${buf.length}\n`)
    hash.update(buf)
  }
  return hash.digest('hex')
}

const HASH_FILE = '/mock/config-dir/.dockerfile-sync-hash'
const DEST_DOCKERFILE = '/mock/config-dir/Dockerfile'
const SRC_DOCKERFILE = '/mock/docker/Dockerfile'
const SRC_ENTRYPOINT = '/mock/docker/entrypoint.sh'
const DEST_ENTRYPOINT = '/mock/config-dir/docker/entrypoint.sh'

const BUNDLED_CONTENT = 'FROM node:24-slim\n# bundled v2'
const OLD_BUNDLED_CONTENT = 'FROM node:24-slim\n# bundled v1'
const BUNDLED_HASH = combinedSha256(BUNDLED_CONTENT)
const OLD_BUNDLED_HASH = combinedSha256(OLD_BUNDLED_CONTENT)
const CUSTOM_CONTENT = 'FROM node:24-slim\n# my custom stuff'

const ENTRYPOINT_CONTENT = '#!/bin/sh\n# entrypoint v2'
const OLD_ENTRYPOINT_CONTENT = '#!/bin/sh\n# entrypoint v1'
const CUSTOM_ENTRYPOINT_CONTENT = '#!/bin/sh\n# my custom entrypoint'

describe('dockerfile-sync', () => {
  describe('syncDockerfileToConfigDir', () => {
    beforeEach(() => {
      jest.clearAllMocks()
      mockedFs.mkdirSync.mockReturnValue(undefined)
      mockedFs.copyFileSync.mockReturnValue(undefined)
      mockedFs.writeFileSync.mockReturnValue(undefined)
      mockedFs.rmSync.mockReturnValue(undefined)
    })

    // -------------------------------------------------------------------------
    // Case 1: Hash file absent — overwrite unconditionally
    // -------------------------------------------------------------------------
    describe('hash file absent (first-run / existing user)', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should copy the bundled Dockerfile to config dir', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
      })

      it('should write the bundled hash to the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
      })

      it('should log dockerfileSynced info', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileSynced'))
      })

      it('should copy entrypoint.sh and include it in the hash when it exists in the bundle', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === SRC_ENTRYPOINT
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })

        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_ENTRYPOINT, DEST_ENTRYPOINT)
        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
          HASH_FILE,
          combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT),
          'utf-8',
        )
      })

      it('should sync the Dockerfile alone (no throw) when the bundle has no entrypoint.sh', () => {
        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(mockedFs.copyFileSync).toHaveBeenCalledTimes(1)
        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('hash file absent, dest Dockerfile already exists', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === DEST_DOCKERFILE) return Buffer.from(OLD_BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should overwrite dest Dockerfile even though it already exists', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
      })

      it('should write the bundled hash to the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
      })
    })

    describe('hash file present but dest Dockerfile missing (deleted by user)', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return BUNDLED_HASH
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should copy the bundled Dockerfile to restore the missing file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
      })

      it('should write the bundled hash to the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
      })

      it('should log dockerfileSynced info', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileSynced'))
      })

      it('should NOT log a warning', () => {
        syncDockerfileToConfigDir()

        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('config entrypoint.sh missing (Dockerfile and hash file present)', () => {
      beforeEach(() => {
        // Bundle has the pair, config dir lost entrypoint.sh — dest missing
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const s = String(p)
          return s === HASH_FILE || s === DEST_DOCKERFILE || s === SRC_ENTRYPOINT
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT)
          if (p === DEST_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should restore the whole pair (Dockerfile + entrypoint.sh)', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_ENTRYPOINT, DEST_ENTRYPOINT)
      })

      it('should write the bundled combined hash and log dockerfileSynced', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
          HASH_FILE,
          combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT),
          'utf-8',
        )
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileSynced'))
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    // -------------------------------------------------------------------------
    // Case 2a: Hash file present, not customised, bundled pair differs
    //          → overwrite + update hash
    // -------------------------------------------------------------------------
    describe('not customised — bundled Dockerfile is newer (hashes differ)', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return OLD_BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(OLD_BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should overwrite the config Dockerfile with the new bundled version', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
      })

      it('should update the hash file with the new bundled hash', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
      })

      it('should log dockerfileUpdated info', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileUpdated'))
      })

      it('should NOT log a warning', () => {
        syncDockerfileToConfigDir()

        expect(logger.warn).not.toHaveBeenCalled()
      })

      it('should also re-copy entrypoint.sh when the pair exists', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const s = String(p)
          return s === HASH_FILE || s === DEST_DOCKERFILE || s === SRC_ENTRYPOINT || s === DEST_ENTRYPOINT
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return combinedSha256(OLD_BUNDLED_CONTENT, ENTRYPOINT_CONTENT)
          if (p === DEST_DOCKERFILE) return Buffer.from(OLD_BUNDLED_CONTENT)
          if (p === DEST_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })

        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_ENTRYPOINT, DEST_ENTRYPOINT)
        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
          HASH_FILE,
          combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT),
          'utf-8',
        )
      })
    })

    describe('not customised — only the bundled entrypoint.sh changed', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const s = String(p)
          return s === HASH_FILE || s === DEST_DOCKERFILE || s === SRC_ENTRYPOINT || s === DEST_ENTRYPOINT
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return combinedSha256(BUNDLED_CONTENT, OLD_ENTRYPOINT_CONTENT)
          if (p === DEST_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === DEST_ENTRYPOINT) return Buffer.from(OLD_ENTRYPOINT_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should re-copy the whole pair even though the Dockerfile is identical', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_ENTRYPOINT, DEST_ENTRYPOINT)
      })

      it('should update the hash file with the new combined hash', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
          HASH_FILE,
          combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT),
          'utf-8',
        )
      })

      it('should log dockerfileUpdated info and NOT warn', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('docker.dockerfileUpdated'))
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    describe('hash file with trailing newline (still treated as not customised)', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          // saved hash matches the config Dockerfile but has a trailing newline
          if (p === HASH_FILE) return `${OLD_BUNDLED_HASH}\n`
          if (p === DEST_DOCKERFILE) return Buffer.from(OLD_BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should overwrite with the newer bundled version (not misjudged as customised)', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).toHaveBeenCalledWith(SRC_DOCKERFILE, DEST_DOCKERFILE)
        expect(mockedFs.writeFileSync).toHaveBeenCalledWith(HASH_FILE, BUNDLED_HASH, 'utf-8')
      })

      it('should NOT log the dockerfileCustomized warning', () => {
        syncDockerfileToConfigDir()

        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    // -------------------------------------------------------------------------
    // Case 2b: Hash file present, not customised, bundled pair is same
    //          → no-op
    // -------------------------------------------------------------------------
    describe('not customised — bundled pair is identical (no-op)', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should NOT copy the Dockerfile', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
      })

      it('should NOT update the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      })

      it('should NOT log info or warn', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
      })
    })

    // -------------------------------------------------------------------------
    // Case 3: Hash file present, customised (saved hash ≠ current config hash)
    //         → warn only, do NOT overwrite
    // -------------------------------------------------------------------------
    describe('customised Dockerfile — warn only, no overwrite', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return OLD_BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(CUSTOM_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should NOT copy the Dockerfile', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
      })

      it('should NOT update the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      })

      it('should log dockerfileCustomized warning', () => {
        syncDockerfileToConfigDir()

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileCustomized'),
        )
      })

      it('should NOT log info', () => {
        syncDockerfileToConfigDir()

        expect(logger.info).not.toHaveBeenCalled()
      })

      it('should NOT read the bundled Dockerfile (no bundled hash needed on this path)', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.readFileSync).not.toHaveBeenCalledWith(SRC_DOCKERFILE)
      })
    })

    describe('customised entrypoint.sh only — warn only, no overwrite', () => {
      beforeEach(() => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          const s = String(p)
          return s === HASH_FILE || s === DEST_DOCKERFILE || s === SRC_ENTRYPOINT || s === DEST_ENTRYPOINT
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return combinedSha256(BUNDLED_CONTENT, ENTRYPOINT_CONTENT)
          if (p === DEST_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === DEST_ENTRYPOINT) return Buffer.from(CUSTOM_ENTRYPOINT_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_ENTRYPOINT) return Buffer.from(ENTRYPOINT_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
      })

      it('should NOT overwrite the Dockerfile or entrypoint.sh', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.copyFileSync).not.toHaveBeenCalled()
      })

      it('should NOT update the hash file', () => {
        syncDockerfileToConfigDir()

        expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      })

      it('should log dockerfileCustomized warning only', () => {
        syncDockerfileToConfigDir()

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileCustomized'),
        )
        expect(logger.info).not.toHaveBeenCalled()
      })
    })

    // -------------------------------------------------------------------------
    // Self-heal: hash file is removed BEFORE copying so a partial failure
    // (copy or hash write) leaves no stale hash that would block future syncs
    // -------------------------------------------------------------------------
    describe('self-heal — hash file removal precedes copying', () => {
      it('should remove the hash file before copyFileSync in the unconditional branch, even when the copy throws', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
        mockedFs.copyFileSync.mockImplementation(() => {
          throw new Error('disk failure mid-copy')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(mockedFs.rmSync).toHaveBeenCalledWith(HASH_FILE, { force: true })
        expect(mockedFs.rmSync.mock.invocationCallOrder[0]).toBeLessThan(
          mockedFs.copyFileSync.mock.invocationCallOrder[0],
        )
        // No new hash was written — next run sees no hash file and re-syncs
        expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      })

      it('should remove the hash file before copyFileSync in the update branch, even when the copy throws', () => {
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return OLD_BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(OLD_BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
        mockedFs.copyFileSync.mockImplementation(() => {
          throw new Error('disk failure mid-copy')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()

        expect(mockedFs.rmSync).toHaveBeenCalledWith(HASH_FILE, { force: true })
        expect(mockedFs.rmSync.mock.invocationCallOrder[0]).toBeLessThan(
          mockedFs.copyFileSync.mock.invocationCallOrder[0],
        )
        expect(mockedFs.writeFileSync).not.toHaveBeenCalled()
      })

      it('should NOT remove the hash file on the customised path or the no-op path', () => {
        // Customised: saved hash differs from the current config hash
        mockedFs.existsSync.mockImplementation((p: unknown) => {
          return String(p) === HASH_FILE || String(p) === DEST_DOCKERFILE
        })
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return OLD_BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(CUSTOM_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
        syncDockerfileToConfigDir()
        expect(mockedFs.rmSync).not.toHaveBeenCalled()

        // No-op: saved hash, config pair, and bundled pair all match
        mockedFs.readFileSync.mockImplementation((p: unknown): string | Buffer => {
          if (p === HASH_FILE) return BUNDLED_HASH
          if (p === DEST_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected readFileSync: ${String(p)}`)
        })
        syncDockerfileToConfigDir()
        expect(mockedFs.rmSync).not.toHaveBeenCalled()
      })
    })

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------
    describe('error handling', () => {
      it('should log warn and not throw when getDockerfilePath throws (bundled Dockerfile missing)', () => {
        mockedGetDockerfilePath.mockImplementationOnce(() => {
          throw new Error('Dockerfile not found in any expected location')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should log warn and not throw when copyFileSync throws', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected: ${String(p)}`)
        })
        mockedFs.copyFileSync.mockImplementation(() => {
          throw new Error('permission denied')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should log warn and not throw when mkdirSync throws', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected: ${String(p)}`)
        })
        mockedFs.mkdirSync.mockImplementation(() => {
          throw new Error('EACCES: permission denied')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should log warn and not throw when writeFileSync (hash write) throws', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected: ${String(p)}`)
        })
        mockedFs.writeFileSync.mockImplementation(() => {
          throw new Error('no space left on device')
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })

      it('should log warn and not throw when copyFileSync throws a non-Error value', () => {
        mockedFs.existsSync.mockReturnValue(false)
        mockedFs.readFileSync.mockImplementation((p: unknown): Buffer => {
          if (p === SRC_DOCKERFILE) return Buffer.from(BUNDLED_CONTENT)
          throw new Error(`unexpected: ${String(p)}`)
        })
        mockedFs.copyFileSync.mockImplementation(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'disk is full'
        })

        expect(() => syncDockerfileToConfigDir()).not.toThrow()
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('docker.dockerfileSyncFailed'),
        )
      })
    })
  })
})
