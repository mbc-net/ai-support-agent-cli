#!/bin/bash
# Check for leaked secrets before committing (PreToolUse / Bash)
# When running git commit, inspect the staged content for known token
# formats. If any are found, require manual confirmation (ask).
# False positives can simply be approved by the user.
set -u

input=$(cat)
command -v python3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

cmd=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    pass' 2>/dev/null) || exit 0

# Also detect commit invocations with extra options, e.g. git -C <dir> commit
# or git -c key=val commit.
printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])git[[:space:]][^;|&]*commit' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Only target high-confidence token formats (generic patterns like password=
# are excluded because they produce too many false positives).
pattern='AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# Read NUL-separated so filenames containing spaces are not missed.
hit_files=""
while IFS= read -r -d '' f; do
  if git show ":$f" 2>/dev/null | grep -EIq "$pattern"; then
    hit_files="$hit_files $f"
  fi
done < <(git diff --cached --name-only --diff-filter=ACM -z 2>/dev/null)

if [ -n "$hit_files" ]; then
  python3 - "$hit_files" <<'PYEOF'
import json, sys
files = sys.argv[1].strip()
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "Guard: the staged content may contain secrets (API keys, tokens, or private keys). Affected files: " + files + " -- review the content and approve only if it is safe."
    }
}, ensure_ascii=False))
PYEOF
fi
exit 0
