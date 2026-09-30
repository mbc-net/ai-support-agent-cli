# サーバセットアップ ロール開発ガイド

Zabbix Server／管理画面の対応構成、設定、復旧、専用DBテストは
[Zabbixセットアップガイド](ZABBIX.md)を参照してください。

`ansible/roles/*`にある同梱ロールを、APIを立てずにローカルで開発・検証するための手引きです。

各ロールは本番では `src/server-setup/server-setup-runner.ts` の
`generatePlaybook()` が動的生成する play（`hosts: all` / `become: true` /
`gather_facts: false` ＋ precheck）から、テナント管理者のレシピ body 経由で
`include_role` されて実行されます。本リポジトリの `ansible/playbook.yml` は
**実行時には使われない参考ファイル**です（そのファイル冒頭の警告を参照）。

---

## 0. 前提: Python venv とコレクション

本番 Docker イメージ（`docker/Dockerfile`）と**同じバージョン**で揃えます。

```bash
python -m venv .venv
. .venv/bin/activate

# ansible-core は Dockerfile の pip 制約に一致させる（現在 >=2.16,<2.18）
pip install 'ansible-core>=2.16,<2.18' ansible-lint yamllint

# Galaxy コレクションは版まで requirements.yml に固定済み
#（ansible.mysql / community.postgresql / ansible.posix — Dockerfile と一致）
ansible-galaxy collection install -r ansible/requirements.yml
```

> バージョンを上げるときは **`docker/Dockerfile` と `ansible/requirements.yml`
> の両方**を同時に更新すること（片方だけ変えると「ローカルは緑／本番は別版」
> の乖離が生まれる）。

---

## 1. 静的検査（ネットワーク不要・高速）

CI（`.github/workflows/ansible-roles.yml`）と同じチェックを手元で回せます。
リポジトリルート（`agent/`）から:

```bash
# YAML スタイル（.yamllint が権威）
npm run ansible:lint         # = yamllint + ansible-lint（下記2つを連結）

# 個別に実行する場合
yamllint  -c ansible/.yamllint     ansible/roles ansible/molecule
ansible-lint --offline -c ansible/.ansible-lint ansible/roles

# 生成 play の構文チェック
npm run ansible:syntax       # ansible-playbook --syntax-check（converge）
```

### lint 設定の方針（既存ロールは修正しない）

既存ロールのコードは変更せず、設定側で現実的なルールに調整しています。

- `.yamllint`: `line-length` は 200・**warning**（Jinja 長行/URL を許容）。
  `truthy` は `true`/`false` の小文字のみ許可。`comments` 系は warning。
- `.ansible-lint`: `profile: basic` から開始。以下は **warn_list**（可視・非致命）:
  - `name[casing]` … 各ロールは `"<role> : ..."` プレフィクス規約を採用しており、
    runner がこの名前をパースして結果をステップ単位に集約する。ansible-lint の
    大文字始まり要求とは意図的に相違する。
  - `partial-become[task]` … `nvm`/`claude_cli`/`codex`/`ai_support_agent`/
    `database` は個別タスクで `become_user:` のみ指定し、`become: true` は
    **本番の生成 play の play レベル**で供給される（`generatePlaybook()`）。
    ロール単体 lint では play 文脈が無いため誤検知になる。
  - `var-naming[no-role-prefix]` … `node_version`/`nvm_user` 等、ロール間で
    受け渡す既定変数はロール名プレフィクスを持たない設計。
  - `yaml` … YAML スタイルは `.yamllint` を権威とし二重失敗を避ける。
  - skip: `role-name`/`galaxy`/`meta-no-info`（ローカルロールで Galaxy 公開しない）、
    `no-changed-when`/`fqcn[canonical]`（`command`/`shell` は明示 `changed_when`
    ガードでコードレビュー担保）。

> 実測（scratch venv, ansible-lint 26.6 / ansible-core 2.17）: 上記設定で
> `ansible-lint` は **rc=0（0 failure / 214 warning）**、`yamllint` も
> **rc=0**（k3s の Kubernetes マニフェスト 1 件が document-start warning のみ）。

### 動的 include を静的に構文チェックする tip

