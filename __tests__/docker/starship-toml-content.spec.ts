/**
 * Static analysis tests for the bundled starship prompt config.
 *
 * starship (via docker/bashrc-extra.sh's `eval "$(starship init bash)"`) ran
 * with no custom config prior to this file's introduction, i.e. fully on
 * starship's built-in defaults. The default `container` module style is
 * "red bold dimmed" — the `dimmed` attribute lowers text intensity, which is
 * hard to read against the dark terminal background (reported: "プロンプト
 * の色の表示が見づらい"). This config overrides just that module.
 */

import * as fs from 'fs'
import * as path from 'path'
import { parse as parseToml } from 'smol-toml'

const STARSHIP_TOML = path.resolve(__dirname, '../../docker/starship.toml')
const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

interface StarshipConfig {
  container?: { style?: unknown }
}

describe('docker/starship.toml content validation', () => {
  let content: string
  let parsed: StarshipConfig

  beforeAll(() => {
    content = fs.readFileSync(STARSHIP_TOML, 'utf-8')
    // starship はこのファイルをTOMLとしてパースする。正規表現による文字列
    // 一致だけでは構文が壊れていても（クォート閉じ忘れ等）検知できず、
    // starshipがconfigを読み込めずデフォルト（dimmed）に戻ってしまう回帰を
    // 見逃す。実際にTOMLパーサを通し、パース結果の値を検証する。
    parsed = parseToml(content) as StarshipConfig
  })

  it('is valid TOML', () => {
    expect(() => parseToml(content)).not.toThrow()
  })

  it('overrides the container module style', () => {
    expect(typeof parsed.container?.style).toBe('string')
  })

  it('does NOT use the "dimmed" attribute on the container style (low contrast on dark background)', () => {
    expect(parsed.container?.style).not.toMatch(/dimmed/)
  })
})

describe('Dockerfile bundles the starship prompt config', () => {
  let dockerfileContent: string

  beforeAll(() => {
    dockerfileContent = fs.readFileSync(DOCKERFILE, 'utf-8')
  })

  it('copies docker/starship.toml to /etc/starship.toml so it applies to every session regardless of the runtime UID', () => {
    expect(dockerfileContent).toMatch(/COPY docker\/starship\.toml \/etc\/starship\.toml\b/)
  })

  it('sets STARSHIP_CONFIG so starship picks up the bundled config regardless of $HOME', () => {
    expect(dockerfileContent).toMatch(/ENV\s+.*STARSHIP_CONFIG=\/etc\/starship\.toml/)
  })

  it('defaults EDITOR/VISUAL to nvim', () => {
    expect(dockerfileContent).toMatch(/ENV\s+.*EDITOR=nvim/)
    expect(dockerfileContent).toMatch(/ENV\s+.*VISUAL=nvim/)
  })
})
