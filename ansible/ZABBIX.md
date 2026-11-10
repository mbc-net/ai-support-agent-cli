# Zabbix サーバーのセットアップ

サーバセットアップの「監視・ログ」から「Zabbixサーバー構築」、続けて
「Zabbix管理画面構築」を挿入します。監視対象には既存の「Zabbix Agent導入」を
使用し、Zabbix側のホスト登録（自動登録またはAPI）は別途行います。

## 対応構成

x86_64/ARM64、Zabbix LTSの公式パッケージに対応します。OSごとに選べるLTSが異なります。

| Ubuntu | `zabbix_server_version` / `zabbix_web_version` | PHP | PostgreSQL（ローカルDB） |
|---|---|---|---|
| 22.04 | 6.0 / 7.0 | 8.1 | 14 |
| 24.04 | 6.0 / 7.0 | 8.3 | 16 |
| 26.04 | 7.0 / 8.0 | 8.5 | 18 |

- 8.0 は PHP 8.2 以上・PostgreSQL 15 以上を要求し、このロールでは 26.04 でしか検証していないため、
  22.04/24.04 で 8.0 を指定すると初期検証で拒否します。26.04 では 6.0 を拒否します（26.04 向けの release パッケージが無いため）。
- 26.04 では、既存の Server/Web パッケージと導入直後のパッケージが検証済みパッチ未満なら拒否します
  （7.0 は 7.0.32、8.0 は 8.0.0）。既存パッケージが下限未満の場合は通常セットアップで変更しません。
  導入直後は必要な2パッケージが揃い、選択した系列・epoch（後述）であることも確認し、DB初期化・Web設定より前に止めます。
  新規構築では構築時の最新パッチを確認してください。厳密なパッチ固定はこのロールでは未対応です。
- `zabbix_agent` は従来どおり 6.0/7.0 のみで、26.04 では 7.0 だけを受け付けます。
  7.0 の Agent を 8.0 の Server へ接続する構成は未検証です。

**Zabbix 8.0 で変わる点（ロール内で吸収済み・変数では変えられない）:**

| 項目 | 6.0 / 7.0 | 8.0 |
|---|---|---|
| パッケージの epoch | `1:`（例 `1:7.0.32-2+ubuntu26.04`） | `2:`（例 `2:8.0.0-1+ubuntu26.04`） |
| パッケージのリポジトリ | `https://repo.zabbix.com/zabbix/<LTS>/ubuntu`（ARM64 は `ubuntu-arm64`） | `https://repo.zabbix.com/zabbix/8.0/stable/ubuntu`（ARM64 も同じ URI） |
| `zabbix-release` の取得元 | 上と同じリポジトリの `pool/main/z/zabbix-release/` | `https://repo.zabbix.com/zabbix/8.0/release/ubuntu/pool/main/z/zabbix-release/` |
| 公式SQLスクリプト | `/usr/share/zabbix-sql-scripts/<engine>/` | `/usr/share/zabbix/sql-scripts/<engine>/` |
| 初期データの確認対象 | `users` と `config` | `users` と `settings`（7.4 で `config` がキー・値形式の `settings` に置き換わった） |
| フロントエンドの DocumentRoot | `/usr/share/zabbix` | `/usr/share/zabbix/ui`（7.2 以降は ui/ へ移動し、旧パスには「Manual intervention is required」を返すスタブだけが残る） |

- 8.0 の `zabbix-release` パッケージは `zabbix.sources` に加えて `zabbix-unstable.sources`（`Enabled: no`）を置きます。
  パッケージの設定ファイルなので書き換えず、`Enabled: no` の行があることだけを確認します。
  手で有効化されている場合は、Zabbix パッケージの導入より前に失敗します（ファイルが無い場合は通過）。
- 既存パッケージの LTS 照合は epoch に依存しません（`1:`・`2:`・epoch なしのいずれも系列で判定）。
  導入直後の検証は `^<epoch>:<LTS>.` の形まで確認するため、7.0 を指定して 8.0 のパッケージ（またはその逆）が入っていれば失敗します。
