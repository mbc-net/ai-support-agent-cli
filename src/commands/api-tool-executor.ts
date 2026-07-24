import * as fs from 'fs'
import * as path from 'path'
import { isMainThread } from 'worker_threads'

import picomatch from 'picomatch'

import {
  API_TOOL_GLOB_MAX_RESULTS,
  API_TOOL_GREP_MAX_LINE_CHARS,
  API_TOOL_GREP_MAX_MATCHES,
  API_TOOL_MAX_READABLE_FILE_BYTES,
  API_TOOL_READ_MAX_BYTES,
  API_TOOL_READ_MAX_LINES,
} from '../constants'
import type { AnthropicToolSchema } from '../types'
import { getErrorMessage } from '../utils'

import { runToolInWorker } from './api-tool-worker-runner'

/**
 * Slack Marketplace（`interactionOrigin: 'slack'` かつ `toolPolicy:
 * 'marketplace_read_only'`）の api チャットモードでのみ有効化される、読み取り専用
 * ツール群（Read/Grep/Glob）。Bash 経由の grep/find には一切依存せず、Node 実装で
 * サンドボックス化する（確定方針1・7）。
 *
 * `containPath` がここでの唯一のセキュリティ境界。`..` を含む相対パスの正規化と
 * `fs.realpath` によるシンボリックリンク解決の両方を行い、実体が sandboxRoots
 * （呼び出し元が渡す addDirs 相当、通常は workspace/repos・workspace/docs）の外に
 * 出ていないかを検証する。検証に失敗した場合やファイルが存在しない場合は例外を
 * 投げず、`isError: true` の結果を返す。
 */

/** ツール実行結果（Anthropic tool_result ブロックへ変換する前段） */
export interface ToolExecutionOutcome {
  output: string
  isError: boolean
}

// Grep/Glob のディレクトリ走査で常にスキップする名前。巨大化しやすい
// (node_modules) か、支援エージェントの読み取り調査に無関係な VCS 内部情報 (.git)。
const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])

/**
 * Slack Marketplace の api モード向けツールスキーマを構築する。
 * Claude Code の同名ツール（Read/Grep/Glob）に意味を寄せているが、実装は完全に
 * 独立している。
 */
export function buildReadOnlyToolSchemas(): AnthropicToolSchema[] {
  return [
    {
      name: 'Read',
      description:
        'Reads a file from the allowed project directories and returns its contents as text with 1-based line numbers. Output is truncated if it exceeds 25,000 lines or 500KB.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to read' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'Grep',
      description:
        'Searches file contents within the allowed project directories for a regular expression pattern. Returns up to 200 matches as "file:line:text".',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression pattern to search for' },
          path: { type: 'string', description: 'Optional file or directory to restrict the search to (defaults to all allowed directories)' },
          glob: { type: 'string', description: 'Optional glob pattern to filter which files are searched (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Glob',
      description:
        'Finds files within the allowed project directories whose path matches a glob pattern (e.g. "**/*.ts"). Results are sorted by most recently modified first.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files against' },
          path: { type: 'string', description: 'Optional directory to restrict the search to (defaults to all allowed directories)' },
        },
        required: ['pattern'],
      },
    },
  ]
}

type PathContainment =
  | { ok: true; resolved: string }
  | { ok: false; error: string }

/**
 * 入力パスを解決し、sandboxRoots 配下に実体が収まっていることを検証する。
 * 相対パスは sandboxRoots[0] を基準に解決する。
 *
 * 既知の残課題（今回のスコープ外、対応不要）: このチェック（realpath/stat）と実際の
 * 後続 readFile/readdir との間には TOCTOU（time-of-check-to-time-of-use）レースが
 * 理論上存在する（チェック直後にファイル/シンボリックリンクが差し替えられた場合）。
 * Slack Marketplace の想定脅威モデル（LLM 誘導のパス・パターン注入）に対しては
 * containPath 自体が主防御であり、TOCTOU はより高度な同一ホスト内攻撃者を要するため
 * 優先度を下げている。
 */
