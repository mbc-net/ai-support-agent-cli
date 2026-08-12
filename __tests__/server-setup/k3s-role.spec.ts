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

  /**
   * disk.yml（増設SSDのパーティション作成〜マウント）の静的検証。
   *
   * このタスク列は誤ると OS ディスクを消し、fstab を壊して再起動不能にする。
   * 実挙動（実ブロックデバイスへの parted / mkfs / mount）は jest では検証不可で、
   * Molecule も特権コンテナと実デバイスを要するため回せない。したがってここでは
   * 「安全性を担保している構造そのもの」を不変条件として固定し、リファクタや
   * 追記でガードが外れることを防ぐ。
   */
  describe('tasks/disk.yml（破壊的ディスク操作）', () => {
    function diskTasks(): Array<Record<string, any>> {
      return loadYaml('tasks', 'disk.yml') as Array<Record<string, any>>
    }

    /** assert タスクの `that` 句を1本の文字列に畳んで返す（配列/単一文字列の両形式に対応）。 */
    function assertClauses(task: Record<string, any>): string {
      const that = task['ansible.builtin.assert']?.that
      if (Array.isArray(that)) return that.join('\n')
      return typeof that === 'string' ? that : ''
    }

    it('タスク列としてパースでき、全タスクが name を持つ', () => {
      const tasks = diskTasks()
      expect(Array.isArray(tasks)).toBe(true)
      expect(tasks.length).toBeGreaterThan(0)
      for (const task of tasks) {
        expect(typeof task.name).toBe('string')
        expect((task.name as string).length).toBeGreaterThan(0)
      }
    })

    it('デバイス指定は by-id のみを受け付け、生デバイス名（/dev/nvme* 等）を assert で拒否する', () => {
      // 生デバイス名はカーネルの列挙順に依存し、同一機種でもノードごとに入れ替わる
      // （実機 3 台のうち 1 台だけ OS ディスクが nvme0n1 だった）。誤指定は OS 全損。
      const clauses = diskTasks().map(assertClauses).join('\n')
      expect(clauses).toContain("'/' not in k3s_ephemeral_disk_id")
      expect(clauses).toContain('nvme[0-9]')
      expect(clauses).toContain('sd[a-z]')
    })

    it('マウント先の allowlist（/var/lib/ 配下）をインラインリテラルで強制する', () => {
      // 変数化するとレシピ側の vars で allowlist ごと上書きでき、ガードが無効化される。
      const clauses = diskTasks().map(assertClauses).join('\n')
      expect(clauses).toContain("item.startswith('/var/lib/')")
      expect(clauses).toContain("'..' not in item")
    })

    it('フォーマット前にシステムマウントポイント（/・/boot・/boot/efi）を載せていないことを assert する', () => {
      const tasks = diskTasks()
      const clauses = tasks.map(assertClauses).join('\n')
      expect(clauses).toContain("'/' not in")
      expect(clauses).toContain("'/boot' not in")
      expect(clauses).toContain("'/boot/efi' not in")

      // ガードは破壊的操作より前に置かれていなければ意味がない。
      const guardIndex = tasks.findIndex((t) =>
        assertClauses(t).includes("'/boot/efi' not in"),
      )
      const partedIndex = tasks.findIndex(
        (t) => t['ansible.builtin.command']?.argv?.[0] === 'parted',
      )
      const mkfsIndex = tasks.findIndex(
        (t) => t['ansible.builtin.command']?.argv?.[0] === 'mkfs.ext4',
      )
      expect(guardIndex).toBeGreaterThanOrEqual(0)
      expect(guardIndex).toBeLessThan(partedIndex)
      expect(guardIndex).toBeLessThan(mkfsIndex)
    })

    it('パーティション作成とフォーマットは冪等キー（FSラベルの有無）で when ガードされている', () => {
      // 再実行で再フォーマットが走るとデータ全損。指示書 §3.2 の冪等性要件。
      const tasks = diskTasks()
      const destructive = tasks.filter((t) =>
        ['parted', 'mkfs.ext4'].includes(t['ansible.builtin.command']?.argv?.[0]),
      )
      expect(destructive.length).toBe(2)
      for (const task of destructive) {
        expect(String(task.when)).toContain('k3s_ephemeral_needs_setup')
      }
    })

    it('bind マウントは ephemeral 本体のマウント後に張る（順序が逆だと空ディレクトリを覆う）', () => {
      const tasks = diskTasks()
      const mountTasks = tasks.filter((t) => t['ansible.posix.mount'])
      const ephemeralIndex = tasks.findIndex(
        (t) => t['ansible.posix.mount']?.fstype === 'ext4',
      )
      const bindIndex = tasks.findIndex(
        (t) => t['ansible.posix.mount']?.opts === 'bind',
      )
      expect(mountTasks.length).toBeGreaterThanOrEqual(2)
      expect(ephemeralIndex).toBeGreaterThanOrEqual(0)
      expect(bindIndex).toBeGreaterThan(ephemeralIndex)
    })

    it('disk.yml は cluster.yml より前に実行される（k3s 起動後の bind は既存データを隠蔽する）', () => {
      const main = readFileSync(path.join(roleDir, 'tasks', 'main.yml'), 'utf8')
      expect(main.indexOf('disk.yml')).toBeLessThan(main.indexOf('cluster.yml'))
    })

    /**
     * 回帰: `blkid -L <label>` はラベル→デバイス解決の専用モードで、
     * man blkid(8) に "the -L option prints the device name rather than the
     * token content" と明記されているとおり `-s` / `-o` を無視してデバイス名を返す。
     * これを UUID 取得に使うと stdout が `/dev/nvme0n1p1` になり、
     * `src: "UUID={{ ... }}"` が `UUID=/dev/nvme0n1p1` という不正な fstab エントリになって
     * 実機で `mount: /var/lib/ephemeral: can't find UUID=/dev/nvme0n1p1` で失敗した。
     */
    it('blkid の argv は -L（ラベル検索モード）と -s/-o（トークン出力）を併用しない', () => {
      const blkidTasks = diskTasks().filter(
        (t) => t['ansible.builtin.command']?.argv?.[0] === 'blkid',
      )
      expect(blkidTasks.length).toBeGreaterThan(0)

      for (const task of blkidTasks) {
        const argv = task['ansible.builtin.command'].argv as string[]
        if (!argv.includes('-L')) continue
        // -L モードでは -s/-o が無視され、UUID ではなくデバイス名が返る。
        // 失敗時にどのタスクの何が悪いかが出るよう、name と違反フラグを添えて比較する。
        const offending = argv.filter((arg) => arg === '-s' || arg === '-o')
        expect({ name: task.name, offending }).toEqual({
          name: task.name,
          offending: [],
        })
      }
    })

    it('UUID を fstab に流し込む前に UUID 形式であることを assert する（非空チェックだけにしない）', () => {
      // 非空チェックのみだと `/dev/nvme0n1p1` のようなデバイスパスが正常値として
      // 通過し、fstab 生成まで到達してしまう（実機で発生）。
      const uuidAsserts = diskTasks()
        .map(assertClauses)
        .filter((clauses) => clauses.includes('k3s_ephemeral_uuid_lookup'))
      expect(uuidAsserts.length).toBeGreaterThan(0)

      const combined = uuidAsserts.join('\n')
      expect(combined).toMatch(/is\s+match\(/)
      expect(combined).toContain('[0-9a-f]{8}')
      expect(combined).toContain('[0-9a-f]{12}')
    })
  })
})