- DB の LTS 照合（`dbversion`）は `[下限, 下限+10000)` の範囲で判定します（6.0=6000000、7.0=7000000、8.0=8000000）。
  Zabbix の採番は XXYYZZZZ で、7.2 は 7020000 です。以前は `+100000` の範囲で判定しており、
  7.0 を指定して 7.2/7.4 の DB を受け入れていた不具合を同時に修正しました。

**Ubuntu 26.04 の実行条件:** 標準 Python 3.14 を扱える ansible-core 2.20 以降の controller が必要です。

- **Docker 版 Agent:** イメージ（`docker/Dockerfile`、ubuntu:26.04・Python 3.14）の既定 Ansible が
  `ansible-core>=2.20,<2.21` なので、そのまま 26.04 の接続先を扱えます。下の専用 controller は不要で、
  `AI_SUPPORT_AGENT_ZABBIX_CONTROLLER` も設定しません。2.17 系を同梱していた旧イメージ（node:24-slim ベース）では
  使用できないため、Agent イメージを更新してから実行してください。
- **常駐 Agent:** controller はホストに入っている Ansible です。2.20 未満なら下の専用 controller を導入します。

ロール内にも旧 controller の拒否を追加していますが、fact 収集はロールより前なので、
その段階で失敗する可能性があります。必ず実行開始前に 2.20 以降の controller を用意してください。

**専用 controller の導入（常駐 Agent の管理者のみ）:** 固定パス `/opt/ai-support-zabbix-ansible` に ansible-core 2.20.11 の
venv を作る installer `scripts/install-zabbix-controller.sh` を npm パッケージに同梱しています。

- 前提: Python 3.12 以上と venv（Ubuntu では `python3-venv` パッケージ）。
- Agent を導入したユーザーの npm から場所を求め、root で実行します。
  例: `sh <Agent の npm root -g の出力>/@ai-support-agent/cli/scripts/install-zabbix-controller.sh`
  （root と Agent のユーザーで npm の場所が違う場合があるため、`sudo` の中で `npm root -g` を評価しないこと）。
- Docker 版 Agent はこの仕組みの対象外です（イメージの既定 Ansible が ansible-core 2.20 のため不要）。
- 導入後、Agent の環境変数 `AI_SUPPORT_AGENT_ZABBIX_CONTROLLER=2.20` を設定して Agent を再起動します。
  未設定なら従来の controller のままです。`2.20` 以外の値は拒否します。controller が無い・版が違う場合は、
  SSH 接続より前に明確なエラーで止まります（従来の controller へは切り替えません）。
- 設定すると、Zabbix ロール（`zabbix_agent`・`zabbix_server`・`zabbix_web`・`zabbix_webhook_relay`）を含むレシピは
  専用 controller で実行されます。**Zabbix ロールと他の同梱ロールを同じレシピに混在させると、対象 OS にかかわらず拒否**
  します（他ロールは 2.20 で未検証のため）。混在しているレシピは Zabbix 部分を別レシピに分けてください。

Ubuntu 26.04 の TimescaleDB 自動導入は未対応のため、LTS（7.0/8.0）にかかわらず
`zabbix_server_db_timescaledb: true` を初期検証で拒否します。26.04 では通常の PostgreSQL を使用します。
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
vhost では `api/`・`conf/`・`include/`・`locale/`・`vendor/` ディレクトリへのアクセスを拒否します
（`api/` は 8.0 公式 nginx 設定に合わせて追加。API の入口 `api_jsonrpc.php` は別ファイルで、拒否されません）。

### 待受アドレス（`zabbix_web_listen_address`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `zabbix_web_listen_address` | `""` | Nginx の待受アドレス。空なら従来どおり全 interface（`listen 8080;`） |

- 指定できるのは空か `127.0.0.1` だけです。それ以外（`10.0.0.5`・`127.0.0.2`・`0.0.0.0` など）は初期検証で拒否します。
  ログイン画面の確認と、管理者パスワード・ハウスキーピングの API ヘルパーが `127.0.0.1:<zabbix_web_listen_port>` へ接続するためです。
  `127.0.0.1` を指定すると `listen 127.0.0.1:<port>;` になります。
- Nginx のみです。`zabbix_web_type: apache` と組み合わせると初期検証で拒否します。
- 指定するときは `zabbix_web_allowed_sources` を空にしてください（ループバックだけで待ち受けるのに ufw で開けるのは矛盾するため拒否します）。
  外部からは SSH トンネルやリバースプロキシで到達する構成を想定しています。
