# MBC SSO の割り当ての同期（PULL）の実機相当検証

2026-11-14。作業ブランチ `feat/zabbix-mbc-pull`（PR #904）。ベース: `a540223`。
本番・実サーバー・実際の `https://sso.mbc-net.com`・本番の資格情報には一切接続していない。すべて手元の Mac
（Docker 29、arm64）の systemd コンテナで、本物の Zabbix をロールで構築して実施した（staging の代わり）。

## 検証環境

| 項目 | 7.0 | 8.0 |
|---|---|---|
| コンテナ | `mbcpull-zbx70`（`tests/Dockerfile.zabbix` = ubuntu:24.04） | `mbcpull-zbx80`（同じ Dockerfile の `FROM` を ubuntu:26.04 に替えたもの） |
| zabbix-frontend-php / server | `1:7.0.32-2+ubuntu24.04` | `2:8.0.0-1+ubuntu26.04` |
| nginx / PHP-FPM / PostgreSQL | 1.24.0-2ubuntu7.19 / 8.3.6 / 16.15 | 1.28.3-2ubuntu1.12 / 8.5.4 / 18.6 |
| Python / systemd | 3.12.3 / 255 | 3.14 / 259 |
| ansible-core（コンテナ内 venv） | 2.20.11（community.postgresql 4.x、ansible.mysql 5.x） | 同じ |

- 起動: `docker run -d --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --add-host sso.mbc-net.com:127.0.10.1 -v <repo>/ansible:/work/ansible:ro <image>`
  （`ZABBIX.md`「開発時の検証」と同じ。ホストの `/sys/fs/cgroup` は共有しない）。`getent hosts sso.mbc-net.com` が `127.0.10.1` であることを最初に確認した。
- **偽の PULL の API**: コンテナ内の systemd unit `fake-pull`（Python の `http.server` + TLS、`127.0.10.1:443`）。
  `/pull/v1/applications/zabbix-test/assignments` だけに `/srv/pull/{status,ctype,body}` の内容を返し、ほかは 404。
  要求ごとにパス・User-Agent・Bearer の先頭（keyId）だけを記録する。サーバー証明書（SAN `sso.mbc-net.com`）は
  使い捨ての CA で署名し、その CA を `update-ca-certificates` でコンテナに信頼させた（スクリプトの
  `ssl.create_default_context()` がそのまま検証する）。
- **SAML**: IdP の証明書は自己署名（ログインはしない）。JIT 有効、`deprovisioned_group: MBC deprovisioned`、
  対応 `viewer → MBC viewer role / MBC viewers`、`operator → MBC operator role / MBC operators`
  （役割は API で事前に作成。`api.access: 0`、`manage_api_tokens` 無効）。`zabbix_web_saml_user_groups` で 2 グループを収束。
- **同期**: `zabbix_web_mbc_pull: {enabled: true, url: https://sso.mbc-net.com, application_id: zabbix-test, interval: 120, scim_port: 18080}`、
  鍵は形式どおりの使い捨ての値（`k` + 24 桁 16 進 `.` 43 文字 base64url）。
- **利用者**: 実 IdP の代わりに Zabbix 自身の SCIM（`127.0.0.1:18080`、サービス用の利用者の API トークン）で
  `POST /Users` を 4 人（`alice/bob/dave+mbcawssso@example.com`、`carol+mbclocal@example.com`）、`POST /Groups`
  で `viewer`（alice, bob, dave）・`operator`（carol）を作った。4 人とも SAML の userdirectory（`userdirectoryid=1`）に属し、
  JIT と同じく対応から役割・グループが計算された。ほかに内部の利用者 `localuser`、`Admin`、`ai-support-automation`。

実行コマンド（コンテナ内、`/work2` に検証用の playbook とシェルを置いた。リポジトリには含めない）:

```sh
cd /work2; R="ANSIBLE_ROLES_PATH=/work/ansible/roles /opt/ansible/bin/ansible-playbook -i localhost, site.yml -e zver=7.0"
# site.yml: hosts localhost / connection local / become、roles zabbix_server・zabbix_web、上記の変数
$R -e phase=base                                   # SAML なし、Admin のパスワード指定
$R -e phase=saml                                   # bootstrap（意図した失敗。service-user-token を取り出す）
$R -e phase=saml -e zabbix_web_api_token=<token>   # SAML + JIT（同期なし）→ vhost を vhost-never-enabled.conf に保存
$R -e phase=saml -e zabbix_web_api_token=<token> -e pull_enabled=true
# 各シナリオ: /srv/pull/{status,ctype,body} を書き換え、
systemctl reset-failed ai-support-zabbix-mbc-pull.service; systemctl start ai-support-zabbix-mbc-pull.service
journalctl -u ai-support-zabbix-mbc-pull -o cat     # と、user.get（role・usrgrps）の比較
$R -e phase=saml -e zabbix_web_api_token=<token> -e pull_enabled=false
```

8.0 は同じ手順を 1 本のスクリプト（`flow.sh 8.0`）で新しいコンテナに対して実行した。

