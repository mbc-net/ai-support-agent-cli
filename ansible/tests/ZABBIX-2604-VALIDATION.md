# Ubuntu 26.04 Zabbix ロール検証

作業ブランチ: `feature/zabbix-rebuild-2604`。ベース: `6b24b48d64325b14a3571006a113b0cbefdc900f`。
本番デプロイ・コミットは未実施。最新の記録は 2026-11-11（表示言語 `zabbix_web_locales`）で、
その次が 2026-11-08（Zabbix 8.0 対応）。2026-11-03〜04 の Zabbix 7.0 の記録は末尾の「過去の記録」に残す。

## 2026-11-11: 表示言語（zabbix_web_locales）

作業ブランチ（worktree）: `agent-worktrees/zabbix-web-locales`（未コミットのロール変更をそのまま検証）。
本番・実サーバーには一切接続していない。すべて手元の Mac（Docker 29、arm64）のコンテナで実施した。

### 検証環境

本番（mbc-zabbix-01）の 2026-11-11 時点のロケール状態を再現した Ubuntu 26.04 / systemd コンテナ。

- イメージ `zabbix-locale-2604:local`: `ubuntu:26.04` に systemd・python3・`locales`・iproute2・curl と
  ansible-core 2.20.11（venv `/opt/ansible`）・community.postgresql 4.x を導入（後から ansible.mysql 5.x・ansible.posix 1.x も追加）。
  `/etc/locale.gen` は `en_US.UTF-8 UTF-8` だけを有効にして `locale-gen`、`/etc/default/locale` は `LANG=en_US.UTF-8`。
  `locale -a` は `C / C.utf8 / POSIX / en_US.utf8`（本番と同じ）。
- PostgreSQL 18 は `LANG=en_US.UTF-8` で導入し、全 DB の `datcollate`/`datctype` が `en_US.UTF-8`（本番と同じ）。
- ロールで Zabbix 8.0 を構築（`zabbix_server` → `zabbix_web`。nginx、`listen_address 127.0.0.1`、port 8080、
  `ufw_manage: false`、管理者パスワード指定）。この状態を `docker commit` してイメージ `zabbix-locale-2604:base` とし、
  シナリオごとに新しいコンテナを起動した。PHP-FPM のプールはロールの `pm = ondemand`（idle 10s）、マスターの環境に LANG/LC_* 無し（本番と同じ）。
- 実測版: libc6/locales 2.43-2ubuntu2.4、zabbix-server-pgsql/zabbix-frontend-php 2:8.0.0-1+ubuntu26.04、
  php8.5-fpm 8.5.4-0ubuntu1.5、nginx 1.28.3-2ubuntu1.12、postgresql-18 18.6-0ubuntu0.26.04.1、Python 3.14、ansible-core 2.20.11。
- 確認用に `/usr/share/zabbix/ui/loctest.php`（`setlocale(LC_MONETARY, 'ja_JP.UTF-8', 'ja_JP.utf8')` の結果とワーカーの PID を返す。
  Zabbix の言語判定と同じ呼び出し）を置き、nginx → PHP-FPM（ロールのプール）経由で叩いた。

実行コマンド（コンテナ内、`/work/ansible` に worktree の `ansible/` を読み取り専用でマウント）:

```sh
cd /work/ansible
ANSIBLE_ROLES_PATH=/work/ansible/roles /opt/ansible/bin/ansible-playbook -i localhost, web.yml -e '{"zl":["ja_JP.UTF-8"]}'
# web.yml: hosts localhost / connection local / become、include_role zabbix_web、
#          vars: zabbix_web_locales: "{{ zl | default([]) }}"
```

未設定時の確認（項目 9）の時点で、構築直後の frontend のユーザー設定には
`Japanese (ja_JP)` が `is_disabled: true` で並び、「You are not able to choose some of the languages, because locales
for them are not installed on the web server.」が表示されていた（本番の症状を再現）。

### 結果（計画のフェーズ3 の項目番号）