async function containPath(inputPath: string, sandboxRoots: string[]): Promise<PathContainment> {
  if (sandboxRoots.length === 0) {
    return { ok: false, error: 'No sandboxed directories are available for this command' }
  }
  const absolute = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(sandboxRoots[0], inputPath)

  let resolved: string
  try {
    resolved = await fs.promises.realpath(absolute)
  } catch {
    return { ok: false, error: `Path does not exist: ${inputPath}` }
  }

  const realRoots = await resolveExistingRoots(sandboxRoots)
  const within = realRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!within) {
    return { ok: false, error: `Access denied: path is outside the allowed sandbox directories: ${inputPath}` }
  }
  return { ok: true, resolved }
}

/** sandboxRoots のうち実在するものだけを realpath 済みで返す */
async function resolveExistingRoots(sandboxRoots: string[]): Promise<string[]> {
  const resolved = await Promise.all(sandboxRoots.map(async (root) => {
    try {
      return await fs.promises.realpath(root)
    } catch {
      return null
    }
  }))
  return resolved.filter((r): r is string => r !== null)
}

/**
 * ディレクトリを再帰的に walk し、ファイルごとに visit を呼ぶ。
 * シンボリックリンクは実体が sandboxRoots 内に収まっている場合のみ辿る
 * （サンドボックス脱出防止）。visit が truthy を返したら走査を打ち切る。
 * 戻り値は「打ち切られたか」を表す（呼び出し元が複数ルートを走査する際の早期終了に使う）。
 *
 * `visited` は「このツール呼び出し1回の中で既に訪問した実ディレクトリパス
 * （realpath）」を保持する。呼び出し元（grepTool/globTool）がツール呼び出しごとに
 * 新しい Set を作って全ての walkFiles 呼び出しに使い回すことで、自己参照的
 * シンボリックリンク（`a/self -> a`）や相互参照（`a/link -> b`, `b/link -> a`）による
 * 無限再帰を防ぐ。これは worker タイムアウト（api-tool-worker-runner.ts）とは独立した
 * 根本修正であり、両方合わせて二重の防御とする。
 */
async function walkFiles(
  dir: string,
  sandboxRoots: string[],
  visit: (filePath: string) => Promise<boolean | void>,
  visited: Set<string>,
): Promise<boolean> {
  const realDir = await fs.promises.realpath(dir).catch(() => null)
  if (!realDir) return false
  if (visited.has(realDir)) return false
  visited.add(realDir)

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const entryPath = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const containment = await containPath(entryPath, sandboxRoots)
      if (!containment.ok) continue
      const stat = await fs.promises.stat(containment.resolved).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) {
        if (await walkFiles(containment.resolved, sandboxRoots, visit, visited)) return true
      } else if (stat.isFile()) {
        if (await visit(entryPath)) return true
      }
      continue
    }
    if (entry.isDirectory()) {
      if (await walkFiles(entryPath, sandboxRoots, visit, visited)) return true
    } else if (entry.isFile()) {
      if (await visit(entryPath)) return true
    }
  }
  return false
}

