import { DEFAULT_SCHEMA, load } from 'js-yaml'

import { toErrorMessage } from '../utils'
import { isPlainObject } from '../utils/is-plain-object'

/**
 * サーバーセットアップレシピ本体（`body` = Ansible タスク列 YAML）の静的検証ガード。
 *
 * **セキュリティ上重要**: このロジックは実行環境（agentホスト / 当社 ECS）への攻撃経路
 * （任意コマンド実行・他ホストへの委譲・秘密情報の平文ログ出力・危険な
 * lookup/queryプラグイン経由のファイル読み取り等）を塞ぐための唯一の防御線。
 * allowlist に無いモジュール・危険なタスクキーは一律拒否し、フォールバックは
 * 行わない（CLAUDE.md フォールバック禁止ルール）。
 *
 * ## 経路別モード（`mode`）
 * - `ecs`: 当社基盤（ECS oneshot）で実行。厳格 allowlist を維持する。
 * - `resident`: 顧客の閉域ネットワーク内の常駐エージェントで実行。モジュール allowlist を
 *   寛容化する（追加モジュールを許可）。**ただし** denylist（危険タスクキー）・lookup 拒否・
 *   copy/template の src 拒否・`ansible_*`/magic 変数拒否は両モードで維持する。
 *
 * API 保存時（レシピ作成/更新）は安全側に倒し `mode: 'ecs'`（厳格側）で検証してよい
 * （早期 UX フィードバック）。権威判定は agent 実行時に `dispatchMode` に応じたモードで行う。
 *
 * ## `include_role` スニペット（組み込みステップ）
 * 組み込みステップ（os_init/ssh_key/docker/nvm/claude_cli/codex/ai_support_agent/
 * ai_support_agent_k8s/web_server/database/dns_tls/gitlab_runner/github_runner/
 * gitlab_runner_k8s/github_runner_k8s/k3s/
 * tailscale）は、bundled role を呼ぶ
 * `include_role` タスクとして表現する。`include_role` は下記 allowlist のロールのみ
 * 許可し、role 名と
 * 許可 param キーを専用バリデータで個別検査する。ロール変数は **task レベルの `vars:`**
 * （`include_role:` と同じインデントの兄弟キー）で渡す。`ansible.builtin.include_role`
 * モジュールに `vars` というパラメータは存在しない（モジュール引数内にネストすると実機の
 * `ansible-playbook` が `Invalid options for ansible.builtin.include_role: vars` で拒否する
 * ため、そちらは許可しない）。include_role タスクに限り task レベルの `vars` を
 * `FORBIDDEN_TASK_KEYS` の対象から除外し、中身は他タスクの `vars`（禁止のまま）と同じ
 * 予約語・マジック変数名チェックを適用する。
 *
 * 設計: admin-docs/docs/specifications/git-artifact-platform.md
 */

export type AnsibleTaskRouteMode = 'resident' | 'ecs'

export interface ValidateAnsibleTasksOptions {
  /** 実行経路。`ecs`=厳格、`resident`=モジュール allowlist 寛容化。 */
  mode: AnsibleTaskRouteMode
  /**
   * この検証呼び出し時点で「secretとして扱うべき」変数名の集合
   * （api保存時は空集合でよい。no_log付与はagent実行時に行う）。
   */
  secretVarNames?: ReadonlySet<string>
}

export interface AnsibleTaskViolation {
  taskIndex: number
  key: string
  reason: string
}

export interface AnsibleTaskValidationResult {
  ok: boolean
  violations: AnsibleTaskViolation[]
  normalizedTasks?: Record<string, unknown>[]
}

/**
 * タスクの実行環境に影響を与える・実行先を変える・秘密情報を露出させる
 * リスクのあるキー（完全一致）。1つでも存在すれば当該タスクを拒否する。
 * 両モード（resident/ecs）で維持する。
 */
const FORBIDDEN_TASK_KEYS: ReadonlySet<string> = new Set([
  'delegate_to',
  'delegate_facts',
  'local_action',
  'connection',
  'become_method',
  'become_exe',
  'become_flags',
  'become_user',
  'vars',
  'environment',
  'notify',
  'listen',
  'hosts',
  'import_playbook',
])

/**
 * play形式（`hosts`/`roles`/`vars_files` を持つトップレベル要素）の検出に使うキー。
 * これらを持つ要素が1つでもあれば YAML 全体を拒否する（タスクのリストのみ許可）。
 */
const PLAY_FORMAT_KEYS: readonly string[] = ['hosts', 'roles', 'vars_files']

/**
 * モジュールキー判定から除外する「タスク制御キー」。
 * これら以外の残りのキーが、実際にモジュールを指定しているキーとみなされる。
 */
const CONTROL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'tags',
  'register',
  'when',
  'no_log',
  'ignore_errors',
  'loop',
  'with_items',
  'until',
  'retries',
  'delay',
])

/**
 * `ansible.builtin.` を省略した短縮形での指定を許可するモジュール名（厳格=ecs）。
 *
 * **CRITICAL**: `template` はここから完全に除外している。`ansible.builtin.template`
 * は `src` が常に Ansible コントローラ側のローカルファイルパスとして解決される仕様で、
 * 安全に使える代替パラメータが無いため allowlist から除外する
 * （`copy` の `content` パラメータで代替可能）。
 */
const BUILTIN_SHORT_NAMES: ReadonlySet<string> = new Set([
  'apt',
  'apt_key',
  'apt_repository',
  'copy',
  'file',
  'user',
  'group',
  'service',
  'systemd',
  'lineinfile',
  'blockinfile',
  'replace',
  'stat',
  'get_url',
  'command',
  'shell',
  'debug',
  'assert',
  'set_fact',
  'wait_for',
])

/**
 * カスタム Ansible タスクで使用を許可するモジュール（フルネーム）の allowlist（厳格=ecs）。
 */
const MODULE_ALLOWLIST: ReadonlySet<string> = new Set([
  'ansible.builtin.apt',
  'ansible.builtin.apt_key',
  'ansible.builtin.apt_repository',
  'ansible.builtin.copy',
  'ansible.builtin.file',
  'ansible.builtin.user',
  'ansible.builtin.group',
  'ansible.builtin.service',
  'ansible.builtin.systemd',
  'ansible.builtin.lineinfile',
  'ansible.builtin.blockinfile',
  'ansible.builtin.replace',
  'ansible.builtin.stat',
  'ansible.builtin.get_url',
  'ansible.builtin.command',
  'ansible.builtin.shell',
  'ansible.builtin.debug',
  'ansible.builtin.assert',
  'ansible.builtin.set_fact',
  'ansible.builtin.wait_for',
  'ansible.mysql.mysql_user',
  'community.postgresql.postgresql_user',
  // Not resident-specific: SSH key management is an operation on the *target*
  // server, not a controller-host attack surface (unlike lookup/copy-src),
  // so it belongs in the base allowlist alongside the ssh_key bundled role.
  'ansible.posix.authorized_key',
])

/**
 * `resident_agent`（顧客の閉域）経路で追加で許可するモジュール（フルネーム）。
 *
 * 顧客自機・閉域内の実行のため、当社基盤より広いモジュールを許容する。
 * ただし denylist（危険タスクキー）・lookup 拒否・copy/template src 拒否・
 * `ansible_*` 拒否は resident でも維持する（緩和はモジュール allowlist に限定）。
 */
const RESIDENT_EXTRA_MODULE_ALLOWLIST: ReadonlySet<string> = new Set([
  'ansible.builtin.uri',
  'ansible.builtin.git',
  'ansible.builtin.unarchive',
  'ansible.builtin.pip',
  'ansible.builtin.cron',
  'ansible.builtin.hostname',
  'ansible.builtin.mount',
  'ansible.posix.mount',
  'ansible.posix.sysctl',
  'community.general.timezone',
  'community.docker.docker_container',
  'community.docker.docker_image',
  'community.docker.docker_network',
])

/** resident 経路で追加許可する短縮形。 */
const RESIDENT_EXTRA_SHORT_NAMES: ReadonlySet<string> = new Set([
  'uri',
  'git',
  'unarchive',
  'pip',
  'cron',
  'hostname',
  'mount',
])

/** `copy` モジュールの正規化後キー名（`src` パラメータ拒否チェックに使用）。 */
const COPY_MODULE_KEY = 'ansible.builtin.copy'

/** `include_role` の正規化後キー名の集合。 */
const INCLUDE_ROLE_MODULE_KEYS: ReadonlySet<string> = new Set([
  'include_role',
  'ansible.builtin.include_role',
])

