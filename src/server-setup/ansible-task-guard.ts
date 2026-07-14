import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * api/src/server-setup/ansible-task-guard.ts とロジックを完全に同期させること。
 * canonical定義は admin-docs/docs/features/server-setup.md「セキュリティモデル
 * （カスタムタスク）」節。
 *
 * **セキュリティ上重要**: このロジックは実行環境（agentホスト）への攻撃経路
 * （任意コマンド実行・他ホストへの委譲・秘密情報の平文ログ出力・危険な
 * lookup/queryプラグイン経由のファイル読み取り等）を塞ぐための唯一の防御線。
 * allowlist に無いモジュール・危険なタスクキーは一律拒否し、フォールバックは
 * 行わない（CLAUDE.md フォールバック禁止ルール）。
 *
 * api 側は保存時（`ServerSetupRecipeService`）の一次検証のみを行い、agent 側の
 * この検証が実行前の**権威的な防御境界**となる（api 側検証をバイパルした
 * 不正 payload が届いた場合の最終防衛線）。
 */

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
 *
 * - `delegate_to`/`delegate_facts`/`local_action`: 実行対象ホストの変更
 *   （agentホスト以外・意図しないホストでの実行を許してしまう）
 * - `connection`: 接続方式の変更（local 接続等での agentホスト直接実行）
 * - `become_method`/`become_exe`/`become_flags`/`become_user`: 権限昇格方式の変更
 * - `vars`/`environment`: タスクスコープ変数・環境変数の注入（allowlist外の
 *   任意コード実行や機密情報の迂回に使われ得る）
 * - `notify`/`listen`: ハンドラ起動（allowlist外のハンドラ定義と組み合わさり得る）
 * - `hosts`: play形式の混入（本ガードはタスクのみを受け付ける）
 * - `import_playbook`: 任意の外部playbookの読み込み
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
])

/**
 * `ansible.builtin.` を省略した短縮形での指定を許可するモジュール名。
 * ここに無いモジュール（`ansible.mysql.mysql_user` 等）はフルネームでのみ許可する。
 *
 * **CRITICAL修正**: `template` はここから完全に削除している。`ansible.builtin.template`
 * は `src` が常に Ansible コントローラ（=agentホスト）側のローカルファイルパスとして
 * 解決される仕様で、安全に使える代替パラメータが無いため allowlist から除外する
 * （`copy` の `content` パラメータで代替可能）。
 */
const BUILTIN_SHORT_NAMES: ReadonlySet<string> = new Set([
  'apt',
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
 * カスタムAnsibleタスクで使用を許可するモジュール（フルネーム）のallowlist。
 *
 * **CRITICAL修正**: `ansible.builtin.template` は allowlist から完全に除外している
 * （理由は {@link BUILTIN_SHORT_NAMES} のコメント参照）。`ansible.builtin.copy` は
 * 許可を維持するが、`src` キーを持つタスクは別途拒否する
 * （{@link validateCustomTasksYaml} の copy/`src` チェック参照。`content` + `dest` の
 * みの利用に限定し、agentホストのローカルファイルを読み取れないようにする）。
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
])

/** `copy` モジュールの正規化後キー名（`src` パラメータ拒否チェックに使用）。 */
const COPY_MODULE_KEY = 'ansible.builtin.copy'

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

