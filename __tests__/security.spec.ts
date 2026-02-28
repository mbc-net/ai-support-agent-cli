import * as os from 'os'
import * as path from 'path'

import { ERR_NO_FILE_PATH_SPECIFIED } from '../src/constants'
import {
  ALLOWED_SIGNALS,
  BLOCKED_COMMAND_PATTERNS,
  BLOCKED_PATH_PREFIXES,
  buildSafeEnv,
  getSensitiveHomePaths,
  resolveAndValidatePath,
  SAFE_ENV_KEYS,
  validateCommand,
  validateFilePath,
} from '../src/security'

describe('security', () => {
  describe('validateCommand', () => {
    it('should return null for safe commands', () => {
      expect(validateCommand('echo hello')).toBeNull()
      expect(validateCommand('ls -la')).toBeNull()
      expect(validateCommand('cat /tmp/file.txt')).toBeNull()
    })

    it('should block rm -rf / patterns', () => {
      expect(validateCommand('rm -rf /')).not.toBeNull()
    })

    it('should block mkfs commands', () => {
      expect(validateCommand('mkfs.ext4 /dev/sda1')).not.toBeNull()
    })

    it('should block dd to device commands', () => {
      expect(validateCommand('dd if=/dev/zero of=/dev/sda')).not.toBeNull()
    })

    it('should block fork bomb patterns', () => {
      expect(validateCommand(':(){ :|:& };:')).not.toBeNull()
      expect(validateCommand(':() { :|:& };:')).not.toBeNull()
    })

    it('should allow safe rm commands', () => {
      expect(validateCommand('rm /tmp/test.txt')).toBeNull()
      expect(validateCommand('rm -rf /tmp/mydir')).toBeNull()
    })
  })

  describe('validateFilePath', () => {
    it('should return null for safe paths', async () => {
      const tmpFile = path.join(os.tmpdir(), 'test-security.txt')
      expect(await validateFilePath(tmpFile)).toBeNull()
    })

    it('should block /etc/ paths', async () => {
      const result = await validateFilePath('/etc/passwd')
      expect(result).toContain('Access denied')
    })

    it('should block /proc/ paths', async () => {
      const result = await validateFilePath('/proc/cpuinfo')
      expect(result).toContain('Access denied')
    })

    it('should block ~/.ssh/ paths', async () => {
      const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa')
      const result = await validateFilePath(sshPath)
      expect(result).toContain('Access denied')
    })

    it('should block ~/.aws/ paths', async () => {
      const awsPath = path.join(os.homedir(), '.aws', 'credentials')
      const result = await validateFilePath(awsPath)
      expect(result).toContain('Access denied')
    })
  })

  describe('resolveAndValidatePath', () => {
    it('should return error when no path specified', async () => {
      const result = await resolveAndValidatePath({})
      expect(typeof result).not.toBe('string')
      if (typeof result !== 'string') {
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
        }
      }
    })

    it('should return the resolved path for valid paths', async () => {
      const tmpFile = path.join(os.tmpdir(), 'test-resolve.txt')
      const result = await resolveAndValidatePath({ path: tmpFile })
      expect(typeof result).toBe('string')
    })

    it('should return error for blocked paths', async () => {
      const result = await resolveAndValidatePath({ path: '/etc/shadow' })
      expect(typeof result).not.toBe('string')
      if (typeof result !== 'string') {
        expect(result.success).toBe(false)
        if (!result.success) {
          expect(result.error).toContain('Access denied')
        }
      }
    })

    it('should use defaultPath when no path in payload', async () => {
      const result = await resolveAndValidatePath({}, os.tmpdir())
      expect(typeof result).toBe('string')
    })
  })

  describe('buildSafeEnv', () => {
    it('should only include whitelisted env keys', () => {
      const originalToken = process.env.AI_SUPPORT_AGENT_TOKEN
      process.env.AI_SUPPORT_AGENT_TOKEN = 'secret'

      try {
        const env = buildSafeEnv()
        expect(env.AI_SUPPORT_AGENT_TOKEN).toBeUndefined()
        expect(env.PATH).toBeDefined()
      } finally {
        if (originalToken === undefined) delete process.env.AI_SUPPORT_AGENT_TOKEN
        else process.env.AI_SUPPORT_AGENT_TOKEN = originalToken
      }
    })

    it('should include PATH from process.env', () => {
      const env = buildSafeEnv()
      expect(env.PATH).toBe(process.env.PATH)
    })
  })

  describe('constants', () => {
    it('BLOCKED_COMMAND_PATTERNS should be an array of RegExp', () => {
      expect(Array.isArray(BLOCKED_COMMAND_PATTERNS)).toBe(true)
      for (const pattern of BLOCKED_COMMAND_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp)
      }
    })

    it('BLOCKED_PATH_PREFIXES should include /etc/ and /proc/', () => {
      expect(BLOCKED_PATH_PREFIXES).toContain('/etc/')
      expect(BLOCKED_PATH_PREFIXES).toContain('/proc/')
    })

    it('ALLOWED_SIGNALS should include SIGTERM and exclude SIGKILL', () => {
      expect(ALLOWED_SIGNALS.has('SIGTERM')).toBe(true)
      expect(ALLOWED_SIGNALS.has('SIGKILL')).toBe(false)
    })

    it('SAFE_ENV_KEYS should include PATH and HOME', () => {
      expect(SAFE_ENV_KEYS).toContain('PATH')
      expect(SAFE_ENV_KEYS).toContain('HOME')
    })
  })

  describe('getSensitiveHomePaths', () => {
    it('should return paths under home directory', () => {
      const paths = getSensitiveHomePaths()
      const home = os.homedir()
      for (const p of paths) {
        expect(p.startsWith(home)).toBe(true)
        expect(p.endsWith('/')).toBe(true)
      }
    })

    it('should include .ssh, .aws, .gnupg paths', () => {
      const paths = getSensitiveHomePaths()
      const home = os.homedir()
      expect(paths).toContain(path.join(home, '.ssh') + '/')
      expect(paths).toContain(path.join(home, '.aws') + '/')
      expect(paths).toContain(path.join(home, '.gnupg') + '/')
    })
  })
})
