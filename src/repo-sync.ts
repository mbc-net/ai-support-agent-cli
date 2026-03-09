import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'

import type { ApiClient } from './api-client'
import { GIT_CHECKOUT_TIMEOUT, GIT_CLONE_TIMEOUT, GIT_FETCH_TIMEOUT } from './constants'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'

const execFileAsync = promisify(execFile)

export interface RepoSyncResult {
  repositoryId: string
  repositoryName: string
  status: 'cloned' | 'updated' | 'skipped'
  error?: string
}

/**
 * プロジェクト設定に含まれるリポジトリを同期（クローンまたは更新）する
 */
export async function syncRepositories(
  client: ApiClient,
  repositories: NonNullable<ProjectConfigResponse['repositories']>,
  reposDir: string,
  prefix: string,
): Promise<RepoSyncResult[]> {
  const results: RepoSyncResult[] = []

  for (const repo of repositories) {
    try {
      const result = await syncSingleRepository(client, repo, reposDir, prefix)
      results.push(result)
    } catch (error) {
      const errorMsg = getErrorMessage(error)
      logger.warn(`${prefix} Repository sync failed for ${repo.repositoryName}: ${errorMsg}`)
      results.push({
        repositoryId: repo.repositoryId,
        repositoryName: repo.repositoryName,
        status: 'skipped',
        error: errorMsg,
      })
    }
  }

  return results
}

async function syncSingleRepository(
  client: ApiClient,
  repo: ProjectConfigResponse['repositories'] extends (infer R)[] | undefined ? R : never,
  reposDir: string,
  prefix: string,
): Promise<RepoSyncResult> {
  // 認証情報をJIT取得
  const credentials = await client.getRepoCredentials(repo.repositoryId)

  const repoDir = path.join(reposDir, repo.repositoryId)
  const gitDir = path.join(repoDir, '.git')

  if (fs.existsSync(gitDir)) {
    // 既存クローン → fetch + checkout + reset
    await pullRepository(repoDir, repo.branch, credentials.authMethod, credentials.authSecret)
    logger.info(`${prefix} Repository updated: ${repo.repositoryName} (${repo.branch})`)
    return {
      repositoryId: repo.repositoryId,
      repositoryName: repo.repositoryName,
      status: 'updated',
    }
  } else {
    // 新規クローン
    await cloneRepository(
      repoDir,
      credentials.repositoryUrl,
      repo.branch,
      credentials.authMethod,
      credentials.authSecret,
    )
    logger.info(`${prefix} Repository cloned: ${repo.repositoryName} (${repo.branch})`)
    return {
      repositoryId: repo.repositoryId,
      repositoryName: repo.repositoryName,
      status: 'cloned',
    }
  }
}

async function cloneRepository(
  repoDir: string,
  repositoryUrl: string,
  branch: string,
  authMethod: string,
  authSecret: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(repoDir), { recursive: true })

  const { env, cleanup } = buildAuthEnv(authMethod, authSecret)

  try {
    const cloneUrl = buildCloneUrl(repositoryUrl, authMethod, authSecret)
    // 全ブランチを取得（サポート対象の環境に応じてブランチ切り替えが必要なため）
    await execFileAsync(
      'git',
      ['clone', '--no-single-branch', cloneUrl, repoDir],
      { env: { ...process.env, ...env }, timeout: GIT_CLONE_TIMEOUT },
    )
    // デフォルトブランチをチェックアウト
    await execFileAsync('git', ['checkout', branch], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      timeout: GIT_CHECKOUT_TIMEOUT,
    })
  } finally {
    cleanup()
  }
}

async function pullRepository(
  repoDir: string,
  branch: string,
  authMethod: string,
  authSecret: string,
): Promise<void> {
  const { env, cleanup } = buildAuthEnv(authMethod, authSecret)

  try {
    // 全リモートブランチを取得
    await execFileAsync('git', ['fetch', '--all'], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      timeout: GIT_FETCH_TIMEOUT,
    })

    await execFileAsync('git', ['checkout', branch], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      timeout: GIT_CHECKOUT_TIMEOUT,
    }).catch(() =>
      execFileAsync('git', ['checkout', '-b', branch, `origin/${branch}`], {
        cwd: repoDir,
        env: { ...process.env, ...env },
        timeout: GIT_CHECKOUT_TIMEOUT,
      }),
    )

    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: repoDir,
      env: { ...process.env, ...env },
      timeout: GIT_CHECKOUT_TIMEOUT,
    })
  } finally {
    cleanup()
  }
}

export function buildCloneUrl(
  url: string,
  authMethod: string,
  authSecret: string,
): string {
  if (authMethod === 'ssh') {
    return url
  }

  try {
    const parsed = new URL(url)
    parsed.username = 'x-access-token'
    parsed.password = authSecret
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * PEM形式のSSH秘密鍵を正規化する
 * DBに保存時に改行が除去されている場合、64文字ごとに改行を挿入して修復する
 */
export function normalizePemKey(key: string): string {
  // 既に改行が含まれていればそのまま返す
  if (key.includes('\n')) {
    return key.endsWith('\n') ? key : key + '\n'
  }

  // ヘッダー/フッターを抽出して本体を64文字ごとに折り返す
  const headerMatch = key.match(/^(-----BEGIN [A-Z ]+-----)/)
  const footerMatch = key.match(/(-----END [A-Z ]+-----)$/)
  if (!headerMatch || !footerMatch) {
    return key
  }

  const header = headerMatch[1]
  const footer = footerMatch[1]
  const body = key.slice(header.length, key.length - footer.length)

  const lines = body.match(/.{1,64}/g) || []
  return [header, ...lines, footer, ''].join('\n')
}

export function buildAuthEnv(
  authMethod: string,
  authSecret: string,
): { env: Record<string, string>; cleanup: () => void } {
  if (authMethod !== 'ssh') {
    return { env: {}, cleanup: () => {} }
  }

  const tmpKeyPath = path.join(
    require('os').tmpdir(),
    `ssh-key-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  const normalizedKey = normalizePemKey(authSecret)
  fs.writeFileSync(tmpKeyPath, normalizedKey, { mode: 0o600 })

  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i "${tmpKeyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
    },
    cleanup: () => {
      try {
        fs.unlinkSync(tmpKeyPath)
      } catch {
        logger.warn(`Failed to delete temporary SSH key file: ${tmpKeyPath}`)
      }
    },
  }
}
