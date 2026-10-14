# Zabbix サーバーのセットアップ

サーバセットアップの「監視・ログ」から「Zabbixサーバー構築」、続けて
「Zabbix管理画面構築」を挿入します。監視対象には既存の「Zabbix Agent導入」を
使用し、Zabbix側のホスト登録（自動登録またはAPI）は別途行います。

## 対応構成

Ubuntu 22.04/24.04、x86_64/ARM64、Zabbix 6.0/7.0 LTSの公式パッケージに対応します。
既定は7.0、ローカルPostgreSQL、Nginxです。Dockerインストール経路はありません。
ServerとWebは別ホストにも配置できます。

| ロール | 選択肢・責務 |
|---|---|
| `zabbix_server` | PostgreSQL/MySQL、`local`/`external`、初期スキーマとServer起動 |
| `zabbix_web` | Nginx/Apache、PHP-FPM、構築済みDBへの接続とWeb管理画面 |

`zabbix_server_db_password`と`zabbix_web_db_password`には、ANSIBLE#の秘匿変数を
同じ参照で指定してください。例: `"{{ ZABBIX_DB_PASSWORD }}"`。
設定ファイルへの改行挿入を防ぐため、パスワードは印字可能ASCII・改行なし・前後の空白なしに
限定します。引用符、バックスラッシュ、コロンは使用できます。

DBの種別・ホスト・ポート・名前・ユーザー・パスワードを両ロールで合わせます。
`zabbix_web`はDB作成を行わず、`db_mode`変数も持ちません。
設定変数の一覧と既定値は各ロールの`defaults/main.yml`を参照してください。

## 外部DB

`zabbix_server_db_mode: external`ではDBサーバーやユーザーを作成しません。
専用DBとユーザーを事前に準備し、テーブル・インデックス・関数等を作成できる権限を付与します。
PostgreSQLはUTF8とpublicスキーマ、MySQLはutf8mb4/utf8mb4_binを使用してください。
MySQLのバイナリログが有効なら、管理者がスキーマ投入前に
`log_bin_trust_function_creators=1`を設定し、投入後に元へ戻してください。
ローカルMySQLではロールが一時的に設定して、成功・失敗のどちらでも復元します。
DB接続のネットワーク許可も事前に設定してください。

## 再実行と復旧

- 空のDB: 公式SQLと初期データを投入します。
- 完了済みDB: スクリプト内の全テーブル、LTSバージョン行、主要な初期データを確認して投入を省略します。
- 不完全なDB: 処理を失敗させます。既存データの自動削除・追記は行いません。

PostgreSQLの投入は単一トランザクションです。SQLが失敗すればロールバックします。
（TimescaleDBでは2段階になります。下記「TimescaleDB」を参照してください。）
MySQLのDDLはロールバックできないため、投入中のマーカーテーブル
`_ai_support_zabbix_import`を残し、次回実行でも失敗を検出します。
失敗時はDBの状態とバックアップを確認し、初期構築用の専用DBを作り直すかバックアップから
復元してから再実行してください。運用中のDBを無条件に作り直さないでください。

既存ServerパッケージのLTS変更は拒否します。LTSのアップグレード・ダウングレードは
バックアップ後、公式手順に従う別作業です。DBのバージョン不一致も自動修復しません。
DB初期化への同時実行はDBのアドバイザリロックで拒否します。

## 管理画面とネットワーク

管理画面は既定でHTTPの8080番ポートを使います。`zabbix_web_server_name`は必須です。
パッケージ標準のvhostを無効にし、`ai-support-zabbix.conf`を独立して配置します。
既存サイトの設定ファイルは編集しません。Webサーバー種別を切り替える場合は、旧ロールが
管理していたvhostの整理と80番ポートの競合確認を別途行ってください。
Apacheでは独立したListenを定義するため、既存のListenと重ならないポート（80/443以外）を指定します。

