import { existsSync, readFileSync, readdirSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

/**
 * Phase 1 の監視・ログ系 bundled role（rsyslog_server / rsyslog_forward /
 * zabbix_agent）の静的検証。
 *
 * ロール内部タスクは信頼済み同梱コードのため body ガード（`validateAnsibleTasks`）の
 * 対象外であり、YAML の妥当性以外は誰も検査しない。一方でこの 3 ロールが守るべき性質の
 * 多くは「壊れても失敗せず、黙って間違ったまま動く」種類のものである（設計書
 * admin-docs docs/specifications/server-setup-monitoring-app-roles.md §7.1）。
 *
 * ここで検証するのは、そういう**サイレント障害を防ぐために置いた仕掛けが実際に残っているか**
 * であって、Ansible の実行結果ではない。実挙動は Molecule シナリオ（rsyslog 2本）と
 * 実 VM 手動検証（zabbix_agent）が担当する。
 *
 * 注意: 本 spec は「書いてあること」しか確認できない。書いてあるが効いていない、という
 * 失敗は Molecule 側で捕まえる（設計書 §7.1 の warning 参照）。
 */

type Task = Record<string, unknown>

const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')

function loadYaml(...segments: string[]): unknown {
  return load(readFileSync(path.join(rolesDir, ...segments), 'utf8'))
}

function loadTasks(role: string, file = 'main.yml'): Task[] {
  const tasks = loadYaml(role, 'tasks', file)
  expect(Array.isArray(tasks)).toBe(true)
  return tasks as Task[]
}

function readRaw(role: string, ...segments: string[]): string {
  return readFileSync(path.join(rolesDir, role, ...segments), 'utf8')
}

/** タスクが使っているモジュール名（`name`/`when` 等の制御キーを除いた最初のキー）。 */
function moduleOf(task: Task): string | undefined {
  const control = new Set([
    'name', 'when', 'become', 'become_user', 'register', 'loop', 'with_items',
    'notify', 'tags', 'vars', 'changed_when', 'failed_when', 'ignore_errors',
    'no_log', 'until', 'retries', 'delay', 'block', 'rescue', 'always', 'args',
    'environment', 'delegate_to', 'run_once', 'check_mode', 'listen',
  ])
  return Object.keys(task).find((k) => !control.has(k))
}

/** block/rescue/always を含めてタスクを再帰的に平坦化する。 */
function flatten(tasks: Task[]): Task[] {
  return tasks.flatMap((t) => {
    const nested = ['block', 'rescue', 'always']
      .flatMap((k) => (Array.isArray(t[k]) ? flatten(t[k] as Task[]) : []))
    return [t, ...nested]
  })
}

describe('Phase 1 監視・ログ系ロール（rsyslog_server / rsyslog_forward / zabbix_agent）', () => {
  const roles = ['rsyslog_server', 'rsyslog_forward', 'zabbix_agent']

  describe.each(roles)('%s: 全ロール共通の不変条件', (role) => {
    it('tasks/main.yml と defaults/main.yml が YAML としてパースできる', () => {
      expect(loadTasks(role).length).toBeGreaterThan(0)
      expect(loadYaml(role, 'defaults', 'main.yml')).toBeTruthy()
    })

    it('分岐変数の assert に when: が付いていない（未定義値が assert ごとスキップされるのを防ぐ）', () => {
      // 既存 database ロールの assert は `when: db_type is defined` 付きで、
      // 変数未定義時は assert 自体がスキップされ、後続タスクも when に一致せず
      // 全スキップのまま exit 0 になる（何も構築していないのに「成功」）。
      // 新規ロールではこの穴を作らないことを構造として固定する。
      const asserts = flatten(loadTasks(role))
        .filter((t) => moduleOf(t) === 'ansible.builtin.assert')
      expect(asserts.length).toBeGreaterThan(0)

      const validation = asserts.filter((t) =>
        String(t.name ?? '').includes('Validate'),
      )
      expect(validation.length).toBeGreaterThan(0)
      // 入力そのものを検証する assert は無条件に実行されなければならない。
      // （PSK の相互検証のように「その機能を使うときだけ」の assert は
      //   when: を持ってよいので、名前で対象を絞る。）
      const unconditional = validation.filter((t) => t.when === undefined)
      expect(unconditional.length).toBeGreaterThan(0)
    })

    it('copy モジュールに no_log を付けていない（失敗理由だけが消えるため）', () => {
      // `copy` の `content` はモジュール自身の argument spec で秘匿されるため、
      // task レベルの no_log は秘匿性を一切上げない。一方で失敗すると結果全体が
      // censored に置き換わり、パス誤り・権限不足・ディスク枯渇の区別がつかなくなる。
      const copies = flatten(loadTasks(role))
        .filter((t) => moduleOf(t) === 'ansible.builtin.copy')
      copies.forEach((t) => {
        expect(t.no_log).toBeUndefined()
      })
    })

    it('ヘルスチェックが存在し、meta: flush_handlers がそれより前にある', () => {
      // flush_handlers が無い（または後ろにある）と、再起動前の古いプロセスに対して
      // ヘルスチェックが通り、設定を直したのに直っていない状態が「成功」になる。
      //
      // 判定はタスク名ではなくモジュールで行う。名前で探すと flush_handlers 自身の
      // 「... before checking health」に一致してしまい、常に自分自身を見つけて
      // 素通りする（実際にこの spec の初版がその状態だった）。
      const tasks = flatten(loadTasks(role))
      const flushIdx = tasks.findIndex(
        (t) => t['ansible.builtin.meta'] === 'flush_handlers',
      )
      expect(flushIdx).toBeGreaterThanOrEqual(0)

      const isHealthCheck = (t: Task): boolean => {
        if (moduleOf(t) === 'ansible.builtin.wait_for') return true
        const argv = (t['ansible.builtin.command'] as Record<string, unknown> | undefined)?.argv
        return Array.isArray(argv) && argv.includes('is-active')
      }
      const healthIdx = tasks.findIndex(isHealthCheck)
      expect(healthIdx).toBeGreaterThanOrEqual(0)
      expect(flushIdx).toBeLessThan(healthIdx)
    })

    it('no_log を付けたタスクの診断は debug ではなく fail である', () => {
      // ignore_errors と組み合わせた no_log タスクの診断が debug だと、
      // 失敗理由を表示しただけで playbook は成功終了してしまう。
      const tasks = flatten(loadTasks(role))
      tasks.forEach((t, i) => {
        if (t.no_log !== true || t.ignore_errors !== true) return
        const following = tasks.slice(i + 1, i + 4)
        const hasFail = following.some(
          (n) => moduleOf(n) === 'ansible.builtin.fail',
        )
        expect(hasFail).toBe(true)
      })
    })
  })

  describe('rsyslog_server', () => {
    it('送信元制限が fail-closed（空リストは allow_all の明示が無い限り assert で失敗する）', () => {
      const defaults = loadYaml('rsyslog_server', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults.rsyslog_server_allowed_senders).toEqual([])
      expect(defaults.rsyslog_server_allow_all_senders).toBe(false)

      const raw = readRaw('rsyslog_server', 'tasks', 'main.yml')
      // 空リスト時に通過させないことを assert の式として固定する。
      expect(raw).toMatch(/rsyslog_server_allow_all_senders \| bool\)\s*\n\s*or \(\(rsyslog_server_allowed_senders/)
    })

    it('UDP 受信は既定オフ（送達保証も送信元検証も無いため）', () => {
      const defaults = loadYaml('rsyslog_server', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults.rsyslog_server_udp_enabled).toBe(false)
      expect(defaults.rsyslog_server_tcp_enabled).toBe(true)
    })

    it('動的ログパスの HOSTNAME と programname の両方に secpath-replace を適用している', () => {
      // どちらも送信者が詐称できる値であり、片方だけでは `../` を含むホスト名で
      // log_root の外にファイル・ディレクトリを作られる。
      const tpl = readRaw('rsyslog_server', 'templates', 'remote-receiver.conf.j2')
      expect(tpl).toContain('%HOSTNAME:::secpath-replace%')
      expect(tpl).toContain('%programname:::secpath-replace%')
    })

    it('受信ログのルートは syslog 所有で作る（root 所有だと権限降格後の rsyslog が書けない）', () => {
      // Ubuntu 既定の /etc/rsyslog.conf は $PrivDropToUser syslog /
      // $PrivDropToGroup syslog を指定しており、`<log_root>/<hostname>/` を
      // mkdir するのは syslog:syslog である（adm の補助グループは降格で外れる）。
      // root 所有の 0750 にすると rsyslog はホスト別ディレクトリを作れず、
      // **リモートのメッセージを全件破棄する**。しかも rsyslogd -N1・
      // systemctl is-active・ソケット所有者照合はいずれも通るため、
      // 「起動しているのに 1 行も受け取らない」状態が成功として報告される。
      // Ubuntu 24.04 / rsyslog 8.2312.0 で再現・修正とも実測確認済み。
      const tasks = flatten(loadTasks('rsyslog_server'))
      const mkLogRoot = tasks.find(
        (t) =>
          moduleOf(t) === 'ansible.builtin.file' &&
          /log root/i.test(String(t.name ?? '')),
      )
      expect(mkLogRoot).toBeDefined()
      const args = (mkLogRoot as Record<string, unknown>)['ansible.builtin.file'] as Record<
        string,
        unknown
      >
      expect(args.state).toBe('directory')
      expect(args.owner).toBe('syslog')
      expect(args.mode).toBe('0750')
    })

    it('設定配置は validate 付きで、配置後に統合設定も検証する', () => {
      const raw = readRaw('rsyslog_server', 'tasks', 'main.yml')
      expect(raw).toContain('validate: "rsyslogd -N1 -f %s"')
      // 断片単体の validate では他断片との組み合わせ破綻を検出できないため、
      // 引数なしの rsyslogd -N1 で /etc/rsyslog.conf 全体も検証する。
      expect(raw).toMatch(/argv: \[rsyslogd, -N1\]/)
    })

    it('ロールバックは backup からの復元であり、分岐キーは changed ではなく backup_file である', () => {
      // 再実行時は「動いていた設定」を上書きしているため、失敗時に削除すると
      // 直前まで正しかった設定ごと消える。さらに template は mode/owner のみの
      // 差異でも changed を返し backup_file を返さないので、changed で分岐すると
      // 正常な既存ファイルを削除してしまう。
      const raw = readRaw('rsyslog_server', 'tasks', 'main.yml')
      expect(raw).toContain('backup: true')
      expect(raw).toContain('when: rsyslog_server_conf_result.backup_file is defined')
      expect(raw).toContain('rsyslog_server_conf_result.backup_file is not defined')
    })

    it('UDP の待受確認に wait_for を使っていない（wait_for は TCP 専用）', () => {
      const tasks = flatten(loadTasks('rsyslog_server'))
      const udpChecks = tasks.filter((t) =>
        /UDP/i.test(String(t.name ?? '')) && moduleOf(t) === 'ansible.builtin.wait_for',
      )
      expect(udpChecks).toHaveLength(0)
    })

    it('待受確認はソケットの所有プロセスが rsyslog 本体であることまで突き合わせる', () => {
      // rsyslog は listener の bind に失敗してもデーモンが動き続けるため、
      // 「ポートに繋がる」＝「rsyslog が受信している」ではない。別プロセスが
      // 先にポートを握っていると wait_for も ss のポート一致も成功してしまう。
      // MainPID と ss -p の pid= を突き合わせることで、その誤判定を消す。
      const raw = readRaw('rsyslog_server', 'tasks', 'main.yml')
      expect(raw).toContain('sport = :{{ rsyslog_server_port }}')
      expect(raw).toContain('MainPID')
      expect(raw).toContain("'pid=' ~ (rsyslog_server_main_pid.stdout | trim)")
      // ポート番号の部分一致に頼らない（`:514` は 5140 にも当たる）
      expect(raw).not.toContain('argv: [ss, -uln]')
    })
  })

  describe('rsyslog_forward', () => {
    it('ディスクアシストキューの必須項目が揃っている（queue.filename が無いと有効にならない）', () => {
      // queue.maxDiskSpace だけではメモリキューのままで、転送先ダウン中のログは
      // 黙って失われる。saveOnShutdown が off だと通常の再起動でも欠落する。
      const tpl = readRaw('rsyslog_forward', 'templates', 'forward.conf.j2')
      expect(tpl).toContain('queue.type="LinkedList"')
      expect(tpl).toContain('queue.filename=')
      expect(tpl).toContain('queue.spoolDirectory=')
      expect(tpl).toContain('queue.maxDiskSpace=')
      expect(tpl).toContain('queue.saveOnShutdown=')
      expect(tpl).toContain('action.resumeRetryCount=')

      const defaults = loadYaml('rsyslog_forward', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults.rsyslog_forward_queue_enabled).toBe(true)
      expect(defaults.rsyslog_forward_queue_save_on_shutdown).toBe(true)
      expect(defaults.rsyslog_forward_resume_retry_count).toBe(-1)

    })

    it('転送断片のファイル名がリテラルで固定され、10-remote-receiver.conf より前にソートされる', () => {
      // 順序: /etc/rsyslog.d/*.conf は辞書順に読まれ、rsyslog の `stop` は以降の
      // 評価を打ち切る。受信ロールの 10-remote-receiver.conf は stop で終わるため、
      // 転送断片がその後ろにあると 1 行も転送されない（失敗もしない）。
      // 固定する理由: 変数だと改名した際に旧断片が残り、両方が読み込まれて
      // 二重に転送・二重にキューイングされる（これも設定検証とサービス確認を通る）。
      const defaults = loadYaml('rsyslog_forward', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults).not.toHaveProperty('rsyslog_forward_conf_filename')

      const raw = readRaw('rsyslog_forward', 'tasks', 'main.yml')
      const paths = [...raw.matchAll(/\/etc\/rsyslog\.d\/([0-9]{2})-[A-Za-z0-9._-]+/g)]
      expect(paths.length).toBeGreaterThan(0)
      paths.forEach(([, prefix]) => expect(Number(prefix)).toBeLessThan(10))
    })
  })

  describe('zabbix_agent', () => {
    it('バージョンは LTS のみ許可する', () => {
      const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
      expect(raw).toContain("(zabbix_agent_version | default('')) in ['6.0', '7.0']")
    })

    it('PSK ファイルの配置だけでなく TLSConnect / TLSAccept を設定に書き込む', () => {
      // 鍵を置いただけでは暗号化は有効にならず、平文のまま黙って通信し続ける。
      const tpl = readRaw('zabbix_agent', 'templates', 'zabbix_agent.conf.j2')
      expect(tpl).toContain('TLSConnect=')
      expect(tpl).toContain('TLSAccept=')
      expect(tpl).toContain('TLSPSKIdentity=')
      expect(tpl).toContain('TLSPSKFile=')
    })

    it('暗号化を無効に戻したとき PSK ファイルを削除する', () => {
      // 退役した秘密がホスト上に残り続けるのを防ぐ。
      const tasks = flatten(loadTasks('zabbix_agent'))
      const removal = tasks.find((t) =>
        /Remove the PSK file/i.test(String(t.name ?? '')),
      )
      expect(removal).toBeTruthy()
      expect((removal as Task)['ansible.builtin.file']).toMatchObject({ state: 'absent' })
    })

    it('ufw の送信元は zabbix_agent_server とは別変数であり、IP/CIDR のみ許可する', () => {
      // zabbix_agent_server は `Server=` に書く値でホスト名も正当だが、
      // ufw はホスト名を Bad source address で拒否するため、流用するとロールごと失敗する。
      const defaults = loadYaml('zabbix_agent', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults).toHaveProperty('zabbix_agent_allowed_sources')
      expect(defaults).toHaveProperty('zabbix_agent_server')
      expect(defaults.zabbix_agent_allowed_sources).toEqual([])

      const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
      expect(raw).toContain('zabbix_agent_allowed_sources | default([])')
      expect(raw).toMatch(/item is match\('\^\[0-9\]\{1,3\}/)
      // ufw タスクが zabbix_agent_server を送信元に使っていないこと
      expect(readRaw('zabbix_agent', 'tasks', 'ufw.yml')).not.toContain('zabbix_agent_server')
    })

    it('コンテナ導入方式（install_method）を提供しない', () => {
      // コンテナ内では /proc・/sys がコンテナのものになり、ホストではなく
      // コンテナを監視した値を黙って返し続ける。
      const defaults = loadYaml('zabbix_agent', 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults).not.toHaveProperty('zabbix_agent_install_method')
    })

    it('アクティブチェックを設定したとき、ServerActive への到達性を再起動後のログで検証する', () => {
      // パッシブポートが応答していてもアクティブチェックは独立に失敗し得る
      // （アドレス誤り・PSK 不一致）。その場合サービスは active・ポートも応答する一方で
      // アクティブ項目が 1 つも収集されない。
      const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
      expect(raw).toContain('zabbix_agent_server_active | trim | length) > 0')
      expect(raw).toContain('journalctl')
      // 過去のエラー行を拾って永久に失敗しないよう、今回の起動分だけを見る
      expect(raw).toContain('_SYSTEMD_INVOCATION_ID=')
    })

    it('PSK 有効時もソケットが bind されていることを確認する', () => {
      // PSK では平文プローブが拒否されるため接続確認はできないが、
      // 「listen していて拒否している」と「そもそも起動していない」は別物であり、
      // 後者を素通りさせない。
      const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
      expect(raw).toContain('sport = :{{ zabbix_agent_listen_port }}')
    })

    it('リポジトリの取得元が実際のダウンロード URL のインラインリテラルである', () => {
      // ロール変数はレシピの task-level vars（include params）で上書きできるため、
      // 変数に入れた時点でピン留めは防御にならない。**実際に apt が読む URL** が
      // このファイル内のリテラルであることが要件。
      //
      // 以前は assert 自身の `vars:` で定義した `zabbix_agent_repo_url` を検査していたが、
      // それは決して失敗しないトートロジーで、apt タスクは無関係な別のリテラルを
      // 使っていた（＝検査は何も守っていなかった）。ここは実物を見る。
      const tasks = flatten(loadTasks('zabbix_agent'))
      const installRepo = tasks.find(
        (t) =>
          moduleOf(t) === 'ansible.builtin.apt' &&
          /repository package/i.test(String(t.name ?? '')),
      )
      expect(installRepo).toBeDefined()
      const args = (installRepo as Record<string, unknown>)['ansible.builtin.apt'] as Record<
        string,
        unknown
      >
      expect(String(args.deb)).toMatch(/^https:\/\/repo\.zabbix\.com\//)
      // URL 全体が変数で差し替えられないこと（補間は enum 検証済みの version のみ）。
      expect(String(args.deb).replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\{\{/)
      // 変数として復活していないこと。コメント行は説明のために名前を挙げるので除く。
      const withoutComments = readRaw('zabbix_agent', 'tasks', 'main.yml')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n')
      expect(withoutComments).not.toContain('zabbix_agent_repo_url')
    })
  })

  describe('ufw 収束（rsyslog_server / zabbix_agent）', () => {
    const ufwRoles = ['rsyslog_server', 'zabbix_agent']

    it.each(ufwRoles)('%s: 列挙に ufw show added を使う（status は inactive で何も列挙しない）', (role) => {
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).toContain('argv: [ufw, show, added]')
      expect(raw).not.toContain('ufw, status, numbered')
    })

    it.each(ufwRoles)('%s: 追加が削除より前にある（削除先行だと追加失敗時にルールが片方も残らない）', (role) => {
      const tasks = loadTasks(role, 'ufw.yml')
      const addIdx = tasks.findIndex((t) => /Add the desired ufw rules/i.test(String(t.name ?? '')))
      const delIdx = tasks.findIndex((t) => /Delete the stale ufw rules/i.test(String(t.name ?? '')))
      expect(addIdx).toBeGreaterThanOrEqual(0)
      expect(delIdx).toBeGreaterThanOrEqual(0)
      expect(addIdx).toBeLessThan(delIdx)
    })

    it.each(ufwRoles)('%s: 他者のコメントが付いた同一ルールを取り込まない', (role) => {
      // 同一条件のルールに別コメントで追加すると ufw が既存コメントを上書きし、
      // 利用者のルールがこのロールの管理下に入って後で削除されてしまう。
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).toContain(`reject('search', "comment 'ai-support-agent:${role}'$")`)
    })

    it.each(ufwRoles)('%s: 所有権の判定がコメント全体との一致である（部分一致にしない）', (role) => {
      // 部分一致だと、`ai-support-agent:<role>-backup` のように**このロールの
      // マーカーで始まるだけ**の無関係なルールまで「自分の持ち物」と判定され、
      // stale として `ufw --force delete` される。実機で再現したときに消えたのは
      // 22/tcp の SSH 許可ルールだった。
      //
      // `ufw show added` の各行は `... comment 'MARKER'` で終わる（実機で確認）。
      // よって末尾の引用符と行末 `$` まで含めて一致させる。この構造テストだけでは
      // 「アンカーが書かれていること」しか見えないため、実際に囮ルールが生き残る
      // ことは Molecule シナリオ（rsyslog_server）の verify で確認している。
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      const anchored = `"comment 'ai-support-agent:${role}'$"`
      // select（stale 計算）と reject（他者ルールの取り込み防止）の両方で使うこと。
      expect(raw.split(anchored).length - 1).toBeGreaterThanOrEqual(2)
      // 素の部分一致が残っていないこと。
      expect(raw).not.toContain(`'ai-support-agent:${role}' | regex_escape`)
    })

    it.each(ufwRoles)('%s: ロール自身が ufw を有効化しない（有効化は os_init の責務）', (role) => {
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).not.toMatch(/ufw,\s*(--force,\s*)?enable/)
    })

    it.each(ufwRoles)('%s: 削除時にコメント部分を除去する（argv にリテラルのクォートを載せない）', (role) => {
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).toContain("regex_replace(\" comment .*$\", '')")
    })

    // レビューで CRITICAL として検出された欠陥の回帰ガード。
    // rsyslog_server の stale 判定が (ポート, プロトコル) だけを比較しており、
    // 送信元を allowed_senders から削っても旧ルールが残っていた
    // （実行は成功し、削ったはずの送信元から通り続ける）。zabbix_agent 側には
    // 送信元の比較があり、兄弟経路の非対称として見逃されていた。
    it.each(ufwRoles)('%s: stale 判定が desired パターン全体（送信元・ポート・プロトコル）で行われる', (role) => {
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      // desired パターンの組み立てブロックを取り出し、3次元すべて
      // （送信元・ポート・プロトコル）が入っていることを確認する。
      const block = raw.split('_ufw_desired_patterns:')[1] ?? ''
      expect(block).toBeTruthy()
      const head = block.split('- name:')[0]
      expect(head).toMatch(/src \| regex_escape/)              // 送信元
      expect(head).toMatch(/_port \| string/)                  // ポート
      expect(head).toMatch(/proto/)                            // プロトコル
      // stale は「所有していて、かつ desired のどれにも一致しないもの」
      expect(raw).toMatch(/for pattern in \w+_ufw_desired_patterns/)
      expect(raw).toContain('keep | length == 0')
    })

    it.each(ufwRoles)('%s: 照合パターンが行頭・行末で境界付けされている（部分一致を防ぐ）', (role) => {
      // アンカー無しだと `port 514` が `port 5140` に、`10.0.0.1` が `10.0.0.10` に
      // 一致し、無関係なルールを自分のものと誤認する（残すべきものを消す／
      // 追加すべきものをスキップする）。
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).toContain("'(^|\\s)")
      expect(raw).toContain("(\\s|$)'")
    })

    it('ufw 収束はヘルスチェックの後に実行される', () => {
      // 収束を設定検証より前に置くと、検証失敗時に設定だけロールバックされ、
      // サービスは旧ポートで待ち受けているのに ufw は新ポートしか許可していない
      // 状態になる（失敗したデプロイが既存のログ収集を止める）。
      const tasks = flatten(loadTasks('rsyslog_server'))
      const healthIdx = tasks.findIndex((t) => /Verify rsyslog is active/i.test(String(t.name ?? '')))
      const ufwIdx = tasks.findIndex((t) => /Converge the firewall/i.test(String(t.name ?? '')))
      expect(healthIdx).toBeGreaterThanOrEqual(0)
      expect(ufwIdx).toBeGreaterThan(healthIdx)
    })
  })
})

describe('レシピから上書きできてはならない値（ガード迂回の防止）', () => {
  // タスクガードは include_role の変数「名」しか検証せず、値は一切見ない。
  // したがって破壊的操作のパスや所有判定の識別子を role 変数にすると、
  // 承認済みロールがそのままガードの抜け道になる。いずれもレビューで
  // CRITICAL として検出されたものの回帰ガード。

  it('ufw の所有識別子が defaults に無く、タスク内のインラインリテラルである', () => {
    // 変数だと `""` を渡すだけで `select('search','')` が全行に一致し、
    // SSH を含むホスト上の全ルールが「このロールの所有」と判定される。
    // desired が空なら、それが全部削除される（実測: 空パターンは無関係な 2/2 行に一致）。
    for (const role of ['rsyslog_server', 'zabbix_agent']) {
      const defaults = loadYaml(role, 'defaults', 'main.yml') as Record<string, unknown>
      expect(defaults).not.toHaveProperty(`${role}_ufw_comment`)

      // set_fact では守れない: レシピの include_role task-level `vars:` は
      // include params として set_fact より優先される（ansible-core で実測し、
      // 空文字を渡すと role 内の実効値が空になることを確認）。
      // したがって「変数として存在しないこと」を検証する。
      const raw = readRaw(role, 'tasks', 'ufw.yml')
      expect(raw).not.toContain(`${role}_ufw_comment`)
      expect(raw).toContain(`"comment 'ai-support-agent:${role}'$"`)
    }
  })

  it('zabbix_agent の PSK ファイルパスが defaults に無く、インラインリテラルである', () => {
    // 「暗号化を無効にしたら PSK を消す」タスクは root の file: state=absent。
    // パスが変数だと `zabbix_agent_psk_file: /etc/passwd` で任意ファイルを削除できる。
    // set_fact でも守れない（include params が勝つ）ため、変数参照そのものが
    // 存在しないことを検証する。
    const defaults = loadYaml('zabbix_agent', 'defaults', 'main.yml') as Record<string, unknown>
    expect(defaults).not.toHaveProperty('zabbix_agent_psk_file')
    for (const file of [['tasks', 'main.yml'], ['templates', 'zabbix_agent.conf.j2']]) {
      expect(readRaw('zabbix_agent', ...file)).not.toContain('zabbix_agent_psk_file')
    }
    expect(readRaw('zabbix_agent', 'tasks', 'main.yml')).toContain('/etc/zabbix/zabbix_agent.psk')
  })

  it('ロールが作成・chown する可変パスが安全な接頭辞に制限されている', () => {
    // log_root / spool ディレクトリはロールが作って所有者を変えるため、
    // 無制約だと `/etc` を渡してシステムディレクトリを奪える。
    expect(readRaw('rsyslog_server', 'tasks', 'main.yml')).toContain(
      "rsyslog_server_log_root is match('^/var/log/",
    )
    expect(readRaw('rsyslog_forward', 'tasks', 'main.yml')).toContain(
      "rsyslog_forward_queue_spool_directory is match('^/var/spool/",
    )
  })
})

describe('ログを根拠にした判定の健全性', () => {
  it('zabbix_agent はログを journald へ出す設定にしたうえで journal を読む', () => {
    // LogFile を設定したままログを journalctl で読むと、エラーはファイル側に出て
    // journal は空になり、チェックが恒常的に偽陰性になる。
    const tpl = readRaw('zabbix_agent', 'templates', 'zabbix_agent.conf.j2')
    expect(tpl).toContain('LogType=system')
    expect(tpl).not.toMatch(/^LogFile=/m)
  })

  it.each(['zabbix_agent', 'rsyslog_forward'])(
    '%s のログ検査は壁時計ではなく systemd の invocation ID で今回起動分に限定する',
    (role) => {
      // `--since '1 min ago'` は、直前の失敗を直して 1 分以内に再実行すると
      // 古いエラー行を拾って正しい設定を失敗と判定する。
      const raw = readRaw(role, 'tasks', 'main.yml')
      expect(raw).toContain('_SYSTEMD_INVOCATION_ID=')
      // コメント中の言及は許容し、argv 要素として `--since` を使っていないことを見る
      const argvLines = raw
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n')
      expect(argvLines).not.toContain('--since')
    },
  )

  it.each(['zabbix_agent', 'rsyslog_forward'])(
    '%s はログを読めなかったこと自体を失敗として扱う',
    (role) => {
      // 読めなかったのに「問題なし」と同じ扱いにすると、その障害クラスを検出できる
      // 唯一の経路が無警告で消える。片方のロールにだけ入れる非対称が本プロジェクトの
      // 定番の欠陥なので、両ロールを同じテストで回す。
      const raw = readRaw(role, 'tasks', 'main.yml')
      expect(raw).toMatch(/Fail if the .* log could not be read/)
    },
  )

  it('rsyslog_forward は転送先到達不能を失敗として扱わない', () => {
    // 集約先はセンダーより後に構築されるのが普通で、resumeRetryCount: -1 は
    // まさにそのために存在する。`'error' in stdout` だと omfwd の
    // TCPSendBuf error / action suspended を拾って健全な構成を赤くする。
    const raw = readRaw('rsyslog_forward', 'tasks', 'main.yml')
    expect(raw).not.toMatch(/'error' in rsyslog_forward_log\s*$/m)
    expect(raw).toContain('error during config processing')
  })
})

describe('パッケージ状態の収束', () => {
  it('zabbix_agent はバージョン変更が反映されるよう state: latest を使う', () => {
    // state: present だと既にインストール済みのとき何もせず、
    // 6.0 -> 7.0 の切り替えでリポジトリだけ変わって旧バイナリが残る。
    const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
    expect(raw).toMatch(/name: "\{\{ 'zabbix-agent2'[\s\S]{0,80}state: latest/)
  })

  it('zabbix_agent は variant 切り替え時に旧フレーバを停止・削除する', () => {
    // 双方が同じポートを使うため、残っていると新 agent の起動を妨げるか
    // 二重に報告し続ける。
    const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
    expect(raw).toContain('Stop and disable the other agent flavour')
    expect(raw).toContain('Remove the other agent flavour')
  })
})

describe('テンプレートへ入る値の書式検証（設定ファイル注入の防止）', () => {
  // ロールが生成する設定ファイルはいずれも行指向で、値に改行が含まれると
  // 「ファイルが壊れる」のではなく「有効なディレクティブが増える」。
  // rsyslog なら `action(type="omprog" binary=...)` で root の任意コマンド実行、
  // Zabbix なら `UserParameter=` で同等のことができる。生成物は構文として正しいので
  // `validate:` も `rsyslogd -N1` も通る。タスクガードは変数名しか見ないため、
  // ここでの書式検証が唯一の防御になる。
  // いずれも実ペイロードを流して assert が拒否することを確認済み。

  it('rsyslog_server: bind アドレス・送信元・logrotate 値を書式で縛る', () => {
    const raw = readRaw('rsyslog_server', 'tasks', 'main.yml')
    expect(raw).toContain("rsyslog_server_bind_address is match('^([0-9]{1,3}\\.){3}[0-9]{1,3}$')")
    // 送信元は要素ごとに検証する（リスト長だけの確認では要素に改行を入れられる）
    expect(raw).toContain("item is match('^[0-9]{1,3}(\\.[0-9]{1,3}){3}(/[0-9]{1,2})?$')")
    expect(raw).toContain("(rsyslog_server_logrotate_days | string) is match('^[0-9]+$')")
    expect(raw).toContain('rsyslog_server_logrotate_compress is boolean')
  })

  it('rsyslog_forward: selector・転送先・キュー設定を書式で縛る', () => {
    const raw = readRaw('rsyslog_forward', 'tasks', 'main.yml')
    expect(raw).toContain("rsyslog_forward_selector is match('^[A-Za-z0-9*,.;_-]+$')")
    expect(raw).toContain("rsyslog_forward_target_host is match('^[A-Za-z0-9][A-Za-z0-9.:_-]*$')")
    expect(raw).toContain("(rsyslog_forward_queue_max_disk_space | string) is match('^[0-9]+[kKmMgG]?$')")
    expect(raw).toContain("(rsyslog_forward_resume_retry_count | string) is match('^-?[0-9]+$')")
  })

  it('zabbix_agent: 設定ファイルへ入る全項目を書式で縛る', () => {
    const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
    // Zabbix は CIDR・セミコロン区切りの HA リスト・角括弧付き IPv6・ホスト名中の空白を
    // 正式に認めるため、文字集合は狭すぎないこと。要件は「改行で新しい設定行を
    // 始められないこと」であり、許可文字を絞りすぎると正当な構成を弾く。
    expect(raw).toMatch(/zabbix_agent_server is match\('\^\[A-Za-z0-9\]/)
    expect(raw).toMatch(/zabbix_agent_server_active is match\(/)
    expect(raw).toMatch(/zabbix_agent_hostname is match\(/)
    // 改行が入らないことが本質なので、パターンに改行系のメタ文字が無いこと
    expect(raw).not.toContain('\\n]')
    expect(raw).toContain("zabbix_agent_psk_identity is match('^[A-Za-z0-9._:-]+$')")
    // PSK は Zabbix が要求する16進文字列
    expect(raw).toContain("zabbix_agent_psk is match('^[0-9a-fA-F]{32,}$')")
  })

  it('テンプレートが参照する変数はすべて assert で「書式を」縛られている', () => {
    // 「テンプレートに変数を足したが検証を足し忘れる」を構造的に防ぐ。
    // これが今回 4 巡目で CRITICAL 3 件になった原因そのもの。
    //
    // 以前はここが `tasks.includes(v)`（tasks/main.yml のどこかに変数名が出てくるか）
    // だった。それでは `when:` 節・コメント・fail_msg に名前が出ているだけで緑になり、
    // 「検証を足し忘れた」ケースを取り逃がす。テンプレートへ入る値の唯一の防御は
    // 書式 assert なので、**assert タスク単位で**、その変数に触れている assert が
    // 実際に形を縛る述語を含むことまで見る。
    //
    // `is defined` や `| length > 0` は「存在するか」しか見ず、改行を含む値を止め
    // られないため、縛りとして数えない。
    const CONSTRAINTS = [
      'is match(',
      'is boolean',
      'is number',
      ' in [',
      'not in [',
      '| int)',
    ]
    const targets: Array<[string, string]> = [
      ['rsyslog_server', 'remote-receiver.conf.j2'],
      ['rsyslog_server', 'logrotate-remote.j2'],
      ['rsyslog_forward', 'forward.conf.j2'],
      ['zabbix_agent', 'zabbix_agent.conf.j2'],
    ]
    for (const [role, tpl] of targets) {
      const template = readRaw(role, 'templates', tpl)
      const tasks = loadYaml(role, 'tasks', 'main.yml') as Array<Record<string, unknown>>
      // assert タスクごとに「条件式 + loop」をひとまとまりの文字列にする。
      // loop を含めるのは、リストを要素ごとに検証する形（`loop: "{{ VAR }}"` の
      // 中で `item is match(...)` を課す）を正しく数えるため。
      // 粒度は assert タスクではなく**条件式1つ**にする。1つの assert が複数の変数を
      // まとめて検証しているとき、タスク単位で見ると「同じタスクの別の行にある
      // `is match(`」を自分の縛りとして数えてしまい、その変数の書式検証だけを
      // 外す変異を取り逃がす（実際に取り逃がすことを確認したうえでこの粒度にした）。
      const assertBlocks = tasks
        .filter((t) => 'assert' in t || 'ansible.builtin.assert' in t)
        .flatMap((t) => {
          const args = (t.assert ?? t['ansible.builtin.assert']) as Record<string, unknown>
          const that = args?.that
          const conditions = Array.isArray(that) ? that : [that]
          // loop は条件ごとに添える。リストを要素単位で縛る形
          // （`loop: "{{ VAR }}"` の中で `item is match(...)`）では、変数名は loop 側、
          // 縛りは条件側に分かれて書かれるため。
          return conditions.map((condition) => JSON.stringify({ condition, loop: t.loop }))
        })
      const referenced = new Set(
        [...template.matchAll(new RegExp(`\\b(${role}_[a-z0-9_]+)`, 'g'))].map((m) => m[1]),
      )
      const unconstrained = [...referenced].filter(
        (v) =>
          !assertBlocks.some(
            (block) => block.includes(v) && CONSTRAINTS.some((c) => block.includes(c)),
          ),
      )
      expect({ role, tpl, unconstrained }).toEqual({ role, tpl, unconstrained: [] })
    }
  })
})

describe('rsyslog_forward の転送先は 1 ホストにつき 1 つ', () => {
  it('二重 include を「この play で実行済みか」の真偽値で検出して失敗させる', () => {
    // 断片ファイル名は固定なので、2 回 include すると 2 回目が 1 回目を上書きし、
    // 先に設定した転送が黙って止まる（設定は検証を通り、サービスも起動し、実行も成功する）。
    //
    // 判定は転送先の一致を見ない。同じ転送先でも selector・protocol・キュー設定は
    // 違い得るので、「同じ転送先なら通す」にすると
    // `selector: authpriv.*` の次に `selector: kern.*` を include したときに
    // 1 回目が黙って消える——まさに防ぎたかった事象がそのまま通る。
    const raw = readRaw('rsyslog_forward', 'tasks', 'main.yml')
    expect(raw).toContain('Fail if this play already configured forwarding on this host')
    expect(raw).toContain('rsyslog_forward_already_configured')
    // 転送先の突き合わせで判定していないこと
    expect(raw).not.toContain('rsyslog_forward_configured_target')
  })

  it('検出用の fact はレシピから渡せない（allowlist に無い）', () => {
    // 渡せてしまうと検出を無効化できる。allowlist は set_fact のキーを除外するので
    // 自動的にそうなるが、意図として固定しておく。
    const defaults = loadYaml('rsyslog_forward', 'defaults', 'main.yml') as Record<string, unknown>
    expect(defaults).not.toHaveProperty('rsyslog_forward_already_configured')
  })

  it('キュー名は変数ではなくテンプレート内の固定値である', () => {
    // rsyslog はこの名前をスプールファイルの prefix に使い、再起動時は設定された名前の
    // キューだけを再開する。レシピから変更できると、収集先が落ちている間に溜まった
    // スプールを抱えたまま名前を変えたとき、旧 prefix のスプールが新設定から参照されなく
    // なり、未送信ログが恒久的に孤立する（実行は成功のまま、誰にも報告されない）。
    // 1 ホスト 1 action なので衝突する相手もいない。変数にしない。
    const defaults = loadYaml('rsyslog_forward', 'defaults', 'main.yml') as Record<string, unknown>
    expect(defaults).not.toHaveProperty('rsyslog_forward_queue_filename')
    expect(readRaw('rsyslog_forward', 'templates', 'forward.conf.j2')).toContain(
      'queue.filename="fwd-primary"',
    )
  })
})

describe('zabbix_agent のバージョン切替は双方向に収束する', () => {
  it('パッケージとリポジトリの両方で allow_downgrade を指定する', () => {
    // apt の既定は allow_downgrade: false。7.0 → 6.0 でリポジトリだけ変わって
    // 7.0 のバイナリが残ると、実行は成功するのに版が変わらない。
    const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
    expect((raw.match(/allow_downgrade: true/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('全開放の指定を拒否する（許可リストを無効化させない）', () => {
  it('zabbix_agent: Server= に 0.0.0.0/0 を書けない', () => {
    // `Server=` は Zabbix 自身のアプリ層の許可リスト。/0 を書くとそれが無効化され、
    // ufw を管理しない構成では既定の TLSAccept=unencrypted と相まって
    // エージェントポートが実質全開放・無認証になる。
    // allowed_sources 側と rsyslog_server 側は既に /0 を拒否しており、
    // ここだけ緩いのは非対称（しかも一番効く場所が一番緩い、という逆転）だった。
    const raw = readRaw('zabbix_agent', 'tasks', 'main.yml')
    expect(raw).toContain('Reject a fully-open Server= entry')
    expect(raw).toContain("['0.0.0.0/0', '::/0']")
    // カンマ・セミコロン区切りの要素単位で見ること（HA リストの一部に紛れ込ませられる）
    expect(raw).toContain("split(',') | map('split', ';') | flatten")
  })

  it.each([
    ['rsyslog_server', 'rsyslog_server_allowed_senders'],
    ['zabbix_agent', 'zabbix_agent_allowed_sources'],
  ])('%s: 許可リストの CIDR を意味で検証する（/0・不正オクテットを拒否）', (role) => {
    const raw = readRaw(role, 'tasks', 'main.yml')
    expect(raw).toContain("map('int') | select('>', 255)")
    expect(raw).toContain(">= 1 and (item.split('/')[1] | int) <= 32")
  })
})

describe('zabbix_agent の active check 検証', () => {
  const readRawTasks = () => readRaw('zabbix_agent', 'tasks', 'main.yml')

  it('ログ待ちの until が「何か書かれたら終了」になっていない', () => {
    // エージェントは起動直後に自分の開始メッセージを出すので、
    // 「stdout が空でなくなるまで」という条件は初回試行で成立してしまい、
    // ServerActive への接続を試す前のログを見て合格にする（fail-open）。
    const raw = readRawTasks()
    const until = raw.slice(raw.indexOf('  until: >-'))
    expect(until).not.toContain("(zabbix_agent_journal.stdout | default('') | trim | length) > 0")
    expect(until).toContain('cannot connect to')
  })

  it('until と fail の失敗シグネチャが一致している（片方だけ増えるのを防ぐ）', () => {
    // 同じ判定が2箇所にある。ロール内のタスク vars へ括り出す手は使えない:
    // タスクの vars はレシピの include params より弱く、レシピ側から上書きできる。
    // したがって両方にリテラルで書き、ずれをテストで縛る。
    const raw = readRawTasks()
    const SIGNATURES = [
      'cannot connect to',
      'active check configuration update',
      'not found',
      'tls',
    ]
    const untilBlock = raw.slice(raw.indexOf('  until: >-'), raw.indexOf('  when:', raw.indexOf('  until: >-')))
    const failWhen = raw.slice(raw.indexOf('The agent started but reported a problem'))
    for (const signature of SIGNATURES) {
      expect(untilBlock).toContain(signature)
      expect(failWhen).toContain(signature)
    }
  })

  it('待ち時間の上限が公開パラメータで、既定が有限である', () => {
    const defaults = loadYaml('zabbix_agent', 'defaults', 'main.yml') as Record<string, unknown>
    expect(typeof defaults.zabbix_agent_active_check_verify_seconds).toBe('number')
    expect(defaults.zabbix_agent_active_check_verify_seconds as number).toBeGreaterThan(0)
  })
})

describe('Molecule シナリオと CI マトリクスの対応', () => {
  // ローカルの `npm run ansible:molecule` は `ansible/molecule/` 配下を全部回すが、
  // CI のマトリクスは明示リストである。シナリオを足して CI へ登録し忘れると、
  // 手元でだけ走って CI では一度も走らない状態になる。落ちないので気づけない。
  it('ansible/molecule 配下のシナリオがすべて CI マトリクスに載っている', () => {
    const scenarios = readdirSync(path.join(__dirname, '../../ansible/molecule'))
      .filter((name) =>
        existsSync(path.join(__dirname, '../../ansible/molecule', name, 'molecule.yml')),
      )
      .sort()
    const workflow = readFileSync(
      path.join(__dirname, '../../.github/workflows/ansible-roles.yml'),
      'utf8',
    )
    const matrix = workflow.match(/scenario:\s*\[([^\]]+)\]/)
    expect(matrix).not.toBeNull()
    const listed = (matrix as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim())
      .sort()
    expect(listed).toEqual(scenarios)
  })
})
