/**
 * AWS 認証情報を `AWS_*` 環境変数の Record に変換する。
 *
 * `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION` を常に設定し、
 * `sessionToken` があれば `AWS_SESSION_TOKEN` を追加する。process.env と合成したい
 * 場合は呼び出し側で `{ ...process.env, ...buildAwsCredentialEnv(creds, region) }`
 * のようにスプレッドする（本関数は AWS_* の4キーのみを返す）。
 */
export function buildAwsCredentialEnv(
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  region: string,
): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_DEFAULT_REGION: region,
    ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
  }
}