外部公開する管理画面はTLS終端を用意してください。管理者（`Admin`）のパスワードは
`zabbix_web_admin_password`で設定できます（下記「管理者パスワード」）。
Serverの起動確認ではTCP接続だけでなく、ループバックから統計リクエストへの応答とLTSを確認します。
Webはセットアップウィザードではなくログインフォームが返ることを確認します。
Web設定の更新からサービスへの反映・ログイン確認までを復元対象に含めます。
失敗時はDB接続設定、PHP-FPM設定、vhostとサービスの起動・自動起動状態を戻します。
復元後はPHP-FPMのキャッシュも更新します。成功または復元完了後に一時バックアップを削除し、
復元自体が失敗した場合は手動復旧用にroot専用のバックアップを残します。

## ファイアウォール（ufw）の許可元

Serverの10051番（`zabbix_server_listen_port`）とWebの8080番（`zabbix_web_listen_port`）は、
`zabbix_agent`と同じ方式でufwの許可ルールを収束させます。

| 変数 | 既定 | 説明 |
|---|---|---|
| `zabbix_server_allowed_sources` / `zabbix_web_allowed_sources` | `[]` | 許可する送信元のIPv4アドレス・CIDRのリスト |
| `zabbix_server_ufw_manage` / `zabbix_web_ufw_manage` | `true` | `false`ならufwに一切触れない |
| `zabbix_server_allow_no_sources` / `zabbix_web_allow_no_sources` | `true` | 空リスト＋管理ONを失敗させない |

- 送信元はIPv4アドレスまたはCIDRに限ります（ホスト名不可、プレフィックスは1〜32、`/0`不可）。
- `/32`は付けても付けなくても同じです。ufwは`192.168.0.20/32`を`192.168.0.20`として保存するため、
  ロールが`/32`を取り除いてから追加・照合します。
- ホストビットが立ったCIDR（例`10.0.0.5/24`）は拒否します。ufwは`10.0.0.0/24`に正規化して保存し、
  書いた範囲と開く範囲が食い違うためです。ネットワークアドレス（`10.0.0.0/24`）で書いてください。
- ルールには`ai-support-agent:zabbix_server`／`ai-support-agent:zabbix_web`のコメントを付け、
  このコメントが付いたルールだけを追加・削除します。許可元やポートを変えると、古いルールは削除されます。
  運用者が手で入れた同じ条件のルールや、送信元を指定しない`ufw allow 10051/tcp`のようなルールには
  触れません（全開放のルールが残っている場合は手で削除してください）。
- 空リストは「このロールが開けたルールをすべて閉じる」という意味です。既定（`allow_no_sources: true`）では
  失敗せず、「ポートはこのロールでは開放されていない」と毎回警告します。既定が`zabbix_agent`
  （`false`）と逆なのは、変数を追加していない既存レシピを失敗させないためです。新規レシピでは
  `allow_no_sources: false`を指定し、許可元の書き忘れを失敗として検出してください。
- ufwの有効化は行いません（`os_init`の責務）。ufwが無効でもルールは収束させ、次に有効化したときに効きます。
- ServerとWebを別ホストに置く場合、`zabbix_server_allowed_sources`にはアクティブチェックを送る
  Agent、Webホスト、Proxyを含めてください。
- Serverは統計リクエストへの応答を確認した後、Webはフロントエンド設定の反映・ログイン確認
  （ロールバック対象）の後に収束させます。ufwの失敗ではフロントエンド設定を戻しません。
- 同じ変更は`zabbix_agent`・`rsyslog_server`にも適用済みです（`/32`の正規化とホストビット付きCIDRの拒否）。

## 管理者パスワード

Zabbixのフロントエンドは初期管理者`Admin`／パスワード`zabbix`で構築されます。
`zabbix_web_admin_password`を指定すると、ロールがZabbix APIでこのパスワードを設定します。

| 変数 | 既定 | 説明 |
|---|---|---|
| `zabbix_web_admin_password` | `""` | `Admin`に設定するパスワード。ANSIBLE#の秘匿変数で渡す（例: `"{{ ZABBIX_ADMIN_PASSWORD }}"`） |
| `zabbix_web_admin_previous_password` | `""` | ローテーション用。いま有効なパスワード（変更前の値） |