| 項目 | 結果 | 根拠 |
|---|---|---|
| 1. 生成・既存の保持・登録 | 合格 | 初回 `ok=53 changed=9 failed=0`。`Generate missing locales` が `changed (item=ja_JP.UTF-8)`。実行後 `locale -a` = `C C.utf8 POSIX en_US.utf8 ja_JP.utf8`、`/etc/locale.gen` の有効行 = `en_US.UTF-8 UTF-8` と `ja_JP.UTF-8 UTF-8`（`# ja_JP.UTF-8 UTF-8` のコメント行が `locale-gen` によって有効化された）、`/usr/lib/locale/locale-archive` あり（3,064,432 → 4,152,224 バイト）。`DEBIAN_FRONTEND=noninteractive dpkg-reconfigure locales` は rc=0 で `en_US.UTF-8` と `ja_JP.UTF-8` の両方を再生成し、`/etc/locale.gen` の sha256 は不変、`locale -a` も両方残った。`/etc/default/locale` は `LANG=en_US.UTF-8` のまま |
| 2. DB 接続 | 合格 | 生成後に PostgreSQL と Zabbix Server を再起動して新規接続にした。`zabbix_server.log` に `database connection re-established`、`dbversion 08000000` の確認、`pg_stat_activity` に zabbix の接続 30 本。`psql -h 127.0.0.1 -U zabbix` で `users` を読めた。全 DB の照合順序は `en_US.UTF-8` のまま。Web は Admin でログイン（302）しダッシュボードを表示 |
| 3. PHP-FPM 再起動の要否 | **再起動が必要**（条件は残す） | 手で `locale-gen ja_JP.UTF-8` を実行（再起動なし）。生成前から 2 秒間隔で叩き続けたワーカー（同じ PID）は生成後も 20 回連続で `false`。idle で終了した後に、再起動していないマスターから fork された新しいワーカーも `false`。同時刻の `php` CLI（新しいプロセス）は `ja_JP.UTF-8`。`systemctl restart php8.5-fpm` の後は `'ja_JP.UTF-8'`。マスターは起動時に locale-archive を mmap しており（`/proc/<pid>/maps`）、`locale-gen` は同じ inode のまま archive を伸長していた。ロール経由でも、生成前のワーカーは `false` のまま、ロールの再起動後のワーカーは `'ja_JP.UTF-8'` |
| 4. 言語一覧と日本語表示 | 合格 | ロール実行後、API `user.update` で Admin の `lang` を `ja_JP` に変更。ユーザー設定の一覧は `日本語 (ja_JP)`（`is_disabled` 無し）、警告文なし、ページタイトル `プロファイル`・`ダッシュボード`、`<html lang="ja">` |
| 5. 中断 → 再実行 | 合格 | `/usr/local/sbin/stat` に必ず失敗する代替を置き、`Read locale archive modification time` で失敗させた（`locale-gen` の後・再起動の前。`ok=23 changed=1 failed=1`）。この時点で ja_JP は生成済み・登録済み、PHP-FPM は未再起動で `loctest.php` は `false`。代替を消して再実行すると `Generate` は skip、`Apply changed PHP settings and clear cached frontend config` が changed（MainPID 62 → 2207）、`loctest.php` は `'ja_JP.UTF-8'`。3 回目は生成・再起動とも skip |
| 6. 存在しないロケール | 合格（2026-11-11 に現行ロールで再測定） | `xx_YY.UTF-8` は `Require supported locale names`（`grep -qxF "xx_YY.UTF-8 UTF-8" /usr/share/i18n/SUPPORTED`、rc=1 を許容して `ok`）の次の `Assert all locale names are supported` で失敗し、`msg` は `Locales not found in /usr/share/i18n/SUPPORTED: xx_YY.UTF-8`（`ok=9 changed=0 failed=1`。リポジトリ導入 `Install the official repository package` より前）。`zabbix-locale-2604:base` から起動した新しいコンテナで、実行前後の `/etc/locale.gen` の sha256・`locale -a`・archive の mtime/サイズ・`/etc/apt/sources.list.d`・`dpkg -l` の sha256・PHP-FPM の MainPID がすべて同一 |
| 7. 冪等性と表記ゆれ | 合格（注記あり） | 2 回目: `Generate` skip・再起動 skip・MainPID 不変（`changed=7` はロケール未指定の再実行と同じ既存タスク: 一時ファイル・nginx 反映・API 接続ファイル）。以下はいずれも 1 回で収束し、その次の実行で生成・再起動とも skip: (a) archive にあるが `/etc/locale.gen` に無い → `locale-gen` が rc=0 で末尾に `ja_JP.UTF-8 UTF-8` を追記、再起動 1 回。(b) archive にあり `# ja_JP.UTF-8 UTF-8` だけがある → `locale-gen` がその行を有効化、再起動 1 回。(c) 有効行が `  ja_JP.UTF-8<TAB>UTF-8  ` → 登録済みと判定され生成・再起動とも skip。(d) (c) の行のまま archive から削除（`localedef --delete-from-archive ja_JP.utf8`）→ 生成と再起動 1 回。このとき `locale-gen` は空白・タブ入りの行を自分のものと認識せず、`ja_JP.UTF-8 UTF-8` を**別の行として追記**した（有効行が 2 行になる。生成結果に害はない）。既存ロケールの再生成で `localedef` が非 0 になる事象は起きず、計画の代替案（登録だけ行う方式）は不要。`dpkg-reconfigure locales` で archive が更新された直後の実行は、生成なしで再起動だけ 1 回行い、その次は skip |
| 8. `no_log` 付き `include_role` | 合格（`fail_msg` は見える） | `include_role` に `no_log: true` を付けて `-vvv` で 4 通り実行: 成功（5,110 行）、Validate 失敗（`ja_JP.utf8`）、`SUPPORTED` 失敗（`xx_YY.UTF-8`）、`locales` 未導入（`dpkg --remove --force-depends locales` 後）。全ログ（このほかの全実行ログを含む）に DB パスワード・管理者パスワードの平文と base64 のいずれも 0 件。`no_log` は include の行（`included: zabbix_web ... (censored due to no_log)`）にしか効かず、ロール内のタスクには継承されない。そのため Validate の `fail_msg`（`zabbix_web_locales must be a list ...` を含む全文）と `Install the locales package beforehand ...` はそのまま表示された。`SUPPORTED` 失敗は 2026-11-11 に現行ロールで再測定し、`Locales not found in /usr/share/i18n/SUPPORTED: xx_YY.UTF-8` が表示された（361 行。DB パスワード・管理者パスワードの平文・base64 とも 0 件）。秘密値を扱うロール内タスクは自身の `no_log` で伏せられており、ロール内への `no_log` 追加作業は不要 |
| 9. ロケール未指定 | 合格（2026-11-11 に現行ロールで再測定） | `zabbix-locale-2604:base` から起動した新しいコンテナで `zabbix_web_locales` 未指定（既定 `[]`）の実行（`ok=41 changed=7 failed=0 skipped=34`）。追加した 12 タスクはすべて `skipping`: 前提確認 4（`Read the locales package status`・`Require locales to be installed beforehand`・`Require supported locale names`・`Assert all locale names are supported`）と生成ブロック 8（`Read locales before generation`・`Check active locale registrations`・`Generate missing locales with explicit arguments`・`Read locales after generation`・`Verify requested and existing locales are preserved`・`Verify persistent locale registrations`・`Read PHP-FPM start time`・`Read locale archive modification time`）。再起動タスク `Apply changed PHP settings and clear cached frontend config` も条件評価のエラーなく `skipping`（未登録の `zabbix_web_locale_fpm_started` を参照しない）。changed の 7 件はロケールと無関係の既存タスク（frontend のロールバック準備・設定退避・設定適用・退避の削除・API 接続ファイルの作成/書込/削除）。実行前後で `/etc/locale.gen` の sha256・`locale -a`・archive の mtime/サイズ/inode・`/etc/apt/sources.list.d`・`dpkg -l` の sha256・PHP-FPM の MainPID と起動時刻がすべて同一 |
| 10. `zabbix-validation.yml` の負例 | 合格（全 87 ケース、2026-11-11 に現行ロールで再測定） | 87 ケース（既存 78 ＋ ロケール 9。新規の文字列でない要素 `[1]` を含む）。Ubuntu 22.04 / ARM64（イメージ `zabbix-native-setup-test:2204`、ansible-core 2.17.14。collection は `zabbix-locale-2604:base` の community.postgresql 4.2.1・ansible.mysql 5.2.0・ansible.posix 1.6.2 を `/usr/share/ansible/collections` に読み取り専用でマウント）で全 87 ケース: `ok=436 changed=0 failed=0 skipped=6 rescued=87`。rescue 内の `Require rejection by the initial validation task`（`Validate branch and required variables` で、`expect` を含む assertion により落ちたことの確認）が 87 回とも `ok`。`[1]` は `reject('string')` を含む assertion（文字列でない要素が 0 件であること）で拒否。Ubuntu 26.04（ansible-core 2.20.11）ではロケール形式の 8 ケース（`[1]` を追加）だけを抜き出した写し（22.04 前提の OS 条件ケースと、26.04 では受理されて導入まで進む他ケースを除外）で `ok=41 changed=0 failed=0 rescued=8`。`[1]` も同じ assertion で拒否 |