/**
 * `include_role` で呼び出しを許可する bundled role の集合。
 * 組み込みステップ（スニペット）に 1:1 対応し、`ansible/roles/` 配下の実ディレクトリと
 * 1:1 で一致すること（追加漏れ・非対称は spec で検出する）。
 *
 * `claude_cli`/`codex`/`ai_support_agent` は `nvm` ロールで導入した Node.js/npm に
 * 依存する。`gitlab_runner`/`github_runner`（CI ランナー登録）で executor=docker を
 * 使う場合は `docker` ロールに依存する。ロール間の自動依存機構は無いため、レシピ
 * 作成者が依存ロールを先に include する運用とし、各ロールは前提を `assert` で検証する。
 *
 * `k3s` は単一ロールで OS 前提整備・ephemeral ディスク・k3s(HA/単一)・gVisor を
 * トグル変数で制御する重量ロール。破壊的なディスク操作・秘匿トークンを扱うため、
 * ロール内部で by-id/UUID 強制・冪等ガード・no_log を徹底する（roles/k3s 参照）。
 *
 * `tailscale` は Tailscale（WireGuard メッシュVPN）へ auth key で非対話参加する単一
 * ロール。秘匿の auth key を 0600 一時ファイル＋`--auth-key=file:` で扱い argv に
 * 載せない（roles/tailscale 参照）。
 *
 * `ai_support_agent_k8s` は kubectl/kubeconfig を持つノード上で動き、エージェントを
 * StatefulSet としてクラスタへ配置する。ホスト常駐の `ai_support_agent` とは配送経路が
 * 異なり、対象ホストに Node.js を導入しないため `nvm` には依存しない。エージェント
 * トークンは 0600 一時ファイル経由で `kubectl create secret --from-file=` に渡し、argv・
 * `environment:`・生成マニフェストのいずれにも載せない（roles/ai_support_agent_k8s 参照）。
 *
 * `rsyslog_server`/`rsyslog_forward` は syslog の集約基盤。`rsyslog_server` は受信側で、送信元制限が
 * 未指定なら**実行を失敗させる**（fail-closed）——`$AllowedSender` 無しの rsyslog は全世界から
 * ログを受け付け、ログ偽造とディスク枯渇の入口になるため。`rsyslog_forward` は送信側で、ディスク
 * アシストキューを既定で有効にする（転送先ダウン中のログが黙って消えるのを防ぐ）。どちらも設定を
 * 配置したあと `rsyslogd -N1` で**統合後の設定**を検証し、失敗したらバックアップから復元する
 * （roles/rsyslog_server・roles/rsyslog_forward 参照）。
 *
 * `zabbix_agent` は監視対象ホストへの Zabbix Agent 導入・設定。**Zabbix サーバー側へのホスト登録は
 * 含まない**（登録が無いと、エージェントが正常稼働していても監視項目は 1 つも収集されない）。
 * PSK は 0600 で配置し、暗号化を無効に戻したときは鍵ファイルを削除する。コンテナ化すると `/proc` が
 * コンテナのものになり「別のマシンを監視している」状態になるため、docker 経路は提供しない
 * （roles/zabbix_agent 参照）。
 *
 * `gitlab_runner_k8s`/`github_runner_k8s` は CI ランナーを**ホストではなくクラスタ上**へ
 * 配置する。`ai_support_agent_k8s` と同じく kubectl/kubeconfig を持つノードで動き、
 * トークン Secret を 0600 一時ファイル経由で作ったうえで、HelmChart CR には
 * 「既存 Secret の名前」だけを書く（秘匿値は生成マニフェストに載らない）。チャートの
 * 取得元（repo / OCI 参照 / チャート名）はロール内のインラインリテラルであり、レシピ側の
 * task-level vars から差し替えできない。ジョブは非特権に固定し、privileged / dind を
 * 有効化する変数は提供しない（roles/gitlab_runner_k8s・roles/github_runner_k8s 参照）。
 */
export const INCLUDE_ROLE_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'os_init',
  'ssh_key',
  'docker',
  'nvm',
  'claude_cli',
  'codex',
  'ai_support_agent',
  'ai_support_agent_k8s',
  'web_server',
  'database',
  'dns_tls',
  'gitlab_runner',
  'github_runner',
  'gitlab_runner_k8s',
  'github_runner_k8s',
  'k3s',
  'tailscale',
  'shared_file',
  'rsyslog_server',
  'rsyslog_forward',
  'zabbix_agent',
])

/**
 * `include_role` の task レベル `vars:` でレシピが渡してよい変数名を、ロールごとに列挙したもの。
 *
 * **なぜ「名前が予約語でない」だけでは足りないのか。**
 * Ansible の変数優先順位では、`include_role` に付けた task レベルの `vars:` は "include params"
 * として扱われ、**ロール内部の `set_fact` にも `register` の結果にも勝つ**（ansible-core 2.17 で実測:
 * ロールが実際にコマンドを実行して `register` した変数を参照しても、呼び出し側が同名を渡すと
 * そちらの値が読まれる）。
 *
 * つまり allowlist が無いと、レシピはロールが計算した中間状態を丸ごと差し替えられる。実害の例:
 *
 * - `k3s_ephemeral_device` は by-id パスから組み立てられて `parted` / `mkfs.ext4` へ渡る。直接渡せば
 *   ロールが安全装置としている by-id 強制を迂回して任意のブロックデバイスを破壊できる
 * - `k3s_ephemeral_needs_setup: true` を渡せば、既存ファイルシステムがあってもパーティション操作が走る
 * - `rsyslog_server_ufw_stale` を渡せば `ufw --force delete` の対象を指定できる（SSH ルールの削除）
 * - ヘルスチェックが参照する `register` 結果を渡せば、実際には失敗している検証を成功に見せられる
 *
 * ロール側では防げない（呼び出し側が必ず勝つ）ため、ガードで名前を絞るのが唯一の対策である。
 *
 * **このリストの作り方。** 各ロールの `defaults/main.yml` のキーと、tasks/templates が参照する
 * ロール接頭辞付きの変数の和集合から、**`set_fact` のキー・`register` 名・task レベル `vars:` で
 * 計算される名前を除いたもの**。除外が要点であり、内部変数がここに混ざると防御が無効になる。
 * agent 側のテストが実ロールから同じ手順で再計算して突き合わせるため、ロールを変更すると差分が出る。
 *
 * 空集合（`docker`）は「レシピから渡せる変数が無い」という意味であり、誤りではない。
 */