/** `lookup(...)` / `query(...)` / `q(...)` プラグイン参照を検出する正規表現。 */
const LOOKUP_PLUGIN_PATTERN = /\b(lookup|query|q)\s*\(/

const SET_FACT_MODULE_KEYS: ReadonlySet<string> = new Set([
  'set_fact',
  'ansible.builtin.set_fact',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** モジュールキーを `ansible.builtin.` 省略形からフルネームへ正規化する。 */
function normalizeModuleKey(key: string): string {
  return BUILTIN_SHORT_NAMES.has(key) ? `ansible.builtin.${key}` : key
}

/** 予約語・マジック変数名かどうかを判定する（`ansible_` プレフィックス or 完全一致）。 */
function isReservedVarName(name: string): boolean {
  return name.startsWith('ansible_') || RESERVED_VAR_NAMES.has(name)
}

/** 値（文字列・オブジェクト・配列を問わず）を再帰的に走査し、lookup/query参照が無いかを調べる。 */
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
 *
 * **CRITICAL修正**: 以前は `{{ name }}`（前後空白のみ許容）の完全一致でしか検出できず、
 * `{{ NAME | quote }}` や `{{ NAME | default('') }}` のようなAnsibleで一般的な
 * Jinjaフィルタ付き参照をすり抜けて no_log が付与されなかった（secret平文が
 * 実行結果ログ=RDS executionLogsに残るリスク）。`{{` と `}}` で囲まれた式の
 * **どこかに単語境界で区切られた変数名トークンが1回でも出現するか**で判定するよう
 * 緩め、見落とし（false negative）を無くす方向にする（誤検知=過剰なno_log付与は許容）。
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
 * カスタムAnsibleタスクのYAML文字列を検証する。
 *
 * @param yaml テナントadminが入力したタスクYAML
 * @param stepType 対象ステップ種別（正規化後の `name` 前置に使用）
 * @param secretVarNames この検証呼び出し時点で「secretとして扱うべき」変数名の集合
 *   （agent実行時は `fetchServerSetupVariables` が解決した secretNames を渡し、
 *   no_log 付与を行う）
 */
export function validateCustomTasksYaml(
  yaml: string,
  stepType: string,
  secretVarNames: ReadonlySet<string>,
): AnsibleTaskValidationResult {
  let parsed: unknown
  try {
    parsed = load(yaml, { schema: DEFAULT_SCHEMA })
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

    // 3. 危険なタスクキーの拒否
    for (const key of Object.keys(task)) {
      if (FORBIDDEN_TASK_KEYS.has(key)) {
        violations.push({ taskIndex, key, reason: 'forbidden task key' })
      }
    }

    // 4. モジュールキーの allowlist 照合
    const moduleCandidateKeys = getModuleCandidateKeys(task)
    if (moduleCandidateKeys.length === 0) {
      violations.push({
        taskIndex,
        key: 'root',
        reason: 'no recognized module key',
      })
    } else {
      for (const key of moduleCandidateKeys) {
        const normalized = normalizeModuleKey(key)
        if (!MODULE_ALLOWLIST.has(normalized)) {
          violations.push({ taskIndex, key, reason: 'module not in allowlist' })
          continue
        }

        // CRITICAL修正: copy モジュールは src（コントローラ=agentホスト側のローカル
        // ファイルパス）を使うと remote_src が既定 false のため、agentホストの
        // 任意ローカルファイルを対象サーバーへ転送できてしまう。content + dest の
        // みの利用に限定する。
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

    // 5. lookup/query プラグイン参照の拒否（タスク全体を再帰的に走査）
    if (containsLookupPluginReference(task)) {
      violations.push({
        taskIndex,
        key: 'root',
        reason: 'lookup/query plugin reference is forbidden',
      })
    }

    // 6. set_fact / register の予約語・マジック変数名チェック
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

  // 8. 正規化（name前置 + secret参照タスクへの no_log 付与）
  const normalizedTasks = parsed.map((rawTask) => {
    const task = { ...(rawTask as Record<string, unknown>) }
    const moduleCandidateKeys = getModuleCandidateKeys(task)
    const originalName = typeof task.name === 'string' ? task.name : undefined
    const summary = originalName ?? moduleCandidateKeys[0] ?? 'task'
    task.name = `${stepType} : ${summary}`

    if (referencesSecretVar(task, secretVarNames) && task.no_log !== true) {
      task.no_log = true
    }

    return task
  })

  return { ok: true, violations: [], normalizedTasks }
}