- 指定時は設定反映・ログイン確認の後に `ss` で実際の待受を読み、そのポートの待受が指定アドレスの1件だけであることを確認します。
  一致しなければ失敗し、フロントエンド設定を復元します。

**Nginx の reload では待受を縮小できません。** 同じポートで全 interface から特定アドレスへ変えると、
reload は `bind() to 127.0.0.1:8080 failed (98: Address already in use)` で失敗し、Nginx は旧設定のまま動き続けます
（2026-11-08 に KAGOYA の Ubuntu 26.04 実機で再現）。逆方向（特定アドレスから全 interface）も同じ理由で失敗します。
そのため Nginx では、反映前に `ss` で実際の待受を読み、**そのポートに待受があるのに、設定したローカルアドレス
（空なら `0.0.0.0:<port>`、`127.0.0.1` なら `127.0.0.1:<port>`）の待受が無いときだけ restart** します。

- 設定どおりの待受があれば、vhost の他の変更（ルートや拒否ディレクトリなど）は従来どおり reload です。
  同じポートに別の待受（別 server ブロックの `[::]:<port>` など）があっても restart しません。
  ただし `127.0.0.1` 指定時は、ログイン確認後の待受確認が「`127.0.0.1:<port>` の1件だけ」を要求するため、
  別の待受があれば失敗して設定を復元します（外部公開になっているため）。
- まだ何も待ち受けていない（初回導入）ときも reload です（reload で新しいソケットが追加されるため）。
- 設定ファイルだけ縮小済みで Nginx が旧待受のまま動いている状態も、この判定で restart して復旧します
  （2026-11-08 に実機で再現し、restart で `127.0.0.1:8080` だけになることを確認）。
- Apache は待受アドレスを変えないため従来どおり reload です。

失敗時の復元では、vhost を変更していれば restart します。
**restart は同じ Nginx で動いている他のサイトも一時停止させます。** 待受を変える実行は、影響を確認してから行ってください。

Web ロールは `ss` のために `iproute2` を導入します。

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
  8.0 の認証は 7.0 と同じ `Authorization: Bearer` で、パスワード変更時の `current_passwd` も 7.0 と同じ扱いです。

## ハウスキーピング

`zabbix_web_housekeeping`に、Zabbixのハウスキーピング設定（Administration → Housekeeping、
7.0の監査ログはAdministration → Audit log）のうち変更したいキーだけを辞書で書きます。
空（既定）なら何もしません。`housekeeping.update`はSuper adminだけが実行できるため、
指定するときは`zabbix_web_admin_password`か`zabbix_web_api_token`（後述の「SAML（SSO）とAPIトークン」）も必須です。

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

## SAML（SSO）とAPIトークン

Zabbix の画面のログインを外部の SAML 2.0 IdP に任せ、パスワードのログインの経路を残さない構成にします。
変数を何も足さなければ従来どおりに動きます（`zabbix.conf.php` の内容・検査・API の呼び出しは変わりません）。

**前提:**

- `zabbix_web_version` は 7.0 か 8.0（6.0 は拒否）。インストール済みの `zabbix-frontend-php` が 7.0.32 以上・8.0.0 以上
  であることを Ubuntu の版に関わらず確かめます（SSO を使う 7.0.0 は CVE-2024-36466 の対象。下限はこのロールの検証済みの版）。
  ヘルパーも `apiinfo.version` の完全な版で同じ下限を確かめ、下回れば何も変えずに失敗します。
- 利用者は前段の TLS 終端（リバースプロキシや CDN）経由の https の公開 URL で開きます。`zabbix_web_saml_public_url`
  を `$SSO['SETTINGS']['baseurl']` に固定し、`use_proxy_headers` は `false`（`X-Forwarded-*` を信頼しない）、`strict` は `true` です。
- `zbx_session` の Cookie は SAML の属性（利用者名・NameID）を暗号化せずに含みます。SAML を有効にする前に、
  前段から上流への転送で Cookie に `Secure` が付くこと（例: nginx の `fastcgi_param HTTPS on`）を確かめてください。
