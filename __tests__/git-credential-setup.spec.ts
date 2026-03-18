import * as fs from 'fs'

import type { ApiClient } from '../src/api-client'
import {
  buildCredentialHelperScript,
  buildGitCredentialEnv,
  buildSshWrapperScript,
  extractHostFromUrl,
  extractPathFromUrl,
} from '../src/git-credential-setup'
import type { ProjectConfigResponse, RepoCredentials } from '../src/types'

jest.mock('../src/logger')

describe('git-credential-setup', () => {
  describe('extractHostFromUrl', () => {
    it('should extract host from SSH URL', () => {
      expect(extractHostFromUrl('git@gitlab.com:org/repo.git')).toBe('gitlab.com')
    })

    it('should extract host from SSH URL with different user', () => {
      expect(extractHostFromUrl('ssh@github.com:org/repo.git')).toBe('github.com')
    })

    it('should extract host from HTTPS URL', () => {
      expect(extractHostFromUrl('https://github.com/org/repo.git')).toBe('github.com')
    })

    it('should extract host from HTTPS URL with port', () => {
      expect(extractHostFromUrl('https://gitlab.example.com:8443/org/repo.git')).toBe('gitlab.example.com')
    })

    it('should return empty string for invalid URL', () => {
      expect(extractHostFromUrl('not-a-url')).toBe('')
    })
  })

  describe('extractPathFromUrl', () => {
    it('should extract path from SSH URL', () => {
      expect(extractPathFromUrl('git@gitlab.com:org/repo.git')).toBe('org/repo.git')
    })

    it('should extract path from HTTPS URL', () => {
      expect(extractPathFromUrl('https://github.com/org/repo.git')).toBe('org/repo.git')
    })

    it('should extract path from HTTPS URL with nested path', () => {
      expect(extractPathFromUrl('https://gitlab.com/group/subgroup/repo.git')).toBe('group/subgroup/repo.git')
    })

    it('should return empty string for invalid URL', () => {
      expect(extractPathFromUrl('not-a-url')).toBe('')
    })
  })

  describe('buildSshWrapperScript', () => {
    it('should generate script with host-based key selection', () => {
      const entries = [
        { host: 'gitlab.com', keyPath: '/tmp/ssh-key-abc' },
        { host: 'github.com', keyPath: '/tmp/ssh-key-def' },
      ]
      const script = buildSshWrapperScript(entries)

      expect(script).toContain('#!/bin/sh')
      expect(script).toContain('gitlab.com')
      expect(script).toContain('/tmp/ssh-key-abc')
      expect(script).toContain('github.com')
      expect(script).toContain('/tmp/ssh-key-def')
      expect(script).toContain('StrictHostKeyChecking=no')
      expect(script).toContain('UserKnownHostsFile=/dev/null')
    })

    it('should extract hostname from first non-option argument', () => {
      const script = buildSshWrapperScript([{ host: 'gitlab.com', keyPath: '/tmp/key' }])
      // Script should skip options (args starting with -)
      expect(script).toContain('-*) ;;')
      // Should extract host from user@host using sed
      expect(script).toContain("sed 's/.*@//'")
    })

    it('should include default case for unknown hosts', () => {
      const script = buildSshWrapperScript([{ host: 'gitlab.com', keyPath: '/tmp/key' }])
      expect(script).toContain('*)')
      expect(script).toContain('exec ssh -o StrictHostKeyChecking=no')
    })
  })

  describe('buildCredentialHelperScript', () => {
    it('should generate script with host/path matching', () => {
      const entries = [
        { host: 'github.com', pathPrefix: 'org/repo.git', token: 'ghp_token123' },
      ]
      const script = buildCredentialHelperScript(entries)

      expect(script).toContain('#!/bin/sh')
      expect(script).toContain('github.com')
      expect(script).toContain('org/repo.git')
      expect(script).toContain('username=x-access-token')
      expect(script).toContain('password=ghp_token123')
    })

    it('should handle multiple entries', () => {
      const entries = [
        { host: 'github.com', pathPrefix: 'org1/repo1.git', token: 'token1' },
        { host: 'gitlab.com', pathPrefix: 'org2/repo2.git', token: 'token2' },
      ]
      const script = buildCredentialHelperScript(entries)

      expect(script).toContain('token1')
      expect(script).toContain('token2')
      expect(script).toContain('github.com')
      expect(script).toContain('gitlab.com')
    })

    it('should only respond to get operation', () => {
      const entries = [
        { host: 'github.com', pathPrefix: 'org/repo.git', token: 'token' },
      ]
      const script = buildCredentialHelperScript(entries)

      expect(script).toContain('if [ "$1" != "get" ]; then')
      expect(script).toContain('exit 0')
    })
  })

  describe('buildGitCredentialEnv', () => {
    const mockClient = {
      getRepoCredentials: jest.fn(),
    } as unknown as ApiClient

    const baseRepo: NonNullable<ProjectConfigResponse['repositories']>[number] = {
      repositoryId: 'repo-1',
      repositoryCode: 'my-repo',
      repositoryName: 'My Repo',
      repositoryUrl: 'git@gitlab.com:org/my-repo.git',
      provider: 'gitlab',
      branch: 'main',
      authMethod: 'ssh',
    }

    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('should return empty env and noop cleanup for empty repositories', async () => {
      const result = await buildGitCredentialEnv(mockClient, [])
      expect(result.env).toEqual({})
      result.cleanup() // should not throw
    })

    it('should set up SSH wrapper for SSH repositories', async () => {
      const sshKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n'
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'git@gitlab.com:org/my-repo.git',
        authMethod: 'ssh',
        authSecret: sshKey,
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo])

      try {
        expect(result.env.GIT_SSH_COMMAND).toBeDefined()
        expect(result.env.GIT_SSH_COMMAND).toMatch(/git-ssh-wrapper-[a-f0-9]+\.sh$/)

        // Verify wrapper script exists and is executable
        const wrapperPath = result.env.GIT_SSH_COMMAND
        const stat = fs.statSync(wrapperPath)
        expect(stat.mode & 0o700).toBe(0o700)

        // Verify wrapper content
        const wrapperContent = fs.readFileSync(wrapperPath, 'utf-8')
        expect(wrapperContent).toContain('gitlab.com')
        expect(wrapperContent).toContain('StrictHostKeyChecking=no')
      } finally {
        result.cleanup()
      }
    })

    it('should write SSH key file with mode 0600', async () => {
      const sshKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n'
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'git@gitlab.com:org/my-repo.git',
        authMethod: 'ssh',
        authSecret: sshKey,
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo])

      try {
        // Read wrapper to find key path
        const wrapperContent = fs.readFileSync(result.env.GIT_SSH_COMMAND, 'utf-8')
        const keyPathMatch = wrapperContent.match(/-i "([^"]+)"/)
        expect(keyPathMatch).toBeTruthy()

        const keyPath = keyPathMatch![1]
        const stat = fs.statSync(keyPath)
        // Check mode is 0600 (owner read/write only)
        expect(stat.mode & 0o777).toBe(0o600)

        // Verify key content is normalized
        const keyContent = fs.readFileSync(keyPath, 'utf-8')
        expect(keyContent).toContain('-----BEGIN RSA PRIVATE KEY-----')
        expect(keyContent).toContain('-----END RSA PRIVATE KEY-----')
      } finally {
        result.cleanup()
      }
    })

    it('should set up credential helper for HTTPS repositories', async () => {
      const httpsRepo = {
        ...baseRepo,
        repositoryUrl: 'https://github.com/org/my-repo.git',
        authMethod: 'api_key',
      }
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'https://github.com/org/my-repo.git',
        authMethod: 'api_key',
        authSecret: 'ghp_token123',
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [httpsRepo])

      try {
        expect(result.env.GIT_CONFIG_COUNT).toBe('1')
        expect(result.env.GIT_CONFIG_KEY_0).toBe('credential.helper')
        expect(result.env.GIT_CONFIG_VALUE_0).toMatch(/^!.*git-credential-helper-[a-f0-9]+\.sh$/)

        // Verify helper script exists and is executable
        const helperPath = result.env.GIT_CONFIG_VALUE_0.slice(1) // remove leading !
        const stat = fs.statSync(helperPath)
        expect(stat.mode & 0o700).toBe(0o700)

        // Verify helper content
        const helperContent = fs.readFileSync(helperPath, 'utf-8')
        expect(helperContent).toContain('github.com')
        expect(helperContent).toContain('ghp_token123')
        expect(helperContent).toContain('x-access-token')
      } finally {
        result.cleanup()
      }
    })

    it('should handle SSH + HTTPS mixed repositories', async () => {
      const sshRepo = { ...baseRepo }
      const httpsRepo = {
        ...baseRepo,
        repositoryId: 'repo-2',
        repositoryCode: 'another-repo',
        repositoryName: 'Another Repo',
        repositoryUrl: 'https://github.com/org/another-repo.git',
        authMethod: 'api_key',
      }

      ;(mockClient.getRepoCredentials as jest.Mock)
        .mockResolvedValueOnce({
          repositoryId: 'repo-1',
          repositoryUrl: 'git@gitlab.com:org/my-repo.git',
          authMethod: 'ssh',
          authSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
        } as RepoCredentials)
        .mockResolvedValueOnce({
          repositoryId: 'repo-2',
          repositoryUrl: 'https://github.com/org/another-repo.git',
          authMethod: 'api_key',
          authSecret: 'ghp_token456',
        } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [sshRepo, httpsRepo])

      try {
        // SSH wrapper should be set
        expect(result.env.GIT_SSH_COMMAND).toBeDefined()
        // HTTPS credential helper should be set
        expect(result.env.GIT_CONFIG_COUNT).toBe('1')
        expect(result.env.GIT_CONFIG_KEY_0).toBe('credential.helper')
      } finally {
        result.cleanup()
      }
    })

    it('should skip individual repository on API error and continue with others', async () => {
      const repo2 = {
        ...baseRepo,
        repositoryId: 'repo-2',
        repositoryCode: 'repo-2',
        repositoryName: 'Repo 2',
        repositoryUrl: 'git@github.com:org/repo-2.git',
      }

      ;(mockClient.getRepoCredentials as jest.Mock)
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          repositoryId: 'repo-2',
          repositoryUrl: 'git@github.com:org/repo-2.git',
          authMethod: 'ssh',
          authSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
        } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo, repo2])

      try {
        // Should still set up SSH wrapper for the successful repository
        expect(result.env.GIT_SSH_COMMAND).toBeDefined()
        const wrapperContent = fs.readFileSync(result.env.GIT_SSH_COMMAND, 'utf-8')
        expect(wrapperContent).toContain('github.com')
        // Should NOT contain gitlab.com (the failed one)
        expect(wrapperContent).not.toContain('gitlab.com')
      } finally {
        result.cleanup()
      }
    })

    it('should cleanup all temporary files', async () => {
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'git@gitlab.com:org/my-repo.git',
        authMethod: 'ssh',
        authSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo])

      const wrapperPath = result.env.GIT_SSH_COMMAND
      const wrapperContent = fs.readFileSync(wrapperPath, 'utf-8')
      const keyPathMatch = wrapperContent.match(/-i "([^"]+)"/)
      const keyPath = keyPathMatch![1]

      // Files exist before cleanup
      expect(fs.existsSync(wrapperPath)).toBe(true)
      expect(fs.existsSync(keyPath)).toBe(true)

      result.cleanup()

      // Files removed after cleanup
      expect(fs.existsSync(wrapperPath)).toBe(false)
      expect(fs.existsSync(keyPath)).toBe(false)
    })

    it('should normalize PEM key in SSH key file', async () => {
      // Key without newlines (as stored in DB)
      const rawKey = '-----BEGIN RSA PRIVATE KEY-----AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBB-----END RSA PRIVATE KEY-----'
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'git@gitlab.com:org/my-repo.git',
        authMethod: 'ssh',
        authSecret: rawKey,
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo])

      try {
        const wrapperContent = fs.readFileSync(result.env.GIT_SSH_COMMAND, 'utf-8')
        const keyPathMatch = wrapperContent.match(/-i "([^"]+)"/)
        const keyContent = fs.readFileSync(keyPathMatch![1], 'utf-8')

        // Key should be normalized with proper PEM format
        expect(keyContent).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/)
        expect(keyContent).toMatch(/\n-----END RSA PRIVATE KEY-----\n$/)
        // Body lines should be max 64 chars
        const lines = keyContent.split('\n')
        for (const line of lines.slice(1, -2)) { // skip header and footer
          expect(line.length).toBeLessThanOrEqual(64)
        }
      } finally {
        result.cleanup()
      }
    })

    it('should not throw when cleanup encounters missing files', async () => {
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'git@gitlab.com:org/my-repo.git',
        authMethod: 'ssh',
        authSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [baseRepo])

      // Manually delete files before cleanup
      const wrapperPath = result.env.GIT_SSH_COMMAND
      const wrapperContent = fs.readFileSync(wrapperPath, 'utf-8')
      const keyPathMatch = wrapperContent.match(/-i "([^"]+)"/)
      fs.unlinkSync(wrapperPath)
      fs.unlinkSync(keyPathMatch![1])

      // Cleanup should not throw
      expect(() => result.cleanup()).not.toThrow()
    })

    it('should skip repository with unparseable URL', async () => {
      const badRepo = {
        ...baseRepo,
        repositoryUrl: 'not-a-valid-url',
      }
      ;(mockClient.getRepoCredentials as jest.Mock).mockResolvedValue({
        repositoryId: 'repo-1',
        repositoryUrl: 'not-a-valid-url',
        authMethod: 'ssh',
        authSecret: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
      } as RepoCredentials)

      const result = await buildGitCredentialEnv(mockClient, [badRepo])

      // Should return empty env since host couldn't be extracted
      expect(result.env).toEqual({})
      result.cleanup()
    })
  })
})
