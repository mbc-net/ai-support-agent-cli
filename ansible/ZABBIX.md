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

Serverの10051番、Webの8080番は、このロールではファイアウォールを開放しません。
別途許可元を限定してください。外部公開する管理画面はTLS終端を用意し、初期ログイン後に
Zabbix管理者パスワードを変更してください。
Serverの起動確認ではTCP接続だけでなく、ループバックから統計リクエストへの応答とLTSを確認します。
Webはセットアップウィザードではなくログインフォームが返ることを確認します。
Web設定の更新からサービスへの反映・ログイン確認までを復元対象に含めます。
失敗時はDB接続設定、PHP-FPM設定、vhostとサービスの起動・自動起動状態を戻します。
復元後はPHP-FPMのキャッシュも更新します。成功または復元完了後に一時バックアップを削除し、
復元自体が失敗した場合は手動復旧用にroot専用のバックアップを残します。

## 開発時の検証

`tests/test_zabbix_database.py`は専用テストDBを使用します。実運用DBへ向けないでください。

```sh
ZABBIX_TEST_ENGINE=postgresql ZABBIX_TEST_PORT=15432 \
ZABBIX_TEST_PASSWORD=test-password \
ZABBIX_TEST_SCHEMA_ROOT=/path/to/official/zabbix-sql-scripts \
python -m unittest discover -s ansible/tests -v
```

MySQLは`ZABBIX_TEST_ENGINE=mysql`に切り替えます。テスト対象は
`zabbix_test` DBと`zabbix_test`ユーザーです。テストはそのDBのテーブルを削除します。
公式SQLパッケージがない場合、その全体投入テストはスキップされます。

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