export const INCLUDE_ROLE_ALLOWED_VARS: Readonly<Record<string, ReadonlySet<string>>> = {
  ai_support_agent: new Set([
    'ai_support_agent_api_url',
    'ai_support_agent_package',
    'ai_support_agent_project_code',
    'ai_support_agent_token',
    'ai_support_agent_tokens',
    'ai_support_agent_user',
  ]),
  ai_support_agent_k8s: new Set([
    'ai_support_agent_k8s_api_url',
    'ai_support_agent_k8s_data_dir',
    'ai_support_agent_k8s_image',
    'ai_support_agent_k8s_kubeconfig',
    'ai_support_agent_k8s_kubectl',
    'ai_support_agent_k8s_manifest_dir',
    'ai_support_agent_k8s_name',
    'ai_support_agent_k8s_namespace',
    'ai_support_agent_k8s_persistence',
    'ai_support_agent_k8s_project',
    'ai_support_agent_k8s_projects',
    'ai_support_agent_k8s_replicas',
    'ai_support_agent_k8s_self_instance_id',
    'ai_support_agent_k8s_self_restart_ack_file',
    'ai_support_agent_k8s_self_restart_ack_timeout_seconds',
    'ai_support_agent_k8s_self_restart_marker_file',
    'ai_support_agent_k8s_storage_class',
    'ai_support_agent_k8s_storage_size',
    'ai_support_agent_k8s_termination_grace_period_seconds',
    'ai_support_agent_k8s_token',
  ]),
  claude_cli: new Set([
    'claude_cli_oauth_token',
    'claude_cli_package',
    'claude_cli_user',
  ]),
  codex: new Set([
    'codex_api_key',
    'codex_oauth_token',
    'codex_package',
    'codex_user',
  ]),
  database: new Set([
    'db_root_password',
    'db_type',
  ]),
  dns_tls: new Set([
    'acme_email',
    'domain',
  ]),
  docker: new Set<string>(),
  github_runner: new Set([
    'github_runner_dir',
    'github_runner_ephemeral',
    'github_runner_group',
    'github_runner_labels',
    'github_runner_name',
    'github_runner_pat',
    'github_runner_registration_token',
    'github_runner_replace',
    'github_runner_scope',
    'github_runner_url',
    'github_runner_user',
    'github_runner_version',
    'github_runner_work',
  ]),
  github_runner_k8s: new Set([
    'github_runner_k8s_chart_version',
    'github_runner_k8s_controller_enabled',
    'github_runner_k8s_controller_namespace',
    'github_runner_k8s_kubeconfig',
    'github_runner_k8s_kubectl',
    'github_runner_k8s_manifest_dir',
    'github_runner_k8s_max_runners',
    'github_runner_k8s_min_runners',
    'github_runner_k8s_name',
    'github_runner_k8s_namespace',
    'github_runner_k8s_pat',
    'github_runner_k8s_url',
  ]),
  gitlab_runner: new Set([
    'gitlab_runner_auth_token',
    'gitlab_runner_description',
    'gitlab_runner_docker_image',
    'gitlab_runner_executor',
    'gitlab_runner_locked',
    'gitlab_runner_registration_token',
    'gitlab_runner_run_untagged',
    'gitlab_runner_tag_list',
    'gitlab_runner_url',
  ]),
  gitlab_runner_k8s: new Set([
    'gitlab_runner_k8s_auth_token',
    'gitlab_runner_k8s_chart_version',
    'gitlab_runner_k8s_concurrent',
    'gitlab_runner_k8s_job_image',
    'gitlab_runner_k8s_kubeconfig',
    'gitlab_runner_k8s_kubectl',
    'gitlab_runner_k8s_locked',
    'gitlab_runner_k8s_manifest_dir',
    'gitlab_runner_k8s_name',
    'gitlab_runner_k8s_namespace',
    'gitlab_runner_k8s_registration_token',
    'gitlab_runner_k8s_replicas',
    'gitlab_runner_k8s_run_untagged',
    'gitlab_runner_k8s_tags',
    'gitlab_runner_k8s_url',
  ]),
  k3s: new Set([
    'gvisor_enabled',
    'k3s_bind_mounts',
    'k3s_bootstrap',
    'k3s_cluster_source_cidr',
    'k3s_containerd_template_name',
    'k3s_disable',
    'k3s_disable_swap',
    'k3s_enable_iscsid',
    'k3s_ephemeral_disk_id',
    'k3s_ephemeral_fs_label',
    'k3s_ephemeral_mount',
    'k3s_ephemeral_mount_opts',
    'k3s_etcd_s3_access_key',
    'k3s_etcd_s3_bucket',
    'k3s_etcd_s3_enabled',
    'k3s_etcd_s3_endpoint',
    'k3s_etcd_s3_folder',
    'k3s_etcd_s3_region',
    'k3s_etcd_s3_secret_key',
    'k3s_etcd_snapshot_retention',
    'k3s_etcd_snapshot_schedule_cron',
    'k3s_extra_server_args',
    'k3s_gvisor_apply_runtimeclass',
    'k3s_gvisor_base_url',
    'k3s_gvisor_release',
    'k3s_install_url',
    'k3s_kernel_modules',
    'k3s_kubeconfig_mode',
    'k3s_longhorn_path',
    'k3s_manage_ufw',
    'k3s_node_ip',
    'k3s_node_taints',
    'k3s_packages',
    'k3s_pod_cidr',
    'k3s_ready_delay',
    'k3s_ready_retries',
    'k3s_server_url',
    'k3s_setup_cluster',
    'k3s_setup_common',
    'k3s_setup_disk',
    'k3s_sysctl',
    'k3s_time_sync_service',
    'k3s_token',
    'k3s_version',
  ]),
  nvm: new Set([
    'node_version',
    'nvm_user',
    'nvm_version',
  ]),
  os_init: new Set([
    'os_init_user',
  ]),
  rsyslog_forward: new Set([
    'rsyslog_forward_protocol',
    'rsyslog_forward_queue_enabled',
    'rsyslog_forward_queue_max_disk_space',
    'rsyslog_forward_queue_save_on_shutdown',
    'rsyslog_forward_queue_spool_directory',
    'rsyslog_forward_resume_retry_count',
    'rsyslog_forward_selector',
    'rsyslog_forward_target_host',
    'rsyslog_forward_target_port',
  ]),
  rsyslog_server: new Set([
    'rsyslog_server_allow_all_senders',
    'rsyslog_server_allowed_senders',
    'rsyslog_server_bind_address',
    'rsyslog_server_log_root',
    'rsyslog_server_logrotate_compress',
    'rsyslog_server_logrotate_days',
    'rsyslog_server_port',
    'rsyslog_server_tcp_enabled',
    'rsyslog_server_udp_enabled',
    'rsyslog_server_ufw_manage',
  ]),
  shared_file: new Set([
    'shared_file_dest',
    'shared_file_directory_mode',
    'shared_file_group',
    'shared_file_mode',
    'shared_file_owner',
    'shared_file_src',
    'shared_file_staging_dir',
  ]),
  ssh_key: new Set([
    'ssh_key_public_key',
    'ssh_key_user',
  ]),
  tailscale: new Set([
    'tailscale_accept_routes',
    'tailscale_advertise_exit_node',
    'tailscale_advertise_routes',
    'tailscale_advertise_tags',
    'tailscale_authkey',
    'tailscale_hostname',
    'tailscale_install_url',
    'tailscale_ssh',
    'tailscale_up_timeout',
  ]),
  web_server: new Set([
    'web_server_type',
  ]),
  zabbix_agent: new Set([
    'zabbix_agent_active_check_verify_seconds',
    'zabbix_agent_allowed_sources',
    'zabbix_agent_hostname',
    'zabbix_agent_listen_port',
    'zabbix_agent_psk',
    'zabbix_agent_psk_identity',
    'zabbix_agent_server',
    'zabbix_agent_server_active',
    'zabbix_agent_tls_accept',
    'zabbix_agent_tls_connect',
    'zabbix_agent_ufw_manage',
    'zabbix_agent_variant',
    'zabbix_agent_version',
  ]),
}

/**
 * `include_role` のモジュール引数マッピングで許可する param キー。
 * - `name`: 必須。{@link INCLUDE_ROLE_ALLOWED_ROLES} のいずれか。
 * - `tasks_from`: ロール内の代替タスクファイル名（ロールディレクトリ内に閉じる）。
 * - `public`: include したロールの変数を後続へ公開するか（真偽値）。
 *
 * **`vars` はここに含めない**: `ansible.builtin.include_role` モジュールに `vars` という
 * パラメータは存在しない（実機の `ansible-playbook --syntax-check` で
 * `[ERROR]: Invalid options for ansible.builtin.include_role: vars` になることを確認済み）。
 * ロール変数は代わりに **task レベルの `vars:`**（`include_role:` と同じインデントの
 * 兄弟キー）で渡す。`validateAnsibleTasks` 側で、include_role タスクに限り task レベルの
 * `vars` を `FORBIDDEN_TASK_KEYS` の対象から除外し、その中身を
 * {@link validateIncludeRoleTaskVars} で検証する。
 */
const INCLUDE_ROLE_ALLOWED_PARAM_KEYS: ReadonlySet<string> = new Set(['name'])

/*
 * `tasks_from` と `public` はレシピから使えない。どちらもかつては許可していたが、
 * ロール内部の検証や秘匿処理を迂回する入口になるため取り下げた。
 * 組み込みスニペットはどちらも使っていない（使用箇所ゼロ）。
 *
 * **`tasks_from`**: ロール内の別タスクファイルを直接実行できてしまう。ロールは
 * 「main.yml が入力を検証し、その後で内部ファイルを include する」構成になっている
 * ので、これは検証の迂回そのものになる。実例:
 *
 *   include_role: { name: zabbix_agent, tasks_from: ufw }
 *     → main.yml の CIDR 書式検証・`0.0.0.0/0` 拒否を飛ばして ufw.yml だけを実行できる
 *   include_role: { name: k3s, tasks_from: disk }
 *     → 破壊的なディスク操作を、main.yml の前提チェックなしで直接呼べる
 *
 * ロール側で各ファイルが独立に再検証する手もあるが、ファイルを増やすたびに
 * 検証の複製が要る設計になり、抜けたときに気づけない。入口を閉じる方が確実である。
 *
 * **`public`**: include したロールの変数を後続タスクへ公開する。ロールの内部派生値
 * （`ai_support_agent_k8s_project_specs` はトークンを含む）が後続から参照できるようになり、
 * `referencesSecretVar` は元の秘匿変数名しか追跡しないので派生名の参照には `no_log` が
 * 付かない。秘匿値が実行ログや `stepResults[].message` に出る経路になる。
 */

