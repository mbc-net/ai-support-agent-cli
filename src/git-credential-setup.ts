import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'

import type { ApiClient } from './api-client'
import { SSH_NO_HOST_CHECK_FLAGS } from './constants'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { atomicWriteFile, getErrorMessage } from './utils'
import { GENERAL_KNOWN_HOSTS_ID, resolveKnownHostsPath } from './utils/known-hosts-store'
import { normalizePemKey } from './utils/pem-key'
import { shellQuote } from './utils/shell-quote'
import { createSecureTempFile, safeUnlink } from './utils/temp-file'

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
 * 生成シェルスクリプトへ埋め込む URL 由来値（host / pathPrefix）で拒否する文字。
 * C0 制御文字・空白（U+0000〜U+0020）と DEL。
 *
 * 埋め込み時の注入対策は `shellQuote` が担う（単一引用符で包み、値の中身は
 * すべてリテラルとして扱われる）。したがってここで文字種を allowlist で絞る必要は
 * なく、むしろ絞りすぎると **正規のリポジトリ URL を取りこぼす**：
 *   - 非 ASCII のリポジトリ名は `new URL().pathname` が `%XX` に変換するため `%` を含む
 *   - Bitbucket Server の個人プロジェクト規約は `~username` で `~` を含む
 *   - リポジトリ名に `+` を含む構成もある
 * 取りこぼすと当該リポジトリだけ認証情報が付かず、「private repo の clone が
 * 恒常的に失敗する」という原因の分かりにくい形でしか現れない。
 *
 * 一方、正規のホスト名・リポジトリパスに制御文字や生の空白は現れない（URL パーサは
 * 空白を `%20` に変換する）。これらは生成スクリプトの行構造を壊しうるため、
 * 「URL の取得に失敗した」ケースと同じ扱い（warn + skip）にする。
 */
const UNSAFE_URL_COMPONENT_PATTERN = /[\u0000-\u0020\u007F]/

/** URL 由来値が生成スクリプトへ埋め込める形か */
export function isSafeUrlComponent(value: string): boolean {
  return value.length > 0 && !UNSAFE_URL_COMPONENT_PATTERN.test(value)
}

/**
 * SSHラッパースクリプトを生成する
 * ホスト名に応じて適切なSSH鍵を選択する
 */
export function buildSshWrapperScript(
  entries: { host: string; keyPath: string; knownHostsPath: string | undefined }[],
  fallbackKnownHostsPath: string | undefined,
): string {
  // host / keyPath / knownHostsPath はいずれも設定由来の値なので、シェルのメタ文字が
  // そのまま解釈されないよう単一引用符でクォートしてから埋め込む。ホスト一致判定も
  // `case` パターン（クォートしても glob として解釈される）ではなく `[` の文字列比較で行う。
  const cases = entries.map((entry) => {
    const hostCheckFlags = entry.knownHostsPath
      ? `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shellQuote(entry.knownHostsPath)}`
      : SSH_NO_HOST_CHECK_FLAGS
    return `if [ "$HOST" = ${shellQuote(entry.host)} ]; then\n  exec ssh -i ${shellQuote(entry.keyPath)} ${hostCheckFlags} "$@"\nfi`
  }).join('\n')

  const fallbackFlags = fallbackKnownHostsPath
    ? `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shellQuote(fallbackKnownHostsPath)}`
    : SSH_NO_HOST_CHECK_FLAGS

  return `#!/bin/sh
# Extract hostname from ssh arguments
# Git calls: ssh [options...] user@host command
# Find the first non-option argument and extract host from user@host
# Note: options like -o, -i, -p take a value as the next argument, so we skip those too
HOST=""
SKIP_NEXT=""
for arg in "$@"; do
  if [ -n "$SKIP_NEXT" ]; then
    SKIP_NEXT=""
    continue
  fi
  case "$arg" in
    -o|-i|-p|-l|-E|-F|-c|-D|-b|-e|-I|-J|-L|-m|-O|-Q|-R|-S|-W|-w) SKIP_NEXT=1 ;;
    -*) ;;
    *)
      HOST=$(echo "$arg" | sed 's/.*@//')
      break
      ;;
  esac
done

${cases}
exec ssh ${fallbackFlags} "$@"
`
}

/**
 * Git credential helper スクリプトを生成する
 * stdin から protocol/host/path を読み取り、一致するリポジトリのトークンを返す
 */