## 結果

| # | 確認 | 7.0 | 8.0 | 根拠 |
|---|---|---|---|---|
| 1 | ロールの収束（base / bootstrap / SAML / 同期 有効） | 合格 | 合格 | 7.0: `ok=79 changed=17 failed=0`（有効化）。bootstrap は想定どおり rc=2 でトークンを 0600 で出力 |
| 2 | nginx の設定・待受 | 合格 | 合格 | `nginx -t` 成功。`127.0.0.1:18080` と `0.0.0.0:8080` のみ。コンテナの eth0 の `:18080` は接続不可（000） |
| 3 | SCIM 専用 server の PATH_INFO | 合格 | 合格 | `GET http://127.0.0.1:18080/api_scim.php/Users` が本物の SCIM の 200（ListResponse）。`/index.php`・`/api_jsonrpc.php` は 404 |
| 4 | 画面のポートに SCIM が無いこと | **不合格→修正** | **不合格→修正** | `/api_scim.php/Users` は 404 だったが、`/api_scim.php` に要求ヘッダー `Path-Info: /Users` を付けると eth0 経由でも SCIM が 200 を返した（下記「不具合」）。修正後は 404（`//api_scim.php`・`/./api_scim.php`・`/api_scim%2Ephp`・クエリ付きも 404、`/index.php` は 200） |
| 5 | 役割の変更（viewer → operator、どちらも対応あり） | 合格 | 合格 | bob が `MBC operator role / MBC operators`。access.log の順は `PATCH Users/8`（無効化）→ `PATCH Groups/2`（operator に追加）→ `PATCH Groups/1`（viewer から削除）＝追加が先 |
| 6 | 応答に無い人の無効化 | 合格 | 合格 | dave が `role=0`、グループは `MBC deprovisioned` だけ。userid 8 のまま（削除されない） |
| 7 | 再び現れた人の復帰 | 合格 | 合格 | `restore: 1`、dave が `MBC viewer role / MBC viewers` に戻る（同じ userid） |
| 8 | 冪等 | 合格 | 合格 | 同じ応答の 2 回目は `changed: false`、`scim_writes: 0`、`already_deprovisioned: 1` |
| 9 | SAML 以外・Admin・サービス用の利用者に触れない | 合格 | 合格 | 全シナリオで `localuser`・`Admin`・`ai-support-automation` の役割・グループが不変（userdirectory 0 なので `managed` に入らない） |
| 10 | 安全の上限 | 合格 | 合格 | `users: []`（4 人中 4 人）と alice だけ（4 人中 3 人）は終了コード 6、利用者不変、SCIM の書き込み 0。ちょうど半分（4 人中 2 人）は適用された（7.0） |
| 11 | 200 以外・形の違う応答 | 合格 | 合格（401・重複のみ） | 401・429・503・302、`text/html`、JSON でない、`applicationId` 違い、`generatedAt` 無し、大文字の subject、`+mbc…` の無い subject、空の roles、重複 subject、users がオブジェクト、未信頼の証明書（`SSLCertVerificationError`）、接続拒否（`ConnectionRefusedError`）: すべて終了コード 5・「Nothing was changed.」。nginx の access.log に同期からの要求なし（Zabbix に接続しない）、SCIM の書き込み数不変 |
| 12 | その他の計画 | 合格 | — | 未作成の人（frank）は `not_provisioned: 1` だけ。対応に無い役割だけの人（bob: `auditor`）は無効化され `unmapped_roles_only: 1`。複数の役割（carol: viewer+operator）は両方のグループと種類の高い `MBC operator role` |
| 13 | ログに識別子・秘密が無いこと | 合格 | 合格 | journal 全体（7.0 は 200 行）に `example.com`・`mbcawssso`・`mbclocal`・利用者名・鍵の secret・API トークン・`Bearer`・`Authorization`・userid の 0 件。出るのは件数・`applicationId`・`keyId` だけ |
| 14 | `ProtectSystem=strict` + `ReadWritePaths` | 合格 | 合格 | unit のまま実行して `/var/lib/ai-support-zabbix/mbc-pull.state` が `root 0600` で書かれ、更新され続けた（salt 32 文字、hash 6 件） |
| 15 | `reapplied` | 合格 | 合格 | 24 時間以内に同じ人の同じ無効化・復帰を繰り返した回で `reapplied: 1` と警告文。初回・冪等の回は 0 |
| 16 | timer | 合格 | 合格 | `systemctl list-timers` に次回が出る。停止して再開した後、約 2 分 20 秒後に timer から自動で 1 回動き、偽の API に keyId 付きの要求が届いた |
| 17 | 無効に戻す（`enabled: false`） | 合格 | 合格 | 7.0: `ok=78 changed=14 failed=0`。unit・スクリプト・設定・鍵・状態のファイルが消え、timer の unit が無い。`scim_status` 0。`127.0.0.1:18080` の待受が消えた。vhost は同期を一度も有効にしていない時の出力と `diff` で一致（md5 `3672a9c8…`）。SCIM の利用者は変えない |

