import { readFileSync } from 'fs'
import { join } from 'path'

import { CLI_FLAG_AUTO_UPDATE, CLI_FLAG_NO_AUTO_UPDATE } from '../../src/constants'

/**
 * `start` コマンドが自動アップデートの肯定・否定フラグを**両方**登録していることを固定する。
 *
 * commander は `--no-x` だけを登録すると、未指定時の `opts.x` を true にする
 * （`__tests__/cli.integration.spec.ts` で実測して固定してある）。肯定フラグを
 * 併せて登録して初めて「未指定 = undefined」になり、既定 OFF が成立する。
 *
 * つまり `--auto-update` の登録を消すと、コンパイルも既存テストも通ったまま、
 * 全エージェントの自動アップデートが暗黙的に ON へ戻る。ソースの登録そのものを
 * 検査してこの退行を防ぐ（index.ts は import すると program.parse() が走るため、
 * 読み込まずにソースを検査する）。
 */
describe('start コマンドの自動アップデートフラグ', () => {
  const source = readFileSync(join(__dirname, '../../src/index.ts'), 'utf-8')

  it('肯定フラグ・否定フラグの定数がどちらも定義されている', () => {
    expect(CLI_FLAG_AUTO_UPDATE).toBe('--auto-update')
    expect(CLI_FLAG_NO_AUTO_UPDATE).toBe('--no-auto-update')
  })

  it('start コマンドが両方のフラグを option として登録している', () => {
    expect(source).toContain(`.option(CLI_FLAG_AUTO_UPDATE,`)
    expect(source).toContain(`.option(CLI_FLAG_NO_AUTO_UPDATE,`)
  })

  it('フラグはリテラルではなく定数経由で登録されている（表記ゆれで片方だけ消えるのを防ぐ）', () => {
    expect(source).not.toContain(`.option('--auto-update'`)
    expect(source).not.toContain(`.option('--no-auto-update'`)
  })
})
