/**
 * サーバーセットアップ実行前に、レシピが参照する共有ファイルをコントローラ側へ
 * 取り寄せる（ステージングする）処理。
 *
 * レシピ本体では `ansible.builtin.copy` の `src`（コントローラ側ローカルパス）を
 * 禁止している。許すと、レシピからエージェント自身のトークンや SSH 秘密鍵を対象
 * サーバーへ配布できてしまうためである。その安全な代替が `shared_file` ロールで、
 * 「プロジェクトの共有ファイルとしてアップロード済みのものだけ」を配布できる。
 *
 * 実現には、playbook を走らせる**前**に対象ファイルを決めて取り寄せる必要がある。
 * そのため `shared_file_src` は静的に決定できるリテラルに限定しており
 * （`ansible-task-guard.ts` の `isValidSharedFileSrc`）、ここではその値を body から
 * 集めてダウンロードする。
 *
 * 取得経路はエージェント向けの既存 API（`listProjectFiles` /
 * `getProjectFileDownloadUrl`）をそのまま使う。テナント・プロジェクトはサーバー側が
 * エージェントトークンから解決するため、他プロジェクトのファイルは構造上参照できない。
 */

import { createWriteStream, mkdirSync } from 'fs'
import * as path from 'path'
import { pipeline } from 'stream/promises'

import axios from 'axios'
import type { Readable } from 'stream'

import type { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { ProjectSharedFileEntry } from '../types'
import { getErrorMessage } from '../utils'
import { isPlainObject } from '../utils/is-plain-object'

/**
 * ステージング先ディレクトリをロールへ渡す extra-var 名。
 *
 * ロールの `defaults/main.yml` の同名変数を上書きする。テナントの `ANSIBLE#` 変数と
 * 衝突しないよう、runner は変数展開のあとにこのキーを書き込む。
 */
export const SHARED_FILE_STAGING_DIR_VAR = 'shared_file_staging_dir'

/** ステージング対象を指定するロール変数名。 */
export const SHARED_FILE_SRC_VAR = 'shared_file_src'

/** 共有ファイル配布ロールの名前。 */
export const SHARED_FILE_ROLE_NAME = 'shared_file'

/**
 * 1 ファイルあたりの上限。
 *
 * 上限はロール変数にしない。レシピ側から緩められると、エージェントのディスクを
 * 埋める操作をレシピ作成者が自由に行えることになるため。
 */
export const SHARED_FILE_MAX_FILE_BYTES = 500 * 1024 * 1024

/** 1 実行あたりの合計上限。 */
export const SHARED_FILE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024

const INCLUDE_ROLE_KEYS = ['include_role', 'ansible.builtin.include_role'] as const
const NESTED_TASK_KEYS = ['block', 'rescue', 'always'] as const

/** 末尾スラッシュと前後空白を落として比較・結合に使える形へ揃える。 */
function normalizeSource(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function roleNameOf(task: Record<string, unknown>): string | undefined {
  for (const key of INCLUDE_ROLE_KEYS) {
    const args = task[key]
    if (isPlainObject(args) && typeof args.name === 'string') return args.name
  }
  return undefined
}

/**
 * body タスク列から、配布対象として指定された共有ファイルのパスを集める。
 *
 * `block` / `rescue` / `always` の入れ子も走査する。値が文字列でないものは無視する
 * （ガードが別途拒否するため、ここで二重にエラーにしない）。重複は取り除き、
 * 記述順を保つ。
 */
export function collectSharedFileSources(
  tasks: readonly unknown[],
): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const walk = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (!isPlainObject(item)) continue
      const task = item as Record<string, unknown>

      if (roleNameOf(task) === SHARED_FILE_ROLE_NAME) {
        const vars = task.vars
        const raw = isPlainObject(vars) ? vars[SHARED_FILE_SRC_VAR] : undefined
        if (typeof raw === 'string') {
          const normalized = normalizeSource(raw)
          if (normalized.length > 0 && !seen.has(normalized)) {
            seen.add(normalized)
            found.push(normalized)
          }
        }
      }

      for (const key of NESTED_TASK_KEYS) {
        const nested = task[key]
        if (Array.isArray(nested)) walk(nested)
      }
    }
  }

  walk(tasks)
  return found
}

export interface StageSharedFilesInput {
  client: ApiClient
  /** `collectSharedFileSources` が返した共有ファイルの相対パス。 */
  sources: readonly string[]
  /** 保存先（実行ごとの一時ディレクトリ配下）。 */
  stagingDir: string
}

/** 親ディレクトリのパス（ルート直下は空文字列）。 */
function parentPathOf(filePath: string): string {
  const index = filePath.lastIndexOf('/')
  return index < 0 ? '' : filePath.slice(0, index)
}

async function listOrThrow(
  client: ApiClient,
  dirPath: string,
): Promise<ProjectSharedFileEntry[]> {
  const response = await client.listProjectFiles(dirPath || undefined)
  if (response.truncated) {
    // 黙って取りこぼすと「一部のファイルだけが配布された」状態になり、
    // 配布物の欠落として現れる。件数上限に達したことを利用者へ返す。
    throw new Error(
      `Shared file listing was truncated at "${dirPath || '(root)'}" ` +
        `(limit: ${response.limit}). Reduce the number of entries in that folder.`,
    )
  }
  return response.entries
}

