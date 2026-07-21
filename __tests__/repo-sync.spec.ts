import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import { buildAuthEnv, buildCloneUrl, normalizePemKey, runGit, syncRepositories, syncRepositoryByCode } from '../src/repo-sync'
import type { ApiClient } from '../src/api-client'
import type { ProjectConfigResponse } from '../src/types'

jest.mock('child_process')
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    renameSync: jest.fn(),
    promises: {
      mkdir: jest.fn().mockResolvedValue(undefined),
    },
  }
})
jest.mock('../src/logger')

const FAKE_KNOWN_HOSTS_PATH = '/fake-config-dir/known-hosts/acme__github.com'
const mockResolveKnownHostsPath = jest.fn().mockReturnValue(FAKE_KNOWN_HOSTS_PATH)
jest.mock('../src/utils/known-hosts-store', () => ({
  GENERAL_KNOWN_HOSTS_ID: 'shared',
  resolveKnownHostsPath: (...args: unknown[]) => mockResolveKnownHostsPath(...args),
}))

const mockedFs = fs as jest.Mocked<typeof fs>

describe('repo-sync', () => {
  describe('normalizePemKey', () => {
    it('should add newlines to single-line PEM key', () => {
      const header = '-----BEGIN RSA PRIVATE KEY-----'
      const footer = '-----END RSA PRIVATE KEY-----'
      const body = 'A'.repeat(128) // 128 chars → 2 lines of 64
      const input = `${header}${body}${footer}`

      const result = normalizePemKey(input)

      expect(result).toContain(`${header}\n`)
      expect(result).toContain(`\n${footer}\n`)
      const lines = result.split('\n')
      // header, 64-char line, 64-char line, footer, trailing empty
      expect(lines[0]).toBe(header)
      expect(lines[1]).toHaveLength(64)
      expect(lines[2]).toHaveLength(64)
      expect(lines[3]).toBe(footer)
    })

    it('should preserve key that already has newlines', () => {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nABCD\nEFGH\n-----END RSA PRIVATE KEY-----\n'
      expect(normalizePemKey(key)).toBe(key)
    })

    it('should add trailing newline if missing', () => {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nABCD\n-----END RSA PRIVATE KEY-----'
      expect(normalizePemKey(key)).toBe(key + '\n')
    })

    it('should return non-PEM string unchanged', () => {
      const key = 'not-a-pem-key'
      expect(normalizePemKey(key)).toBe(key)
    })

    it('should handle OPENSSH PRIVATE KEY format', () => {
      const header = '-----BEGIN OPENSSH PRIVATE KEY-----'
      const footer = '-----END OPENSSH PRIVATE KEY-----'
      const body = 'B'.repeat(70) // 70 chars → 64 + 6
      const input = `${header}${body}${footer}`

      const result = normalizePemKey(input)
      const lines = result.split('\n')
      expect(lines[0]).toBe(header)
      expect(lines[1]).toHaveLength(64)
      expect(lines[2]).toHaveLength(6)
      expect(lines[3]).toBe(footer)
    })
  })

  describe('runGit', () => {
    beforeEach(() => {
      jest.clearAllMocks()
      ;(child_process.execFile as unknown as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const callback = args[args.length - 1]
          if (typeof callback === 'function') {
            callback(null, { stdout: '', stderr: '' })
          }
          return { on: jest.fn(), kill: jest.fn() }
        },
      )
    })

    it('should run git with merged env and timeout, omitting cwd when not provided', async () => {
      await runGit(['status'], { env: { FOO: 'bar' }, timeout: 1234 })

      const call = (child_process.execFile as unknown as jest.Mock).mock.calls[0]
      expect(call[0]).toBe('git')
      expect(call[1]).toEqual(['status'])
      const opts = call[2] as { env: Record<string, string>; timeout: number; cwd?: string }
      expect(opts.timeout).toBe(1234)
      expect(opts.env.FOO).toBe('bar')
      // process.env is merged in
      expect(opts.env.PATH).toBe(process.env.PATH)
      // cwd not provided -> not present
      expect(opts).not.toHaveProperty('cwd')
    })

    it('should pass cwd when provided', async () => {
      await runGit(['fetch'], { env: {}, timeout: 10, cwd: '/repo' })

      const call = (child_process.execFile as unknown as jest.Mock).mock.calls[0]
      const opts = call[2] as { cwd?: string }
      expect(opts.cwd).toBe('/repo')
    })

    it('should let env override process.env values', async () => {
      const originalPath = process.env.PATH
      await runGit(['log'], { env: { PATH: '/custom/path' }, timeout: 5 })

      const call = (child_process.execFile as unknown as jest.Mock).mock.calls[0]
      const opts = call[2] as { env: Record<string, string> }
      expect(opts.env.PATH).toBe('/custom/path')
      // process.env not mutated
      expect(process.env.PATH).toBe(originalPath)
    })
  })

  describe('buildCloneUrl', () => {
    it('should embed token in HTTPS URL', () => {
      const result = buildCloneUrl(
        'https://github.com/org/repo.git',
        'api_key',
        'ghp_token123',
      )
      expect(result).toBe('https://x-access-token:ghp_token123@github.com/org/repo.git')
    })

    it('should return SSH URL unchanged', () => {
      const result = buildCloneUrl(
        'git@github.com:org/repo.git',
        'ssh',
        'ssh-key-content',
      )
      expect(result).toBe('git@github.com:org/repo.git')
    })

    it('should return URL unchanged if parsing fails', () => {
      const result = buildCloneUrl(
        'not-a-valid-url',
        'api_key',
        'token',
      )
      expect(result).toBe('not-a-valid-url')
    })

    it('should log a warning when credential embedding fails (without leaking url or secret)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { logger: loggerMock } = require('../src/logger') as {
        logger: { warn: jest.Mock }
      }
      loggerMock.warn.mockClear()

      const result = buildCloneUrl(
        'not-a-valid-url',
        'api_key',
        'super-secret-token',
      )

      // Behaviour preserved: original url is returned unchanged
      expect(result).toBe('not-a-valid-url')

      // A warning is emitted with the failure fact + error message only
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Failed to embed credentials into repo URL',
        expect.objectContaining({ error: expect.any(String) }),
      )

      // The url and the secret must never be passed to the logger
      for (const call of loggerMock.warn.mock.calls) {
        const serialized = JSON.stringify(call)
        expect(serialized).not.toContain('not-a-valid-url')
        expect(serialized).not.toContain('super-secret-token')
      }
    })
  })

  describe('buildAuthEnv', () => {
    beforeEach(() => {
      mockResolveKnownHostsPath.mockClear()
      mockResolveKnownHostsPath.mockReturnValue(FAKE_KNOWN_HOSTS_PATH)
    })

    it('should return empty env for non-SSH auth', () => {
      const { env, cleanup } = buildAuthEnv('api_key', 'token', undefined, 'https://github.com/org/repo.git')
      expect(env).toEqual({})
      cleanup() // no-op
    })

    it('should create SSH key file and GIT_SSH_COMMAND with legacy no-host-check flags when tenantCode is undefined (regression)', () => {
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.unlinkSync.mockImplementation(() => {})

      const { env, cleanup } = buildAuthEnv('ssh', 'ssh-private-key-content', undefined, 'git@github.com:org/repo.git')

      expect(env.GIT_SSH_COMMAND).toContain('ssh -i')
      expect(env.GIT_SSH_COMMAND).toContain('-o StrictHostKeyChecking=no')
      expect(env.GIT_SSH_COMMAND).toContain('-o UserKnownHostsFile=/dev/null')
      // TOFU path must not be consulted when tenantCode is unavailable
      expect(mockResolveKnownHostsPath).not.toHaveBeenCalled()
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('ssh-key-'),
        expect.any(String),
        { mode: 0o600 },
      )

      // SSH key filename should use cryptographic hex pattern
      const writtenPath = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][0] as string
      expect(path.basename(writtenPath)).toMatch(/^ssh-key-[0-9a-f]{32}$/)

      cleanup()
      expect(mockedFs.unlinkSync).toHaveBeenCalled()
    })

    it('should use TOFU (accept-new) + persistent known_hosts file when tenantCode is provided', () => {
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.unlinkSync.mockImplementation(() => {})

      const { env } = buildAuthEnv('ssh', 'ssh-private-key-content', 'acme', 'git@github.com:org/repo.git')

      expect(env.GIT_SSH_COMMAND).toContain('ssh -i')
      expect(env.GIT_SSH_COMMAND).toContain('-o StrictHostKeyChecking=accept-new')
      expect(env.GIT_SSH_COMMAND).toContain(`-o UserKnownHostsFile="${FAKE_KNOWN_HOSTS_PATH}"`)
      expect(env.GIT_SSH_COMMAND).not.toContain('StrictHostKeyChecking=no')

      // Resolved using the host extracted from the SSH repository URL
      expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'github.com')
    })

    it('should fall back to the shared known-hosts bucket when the host cannot be extracted from the URL', () => {
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.unlinkSync.mockImplementation(() => {})

      buildAuthEnv('ssh', 'ssh-private-key-content', 'acme', 'not-a-valid-url')

      expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'shared')
    })

    it('should not throw when cleanup fails and log warning', () => {
      mockedFs.writeFileSync.mockImplementation(() => {})
      mockedFs.unlinkSync.mockImplementation(() => {
        throw new Error('file not found')
      })

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { logger: loggerMock } = require('../src/logger') as { logger: { warn: jest.Mock } }
      const { cleanup } = buildAuthEnv('ssh', 'key', undefined, 'git@github.com:org/repo.git')
      expect(() => cleanup()).not.toThrow()
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete temporary SSH key file'),
      )
    })
  })

  describe('syncRepositories', () => {
    const mockClient = {
      getRepoCredentials: jest.fn(),
      getTenantCode: jest.fn().mockReturnValue('acme'),
    } as unknown as ApiClient

    const repositories: NonNullable<ProjectConfigResponse['repositories']> = [
      {
        repositoryId: 'REPO_01',
        repositoryCode: 'my-repo',
        repositoryName: 'my-repo',
        repositoryUrl: 'https://github.com/org/repo.git',
        provider: 'github',
        branch: 'main',
        authMethod: 'api_key',
      },
    ]

    beforeEach(() => {
      jest.clearAllMocks()
      // Re-setup fs.promises.mkdir after clearAllMocks
      ;(fs.promises.mkdir as jest.Mock).mockResolvedValue(undefined)
      // Setup execFile mock: promisify turns it into callback-last style
      ;(child_process.execFile as unknown as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const callback = args[args.length - 1]
          if (typeof callback === 'function') {
            callback(null, { stdout: '', stderr: '' })
          }
          return { on: jest.fn(), kill: jest.fn() }
        },
      )
    })

    it('should clone repository when .git does not exist', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(false)

      const results = await syncRepositories(
        mockClient,
        repositories,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('cloned')
      expect(results[0].repositoryId).toBe('REPO_01')
    })

    it('should update repository when .git exists', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(true)

      const results = await syncRepositories(
        mockClient,
        repositories,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('updated')
    })

    // 回帰テスト: entrypoint.sh はコンテナ起動時点で /workspace 配下に既に
    // 存在するリポジトリのみ safe.directory へ登録する（実行UIDと所有者UIDの
    // 不一致で git コマンドが "detected dubious ownership" で失敗する問題の
    // 対策、docker/entrypoint.sh 参照）。セッション中にWeb経由で新規クローン・
    // 更新されるリポジトリはその時点では未登録のため、clone/pull 自体が
    // 対象ディレクトリを都度 safe.directory へ登録する必要がある。
    it('registers the repo directory with git safe.directory before cloning (new repo)', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(false)

      await syncRepositories(mockClient, repositories, '/tmp/repos', '[TEST]')

      const calls = (child_process.execFile as unknown as jest.Mock).mock.calls
      // 未登録かどうかの事前確認（--get-all）を経てから --add する
      const getAllCall = calls.find(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'config' && (call[1] as string[])[2] === '--get-all',
      )
      const addCall = calls.find(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'config' && (call[1] as string[])[2] === '--add',
      )
      expect(getAllCall).toBeDefined()
      expect(addCall).toBeDefined()
      expect(addCall![1]).toEqual([
        'config',
        '--global',
        '--add',
        'safe.directory',
        path.join('/tmp/repos', 'my-repo'),
      ])

      // 登録（確認→追加）は clone より前（clone 自体もこのディレクトリに
      // 対して git を実行するため）
      const cloneIndex = calls.findIndex((call) => (call[1] as string[])[0] === 'clone')
      expect(calls.indexOf(getAllCall)).toBeLessThan(cloneIndex)
      expect(calls.indexOf(addCall)).toBeLessThan(cloneIndex)
    })

    it('registers the repo directory with git safe.directory before pulling (existing repo)', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(true)

      await syncRepositories(mockClient, repositories, '/tmp/repos', '[TEST]')

      const calls = (child_process.execFile as unknown as jest.Mock).mock.calls
      const addCall = calls.find(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'config' && (call[1] as string[])[2] === '--add',
      )
      expect(addCall).toBeDefined()
      expect(addCall![1]).toEqual([
        'config',
        '--global',
        '--add',
        'safe.directory',
        path.join('/tmp/repos', 'my-repo'),
      ])

      const fetchIndex = calls.findIndex((call) => (call[1] as string[])[0] === 'fetch')
      expect(calls.indexOf(addCall)).toBeLessThan(fetchIndex)
    })

    // 回帰テスト: --add は既存値の重複有無を確認しないため、事前チェックなしに
    // 呼ぶと同一セッションでの繰り返し同期（毎回 pullRepository を通る／
    // sync_repository MCPツールの再呼び出し）のたびに ~/.gitconfig に同じ
    // パスが際限なく積み上がる（レビュー指摘）。既に登録済みなら --add
    // 自体を呼ばないことを確認する。
    it('does NOT re-register safe.directory when the repo is already registered (avoids unbounded ~/.gitconfig growth)', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(true)
      const repoDir = path.join('/tmp/repos', 'my-repo')
      ;(child_process.execFile as unknown as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const callback = args[args.length - 1]
          const gitArgs = args[1] as string[]
          if (typeof callback === 'function') {
            if (gitArgs[0] === 'config' && gitArgs[2] === '--get-all') {
              callback(null, { stdout: `${repoDir}\n`, stderr: '' })
            } else {
              callback(null, { stdout: '', stderr: '' })
            }
          }
          return { on: jest.fn(), kill: jest.fn() }
        },
      )

      await syncRepositories(mockClient, repositories, '/tmp/repos', '[TEST]')

      const calls = (child_process.execFile as unknown as jest.Mock).mock.calls
      const addCall = calls.find(
        (call) => call[0] === 'git' && (call[1] as string[])[0] === 'config' && (call[1] as string[])[2] === '--add',
      )
      expect(addCall).toBeUndefined()
    })

    it('should handle checkout failure with branch creation fallback', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(true)

      // Make checkout fail on the first call (branch doesn't exist locally),
      // but succeed on the second call (create from remote)
      let callCount = 0
      ;(child_process.execFile as unknown as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const callback = args[args.length - 1]
          const gitArgs = args[1] as string[]
          callCount++
          if (typeof callback === 'function') {
            // Fail on 'git checkout main' (2nd git call after fetch)
            if (gitArgs[0] === 'checkout' && gitArgs.length === 2 && callCount === 2) {
              callback(new Error('branch not found'), { stdout: '', stderr: '' })
            } else {
              callback(null, { stdout: '', stderr: '' })
            }
          }
          return { on: jest.fn(), kill: jest.fn() }
        },
      )

      const results = await syncRepositories(
        mockClient,
        repositories,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('updated')
    })

    it('should skip repository when credentials fetch fails', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockRejectedValue(
        new Error('Not found'),
      )

      const results = await syncRepositories(
        mockClient,
        repositories,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('skipped')
      expect(results[0].error).toBe('Not found')
    })

    it('should reject branch names starting with -', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      mockedFs.existsSync.mockReturnValue(false)

      const maliciousRepos: NonNullable<ProjectConfigResponse['repositories']> = [
        {
          repositoryId: 'REPO_01',
          repositoryCode: 'my-repo',
          repositoryName: 'my-repo',
          repositoryUrl: 'https://github.com/org/repo.git',
          provider: 'github',
          branch: '-u',
          authMethod: 'api_key',
        },
      ]

      const results = await syncRepositories(
        mockClient,
        maliciousRepos,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('skipped')
      expect(results[0].error).toContain('Invalid branch name')
    })

    it('should migrate legacy directory and update repository', async () => {
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })

      // Legacy dir (repositoryId) exists but new dir (repositoryCode) does not,
      // then after migration the .git dir exists
      const mockedRenameSync = fs.renameSync as jest.Mock
      mockedRenameSync.mockClear()

      let renameCallCount = 0
      mockedFs.existsSync.mockImplementation((p: unknown) => {
        if (typeof p !== 'string') return false
        // legacyDir (/tmp/repos/REPO_01): exists
        if (p === '/tmp/repos/REPO_01') return true
        // repoDir (/tmp/repos/my-repo): doesn't exist yet (triggers rename)
        if (p === '/tmp/repos/my-repo') return false
        // gitDir (/tmp/repos/my-repo/.git): exists after rename
        if (p === '/tmp/repos/my-repo/.git') return renameCallCount > 0
        return false
      })
      mockedRenameSync.mockImplementation(() => {
        renameCallCount++
      })

      const results = await syncRepositories(
        mockClient,
        repositories,
        '/tmp/repos',
        '[TEST]',
      )

      expect(mockedRenameSync).toHaveBeenCalled()
      expect(results[0].status).toBe('updated')
    })

    it('should handle multiple repositories', async () => {
      const multiRepos: NonNullable<ProjectConfigResponse['repositories']> = [
        {
          repositoryId: 'REPO_01',
          repositoryCode: 'repo-a',
          repositoryName: 'repo-a',
          repositoryUrl: 'https://github.com/org/repo-a.git',
          provider: 'github',
          branch: 'main',
          authMethod: 'api_key',
        },
        {
          repositoryId: 'REPO_02',
          repositoryCode: 'repo-b',
          repositoryName: 'repo-b',
          repositoryUrl: 'https://github.com/org/repo-b.git',
          provider: 'github',
          branch: 'develop',
          authMethod: 'api_key',
        },
      ]

      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials
        .mockResolvedValueOnce({
          repositoryId: 'REPO_01',
          repositoryUrl: 'https://github.com/org/repo-a.git',
          authMethod: 'api_key',
          authSecret: 'token_a',
        })
        .mockRejectedValueOnce(new Error('Auth failed'))

      mockedFs.existsSync.mockReturnValue(false)

      const results = await syncRepositories(
        mockClient,
        multiRepos,
        '/tmp/repos',
        '[TEST]',
      )

      expect(results).toHaveLength(2)
      expect(results[0].status).toBe('cloned')
      expect(results[1].status).toBe('skipped')
    })

    describe('TOFU plumbing (tenantCode -> resolveKnownHostsPath) for ssh repositories', () => {
      const sshRepositories: NonNullable<ProjectConfigResponse['repositories']> = [
        {
          repositoryId: 'REPO_SSH',
          repositoryCode: 'ssh-repo',
          repositoryName: 'ssh-repo',
          repositoryUrl: 'git@gitlab.com:org/ssh-repo.git',
          provider: 'gitlab',
          branch: 'main',
          authMethod: 'ssh',
        },
      ]

      beforeEach(() => {
        mockResolveKnownHostsPath.mockClear()
        mockResolveKnownHostsPath.mockReturnValue(FAKE_KNOWN_HOSTS_PATH)
        mockedFs.writeFileSync.mockImplementation(() => {})
        mockedFs.unlinkSync.mockImplementation(() => {})
        ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
          repositoryId: 'REPO_SSH',
          repositoryUrl: 'git@gitlab.com:org/ssh-repo.git',
          authMethod: 'ssh',
          authSecret: '-----BEGIN OPENSSH PRIVATE KEY-----\nABCD\n-----END OPENSSH PRIVATE KEY-----\n',
        })
      })

      it('resolves the TOFU known_hosts path with the tenantCode and the URL host when cloning', async () => {
        mockedFs.existsSync.mockReturnValue(false)

        const results = await syncRepositories(mockClient, sshRepositories, '/tmp/repos', '[TEST]')

        expect(results[0].status).toBe('cloned')
        expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'gitlab.com')
      })

      it('resolves the TOFU known_hosts path with the tenantCode and the URL host when pulling', async () => {
        mockedFs.existsSync.mockReturnValue(true)

        const results = await syncRepositories(mockClient, sshRepositories, '/tmp/repos', '[TEST]')

        expect(results[0].status).toBe('updated')
        expect(mockResolveKnownHostsPath).toHaveBeenCalledWith('acme', 'gitlab.com')
      })

      it('falls back to legacy no-host-check flags (no TOFU lookup) when the client has no tenantCode', async () => {
        ;(mockClient as unknown as { getTenantCode: jest.Mock }).getTenantCode.mockReturnValueOnce('')
        mockedFs.existsSync.mockReturnValue(false)

        const results = await syncRepositories(mockClient, sshRepositories, '/tmp/repos', '[TEST]')

        expect(results[0].status).toBe('cloned')
        expect(mockResolveKnownHostsPath).not.toHaveBeenCalled()
      })
    })
  })

  describe('syncRepositoryByCode', () => {
    const mockClient = {
      getRepoCredentials: jest.fn(),
      getTenantCode: jest.fn().mockReturnValue('acme'),
    } as unknown as ApiClient

    const repositories: NonNullable<ProjectConfigResponse['repositories']> = [
      {
        repositoryId: 'REPO_01',
        repositoryCode: 'my-repo',
        repositoryName: 'my-repo',
        repositoryUrl: 'https://github.com/org/repo.git',
        provider: 'github',
        branch: 'main',
        authMethod: 'api_key',
      },
    ]

    beforeEach(() => {
      jest.clearAllMocks()
      ;(fs.promises.mkdir as jest.Mock).mockResolvedValue(undefined)
      ;(child_process.execFile as unknown as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const callback = args[args.length - 1]
          if (typeof callback === 'function') {
            callback(null, { stdout: '', stderr: '' })
          }
          return { on: jest.fn(), kill: jest.fn() }
        },
      )
      ;(mockClient as unknown as { getRepoCredentials: jest.Mock }).getRepoCredentials.mockResolvedValue({
        repositoryId: 'REPO_01',
        repositoryUrl: 'https://github.com/org/repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      })
    })

    it('should sync repository by code (clone)', async () => {
      mockedFs.existsSync.mockReturnValue(false)

      const result = await syncRepositoryByCode(
        mockClient,
        repositories,
        'my-repo',
        undefined,
        '/tmp/repos',
        '[TEST]',
      )

      expect(result.status).toBe('cloned')
      expect(result.repositoryCode).toBe('my-repo')
    })

    it('should override branch when specified', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      const result = await syncRepositoryByCode(
        mockClient,
        repositories,
        'my-repo',
        'feature/new-branch',
        '/tmp/repos',
        '[TEST]',
      )

      expect(result.status).toBe('updated')
      // Verify git checkout was called with the override branch
      const execFileCalls = (child_process.execFile as unknown as jest.Mock).mock.calls
      const checkoutCall = execFileCalls.find(
        (args: unknown[]) => Array.isArray(args[1]) && (args[1] as string[])[0] === 'checkout',
      )
      expect(checkoutCall).toBeDefined()
      expect((checkoutCall[1] as string[])).toContain('feature/new-branch')
    })

    it('should use config branch when override is not specified', async () => {
      mockedFs.existsSync.mockReturnValue(true)

      const result = await syncRepositoryByCode(
        mockClient,
        repositories,
        'my-repo',
        undefined,
        '/tmp/repos',
        '[TEST]',
      )

      expect(result.status).toBe('updated')
      const execFileCalls = (child_process.execFile as unknown as jest.Mock).mock.calls
      const checkoutCall = execFileCalls.find(
        (args: unknown[]) => Array.isArray(args[1]) && (args[1] as string[])[0] === 'checkout',
      )
      expect(checkoutCall).toBeDefined()
      expect((checkoutCall[1] as string[])).toContain('main')
    })

    it('should throw when repositoryCode is not found', async () => {
      await expect(
        syncRepositoryByCode(
          mockClient,
          repositories,
          'non-existent-repo',
          undefined,
          '/tmp/repos',
          '[TEST]',
        ),
      ).rejects.toThrow('Repository not found: non-existent-repo')
    })
  })
})