計画のフェーズ3 項目 10（recipe 11 の事前確認）は今回の範囲外で未実施。

### 補足の観察

- `locales` パッケージを `dpkg --remove` すると `/usr/lib/locale/locale-archive` ごと消え、`locale -a` は
  `C C.utf8 POSIX` だけになった。ロールが `locales` を導入・削除しない判断と整合する（本番で `locales` を触らないこと）。
- 生成後の初回実行・中断後の再実行・archive 更新後の実行の 3 つで、PHP-FPM の再起動が 1 回ずつ起きる。
  いずれも `pm = ondemand` のため、再起動していないマスターから fork される新しいワーカーでも反映されないことを確認済み。

### ロールの不具合

検出なし。軽微な改善候補だった `SUPPORTED` 失敗時の表示（`non-zero return code` だけで理由が出ない）は対応済み:
`grep` は rc 0/1 を許容して register し、続く `Assert all locale names are supported` が
`Locales not found in /usr/share/i18n/SUPPORTED: ...` で失敗する（項目 6・8 で再測定）。

### 生ログ（ローカル一時証跡）

`/private/tmp/claude-501/-Users-koichi-murakami-code-ai-support-agent-ai-support-agent/1fedf829-0b01-4e54-8dc8-308f10c665d2/scratchpad/locale-phase3/logs/`
（`01-server.log`〜`61-validation-2604-locales.log`、再測定の `70-web-xx-rerun.log`・`72-nolog-xx-vvv-rerun.log`・`70-before.txt`/`70-after.txt`/`72-after.txt`・
`80-web-nolocale-current.log`・`80-before.txt`/`80-after.txt`・`81-validation-2204-87.log`・`82-validation-2604-locales8.log`、`03-poll.log`・`10-poll-a.log` はワーカーの PID と `setlocale` 結果の時系列）。