- 上流の vhost（`zabbix_web_listen_port`、既定 8080）が前段以外から届かないこと（ufw などの送信元の制限）。
- 画面のパスワードのログイン（`/index.php` の `name`・`password`・`enter`。GET のクエリでも通る）は、前段の WAF などで
  全員分止めることを推奨します（ロールは前段を設定しません）。ログアウトは POST `/index.php?reconnect=1` です。

**仕組み:**

- 証明書は 7.0・8.0 とも**ファイル**に置きます（7.0 は DB に置けません。8.0 の既定は DB なので
  `$SSO['CERT_STORAGE'] = 'file';` を明示します）。`/etc/zabbix/web/saml/`（`root:www-data` 0750）に `idp.crt`
  と、指定したときだけ `sp.crt`・`sp.key`（0640）を置きます。API には証明書の項目を送りません
  （8.0 のファイル方式で `idp_certificate` などを送ると `unexpected parameter` で失敗するため）。
- `zabbix_web_saml_idp_certificates` は 1〜2 件です。1 件目を `idp.crt` に、全部を
  `$SSO['SETTINGS']['idp']['x509certMulti']['signing']` に入れます（`x509certMulti` があると `idp.crt` は検証に使われません）。
- API の収束（ヘルパー）: SAML の userdirectory（`idp_type=2`）を作るか差分だけ更新し（`nameid_format` は必ず送る。
  Zabbix の既定は空文字で、IdP によっては `Format=""` を拒否します）、JIT の役割・グループの対応、無効化用のグループ、
  `authentication`（`saml_auth_enabled`・`saml_case_sensitive`・`saml_jit_status`・`disabled_usrgrpid`）を収束させます。
  2 回目以降は差分が無ければ何も更新しません。
- 役割の名前・グループの名前・メディア種別の名前は既存のものを引きます（見つからなければ失敗）。無効化用のグループ
  （`deprovisioned_group`）だけは、無ければ無効の状態で作ります。既にあって有効なら失敗します。
- **Super admin は SAML では渡しません。** Super admin の種類の役割（名前に関わらず）を対応に書くと失敗します。
- **手動の利用者の検査:** 内部の（SAML の userdirectory に属さない）利用者に `@` を含む名前があると、SAML を有効に
  する前に失敗します（Zabbix は SAML の利用者名で同じ名前の内部の利用者にもログインさせ、その利用者の今の役割
  のまま入れてしまうため）。件数だけを出します。`zabbix_web_saml_allow_legacy_users: true` の間だけこの検査を
  外します（IdP の検証期間に、アサーションが検証の利用者 1 人にしか出ない間だけ使い、その利用者の email が
  内部の利用者の名前と一致しないことを人が確かめる）。**内部の利用者（サービス用・break-glass 用など）の名前に
  `@` を使わないでください**（検査はロールの実行のときだけです）。

### 変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `zabbix_web_api_token` | `""` | サービス用の利用者の API トークン（64 桁の 16 進）。ANSIBLE# の秘匿変数で渡す。空でなければヘルパーはこれだけを使い、`Admin` でログインせず、`zabbix_web_admin_password` の収束もしない |
| `zabbix_web_admin_lockdown` | `false` | `Admin` を画面のログインが無効のグループへ加え、乱数のパスワードにする。`zabbix_web_api_token` が必須 |
| `zabbix_web_saml_enabled` | `false` | SAML を収束させる。`zabbix_web_api_token`（初回の bootstrap だけは `zabbix_web_admin_password`）が必須 |
| `zabbix_web_saml_public_url` | `""` | 公開 URL。`https://`、末尾 `/`、クエリ・断片なし（例 `https://zabbix.example.com/`） |
| `zabbix_web_saml_idp_entityid` | `""` | IdP の entity ID（https の URL か URN、1024 文字以下） |
| `zabbix_web_saml_sso_url` / `zabbix_web_saml_slo_url` | `""` | IdP の SSO の URL（https）／SLO の URL（空か https） |
| `zabbix_web_saml_sp_entityid` | `""` | Zabbix（SP）の entity ID。IdP の登録と一致させる（1〜1024 文字の印字可能 ASCII、空白なし） |
| `zabbix_web_saml_nameid_format` | `urn:oasis:names:tc:SAML:2.0:nameid-format:persistent` | この値か `urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified` |
| `zabbix_web_saml_idp_certificates` | `[]` | IdP の署名の証明書（PEM、1〜2 件） |
| `zabbix_web_saml_sp_certificate` / `zabbix_web_saml_sp_private_key` | `""` | SP の証明書と秘密鍵（PEM、暗号化していない鍵）。両方か、どちらも空。`sign` の `authn_requests`・`logout_*` のどれかが true なら必須。秘密鍵は秘匿変数で渡す。空ならファイルを消す |
| `zabbix_web_saml_sign` | `{messages: true, assertions: true, authn_requests: false, logout_requests: false, logout_responses: false}` | 書いたキーだけが既定を上書きする（真偽値） |
| `zabbix_web_saml_username_attribute` | `username` | 利用者名の属性 |
| `zabbix_web_saml_case_sensitive` | `true` | 利用者名の大小文字を区別する |
| `zabbix_web_saml_jit` | `{enabled: false}` | JIT（下記） |
| `zabbix_web_saml_autologout` | `""` | 空でなければ、JIT の利用者の `autologout` を毎回この値にする（90s〜1d。例 `1h`） |
| `zabbix_web_saml_allow_legacy_users` | `false` | 手動の利用者の検査を外す（検証期間だけ） |
| `zabbix_web_saml_local_users` | `{mode: "", targets: [], expected_sha256: "", transfer_maps_dashboards: false}` | 既存の個人の利用者の 1 回だけの手続き（下記） |

