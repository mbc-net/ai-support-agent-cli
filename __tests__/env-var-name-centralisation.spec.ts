import * as fs from 'fs'
import * as path from 'path'

/**
 * `AI_SUPPORT_AGENT_*` 環境変数名が定数経由で使われているかの検査。
 *
 * これらの名前は Docker コンテナ・生成されたサービススクリプト・K8s/ECS
 * マニフェスト・Ansible ロールへ渡され、**設定する側と読む側が別ファイル**に
 * ある。`constants.ts` の `ENV_VARS` に集約されているのはそのためで、
 * 同ファイルのコメントも「どこか 1 箇所でタイプミスすると、コンテナ内で
 * 変数が黙って未設定になる」と明記している。
 *
 * ただしその規律は文章で書かれているだけで、実際に逸脱していないかは
 * 誰も検査していなかった。ここで固定する。
 *
 * :::note
 * 現時点で逸脱は 1 箇所だけ（`auth-commands.ts` の `.env('AI_SUPPORT_AGENT_TOKEN')`、
 * 本コミットで `ENV_VARS.TOKEN` へ変更）。**既存の不具合の修正ではなく予防**である。
 * :::
 */

const SRC_DIR = path.join(__dirname, '..', 'src')

/** 環境変数名の定数を宣言してよいファイル（src/ からの POSIX 相対パス） */
const DECLARATION_FILES: ReadonlySet<string> = new Set([
  'constants.ts',
  // MCP サーバーへ渡す実行コンテキスト。config-writer が書き、
  // mcp/tools/* が読む。専用の定数として同ファイルにまとまっている。
  'mcp/config-writer.ts',
])

const ENV_NAME_PATTERN = /['"`](AI_SUPPORT_AGENT_[A-Z0-9_]+)['"`]/g

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/**
 * コメントを取り除く。
 *
 * doc コメントは環境変数名を説明のために書くので、そのまま検査すると
 * **実際には定数経由なのに違反として報告される**（この spec を書く過程で
 * 4 種類の偽陽性が出た）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('環境変数名の集約', () => {
  const files = collectSourceFiles(SRC_DIR)

  it('検査対象のファイルを見つけている', () => {
    // 走査条件を壊すと 0 件になり、以降が素通りしてしまう
    expect(files.length).toBeGreaterThan(50)
  })

  it('ENV_VARS に AI_SUPPORT_AGENT_* が定義されている', () => {
    const constants = fs.readFileSync(path.join(SRC_DIR, 'constants.ts'), 'utf8')
    const names = [...constants.matchAll(ENV_NAME_PATTERN)].map((m) => m[1])

    expect(names.length).toBeGreaterThan(10)
  })

  it('宣言ファイル以外は環境変数名をリテラルで書かない', () => {
    const violations: string[] = []

    for (const file of files) {
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/')
      if (DECLARATION_FILES.has(rel)) continue

      const source = stripComments(fs.readFileSync(file, 'utf8'))
      for (const match of source.matchAll(ENV_NAME_PATTERN)) {
        violations.push(`${rel}: ${match[1]}`)
      }
    }

    // 違反があるなら ENV_VARS.<名前> を使うか、意図があるなら
    // DECLARATION_FILES に理由を添えて登録する
    expect(violations).toEqual([])
  })
})