## 2026-11-08: Zabbix 8.0 対応と KAGOYA amd64 実機検証

### 変更と条件

- Server/Web: Ubuntu 26.04 で `7.0` と `8.0` を受け付ける。22.04/24.04 は従来どおり 6.0/7.0 のみで、
  8.0 は初期assertで拒否する（8.0 は PHP 8.2 以上・PostgreSQL 15 以上が必要で、22.04/24.04 では未検証のため）。
  26.04 で 6.0 を拒否すること、TimescaleDB を拒否すること（7.0/8.0 共通）は従来どおり。
- `zabbix_agent` は変更なし（26.04 では 7.0 のみ）。
- 版ごとの派生値を `roles/zabbix_server/vars/main.yml`（新規）と `roles/zabbix_web/vars/main.yml` に定義した。

  | 変数（`zabbix_server_*` / `zabbix_web_*`） | 6.0 / 7.0 | 8.0 |
  |---|---|---|
  | `*_pkg_epoch` | `1` | `2` |
  | `*_min_patch`（26.04 のみ使用） | 7.0: `7.0.32` | `8.0.0` |
  | `*_repo_uri` | `https://repo.zabbix.com/zabbix/<LTS>/ubuntu`（aarch64 は `ubuntu-arm64`） | `https://repo.zabbix.com/zabbix/8.0/stable/ubuntu`（aarch64 も同じ） |
  | `*_release_deb` | `<repo_uri>/pool/main/z/zabbix-release/zabbix-release_latest_<LTS>+ubuntu<OS>_all.deb` | `https://repo.zabbix.com/zabbix/8.0/release/ubuntu/pool/main/z/zabbix-release/zabbix-release_latest_8.0+ubuntu<OS>_all.deb` |
  | `zabbix_web_ui_root`（web のみ） | `/usr/share/zabbix` | `/usr/share/zabbix/ui` |

  UI は 7.2 以降のパッケージで `ui/` へ移動し、旧パスには「Manual intervention is required」を返すスタブだけが残る。