/**
 * bundled role の名前空間に属する変数名かどうか。
 *
 * `include_role` の `vars:` は {@link INCLUDE_ROLE_ALLOWED_VARS} で絞ったが、レシピ本体には
 * `set_fact` タスクも書ける。そちらを素通りさせると、同じ変数へ別の入口から到達できてしまう:
 *
 *   - name: rsyslog_forward を include
 *   - name: ロールが立てた実行済みフラグを戻す
 *     ansible.builtin.set_fact: { rsyslog_forward_already_configured: false }
 *   - name: もう一度 include   ← 二重 include の検出をすり抜ける
 *
 * ロールが自分の状態を持つのに使う名前空間（`<role>_...`）へは、レシピから一切書き込めない
 * ようにする。レシピがロールへ値を渡す唯一の経路は `include_role` の `vars:` であり、
 * そこは allowlist で公開パラメータだけに絞られている。
 */
function isBundledRoleNamespacedName(name: string): boolean {
  for (const role of INCLUDE_ROLE_ALLOWED_ROLES) {
    if (name.startsWith(`${role}_`)) return true
  }
  return false
}

/**
 * 同梱ロールが内部計算に使う変数名（`set_fact` の定義名と `register` の登録名）。
 * `ansible/roles/**\/{tasks,handlers}/*.yml` から機械的に収集したもので、
 * agent 側の構造テストが実ロールとの一致を検査する（新しい内部変数を足したのに
 * ここへ載せ忘れると CI が赤くなる = fail-closed）。
 *
 * **なぜ「書き込み禁止」だけでなく「参照禁止」も要るのか。**
 * `include_role` の `public` を禁止したので、ロール内部の値はレシピから見えない——
 * と考えていたが、実測ではそうならない。`register` の結果と `set_fact` の値は
 * ロールスコープではなくホストの変数なので、`public` を指定しなくても include の
 * あとのタスクから読める（ansible-core 2.21 で確認: ロール内で `no_log: true` を
 * 付けて register した値を、後続の `debug` がそのまま出力した）。
 *
 * これが効くのは秘匿値である。例えば `github_runner` ロールは runner 登録トークンを
 * `github_runner_regtoken_resp` に register する。レシピが
 * `{{ github_runner_regtoken_resp.json.token }}` を出力するタスクを書いても、
 * `referencesSecretVar` はテナントの秘匿変数名しか見ていないので `no_log` が付かず、
 * トークンが実行ログと `stepResults[].message` に平文で残る。
 *
 * 参照禁止は**この実名リスト**で行い、接頭辞では行わない。接頭辞で禁止すると
 * `database_url` のような、たまたまロール名で始まるだけのテナント変数まで巻き添えで
 * 拒否してしまうため。書き込み側は従来どおり接頭辞でも拒否する（そちらは
 * レシピ側に正当な用途が無い）。
 */
export const BUNDLED_ROLE_INTERNAL_VARS: ReadonlySet<string> = new Set([
  // ai_support_agent
  'ai_support_agent_configure_items',
  'ai_support_agent_configure_results',
  'ai_support_agent_empty_token_entries',
  'ai_support_agent_install_result',
  'ai_support_agent_linger_status',
  'ai_support_agent_nvm_check',
  'ai_support_agent_token_tempfiles',
  'ai_support_agent_token_writes',
  'ai_support_agent_uid',
  // ai_support_agent_k8s
  'ai_support_agent_k8s_apply',
  'ai_support_agent_k8s_kubeconfig_stat',
  'ai_support_agent_k8s_kubectl_stat',
  'ai_support_agent_k8s_manifest',
  'ai_support_agent_k8s_namespace_apply',
  'ai_support_agent_k8s_pending_self_targets',
  'ai_support_agent_k8s_rollout',
  'ai_support_agent_k8s_secret_apply',
  'ai_support_agent_k8s_secret_current',
  'ai_support_agent_k8s_self_apply',
  'ai_support_agent_k8s_self_restart_ack',
  'ai_support_agent_k8s_self_restart_ack_content',
  'ai_support_agent_k8s_self_restart_marker',
  'ai_support_agent_k8s_token_tempfile',
  // claude_cli
  'claude_cli_install_result',
  'claude_cli_nvm_check',
  // codex
  'codex_api_key_login_result',
  'codex_api_key_tempfile',
  'codex_install_result',
  'codex_nvm_check',
  'codex_oauth_login_result',
  'codex_oauth_token_tempfile',
  // database
  'db_mysql_root_password_result',
  'db_postgres_password_result',
  // dns_tls
  'dns_tls_caddyfile',
  // github_runner
  'github_runner_api_url',
  'github_runner_arch',
  'github_runner_config_result',
  'github_runner_dir_effective',
  'github_runner_has_pat',
  'github_runner_has_regtoken',
  'github_runner_latest_release',
  'github_runner_regtoken_resp',
  'github_runner_regtoken_tempfile',
  'github_runner_svc_marker',
  'github_runner_user_check',
  'github_runner_version_resolved',
  // github_runner_k8s
  'github_runner_k8s_apply',
  'github_runner_k8s_arc_crd',
  'github_runner_k8s_controller_apply',
  'github_runner_k8s_controller_wait',
  'github_runner_k8s_helm_crd',
  'github_runner_k8s_kubeconfig_stat',
  'github_runner_k8s_kubectl_stat',
  'github_runner_k8s_listener_wait',
  'github_runner_k8s_manifest',
  'github_runner_k8s_namespace_apply',
  'github_runner_k8s_pat_tempfile',
  'github_runner_k8s_secret_apply',
  // gitlab_runner
  'gitlab_runner_docker_check',
  'gitlab_runner_has_auth',
  'gitlab_runner_has_reg',
  'gitlab_runner_register_auth',
  'gitlab_runner_register_legacy',
  'gitlab_runner_token_tempfile',
  // gitlab_runner_k8s
  'gitlab_runner_k8s_apply',
  'gitlab_runner_k8s_empty_tempfile',
  'gitlab_runner_k8s_has_auth',
  'gitlab_runner_k8s_has_reg',
  'gitlab_runner_k8s_helm_crd',
  'gitlab_runner_k8s_kubeconfig_stat',
  'gitlab_runner_k8s_kubectl_stat',
  'gitlab_runner_k8s_manifest',
  'gitlab_runner_k8s_namespace_apply',
  'gitlab_runner_k8s_rollout',
  'gitlab_runner_k8s_secret_apply_auth',
  'gitlab_runner_k8s_secret_apply_legacy',
  'gitlab_runner_k8s_token_tempfile',
  'gitlab_runner_k8s_verify',
  // k3s
  'k3s_binary_for_gvisor',
  'k3s_effective_cluster_source_cidr',
  'k3s_ephemeral_device',
  'k3s_ephemeral_label_device',
  'k3s_ephemeral_label_lookup',
  'k3s_ephemeral_mountpoints',
  'k3s_ephemeral_needs_setup',
  'k3s_ephemeral_partition',
  'k3s_ephemeral_stat',
  'k3s_ephemeral_uuid_lookup',
  'k3s_gvisor_url_base',
  'k3s_install_result',
  'k3s_join_ready',
  'k3s_join_server_host',
  'k3s_lsmod',
  'k3s_needs_install',
  'k3s_nodes_ready',
  'k3s_time_sync_load_states',
  'k3s_time_sync_resolved',
  'k3s_time_sync_unit_states',
  'k3s_ufw_enable',
  'k3s_ufw_flannel',
  'k3s_ufw_pods',
  'k3s_ufw_ssh',
  'k3s_ufw_status',
  'k3s_ufw_tcp',
  'k3s_version_check',
  // nvm
  'nvm_install_node_result',
  'nvm_resolved_dir',
  // os_init
  'os_init_ufw_allow_ssh',
  'os_init_ufw_enable',
  'os_init_ufw_status',
  // rsyslog_forward
  'rsyslog_forward_already_configured',
  'rsyslog_forward_conf_before',
  'rsyslog_forward_conf_result',
  'rsyslog_forward_invocation',
  'rsyslog_forward_is_active',
  'rsyslog_forward_journal',
  'rsyslog_forward_revalidate',
  'rsyslog_forward_spool_writable',
  'rsyslog_forward_validate',
  // rsyslog_server
  'rsyslog_server_conf_before',
  'rsyslog_server_conf_result',
  'rsyslog_server_is_active',
  'rsyslog_server_listen_sockets',
  'rsyslog_server_main_pid',
  'rsyslog_server_revalidate',
  'rsyslog_server_ufw_add',
  'rsyslog_server_ufw_added',
  'rsyslog_server_ufw_after_add',
  'rsyslog_server_ufw_delete',
  'rsyslog_server_ufw_desired',
  'rsyslog_server_ufw_desired_patterns',
  'rsyslog_server_ufw_stale',
  'rsyslog_server_validate',
  // shared_file
  'shared_file_dest_dir',
  'shared_file_dest_dir_stat',
  'shared_file_staged',
  // tailscale
  'tailscale_authkey_tempfile',
  'tailscale_bin',
  'tailscale_has_authkey',
  'tailscale_install_result',
  'tailscale_up_result',
  // zabbix_agent
  'zabbix_agent_invocation',
  'zabbix_agent_is_active',
  'zabbix_agent_journal',
  'zabbix_agent_other_service',
  'zabbix_agent_psk_socket',
  'zabbix_agent_repo_pkg',
  'zabbix_agent_ufw_add',
  'zabbix_agent_ufw_added',
  'zabbix_agent_ufw_after_add',
  'zabbix_agent_ufw_delete',
  'zabbix_agent_ufw_desired',
  'zabbix_agent_ufw_desired_patterns',
  'zabbix_agent_ufw_stale',
])

