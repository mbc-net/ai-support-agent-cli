import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'

import type { ApiClient } from './api-client'
import {
  GIT_CHECKOUT_TIMEOUT,
  GIT_CLONE_TIMEOUT,
  GIT_CONFIG_TIMEOUT,
  GIT_FETCH_TIMEOUT,
  SSH_NO_HOST_CHECK_FLAGS,
} from './constants'
import { extractHostFromUrl } from './git-credential-setup'
import { logger } from './logger'
import type { ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'
import { GENERAL_KNOWN_HOSTS_ID, resolveKnownHostsPath } from './utils/known-hosts-store'
import { normalizePemKey } from './utils/pem-key'
import { createSecureTempFile, safeUnlink } from './utils/temp-file'

const execFileAsync = promisify(execFile)

function validateBranchName(branch: string): void {
  if (branch.startsWith('-')) {
    throw new Error(`Invalid branch name: "${branch}"`)
  }
}

/**
 * Run a `git` subcommand with the auth env merged on top of process.env.
 *
 * Collapses the `execFileAsync('git', args, { [cwd,] env: { ...process.env, ...env }, timeout })`
 * idiom that was duplicated across clone/checkout/fetch/reset calls. Centralising
 * it guarantees every git invocation gets the same env-merge and an explicit
 * timeout, so a new call site cannot accidentally drop the auth env or run
 * without a timeout.
 */
export async function runGit(
  args: string[],
  options: { env: Record<string, string>; timeout: number; cwd?: string },
): Promise<void> {
  await execFileAsync('git', args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...options.env },
    timeout: options.timeout,
  })
}

/**
 * Whether `repoDir` is already registered in the current $HOME's global
 * safe.directory list. `git config --global --add` never deduplicates, so
 * callers must check first — otherwise a long-running session that syncs
 * the same repository repeatedly (pullRepository on every sync, or the
 * `sync_repository` MCP tool) grows ~/.gitconfig by one line per call
 * forever. Any failure to read the list (no entries yet — exit 1 — or a
 * genuine error) is treated as "not registered" so the caller falls through
 * to registering it; worst case is one redundant --add, not a skipped one.
 */
async function isSafeDirectoryRegistered(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--get-all', 'safe.directory'], {
      env: { ...process.env },
      timeout: GIT_CONFIG_TIMEOUT,
    })
    return stdout.split('\n').map((line) => line.trim()).includes(repoDir)
  } catch {
    return false
  }
}

/**
 * Trust `repoDir` for git commands under the current UID.
 *
 * git 2.35.2+ refuses to run inside a repository owned by a different UID
 * ("detected dubious ownership") unless explicitly trusted via
 * safe.directory. docker/entrypoint.sh registers whatever repos already
 * exist under the workspace at container start, but repos synced here
 * (server-setup git-sync, e2e test repositories, project repositories
 * linked via the web UI) can be cloned mid-session, after that scan already
 * ran — so clone/pull must register their own repoDir before running any
 * other git command against it. Always an exact path (never the '*'
 * wildcard), so trust stays scoped to this specific repository.
 */
async function registerSafeDirectory(repoDir: string): Promise<void> {
  if (await isSafeDirectoryRegistered(repoDir)) return
  await runGit(['config', '--global', '--add', 'safe.directory', repoDir], {
    env: {},
    timeout: GIT_CONFIG_TIMEOUT,
  })
}

export interface RepoSyncResult {
  repositoryId: string
  repositoryCode: string
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
        repositoryCode: repo.repositoryCode,
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
  const tenantCode = client.getTenantCode() || undefined

  const repoDir = path.join(reposDir, repo.repositoryCode)

  // レガシーディレクトリ移行: repositoryId → repositoryCode
  const legacyDir = path.join(reposDir, repo.repositoryId)
  if (repo.repositoryId !== repo.repositoryCode && fs.existsSync(legacyDir) && !fs.existsSync(repoDir)) {
    fs.renameSync(legacyDir, repoDir)
    logger.info(`${prefix} Migrated repository directory: ${repo.repositoryId} -> ${repo.repositoryCode}`)
  }

  const gitDir = path.join(repoDir, '.git')

  if (fs.existsSync(gitDir)) {
    // 既存クローン → fetch + checkout + reset
    await pullRepository(repoDir, tenantCode, credentials.repositoryUrl, repo.branch, credentials.authMethod, credentials.authSecret)
    logger.info(`${prefix} Repository updated: ${repo.repositoryName} (${repo.branch})`)
    return {
      repositoryId: repo.repositoryId,
      repositoryCode: repo.repositoryCode,
      repositoryName: repo.repositoryName,
      status: 'updated',
    }
  } else {
    // 新規クローン
    await cloneRepository(
      repoDir,
      tenantCode,
      credentials.repositoryUrl,
      repo.branch,
      credentials.authMethod,
      credentials.authSecret,
    )
    logger.info(`${prefix} Repository cloned: ${repo.repositoryName} (${repo.branch})`)
    return {
      repositoryId: repo.repositoryId,
      repositoryCode: repo.repositoryCode,
      repositoryName: repo.repositoryName,
      status: 'cloned',
    }
  }
}