export function buildCredentialHelperScript(entries: { host: string; pathPrefix: string; token: string }[]): string {
  // host / pathPrefix / token は設定由来の値。単一引用符でクォートしたうえで
  // シェル変数へ代入し、`case` のパターンは変数展開（`"$prefixN"`）で参照する。
  // `case` のパターン部分は変数を経由しない限りクォートが効かず、`)` や `;;` を
  // 含む値でそのままスクリプトを抜け出せてしまうため。
  // トークンの出力も `echo "...$(...)..."` ではなく `printf '%s\n'` を使う。
  const conditions = entries.map((entry, index) => {
    return `  if [ "$host" = ${shellQuote(entry.host)} ]; then
    prefix${index}=${shellQuote(entry.pathPrefix)}
    token${index}=${shellQuote(entry.token)}
    case "$path" in
      "$prefix${index}"*)
        printf '%s\n' "protocol=$protocol"
        printf '%s\n' "host=$host"
        printf '%s\n' 'username=x-access-token'
        printf '%s\n' "password=$token${index}"
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

  // tenantCode 未確立（''）の場合は undefined 扱いにし、repo-sync.ts の buildAuthEnv と
  // 同じ規約で「テナント不明時は非TOFUにフォールバック」を統一する（テナント間の
  // 意図しない共有ネームスペース化を防ぐ）。
  const tenantCode = client.getTenantCode() || undefined
  const tempFiles: string[] = []
  const sshEntries: { host: string; keyPath: string; knownHostsPath: string | undefined }[] = []
  const httpsEntries: { host: string; pathPrefix: string; token: string }[] = []

  for (const repo of repositories) {
    try {
      const credentials = await client.getRepoCredentials(repo.repositoryId)
      const host = extractHostFromUrl(credentials.repositoryUrl)
      if (!host) {
        logger.warn(`[git-cred] Could not extract host from URL for repository ${repo.repositoryName}`)
        continue
      }
      if (!isSafeUrlComponent(host)) {
        logger.warn(`[git-cred] Host extracted from URL contains unsupported characters for repository ${repo.repositoryName}`)
        continue
      }

      if (credentials.authMethod === 'ssh') {
        await addSshEntry(credentials.authSecret, host, tenantCode, sshEntries, tempFiles)
      } else {
        const pathPrefix = extractPathFromUrl(credentials.repositoryUrl)
        if (!isSafeUrlComponent(pathPrefix)) {
          logger.warn(`[git-cred] Path extracted from URL contains unsupported characters for repository ${repo.repositoryName}`)
          continue
        }
        httpsEntries.push({ host, pathPrefix, token: credentials.authSecret })
      }
    } catch (error) {
      logger.warn(`[git-cred] Failed to get credentials for repository ${repo.repositoryName}: ${getErrorMessage(error)}`)
    }
  }

  const env: Record<string, string> = {}

  // SSH ラッパースクリプト
  if (sshEntries.length > 0) {
    let fallbackKnownHostsPath: string | undefined
    if (!tenantCode) {
      logger.warn('[git-cred] tenantCode is unavailable; falling back to non-TOFU SSH host-key checking for unregistered hosts')
    } else {
      try {
        fallbackKnownHostsPath = resolveKnownHostsPath(tenantCode, GENERAL_KNOWN_HOSTS_ID)
      } catch (error) {
        logger.warn(`[git-cred] Failed to resolve shared known_hosts path; falling back to non-TOFU SSH host-key checking for unregistered hosts: ${getErrorMessage(error)}`)
      }
    }
    const wrapperPath = writeTempScript(
      buildSshWrapperScript(sshEntries, fallbackKnownHostsPath),
      'git-ssh-wrapper',
    )
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
      safeUnlink(filePath, `[git-cred] Failed to delete temporary file: ${filePath}`)
    }
  }

  return { env, cleanup }
}

async function addSshEntry(
  authSecret: string,
  host: string,
  tenantCode: string | undefined,
  sshEntries: { host: string; keyPath: string; knownHostsPath: string | undefined }[],
  tempFiles: string[],
): Promise<void> {
  const normalizedKey = normalizePemKey(authSecret)
  const tmpKeyPath = createSecureTempFile(normalizedKey, 'ssh-key')
  tempFiles.push(tmpKeyPath)
  const knownHostsPath = tenantCode ? resolveKnownHostsPath(tenantCode, host) : undefined
  sshEntries.push({ host, keyPath: tmpKeyPath, knownHostsPath })
}

function writeTempScript(content: string, prefix: string): string {
  const scriptPath = path.join(
    os.tmpdir(),
    `${prefix}-${crypto.randomBytes(16).toString('hex')}.sh`,
  )
  atomicWriteFile(scriptPath, content, 0o700)
  return scriptPath
}
