#!/bin/bash
# Track gated-command resume state across turns (Stop)
# `claude -p` restarts as a fresh process every turn, so the resumable
# commands (/plan, /add-feature, /fix-defect) cannot rely on the command
# body being re-expanded past turn 1 to keep gate discipline. When the final
# assistant message of a turn ends with the completion marker
# `<!-- ai-support-agent:resume name="<command>" -->`, this hook persists a
# small per-conversation state file so the UserPromptSubmit hook
# (on-command-resume.sh) can re-inject that command's Resume Digest on the
# next turn. If no marker is found, existing state is given a one-turn grace
# period (tracked via `misses`) before being cleared, since assistants
# occasionally omit the marker on an otherwise still-open flow; a second
# consecutive miss clears the state (the flow is considered complete or
# abandoned). If python3 is unavailable, do nothing (fail open).
set -u

[ -n "${AI_SUPPORT_CONVERSATION_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

input=$(cat)
export AI_SUPPORT_AGENT_HOOK_STDIN="$input"

python3 - "$AI_SUPPORT_CONVERSATION_ID" <<'PYEOF' 2>/dev/null
import json
import os
import re
import sys
import time

conversation_id = sys.argv[1]
sanitized_id = re.sub(r'[^A-Za-z0-9._-]', '', conversation_id)
if not sanitized_id:
    sys.exit(0)

state_dir = os.path.join(os.path.expanduser('~'), '.ai-support-agent', 'plugin-resume')
state_path = os.path.join(state_dir, sanitized_id + '.json')

MARKER_RE = re.compile(
    r'^\s*<!--\s*ai-support-agent:resume\s+name="(plan|add-feature|fix-defect)"\s*-->\s*$',
    re.MULTILINE,
)


def extract_last_assistant_text(transcript_path):
    """Return the text of the last `type == "assistant"` entry in the
    transcript JSONL, or None on any extraction failure (fail safe)."""
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception:
        return None

    last_text = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict) or entry.get('type') != 'assistant':
            continue
        try:
            content = entry['message']['content']
        except Exception:
            continue
        if not isinstance(content, list):
            continue
        texts = [
            block.get('text', '')
            for block in content
            if isinstance(block, dict) and block.get('type') == 'text'
        ]
        if texts:
            last_text = ''.join(texts)

    return last_text


def detect_marker(text):
    """Search for the resume marker, excluding anything inside fenced
    (```) code blocks. Returns the matched command name, or None."""
    if not text:
        return None
    segments = text.split('```')
    for index, segment in enumerate(segments):
        if index % 2 == 1:
            # Odd-indexed segments are inside a fenced code block; skip them.
            continue
        match = MARKER_RE.search(segment)
        if match:
            return match.group(1)
    return None


def read_state(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def write_state(path, command, turns, misses):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.chmod(os.path.dirname(path), 0o700)
    tmp_path = path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump({'command': command, 'turns': turns, 'misses': misses}, f)
    os.replace(tmp_path, path)


def prune_stale_state_files(directory):
    if not os.path.isdir(directory):
        return
    now = time.time()
    try:
        entries = os.listdir(directory)
    except Exception:
        return
    for name in entries:
        if not name.endswith('.json'):
            continue
        full_path = os.path.join(directory, name)
        try:
            mtime = os.stat(full_path).st_mtime
        except Exception:
            continue
        if now - mtime > 86400:
            try:
                os.remove(full_path)
            except Exception:
                pass


try:
    hook_input = json.loads(os.environ.get('AI_SUPPORT_AGENT_HOOK_STDIN', ''))
except Exception:
    hook_input = {}

transcript_path = hook_input.get('transcript_path', '') if isinstance(hook_input, dict) else ''

detected_command = None
if transcript_path:
    last_text = extract_last_assistant_text(transcript_path)
    detected_command = detect_marker(last_text)

if detected_command:
    existing = read_state(state_path)
    if isinstance(existing, dict) and existing.get('command') == detected_command:
        turns = existing.get('turns', 0)
        if not isinstance(turns, int):
            turns = 0
        turns += 1
    else:
        turns = 1
    write_state(state_path, detected_command, turns, 0)
else:
    if os.path.exists(state_path):
        existing = read_state(state_path)
        if isinstance(existing, dict):
            misses = existing.get('misses', 0)
            if not isinstance(misses, int):
                misses = 0
            if misses == 0:
                command = existing.get('command')
                turns = existing.get('turns', 0)
                if not isinstance(turns, int):
                    turns = 0
                if isinstance(command, str):
                    write_state(state_path, command, turns, 1)
                else:
                    try:
                        os.remove(state_path)
                    except Exception:
                        pass
            else:
                try:
                    os.remove(state_path)
                except Exception:
                    pass
        else:
            # The state file exists but could not be parsed (corrupted).
            # Self-heal by removing it, rather than leaving a broken file
            # in place that silently disables re-injection until the next
            # prune sweep (up to 24h later).
            try:
                os.remove(state_path)
            except Exception:
                pass

prune_stale_state_files(state_dir)
PYEOF

exit 0