`zabbix_web_saml_jit` のキー:

| キー | 既定 | 説明 |
|---|---|---|
| `enabled` | `false` | 初回のログインで利用者を作る |
| `group_name_attribute` / `user_name_attribute` / `user_lastname_attribute` | `groups` / `name` / `""` | グループ・名・姓の属性 |
| `deprovisioned_group` | （JIT では必須） | 役割を失った JIT の利用者を移すグループ。無ければ無効の状態で作る |
| `groups` | （JIT では 1 件以上） | `[{saml_group, role, user_groups: [名前]}]`。`saml_group` は `*` を含まない完全な名前、`role` は Super admin 以外 |
| `media` | `[]` | `[{name, mediatype, attribute}]`（任意） |

レシピの例（値は例です）:

```yaml
- ansible.builtin.include_role:
    name: zabbix_web
  vars:
    zabbix_web_db_password: "{{ ZABBIX_DB_PASSWORD }}"
    zabbix_web_api_token: "{{ ZABBIX_API_TOKEN }}"
    zabbix_web_saml_enabled: true
    zabbix_web_saml_public_url: https://zabbix.example.com/
    zabbix_web_saml_idp_entityid: https://sso.example.com/saml/metadata
    zabbix_web_saml_sso_url: https://sso.example.com/saml/sso
    zabbix_web_saml_sp_entityid: zabbix
    zabbix_web_saml_idp_certificates:
      - |
        -----BEGIN CERTIFICATE-----
        ...
        -----END CERTIFICATE-----
    zabbix_web_saml_autologout: 1h
    zabbix_web_saml_jit:
      enabled: true
      deprovisioned_group: SAML deprovisioned
      groups:
        - {saml_group: admin, role: Admin role, user_groups: [SSO admins]}
        - {saml_group: operator, role: User role, user_groups: [SSO operators]}
        - {saml_group: viewer, role: User role, user_groups: [SSO viewers]}
```

- 役割の対応の例: IdP の `admin` → Admin role、`operator` → User role（ホストグループに読み書きの権限を持つ
  グループ）、`viewer` → User role（読み取りの権限だけのグループ）。権限はユーザーグループで決まるので、
  対応に書くグループは事前に画面か API で作ってください。
- `autologout`: JIT で作られた利用者の既定は 15m です。ロールは実行のたびに SAML の userdirectory の利用者だけを
  この値へ揃えます（内部の利用者には触れません）。新しく JIT で作られた利用者は、次のロールの実行までは 15m のままです。
  JIT の利用者は API で利用者名・役割・グループ・パスワードを変えられないため、すぐ止めるには利用者の削除（下記）が要ります。
- SAML を無効に戻すとき（`zabbix_web_saml_enabled: false`、`zabbix_web_api_token` あり）は `saml_auth_enabled` を 0 に
  するだけで、userdirectory・利用者は消しません。`zabbix_web_api_token` を指定している間は、このロールが SAML の
  オン・オフを管理します（画面で SAML を有効にしていても、`zabbix_web_saml_enabled: false` なら無効にします）。

