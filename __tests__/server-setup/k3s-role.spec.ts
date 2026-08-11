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

  it('defaults/main.yml が Longhorn 必須カーネルモジュール（nfs / dm_crypt）を含む', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    const modules = defaults.k3s_kernel_modules as string[]

    // 既存（k3s / コンテナランタイム / iSCSI）
    expect(modules).toContain('overlay')
    expect(modules).toContain('br_netfilter')
    expect(modules).toContain('iscsi_tcp')
    // Longhorn 要求。未ロードだと longhornctl check preflight が error になり、
    // RWX / 暗号化ボリュームが使えない（実機 3 ノードで確認）。
    expect(modules).toContain('nfs')
    expect(modules).toContain('dm_crypt')
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

  it('/etc/rancher と /etc/rancher/k3s は 0755、config.yaml.d は 0700 で作成する（kubeconfig を一般ユーザーが読めるようにする）', () => {
    const tasks = loadYaml('tasks', 'cluster.yml') as Array<Record<string, any>>

    const dirTasks = tasks.filter((t) => t['ansible.builtin.file']?.state === 'directory')
    const rancherDir = dirTasks.find(
      (t) => t['ansible.builtin.file'].path === '/etc/rancher',
    )
    const configDir = dirTasks.find(
      (t) => t['ansible.builtin.file'].path === '/etc/rancher/k3s',
    )
    const dropInDir = dirTasks.find(
      (t) => t['ansible.builtin.file'].path === '/etc/rancher/k3s/config.yaml.d',
    )

    // いずれかの親ディレクトリが 0700 だと write-kubeconfig-mode: 644 が無効化され、
    // 一般ユーザーの kubectl が permission denied になる（実機で確認済み）。
    expect(rancherDir?.['ansible.builtin.file'].mode).toBe('0755')
    expect(configDir?.['ansible.builtin.file'].mode).toBe('0755')
    // 秘匿ドロップイン（etcd-S3 認証情報）は root 専用のまま維持する。
    expect(dropInDir?.['ansible.builtin.file'].mode).toBe('0700')
  })

  it('config.yaml は 0600 のまま（ディレクトリを緩めても内容は保護される）', () => {
    const tasks = loadYaml('tasks', 'cluster.yml') as Array<Record<string, any>>
    const renderTask = tasks.find(
      (t) => t['ansible.builtin.template']?.dest === '/etc/rancher/k3s/config.yaml',
    )
    expect(renderTask?.['ansible.builtin.template'].mode).toBe('0600')
  })

  it('k3s導入前にプライベートLANを自動検出してUFWをクラスターポートだけに限定する', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    const main = readFileSync(path.join(roleDir, 'tasks', 'main.yml'), 'utf8')
    const firewall = readFileSync(path.join(roleDir, 'tasks', 'firewall.yml'), 'utf8')
    expect(Array.isArray(load(firewall))).toBe(true)

    expect(defaults.k3s_manage_ufw).toBe(true)
    expect(defaults.k3s_cluster_source_cidr).toBe('')
    expect(main.indexOf('firewall.yml')).toBeLessThan(main.indexOf('cluster.yml'))
    expect(firewall).toContain('gather_subset')
    expect(firewall).toContain('ansible_default_ipv4')
    expect(firewall).toContain('RFC1918')
    expect(firewall).toContain('k3s_server_url')
    expect(firewall).toContain('6443')
    expect(firewall).toContain('2379:2380')
    expect(firewall).toContain('10250')
    expect(firewall).toContain('8472')
    expect(defaults.k3s_pod_cidr).toBe('10.42.0.0/16')
    expect(firewall).toContain('flannel.1')
    expect(firewall).toContain('cni0')
    expect(firewall).not.toContain('ufw allow 6443')
  })
})
