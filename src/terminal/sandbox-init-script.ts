/**
 * プロジェクトディレクトリ外への移動を制限するシェル初期化スクリプトを生成する。
 * cd をラップし、移動先がプロジェクトディレクトリ配下でなければ拒否する。
 * PROMPT_COMMAND / precmd でも毎回チェックし、外部コマンド経由での移動も防止する。
 *
 * terminal-session.ts と vscode-server.ts の両方から利用される共有モジュール。
 */

/**
 * シェルパスが zsh かどうかを判定する。
 * 引数なしの場合は process.env.SHELL を参照する。
 */
export function isZshShell(shell?: string): boolean {
  const s = shell ?? process.env.SHELL ?? ''
  return s.endsWith('/zsh') || s.endsWith('/zsh5')
}

/**
 * bash 用 rc ファイルの内容を生成する。
 * 元の ~/.bashrc をロードした後にサンドボックススクリプトを注入する。
 */
export function buildBashRcContent(sandboxScript: string): string {
  return `# Load original .bashrc\n[ -f ~/.bashrc ] && source ~/.bashrc\n${sandboxScript}`
}

/**
 * zsh 用 rc ファイルの内容を生成する。
 * ZDOTDIR または HOME の .zshrc をロードした後にサンドボックススクリプトを注入する。
 */
export function buildZshRcContent(sandboxScript: string): string {
  const origZdotdir = (process.env.ZDOTDIR ?? process.env.HOME ?? '').replace(/'/g, "'\\''")
  return `# Load original .zshrc\n[ -f '${origZdotdir}/.zshrc' ] && source '${origZdotdir}/.zshrc'\n${sandboxScript}`
}

/**
 * Open Folder / Open File / Open Workspace 系コマンドのキーバインド無効化エントリを生成する。
 * code-server の keybindings.json に書き出すことで、ショートカットによるフォルダ移動を防止する。
 */
export function buildOpenFolderDisableKeybindings(): Array<{ key: string; command: string }> {
  return [
    { key: 'ctrl+o', command: '-workbench.action.files.openFile' },
    { key: 'ctrl+k ctrl+o', command: '-workbench.action.files.openFolder' },
    { key: 'cmd+o', command: '-workbench.action.files.openFile' },
    { key: 'cmd+k cmd+o', command: '-workbench.action.files.openFolder' },
  ]
}

export function buildSandboxInitScript(projectDir: string): string {
  // シェル変数に埋め込む際にシングルクォートをエスケープ
  const escaped = projectDir.replace(/'/g, "'\\''")
  // __SANDBOX_REAL は realpath で解決した物理パス。
  // pwd -P との比較に使い、シンボリックリンクの不一致を防ぐ。
  return `
__SANDBOX_DIR='${escaped}'
__SANDBOX_REAL="$(cd "\${__SANDBOX_DIR}" && pwd -P)"
__sandbox_is_inside() {
  local cur
  cur="$(pwd -P)"
  case "\${cur}" in
    "\${__SANDBOX_REAL}") return 0 ;;
    "\${__SANDBOX_REAL}/"*) return 0 ;;
    *) return 1 ;;
  esac
}
cd() {
  builtin cd "\$@" || return
  if ! __sandbox_is_inside; then
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    builtin cd "\${__SANDBOX_DIR}"
    return 1
  fi
}
pushd() {
  builtin pushd "\$@" || return
  if ! __sandbox_is_inside; then
    builtin popd >/dev/null 2>&1
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    return 1
  fi
}
popd() {
  builtin popd "\$@" || return
  if ! __sandbox_is_inside; then
    builtin cd "\${__SANDBOX_DIR}"
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    return 1
  fi
}
exec() {
  echo "restricted: exec is disabled in sandbox mode" >&2
  return 1
}
__sandbox_check() {
  if ! __sandbox_is_inside; then
    builtin cd "\${__SANDBOX_DIR}" 2>/dev/null
  fi
}
# bash
if [ -n "\${BASH_VERSION}" ]; then
  PROMPT_COMMAND="__sandbox_check;\${PROMPT_COMMAND}"
fi
# zsh
if [ -n "\${ZSH_VERSION}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook precmd __sandbox_check 2>/dev/null
fi
`
}
