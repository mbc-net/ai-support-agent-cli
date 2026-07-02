#!/bin/bash
# Auto-format after edits (PostToolUse / Edit, Write)
# Only formats the edited file when the project already has a matching
# formatter configured. Never performs network access to fetch tooling
# (e.g. downloading via npx). Always exits successfully.
set -u

input=$(cat)
command -v python3 >/dev/null 2>&1 || exit 0

fp=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    pass' 2>/dev/null) || exit 0
[ -n "$fp" ] && [ -f "$fp" ] || exit 0

proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ext="${fp##*.}"

has_prettier_config() {
  ls "$proj"/.prettierrc "$proj"/.prettierrc.* "$proj"/prettier.config.* >/dev/null 2>&1 && return 0
  [ -f "$proj/package.json" ] && grep -q '"prettier"' "$proj/package.json" && return 0
  return 1
}

# Resolve Python tools preferring the project's virtual environment.
# Priority order: $proj/.venv/bin -> $proj/venv/bin -> $VIRTUAL_ENV/bin -> global
find_py_tool() {
  tool="$1"
  for dir in "$proj/.venv/bin" "$proj/venv/bin" "${VIRTUAL_ENV:-}/bin"; do
    if [ -x "$dir/$tool" ]; then
      printf '%s' "$dir/$tool"
      return 0
    fi
  done
  command -v "$tool" 2>/dev/null
}

case "$ext" in
  ts|tsx|js|jsx|mjs|cjs|json|css|scss|vue)
    # Only use a locally installed prettier; never auto-fetch via npx.
    if [ -x "$proj/node_modules/.bin/prettier" ] && has_prettier_config; then
      "$proj/node_modules/.bin/prettier" --write --log-level silent "$fp" >/dev/null 2>&1 || true
    fi
    ;;
  py)
    ruff_bin=$(find_py_tool ruff)
    if [ -n "$ruff_bin" ]; then
      if [ -f "$proj/ruff.toml" ] || [ -f "$proj/.ruff.toml" ] || { [ -f "$proj/pyproject.toml" ] && grep -q '\[tool\.ruff' "$proj/pyproject.toml"; }; then
        "$ruff_bin" format --quiet "$fp" >/dev/null 2>&1 || true
      fi
    fi
    ;;
  php)
    if [ -x "$proj/vendor/bin/pint" ]; then
      "$proj/vendor/bin/pint" --quiet "$fp" >/dev/null 2>&1 || true
    elif [ -x "$proj/vendor/bin/php-cs-fixer" ] && { [ -f "$proj/.php-cs-fixer.php" ] || [ -f "$proj/.php-cs-fixer.dist.php" ]; }; then
      "$proj/vendor/bin/php-cs-fixer" fix --quiet "$fp" >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
