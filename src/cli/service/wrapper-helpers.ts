import * as fs from 'fs'

import { getProjectList, loadConfig } from '../../config-manager'
import { t } from '../../i18n'
import { logger } from '../../logger'
import { isProjectCodeSafe, validateBindMountPathSync } from '../../security'
import type { ProjectRegistration } from '../../types'
import { projectKey } from '../../project-key'
import { ensureDir, sanitizeNameSegment } from '../../utils'
import {
  getProjectConfigHostDir,
  getProjectServiceDir,
  getServicesDir,
} from '../../utils/path-utils'
import { IMAGE_NAME } from '../../docker/docker-utils'
import {
  type AgentCredentialEnv,
  readAgentCredentialEnv,
} from './agent-credential-env'

// Re-export the projectCode validators that now live in `src/security.ts` so
// existing call sites (linux-service / darwin-service) can continue to import
// them from here. The actual implementations moved to avoid a layering
// inversion (the docker supervisor also needs them).
export { assertProjectCodeIsSafe, isProjectCodeSafe } from '../../security'

// Re-export toContainerApiUrl from utils so that callers (darwin-service,
// linux-service, win32-service) can continue to import it from here without
// change.  The canonical implementation lives in utils.ts so that
// volume-mount-builder.ts can share it without a cli/ → docker/ layering
// inversion.
export { toContainerApiUrl } from '../../utils'

// Re-export shellQuote from utils so existing callers (darwin-service,
// linux-service, service-template-helpers) can keep importing it from here.
// The canonical implementation moved to `src/utils/shell-quote.ts` so that
// `terminal/` can share it without a terminal/ → cli/service/ layering
// inversion.
export { shellQuote } from '../../utils/shell-quote'

/**
 * Sanitize one tenantCode / projectCode segment for use in generated names:
 * lowercase, with every character outside `[a-z0-9-]` collapsed to `-`.
 *
 * Shared by all three platforms so naming cannot drift: systemd unit names
 * and per-project log-dir keys (linux), docker container names (all
 * platforms), and scheduled-task names (win32). `detectInstallCollisions`
 * relies on its callers deriving names through this same mapping.
 *
 * Thin service-layer alias for the canonical `sanitizeNameSegment` in
 * `utils.ts`; the name is retained so the service-installer call sites read
 * intentfully ("service name segment").
 */
export function sanitizeServiceNameSegment(s: string): string {
  return sanitizeNameSegment(s)
}

/**
 * Validate a user-supplied `project.projectDir` for use as a bind mount.
 *
 * Returns the original value when the path is acceptable, or `undefined`
 * when it should be dropped (and the wrapper / supervisor should fall back
 * to the default per-project dir). Emits a warning so the user is aware
 * that their configured projectDir was ignored.
 *
 * Rejects: empty string, non-existent paths, and paths under
 * `BLOCKED_PATH_PREFIXES` / `getSensitiveHomePaths` (e.g. `/etc`,
 * `~/.ssh`). All three reasons end up at the same fallback to keep the
 * caller code simple.
 */
export function validateProjectDirForMount(projectDir: string | undefined): string | undefined {
  if (!projectDir) return undefined
  if (!fs.existsSync(projectDir)) {
    logger.warn(t('service.projectDirMissing', { path: projectDir }))
    return undefined
  }
  const blockedError = validateBindMountPathSync(projectDir)
  if (blockedError) {
    logger.warn(t('service.projectDirBlocked', { path: projectDir, message: blockedError }))
    return undefined
  }
  return projectDir
}

export interface CollisionInfo {
  /** The conflicting unit name / plist label (already sanitized). */
  name: string
  /** Other configured `<tenantCode>/<projectCode>` tuples mapping to the same name. */
  others: string[]
  /**
   * True when this FQN appears more than once in config (literal
   * duplicate entry). The caller should surface a different message in
   * that case ("remove the duplicate row" vs. "rename one of the codes").
   * `isDuplicate` and `others.length > 0` can BOTH be true when a config
   * contains both a literal duplicate AND a sanitize-collision sibling
   * (e.g. `[mbc/MBC_01, mbc/MBC_01, mbc/MBC-01]`).
   */
  isDuplicate: boolean
}

export interface CollisionDetectionResult {
  /**
   * FQN (`<tenantCode>/<projectCode>`) → sanitized unit-name / plist-label
   * for every project that passed `isProjectCodeSafe`. Callers that need
   * the sanitized name later (orphan-protection sets, unit-file paths)
   * can read it from here instead of recomputing via `nameFn`.
   */
  names: Map<string, string>
  /**
   * FQN → CollisionInfo for projects that conflict with another
   * configured entry (sanitize-collision and/or literal duplicate).
   * Projects without conflict are absent from this map.
   */
  collisions: Map<string, CollisionInfo>
}

