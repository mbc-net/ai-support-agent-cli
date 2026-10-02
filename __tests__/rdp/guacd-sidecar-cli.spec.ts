import { Command } from 'commander'

import { registerManifestCommands } from '../../src/cli/manifest-command'

/**
 * `--rdp` / `--guacd-image` の CLI 配線。
 *
 * オプションを定義しただけでは意味が無く、生成側へ届いて初めて効く。
 * 届かなければ「指定したのにサイドカーが出ない」という無言の失敗になる。
 */

/** 定義済みオプションのフラグ名を集める。 */
function optionNames(commandName: string): string[] {
  const program = new Command()
  registerManifestCommands(program)
  const manifest = program.commands.find((c) => c.name() === 'manifest')
  if (!manifest) throw new Error('manifest コマンドが見つかりません')
  const sub = manifest.commands.find((c) => c.name() === commandName)
  if (!sub) throw new Error(`サブコマンド ${commandName} が見つかりません`)
  return sub.options.map((o) => o.long ?? '')
}

describe('manifest コマンドの --rdp 配線', () => {
  it.each(['k8s', 'ecs'])('%s に --rdp がある', (name) => {
    expect(optionNames(name)).toContain('--rdp')
  })

  it.each(['k8s', 'ecs'])('%s に --guacd-image がある', (name) => {
    expect(optionNames(name)).toContain('--guacd-image')
  })

  describe('★ 生成側へ値が渡ること', () => {
    // オプションを定義しただけで渡し忘れると、指定してもサイドカーが出ない。
    const SOURCE = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/cli/manifest-command.ts'),
      'utf8',
    ) as string

    it('runK8sManifest が rdp / guacdImage を渡す', () => {
      const body = SOURCE.slice(
        SOURCE.indexOf('export async function runK8sManifest'),
        SOURCE.indexOf('export async function runEcsManifest'),
      )
      expect(body).toContain('rdp: opts.rdp')
      expect(body).toContain('guacdImage: opts.guacdImage')
    })

    it('runEcsManifest が rdp / guacdImage を渡す', () => {
      const body = SOURCE.slice(
        SOURCE.indexOf('export async function runEcsManifest'),
      )
      expect(body).toContain('rdp: opts.rdp')
      expect(body).toContain('guacdImage: opts.guacdImage')
    })
  })
})