### 導入の順番

1. **サービス用の利用者の bootstrap（1 回だけ）:** `zabbix_web_saml_enabled: true` と SAML の変数、`zabbix_web_admin_password`
   を指定し、`zabbix_web_api_token` は空で実行します。ヘルパーは `Admin` で 127.0.0.1 の API に入り、
   - 画面のログインを無効にしたグループ `AI support automation (API only)`
   - そのグループだけに属し、Super admin role を持つ**パスワード無し**の利用者 `ai-support-automation`
     （画面が無効のグループだけに属する利用者はパスワード無しで作れ、API の `user.login` の経路も無い）
   - その利用者の API トークン
   を作り、トークンを一度だけ `/var/lib/ai-support-zabbix/service-user-token`（root、0600）に書き、DB のグローバル
   マクロ `{$AI_SUPPORT_SERVICE_USER_DONE}` を印にします。**この実行は意図的に失敗で止まり、SAML は設定しません。**
   トークンを ANSIBLE# の秘匿変数（例 `ZABBIX_API_TOKEN`）へ移し、ファイルを消してください。
   印がある状態でトークン無しで実行すると「Set zabbix_web_api_token (bootstrap is done)」で失敗します。
   途中で失敗した bootstrap は、トークンファイルを消してから再実行すると、読み戻せないトークンを作り直して続きから行います。
2. **SAML の設定:** `zabbix_web_api_token` を指定して実行します。以後ヘルパーは `Admin` でログインしません。
   IdP の検証期間は `zabbix_web_saml_allow_legacy_users: true` で実行できます。
3. **既存の個人の利用者の 1 回だけの手続き**（下記）で、email の名前の内部の利用者を消します。
4. `zabbix_web_saml_allow_legacy_users` を `false` に戻して実行し、手動の利用者の検査が通ることを確かめます。
5. **`Admin` の処置:** `zabbix_web_admin_lockdown: true` で実行します。`Admin` を画面のログインが無効のグループに
   加え（`Zabbix administrators` などのグループ自体は変えない）、誰にも渡さない乱数のパスワードにします
   （画面が無効でも API の `user.login` は通るため、乱数のパスワードは必須です）。`Admin` が既にそのグループに
   いれば何もしません。`zabbix_web_admin_password` は以後使いません（レシピから外してください）。

Super admin は `ai-support-automation` と（使えない）`Admin` だけになり、SSO では渡りません。

### 既存の個人の利用者の 1 回だけの手続き

`zabbix_web_saml_local_users` に、対象の利用者名の**明示の一覧**と、その hash を書きます。

```yaml
zabbix_web_saml_local_users:
  mode: delete            # delete（削除）か scramble（乱数のパスワード）
  targets: [alice@example.com, bob@example.com]
  expected_sha256: <下のコマンドの出力>
```

`expected_sha256` は、`targets` を**バイト順**で並べて改行で結合した（末尾の改行なし）UTF-8 の sha256 です。
macOS と Linux で同じ結果になるよう、shell の `sort` は使わず次のコマンドで計算します。

```sh
python3 -c 'import hashlib,sys; print(hashlib.sha256("\n".join(sorted(sys.argv[1:], key=lambda s: s.encode())).encode()).hexdigest())' alice@example.com bob@example.com
```

- `targets` は 1〜200 件、各 1〜100 文字の印字可能 ASCII（空白なし）、重複なし。`Admin` と `ai-support-automation`
  は（大小文字に関わらず）含められません。hash が合わなければ何も変えずに失敗します（書き間違いの防止）。
- 見つかった利用者名の集合が `targets` と**大小文字まで**一致しなければ、何も変えずに失敗します（MySQL の照合順序は
  大小文字を区別しないことがあるため）。`delete` で 1 人も見つからなければ完了とみなし、印だけを作ります。