- 8.0 の release パッケージが置く `/etc/apt/sources.list.d/zabbix-unstable.sources` に
  `Enabled: no` の行があることを `grep -qx` で確認する（書き換えない。rc 0=無効、rc 2=ファイル無しは通過、それ以外は失敗）。
- 既存パッケージの LTS 照合の正規表現を `^([0-9]+:)?<LTS>\.` に変更（epoch 非依存）。
  26.04 での導入後検証は `^<epoch>:<LTS>\.[0-9]+-` で epoch まで確認する。
- `files/database.py`:
  - SQLスクリプトのルートを版別にした（6.0/7.0 は `/usr/share/zabbix-sql-scripts`、8.0 は `/usr/share/zabbix/sql-scripts`）。
  - `dbversion` の判定範囲を `[下限, 下限+10000)` にした（XXYYZZZZ 採番）。従来の `+100000` は
    7.0 指定で 7.2/7.4 の DB を受け入れていた既存不具合。
  - 初期データの確認対象を 8.0 では `users`+`settings` にした（7.4 で `config` がキー・値形式の `settings` に置換）。
  - `db_extension` の取得を 8.0 では `SELECT value_str FROM settings WHERE name='db_extension'` にした。
- `files/zabbix_api.py`: 8.0 を許可。認証（Bearer）と `current_passwd` は 7.0 と同じ経路（API 版 6.2 以上で付与）。
- 新変数 `zabbix_web_listen_address`（既定 `""` = 全 interface）。空か `127.0.0.1` のみ許可
  （確認処理と API ヘルパーが 127.0.0.1 へ接続するため）、Nginx のみ、指定時は `zabbix_web_allowed_sources` が空であることを要求する。
  Nginx テンプレートの `listen` に反映。
- Nginx の reload では同一ポートの wildcard 待受と特定アドレスを入れ替えられない
  （`bind() to 127.0.0.1:8080 failed (98: Address already in use)` で reload が失敗し、旧設定のまま動き続ける。
  2026-11-08 に KAGOYA の実機で再現）。Nginx では反映前に `ss` で実待受を読み、そのポートに待受があるのに設定した
  ローカルアドレス（空なら `0.0.0.0:<port>`）の待受が無いときだけ restart する。設定どおりの待受がある・未待受なら
  reload（他サイトを止めない。同ポートの別の待受だけでは restart しない）。失敗時の復元は vhost 変更時は restart。
  Web ロールは `ss` 用に `iproute2` を導入する。
  `zabbix_web_listen_address` 指定時は、ログイン確認の後に `ss -H -lnt sport = :<port>` で
  待受がちょうど1件・指定アドレスであることを assert する（rescue 対象のブロック内）。
- zabbix_agent: 同じホストに別系列の Server/Web パッケージ（例: 8.0 Server と 7.0 Agent）があるときは、共有の
  `zabbix.sources` を書き換える前に停止する（`zabbix_agent_manage_packages: true` の場合のみ。PSK 再設定の
  `manage_packages: false` は対象外）。`dpkg-query -f='${db:Status-Abbrev} ${Version}'` で状態も読み、未導入（`un`）と
  設定ファイルのみ（`rc`）は除外、hold 中（`hi`）は導入済みとして扱う（実機の 8.0 パッケージは hold により `hi` と表示された）。
  26.04 の Agent は 7.0 のみなので、8.0 Server と同居する Agent の新規導入は現状できない。
- Nginx/Apache テンプレートの拒否ディレクトリに `api/` を追加（8.0 公式 nginx 設定に合わせた。`api_jsonrpc.php` は対象外）。
- ガード（`src/server-setup/ansible-task-guard.ts`）: `zabbix_web_listen_address` を include_role の公開変数に、
  `*_min_patch`・`*_pkg_epoch`・`*_release_deb`・`*_repo_uri`・`*_unstable_source`・`zabbix_agent_shared_packages`・`zabbix_web_listener`・`zabbix_web_listener_before`・`zabbix_web_listener_differs`・`zabbix_web_ui_root` を予約内部変数に追加。

### 実機検証（KAGOYA amd64）

ansible-core 2.20.11 の controller から、隔離基盤レシピの本文を直接実行した（Agent の自動構築経路は経由していない）。

