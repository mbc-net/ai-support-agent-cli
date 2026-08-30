import * as fs from 'fs'
import * as path from 'path'

/**
 * 起動経路からの呼び出しの存在確認。
 *
 * ヘルパを用意しただけでは何も起きない。呼び忘れると `--rdp` を指定しても
 * guacd が起動せず、利用者には「RDP がつながらない」としか見えない。
 */

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')

describe('guacd の起動経路への配線', () => {
  it('★ Docker 形態が buildGuacdDockerArgs を docker run へ差し込む', () => {
    const source = read('src/docker/docker-runner.ts')
    expect(source).toContain('buildGuacdDockerArgs')
    // 引数を組み立てるだけで dockerArgs に入れ忘れると効かない。
    const runBlock = source.slice(source.indexOf('const dockerArgs = ['))
    expect(runBlock.slice(0, 400)).toContain('guacdArgs')
  })

  it('★ CLI 直起動が resolveGuacdForHost を呼ぶ', () => {
    const source = read('src/index.ts')
    expect(source).toContain('resolveGuacdForHost')
  })

  it('★ 終了処理が guacd コンテナを停止する', () => {
    // 止め忘れると、エージェントを終了しても guacd が残り続ける。
    const sources = [
      read('src/index.ts'),
      read('src/docker/docker-runner.ts'),
    ].join('\n')
    expect(sources).toContain('stopGuacdContainer')
  })
})
