import * as fs from 'fs'
import * as path from 'path'

/**
 * 起動経路からの呼び出しの存在確認。
 *
 * ヘルパを用意しただけでは何も起きない。呼び忘れると `--rdp` を指定しても
 * guacd が起動せず、利用者には「RDP がつながらない」としか見えない。
 */

/**
 * ソースからコメントを取り除いて読む。
 *
 * 取り除かないと、**「呼ぶこと」と書いたコメントだけで検査が通る**。実際この
 * ファイルが確認したい配線は、どれも該当箇所に長い日本語コメントが付いている。
 */
const read = (rel: string): string =>
  stripComments(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8'))

/** ブロックコメントと行コメントを落とす。文字列リテラル中の // は対象外。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // クオート除去後に見つけた位置をそのまま使う。元の行から
      // `indexOf('//')` を取り直すと、`//` を含む文字列リテラル（URL 等）が
      // 先にヒットして正当なコードまで切り落とす。
      const quoteless = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ')
      const marker = quoteless.indexOf('//')
      return marker === -1 ? line : line.slice(0, marker)
    })
    .join('\n')
}

describe('guacd の起動経路への配線', () => {
  it('★ Docker 形態が buildGuacdDockerArgs を docker run へ差し込む', () => {
    const source = read('src/docker/docker-runner.ts')
    expect(source).toContain('buildGuacdDockerArgs')
    // 引数を組み立てるだけで dockerArgs に入れ忘れると効かない。
    const runBlock = source.slice(source.indexOf('const dockerArgs = ['))
    expect(runBlock.slice(0, 400)).toContain('guacdArgs')
  })

  it('★ 通常経路（DockerSupervisor）でも guacd が配線されている', () => {
    // runInDocker はプロジェクトが 1 件でもあれば DockerSupervisor 経路で
    // return する。legacy fallback（プロジェクト 0 件）にしか配線していないと、
    // **通常の運用では --rdp を指定しても guacd が起動しない**。
    const source = read('src/docker/docker-supervisor.ts')
    expect(source).toContain('buildGuacdDockerArgs')
    const runBlock = source.slice(source.indexOf('const dockerArgs = ['))
    expect(runBlock.slice(0, 500)).toContain('guacdArgs')
  })

  // 通常経路（DockerSupervisor）の**停止**は guacd-shutdown.spec.ts が実際に
  // 実行して検証する。ソース文字列の検査では、呼び出しをヘルパへ切り出した
  // だけで落ちる一方、片方の終了経路にしか書かれていなくても通ってしまう。

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