`--syntax-check` は **動的** include（`include_role` / `include_tasks`）の
中身までは辿りません（converge の play ラッパーのみ検証）。あるロールの
tasks ツリー自体を構文チェックしたいときは、一時的に **静的**な
`import_role` / `import_tasks` に置き換えると `--syntax-check` が解決します
（k3s ロールの tasks 分割を手元で検証したときに使った手法）。検証後は
元の動的 include に戻すこと（実行時の挙動を変えないため）。

---

## 2. 動的検査（Molecule / Docker）

`ansible/molecule/*` の各シナリオが、**コンテナで安全に緑になるロールのみ**を
1 シナリオ 1 ロールで converge → idempotence → verify します。現状のシナリオ:

- `default` … `ssh_key` ロール
- `os_init` … `os_init` ロール（ユーザー作成・apt upgrade・ufw 設定。ufw の
  `changed_when` 冪等化後に idempotence 達成。下記「findings」参照）

CI（`.github/workflows/ansible-roles.yml`）の `molecule` ジョブは両シナリオを
matrix で回す（`molecule test -s default` と `molecule test -s os_init`）。

```bash
# ansible/ ディレクトリから、または npm script 経由で
npm run ansible:molecule     # = molecule test -s default（内部で cd ansible）

# 直接（シナリオを指定）:
cd ansible && molecule test -s default
cd ansible && molecule test -s os_init
```

- プラットフォーム: `geerlingguy/docker-ubuntu2404-ansible:latest`
  （systemd 有効・`privileged` ＋ `cgroupns_mode: host` ＋
  `/sys/fs/cgroup` マウント）。
- `default` シナリオの converge 対象は **`ssh_key` のみ**。`prepare.yml` が対象
  ユーザーを作成し、`converge.yml` が公開鍵を投入、`verify.yml` が
  `authorized_keys` に鍵が入ったかを assert。`ansible.posix` コレクション
  （requirements.yml で版固定）の疎通確認も兼ねる。
- `os_init` シナリオの converge 対象は **`os_init` のみ**。`prepare.yml` が
  `openssh-server`（ufw の `OpenSSH` プロファイル提供元）を導入し、`converge.yml`
  が `os_init_user: molecule_osuser` を渡して `os_init` を include、`verify.yml`
  が「setup ユーザー存在＋`/bin/bash`＋sudo 所属」「`ufw status verbose` が
  active・default deny (incoming)・allow (outgoing)・OpenSSH 許可」を assert。
- `idempotence` ステップで **2 回目の converge が無変更**であることを要求するため、
  冪等でないロールはシナリオに入れない。

> 実測（Docker ローカル実行, molecule 26.6 / ansible-core 2.17）:
> `molecule test -s default` / `molecule test -s os_init` はいずれも **rc=0** で
> 全通過。converge → idempotence（**changed=0**）→ verify（assert 成功）。

### findings: `os_init` の ufw 非冪等バグ（修正済み・CI 冪等検証対象）

当初 `os_init` は Molecule で **冪等でない**ことが判明していた（本土台が捕捉した
実バグ）。現在は修正済みで、`os_init` シナリオとして CI の idempotence 検証対象に
含まれている。

- **症状**: `os_init` の「Set ufw default incoming policy to deny」/「... outgoing
  ... allow」タスクは `changed_when: "'Default incoming policy changed' in
  stdout"` でガードしていたが、`ufw default deny incoming` は**既に deny でも
  毎回**「Default incoming policy changed to 'deny'」を出力する（コンテナで実測
  確認済み）。このためガードが常に true になり、2 回目の converge でこの 2 タスクが
  changed になって idempotence が失敗していた。
- **修正**: 冒頭の「Check ufw status」を `ufw status` → `ufw status verbose` に変更
  （register `os_init_ufw_status`・`changed_when: false` は維持）。active 時の
  `Default: deny (incoming), allow (outgoing), ...` 行を判定に使い、2 つの default
  policy タスクを `when: "'deny (incoming)' not in ...stdout"` /
  `when: "'allow (outgoing)' not in ...stdout"` ＋ `changed_when: true` に変更。
  既定状態（active かつ既に deny/allow）では skip され changed にならない。
  inactive なフレッシュホストでは verbose に Default 行が無いため両タスクが実行され
  設定される（`Enable ufw` の `when: "'inactive' in ...stdout"` も verbose の
  `Status: inactive` で従来どおり発火）。**OpenSSH 許可 → default-deny → enable の
  順序・ロールの機能は不変**。