- 処理の順は「この手続き → 手動の利用者の検査 → SAML の有効化」です。
- 完了すると DB のグローバルマクロ `{$AI_SUPPORT_SAML_LOCAL_USERS_DONE}`（値 `<expected_sha256>:<mode>`）を印にし、
  ホストにも目印 `/var/lib/ai-support-zabbix/saml-local-users.done` を置きます（判定は DB の印だけで行うので、
  作り直したホストや同じ DB の別のフロントエンドでも繰り返されません）。印と同じ指定なら何もしません。
  印と違う指定なら何も変えずに失敗します（前回と別の手続きを黙って重ねない）。
- **完了後は `mode` を `""` に戻してください**（以後この手続きの API 呼び出し自体が起きません）。
- `scramble` は 1 人ずつ乱数のパスワードにします（値はどこにも出しません）。途中で失敗すると印は作らず、処理済みの件数を出します。
  次の実行は見つかった名前の不一致で止まるので、`targets` を残りに直して `expected_sha256` を作り直してください。
- **所有物（`delete`）:** Zabbix は所有物のある利用者の削除を全体ごと拒否します。ヘルパーは削除の前に数えます。
  - マップ・ダッシュボード: `transfer_maps_dashboards: true` のときだけサービス用の利用者へ移してから削除します（既定は失敗）。
  - 定期レポート（持ち主・受信者）: 移しません。削除するか、**同じかより狭い権限の人**へ移してください
    （「Generate report by: current user」では持ち主の権限でデータが作られるので、サービス用の利用者・`Admin` へは移さない）。
  - アクションの送信先: 移しません。その利用者を送信先から外し、代わりの送信先はアクションの持ち主が選んでください
    （サービス用の利用者に替えると通知が黙って消えます）。
  - 定期レポートかアクションの送信先が残っていれば、何も変えずに件数を出して失敗します。
- Super admin role の利用者を消すには、画面の使える有効な Super admin role の利用者がほかに 1 人要ります
  （`Admin` の処置の前に行ってください）。
- 削除した利用者は戻りません。実行の前に利用者の一覧（名前・グループ・所有物）を退避してください。

### 利用者をすぐ止める（急ぐ失効）

JIT の利用者のセッションは IdP では切れず、`autologout` か削除まで続きます。すぐ止めるには削除します。

1. 所有物を読む（読み取りだけ）。トークンはコマンド引数・環境変数に載せず、root 専用のヘッダファイル
   （`Authorization: Bearer <token>` の 1 行、0600）を `curl -H @<ファイル>` で渡します。

   ```sh
   api() { curl -s -H 'Content-Type: application/json-rpc' -H @/root/zabbix-api-header \
     --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" http://127.0.0.1:8080/api_jsonrpc.php; }
   api user.get '{"output":["userid","username"],"filter":{"username":"alice@example.com"}}'
   api map.get '{"output":["sysmapid","name"],"userids":["<userid>"]}'
   api dashboard.get '{"output":["dashboardid","name"],"filter":{"userid":"<userid>"}}'
   api report.get '{"output":["reportid","name","userid"],"selectUsers":"extend"}'
   api action.get '{"output":["actionid","name"],"selectOperations":"extend","selectRecoveryOperations":"extend","selectUpdateOperations":"extend"}'
   ```

2. 所有物を処理する: マップとダッシュボードだけはサービス用の利用者へ移してよい（`map.update`・`dashboard.update`
   の `userid`）。定期レポートとアクションの送信先は上の「所有物」のとおりに扱う。
3. `user.delete`。開いていた画面のセッションは直後に無効になります。次のログインで JIT が新しい利用者として作り直します
   （そのとき `autologout` は 15m に戻り、次のロールの実行で揃います）。

### 証明書の交換

1. 新しい IdP の証明書を `zabbix_web_saml_idp_certificates` の 2 件目に足して実行する（新旧どちらの署名も通る）。
2. IdP の署名の鍵を新しいものへ切り替える。
3. 古い証明書を外して（新しいものを 1 件目にして）実行する。

### break-glass（IdP の障害時）

パスワードのログインの経路は常設しません。IdP が使えないときだけ、break-glass 用の SSH の鍵と API トークンを
持つ人（持ち主だけが持つ。ほかの人には渡さない）が次の手順で行います。

1. 作業記録を始める（開始時刻）。
2. SSH のポート転送で上流のポート（`zabbix_web_listen_port`）へつなぐ（前段の CDN・WAF を通らない）。
3. API トークンは手元の写しから、サーバーの root だけが読める一時ファイル（0600）に置いて使い、作業の最後に消す
   （コマンド引数・環境変数に載せない。上の `curl -H @<ファイル>` の形）。