| 回 | 結果 | 対応 |
|---|---|---|
| 1〜3 回目 | 失敗 | SQLスクリプトのパス、`settings` テーブル、UI のパスの順に判明し、それぞれ修正 |
| 4 回目 | `failed=0`（`ok=102 changed=26`） | — |
| 再適用 | `failed=0`（`ok=102 changed=18`） | changed は一時ファイル、`changed_when` の無い command、reload によるもののみ |
| 最終コードでの再適用（一致状態） | `failed=0`（`ok=103 changed=19`） | 実待受が一致しているため nginx は reload（restart 0 回）を journal で確認 |
| 最終コードでの再適用（途中状態） | `failed=0`（`ok=103 changed=18`） | 旧レシピの途中状態から実行し、restart で `127.0.0.1:8080` のみになることを確認 |

上の 4 回目と再適用の数値は、レビュー対応前のロールでの実行結果。最終コード（`/code-review` 対応後）での実行は「最終コードでの再適用」の 2 回。

| ソフトウェア | 実測版 |
|---|---|
| zabbix-server-pgsql / zabbix-frontend-php / zabbix-sql-scripts / zabbix-nginx-conf | `2:8.0.0-1+ubuntu26.04` |
| PostgreSQL | 18.6-0ubuntu0.26.04.1 |
| PHP-FPM | 8.5.4-0ubuntu1.5 |
| nginx | 1.28.3-2ubuntu1.12 |
| Python（対象ホスト） | 3.14.3 |
| ansible-core（controller） | 2.20.11 |

確認した内容:

- Web は `127.0.0.1:8080` のみ、DB は `127.0.0.1:5432` のみで待ち受ける。
- `apiinfo.version` は `8.0.0`。
- Admin の初期パスワードでのログインは拒否され、新しいパスワードでログインできる。
- housekeeping の設定値が 30d/365d/365d になっている。
- `/api/`・`/conf/` は 403。
- 外部から到達できるのは 22 番のみ。
- Zabbix の3パッケージが hold されている（hold はロールではなくレシピ側の処理。ロールには hold のタスクは無い）。
- UI パス誤りで失敗した回に、Web の rescue 経路が実機で動き、設定ファイルが導入前の状態（未作成）に戻った。
  ただし Docker fixture を要する既存の rollback 試験（`test_zabbix_web_rollback` の3件）は実施していない。
- 旧レシピの途中状態（設定ファイルは `listen 127.0.0.1:8080;`、Nginx は `0.0.0.0:8080` のまま）を実機で作って再適用し、
  vhost は無変更（ok）のまま実待受の不一致で restart され、`127.0.0.1:8080` だけになることを確認した（`failed=0`）。

### 自動検証

| 検証 | 結果 |
|---|---|
| `ansible/tests` の `test_zabbix_*.py` | 88 件実行・失敗 0・skip 24（DB/TimescaleDB/rollback の Docker 前提試験。今回未実行。2.16 controller 指定時の件数） |
| `npx jest __tests__/server-setup` | 34 suites / 2,148 tests 合格 |
| `npm run build` | 合格 |

### 未検証・未対応

- 8.0 + TimescaleDB: 26.04 ではロールが TimescaleDB を拒否するため、未検証ではなく未対応
  （`database.py` の TimescaleDB スクリプト表にも 8.0 の項目は無い）。
- 8.0 + Apache、8.0 + MySQL（いずれも初期assertでは受け付ける）。
- 22.04/24.04 での 8.0（拒否する）。
- arm64 実機での 8.0（URI はテンプレート評価のみ確認）。
- Agent 6.0/7.0 → Server 8.0 の接続。
- Docker 前提の DB/TimescaleDB/rollback 試験（上記 skip 24 件）。

## 過去の記録（2026-11-03〜04、Zabbix 7.0）

この節の時点では 26.04 は Zabbix 7.0 専用だった。8.0 の許可は上の 2026-11-08 の記録を参照。


実施日: 2026-11-03。作業ブランチ: `feature/zabbix-rebuild-2604`。
ベース: `6b24b48d64325b14a3571006a113b0cbefdc900f`。
本番デプロイ・コミットは未実施。

### 変更と条件