### 新しいロール用シナリオの追加

コンテナで完結するロール（例 `database` / `web_server` / `dns_tls`）を
足す場合:

1. `ansible/molecule/<role>/` を作り、`molecule.yml`（default をコピーして
   platform を流用）・`converge.yml`（`include_role: {name: <role>}` ＋
   必要なテスト vars）・`verify.yml` を置く。
2. `molecule test -s <role>` で converge/idempotence/verify が緑になるまで調整。
3. 安定したら CI の `molecule` ジョブに（matrix 化などで）追加。

> `os_init` を前提にするロール（`nvm` 以降）は converge 冒頭で `os_init` も
> include するか、必要なユーザー/ディレクトリをテスト vars で用意すること。

---

## 3. CI 非対象ロールの実機検証（重要）

**「コンテナで緑」＝「実機で正しい」ではありません。** 以下はカーネル/
ブロックデバイス依存、または稼働中の登録シークレットが必要で、Molecule/CI の
自動対象**外**です。実 VM（Multipass / Vagrant + libvirt/VirtualBox）で
手動検証してください。

| ロール | コンテナ不可の理由 | 実機検証の要点 |
|--------|--------------------|----------------|
| `k3s` | `disk`（パーティション操作＝**破壊的**）・`gvisor`（containerd ランタイム）がカーネル/ブロックデバイス依存 | 使い捨て VM に**追加の空ディスク**を接続し、`by-id` 指定でパーティション/ラベル冪等・`/`・`/boot` ガードを確認。gVisor は `runsc` runtimeclass 適用を確認 |
| `docker` | docker-in-docker が必要 | クリーン VM で `docker run hello-world` まで確認 |
| `gitlab_runner` / `github_runner` | 稼働中の登録トークンで実際に enrol する | 使い捨てプロジェクト/リポの登録トークンを使い、登録→ジョブ受領を確認。トークンは `no_log` |
| `tailscale` | 実 auth key で tailnet 参加（routes/exit-node は管理コンソール承認要） | 一時 auth key（`0600` 一時ファイル + argv 非露出）で `tailscale up` を確認。routes/exit-node は rc=0 でも承認が要る点に注意 |

実 VM 例（Multipass, Ubuntu 24.04）:

```bash
multipass launch 24.04 --name role-test --disk 20G --memory 4G
multipass exec role-test -- sudo bash -c 'apt-get update && apt-get install -y python3'
# ローカルの ansible からインベントリを組んで対象ロールを include_role する
# play を流す（本番同等の play 形状は次節の local-run が最も手軽）
```

---

## 4. 本番パリティのローカル実行（`server-setup:local-run`）

レシピ body を **本番と同一の play・同一のガード**でローカル VM に対して
実行できる dev 専用コマンドです（API 不要・顧客向け commander には未接続）。
ロールを「本番と同じ経路」で実機検証したいときはこれが最短です。

```bash
npm run server-setup:local-run -- \
  --body ./recipe.yml \
  --host 192.168.64.10 --user ubuntu --key ./id_rsa
```

主なフラグ（**実装を正**とすること: `src/server-setup/server-setup-local-run.ts`
の `ServerSetupLocalRunOptions` / `parseLocalRunArgs`。CLI ヘッダは
`src/server-setup/server-setup-local-run.cli.ts`）:

| フラグ | 意味 |
|--------|------|
| `--body <path>` | レシピ body（トップレベルが Ansible タスクの YAML リスト）。**必須** |
| `--host <host>` | 対象 SSH ホスト/IP。**必須** |
| `--user <user>` | 対象 SSH ユーザー。**必須** |
| `--port <n>` | SSH ポート（既定 22） |
| `--auth-type <privateKey\|password>` | 認証方式（既定 `privateKey`） |
| `--key <path>` | 秘密鍵ファイル（key 認証）またはパスワード（password 認証）のパス。**ファイルパスのみ**（秘密値を argv に載せるインライン指定手段は意図的に設けていない） |
| `--extra-vars <path>` | `ANSIBLE#` プロジェクト変数の JSON ファイル（`Record<string,string>`） |
| `--secret-names <A,B>` | extra-vars のうち秘匿扱いにする名前（`no_log` ＋出力マスキング） |
| `--ssh-host-id <id>` | known_hosts 名前空間の host id（既定 `local-host`） |
| `--strict` | 厳格な `ecs` allowlist で検証（既定は寛容な `resident`） |

