import axios from 'axios'

import type { ApiClient } from './api-client'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'

export interface AwsCredentialResult {
  env?: Record<string, string>
  errors: string[]
}

/**
 * HTTPエラーレスポンスからAWS認証エラーメッセージを抽出する
 */
function extractAwsCredentialError(error: unknown, accountName: string): string {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status
    const data = error.response.data as Record<string, unknown> | undefined

    if (data) {
      // SSO認証切れの場合は専用メッセージ
      if (data.error === 'SSO_AUTH_REQUIRED') {
        return `AWS SSO認証の有効期限が切れています（${accountName}）。管理画面からSSO再認証を実行してください。`
      }

      // その他のAPIエラー（422含む）はレスポンス詳細を含める
      const serverMessage = data.message ?? data.error ?? 'Unknown error'
      logger.debug(`[aws-cred] API error response (status=${status}): ${JSON.stringify(data)}`)
      return `AWS認証情報の取得に失敗しました（${accountName}）: [${status}] ${serverMessage}`
    }

    return `AWS認証情報の取得に失敗しました（${accountName}）: HTTP ${status}`
  }
  return `AWS認証情報の取得に失敗しました（${accountName}）: ${getErrorMessage(error)}`
}

/**
 * プロファイル方式でAWS認証情報を構築する。
 * 全アカウントの認証情報をサーバーから取得し、プロファイルファイルに書き込んで
 * 環境変数（AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE 等）を返す。
 */
export async function buildAwsProfileCredentials(
  client: ApiClient,
  projectDir: string,
  projectConfig: ProjectConfigResponse,
): Promise<AwsCredentialResult> {
  const accounts = projectConfig.aws?.accounts
  if (!accounts?.length) return { errors: [] }

  const projectCode = projectConfig.project.projectCode
  const { writeAwsCredentials, buildAwsProfileEnv } = await import('./aws-profile')
  const credentialMap = new Map<string, import('./types').AwsCredentials>()
  const errors: string[] = []

  for (const account of accounts) {
    try {
      logger.info(`[chat] Fetching AWS credentials for profile: ${account.name} (${account.id})`)
      const creds = await client.getAwsCredentials(account.id)
      credentialMap.set(account.name, creds)
    } catch (error) {
      const errorMsg = extractAwsCredentialError(error, account.name)
      errors.push(errorMsg)
      logger.warn(`[chat] Failed to get AWS credentials for ${account.name}: ${getErrorMessage(error)}`)
    }
  }

  if (credentialMap.size === 0) return { errors }

  // credentials ファイルに書き込み
  writeAwsCredentials(projectDir, projectCode, credentialMap)

  // デフォルトアカウントを特定
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0]

  const env = buildAwsProfileEnv(
    projectDir,
    projectCode,
    defaultAccount.name,
    defaultAccount.region,
  )

  return { env, errors }
}

/**
 * 従来方式（単一アカウント）でAWS認証情報を環境変数として構築する。
 * awsAccountId が指定されている場合にサーバーから認証情報を取得し、
 * AWS_ACCESS_KEY_ID 等の環境変数マップを返す。
 */
export async function buildSingleAccountAwsEnv(
  client: ApiClient,
  awsAccountId: string | undefined,
): Promise<AwsCredentialResult> {
  if (!awsAccountId) return { errors: [] }

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
    return { env, errors: [] }
  } catch (error) {
    const errorMsg = extractAwsCredentialError(error, awsAccountId)
    logger.warn(`[chat] Failed to get AWS credentials: ${getErrorMessage(error)}`)
    return { errors: [errorMsg] }
  }
}
