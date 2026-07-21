# インタラクティブシェルの見た目・使い勝手を整える。
# Dockerfile が /etc/bash.bashrc に追記して読み込む（bash はここを --rcfile
# 指定時も含めて常にソースする。/etc/profile.d/*.sh はログインシェルでしか
# 実行されず、エージェントの実ターミナルセッションでは発火しない）。

# starship プロンプト
eval "$(starship init bash)"

# eza（ls 代替、アイコン付き）・bat（cat 代替、シンタックスハイライト付き）
# Debian の bat パッケージは名前衝突のため実体が /usr/bin/batcat になる。
# --paging=never: bat は既定で出力が端末の高さを超えると less 経由でページングする。
# このセッションはAIエージェントがPTYを駆動しており人間が q を押すことはないため、
# ページング待ちで固まらないよう明示的に無効化する（git の core.pager=cat と同じ理由）。
alias ls='eza --icons'
alias ll='eza -la --icons'
alias cat='batcat --paging=never'
