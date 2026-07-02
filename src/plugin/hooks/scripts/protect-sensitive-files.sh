#!/bin/bash
# Protect sensitive files (PreToolUse / Read, Edit, Write)
# Access to private key files is denied outright; access to .env and
# credentials-style files requires manual confirmation (ask).
# If python3 is unavailable, do nothing (fail open).
set -u

input=$(cat)
command -v python3 >/dev/null 2>&1 || exit 0

fp=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    pass' 2>/dev/null) || exit 0
[ -z "$fp" ] && exit 0

base=$(basename "$fp")
decision=""
reason=""

# Deny: private keys and certificate stores
case "$base" in
  id_rsa|id_ed25519|id_ecdsa|id_dsa|*.pem|*.p12|*.pfx|*.keystore|*.jks)
    decision="deny"
    reason="access to a private key or certificate store (${base}) is not allowed. If this is required, the user must handle it directly."
    ;;
esac

# Ask: .env-style files (templates excluded) and credentials-style files
if [ -z "$decision" ]; then
  case "$base" in
    .env.example|.env.sample|.env.template|.env.dist|.env.testing)
      ;; # templates are allowed
    .env|.env.*)
      decision="ask"
      reason="access to an environment variable file (${base}). It may contain secrets, so confirm how the contents will be used before approving."
      ;;
    *credentials*|secrets.json|secrets.yml|secrets.yaml)
      decision="ask"
      reason="access to a file that appears to hold credentials (${base}). Review before approving."
      ;;
  esac
fi

if [ -n "$decision" ]; then
  python3 - "$decision" "$reason" <<'PYEOF'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": sys.argv[1],
        "permissionDecisionReason": "Guard: " + sys.argv[2]
    }
}, ensure_ascii=False))
PYEOF
fi
exit 0