/** 指定パスのエントリ（ファイル/フォルダ）を親ディレクトリの一覧から特定する。 */
async function resolveEntry(
  client: ApiClient,
  sourcePath: string,
): Promise<ProjectSharedFileEntry> {
  const entries = await listOrThrow(client, parentPathOf(sourcePath))
  const entry = entries.find((candidate) => candidate.path === sourcePath)
  if (!entry) {
    throw new Error(
      `Shared file not found: "${sourcePath}". ` +
        'Upload it under the project shared files, or fix shared_file_src.',
    )
  }
  return entry
}

/** 配布対象のファイルを、フォルダ指定なら再帰的に列挙する。 */
async function collectFileEntries(
  client: ApiClient,
  sourcePath: string,
): Promise<ProjectSharedFileEntry[]> {
  const entry = await resolveEntry(client, sourcePath)
  if (entry.type === 'file') return [entry]

  const files: ProjectSharedFileEntry[] = []
  const walk = async (dirPath: string): Promise<void> => {
    for (const child of await listOrThrow(client, dirPath)) {
      if (child.type === 'directory') {
        await walk(child.path)
      } else {
        files.push(child)
      }
    }
  }
  await walk(entry.path)
  return files
}

/**
 * 保存先がステージングディレクトリの中に収まることを確認する。
 *
 * `path` は API 側で検証済み（`assertSafeProjectFilePath`）だが、保存先の組み立ては
 * こちらの責務である。応答が壊れた・改変された場合にエージェントホストの任意パスへ
 * 書けてしまう経路を、多層防御としてここでも塞ぐ。
 */
function assertWithinStagingDir(
  stagingDir: string,
  destination: string,
  filePath: string,
): void {
  const root = path.resolve(stagingDir)
  const resolved = path.resolve(destination)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to stage "${filePath}": it resolves outside the staging directory.`,
    )
  }
}

function assertWithinLimits(files: readonly ProjectSharedFileEntry[]): void {
  let total = 0
  for (const file of files) {
    const size = file.size ?? 0
    if (size > SHARED_FILE_MAX_FILE_BYTES) {
      throw new Error(
        `Shared file "${file.path}" is too large: ${size} bytes ` +
          `(max ${SHARED_FILE_MAX_FILE_BYTES} bytes per file).`,
      )
    }
    total += size
  }
  if (total > SHARED_FILE_MAX_TOTAL_BYTES) {
    throw new Error(
      `Shared files total ${total} bytes, which exceeds the per-run limit of ` +
        `${SHARED_FILE_MAX_TOTAL_BYTES} bytes.`,
    )
  }
}

/**
 * 1 ファイルをステージングディレクトリへストリーミング保存する。
 *
 * 数百MB を想定するため、メモリへ載せずに `pipeline` でディスクへ流す
 * （`commands/file-transfer.ts` の添付ダウンロードと同じ方式）。
 * 署名付き URL は**ログに出さない**。短命とはいえ、URL 単体でファイルを取得できる。
 */
async function downloadTo(
  client: ApiClient,
  file: ProjectSharedFileEntry,
  stagingDir: string,
): Promise<void> {
  const { downloadUrl } = await client.getProjectFileDownloadUrl(file.path)
  const destination = path.join(stagingDir, file.path)
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })

  const response = await axios.get<Readable>(downloadUrl, {
    responseType: 'stream',
  })
  // 0600: 配布物には秘密鍵や認証情報を含み得る。エージェントホストの他ユーザーから
  // 読めない状態で置き、実行後に一時ディレクトリごと削除する。
  await pipeline(response.data, createWriteStream(destination, { mode: 0o600 }))
}

/**
 * レシピが参照する共有ファイルをステージングディレクトリへ取り寄せる。
 *
 * 失敗時は例外を投げる。呼び出し側は playbook を実行せずに失敗させること
 * （不完全な配布物のまま実行すると、対象サーバーが中途半端な状態になる）。
 */
export async function stageSharedFiles({
  client,
  sources,
  stagingDir,
}: StageSharedFilesInput): Promise<void> {
  if (sources.length === 0) return

  const files: ProjectSharedFileEntry[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    for (const file of await collectFileEntries(client, source)) {
      // 同じファイルが複数の指定に含まれることがある（フォルダとその中のファイル）。
      // 二重ダウンロードを避ける。
      if (seen.has(file.path)) continue
      seen.add(file.path)
      files.push(file)
    }
  }

  // ダウンロードを始める前に、保存先と上限を判定する。流し始めてから落とすと、
  // 途中まで書いたファイルでディスクを消費したうえで失敗することになる。
  for (const file of files) {
    assertWithinStagingDir(
      stagingDir,
      path.join(stagingDir, file.path),
      file.path,
    )
  }
  assertWithinLimits(files)

  logger.info(
    `[server-setup] Staging ${files.length} shared file(s) for distribution`,
  )
  for (const file of files) {
    try {
      await downloadTo(client, file, stagingDir)
    } catch (error: unknown) {
      throw new Error(
        `Failed to stage shared file "${file.path}": ${getErrorMessage(error)}`,
      )
    }
  }
}