/** set_fact / register で禁止する予約語・マジック変数名（完全一致）。 */
const RESERVED_VAR_NAMES: ReadonlySet<string> = new Set([
  'hostvars',
  'groups',
  'group_names',
  'inventory_hostname',
  'inventory_hostname_short',
  'play_hosts',
  'ansible_play_hosts',
  'environment',
])

/**
 * 接続用の認証情報を保持する Ansible 予約変数（完全一致）。`buildInventory`
 * が `authType === 'password'` のホストに設定する `ansible_ssh_pass` など、
 * テナント側の `secretVarNames`（ANSIBLE# プロジェクト変数）とは別に、常に
 * secret 扱いする。`isReservedVarName`（set_fact/register での書き込み禁止）
 * とは独立に、`referencesSecretVar` 側（no_log 付与のためのタスク内容の
 * **参照**検出）にも常時マージする — でなければ `fail_msg: "{{
 * ansible_ssh_pass }}"` のようなタスクでパスワードが平文のまま
 * stepResults[].message / 実行エラー文字列に露出する。
 */
const ALWAYS_SECRET_VAR_NAMES: ReadonlySet<string> = new Set([
  'ansible_ssh_pass',
  'ansible_password',
  'ansible_ssh_private_key_file',
  'ansible_become_pass',
])

/** `lookup(...)` / `query(...)` / `q(...)` プラグイン参照を検出する正規表現。 */
const LOOKUP_PLUGIN_PATTERN = /\b(lookup|query|q)\s*\(/

const SET_FACT_MODULE_KEYS: ReadonlySet<string> = new Set([
  'set_fact',
  'ansible.builtin.set_fact',
])

/**
 * モジュールキーを `ansible.builtin.` 省略形からフルネームへ正規化する。
 * mode によって認識する短縮形が変わる（resident は追加短縮形を認識する）。
 */
function normalizeModuleKey(key: string, mode: AnsibleTaskRouteMode): string {
  if (BUILTIN_SHORT_NAMES.has(key)) return `ansible.builtin.${key}`
  if (key === 'include_role') return 'ansible.builtin.include_role'
  if (mode === 'resident' && RESIDENT_EXTRA_SHORT_NAMES.has(key)) {
    return `ansible.builtin.${key}`
  }
  return key
}

/** mode に応じた実効モジュール allowlist を返す。 */
function moduleAllowlistFor(mode: AnsibleTaskRouteMode): ReadonlySet<string> {
  if (mode !== 'resident') return MODULE_ALLOWLIST
  return new Set<string>([...MODULE_ALLOWLIST, ...RESIDENT_EXTRA_MODULE_ALLOWLIST])
}

/** 予約語・マジック変数名かどうかを判定する（`ansible_` プレフィックス or 完全一致）。 */
function isReservedVarName(name: string): boolean {
  return name.startsWith('ansible_') || RESERVED_VAR_NAMES.has(name)
}

/** 値を再帰的に走査し、lookup/query参照が無いかを調べる。 */
function containsLookupPluginReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return LOOKUP_PLUGIN_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsLookupPluginReference(item))
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => containsLookupPluginReference(item))
  }
  return false
}

/**
 * タスクが `secretVarNames` のいずれかを `{{ ... }}` 式の中で参照しているかを判定する。
 * Jinjaフィルタ付き参照（`{{ NAME | quote }}` 等）や複数変数混在の式でも検出する
 * （見落とし＝secret 平文が実行ログに残るリスクを無くす方向。誤検知は許容）。
 */
/**
 * タスク全体に現れる識別子を集める。
 *
 * **`{{ ... }}` の中だけを見てはいけない。** 最初はそう実装したが、次の 3 つが
 * そのまま素通りすることを実測した:
 *
 *   - `msg: "{% set x = NAME %}{{ x }}"` … Jinja のステートメントは `{{ }}` ではない
 *   - `debug: { var: NAME }`             … `debug` の `var` は変数名そのものを取る
 *   - `when: NAME.foo is match('^A')`    … `when` は素の Jinja 式で波括弧を書かない
 *
 * Jinja が値を評価する場所を数え上げてそれぞれ対応する方針は、数え漏らした場所が
 * そのまま穴になる。ここでは**タスクのどこかに識別子として現れたら該当**とする。
 * 内部変数 154 個と公開パラメータ 185 個の名前の重複は 0 件であることを確認しており、
 * 正当なレシピを巻き込まない。
 *
 * この関数は「ロール内部変数の参照禁止」と「秘匿値の no_log 判定」の**両方**で使う。
 * かつては後者だけが `{{ }}` 限定の別実装を持っていて、同じ穴が片方にだけ残った。
 *
 * **走査は JSON 文字列ではなく、デコード済みの値に対して行う。** かつては
 * `JSON.stringify(task)` を 1 本の文字列として字句解析していたが、JSON エスケープが
 * 識別子の直前に来ると先頭文字と癒着して別の名前になった（実測）:
 *
 *   debug: { var: "\tgithub_runner_regtoken_resp" }
 *     → JSON では "\tgithub_runner_regtoken_resp" となり、字句解析の結果は
 *       `tgithub_runner_regtoken_resp`。内部変数の参照禁止に一致しない。
 *       一方 Jinja は `{{ }}` の内側の空白を無視するので、**実機ではそのまま解決され**、
 *       ロールが register した登録トークンの全文が実行ログへ出た。
 *   when: "\tANSIBLE_SECRET is match('^x')"
 *     → 同じ理由で秘匿名に一致せず `no_log` が付かない。正規表現で 1 文字ずつ
 *       秘匿値を読み出すオラクルになる。
 *
 * YAML パーサが `\t` を実際のタブへ復元したあとの文字列を見れば、この癒着は起きない。
 * 念のため JSON 側の字句解析結果も和集合に残す（名前が増える方向＝fail-closed であり、
 * 深いネストで再帰を打ち切った場合の取りこぼしも埋める）。
 */
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g

/** 再帰の深さ上限。レシピ本体の YAML でこの深さに達することは無い。 */
const MAX_VALUE_WALK_DEPTH = 64

function collectTemplateReferencedNames(
  task: Record<string, unknown>,
): ReadonlySet<string> {
  const names = new Set<string>()
  const addIdentifiers = (text: string): void => {
    for (const identifier of text.match(IDENTIFIER_PATTERN) ?? []) {
      names.add(identifier)
    }
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_VALUE_WALK_DEPTH) return
    if (typeof value === 'string') {
      addIdentifiers(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        addIdentifiers(key)
        visit(item, depth + 1)
      }
    }
  }
  visit(task, 0)
  try {
    addIdentifiers(JSON.stringify(task))
  } catch {
    // 循環参照は YAML パース結果には現れないが、増える方向の補助なので無視でよい。
  }
  return names
}

/**
 * 値そのものが Jinja 式として評価されるキー。
 *
 * `CONTROL_KEYS` に無いキーはモジュール候補として allowlist に照合され拒否されるので、
 * レシピが書ける「波括弧なしの Jinja 式」はここに挙げたものが全てである
 * （`changed_when` / `failed_when` はモジュール候補になるため書けない）。
 * `var` は `debug` / `assert` が取る「変数名そのもの」で、Ansible が `{{ }}` で包む。
 */
const BARE_JINJA_KEYS: ReadonlySet<string> = new Set([
  'when',
  'until',
  'loop',
  'with_items',
  'var',
])