/** UTF-8 のマルチバイト文字境界を気にせず bytes 上限で打ち切る（不完全なシーケンスは置換文字になる） */
function truncateToByteLimit(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

async function readTool(input: Record<string, unknown>, sandboxRoots: string[]): Promise<ToolExecutionOutcome> {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
  if (!filePath) {
    return { output: 'Error: file_path is required', isError: true }
  }
  const containment = await containPath(filePath, sandboxRoots)
  if (!containment.ok) {
    return { output: `Error: ${containment.error}`, isError: true }
  }
  try {
    const stat = await fs.promises.stat(containment.resolved)
    if (!stat.isFile()) {
      return { output: `Error: not a file: ${filePath}`, isError: true }
    }
    // ファイル全体を readFile() でメモリに載せる前にサイズを確認する（OOM 防止）。
    // 出力の行数/バイト数上限（API_TOOL_READ_MAX_*）は読み込み後の切り詰めであり、
    // 読み込み自体を防ぐガードにはならない。
    if (stat.size > API_TOOL_MAX_READABLE_FILE_BYTES) {
      return {
        output: `Error: file too large to read (over ${API_TOOL_MAX_READABLE_FILE_BYTES} bytes): ${filePath}`,
        isError: true,
      }
    }
    const raw = await fs.promises.readFile(containment.resolved, 'utf8')
    const lines = raw.split('\n')
    let truncated = false
    let selectedLines = lines
    if (lines.length > API_TOOL_READ_MAX_LINES) {
      selectedLines = lines.slice(0, API_TOOL_READ_MAX_LINES)
      truncated = true
    }
    let numbered = selectedLines.map((line, idx) => `${idx + 1}\t${line}`).join('\n')
    if (Buffer.byteLength(numbered, 'utf8') > API_TOOL_READ_MAX_BYTES) {
      numbered = truncateToByteLimit(numbered, API_TOOL_READ_MAX_BYTES)
      truncated = true
    }
    if (truncated) {
      numbered += `\n\n[Output truncated: exceeds ${API_TOOL_READ_MAX_LINES} lines or ${API_TOOL_READ_MAX_BYTES} bytes]`
    }
    return { output: numbered, isError: false }
  } catch (error) {
    return { output: `Error: failed to read file: ${getErrorMessage(error)}`, isError: true }
  }
}

interface GrepMatch {
  file: string
  line: number
  text: string
}

/**
 * ReDoS（破滅的バックトラッキング）につながりやすい正規表現パターンを検出する
 * 軽量な静的ヒューリスティック。Grep は Slack 起点（信頼できない入力）から誘導された
 * パターンを受け取りうるため、`regex.test()` を walk 中の全ファイル・全行に対して
 * 無防備に同期実行しない（1リクエストのハングが同一 agent プロセス内の他の全チャット
 * ／他テナントを巻き込む。過去の ReDoS 実害事例: ロギングマスキング正規表現で実測7万倍）。
 *
 * 判定対象:
 * - ネストした量指定子（例: `(a+)+`, `(a*)*`, `((a+)+)+`）
 * - 量指定子が付いたグループ内のあいまいな選択（例: `(a|a)+`）
 *
 * 外部の正規表現解析ライブラリ（safe-regex 等）には依存せず、自前のトークナイザで
 * 判定する（新規重量依存を避けるため）。安全側に倒した保守的なチェックであり、
 * 理論上安全なパターン（例: `(cat|dog|bird)+`）も一部誤検出しうるが、Grep ツールが
 * 想定する用途（単純な文字列・キーワード検索）では実用上問題にならない。
 */
export function isDangerousRegexPattern(pattern: string): boolean {
  let inClass = false
  let escaped = false
  // 現在オープン中の各グループにつき、「そのグループが開いている間に量指定子または
  // 選択(|)を（どの深さであれ）見た」かどうかを保持する。
  const openGroups: { sawRepetitionOrAlternation: boolean }[] = []

  const markOpenGroupsUnsafe = (): void => {
    for (const group of openGroups) group.sawRepetitionOrAlternation = true
  }

  /** index が量指定子（+ / * / {n,m}）の先頭であれば、その終端の次のインデックスを返す */
  const matchQuantifierAt = (index: number): number | undefined => {
    const ch = pattern[index]
    if (ch === '+' || ch === '*') return index + 1
    if (ch === '{') {
      const closeIdx = pattern.indexOf('}', index)
      if (closeIdx !== -1 && /^\{\d*,?\d*\}$/.test(pattern.slice(index, closeIdx + 1))) {
        return closeIdx + 1
      }
    }
    return undefined
  }

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      openGroups.push({ sawRepetitionOrAlternation: false })
      continue
    }
    if (ch === ')') {
      const group = openGroups.pop()
      const quantifierEnd = matchQuantifierAt(i + 1)
      const isQuantified = quantifierEnd !== undefined
      if (isQuantified && group?.sawRepetitionOrAlternation) {
        return true
      }
      if (isQuantified) {
        // このグループ自体が量指定子付きであることは、外側のグループから見れば
        // 「内部に量指定子/選択を含む要素がある」ことに等しい。
        markOpenGroupsUnsafe()
      }
      continue
    }
    if (ch === '|') {
      markOpenGroupsUnsafe()
      continue
    }
    const quantifierEnd = matchQuantifierAt(i)
    if (quantifierEnd !== undefined) {
      markOpenGroupsUnsafe()
      i = quantifierEnd - 1
      continue
    }
  }
  return false
}

/**
 * exported (not just for `executeReadOnlyTool`'s internal dispatch) so tests can
 * exercise the real grep logic directly, same-thread. When Grep runs via the
 * Worker (the normal main-thread path), coverage instrumentation running in the
 * Jest process cannot see code executed inside the separate Worker thread's own
 * V8 isolate — direct calls here are what keep this logic under test coverage,
 * independent of (and in addition to) the worker-wiring integration tests that
 * go through `executeReadOnlyTool`.
 */