終了コードは成功で 0 / 失敗で 1。詳細・最新のフラグは必ず上記の実装ファイルを
参照すること（この表は憶測で増やさない）。

---

## 5. 設計ドキュメント

ロール/レシピの設計は admin-docs の
`development/server-setup-role-development`（サーバセットアップ ロール開発）を
参照してください。ロールを追加・変更したら、実装の実態に合わせて同ドキュメントを
更新すること。


## HAProxy ロール

`haproxy` は Ubuntu 22.04 / 24.04 / 26.04 LTS の配布パッケージを使用する。
`state: present` 相当で未導入時だけインストールし、導入済みパッケージは更新しない。
Ansible の組み込み `command` から、同梱の `roles/haproxy/files/haproxy_setup.py` を
対象ホストで実行する。Python 標準ライブラリだけを使用し、入力は JSON の標準入力で渡す。
補助スクリプトは対象ホストへ常設しない。

```yaml
- name: HAProxy
  ansible.builtin.include_role:
    name: haproxy
  vars:
    haproxy_mode: http
    haproxy_bind_address: 127.0.0.1
    haproxy_bind_port: 8080
    haproxy_backends:
      - name: app1
        address: 127.0.0.1
        port: 9001
      - name: app2
        address: app2.example.com
        port: 9001
```

| 変数 | 型・既定値 | 制約 |
| --- | --- | --- |
| `haproxy_mode` | string、`http` | `http` または `tcp` |
| `haproxy_bind_address` | string、`127.0.0.1` | IPv4。外部公開には明示指定が必要 |
| `haproxy_bind_port` | integer、`8080` | 1〜65535。文字列・booleanは拒否 |
| `haproxy_backends` | list、`[]` | 必須、1〜256件。各要素は `name`・`address`・`port` のみ |

転送先名は英字で開始する63文字以下の英数字・ハイフン・アンダースコアで、重複不可。
転送先アドレスはIPv4またはDNS名。`ipv4@` 接頭辞でIPv4接続を強制するため、
AAAAのみの名前は設定検証で失敗する。DNSは起動・reload時に解決し、継続的なDNS更新は行わない。
転送先ポートも整数の1〜65535。改行や任意のHAProxyオプションの混入を拒否する。
負荷分散はround-robin、死活監視はTCP接続確認（2秒間隔、3回失敗で除外、2回成功で復帰）。
HTTP応答の正常性は判定しない。TLS終端、証明書管理、統計画面、IPv6は対象外。
UFWの開放や他サービスの停止は行わない。

### 設定反映・復旧

`/etc/haproxy/haproxy.cfg` **全体を管理する**。シンボリックリンクの設定ファイル、
masked等の通常のenabled/disabled以外のサービス状態は、変更前に拒否する。
入力を検証してから `/var/lib/ai-support-agent/haproxy.lock` を原子的に作成する。
ロックには実行ID・PID・取得時刻、変更開始後にはバックアップのパスを記録する。
ロックを取得できない実行はホストを変更しない。

ロック取得後にパッケージ・設定ファイルの有無、稼働状態、自動起動状態を記録する。
未導入の場合、`policy-rc.d` でインストール時の自動起動を抑止し、元のpolicyを復元する。
候補設定を `haproxy -c -f` で検証してから、root所有・0600で原子的に配置する。
停止中なら起動、稼働中なら設定変更時だけreloadし、成功後に自動起動を有効化する。

終了コード・稼働状態に加え、指定IPv4アドレス・ポートのLISTENソケットが
HAProxyのsystemd MainPIDまたは子プロセスに属することを確認する。
別プロセスが同じポートで待受しているだけでは成功にしない。
reload前のワーカーPIDを記録し、新しいワーカーが指定ポートを保持するまで待つ。
旧ワーカーだけが残る場合は失敗として復旧する。HTTPアプリケーション応答の正常性までは保証しない。

