import { readFileSync } from 'fs'
import { join } from 'path'

import type { AgentRunOptions } from '../src/agent-run-options'
import { buildContainerArgs } from '../src/docker/docker-runner'

/**
 * `AgentRunOptions` の項目は「コンテナの中まで届かなければならないもの」である。
 * Docker 実行では `buildContainerArgs()` が CLI 引数へ転送する。
 *
 * 転送を書き忘れても**型エラーにならない**。ネイティブ実行では効くのに
 * Docker 実行でだけ黙って無視され、利用者からは「設定したのに効かない」と
 * しか見えない。ここで型と転送の対応を固定する。
 */
describe('AgentRunOptions のコンテナ転送', () => {
  /** 全項目を埋めた値 */
  const ALL_OPTIONS: Required<AgentRunOptions> = {
    token: 'tok-abc',
    apiUrl: 'https://api.example.com',
    pollInterval: 1234,
    heartbeatInterval: 5678,
    verbose: true,
    autoUpdate: false,
    updateChannel: 'beta',
    project: 'mbc/MBC_01',
  }

  /** 各項目が、どの CLI 引数として現れるか */
  const FORWARDED: ReadonlyArray<readonly [keyof AgentRunOptions, string]> = [
    ['token', 'tok-abc'],
    ['apiUrl', 'https://api.example.com'],
    ['pollInterval', '1234'],
    ['heartbeatInterval', '5678'],
    ['verbose', '--verbose'],
    ['autoUpdate', '--no-auto-update'],
    ['updateChannel', 'beta'],
    ['project', 'mbc/MBC_01'],
  ]

  /**
   * `AgentRunOptions` が宣言している項目名を**ソースから**読み出す。
   *
   * 型レベルの表明（`Required<AgentRunOptions>` に項目が足りない等）は
   * このリポジトリでは検査されない。`tsconfig.json` が `__tests__` を
   * exclude しており、ts-jest も `isolatedModules: true` で型検査しないため、
   * spec 内の型注釈は**何も保証しない**。実行時にソースを読むしかない。
   */
  const declaredOptionKeys = (): string[] => {
    const source = readFileSync(
      join(__dirname, '..', 'src/agent-run-options.ts'),
      'utf8',
    )
    const body = source.slice(source.indexOf('export interface AgentRunOptions'))
    return [...body.matchAll(/^  (\w+)\?:/gm)].map((m) => m[1])
  }

  it('AgentRunOptions の全項目を検査対象にしている', () => {
    // 型へ項目を足して検査表への追加を忘れたら、ここで落ちる
    expect(FORWARDED.map(([key]) => key).sort()).toEqual(
      declaredOptionKeys().sort(),
    )
  })

  it('検査対象の項目はフィクスチャにも値がある', () => {
    expect(Object.keys(ALL_OPTIONS).sort()).toEqual(declaredOptionKeys().sort())
  })

  it.each(FORWARDED)('%s をコンテナ引数へ転送する', (_key, expected) => {
    expect(buildContainerArgs(ALL_OPTIONS)).toContain(expected)
  })

  it('値を持たない項目は引数に現れない', () => {
    const args = buildContainerArgs({})

    expect(args).not.toContain('--token')
    expect(args).not.toContain('--poll-interval')
    expect(args).not.toContain('--verbose')
    expect(args).not.toContain('--update-channel')
  })

  /**
   * `autoUpdate` だけは真偽の向きが逆（false のときに `--no-auto-update` を足す）。
   * 他項目と同じ「値があれば足す」で書くと、既定の true で無効化してしまう。
   */
  it('autoUpdate は false のときだけ --no-auto-update を足す', () => {
    expect(buildContainerArgs({ autoUpdate: true })).not.toContain(
      '--no-auto-update',
    )
    expect(buildContainerArgs({ autoUpdate: false })).toContain(
      '--no-auto-update',
    )
  })
})