- 空なら何もしません（既存レシピ互換。初期パスワードのまま残ります）。空のまま
  `zabbix_web_allowed_sources`を指定すると、「初期パスワードのまま公開している可能性がある」と警告します。
- 印字可能ASCII 8〜72文字・前後の空白なし・`zabbix`以外に限ります。previousは0〜72文字です。
  Zabbix側のパスワードポリシー（長さ・文字種）に違反した場合は、APIのエラーメッセージを表示して失敗します。
- ログインは「新しいパスワード → previous（空でなければ）→ 初期値`zabbix`」の順に試します。
  新しいパスワードでログインできれば変更しません（再実行してもchangedになりません）。
  previousか初期値でログインできたら`user.update`で変更し、新しいパスワードで再ログインして確かめます。
- どのパスワードでもログインできなければ失敗します。いまのパスワードを
  `zabbix_web_admin_previous_password`に渡すか、`zabbix_web_admin_password`を空にしてこのロールでの
  管理をやめてください。`Admin`が無効化・削除・一時ブロックされていないかも確認してください。
  失敗のたびにログイン失敗回数が増える（Zabbix既定では5回で一時ブロック）ため、原因を解消してから再実行してください。
- 変更は送信できたが新しいパスワードで再ログインできなかった場合も失敗します。変更は反映済みの
  可能性が高いため、まず新しいパスワードでログインできるか確認してください。
- ユーザー名`Admin`と初期値`zabbix`はロール内の固定値で、変数では変えられません。
- 処理はフロントエンド設定の反映・ログイン確認（ロールバック対象）の後、ufwの収束より前に行います。
  パスワードの設定に失敗した実行では、ufwで8080番を新たに開けません。パスワードの失敗では
  フロントエンド設定を戻しません（設定ファイルの問題ではなく、戻す先が初期パスワードになるため）。
- パスワードは一時ファイル（root専用・0600）経由でヘルパー（`/usr/local/lib/ai-support-zabbix-api.py`）へ
  渡し、実行後に削除します。コマンド引数・環境変数・実行ログには出しません。
- APIはループバック（`http://127.0.0.1:<zabbix_web_listen_port>/api_jsonrpc.php`、Hostヘッダは
  `zabbix_web_server_name`）へ接続します。APIのバージョンが`zabbix_web_version`と違えば失敗します。

## ハウスキーピング

`zabbix_web_housekeeping`に、Zabbixのハウスキーピング設定（Administration → Housekeeping、
7.0の監査ログはAdministration → Audit log）のうち変更したいキーだけを辞書で書きます。
空（既定）なら何もしません。`housekeeping.update`はSuper adminだけが実行できるため、
指定するときは`zabbix_web_admin_password`も必須です。

```yaml
zabbix_web_admin_password: "{{ ZABBIX_ADMIN_PASSWORD }}"
zabbix_web_housekeeping:
  hk_history_global: 1
  hk_history: 90d
  hk_trends_global: 1
  hk_trends: 365d
```

| 区分 | キー | 値 |
|---|---|---|
| 有効化・上書き・圧縮 | `hk_events_mode` `hk_services_mode` `hk_audit_mode` `hk_sessions_mode` `hk_history_mode` `hk_trends_mode` `hk_history_global` `hk_trends_global` `compression_status` | `0`／`1`（整数または文字列。真偽値は不可） |
| 保存期間 | `hk_events_trigger` `hk_events_service` `hk_events_internal` `hk_events_discovery` `hk_events_autoreg` `hk_services` `hk_audit` `hk_sessions` | 1d〜25y |
| ヒストリ | `hk_history` | `0`、または1h〜25y |
| トレンド | `hk_trends` | `0`、または1d〜25y |
| 圧縮の閾値 | `compress_older` | 7d〜25y |

- 期間は秒数（整数または数字の文字列）か、`s`/`m`/`h`/`d`/`w`の単位付き（例`90d`、`2w`）で書きます。
  ユーザーマクロ、`y`/`M`の単位、空白は使えません（25yは`9125d`と書きます）。
