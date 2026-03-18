import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { ApiClient } from './api-client'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'
import { normalizePemKey } from './utils/pem-key'
import { createSecureTempFile } from './utils/temp-file'

export interface GitCredentialResult {
  env: Record<string, string>
  cleanup: () => void
}

/**
 * リポジトリURLからホスト名を抽出する
 * SSH: git@gitlab.com:org/repo.git → gitlab.com
 * HTTPS: https://github.com/org/repo.git → github.com
 */
export function extractHostFromUrl(url: string): string {
  // SSH形式: git@host:path
  const sshMatch = url.match(/^[^@]+@([^:]+):/)
  if (sshMatch) {
    return sshMatch[1]
  }

  // HTTPS形式
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * リポジトリURLからパスを抽出する（credential helper のマッチング用）
 * SSH: git@gitlab.com:org/repo.git → org/repo.git
 * HTTPS: https://github.com/org/repo.git → org/repo.git
 */
export function extractPathFromUrl(url: string): string {
  // SSH形式: git@host:path
  const sshMatch = url.match(/^[^@]+@[^:]+:(.+)$/)
  if (sshMatch) {
    return sshMatch[1]
  }

  // HTTPS形式
  try {
    const parsed = new URL(url)
    // 先頭の / を除去
    return parsed.pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

/**
 * SSHラッパースクリプトを生成する
 * ホスト名に応じて適切なSSH鍵を選択する
 */
export function buildSshWrapperScript(entries: { host: string; keyPath: string }[]): string {
  const cases = entries.map((entry) =>
    `  ${entry.host})\n    exec ssh -i "${entry.keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$@"\n    ;;`,
  ).join('\n')

  return `#!/bin/sh
# Extract hostname from ssh arguments
# Git calls: ssh [options...] user@host command
# Find the first non-option argument and extract host from user@host
HOST=""
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *)
      HOST=$(echo "$arg" | sed 's/.*@//')
      break
      ;;
  esac
done

case "$HOST" in
${cases}
  *)
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$@"
    ;;
esac
`
}

/**
 * Git credential helper スクリプトを生成する
 * stdin から protocol/host/path を読み取り、一致するリポジトリのトークンを返す
 */
export function buildCredentialHelperScript(entries: { host: string; pathPrefix: string; token: string }[]): string {
  const conditions = entries.map((entry) => {
    return `  if [ "$host" = "${entry.host}" ]; then
    case "$path" in
      ${entry.pathPrefix}*)
        echo "protocol=$protocol"
        echo "host=$host"
        echo "username=x-access-token"
        echo "password=${entry.token}"
        exit 0
        ;;
    esac
  fi`
  }).join('\n')

  return `#!/bin/sh
# Git credential helper - reads protocol/host/path from stdin
# Only respond to 'get' operation (ignore 'store' and 'erase')
if [ "$1" != "get" ]; then
  exit 0
fi

protocol=""
host=""
path=""

while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
    path) path="$value" ;;
  esac
done

${conditions}
`
}

/**
 * プロジェクトのリポジトリ認証情報をセットアップし、
 * Claude Code サブプロセスに渡す環境変数とクリーンアップ関数を返す
 */
export async function buildGitCredentialEnv(
  client: ApiClient,
  repositories: NonNullable<ProjectConfigResponse['repositories']>,
): Promise<GitCredentialResult> {
  if (repositories.length === 0) {
    return { env: {}, cleanup: () => {} }
  }

  const tempFiles: string[] = []
  const sshEntries: { host: string; keyPath: string }[] = []
  const httpsEntries: { host: string; pathPrefix: string; token: string }[] = []

  for (const repo of repositories) {
    try {
      const credentials = await client.getRepoCredentials(repo.repositoryId)
      const host = extractHostFromUrl(credentials.repositoryUrl)
      if (!host) {
        logger.warn(`[git-cred] Could not extract host from URL for repository ${repo.repositoryName}`)
        continue
      }

      if (credentials.authMethod === 'ssh') {
        await addSshEntry(credentials.authSecret, host, sshEntries, tempFiles)
      } else {
        const pathPrefix = extractPathFromUrl(credentials.repositoryUrl)
        httpsEntries.push({ host, pathPrefix, token: credentials.authSecret })
      }
    } catch (error) {
      logger.warn(`[git-cred] Failed to get credentials for repository ${repo.repositoryName}: ${getErrorMessage(error)}`)
    }
  }

  const env: Record<string, string> = {}

  // SSH ラッパースクリプト
  if (sshEntries.length > 0) {
    const wrapperPath = writeTempScript(buildSshWrapperScript(sshEntries), 'git-ssh-wrapper')
    tempFiles.push(wrapperPath)
    env.GIT_SSH_COMMAND = wrapperPath
  }

  // HTTPS credential helper
  if (httpsEntries.length > 0) {
    const helperPath = writeTempScript(buildCredentialHelperScript(httpsEntries), 'git-credential-helper')
    tempFiles.push(helperPath)
    // GIT_CONFIG_COUNT + GIT_CONFIG_KEY_N + GIT_CONFIG_VALUE_N で credential.helper を設定
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'credential.helper'
    env.GIT_CONFIG_VALUE_0 = `!${helperPath}`
  }

  const cleanup = () => {
    for (const filePath of tempFiles) {
      try {
        fs.unlinkSync(filePath)
      } catch {
        logger.warn(`[git-cred] Failed to delete temporary file: ${filePath}`)
      }
    }
  }

  return { env, cleanup }
}

async function addSshEntry(
  authSecret: string,
  host: string,
  sshEntries: { host: string; keyPath: string }[],
  tempFiles: string[],
): Promise<void> {
  const normalizedKey = normalizePemKey(authSecret)
  const tmpKeyPath = createSecureTempFile(normalizedKey, 'ssh-key')
  tempFiles.push(tmpKeyPath)
  sshEntries.push({ host, keyPath: tmpKeyPath })
}

function writeTempScript(content: string, prefix: string): string {
  const scriptPath = path.join(
    os.tmpdir(),
    `${prefix}-${crypto.randomBytes(16).toString('hex')}.sh`,
  )
  fs.writeFileSync(scriptPath, content, { mode: 0o700 })
  return scriptPath
}