/**
 * Jinja が式として評価する断片だけを集める。
 *
 * `vars` の検出に使う。`vars` は英単語でもあるため、タスク全体の字句解析で拒否すると
 * `- name: Set some vars` のような無害な記述まで巻き添えにする。式の内側に限れば
 * その誤検知が消える一方、`{{ vars }}` / `{{ vars | dict2items }}` /
 * `{{ vars.get('github_runner_' ~ 'regtoken_resp') }}` はいずれもここに入る。
 */
function collectJinjaExpressions(task: Record<string, unknown>): string[] {
  const expressions: string[] = []
  const addString = (text: string, bare: boolean): void => {
    if (bare) expressions.push(text)
    for (const region of text.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? []) {
      expressions.push(region)
    }
  }
  const visit = (value: unknown, bare: boolean, depth: number): void => {
    if (depth > MAX_VALUE_WALK_DEPTH) return
    if (typeof value === 'string') {
      addString(value, bare)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, bare, depth + 1)
      return
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, BARE_JINJA_KEYS.has(key), depth + 1)
      }
    }
  }
  visit(task, false, 0)
  return expressions
}

/**
 * Jinja 式の中に「変数として」現れる識別子を集める。
 *
 * **散文まで拾ってはいけない。** タスク全体を字句解析していたときは、値へ到達し得ない
 * ただの文章が違反や `no_log` を引き起こした（実測）:
 *
 *   - `- name: Print the hostvars summary`              → 動的参照として拒否
 *   - `- name: Document how k3s_ephemeral_device is …`  → 内部変数の参照として拒否
 *   - `register: config` が汚染されたあとの
 *     `- name: Restart the service to pick up the new config` → 無関係なタスクに `no_log`
 *
 * 最後のものが特に悪い。`no_log` が付いたタスクはモジュールの出力も失敗理由も
 * 実行ログと `stepResults[].message` から消えるので、**サーバーセットアップの failure を
 * 追う手段そのものが失われる**。`register` 名は `config` / `result` のような普通の英単語に
 * なりがちで、汚染が文章へ雪だるま式に広がる。
 *
 * 名前が値へ到達する経路は Jinja だけなので、Jinja が式として評価する断片
 * （{@link collectJinjaExpressions}）に限って字句解析すれば、取りこぼさずに散文を外せる。
 * §6.3.1 が挙げた 3 つの穴（`{% %}` のステートメント・`debug` の `var`・素の `when` 式）は
 * どれも {@link BARE_JINJA_KEYS} と `{% %}` の取り込みで覆われている。
 */
function collectJinjaReferencedNames(
  task: Record<string, unknown>,
): ReadonlySet<string> {
  const names = new Set<string>()
  for (const expression of collectJinjaExpressions(task)) {
    for (const identifier of expression.match(IDENTIFIER_PATTERN) ?? []) {
      names.add(identifier)
    }
  }
  return names
}

/**
 * タスクが秘匿変数を参照しているか。
 *
 * 走査は {@link collectTemplateReferencedNames} と**同じ方式**（タスク全体の識別子）で行う。
 * かつてここは `{{ ... }}` の中だけを見る正規表現だった。内部変数の参照禁止側で
 * 「`{{ }}` の中だけでは足りない」と分かって直したのに、no_log 判定であるこちらを
 * 直さなかったため、次の 3 つが no_log なしで通っていた（実測）:
 *
 *   - `debug: { var: DB_PASSWORD }`          … `var` は変数名そのものを取る
 *   - `when: DB_PASSWORD is match('^x')`     … `when` は素の Jinja 式
 *   - `msg: "{% set x = DB_PASSWORD %}..."`  … Jinja ステートメント
 *
 * どれも接続パスワードやテナントの `ANSIBLE#` 秘匿変数を実行ログ・`stepResults[].message`
 * へ平文で出す（3 番目は値そのもの、2 番目は正規表現による 1 文字ずつの読み出し）。
 * 同じ穴を 2 箇所に持たないよう、判定は 1 つの関数に寄せる。
 */
function referencesSecretVar(
  task: Record<string, unknown>,
  secretVarNames: ReadonlySet<string>,
): boolean {
  if (secretVarNames.size === 0) return false
  for (const name of collectJinjaReferencedNames(task)) {
    if (secretVarNames.has(name)) return true
  }
  return false
}

/**
 * タスクのモジュールキー（制御キー除く）を抽出する。
 * `FORBIDDEN_TASK_KEYS` に該当するキーはモジュール候補から除外する（既に別途違反として記録されるため）。
 */
function getModuleCandidateKeys(task: Record<string, unknown>): string[] {
  return Object.keys(task).filter(
    (key) => !CONTROL_KEYS.has(key) && !FORBIDDEN_TASK_KEYS.has(key),
  )
}

/**
 * `include_role` タスクのモジュール引数を検証する。
 * - 引数はマッピングであること。
 * - `name` が {@link INCLUDE_ROLE_ALLOWED_ROLES} のいずれかであること。
 * - すべてのキーが {@link INCLUDE_ROLE_ALLOWED_PARAM_KEYS} に含まれること（`vars` はここに
 *   含まれない — {@link validateIncludeRoleTaskVars} 参照）。
 * - `tasks_from` はパラメータキーの allowlist（`name` のみ）で拒否される。
 */
function validateIncludeRole(
  taskIndex: number,
  moduleKey: string,
  moduleArgs: unknown,
  violations: AnsibleTaskViolation[],
): void {
  if (!isPlainObject(moduleArgs)) {
    violations.push({
      taskIndex,
      key: moduleKey,
      reason: 'include_role args must be a mapping',
    })
    return
  }

  const roleName = moduleArgs.name
  if (typeof roleName !== 'string' || !INCLUDE_ROLE_ALLOWED_ROLES.has(roleName)) {
    violations.push({
      taskIndex,
      key: 'name',
      reason: 'include_role name is not one of the allowed bundled roles',
    })
  }

  for (const paramKey of Object.keys(moduleArgs)) {
    if (!INCLUDE_ROLE_ALLOWED_PARAM_KEYS.has(paramKey)) {
      violations.push({
        taskIndex,
        key: paramKey,
        reason: 'include_role param key is not allowed',
      })
    }
  }

  // `tasks_from` の文字種検証はここには無い。かつては「パス区切りと `..` を含まなければ
  // 許可」だったが、それではロール内部のタスクファイルを直接呼べてしまい、`main.yml` の
  // 入力検証を迂回できた（理由は INCLUDE_ROLE_ALLOWED_PARAM_KEYS のコメント参照）。
  // 現在は `name` 以外のパラメータキーを上のループが一律で拒否するため、`tasks_from` は
  // そこで違反として記録される。文字種チェックを残しても二重報告になるだけで、
  // 「文字種さえ妥当なら通してよい」という誤った印象を与える。
}

/**
 * `include_role` タスクにロール変数を渡す唯一の正しい形は task レベルの `vars:`
 * （`include_role:` と同じインデントの兄弟キー）である —
 * `ansible.builtin.include_role` モジュールに `vars` というパラメータは存在せず、
 * モジュール引数内にネストすると実機の `ansible-playbook` が
 * `[ERROR]: Invalid options for ansible.builtin.include_role: vars` で拒否する
 * （検証済み。{@link INCLUDE_ROLE_ALLOWED_PARAM_KEYS} のコメント参照）。
 *
 * `validateAnsibleTasks` は include_role タスクに限り、task レベルの `vars` を
 * {@link FORBIDDEN_TASK_KEYS} の対象から除外して通過させる。この関数はその中身を、
 * 従来 `include_role.vars` に適用していたのと同じ予約語・マジック変数名チェック
 * （{@link isReservedVarName}）で検査する。中身を検査しないと
 * `vars: { ansible_connection: local }` 等の magic 変数注入で、固定 `become: true` の
 * play を agent ホスト自身へリダイレクトできてしまう（本ガードが塞ぐべき委譲/接続
 * すり替え攻撃の再発）。`vars` 値内の `lookup(...)` 参照は呼び出し側
 * （{@link validateAnsibleTasks} のタスク全体再帰 {@link containsLookupPluginReference}）
 * で別途拒否される。
 */