全体のテスト: `PATH=<venv>/bin:$PATH python -m pytest -q ansible/tests` → 204 passed、39 skipped（Docker・DB 前提の試験）、580 subtests passed。

## 不具合と修正

**画面のポートから SCIM に届いた（修正: `e850f53`）。** Zabbix の `api_scim.php` は endpoint を `CHttpRequest` から読み、
`CHttpRequest` はサーバー変数 `PATH_INFO` と利用者が送る要求ヘッダー `Path-Info`（`HTTP_PATH_INFO`）を同じ
`PATH-INFO` のキーにする（7.0.32・8.0.0 とも同じ実装）。そのため同期を有効にして `scim_status` が 1 の間は、
画面・API の server（`zabbix_web_listen_port`）の `location ~ \.php$` が `/api_scim.php` を PHP に渡し、
`Path-Info: /Users` と API トークンで SCIM が使えた（7.0 は修正前のロールで、8.0 は同期を無効にした vhost に
`scim_status` を 1 にして再現。どちらも 200）。PR の「画面のポートには SCIM を出さない」「前段のプロキシは SCIM に届かない」
が成り立っていなかった。必要なのは Super admin の API トークンなので影響は限定的だが、loopback だけの別の server にした意味が失われる。

修正: 同期が有効なときだけ、画面の server に `location = /api_scim.php { return 404; }` を足した（無効のときの vhost は
従来とバイト単位で同じまま）。`test_zabbix_web_saml_role.py` の vhost の試験を更新（修正前のテンプレートで失敗することを確認）し、
`ZABBIX.md` に理由を追記。修正後のロールで 7.0・8.0 とも再収束し、上の表 #4 のとおり 404 になることを確認した。

## 補足の観察（不具合ではない）

- 起動から 3 分を過ぎたホストで同期を有効にした（timer の unit を書き換えた）実行では、`OnBootSec=3min` が過ぎているため
  timer の開始直後に 1 回動く（7.0・8.0 とも、有効化の直後に偽の API へ 1 回要求が届いた）。`ZABBIX.md` の
  「周期と負荷」に追記した。
- 手で `systemctl start` を 10 秒に 5 回を超えて失敗させると systemd の既定の `StartLimitBurst` で
  「Start request repeated too quickly」になる（検証では `systemctl reset-failed` を挟んだ）。120 秒以上の timer では起きない。
- `reapplied` は、MBC 側で同じ人を 24 時間以内に外して戻した正当な操作でも 1 になる（仕様どおり。警告は疑いの合図）。
- SCIM の `POST /Users` だけで作った利用者は、グループの所属が付くまで役割 0・グループ無しで、無効化用のグループにはいない。
  同期はこの人を「有効」として数える（実際の JIT のログインでは起きない状態）。
- 7.0・8.0 とも、JSON-RPC の `usergroup.update` で SAML の利用者を「Disabled」に入れることはできない
  （`cannot update readonly parameter "usrgrps" of provisioned user`）。そのため「管理者が無効にした利用者に触れない」
  （`skipped_disabled`）は実機では作れず、単体試験（`test_zabbix_mbc_pull.py`）だけで確認している。

## 未検証

- 実 IdP（MBC SSO）での SAML ログインと、ログインのたびの役割・グループの再計算（同期の変更をログインが上書きする挙動）。
  `reapplied` は同期自身の繰り返しでだけ確認した。
- 実際の `sso.mbc-net.com` の PULL の API（WAF・頻度の制限・応答時間・本物の鍵）。応答の形は偽のサーバーで `ZABBIX.md` と
  スクリプトの検査に合わせたもの。
- 同期の実行中の利用者の削除（`vanished`）、SCIM の途中の失敗（単体試験のみ）、無効化で開いている画面のセッションが切れること。
- `zabbix_web_listen_address: 127.0.0.1` の構成、前段のリバースプロキシ、ufw、amd64 の実機（KAGOYA）。
- Apache（同期は nginx のみ対応で、初期 assert が拒否する）。

生ログ（ローカル一時証跡）: コンテナ内 `/work2/run-*.log`、8.0 の一括実行の出力 `scratchpad/mbcpull/flow-80.log`。
コンテナ・イメージは検証後に削除した。

## レビュー後の変更（2026-11-14）

PR のレビュー（同期を無効に戻す実行では、vhost の書き換えが API での SCIM の無効化より先に行われ、API が失敗すると
SCIM が有効なまま画面のポートから届く）を受けて、画面の server の `location = /api_scim.php { return 404; }` を同期の
有効・無効に関わらず常に出すように変えた。上の #4・#17 の「無効のときの vhost は従来とバイト単位で同じ」は、この変更で
「従来の vhost にこの 404 の location だけが加わったもの」に変わる（同期を使わないホストも、次のロールの実行で nginx を
1 回 reload する）。あわせて、終了コード 0 の回の時刻を `/var/lib/ai-support-zabbix-mbc-pull/last-success` に書き、
Zabbix エージェントで古さを監視する手順を `ZABBIX.md`「同期の監視」に加えた。

