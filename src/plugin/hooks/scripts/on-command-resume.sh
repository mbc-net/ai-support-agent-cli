#!/bin/bash
# Re-inject gate discipline for resumed gated commands (UserPromptSubmit)
# Companion to hooks/scripts/on-command-stop.sh. When a prior turn's Stop
# hook detected an incomplete /plan, /add-feature, or /fix-defect flow (see
# on-command-stop.sh), this hook re-injects that command's Resume Digest
# (the RESUME_DIGEST_START/END block in the command's own .md file) as
# additionalContext on the next turn, since `claude -p` does not re-expand
# the original command body past turn 1. A trailing PROTOCOL REMINDER is
# appended after the digest, restating the completion-marker requirement,
# since assistants sometimes omit it even while the flow is still open. A
# turn-count safety valve stops runaway re-injection (independent of the
# Stop hook's `misses` grace-period counter). If python3 is unavailable, do
# nothing (fail open).
set -u

# Consume stdin (UserPromptSubmit hook JSON) even though it is unused here,
# so the calling process never blocks on an unread pipe.
cat >/dev/null

[ -n "${AI_SUPPORT_CONVERSATION_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

state_dir="$HOME/.ai-support-agent/plugin-resume"
sanitized_id=$(printf '%s' "$AI_SUPPORT_CONVERSATION_ID" | python3 -c 'import re,sys
print(re.sub(r"[^A-Za-z0-9._-]", "", sys.stdin.read()))' 2>/dev/null) || exit 0
[ -n "$sanitized_id" ] || exit 0

state_path="$state_dir/$sanitized_id.json"
[ -f "$state_path" ] || exit 0

python3 - "$state_path" "${CLAUDE_PLUGIN_ROOT:-}" <<'PYEOF' 2>/dev/null
import json
import os
import sys

state_path = sys.argv[1]
plugin_root = sys.argv[2]

ALLOWED_COMMANDS = {"plan", "add-feature", "fix-defect"}
MAX_TURNS = 6

try:
    with open(state_path, 'r', encoding='utf-8') as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

if not isinstance(state, dict):
    sys.exit(0)

turns = state.get('turns', 0)
if not isinstance(turns, int):
    # Type mismatch means the state file is corrupted. Self-heal by
    # removing it now, rather than leaving re-injection disabled
    # indefinitely until on-command-stop.sh happens to overwrite it.
    try:
        os.remove(state_path)
    except Exception:
        pass
    sys.exit(0)

if turns > MAX_TURNS:
    try:
        os.remove(state_path)
    except Exception:
        pass
    sys.exit(0)

command = state.get('command')
if command not in ALLOWED_COMMANDS:
    sys.exit(0)

command_md_path = os.path.join(plugin_root, 'commands', command + '.md')
try:
    with open(command_md_path, 'r', encoding='utf-8') as f:
        content = f.read()
except Exception:
    sys.exit(0)

start_marker = '<!-- RESUME_DIGEST_START -->'
end_marker = '<!-- RESUME_DIGEST_END -->'
start_idx = content.find(start_marker)
end_idx = content.find(end_marker)
if start_idx == -1 or end_idx == -1 or end_idx <= start_idx:
    sys.exit(0)

digest = content[start_idx + len(start_marker):end_idx].strip()
if not digest:
    sys.exit(0)

protocol_reminder = (
    '---\n'
    'PROTOCOL REMINDER (do not omit): You are resuming an in-progress /{command} flow via\n'
    'injected context, not a fresh invocation. If this turn does not fully conclude the flow,\n'
    'end your entire response with this exact line on its own line:\n'
    '<!-- ai-support-agent:resume name="{command}" -->\n'
    'If you omit it while the flow is genuinely still open, the system will lose track of the\n'
    'constraints above on the next turn.'
).format(command=command)

additional_context = digest + '\n' + protocol_reminder

output = {
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": additional_context,
    }
}
print(json.dumps(output, ensure_ascii=False))
PYEOF

exit 0