export async function grepTool(input: Record<string, unknown>, sandboxRoots: string[]): Promise<ToolExecutionOutcome> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
  if (!pattern) {
    return { output: 'Error: pattern is required', isError: true }
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    return { output: `Error: invalid regular expression: ${getErrorMessage(error)}`, isError: true }
  }
  if (isDangerousRegexPattern(pattern)) {
    return {
      output: 'Error: pattern rejected: potentially catastrophic backtracking (nested quantifiers or ambiguous alternation)',
      isError: true,
    }
  }

  const globPattern = typeof input.glob === 'string' ? input.glob : undefined
  let globMatcher: ((str: string) => boolean) | undefined
  if (globPattern) {
    try {
      globMatcher = picomatch(globPattern, { dot: true, strictBrackets: true })
    } catch (error) {
      return { output: `Error: invalid glob pattern: ${getErrorMessage(error)}`, isError: true }
    }
  }

  const targetPath = typeof input.path === 'string' ? input.path : undefined
  if (!targetPath && sandboxRoots.length === 0) {
    return { output: 'Error: No sandboxed directories are available for this command', isError: true }
  }
  let searchRoots: string[] = []
  let singleFile: string | undefined
  if (targetPath) {
    const containment = await containPath(targetPath, sandboxRoots)
    if (!containment.ok) {
      return { output: `Error: ${containment.error}`, isError: true }
    }
    // containPath() already proved containment.resolved exists (via
    // fs.realpath), so this stat() can only fail on a TOCTOU race — left
    // uncaught here and handled by executeReadOnlyTool()'s outer catch.
    const stat = await fs.promises.stat(containment.resolved)
    if (stat.isFile()) {
      singleFile = containment.resolved
    } else {
      searchRoots = [containment.resolved]
    }
  } else {
    searchRoots = await resolveExistingRoots(sandboxRoots)
  }

  const matches: GrepMatch[] = []
  const searchFile = async (filePath: string): Promise<boolean> => {
    if (globMatcher && !globMatcher(path.basename(filePath)) && !globMatcher(filePath)) return false
    // ファイル全体を readFile() でメモリに載せる前にサイズを確認する（OOM 防止）。
    // 巨大ファイル（誤コミットされたダンプ等）は一般的な grep ツールがバイナリを
    // スキップするのと同様に、検索対象から静かにスキップする（全体を失敗させない）。
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat || stat.size > API_TOOL_MAX_READABLE_FILE_BYTES) {
      return matches.length >= API_TOOL_GREP_MAX_MATCHES
    }
    let content: string
    try {
      content = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return matches.length >= API_TOOL_GREP_MAX_MATCHES
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        // 1マッチあたりの行テキスト長を上限で切り詰める。ファイルサイズガード
        // （5MB）はファイル全体には効くが、1行がその上限近くまで長い場合、
        // その1マッチがそのまま tool_result に載り出力が肥大化しうる。
        const rawText = lines[i]
        const text = rawText.length > API_TOOL_GREP_MAX_LINE_CHARS
          ? `${rawText.slice(0, API_TOOL_GREP_MAX_LINE_CHARS)}... [line truncated]`
          : rawText
        matches.push({ file: filePath, line: i + 1, text })
        if (matches.length >= API_TOOL_GREP_MAX_MATCHES) return true
      }
    }
    return matches.length >= API_TOOL_GREP_MAX_MATCHES
  }

  if (singleFile) {
    await searchFile(singleFile)
  } else {
    const visited = new Set<string>()
    for (const root of searchRoots) {
      if (matches.length >= API_TOOL_GREP_MAX_MATCHES) break
      if (await walkFiles(root, sandboxRoots, searchFile, visited)) break
    }
  }

  if (matches.length === 0) {
    return { output: 'No matches found', isError: false }
  }
  const truncated = matches.length >= API_TOOL_GREP_MAX_MATCHES
  let output = matches.map((m) => `${m.file}:${m.line}:${m.text}`).join('\n')
  if (truncated) {
    output += `\n\n[Results truncated: showing first ${API_TOOL_GREP_MAX_MATCHES} matches]`
  }
  return { output, isError: false }
}

interface GlobEntry {
  file: string
  mtimeMs: number
}