- Server/Web: Ubuntu 26.04 (`resolute`)・PHP 8.5 の分岐。
- 26.04 は Zabbix 7.0 専用、TimescaleDB 自動導入は初期検証で拒否。
- Server/Web は 26.04 上の既存パッケージと導入直後のパッケージを検査し、
  7.0.32 未満を拒否。導入直後は必要な2パッケージの存在と7.0系列も確認する。
- Server/Web/Agent: 26.04 では ansible-core 2.20 以上を要求する。
  同梱Dockerの2.16〜2.17制約は更新していない。fact収集はロールより前なので、
  controller選択は呼び出し側で実行開始前に行う必要がある。
- 完全なパッチ版固定、AI監視登録、Webhook、DNS/VPN/本番構築は今回のロール差分に含まない。

### 自動検証

| 検証 | 結果 |
|---|---|
| 新規platformテストを元のロールへ適用 | 失敗10・エラー2。26.04拒否、旧controller/6.0の素通り、PHP/repo誤選択、最低版ガード未実装を検出 |
| 新規platformテストを修正後へ適用 | 8テスト成功。内部で新旧controller・OS・版の組み合わせを実行 |
| 既存Zabbix Jestベースライン | 1 suite / 64 tests 成功 |
| 修正後server-setup関連Jest | 33 suites / 2136 tests 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |
| `npm test -- --runInBand` 全件 | project-agent失敗後に進行が停止し、約5分後に当該プロセスを終了。全件合格ではない |
| 元ブランチの代表失敗再現 | `project-agent.spec.ts` の `should register on start and begin heartbeat/subscription` が同じheartbeat未発火で失敗 |

platformテストは `ansible-playbook` で実際の初期assert・テンプレートを評価する。
専用controllerは2.20.11、旧controllerは2.16.19。

```sh
ZABBIX_TEST_LEGACY_ANSIBLE=/private/tmp/zabbix-2604-ansible-venv/bin/ansible-playbook \
PATH=/private/tmp/zabbix-2604-supported-venv/bin:$PATH \
/private/tmp/zabbix-2604-supported-venv/bin/python -m unittest discover \
  -s ansible/tests -p test_zabbix_platform.py -v
```

### 実サービス検証環境

専用Dockerコンテナ `zabbix-resolute-native` (Ubuntu 26.04 / aarch64 / systemd)。
KAGOYAで予定するamd64の実機とはarchitectureが異なる。

| ソフトウェア | 実測版 |
|---|---|
| Python | 3.14.4 |
| ansible-core | 2.20.11 |
| Zabbix server / frontend | 1:7.0.32-2+ubuntu26.04 |
| PostgreSQL | 18.6-0ubuntu0.26.04.1 |
| PHP-FPM | 8.5.4-0ubuntu1.5 |

`tests/zabbix-native.yml` で新規構築・再適用・既存サイト共存・停止したサービス復旧・
Adminパスワード変更・housekeepingを検証する。テスト内に残っていたPHP8.3/PG16の
二択を26.04対応表に変更した。

初回構築で Server/PostgreSQL/Nginx/PHP-FPM のactiveとログイン画面応答を確認した。
初回API試験ではAdmin初期パスワード変更・同値再適用・第三のパスワードを介した変更・
housekeeping更新/再適用・API認証ファイルの削除まで通過した。
末尾のTimescaleDB否定試験は旧OS向けのDB plan到達を期待していたため失敗したが、
26.04では仕様通り初期assertで拒否されていた。fixtureをOS別の期待に修正した。
Admin/housekeepingの初期状態を既に変更しているため、最終再適用では
`zabbix_native_api_checks=false` として初期状態専用のAPIシナリオだけを省く。
最終再適用は終了コード0、`ok=168 changed=21 failed=0 skipped=54 rescued=1 ignored=0`。
changedには私的退避ファイルの作成/削除と、試験で意図的に停止したサービスの復旧を含む。
TimescaleDBは初期assertで拒否し、PostgreSQLの起動時刻・preloadが変わらず、
Timescaleパッケージ/リポジトリ/鍵が追加されず、Zabbix Serverがactiveを維持することも確認した。
最終API `apiinfo.version` は `7.0.32`、管理画面のpassword入力欄あり。