function validateIncludeRoleTaskVars(
  taskIndex: number,
  roleName: string | undefined,
  taskLevelVars: unknown,
  violations: AnsibleTaskViolation[],
): void {
  // `undefined`（vars を書いていない）だけが「vars 無し」。スカラーや配列を
  // 素通りさせると、ガードは ok を返したのに実機の ansible-playbook が
  // 「vars must be specified as a dictionary」で落ちる——保存時に弾く意味が消える。
  if (taskLevelVars === undefined || taskLevelVars === null) return
  if (!isPlainObject(taskLevelVars)) {
    violations.push({
      taskIndex,
      key: 'vars',
      reason: 'include_role task vars must be a mapping',
    })
    return
  }
  // roleName が未確定（role 名自体が不正）なら、validateIncludeRole 側で既に violation を
  // 積んでいる。allowlist 検査へ進むと同じタスクを二重に報告するので、予約語チェックだけ行う。
  //
  // roleName が有効なのに allowlist にエントリが無い場合は話が別で、「公開変数ゼロ」として
  // 全拒否する（fail-closed）。ロールを INCLUDE_ROLE_ALLOWED_ROLES に足して allowlist への
  // 追加を忘れると、fail-open ではそのロールだけ防御が外れたまま素通りする。
  const allowedVars =
    roleName === undefined
      ? undefined
      : (INCLUDE_ROLE_ALLOWED_VARS[roleName] ?? new Set<string>())
  for (const varName of Object.keys(taskLevelVars)) {
    if (isReservedVarName(varName)) {
      violations.push({
        taskIndex,
        key: varName,
        reason: 'reserved or magic variable name in include_role vars',
      })
      continue
    }
    // エントリが無い許可済みロールは「公開変数ゼロ」として全拒否する（fail-closed）。
    // ロールを INCLUDE_ROLE_ALLOWED_ROLES に足して allowlist への追加を忘れたとき、
    // fail-open だとそのロールだけ防御が外れたまま素通りし、テストが無ければ誰も
    // 気づけない。構造テストでも 1:1 を検証しているが、実装側でも倒れる向きを揃える。
    if (allowedVars === undefined) continue
    if (!allowedVars.has(varName)) {
      violations.push({
        taskIndex,
        key: varName,
        reason: `variable is not a public parameter of role '${roleName}'`,
      })
    }
  }
}

/** `shared_file` ロールで配布元を指定する変数名。 */
export const SHARED_FILE_SRC_VAR = 'shared_file_src'

/** `shared_file` ロールの名前。 */
const SHARED_FILE_ROLE = 'shared_file'

/**
 * `shared_file_src` に指定できる共有ファイルの相対パス。
 *
 * - Jinja テンプレート（`{{ }}` / `{% %}`）を含まないこと
 * - 相対パスであること（先頭 `/` を許さない）
 * - `..` セグメントを含まないこと
 *
 * テンプレートを拒む理由は権限ではなく**決定可能性**である。エージェントは playbook を
 * 走らせる前に body を静的に走査し、取り寄せる共有ファイルを決めてステージングする。
 * 値が実行時にしか定まらないと、何を取り寄せればよいか分からない。
 *
 * `..` と絶対パスを拒むのは、ロールが `src` をステージングディレクトリからの相対パスとして
 * 組み立てるためである。ここを抜けると、エージェント上の任意ファイル（自身のトークンや
 * SSH 秘密鍵）を対象サーバーへ配布できてしまう。`ansible.builtin.copy` の `src` を
 * 本体タスクで禁止しているのと同じ理由の防御であり、この検証がその代替になっている。
 */
export function isValidSharedFileSrc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (trimmed.includes('{{') || trimmed.includes('{%')) return false
  if (trimmed.startsWith('/')) return false
  // 先頭・中間・末尾のいずれの `..` セグメントも拒否する（`..foo` のような
  // 正当な名前は通す必要があるため、セグメント単位で厳密に比較する）。
  if (trimmed.split('/').some((segment) => segment === '..')) return false
  return true
}

/**
 * `shared_file` ロール呼び出し固有の検証。
 *
 * このロールだけは、エージェントが実行前にファイルを取り寄せる必要があるため、
 * `shared_file_src` が静的に決定できる安全な相対パスであることを保証する。
 */
function validateSharedFileRoleVars(
  taskIndex: number,
  roleName: unknown,
  taskLevelVars: unknown,
  violations: AnsibleTaskViolation[],
): void {
  if (roleName !== SHARED_FILE_ROLE) return

  const src = isPlainObject(taskLevelVars)
    ? taskLevelVars[SHARED_FILE_SRC_VAR]
    : undefined
  if (!isValidSharedFileSrc(src)) {
    violations.push({
      taskIndex,
      key: SHARED_FILE_SRC_VAR,
      reason:
        'shared_file_src must be a literal relative path without ".." (no Jinja templating)',
    })
  }
}

/**
 * サーバーセットアップレシピ本体（Ansible タスク列 YAML）を検証する。
 *
 * @param body テナントadminが入力したタスク YAML（トップレベルはタスクの配列）
 * @param opts.mode 実行経路（`ecs`=厳格 / `resident`=寛容）
 * @param opts.secretVarNames secretとして扱う変数名（no_log 付与判定用。api保存時は空でよい）
 */
