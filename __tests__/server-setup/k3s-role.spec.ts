import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

/**
 * k3s bundled role（agent/ansible/roles/k3s）の静的検証。
 *
 * role 内部のタスクは信頼済み同梱コードのため `validateAnsibleTasks`（body ガード）
 * の対象外だが、YAML として壊れていると実機の `ansible-playbook` が起動時に失敗する。
 * ここでは (1) defaults/main.yml がパースでき主要トグルの既定値を持つこと、
 * (2) tasks/main.yml がタスク列としてパースできること、を最小限の回帰防止として検証する。
 * 実際のクラスタ構築挙動（k3s インストール・パーティション操作等）は jest では検証不可で、
 * `ansible-playbook --syntax-check`（ansible 利用可能時）と指示書の受け入れ条件（実機）に委ねる。
 */
describe('k3s bundled role', () => {
  const roleDir = path.join(__dirname, '..', '..', 'ansible', 'roles', 'k3s')

  function loadYaml(...segments: string[]): unknown {
    const file = path.join(roleDir, ...segments)
    return load(readFileSync(file, 'utf8'))
  }

  it('defaults/main.yml が主要トグルの既定値（disk/gvisor/etcd S3 は既定オフ、common/cluster は既定オン）を持つ', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    expect(defaults).toBeTruthy()
    // 破壊的・外部連携系は既定オプトイン（false）
    expect(defaults.k3s_setup_disk).toBe(false)
    expect(defaults.gvisor_enabled).toBe(false)
    expect(defaults.k3s_etcd_s3_enabled).toBe(false)
    // OS 前提整備と k3s 導入は既定オン
    expect(defaults.k3s_setup_common).toBe(true)
    expect(defaults.k3s_setup_cluster).toBe(true)
    // ブートストラップ既定は init（単一/初期ノード）
    expect(defaults.k3s_bootstrap).toBe('init')
  })

  it('defaults/main.yml は個別PC固有値（バージョン・トークン・disk id）をハードコードせず空/未指定にしている', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    // k3s_version は呼び出し側でピン留め必須（latest ドリフト防止）→ 既定は空
    expect(defaults.k3s_version ?? '').toBe('')
    // 秘匿トークンとデバイスIDを既定に持たない
    expect(defaults.k3s_token ?? '').toBe('')
    expect(defaults.k3s_ephemeral_disk_id ?? '').toBe('')
  })

  it('tasks/main.yml がタスク列（配列）としてパースできる', () => {
    const tasks = loadYaml('tasks', 'main.yml')
    expect(Array.isArray(tasks)).toBe(true)
    expect((tasks as unknown[]).length).toBeGreaterThan(0)
  })

  it('joinノードもKubernetes API上で自身がReadyになるまで成功扱いしない', () => {
    const cluster = readFileSync(path.join(roleDir, 'tasks', 'cluster.yml'), 'utf8')
    expect(cluster).toContain('Wait for this join node to report Ready')
    expect(cluster).toContain('kubectl')
    expect(cluster).toContain('jsonpath')
    expect(cluster).toContain("== 'True'")
  })
})