/** exported for the same direct-coverage reason as {@link grepTool} — see its comment. */
export async function globTool(input: Record<string, unknown>, sandboxRoots: string[]): Promise<ToolExecutionOutcome> {
  const pattern = typeof input.pattern === 'string' ? input.pattern : undefined
  if (!pattern) {
    return { output: 'Error: pattern is required', isError: true }
  }
  let matcher: (str: string) => boolean
  try {
    matcher = picomatch(pattern, { dot: true, strictBrackets: true })
  } catch (error) {
    return { output: `Error: invalid glob pattern: ${getErrorMessage(error)}`, isError: true }
  }

  const targetPath = typeof input.path === 'string' ? input.path : undefined
  if (!targetPath && sandboxRoots.length === 0) {
    return { output: 'Error: No sandboxed directories are available for this command', isError: true }
  }
  let searchRoots: string[]
  if (targetPath) {
    const containment = await containPath(targetPath, sandboxRoots)
    if (!containment.ok) {
      return { output: `Error: ${containment.error}`, isError: true }
    }
    // containPath() already proved containment.resolved exists (via
    // fs.realpath), so this stat() can only fail on a TOCTOU race — left
    // uncaught here and handled by executeReadOnlyTool()'s outer catch.
    const stat = await fs.promises.stat(containment.resolved)
    if (!stat.isDirectory()) {
      return { output: `Error: not a directory: ${targetPath}`, isError: true }
    }
    searchRoots = [containment.resolved]
  } else {
    searchRoots = await resolveExistingRoots(sandboxRoots)
  }

  const results: GlobEntry[] = []
  const visited = new Set<string>()
  for (const root of searchRoots) {
    if (results.length >= API_TOOL_GLOB_MAX_RESULTS) break
    await walkFiles(root, sandboxRoots, async (filePath) => {
      const relative = path.relative(root, filePath)
      if (matcher(relative) || matcher(path.basename(filePath))) {
        const stat = await fs.promises.stat(filePath).catch(() => null)
        results.push({ file: filePath, mtimeMs: stat?.mtimeMs ?? 0 })
      }
      return results.length >= API_TOOL_GLOB_MAX_RESULTS
    }, visited)
  }

  if (results.length === 0) {
    return { output: 'No files found', isError: false }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const truncated = results.length >= API_TOOL_GLOB_MAX_RESULTS
  let output = results.map((r) => r.file).join('\n')
  if (truncated) {
    output += `\n\n[Results truncated: showing first ${API_TOOL_GLOB_MAX_RESULTS} files]`
  }
  return { output, isError: false }
}

/**
 * Slack Marketplace 読み取り専用ツール（Read/Grep/Glob）を実行する統一エントリポイント。
 * 例外は投げず、常に `ToolExecutionOutcome`（isError フラグ付き）を返す。
 *
 * Grep/Glob はメインスレッドから呼ばれた場合、`api-tool-worker-runner.ts` 経由で
 * Worker スレッド内で実行する（ReDoS・シンボリックリンク循環等のハングがメイン
 * スレッド＝同一 agent プロセス内の他の全チャットを巻き込まないようにするため）。
 * Worker スレッド自身の中からこの関数が呼ばれた場合（`isMainThread === false`、
 * つまり Worker のブートストラップが同じこの関数を呼び出す場合）は、さらに別の
 * Worker を生成せず、その場で grepTool/globTool を直接実行する（無限にネストした
 * Worker 生成を防ぐ）。
 *
 * `abortSignal` は Grep/Glob の Worker 実行にのみ渡される（Read はファイルサイズ
 * ガードで既に有界なため、キャンセル伝播の主眼ではない）。
 */
export async function executeReadOnlyTool(
  name: string,
  input: Record<string, unknown>,
  sandboxRoots: string[],
  abortSignal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  try {
    switch (name) {
      case 'Read':
        return await readTool(input, sandboxRoots)
      case 'Grep':
        return isMainThread
          ? await runToolInWorker(name, input, sandboxRoots, abortSignal)
          : await grepTool(input, sandboxRoots)
      case 'Glob':
        return isMainThread
          ? await runToolInWorker(name, input, sandboxRoots, abortSignal)
          : await globTool(input, sandboxRoots)
      default:
        return { output: `Error: unknown tool: ${name}`, isError: true }
    }
  } catch (error) {
    return { output: `Error: ${getErrorMessage(error)}`, isError: true }
  }
}