export function validateAnsibleTasks(
  body: string,
  opts: ValidateAnsibleTasksOptions,
): AnsibleTaskValidationResult {
  const mode = opts.mode
  const secretVarNames = opts.secretVarNames ?? new Set<string>()
  const allowlist = moduleAllowlistFor(mode)

  let parsed: unknown
  try {
    parsed = load(body, { schema: DEFAULT_SCHEMA })
  } catch (error) {
    return {
      ok: false,
      violations: [
        {
          taskIndex: -1,
          key: 'root',
          reason: `YAML parse failed: ${toErrorMessage(error)}`,
        },
      ],
    }
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      violations: [
        {
          taskIndex: -1,
          key: 'root',
          reason: 'top-level must be a list of tasks, not a play',
        },
      ],
    }
  }

  if (parsed.length === 0) {
    return {
      ok: false,
      violations: [
        { taskIndex: -1, key: 'root', reason: 'tasks list must not be empty' },
      ],
    }
  }

  // play形式混入チェック（配列の要素が hosts/roles/vars_files を持つ場合は全体を拒否）。
  const hasPlayFormatElement = parsed.some(
    (item) =>
      isPlainObject(item) &&
      PLAY_FORMAT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(item, key)),
  )
  if (hasPlayFormatElement) {
    return {
      ok: false,
      violations: [
        {
          taskIndex: -1,
          key: 'root',
          reason: 'top-level must be a list of tasks, not a play',
        },
      ],
    }
  }

  const violations: AnsibleTaskViolation[] = []

  parsed.forEach((rawTask, taskIndex) => {
    if (!isPlainObject(rawTask)) {
      violations.push({
        taskIndex,
        key: 'root',
        reason: 'each task must be a mapping',
      })
      return
    }
    const task = rawTask

    // include_role タスクか否かを先に判定する。task レベルの `vars` は
    // FORBIDDEN_TASK_KEYS の対象だが、include_role タスクに限り、ロール変数を渡す
    // 唯一の正しい形（validateIncludeRoleTaskVars 参照）として例外的に許可する。
    const isIncludeRoleTask = Object.keys(task).some((key) =>
      INCLUDE_ROLE_MODULE_KEYS.has(normalizeModuleKey(key, mode)),
    )

    // 1. 危険なタスクキーの拒否（両モード）
    for (const key of Object.keys(task)) {
      if (key === 'vars' && isIncludeRoleTask) continue
      if (FORBIDDEN_TASK_KEYS.has(key)) {
        violations.push({ taskIndex, key, reason: 'forbidden task key' })
      }
    }

    // 2. モジュールキーの照合
    const moduleCandidateKeys = getModuleCandidateKeys(task)
    if (moduleCandidateKeys.length === 0) {
      violations.push({
        taskIndex,
        key: 'root',
        reason: 'no recognized module key',
      })
    } else {
      for (const key of moduleCandidateKeys) {
        const normalized = normalizeModuleKey(key, mode)

        // include_role は専用バリデータで検査する（allowlist ロール限定 + param キー allowlist）。
        // ロール変数（task レベルの vars）は validateIncludeRoleTaskVars で別途検査する。
        if (INCLUDE_ROLE_MODULE_KEYS.has(normalized)) {
          validateIncludeRole(taskIndex, key, task[key], violations)
          // ロール名は vars の allowlist を引くために必要。allowlist に無いロール名は
          // validateIncludeRole が既に拒否しているので、ここでは undefined を渡して
          // vars 側の重複報告を避ける。
          const includeRoleName = isPlainObject(task[key])
            ? (task[key] as Record<string, unknown>).name
            : undefined
          validateIncludeRoleTaskVars(
            taskIndex,
            typeof includeRoleName === 'string' && INCLUDE_ROLE_ALLOWED_ROLES.has(includeRoleName)
              ? includeRoleName
              : undefined,
            task.vars,
            violations,
          )
          validateSharedFileRoleVars(
            taskIndex,
            isPlainObject(task[key])
              ? (task[key] as Record<string, unknown>).name
              : undefined,
            task.vars,
            violations,
          )
          continue
        }

        if (!allowlist.has(normalized)) {
          violations.push({ taskIndex, key, reason: 'module not in allowlist' })
          continue
        }

        // copy は src（コントローラ側ローカルファイルパス）を拒否し content + dest に限定する。
        if (normalized === COPY_MODULE_KEY) {
          const moduleArgs = task[key]
          if (isPlainObject(moduleArgs) && 'src' in moduleArgs) {
            violations.push({
              taskIndex,
              key: 'src',
              reason: 'copy module must use content, not a controller-local src path',
            })
          }
        }
      }
    }

    // 3. lookup/query プラグイン参照の拒否（タスク全体を再帰的に走査）
    if (containsLookupPluginReference(task)) {
      violations.push({
        taskIndex,
        key: 'root',
        reason: 'lookup/query plugin reference is forbidden',
      })
    }

    // 4. set_fact / register の予約語・マジック変数名チェックと、
    //    bundled role の名前空間への書き込み禁止
    for (const key of moduleCandidateKeys) {
      if (!SET_FACT_MODULE_KEYS.has(key)) continue
      const factValue = task[key]
      // free-form 文字列形式（`set_fact: foo=bar`）はマッピングではないので、
      // 下のキー検査が一度も走らない。素通りさせると予約名も role 名前空間も
      // そのまま書けてしまうため、形式ごと拒否する。
      if (!isPlainObject(factValue)) {
        violations.push({
          taskIndex,
          key,
          reason: 'set_fact args must be a mapping (free-form form is not allowed)',
        })
        continue
      }
      {
        for (const factName of Object.keys(factValue)) {
          // set_fact は**キー自体**を実行時にテンプレート展開する
          // （ansible の set_fact アクションが `k = self._templar.template(k)` を行う）。
          // つまり `"{{ 'ansible_' ~ 'connection' }}"` のように組み立てたキーは、
          // 静的な文字列としては予約名にも role 接頭辞にも一致しないのに、
          // 実行時には一致する名前になる。実測でこの 2 経路と free-form 形式が
          // 素通りすることを確認済み。静的に読めない名前は最初から書けなくする。
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(factName)) {
            violations.push({
              taskIndex,
              key: factName,
              reason: 'set_fact variable name must be a static identifier',
            })
            continue
          }
          if (isReservedVarName(factName)) {
            violations.push({
              taskIndex,
              key: factName,
              reason: 'reserved or magic variable name',
            })
          } else if (
            isBundledRoleNamespacedName(factName) ||
            BUNDLED_ROLE_INTERNAL_VARS.has(factName)
          ) {
            // 接頭辞だけでは足りない: `database` ロールは内部計算に `db_*` を使う
            // （`db_mysql_root_password_result` など）。実名リストと OR で見る。
            violations.push({
              taskIndex,
              key: factName,
              reason: 'set_fact must not write into a bundled role namespace',
            })
          }
        }
      }
    }
    // 4.5. 同梱ロールの内部変数を「読む」ことも禁止する（タスク全体を走査）。
    //
    // `public` を禁止しても塞がらない。`register` / `set_fact` の値はロールスコープ
    // ではなくホストの変数で、include のあとのタスクから普通に読める（実測済み）。
    // 秘匿値を register しているロール（`github_runner` の runner 登録トークン等）が
    // あるので、読めるままだとレシピが自分のタスクでそれを出力でき、`no_log` は
    // 付かない（`referencesSecretVar` はテナントの秘匿変数名しか知らない）。
    for (const name of collectJinjaReferencedNames(task)) {
      if (BUNDLED_ROLE_INTERNAL_VARS.has(name)) {
        violations.push({
          taskIndex,
          key: name,
          reason: "must not reference a bundled role's internal variable",
        })
      }
    }

    // 4.6. 変数名を実行時に組み立てる参照を禁止する。
    //
    // 4.5 の照合は静的な識別子で行うため、名前を分割して連結されると素通りする:
    //
    //   {{ vars['github_runner_' ~ 'regtoken_resp'].json.token }}
    //   {{ hostvars[inventory_hostname]['github_' ~ 'runner_regtoken_resp'] }}
    //   debug: { var: hostvars[inventory_hostname] }   ← ホスト変数を丸ごと出す
    //
    // いずれも実測で素通りすることを確認した。`set_fact` のキー側は既に
    // 「静的な識別子であること」を要求しているのに、参照側だけ動的な組み立てを
    // 許していたのは非対称である。レシピが `vars` / `hostvars` を辿る正当な用途は
    // 無いので、入口ごと閉じる。
    //
    // `vars` は添字アクセスに限らない。`{{ vars }}` をそのまま出せばホスト変数が
    // 丸ごと出るし、`{{ vars | dict2items }}` や `{{ vars.get('github_runner_' ~
    // 'regtoken_resp') }}` も同じ場所へ届く（いずれも実機で内部 register の値が
    // 出ることを確認した）。添字だけを見ていたのは穴だったので、識別子として拒否する。
    //
    // ただし `vars` は英単語でもあり、タスク全体を字句解析して拒否すると
    // `- name: Set some vars` まで巻き添えになる。**Jinja が式として評価する断片に
    // 限って**判定する（`collectJinjaExpressions` 参照）。`hostvars` と `getattr(` は
    // 英文に現れないので、従来どおりタスク全体で見る。
    {
      const jinjaExpressions = collectJinjaExpressions(task)
      if (
        jinjaExpressions.some(
          (expression) =>
            /\bvars\b/.test(expression) ||
            /\bhostvars\b/.test(expression) ||
            /\bgetattr\s*\(/.test(expression),
        )
      ) {
        violations.push({
          taskIndex,
          key: 'root',
          reason:
            'dynamic variable lookup (vars / hostvars / getattr) is forbidden',
        })
      }
    }

    const registerValue = task.register
    if (typeof registerValue === 'string' && isReservedVarName(registerValue)) {
      violations.push({
        taskIndex,
        key: 'register',
        reason: 'reserved or magic variable name',
      })
    } else if (
      typeof registerValue === 'string' &&
      (isBundledRoleNamespacedName(registerValue) ||
        BUNDLED_ROLE_INTERNAL_VARS.has(registerValue))
    ) {
      violations.push({
        taskIndex,
        key: 'register',
        reason: 'register must not write into a bundled role namespace',
      })
    }
  })

  if (violations.length > 0) {
    return { ok: false, violations }
  }

  // 5. 正規化（secret参照タスクへの no_log 付与）
  // ALWAYS_SECRET_VAR_NAMES は secretVarNames（テナントのANSIBLE#変数、api保存
  // 時は空集合になり得る）とは独立に常時マージする — 接続用認証情報の変数名は
  // テナント設定に関わらず常に secret 扱いする。
  const noLogVarNames = new Set([...secretVarNames, ...ALWAYS_SECRET_VAR_NAMES])
  // 秘匿性は代入をまたいで伝播させる。
  //
  // `referencesSecretVar` は変数名の直接参照しか見ないので、名前を一度付け替えると
  // それ以降は素通りする。実際に次の 2 タスクは、1 つ目にだけ no_log が付き、
  // 2 つ目が秘匿値をそのまま実行ログへ出していた:
  //
  //   - set_fact: { copied: "{{ ansible_ssh_pass }}" }   ← no_log が付く
  //   - debug:    { msg: "{{ copied }}" }                ← 付かない。平文で出る
  //
  // register も同じで、秘匿値を参照したコマンドの結果には秘匿値が入る。よって
  // タスクを順に見て、秘匿名を参照したタスクが定義した名前（set_fact のキー・
  // register 名）を秘匿集合へ足していく。以降の参照は同じ扱いになる。
  const taintedVarNames = new Set(noLogVarNames)
  const normalizedTasks = parsed.map((rawTask) => {
    const task = { ...(rawTask as Record<string, unknown>) }
    if (referencesSecretVar(task, taintedVarNames)) {
      if (task.no_log !== true) {
        task.no_log = true
      }
      for (const key of Object.keys(task)) {
        if (!SET_FACT_MODULE_KEYS.has(key)) continue
        const factValue = task[key]
        if (!isPlainObject(factValue)) continue
        for (const factName of Object.keys(factValue)) {
          if (factName === 'cacheable') continue
          taintedVarNames.add(factName)
        }
      }
      const registerName = task.register
      if (typeof registerName === 'string' && registerName !== '') {
        taintedVarNames.add(registerName)
      }
    }
    return task
  })

  return { ok: true, violations: [], normalizedTasks }
}