/**
 * Detect sanitizeServiceNameSegment() collisions across configured projects.
 *
 * `nameFn` derives the per-platform unit-name / plist-label from
 * (tenantCode, projectCode). Codes that fail `isProjectCodeSafe` are
 * skipped from collision counting (they're refused independently by
 * `writeProjectServiceFiles`, and including them here would falsely
 * collide with a valid sibling like `MBC;01` + `MBC-01`).
 *
 * The returned `names` map covers ALL projects that passed validation
 * (single source of truth — callers should not recompute via `nameFn`
 * again). The `collisions` map only includes FQNs with a conflict.
 *
 * Shared between linux-service and darwin-service to keep the two
 * platforms from drifting on collision semantics.
 */
export function detectInstallCollisions(
  projects: ProjectRegistration[],
  nameFn: (tenantCode: string, projectCode: string) => string,
): CollisionDetectionResult {
  const names = new Map<string, string>()
  // First pass: bucket FQN tuples by sanitized name, skipping unsafe codes.
  // Keep duplicate FQNs in the array so we can detect literal duplicates
  // (`fqns.length > uniqueFqns.length`) independently of sanitize-collisions.
  const nameToFqns = new Map<string, string[]>()
  for (const project of projects) {
    if (!isProjectCodeSafe(project.tenantCode) || !isProjectCodeSafe(project.projectCode)) continue
    const name = nameFn(project.tenantCode, project.projectCode)
    const fqn = projectKey(project)
    names.set(fqn, name)
    const existing = nameToFqns.get(name)
    if (existing) existing.push(fqn)
    else nameToFqns.set(name, [fqn])
  }
  // Second pass: report a CollisionInfo entry for any FQN involved in a
  // sanitize-collision OR a literal duplicate.
  const collisions = new Map<string, CollisionInfo>()
  for (const [name, fqns] of nameToFqns) {
    const uniqueFqns = Array.from(new Set(fqns))
    // No conflict at all: one entry, listed once.
    if (fqns.length === 1) continue
    // Count occurrences per FQN to detect literal duplicates.
    const fqnCounts = new Map<string, number>()
    for (const fqn of fqns) fqnCounts.set(fqn, (fqnCounts.get(fqn) ?? 0) + 1)
    for (const fqn of uniqueFqns) {
      const others = uniqueFqns.filter((f) => f !== fqn)
      const isDuplicate = (fqnCounts.get(fqn) ?? 0) > 1
      collisions.set(fqn, { name, others, isDuplicate })
    }
  }
  return { names, collisions }
}

/**
 * Log the install-time collision error for one project, deduped so an
 * N-times-listed entry doesn't produce N identical error lines.
 *
 * Picks the more actionable message: literal duplicates ask the user to
 * "remove the duplicate row"; sanitize-collisions ask them to "rename one of
 * the projectCodes". A single config can exhibit BOTH at once (the duplicate
 * row AND a sibling that collides); when that happens we want both hints to
 * fire — so the dedup key is the (name, messageKey) tuple, not just the name.
 * Otherwise the row-order of config would silently decide which hint the
 * user sees.
 *
 * `reported` is owned by the caller so the dedup scope is one install run.
 * Shared by all three platforms (linux unit names, darwin plist labels,
 * win32 scheduled-task names) so the collision semantics cannot drift.
 */
export function reportInstallCollision(
  projectCode: string,
  collision: CollisionInfo,
  reported: Set<string>,
): void {
  const messageKey = collision.isDuplicate
    ? 'service.projectDuplicateEntry'
    : 'service.projectUnitNameCollision'
  const dedupKey = `${collision.name}\x00${messageKey}`
  if (reported.has(dedupKey)) return
  logger.error(t(messageKey, {
    projectCode,
    unitName: collision.name,
    others: collision.others.join(', '),
  }))
  reported.add(dedupKey)
}

/**
 * Emit the post-install hints (how to start, where the logs live, and that
 * there is no log rotation).
 *
 * The caller decides WHETHER to emit them — each platform counts successful
 * installs differently (`installedCount` vs `writtenUnits.length`) — but the
 * lines themselves must stay identical across platforms, so they live here.
 */
