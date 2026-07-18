import { DEFAULT_SCHEMA, load } from 'js-yaml'

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
 * 組み込みステップ（os_init/docker/web_server/database/dns_tls/ssh_key）は、bundled role を
 * 呼ぶ `include_role` タスクとして表現する。`include_role` は 6 ロールのみ許可し、role 名と
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
 * `include_role` で呼び出しを許可する 6 つの bundled role。
 * 組み込みステップ（スニペット）に 1:1 対応する。
 */
export const INCLUDE_ROLE_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'os_init',
  'docker',
  'web_server',
  'database',
  'dns_tls',
  'ssh_key',
])

/**
 * `include_role` のモジュール引数マッピングで許可する param キー。
 * - `name`: 必須。上記 6 ロールのいずれか。
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
const INCLUDE_ROLE_ALLOWED_PARAM_KEYS: ReadonlySet<string> = new Set([
  'name',
  'tasks_from',
  'public',
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

/**
 * `include_role` の `tasks_from` に許可する文字クラス（英数・`_`・`-` のみ）。
 * `/`・`..` 等のパス区切りを禁止し、ロールディレクトリ外の任意ファイルを
 * tasks ファイルとして読み込ませる（パストラバーサル）攻撃を防ぐ。
 */
const TASKS_FROM_ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/

const SET_FACT_MODULE_KEYS: ReadonlySet<string> = new Set([
  'set_fact',
  'ansible.builtin.set_fact',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
function referencesSecretVar(
  task: Record<string, unknown>,
  secretVarNames: ReadonlySet<string>,
): boolean {
  if (secretVarNames.size === 0) return false
  let serialized: string
  try {
    serialized = JSON.stringify(task)
  } catch {
    return false
  }
  for (const name of secretVarNames) {
    const pattern = new RegExp(`\\{\\{[^}]*\\b${escapeRegExp(name)}\\b[^}]*\\}\\}`)
    if (pattern.test(serialized)) {
      return true
    }
  }
  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
 * - `tasks_from`（ロール内の代替タスクファイル名）が英数・`_`・`-` のみ
 *   （{@link TASKS_FROM_ALLOWED_PATTERN}）であること。`/` や `..` を含む値でロール
 *   ディレクトリ外の任意ファイルを読み込ませるパストラバーサルを防ぐ。
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

  // tasks_from はロールディレクトリ内の代替タスクファイル名。パストラバーサルを
  // 防ぐため、英数・`_`・`-` のみの allowlist で検証する（`/`・`..` は拒否）。
  const tasksFrom = moduleArgs.tasks_from
  if (tasksFrom !== undefined) {
    if (
      typeof tasksFrom !== 'string' ||
      !TASKS_FROM_ALLOWED_PATTERN.test(tasksFrom)
    ) {
      violations.push({
        taskIndex,
        key: 'tasks_from',
        reason:
          'include_role tasks_from must match [A-Za-z0-9_-]+ (no path separators)',
      })
    }
  }
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
  taskLevelVars: unknown,
  violations: AnsibleTaskViolation[],
): void {
  if (!isPlainObject(taskLevelVars)) return
  for (const varName of Object.keys(taskLevelVars)) {
    if (isReservedVarName(varName)) {
      violations.push({
        taskIndex,
        key: varName,
        reason: 'reserved or magic variable name in include_role vars',
      })
    }
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
          reason: `YAML parse failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
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

        // include_role は専用バリデータで検査する（6 ロール限定 + param キー allowlist）。
        // ロール変数（task レベルの vars）は validateIncludeRoleTaskVars で別途検査する。
        if (INCLUDE_ROLE_MODULE_KEYS.has(normalized)) {
          validateIncludeRole(taskIndex, key, task[key], violations)
          validateIncludeRoleTaskVars(taskIndex, task.vars, violations)
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

    // 4. set_fact / register の予約語・マジック変数名チェック
    for (const key of moduleCandidateKeys) {
      if (!SET_FACT_MODULE_KEYS.has(key)) continue
      const factValue = task[key]
      if (isPlainObject(factValue)) {
        for (const factName of Object.keys(factValue)) {
          if (isReservedVarName(factName)) {
            violations.push({
              taskIndex,
              key: factName,
              reason: 'reserved or magic variable name',
            })
          }
        }
      }
    }
    const registerValue = task.register
    if (typeof registerValue === 'string' && isReservedVarName(registerValue)) {
      violations.push({
        taskIndex,
        key: 'register',
        reason: 'reserved or magic variable name',
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
  const normalizedTasks = parsed.map((rawTask) => {
    const task = { ...(rawTask as Record<string, unknown>) }
    if (referencesSecretVar(task, noLogVarNames) && task.no_log !== true) {
      task.no_log = true
    }
    return task
  })

  return { ok: true, violations: [], normalizedTasks }
}