- 読み取り専用の`db_extension`・`compression_availability`と、上記以外のキーは拒否します。
- 現在値と秒数に直して比較し（`365d`と`31536000`は同じ）、差のあるキーだけを更新します。
  差がなければ更新せず、changedになりません。指定していないキーには触れません。
  更新する値は書いたとおりの形で送ります（`90d`は画面上も`90d`）。
- `compression_status: 1`と`compress_older`はTimescaleDBのDBでだけ指定できます（APIの`db_extension`で判定）。
  TimescaleDBでなければ失敗し、何も更新しません。`compression_status: 1`で圧縮が使えない
  （`compression_availability`が0。Apacheライセンス版のTimescaleDBなど）場合も失敗します。
- TimescaleDB環境では`hk_history_global`と`hk_trends_global`を`1`にしてください。`0`のままだと
  パーティション単位の削除が効かず、Zabbixが警告を出します（ロールは失敗させません）。
- 監査ログの有効化そのもの（`settings`）はこのロールの対象外です。

## TimescaleDB

`zabbix_server_db_timescaledb: true`（既定は`false`）で、ヒストリ・トレンド（7.0は監査ログも）を
TimescaleDBのハイパーテーブルとして構築します。PostgreSQLのみです。
**対象は新規構築（空のDBへの初期投入）だけ**です。

```yaml
zabbix_server_db_type: postgresql
zabbix_server_db_timescaledb: true
```

| DBの状態 | `true` | `false` |
|---|---|---|
| 空 | 公式SQLとTimescaleDBスクリプトを投入 | 通常どおり投入 |
| 投入済み・通常DB | **失敗**（PostgreSQLの設定変更・再起動より前に止める） | 通常どおり |
| 投入済み・TimescaleDB化済み | 変更なし | **失敗**（`true`の指定が必要） |
| ハイパーテーブルが一部だけ、`db_extension`と食い違う、拡張が無い | 失敗 | 失敗 |

- **ローカルDB**: Timescaleの公式APTリポジトリ（packagecloud）からCommunity版
  （`timescaledb-2-postgresql-14/16`）を導入します。リポジトリURL・GPG鍵の指紋・版の範囲は
  ロール内に固定しており、変数では変えられません。版は2.13〜2.28の範囲で最新のものを選び、
  `/etc/apt/preferences.d/ai-support-timescaledb`で固定します（2.28が上限なのは、Zabbix 6.0.48が
  2.29で起動を拒否するため）。導入済みの版が範囲内ならその版を維持し、範囲外なら失敗します。
  PostgreSQLはUbuntu同梱のメジャー（22.04は14、24.04は16）だけに対応します。
- **初回は PostgreSQL が再起動されます。** `shared_preload_libraries`に`timescaledb`を足すためで、
  同じホストの他のDBも一時停止します。以後の実行では再起動しません。
- `shared_preload_libraries`は`ALTER SYSTEM`（`postgresql.auto.conf`）で既存の値と合流させます
  （`pg_stat_statements`等は残ります）。`postgresql.auto.conf`は`postgresql.conf`より優先されるため、
  **以後は`postgresql.conf`を編集しても preload は変わりません**。変更するときは
  `ALTER SYSTEM SET shared_preload_libraries = ...`を使ってください。
- テレメトリは`timescaledb.telemetry_level=off`で固定します。
- `AllowUnsupportedDBVersions`は設定しません。サポート外のTimescaleDB版だとZabbix serverは
  起動を拒否します（起動確認で失敗した場合は`/var/log/zabbix/zabbix_server.log`の
  `Unsupported DB!`を確認してください）。古い6.0マイナーは新しいTimescaleDBを受け付けないことがあります。
- `timescaledb-tune`は実行しません。必要なら手作業で行ってください。
- **外部DB**（`external`）: DBサーバーには触れません。DBAが対象DBでCommunity版の拡張を事前に作成し
  （`CREATE EXTENSION timescaledb CASCADE`、`timescaledb.license`が`timescale`）、preloadも設定しておきます。
  拡張が無い、またはApache版（`license`が`apache`）なら失敗します。
