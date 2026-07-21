#!/bin/sh
# Dynamically add passwd entry for arbitrary UIDs (e.g., when --user is passed)
CURRENT_UID=$(id -u)
if [ "$CURRENT_UID" != "0" ] && ! getent passwd "$CURRENT_UID" > /dev/null 2>&1; then
  echo "ai-support-agent:x:${CURRENT_UID}:$(id -g):ai-support-agent:/workspace:/bin/bash" >> /etc/passwd 2>/dev/null || true
fi

# git 2.35.2+ refuses to run inside a repository owned by a different UID
# ("detected dubious ownership") unless the directory is explicitly trusted
# via safe.directory. The container's runtime UID (docker-runner.ts passes
# `--user <hostUID>:<hostGID>`) commonly differs from whichever UID actually
# created a given repo under the workspace (an earlier root-owned layer, a
# previous container run, etc.), which otherwise silently breaks anything
# that shells out to git — including nvim's lualine branch segment and the
# starship prompt's git modules, with no visible error.
#
# Register every repository already present under the workspace by its
# exact path (never the global '*' wildcard, which would trust git commands
# anywhere in the container, not just the agent's own working area).
# Repositories synced during a live session (after this scan already ran)
# register themselves at clone/pull time instead — see repo-sync.ts.
# AI_SUPPORT_AGENT_WORKSPACE_DIR overrides the scan root for testing; it is
# unset in the image, so production always scans /workspace.
# Failures here (find hitting an unreadable subtree, git config unable to
# write $HOME/.gitconfig, ...) must not be silent: this whole block exists
# precisely because a silently-broken git call shows up downstream as
# nvim's lualine branch segment / starship's git modules just rendering
# nothing, with no clue why. find's own stderr is captured separately from
# its stdout (repo paths) so the two never get mixed on the same stream.
WORKSPACE_DIR="${AI_SUPPORT_AGENT_WORKSPACE_DIR:-/workspace}"
if [ -d "$WORKSPACE_DIR" ]; then
  FIND_ERR_LOG="$(mktemp)"
  find "$WORKSPACE_DIR" -type d -name .git 2>"$FIND_ERR_LOG" | while IFS= read -r gitdir; do
    REPO_DIR="$(dirname "$gitdir")"
    if ! git config --global --add safe.directory "$REPO_DIR" 2>/dev/null; then
      echo "WARN: failed to register git safe.directory for $REPO_DIR" >&2
    fi
  done
  if [ -s "$FIND_ERR_LOG" ]; then
    echo "WARN: errors while scanning $WORKSPACE_DIR for git repositories:" >&2
    cat "$FIND_ERR_LOG" >&2
  fi
  rm -f "$FIND_ERR_LOG"
fi

# ECS oneshot mode: AGENT_MODE=oneshot is injected at RunTask time via
# containerOverrides. The CLI entry point detects it and runs exactly one
# command (getCommand -> execute -> submitResult) before exiting, so any
# container CMD is ignored in this mode.
if [ "$AGENT_MODE" = "oneshot" ]; then
  exec ai-support-agent
fi

exec "$@"
