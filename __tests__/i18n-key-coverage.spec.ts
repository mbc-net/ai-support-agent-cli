/**
 * src 内で静的キーを使って呼ばれる t('...') が、en.json / ja.json の
 * 両方に定義されていることを検証する回帰テスト。
 *
 * 背景: `start --project` の説明キー cmd.start.project がロケール未定義のまま
 * リリースされ、--help にキー文字列がそのまま表示された。t() は未定義キーを
 * キー文字列で返すフォールバック仕様のため、型でもテストでも検出されなかった。
 *
 * 抽出は「単語境界の t( 呼び出し」のみを対象とし、digest('hex') や
 * split('_') のような末尾 t を持つ別メソッドの呼び出しは除外する。
 * 動的キー（t(variable) や t(`cmd.${x}`)）はこのテストの対象外。
 */
import * as fs from 'fs'
import * as path from 'path'

const SRC_DIR = path.join(__dirname, '..', 'src')

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

function extractStaticTranslationKeys(): Set<string> {
  // (?<![\w.$]) で toString( / digest( / import( 等の「t で終わる別識別子」を除外
  const callPattern = /(?<![\w.$])t\(\s*['"]([a-zA-Z0-9._-]+)['"]/g
  const keys = new Set<string>()
  for (const file of collectSourceFiles(SRC_DIR)) {
    const content = fs.readFileSync(file, 'utf8')
    for (const match of content.matchAll(callPattern)) {
      keys.add(match[1])
    }
  }
  return keys
}

describe('i18n key coverage', () => {
  const en: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(SRC_DIR, 'locales', 'en.json'), 'utf8'),
  )
  const ja: Record<string, string> = JSON.parse(
    fs.readFileSync(path.join(SRC_DIR, 'locales', 'ja.json'), 'utf8'),
  )
  const usedKeys = extractStaticTranslationKeys()

  it('extracts a meaningful number of keys (sanity check)', () => {
    expect(usedKeys.size).toBeGreaterThan(100)
  })

  it('every statically referenced key exists in en.json', () => {
    const missing = [...usedKeys].filter((key) => !(key in en)).sort()
    expect(missing).toEqual([])
  })

  it('every statically referenced key exists in ja.json', () => {
    const missing = [...usedKeys].filter((key) => !(key in ja)).sort()
    expect(missing).toEqual([])
  })

  it('en.json and ja.json define the same key set', () => {
    const enKeys = Object.keys(en).sort()
    const jaKeys = Object.keys(ja).sort()
    expect(jaKeys).toEqual(enKeys)
  })
})