- 投入は2段階です。公式の`server.sql`は末尾に自身の`COMMIT`を持つため、TimescaleDBスクリプトと
  1つのトランザクションにできません。1段目（`server.sql`）と同時にマーカーテーブル
  `_ai_support_zabbix_timescaledb_pending`を作り、2段目（TimescaleDBスクリプト）と同時に削除します。
  2段目が失敗するとマーカーが残り（ハイパーテーブルは作られていない）、次回の実行で2段目だけを
  やり直します。この状態で`false`を指定すると失敗します。

### 既存DBの手動移行

データ量に応じて長時間かかり、ZabbixのServerとWebの停止が必要です。

1. Zabbix serverとフロントエンド（PHP-FPM/Webサーバー）を停止する
2. DBをバックアップする
3. TimescaleDBのパッケージを導入し、`shared_preload_libraries`に`timescaledb`を足してPostgreSQLを再起動する
4. `postgres`ユーザーで対象DBに`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`
5. Zabbix DBユーザーで公式スクリプトを実行する
   - 6.0: `/usr/share/zabbix-sql-scripts/postgresql/timescaledb.sql`
   - 7.0: `/usr/share/zabbix-sql-scripts/postgresql/timescaledb/schema.sql`
6. Zabbixを起動し、以後のレシピでは`zabbix_server_db_timescaledb: true`を指定する

**TimescaleDBの解除はロールの対象外です。** バックアップから通常のDBへ移行し直してください。

### パッケージ更新

拡張のパッケージ更新は手作業です。apt pinで意図しない更新を防いでいます。更新するときは、
Zabbixの対応範囲（6.0は使用中のマイナーが許す上限）を確認し、pinを書き換えてパッケージを更新したうえで、
拡張を使う全DBで`ALTER EXTENSION timescaledb UPDATE;`を実行します（新しいセッションで最初に実行）。
ロールは導入済みの版が2.13〜2.28の範囲外になると失敗するため、範囲を外れる更新はロールの更新を待ってください。

## 開発時の検証

`tests/test_zabbix_database.py`は専用テストDBを使用します。実運用DBへ向けないでください。

```sh
ZABBIX_TEST_ENGINE=postgresql ZABBIX_TEST_PORT=15432 \
ZABBIX_TEST_PASSWORD=test-password \
ZABBIX_TEST_SCHEMA_ROOT=/path/to/official/zabbix-sql-scripts \
python -m unittest discover -s ansible/tests -v
```

TimescaleDBのテストは`timescale/timescaledb`のPG16イメージの使い捨てコンテナで実行します。
`postgres`ユーザーでテストごとに`template0`からDBを作り直します（イメージは`template1`に拡張を入れているため）。
Apache版のケースは同じイメージを`-c timescaledb.license=apache`で起動したコンテナを使います。

```sh
docker run -d --name ts16 -e POSTGRES_PASSWORD=pw -p 127.0.0.1:25432:5432 timescale/timescaledb:2.28.1-pg16
docker run -d --name ts16-apache -e POSTGRES_PASSWORD=pw -p 127.0.0.1:25433:5432 \
  timescale/timescaledb:2.28.1-pg16 -c timescaledb.license=apache
ZABBIX_TEST_TIMESCALEDB=1 ZABBIX_TEST_TIMESCALEDB_PORT=25432 \
ZABBIX_TEST_TIMESCALEDB_ADMIN_PASSWORD=pw ZABBIX_TEST_TIMESCALEDB_APACHE_PORT=25433 \
ZABBIX_TEST_SCHEMA_ROOT=/path/to/official/zabbix-sql-scripts ZABBIX_TEST_SCHEMA_VERSION=7.0 \
python -m unittest discover -s ansible/tests -v
```

MySQLは`ZABBIX_TEST_ENGINE=mysql`に切り替えます。テスト対象は
`zabbix_test` DBと`zabbix_test`ユーザーです。テストはそのDBのテーブルを削除します。
公式SQLパッケージがない場合、その全体投入テストはスキップされます。

`tests/test_zabbix_api.py`は管理者パスワード・ハウスキーピングのヘルパーを、6.0（本文の`auth`）と
7.0（`Authorization: Bearer`）を模した偽のJSON-RPCサーバーに向けて実行します。外部環境は不要です。
全ケースで、出力にパスワードとトークン（平文・Base64）が無いことも確認します。

