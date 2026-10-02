# Zabbixセットアップの検証記録

2026-09-30。変更は専用ブランチ`feature/zabbix-server-setup`のworktreeにあります。
コミット・マージ・デプロイは未実施です。

## 変更対象

- Agent: `agent-worktrees/zabbix-server-setup` — Server/Webロール、DB初期化・起動確認、実行ガード、CLI梱包設定、ガイドとテスト。
- API: `api-worktrees/zabbix-server-setup` — 新ロール・公開変数の許可、内部変数保護、テスト。
- Web: `web-worktrees/zabbix-server-setup` — 「監視・ログ」のServer/Webスニペットとテスト。

元のAPI worktreeにあった`prisma/dynamodbs/cqrs.json`の変更は編集していません。

## TDDの赤確認

以下を実装前に実行し、新ロール未登録、内部変数未保護、スニペット未追加、
DBヘルパー未配置により失敗することを確認しました。

```sh
# Agent
npm test -- --selectProjects unit --runInBand --testPathPatterns zabbix-server-roles
python3 -m unittest discover -s ansible/tests -v
# API
npm run test:unit -- --runInBand --testPathPattern zabbix-server-guard
# Web
npm test -- --runInBand --testPathPattern zabbix-server-snippets
```

CLI梱包も、`npm pack --dry-run --ignore-scripts --json`で開発用DBテストが
含まれる失敗を確認してから除外しました。最終成果物には新ロールと両ヘルパー・
vhostテンプレートが含まれ、開発テストやPythonキャッシュは含まれません。

## 最終検証

| 対象 | コマンド・方法 | 結果 |
|---|---|---|
| Agent | `npm test -- --selectProjects unit --runInBand --testPathPatterns '__tests__/server-setup/'` | 22スイート・868件成功 |
| API | `npm run test:unit -- --runInBand --testPathPattern 'src/server-setup/'` | 32スイート・807件成功 |
| Web | `npm test -- --runInBand --testPathPattern 'src/.*(server-setup\|recipe-)'` | 41スイート・852件成功 |
| DB | `test_zabbix_database.py`を専用PostgreSQL 16/MySQL 8.0で実行 | 各9件成功 |
| Agent/APIビルド | `npm run build` / `npm run build:prod` | 成功 |
| Web型・ビルド | `npx tsc --noEmit` / `npm run build` | 成功 |
| Ansible | yamllint、ansible-lint（offline/basic） | エラーなし。既存規約のタスク名、become等の警告あり |
| 梱包 | `npm pack --dry-run --ignore-scripts --json` | 必要ファイルの同梱・開発ファイル除外を確認 |
| 差分 | 各worktreeで`git diff --check` | 成功 |

DBテストでは公式7.0 SQLパッケージ全体の投入、再実行でのデータ保持、不完全スキーマ、
バージョン不一致、初期データ欠落、SQL途中失敗、同時実行の拒否、ロック名の長さ、
認証エラーへのパスワード非露出を確認しました。

HTTP待受やDB接続はsandbox内で制限されたため、対応する検証だけ権限を拡張して再実行しました。
WebビルドのGoogle Fonts取得もネットワーク許可後に成功しました。
テスト対象のパスには`server-setup`が含まれるため、Jestのフィルターは上記の
`__tests__/server-setup/`や`src/server-setup/`を指定します。

## 実サービス検証

systemd付きUbuntu 24.04 ARM64コンテナで`zabbix-native.yml`を実行しました。

| LTS | DB | Web | 結果 |
|---|---|---|---|
| 7.0 | ローカルPostgreSQL | Nginx | 成功 |
| 7.0 | ローカルMySQL | Apache | 成功 |
| 7.0 | 外部PostgreSQL | Nginx | 成功 |
| 7.0 | 外部MySQL | Nginx | 成功 |
| 6.0 | ローカルPostgreSQL | Nginx | 成功 |

各経路でサービス起動、統計プロトコル応答、ログイン画面、再実行、既存サイトの応答維持、
停止・無効化したPHP/Webサービスの復旧を確認しました。
ローカル構成は引用符・バックスラッシュ・コロンを含むパスワードでも確認しています。
PostgreSQLの最終コードは`-vvv`でも実行し、平文・Base64のどちらのパスワードも
ログに含まれないことを確認しました。

`zabbix-validation.yml`の15件（null、真偽値、改行、無効な分岐・ポート等）は
初期assertで拒否され、変更0・失敗0・意図したrescue 15件となりました。

## レビューと修正

実行検証とコードレビューを反復し、以下を修正しました。

- ARM64公式リポジトリの選択と既存リポジトリ設定の更新。
- 特殊文字を含むパスワードのPHP設定生成。構文確認も書き込み前に実施。
- 共有リポジトリを変更する前のServer/Web LTS互換性確認。
- MySQL関数作成設定の復元と、再実行時の不要な変更の抑制。
- MySQLの最終SQLで失敗した場合も残る投入マーカー。
- 内部変数の保護、DB同時実行、長いDB名のロック対応、PostgreSQL publicスキーマの明示。
- PHPタイムゾーンの認識確認と、値の末尾改行も拒否する検証。

レビュー3巡の最終判定: CRITICAL/HIGHの指摘と未解決の検証失敗なし。

## 未実行・残る制約

- 標準VMでのSSH実行、Ubuntu 22.04、x86_64、全LTS×DB×Webの全組合せは未検証です。
  対応設定を実装しましたが、本番導入前の環境別確認は必要です。
- リポジトリ全体の全テスト・全Moleculeシナリオ・全体カバレッジは未実行です。
  変更範囲の関連テストと、専用DB・実サービス検証を実行しました。
- DBのLTS変更、Webサーバー種別の移行、ファイアウォール開放、TLS終端、
  監視対象のホスト登録は自動化の対象外です。手順・制約は`../ZABBIX.md`に記載しました。

## Web rollback regression

`test_zabbix_web_rollback.py` uses the provisioned, isolated Ubuntu 24.04 PostgreSQL/nginx container `zabbix-native-test-pg-isolated`. The test begins with a working login and checks three failure paths:

- Invalid nginx configuration before service activation.
- A wrong DB password detected by the HTTP login check after service activation.
- An occupied nginx port causing startup failure when PHP/nginx were originally stopped and disabled.

It verifies file contents, permissions and ownership for the frontend DB config, PHP-FPM pool and vhost; recovery of the original login and port for running services; restoration of stopped/disabled services; and removal of private backups after successful rollback. It exercises real service changes without handler stubs. Ordinary unittest discovery skips these fixture-dependent tests; direct invocation or `ZABBIX_TEST_WEB_ROLLBACK=1` explicitly enables them. Run with a Python environment containing PyYAML and Docker access:

```sh
python ansible/tests/test_zabbix_web_rollback.py
```

The HTTP regression failed before this fix because the DB config remained overwritten. Configuration updates, service activation and the login check now share one rollback block. Backups are removed only after successful setup or completed rollback; if rollback itself fails, root-only backups remain for manual recovery. Backups use the full path hash to avoid collisions between the same-named PHP pool and vhost files. Apache and other OS/database combinations are not covered by this regression fixture.
