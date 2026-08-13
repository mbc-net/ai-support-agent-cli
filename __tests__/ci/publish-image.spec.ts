import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * `ci-cd.yml` のコンテナイメージ公開ジョブ（`publish_image`）の静的検証。
 *
 * このジョブは `ghcr.io/mbc-net/ai-support-agent-cli` を発行する唯一の経路であり、
 * `manifest-generator.ts` の `DEFAULT_AGENT_IMAGE` が指す先そのものである。
 * ここが壊れると、生成マニフェストを適用したユーザーが ImagePullBackOff になる
 * （ワークフロー追加前は実際にその状態だった）。
 *
 * ワークフローは jest から実行できないため、YAML として満たすべき不変条件を固定する。
 * 特に重要なのは次の 3 点で、いずれも壊れても CI は緑のまま通ってしまう:
 *   - npm 公開の完了後に走ること（Dockerfile が npm から CLI を取得するため）
 *   - タグ由来のバージョンが `AGENT_VERSION` に渡ること（`latest` 固定だと別物が入る）
 *   - `latest` タグが正式リリース時のみ動くこと（beta が latest を奪わない）
 */
describe('ci-cd.yml: publish_image ジョブ', () => {
  const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'ci-cd.yml')
  const raw = readFileSync(workflowPath, 'utf8')
  const workflow = load(raw, { schema: DEFAULT_SCHEMA }) as Record<string, any>
  const job = () => workflow.jobs?.publish_image as Record<string, any> | undefined
  /** タグ付け（manifest list の作成）を担当するジョブ。 */
  const manifestJob = () =>
    workflow.jobs?.publish_image_manifest as Record<string, any> | undefined

  /** ジョブ内の全ステップを 1 本の文字列に畳む（`with` や `run` を横断して検索するため）。 */
  function jobText(): string {
    return JSON.stringify(job() ?? {})
  }

  /** ビルドとタグ付けの両ジョブを合わせた全文（どちらに置かれても検出する）。 */
  function allText(): string {
    return JSON.stringify({ build: job() ?? {}, manifest: manifestJob() ?? {} })
  }

  it('publish_image ジョブが存在する', () => {
    expect(Object.keys(workflow.jobs ?? {})).toContain('publish_image')
  })

  it('npm 公開（publish ジョブ）の完了後に実行される', () => {
    // Dockerfile は `npm install -g @ai-support-agent/cli@${AGENT_VERSION}` で
    // npm レジストリから取得する。publish より先に走ると、そのバージョンはまだ存在しない。
    const needs = job()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish')
  })

  it('タグ push のときだけ実行される', () => {
    expect(String(job()?.if ?? '')).toContain("startsWith(github.ref, 'refs/tags/')")
  })

  it('GHCR へ push するための packages: write 権限を持つ', () => {
    expect(job()?.permissions?.packages).toBe('write')
  })

  it('タグ由来のバージョンを AGENT_VERSION に渡す（latest 固定にしない）', () => {
    const text = jobText()
    expect(text).toContain('AGENT_VERSION=')
    // タグから抽出した値を参照していること。素の `AGENT_VERSION=latest` は不可。
    expect(text).toMatch(/AGENT_VERSION=\$\{\{[^}]*version[^}]*\}\}/)
    expect(text).not.toMatch(/AGENT_VERSION=latest/)
  })

  it('amd64 と arm64 の両方を発行する', () => {
    const text = jobText()
    expect(text).toContain('amd64')
    expect(text).toContain('arm64')
  })

  it('アーキテクチャ別のイメージを結合するジョブがビルド後に走る', () => {
    const needs = manifestJob()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish_image')
    expect(manifestJob()?.permissions?.packages).toBe('write')
  })

  it('バージョンとチャンネルを publish ジョブの出力として公開している', () => {
    // 下流で再計算するとコンテナタグが npm の dist-tag とずれる余地が生まれる。
    const outputs = workflow.jobs?.publish?.outputs ?? {}
    expect(String(outputs.version ?? '')).toContain('steps.version.outputs.version')
    expect(String(outputs.channel_tag ?? '')).toContain('steps.release-type.outputs.tag')
  })

  it('publish ジョブの release-type 判定が beta / alpha / latest を区別する', () => {
    const publishText = JSON.stringify(workflow.jobs?.publish ?? {})
    expect(publishText).toContain('beta')
    expect(publishText).toContain('alpha')
    expect(publishText).toContain('prerelease')
  })

  it('不変のバージョンタグを必ず発行する', () => {
    // `latest` だけだと過去のリリースを再現できない。
    const text = JSON.stringify(manifestJob() ?? {})
    expect(text).toContain('needs.publish.outputs.version')
    expect(text).toMatch(/\$\{IMAGE\}:\$\{VERSION\}/)
  })

  it('移動タグは publish ジョブの決定を参照する（latest を直書きしない）', () => {
    // beta リリースで `latest` が動くと、既定値 `:latest` を使う全ユーザーが
    // プレリリース版を引くことになる。
    const text = JSON.stringify(manifestJob() ?? {})
    expect(text).toContain('needs.publish.outputs.channel_tag')
    expect(text).toMatch(/\$\{IMAGE\}:\$\{CHANNEL_TAG\}/)
    // タグ名をワークフロー内で直書きしていないこと。
    expect(text).not.toMatch(/\$\{IMAGE\}:latest/)
  })

  it('manifest ジョブは publish の出力を参照できるよう needs に publish を含む', () => {
    const needs = manifestJob()?.needs
    const list = Array.isArray(needs) ? needs : [needs]
    expect(list).toContain('publish')
  })

  it('イメージ名が manifest-generator の DEFAULT_AGENT_IMAGE と一致する', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DEFAULT_AGENT_IMAGE } = require('../../src/manifest/manifest-generator')
    const repository = String(DEFAULT_AGENT_IMAGE).split(':')[0]
    expect(repository).toBe('ghcr.io/mbc-net/ai-support-agent-cli')
    // ワークフローが発行する先がその参照先とずれていないこと。
    expect(allText().toLowerCase()).toContain(repository.toLowerCase())
  })
})