生ログ（ローカル一時証跡）:
- `/private/tmp/zabbix-2604-native.log`: API試験全通過、旧Timescale期待値で末尾失敗。
- `/private/tmp/zabbix-2604-native-rerun.log`: 修正後の再適用・復旧・初期拒否検証成功。
- `/private/tmp/zabbix-platform-green.log`: 新旧controllerの8テスト成功。
- `/private/tmp/zabbix-2604-jest.log`: 関連33スイート成功。
- `/private/tmp/zabbix-2604-baseline-project.log`: 元ブランチでの既存失敗再現。

### 未確認

- KAGOYAのamd64実機・SSH経由の構築とFW/VPN到達性。
- 26.04でのMySQL/Apache構成、既存Agentの遠隔再設定。
- 全Agent runtimeをAnsible2.20へ変更した際の全ロール・callback回帰。
- リポジトリ全体の全件テスト合格。

### 2026-11-04: 専用controllerと既存Agent PSK再設定

- Agent管理者設定`AI_SUPPORT_AGENT_ZABBIX_CONTROLLER=2.20`でZabbixのみ固定venvを使う。
  他bundled roleとの混在は拒否。既存runtimeは変更しない。
- 専用installerをUbuntu26.04/aarch64コンテナ内で実行し、固定パスへcore2.20.11導入を確認。
- controller選択・missing/wrongversion拒否・runner実行先同一・secret argv非出力をJestで確認。
- 既存PSKの奇数桁・512桁超過を拒否する試験は改修前2失敗→修正後合格。
- maintenance recipeのpreflight/Include検査を実Ansible/Pythonで検証。
- 専用`zabbix-resolute-native`内の実Agent2 7.0.32で同recipeを2回適用。
  最終実行は固定`/opt/ai-support-zabbix-ansible/bin/ansible-playbook`を使用。
  package版不変・原本backup hash維持・JSON/progressへのPSK非出力を確認。
- 正PSKでagent.ping=1、誤PSKと平文接続は拒否。実Zabbixでactive agent.pingを受信。
  fixtureが作ったhost/groupだけを終了時削除。VPS/DNS/既存監視対象は操作していない。
- ログ: `/private/tmp/zabbix-phase4-native.log`、`zabbix-phase4-server-setup.log`、
  `zabbix-phase4-platform.log`、`zabbix-phase4-maintenance.log`（全て同/tmp）。
- 関連Jest34 suites/2145 tests、platform9、maintenance49 tests、buildとstrict guard合格。
- 全件Jest初回はsandboxのlisten EPERMで停止し、権限制約を解除した別runを実行中。
  全件合格・coverage閾値・KAGOYA amd64実機受入はこの記録からは主張しない。

#### 最終追記

- Agent全件（承認済レシピ同期証明の追加後）: 369 suites/10,268 tests合格、
  1 suite/1 test失敗、4 suites/8 tests skip。失敗はguacd Docker fixtureに公開portがないもの。
  変更前`agent`でも同じ単独試験を実行して再現した。
  ログ: `/private/tmp/zabbix-phase4-all-agent-approved-policy.log`、
  `/private/tmp/zabbix-phase4-guacd-baseline.log`。全件合格とは扱わない。
- 新環境変数の集約違反は`src/constants.ts`へ移して修正済み。
- API/Agent双方でexact approved recipe body hashだけを同期完了可能とし、
  実runnerのprocessClosed証拠、server-owned receiptのbodyhash、実inspector/verifyを接続。
  legacy hash無しreceiptは再送可能だが監視proofへ昇格しない。
- 実DynamoDBを含むreceipt/inspector/controller関連9 suites/133 tests合格。
  body-less processing再送時のhash/mode保持は追加最終15 testsで確認。
- 管理者CLIの実HTTPS登録→同一世代retry→Agent適用→完了後ping/version到着も確認。
  CLIはPSK/identityのwrite-only性を踏まえ、identity読戻し成功を仮定しない。

- 最終extra-vars補強後: 専用5変数以外を拒否するAgent回帰2件/inspector回帰3件を
  改修前fail→改修後passで確認。Agent関連34 suites/2,148 tests、API inspector/chain19 tests合格。
  Agent全件は369 suites/10,270 tests合格、前述の既存guacd1件のみ失敗、8 tests skip。
  最終ログは`/private/tmp/zabbix-phase4-all-agent-extra-vars.log`。
- PSK/HTTPS CLI/Webhook実エンジン検証後、専用`zabbix-resolute-native`を停止した。
  既存の他コンテナは操作していない。
