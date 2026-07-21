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
  container?: { style?: unknown; format?: unknown }
  directory?: { style?: unknown; format?: unknown }
  username?: { style_user?: unknown; style_root?: unknown; format?: unknown }
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

  // ブロック（背景色付きピル）表示。「ディレクトリをブロック表示にしてください」
  // 「rootの赤字が見づらい」への対応。プレーンな前景色文字ではなく、背景色
  // (bg:) を持たせて視認性を上げる。
  it('gives the directory module a background-filled block style (bg:)', () => {
    expect(parsed.directory?.style).toMatch(/bg:#[0-9a-fA-F]{6}/)
  })

  it('gives the username module a background-filled block style for both a normal user and root (fixes the hard-to-read plain red "root" text)', () => {
    expect(parsed.username?.style_user).toMatch(/bg:#[0-9a-fA-F]{6}/)
    expect(parsed.username?.style_root).toMatch(/bg:#[0-9a-fA-F]{6}/)
    // 素のstarshipデフォルト(red bold, dimmedなし)は見づらいと報告されたため、
    // 単に色を変えるだけでなくブロック化しており、赤一色のままではないこと
    expect(parsed.username?.style_root).not.toBe('red bold')
  })

  it('gives the container module a background-filled block style too (consistent with directory/username)', () => {
    expect(parsed.container?.style).toMatch(/bg:#[0-9a-fA-F]{6}/)
  })

  // 回帰テスト: directory/username/container いずれも format 末尾に
  // スペースを持たせ、tmuxのピル間の余白と同様に隣接セグメント（ブロック同士、
  // ブロックとプロンプト文字 ❯ 等）が隙間なく連結表示されないようにする
  // （レビュー指摘: username/containerだけ末尾スペースが欠落し連結していた）。
  it('separates every block from whatever comes next with a trailing space in format (no squashed-together pills)', () => {
    for (const format of [parsed.directory?.format, parsed.username?.format, parsed.container?.format]) {
      expect(typeof format).toBe('string')
      expect(format as string).toMatch(/\(\$style\)\s+$/)
    }
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
