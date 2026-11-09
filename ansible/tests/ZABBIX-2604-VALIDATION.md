# Ubuntu 26.04 Zabbix ロール検証

作業ブランチ: `feature/zabbix-rebuild-2604`。ベース: `6b24b48d64325b14a3571006a113b0cbefdc900f`。
本番デプロイ・コミットは未実施。最新の記録は 2026-11-08（Zabbix 8.0 対応）で、
2026-11-03〜04 の Zabbix 7.0 の記録は末尾の「過去の記録」に残す。

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
