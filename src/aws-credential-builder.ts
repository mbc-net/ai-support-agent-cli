import type { ApiClient } from './api-client'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'

/**
 * プロファイル方式でAWS認証情報を構築する。
 * 全アカウントの認証情報をサーバーから取得し、プロファイルファイルに書き込んで
 * 環境変数（AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE 等）を返す。
 */
export async function buildAwsProfileCredentials(
  client: ApiClient,
  projectDir: string,
  projectConfig: ProjectConfigResponse,
): Promise<Record<string, string> | undefined> {
  const accounts = projectConfig.aws?.accounts
  if (!accounts?.length) return undefined

  const projectCode = projectConfig.project.projectCode
  const { writeAwsCredentials, buildAwsProfileEnv } = await import('./aws-profile')
  const credentialMap = new Map<string, import('./types').AwsCredentials>()

  for (const account of accounts) {
    try {
      logger.info(`[chat] Fetching AWS credentials for profile: ${account.name} (${account.id})`)
      const creds = await client.getAwsCredentials(account.id)
      credentialMap.set(account.name, creds)
    } catch (error) {
      logger.warn(`[chat] Failed to get AWS credentials for ${account.name}: ${getErrorMessage(error)}`)
    }
  }

  if (credentialMap.size === 0) return undefined

  // credentials ファイルに書き込み
  writeAwsCredentials(projectDir, projectCode, credentialMap)

  // デフォルトアカウントを特定
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0]

  return buildAwsProfileEnv(
    projectDir,
    projectCode,
    defaultAccount.name,
    defaultAccount.region,
  )
}

/**
 * 従来方式（単一アカウント）でAWS認証情報を環境変数として構築する。
 * awsAccountId が指定されている場合にサーバーから認証情報を取得し、
 * AWS_ACCESS_KEY_ID 等の環境変数マップを返す。
 */
export async function buildSingleAccountAwsEnv(
  client: ApiClient,
  awsAccountId: string | undefined,
): Promise<Record<string, string> | undefined> {
  if (!awsAccountId) return undefined

  try {
    logger.info(`[chat] Fetching AWS credentials for account: ${awsAccountId}`)
    const creds = await client.getAwsCredentials(awsAccountId)
    const env: Record<string, string> = {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_DEFAULT_REGION: creds.region,
      ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    }
    logger.info(`[chat] AWS credentials obtained for region=${creds.region}`)
    return env
  } catch (error) {
    logger.warn(`[chat] Failed to get AWS credentials: ${getErrorMessage(error)}`)
    return undefined
  }
}
