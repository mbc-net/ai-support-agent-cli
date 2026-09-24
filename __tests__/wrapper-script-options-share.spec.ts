import { readFileSync } from 'fs'
import { join } from 'path'

import { generateWrapperScript as generateDarwinWrapperScript } from '../src/cli/service/darwin-service'
import { generateWrapperScript as generateLinuxWrapperScript } from '../src/cli/service/linux-service'
import type { WrapperScriptBaseOptions } from '../src/cli/service/wrapper-helpers'
import { generateWin32WrapperScript } from '../src/cli/service/win32-service'

/**
 * darwin / linux / win32 のラッパー生成は、同じ 12 項目を**それぞれ別に**
 * インライン宣言していた。全プラットフォームが `WrapperScriptBaseOptions`
 * （= `AgentCredentialEnv` を継承）を受けることで、認証情報を 1 つ増やしたときに
 * 3 箇所すべてへ同時に届くようにする。
 *
 * 片方だけ宣言し忘れても**呼び出し側はスプレッドで渡しているので型エラーにならず**、
 * そのプラットフォームでだけ資格情報が渡らない（= その OS の利用者だけ認証できない）
 * という出方をする。
 */
describe('ラッパー生成の共通オプション', () => {
  const BASE: WrapperScriptBaseOptions = {
    imageName: 'ghcr.io/example/agent:latest',
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    projectConfigHostDir: '/home/u/.ai-support-agent/mbc/MBC_01',
    projectDir: '/home/u/work/proj',
    token: 'tok-abc',
    apiUrl: 'https://api.example.com',
    anthropicApiKey: 'sk-ant-key',
    claudeCodeOauthToken: 'sk-ant-oat01-tok',
    codexApiKey: 'codex-key',
    codexAccessToken: 'codex-access',
    verbose: true,
  }

  /** AgentCredentialEnv の 4 項目と、それが渡ったことを確かめる値 */
  const CREDENTIALS = [
    ['anthropicApiKey', 'sk-ant-key'],
    ['claudeCodeOauthToken', 'sk-ant-oat01-tok'],
    ['codexApiKey', 'codex-key'],
    ['codexAccessToken', 'codex-access'],
  ] as const

  const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
    [
      'darwin',
      generateDarwinWrapperScript({ ...BASE, updateScriptPath: '/opt/upd.sh' }),
    ],
    [
      'linux',
      generateLinuxWrapperScript({ ...BASE, updateScriptPath: '/opt/upd.sh' }),
    ],
    ['win32', generateWin32WrapperScript(BASE)],
  ]

  describe.each(SCRIPTS)('%s', (_platform, script) => {
    it.each(CREDENTIALS)(
      '%s を生成スクリプトへ渡す',
      (_field, value) => {
        expect(script).toContain(value)
      },
    )

    it('接続情報（token / apiUrl）を渡す', () => {
      expect(script).toContain('tok-abc')
      expect(script).toContain('api.example.com')
    })
  })

  /**
   * 3 プラットフォームが基底型を**共有し続けている**ことをソースで固定する。
   *
   * 型レベルの代入検査ではこれを検出できない。インライン型へ戻しても
   * `WrapperScriptBaseOptions` と構造的に同一なら代入は通ってしまうため。
   * 「共有をやめた」こと自体を見るには宣言そのものを見るしかない。
   */
  describe('基底型の共有', () => {
    const SOURCES = [
      ['darwin', 'src/cli/service/darwin-service.ts'],
      ['linux', 'src/cli/service/linux-service.ts'],
      ['win32', 'src/cli/service/win32-service.ts'],
    ] as const

    /** AgentCredentialEnv が持つ項目。個別に再宣言されていたら共有が切れている */
    const CREDENTIAL_FIELDS = [
      'anthropicApiKey',
      'claudeCodeOauthToken',
      'codexApiKey',
      'codexAccessToken',
    ] as const

    it.each(SOURCES)(
      '%s は WrapperScriptBaseOptions を受け取る',
      (_platform, file) => {
        const source = readFileSync(join(__dirname, '..', file), 'utf8')

        expect(source).toContain('opts: WrapperScriptBaseOptions')
      },
    )

    it.each(SOURCES)(
      '%s は認証情報の項目を自前で宣言し直さない',
      (_platform, file) => {
        const source = readFileSync(join(__dirname, '..', file), 'utf8')

        for (const field of CREDENTIAL_FIELDS) {
          // `anthropicApiKey?: string` のような**宣言**が残っていたら共有が切れている。
          // `opts.anthropicApiKey` という**参照**は正常なので拾わない。
          expect(source).not.toMatch(
            new RegExp(`^\\s*${field}\\?:\\s*string`, 'm'),
          )
        }
      },
    )
  })
})
