import axios from 'axios'

import type { ApiClient } from '../src/api-client'
import { buildAwsProfileCredentials, buildSingleAccountAwsEnv } from '../src/aws-credential-builder'
import type { ProjectConfigResponse } from '../src/types'

jest.mock('../src/logger')

// Mock aws-profile
jest.mock('../src/aws-profile', () => ({
  writeAwsCredentials: jest.fn(),
  buildAwsProfileEnv: jest.fn().mockReturnValue({
    AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
    AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
    AWS_PROFILE: 'TEST-dev',
    AWS_DEFAULT_REGION: 'ap-northeast-1',
  }),
}))

describe('aws-credential-builder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('buildAwsProfileCredentials', () => {
    const projectConfig: ProjectConfigResponse = {
      configHash: 'test-hash',
      project: { projectCode: 'TEST', projectName: 'Test Project' },
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
      },
      aws: {
        accounts: [
          {
            id: '1',
            name: 'dev',
            description: 'Dev account',
            region: 'ap-northeast-1',
            accountId: '123456789012',
            auth: { method: 'access_key' },
            isDefault: true,
          },
          {
            id: '2',
            name: 'staging',
            description: 'Staging account',
            region: 'us-east-1',
            accountId: '987654321098',
            auth: { method: 'access_key' },
            isDefault: false,
          },
        ],
      },
    }

    it('should return empty result when accounts is empty', async () => {
      const client = {} as ApiClient
      const config: ProjectConfigResponse = {
        ...projectConfig,
        aws: { accounts: [] },
      }

      const result = await buildAwsProfileCredentials(client, '/tmp/project', config)
      expect(result).toEqual({ errors: [] })
      expect(result.env).toBeUndefined()
    })

    it('should return empty result when aws is undefined', async () => {
      const client = {} as ApiClient
      const config: ProjectConfigResponse = {
        ...projectConfig,
        aws: undefined,
      }

      const result = await buildAwsProfileCredentials(client, '/tmp/project', config)
      expect(result).toEqual({ errors: [] })
      expect(result.env).toBeUndefined()
    })

    it('should fetch credentials for all accounts and return profile env', async () => {
      const client = {
        getAwsCredentials: jest.fn()
          .mockResolvedValueOnce({
            accessKeyId: 'AKIA_DEV',
            secretAccessKey: 'secret_dev',
            region: 'ap-northeast-1',
          })
          .mockResolvedValueOnce({
            accessKeyId: 'AKIA_STG',
            secretAccessKey: 'secret_stg',
            region: 'us-east-1',
          }),
      } as unknown as ApiClient

      const { writeAwsCredentials, buildAwsProfileEnv } = require('../src/aws-profile')

      const result = await buildAwsProfileCredentials(client, '/tmp/project', projectConfig)

      expect(client.getAwsCredentials).toHaveBeenCalledTimes(2)
      expect(client.getAwsCredentials).toHaveBeenCalledWith('1')
      expect(client.getAwsCredentials).toHaveBeenCalledWith('2')

      expect(writeAwsCredentials).toHaveBeenCalledWith(
        '/tmp/project',
        'TEST',
        expect.any(Map),
      )

      // Check the credential map passed to writeAwsCredentials
      const credMap = writeAwsCredentials.mock.calls[0][2] as Map<string, unknown>
      expect(credMap.size).toBe(2)
      expect(credMap.has('dev')).toBe(true)
      expect(credMap.has('staging')).toBe(true)

      expect(buildAwsProfileEnv).toHaveBeenCalledWith(
        '/tmp/project',
        'TEST',
        'dev', // default account name
        'ap-northeast-1', // default account region
      )

      expect(result.env).toEqual({
        AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
        AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
        AWS_PROFILE: 'TEST-dev',
        AWS_DEFAULT_REGION: 'ap-northeast-1',
      })
      expect(result.errors).toEqual([])
    })

    it('should return errors when all credential fetches fail', async () => {
      const client = {
        getAwsCredentials: jest.fn().mockRejectedValue(new Error('Not found')),
      } as unknown as ApiClient

      const result = await buildAwsProfileCredentials(client, '/tmp/project', projectConfig)
      expect(result.env).toBeUndefined()
      expect(result.errors).toHaveLength(2)
      expect(result.errors[0]).toContain('dev')
      expect(result.errors[1]).toContain('staging')
    })

    it('should skip failed accounts and continue with successful ones', async () => {
      const client = {
        getAwsCredentials: jest.fn()
          .mockRejectedValueOnce(new Error('Not found'))
          .mockResolvedValueOnce({
            accessKeyId: 'AKIA_STG',
            secretAccessKey: 'secret_stg',
            region: 'us-east-1',
          }),
      } as unknown as ApiClient

      const { writeAwsCredentials } = require('../src/aws-profile')

      const result = await buildAwsProfileCredentials(client, '/tmp/project', projectConfig)

      expect(result.env).toBeDefined()
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('dev')
      const credMap = writeAwsCredentials.mock.calls[0][2] as Map<string, unknown>
      expect(credMap.size).toBe(1)
      expect(credMap.has('staging')).toBe(true)
    })

    it('should use first account as default when no isDefault is set', async () => {
      const configNoDefault: ProjectConfigResponse = {
        ...projectConfig,
        aws: {
          accounts: [
            {
              id: '1',
              name: 'alpha',
              description: 'Alpha',
              region: 'eu-west-1',
              accountId: '111111111111',
              auth: { method: 'access_key' },
              isDefault: false,
            },
            {
              id: '2',
              name: 'beta',
              description: 'Beta',
              region: 'us-west-2',
              accountId: '222222222222',
              auth: { method: 'access_key' },
              isDefault: false,
            },
          ],
        },
      }

      const client = {
        getAwsCredentials: jest.fn().mockResolvedValue({
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret_test',
          region: 'eu-west-1',
        }),
      } as unknown as ApiClient

      const { buildAwsProfileEnv } = require('../src/aws-profile')

      await buildAwsProfileCredentials(client, '/tmp/project', configNoDefault)

      // Should fall back to first account
      expect(buildAwsProfileEnv).toHaveBeenCalledWith(
        '/tmp/project',
        'TEST',
        'alpha',
        'eu-west-1',
      )
    })

    it('should detect SSO_AUTH_REQUIRED error from API response', async () => {
      const ssoError = new axios.AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        {
          status: 422,
          statusText: 'Unprocessable Entity',
          data: {
            statusCode: 422,
            error: 'SSO_AUTH_REQUIRED',
            message: 'SSO token expired',
            accountId: '123456789012',
            accountName: 'dev',
          },
          headers: {},
          config: {} as never,
        },
      )

      const client = {
        getAwsCredentials: jest.fn()
          .mockRejectedValueOnce(ssoError)
          .mockResolvedValueOnce({
            accessKeyId: 'AKIA_STG',
            secretAccessKey: 'secret_stg',
            region: 'us-east-1',
          }),
      } as unknown as ApiClient

      const result = await buildAwsProfileCredentials(client, '/tmp/project', projectConfig)

      expect(result.env).toBeDefined()
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('SSO認証の有効期限が切れています')
      expect(result.errors[0]).toContain('dev')
      expect(result.errors[0]).toContain('管理画面からSSO再認証')
    })
  })

  describe('buildSingleAccountAwsEnv', () => {
    it('should return empty result when awsAccountId is undefined', async () => {
      const client = {} as ApiClient
      const result = await buildSingleAccountAwsEnv(client, undefined)
      expect(result).toEqual({ errors: [] })
      expect(result.env).toBeUndefined()
    })

    it('should fetch credentials and return env map', async () => {
      const client = {
        getAwsCredentials: jest.fn().mockResolvedValue({
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'secretTest',
          sessionToken: 'tokenTest',
          region: 'ap-northeast-1',
        }),
      } as unknown as ApiClient

      const result = await buildSingleAccountAwsEnv(client, 'prod-account')

      expect(client.getAwsCredentials).toHaveBeenCalledWith('prod-account')
      expect(result.env).toEqual({
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        AWS_SECRET_ACCESS_KEY: 'secretTest',
        AWS_SESSION_TOKEN: 'tokenTest',
        AWS_DEFAULT_REGION: 'ap-northeast-1',
      })
      expect(result.errors).toEqual([])
    })

    it('should not include AWS_SESSION_TOKEN when sessionToken is not provided', async () => {
      const client = {
        getAwsCredentials: jest.fn().mockResolvedValue({
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'secretTest',
          region: 'us-east-1',
        }),
      } as unknown as ApiClient

      const result = await buildSingleAccountAwsEnv(client, 'dev-account')

      expect(result.env).toEqual({
        AWS_ACCESS_KEY_ID: 'AKIATEST',
        AWS_SECRET_ACCESS_KEY: 'secretTest',
        AWS_DEFAULT_REGION: 'us-east-1',
      })
      expect(result.env).not.toHaveProperty('AWS_SESSION_TOKEN')
      expect(result.errors).toEqual([])
    })

    it('should return error when getAwsCredentials fails', async () => {
      const client = {
        getAwsCredentials: jest.fn().mockRejectedValue(new Error('Access denied')),
      } as unknown as ApiClient

      const result = await buildSingleAccountAwsEnv(client, 'bad-account')

      expect(result.env).toBeUndefined()
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('bad-account')
    })

    it('should detect SSO_AUTH_REQUIRED error from API response', async () => {
      const ssoError = new axios.AxiosError(
        'Request failed',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        {
          status: 422,
          statusText: 'Unprocessable Entity',
          data: {
            statusCode: 422,
            error: 'SSO_AUTH_REQUIRED',
            message: 'SSO token expired',
            accountId: '123456789012',
            accountName: 'prod',
          },
          headers: {},
          config: {} as never,
        },
      )

      const client = {
        getAwsCredentials: jest.fn().mockRejectedValue(ssoError),
      } as unknown as ApiClient

      const result = await buildSingleAccountAwsEnv(client, 'prod-account')

      expect(result.env).toBeUndefined()
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('SSO認証の有効期限が切れています')
      expect(result.errors[0]).toContain('prod-account')
      expect(result.errors[0]).toContain('管理画面からSSO再認証')
    })
  })
})