```sh
python3 ansible/tests/test_zabbix_api.py -v
```

Ubuntuのサービス検証は`tests/zabbix-native.yml`を隔離VMまたはsystemd付きコンテナで実行します。
コンテナ用のベースイメージは`tests/Dockerfile.zabbix`です。
Dockerでは`--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock`を使用し、
**ホストの`/sys/fs/cgroup`を共有マウントしないでください**。
Ansibleロールとコレクションを読み取り専用でマウントし、`ANSIBLE_ROLES_PATH`を指定します。

```sh
ansible-playbook -i localhost, ansible/tests/zabbix-native.yml
ansible-playbook -i localhost, ansible/tests/zabbix-native.yml \
  -e zabbix_server_db_type=mysql -e zabbix_web_type=apache
```

それぞれ別の隔離ホストで実行してください。既存サイトの応答、再実行、停止・無効化した
Web/PHPサービスの復旧を確認します。外部DB構成では、払い出し済みDBのホスト・ポート・
認証情報を指定します。サービスの実機検証結果と未検証構成は変更の検証記録に残してください。

### 引き継ぎ時の検証記録（2026-10-14）

`feature/zabbix-firewall-admin-password` の既存 worktree（agent / api / web / admin-docs）を
引き継いだ。追加機能は未コミット・未デプロイ。KAGOYA の対象ホスト・接続経路・適用済み
レシピは未特定であり、以下の成功は KAGOYA への適用完了を意味しない。

| 検証 | 結果 |
|---|---|
| agent: Zabbix・監視ロール・秘匿診断・Ansible ガードの Jest 7 suite | 1,217 件成功 |
| api: Zabbix・Ansible ガードの Jest 5 suite | 1,088 件成功 |
| web: Zabbix スニペットの Jest 1 suite | 10 件成功 |
| `python3 -m unittest discover -s ansible/tests -p 'test_zabbix*.py' -v` | 28 件成功、24 件スキップ（専用 DB・復旧用 fixture が必要） |
| `tests/zabbix-validation.yml`（既存 Ubuntu 22.04 / ARM64 検証コンテナ） | 不正入力 68 ケースを意図した箇所で拒否。`ok=341 changed=0 failed=0 rescued=68` |
| `tests/zabbix-native.yml --syntax-check` | 成功。ただし動的 include 内の実行検証ではない |
| agent / web / admin-docs の `npm run build`、api の `npm run build:prod` | すべて成功 |
| api / agent の変数一覧の突合 | 公開変数 Server 14・Web 20、Zabbix 予約内部変数 67、常時秘匿変数 2 が一致 |

レビューでは ufw の所有コメントと `/32` 正規化、API パスワード変更を ufw 開放より前に
実行する順序、DB の `--plan` による既存 DB の変換拒否、ガードの変数登録を確認した。
この確認範囲で新たな HIGH / CRITICAL は検出していないが、実 DB・実通信の再検証が
残るため、リリース承認の判定は保留する。

次に行うこと:

1. KAGOYA の対象ホスト、OS、接続経路、現在のレシピ・実行履歴を確認する。
2. 専用 DB で初期化・再実行・中断後の復旧と TimescaleDB を検証する。
   `zabbix-native.yml` の API ケースは初期パスワードと初期保存期間を前提とするため、
   既に実行済みの fixture にそのまま流し直さず、新しい隔離環境を用意する。
3. ufw の許可元・拒否元からの通信、`-vvv` ログの秘匿、Web 復旧を検証する。
   lint とリリースに必要な全体チェックも完了させる。
4. 差分レビューを完了し、コミット・公開の範囲を確認する。
   配布順は agent（CLI リリースと対象 agent 更新）→ api → web → admin-docs。

引き継ぎ時の 53 ファイルのコピー・差分・SHA-256 と今回の検証ログは、作業端末の
`/private/tmp/zabbix-takeover-20261014/` に保存した（一時領域なので永続保管ではない）。