async function cloneRepository(
  repoDir: string,
  tenantCode: string | undefined,
  repositoryUrl: string,
  branch: string,
  authMethod: string,
  authSecret: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(repoDir), { recursive: true })
  await registerSafeDirectory(repoDir)

  const { env, cleanup } = buildAuthEnv(authMethod, authSecret, tenantCode, repositoryUrl)

  try {
    validateBranchName(branch)
    const cloneUrl = buildCloneUrl(repositoryUrl, authMethod, authSecret)
    // 全ブランチを取得（サポート対象の環境に応じてブランチ切り替えが必要なため）
    await runGit(['clone', '--no-single-branch', cloneUrl, repoDir], {
      env,
      timeout: GIT_CLONE_TIMEOUT,
    })
    // デフォルトブランチをチェックアウト
    await runGit(['checkout', branch], {
      cwd: repoDir,
      env,
      timeout: GIT_CHECKOUT_TIMEOUT,
    })
  } finally {
    cleanup()
  }
}

async function pullRepository(
  repoDir: string,
  tenantCode: string | undefined,
  repositoryUrl: string,
  branch: string,
  authMethod: string,
  authSecret: string,
): Promise<void> {
  await registerSafeDirectory(repoDir)

  const { env, cleanup } = buildAuthEnv(authMethod, authSecret, tenantCode, repositoryUrl)

  try {
    validateBranchName(branch)
    // 全リモートブランチを取得
    await runGit(['fetch', '--all'], {
      cwd: repoDir,
      env,
      timeout: GIT_FETCH_TIMEOUT,
    })

    try {
      await runGit(['checkout', branch], {
        cwd: repoDir,
        env,
        timeout: GIT_CHECKOUT_TIMEOUT,
      })
    } catch {
      // Branch does not exist locally yet — create it tracking the remote branch
      await runGit(['checkout', '-b', branch, `origin/${branch}`], {
        cwd: repoDir,
        env,
        timeout: GIT_CHECKOUT_TIMEOUT,
      })
    }

    await runGit(['reset', '--hard', `origin/${branch}`], {
      cwd: repoDir,
      env,
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
  } catch (error) {
    // Do NOT log the url or the secret — only the failure fact + error message.
    logger.warn('Failed to embed credentials into repo URL', {
      error: getErrorMessage(error),
    })
    return url
  }
}

/**
 * リポジトリコードを指定して単体同期する。
 * overrideBranch を指定した場合は ProjectConfig のブランチを上書きする。
 */
export async function syncRepositoryByCode(
  client: ApiClient,
  repositories: NonNullable<ProjectConfigResponse['repositories']>,
  repositoryCode: string,
  overrideBranch: string | undefined,
  reposDir: string,
  prefix: string,
): Promise<RepoSyncResult> {
  const repo = repositories.find(r => r.repositoryCode === repositoryCode)
  if (!repo) {
    throw new Error(`Repository not found: ${repositoryCode}`)
  }
  const effectiveRepo = overrideBranch ? { ...repo, branch: overrideBranch } : repo
  return syncSingleRepository(client, effectiveRepo, reposDir, prefix)
}

export { normalizePemKey } from './utils/pem-key'

export function buildAuthEnv(
  authMethod: string,
  authSecret: string,
  tenantCode: string | undefined,
  repositoryUrl: string,
): { env: Record<string, string>; cleanup: () => void } {
  if (authMethod !== 'ssh') {
    return { env: {}, cleanup: () => {} }
  }

  let hostCheckFlags = SSH_NO_HOST_CHECK_FLAGS
  if (!tenantCode) {
    logger.warn('[repo-sync] tenantCode is unavailable; falling back to non-TOFU SSH host-key checking')
  } else {
    try {
      const host = extractHostFromUrl(repositoryUrl)
      const sshHostId = host || GENERAL_KNOWN_HOSTS_ID
      hostCheckFlags = `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${resolveKnownHostsPath(tenantCode, sshHostId)}"`
    } catch (error) {
      logger.warn(`[repo-sync] Failed to resolve known_hosts path; falling back to non-TOFU SSH host-key checking: ${getErrorMessage(error)}`)
    }
  }

  const normalizedKey = normalizePemKey(authSecret)
  const tmpKeyPath = createSecureTempFile(normalizedKey, 'ssh-key')

  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i "${tmpKeyPath}" ${hostCheckFlags}`,
    },
    cleanup: () => {
      safeUnlink(tmpKeyPath, `Failed to delete temporary SSH key file: ${tmpKeyPath}`)
    },
  }
}
