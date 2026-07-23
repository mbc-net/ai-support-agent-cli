import axios from 'axios'

import type { ApiClient } from './api-client'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage, isSsoAuthRequiredError } from './utils'

export interface SsoAuthRequiredInfo {
  accountId: string
  accountName: string
}

export interface AwsCredentialResult {
  env?: Record<string, string>
  errors: string[]
  ssoAuthRequired: SsoAuthRequiredInfo[]
  cleanup?: () => void
}

interface CredentialError {
  errorMessage: string
  ssoInfo?: SsoAuthRequiredInfo
}

/**
 * HTTPエラーレスポンスからAWS認証エラーメッセージを抽出する
 */
function extractAwsCredentialError(error: unknown, accountName: string): CredentialError {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status
    const data = error.response.data as Record<string, unknown> | undefined

    if (data) {
      // SSO認証切れの場合は専用メッセージ + SSO情報
      if (isSsoAuthRequiredError(error)) {
        const accountId = typeof data.accountId === 'string' ? data.accountId : ''
        return {
          errorMessage: `AWS SSO認証の有効期限が切れています（${accountName}）。管理画面からSSO再認証を実行してください。`,
          ssoInfo: { accountId, accountName },
        }
      }

      // その他のAPIエラー（422含む）はレスポンス詳細を含める
      const serverMessage = data.message ?? data.error ?? 'Unknown error'
      logger.debug(`[aws-cred] API error response (status=${status}): ${JSON.stringify(data)}`)
      return { errorMessage: `AWS認証情報の取得に失敗しました（${accountName}）: [${status}] ${serverMessage}` }
    }

    return { errorMessage: `AWS認証情報の取得に失敗しました（${accountName}）: HTTP ${status}` }
  }
  return { errorMessage: `AWS認証情報の取得に失敗しました（${accountName}）: ${getErrorMessage(error)}` }
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
  if (!accounts?.length) return { errors: [], ssoAuthRequired: [] }

  const projectCode = projectConfig.project.projectCode
  const { writeAwsCredentials, buildAwsProfileEnv, cleanupAwsCredentials } = await import('./aws-profile')
  const credentialMap = new Map<string, import('./types').AwsCredentials>()
  const errors: string[] = []
  const ssoAuthRequired: SsoAuthRequiredInfo[] = []

  // Each account's credentials come from an independent API call, so fetch
  // them concurrently instead of paying N round trips back-to-back at chat
  // startup. Every entry catches its own error (never rejects) so Promise.all
  // always resolves with one result per account, in the original account
  // order — keeping `errors`/`ssoAuthRequired` deterministic regardless of
  // which fetch actually finishes first. `ok` is an explicit discriminant
  // (rather than relying on structural `'creds' in result` narrowing) so the
  // fulfilled/failed branches stay unambiguous to the type checker.
  const fetched = await Promise.all(
    accounts.map(async (account) => {
      try {
        logger.info(`[chat] Fetching AWS credentials for profile: ${account.name} (${account.id})`)
        const creds = await client.getAwsCredentials(account.id)
        return { ok: true as const, account, creds }
      } catch (error) {
        return { ok: false as const, account, error }
      }
    }),
  )

  for (const result of fetched) {
    if (result.ok) {
      credentialMap.set(result.account.name, result.creds)
      continue
    }
    const { errorMessage, ssoInfo } = extractAwsCredentialError(result.error, result.account.name)
    errors.push(errorMessage)
    if (ssoInfo) {
      ssoAuthRequired.push(ssoInfo)
    }
    logger.warn(`[chat] Failed to get AWS credentials for ${result.account.name}: ${getErrorMessage(result.error)}`)
  }

  if (credentialMap.size === 0) return { errors, ssoAuthRequired }

  // credentials ファイルに書き込み（呼び出しごとに一意なパス。並行実行される
  // 別のチャットコマンドのファイルと衝突しない）
  const credentialsPath = writeAwsCredentials(projectDir, projectCode, credentialMap)
  if (!credentialsPath) {
    // 書き込み失敗時は env を提供せず、cleanup も無害な no-op にする。
    // 利用者への通知（sendAwsCredentialNotices 経由）に載せるため errors にも記録する。
    errors.push('AWS認証情報ファイルの書き込みに失敗しました')
    return { errors, ssoAuthRequired, cleanup: () => {} }
  }

  // デフォルトアカウントを特定
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0]

  const env = buildAwsProfileEnv(
    projectDir,
    projectCode,
    credentialsPath,
    defaultAccount.name,
    defaultAccount.region,
  )

  return { env, errors, ssoAuthRequired, cleanup: () => cleanupAwsCredentials(credentialsPath) }
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
  if (!awsAccountId) return { errors: [], ssoAuthRequired: [] }

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
    return { env, errors: [], ssoAuthRequired: [], cleanup: () => {} }
  } catch (error) {
    const { errorMessage, ssoInfo } = extractAwsCredentialError(error, awsAccountId)
    const ssoAuthRequired: SsoAuthRequiredInfo[] = ssoInfo ? [ssoInfo] : []
    logger.warn(`[chat] Failed to get AWS credentials: ${getErrorMessage(error)}`)
    return { errors: [errorMessage], ssoAuthRequired, cleanup: () => {} }
  }
}