4. **SAML を無効にするのは必要なときだけ:** `authentication.update {"saml_auth_enabled": 0}`。
5. 一時の内部の利用者を作る: 名前は `breakglass-<日付>`（**`@` を含めない**）、必要な最小の役割で、
   **Super admin role は使わない**（Super admin role の利用者を消すには画面の使える有効な Super admin が
   ほかに要りますが、`Admin` とサービス用の利用者は画面が無効なので消せなくなります）。Super admin の作業は画面ではなく
   API トークンで行う。パスワードは乱数でその場だけ使う。
6. Zabbix の利用者には期限が無いので、作業の終わりに一時の利用者を削除し、記録の終了時刻と Zabbix の監査ログの
   削除の時刻を照合する。4 をした場合は SAML を戻し（`saml_auth_enabled: 1`、またはロールの再実行）、一時ファイルを消し、
   監査ログを記録に写す。

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

DBを使わない版別の単体試験（8.0 のSQLスクリプトのパス、`settings`による初期データ確認と`db_extension`の読み方、
`dbversion` の範囲で 7.2/7.4・8.2 の DB を拒否すること）も`tests/test_zabbix_database.py`に含まれ、専用DBなしで実行されます。

`tests/test_zabbix_api.py`は管理者パスワード・ハウスキーピングのヘルパーを、6.0（本文の`auth`）と
7.0/8.0（`Authorization: Bearer`）を模した偽のJSON-RPCサーバーに向けて実行します。外部環境は不要です。
全ケースで、出力にパスワードとトークン（平文・Base64）が無いことも確認します。

```sh
python3 ansible/tests/test_zabbix_api.py -v
```

SAML・API トークンのヘルパー（bootstrap、トークンでの実行、userdirectory・authentication の収束、手動の利用者の検査、
1 回だけの手続きと DB の印、所有物、`Admin` の処置、版の下限）は `tests/test_zabbix_api_saml.py` で、同じ形の偽の
JSON-RPC サーバーに向けて試します。ロールの検査（先頭の assert）・SAML の版の下限・`zabbix.conf.php` と証明書の
生成は `tests/test_zabbix_web_saml_role.py` が ansible-playbook で実際に評価します（パッケージ・サービスには触れません）。

```sh
python3 ansible/tests/test_zabbix_api_saml.py -v
# ansible-core 2.20 の venv で。ZABBIX_TEST_LEGACY_ANSIBLE に 2.16 の ansible-playbook を渡すと 22.04/24.04 の controller も試す
python -m unittest discover -s ansible/tests -p test_zabbix_web_saml_role.py -v
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


### Ubuntu 26.04 の分岐検証

`tests/test_zabbix_platform.py` は実際のロールの初期 assert と repository/PHP の
Jinja テンプレートを `ansible-playbook` で評価します。パッケージ・サービスは変更しません。
対応 controller と旧 controller を別々の venv に用意して実行します。

```sh
# 現在の PATH は ansible-core 2.20 以降の venv
ZABBIX_TEST_LEGACY_ANSIBLE=/path/to/ansible-2.16/bin/ansible-playbook \
  python -m unittest discover -s ansible/tests -p test_zabbix_platform.py -v
```

22.04/24.04 の継続受理、26.04 の受理、旧 controller・6.0・TimescaleDB の拒否、
既存パッチの下限と resolute/PHP 8.5 の選択を確認します。
8.0 については、26.04 での受理と 22.04/24.04 での拒否、epoch を含む導入後の版検証
（`1:8.0.0` や `2:7.0.32` を拒否）、8.0 のリポジトリ URI・release パッケージ URL（amd64/arm64 とも同じ）、
`zabbix-unstable.sources` の確認タスク、UI のルート（`/usr/share/zabbix/ui`）と `api/` の拒否、
`zabbix_web_listen_address` の入力検証と Nginx テンプレートの `listen` 行を確認します。
実ホストの構築成功はこの検証とは別に `tests/zabbix-native.yml` で確認してください。
8.0 の実機検証の記録は `tests/ZABBIX-2604-VALIDATION.md` にあります。