失敗時、導入済み環境では元の設定内容・権限・所有者、稼働状態、自動起動状態への復旧を試みる。
初回導入ではサービスを停止・自動起動無効にし、パッケージと診断用設定を保持する。
元の失敗と復旧失敗を分けて報告する。パッケージ・依存関係は巻き戻さない。
稼働中だったサービスの再起動は、旧設定の内容・権限・所有者の復元と構文検証が成功した場合だけ行う。
設定復元に失敗した場合はサービス操作を行わず、復旧エラーが残る場合はロックを保持して手動復旧を要求する。
SSH切断やプロセス強制終了では自動復旧を保証しない。
外部コマンドは独立したプロセスグループで実行し、タイムアウト時はTERM・KILLで
グループ全体の停止を試みる。systemdジョブやグループ外へ移ったプロセスの終了は
断定できないため、タイムアウト時は自動復旧・ロック解除を行わず、状態を `interrupted` として保存する。
復旧処理自体がタイムアウトした場合も、後続の復旧処理を停止して同じ扱いにする。

### バックアップ保持と手動復旧

変更が必要な場合だけ `/var/backups/ai-support-agent/haproxy/<実行ID>/` に
`state.json`、既存設定の `haproxy.cfg`、候補設定の `candidate.cfg` を保存する。
ディレクトリは0700、ファイルは0600。正常完了した直近5世代を保持し、整理は正常完了後だけ行う。
`pending`・`interrupted`・`rolled_back`・`recovery_failed` は自動削除しない。解決後の整理は管理者が行う。
変更不要の再実行では設定変更・reload・バックアップ作成は発生しない。

中断時は次の手順で復旧する。

1. 対象ホストでロックの `owner.json` を確認し、PIDだけでなくコマンド・取得時刻を照合する。
   実行プロセスと子のapt処理、systemdの未完了ジョブ（`systemctl list-jobs`）が
   終了していることを確認する。稼働中の処理が残るロックは解除しない。
2. ロックの `transaction` が示すバックアップの `state.json` を読む。
   パスが未記録なら変更開始前であり、設定復元は不要。
3. `policy-state.json` がロック内に残っていればインストール中断・タイムアウトの可能性がある。
   タイムアウト時は自動起動抑止のpolicyを保持するため、apt/dpkg処理の終了確認後に復元する。
   `present: true` なら `policy-rc.d.original` を `/usr/sbin/policy-rc.d` に所有者・権限・
   シンボリックリンクを保持して復元する。falseならこの処理が置いたpolicyを取り除く。
   元のpolicyの所有者は `policy-state.json` の `uid`・`gid` に記録されるため、その値に戻す。
4. `installed: true` なら、`config_exists: true` の場合はバックアップの設定を
   `/etc/haproxy/haproxy.cfg` に復元し、`mode`・`uid`・`gid` をstateの値に戻す。
   falseなら今回配置した設定を取り除く。
5. 導入済み環境は `active: true` なら旧設定の構文を確認して `systemctl restart haproxy`、
   falseなら `systemctl stop haproxy` を実行する。
   `enabled` に従い `systemctl enable haproxy` または `systemctl disable haproxy` を実行する。
   初回導入失敗なら停止・自動起動無効とし、パッケージと診断用設定は残す。
6. 設定内容と `systemctl is-active/is-enabled haproxy` を確認して復旧結果を記録する。
   復旧が完了してからロックディレクトリを削除する。

Ansible check modeは入力検証のみ実行し、導入・設定反映は行わない。

### 検証

エージェントのJest `haproxy-role.spec.ts` がPythonのトランザクションテストを実行する。
入力拒否、復旧、保持世代数、同時実行、強制終了後の記録保持を検証する。
実通信の検証は **使い捨てのUbuntu/systemdホストでのみ** 次を実行する。
設定ファイルとサービス状態を変更するため、運用中のホストでは実行しない。

```bash
sudo python3 __tests__/server-setup/haproxy-live.py
```

HTTP/TCP転送、複数転送先の分散、停止した転送先の除外、reload、実ポート競合時の復旧、
再実行時の冪等性を検証する。初回導入の検証にはHAProxy未導入のホストを使用する。

Ansible経由の異常系は、HAProxyが稼働する使い捨てホストで
`__tests__/server-setup/haproxy-failure-play.yml` を実行して検証する。
存在しないローカルアドレスへの反映失敗を発生させ、元のエラーと復旧結果の表示、
設定内容の復元、サービスの稼働をアサートする。rootで接続するDocker検証環境では
`-e ansible_become=false` を指定する。
