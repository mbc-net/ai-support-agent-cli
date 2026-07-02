#!/bin/bash
# Guard against dangerous commands before execution (PreToolUse / Bash)
# When a destructive command is detected, block execution and require the
# user to manually confirm (ask) before it proceeds.
# If python3 is unavailable, do nothing (fail open).
set -u

input=$(cat)
command -v python3 >/dev/null 2>&1 || exit 0

cmd=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    pass' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

reason=""
# Detect rm with both recursive (-r/-R/--recursive) and force (-f/--force)
# flags, regardless of whether they are combined, separate, or long-form.
if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])rm[[:space:]]' \
  && printf '%s' "$cmd" | grep -Eq '[[:space:]]-[a-zA-Z]*[rR]|[[:space:]]--recursive' \
  && printf '%s' "$cmd" | grep -Eq '[[:space:]]-[a-zA-Z]*f|[[:space:]]--force'; then
  reason="recursive forced delete (rm -rf or equivalent)"
elif printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[^;|&]*([[:space:]](--force|-f))([[:space:]]|$)'; then
  reason="git force push"
elif printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard'; then
  reason="git reset --hard (discards working tree changes)"
elif printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+clean[^;|&]*[[:space:]]-[a-zA-Z]*f'; then
  reason="git clean -f (removes untracked files)"
elif printf '%s' "$cmd" | grep -Eiq '(^|[^a-z])(drop[[:space:]]+(table|database|schema)|truncate[[:space:]]+table|truncate[[:space:]]+[a-z_]+;)'; then
  reason="SQL containing DROP / TRUNCATE"
elif printf '%s' "$cmd" | grep -Eq 'chmod[[:space:]]+(-R[[:space:]]+)?777'; then
  reason="chmod 777 (grants full permissions to everyone)"
elif printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])aws[[:space:]][^;|&]*[[:space:]](create|update|delete|put|terminate|stop|reboot|modify)-[a-z-]+'; then
  reason="AWS resource mutation operation"
elif printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])aws[[:space:]]+lambda[[:space:]]+invoke'; then
  reason="AWS Lambda invocation (lambda invoke)"
elif printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])aws[[:space:]]+ssm[[:space:]]+send-command'; then
  reason="remote command execution via SSM"
fi

if [ -n "$reason" ]; then
  python3 - "$reason" <<'PYEOF'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": "Guard: detected " + sys.argv[1] + ". Review the command and its target before approving."
    }
}, ensure_ascii=False))
PYEOF
fi
exit 0