export function logPostInstallHints(logDir: string): void {
  logger.info(t('service.loadHintMulti'))
  logger.info(t('service.logDir', { path: logDir }))
  logger.info(t('service.noLogRotation'))
}

/**
 * ラッパースクリプト生成に渡す、プラットフォーム共通のオプション。
 *
 * linux / darwin / win32 の各インストーラが同じ 9 項目を組み立てていた。
 * 特に `...readAgentCredentialEnv()` の展開を 1 つのプラットフォームで
 * 書き忘れると、そのプラットフォームだけ ANTHROPIC_API_KEY 等を持たない
 * コンテナが起動する。**コンテナ自体は正常に起動する**ので、症状は実行時に
 * チャットが失敗する形でしか出ない。
 *
 * `updateScriptPath` / `logDir` は win32 のラッパーが受け取らないため、
 * 必要なプラットフォームだけが呼び出し側で足す。
 */
export interface WrapperScriptBaseOptions extends AgentCredentialEnv {
  imageName: string
  tenantCode: string
  projectCode: string
  projectConfigHostDir: string
  projectDir?: string
  token: string
  apiUrl: string
  verbose?: boolean
}

/**
 * 各インストーラが `generateWrapperScript` / `generateWin32WrapperScript` に
 * 渡す共通部分を組み立てる。
 *
 * 認証情報は**ここで一度だけ** `readAgentCredentialEnv()` から読む。
 */
export function buildWrapperScriptBaseOptions(params: {
  tenantCode: string
  projectCode: string
  projectConfigHostDir: string
  projectDir?: string
  project: Pick<ProjectRegistration, 'token' | 'apiUrl'>
  verbose?: boolean
}): WrapperScriptBaseOptions {
  return {
    imageName: IMAGE_NAME,
    tenantCode: params.tenantCode,
    projectCode: params.projectCode,
    projectConfigHostDir: params.projectConfigHostDir,
    projectDir: params.projectDir,
    token: params.project.token,
    apiUrl: params.project.apiUrl,
    ...readAgentCredentialEnv(),
    verbose: params.verbose,
  }
}

/**
 * サービスファイルを書き出す前に必要なディレクトリを用意し、
 * プロジェクトディレクトリの妥当性を検証する。
 *
 * 3 つのインストーラが逐語で同じ 3 手順を持っていた。特に
 * `validateProjectDirForMount` を落とすと、空・不存在・ブロック対象
 * （`/etc`・`~/.ssh` 等）のパスがそのまま `-v <bad>:/workspace/...:rw` として
 * 出力され、起動失敗かホストの機密のコンテナ露出につながる。
 *
 * @returns 書き出し先と、マウントに使ってよいと判断されたプロジェクトディレクトリ
 */
export function prepareProjectServiceDirs(params: {
  projectKey: string
  tenantCode: string
  projectCode: string
  projectDir?: string
}): {
  projectServiceDir: string
  projectConfigHostDir: string
  validatedProjectDir: string | undefined
} {
  const projectServiceDir = getProjectServiceDir(
    getServicesDir(),
    params.projectKey,
  )
  ensureDir(projectServiceDir, 0o700)

  const projectConfigHostDir = getProjectConfigHostDir(
    params.tenantCode,
    params.projectCode,
  )
  ensureDir(projectConfigHostDir, 0o700)

  return {
    projectServiceDir,
    projectConfigHostDir,
    validatedProjectDir: validateProjectDirForMount(params.projectDir),
  }
}

/**
 * 設定から登録済みプロジェクト一覧を読み、1 件も無ければ理由をログに出して
 * `null` を返す。
 *
 * linux / darwin / win32 の 3 つのインストーラが `install()` の冒頭で同じ
 * 8 行を持っていた。「設定が無い」と「プロジェクトが 0 件」は利用者から見れば
 * 同じ状況（何もインストールできない）なので、両方をここで空扱いに畳む。
 *
 * 呼び出し側は `if (!projects) return` で中断する。空配列ではなく `null` を
 * 返すのは、**中断すべきかどうかを呼び出し側が判定し直さずに済ませる**ため。
 * 空配列を返すと、各インストーラが再び `projects.length === 0` を書くことに
 * なり、そのときログ出力を添え忘れれば「何も起きずに正常終了した」ように
 * 見える。
 */
export function loadConfiguredProjectsOrReport(): ProjectRegistration[] | null {
  const config = loadConfig()
  const projects = config ? getProjectList(config) : []

  if (projects.length === 0) {
    logger.error(t('service.noProjectsConfigured'))
    return null
  }

  return projects
}
