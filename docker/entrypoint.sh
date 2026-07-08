#!/bin/sh
# Dynamically add passwd entry for arbitrary UIDs (e.g., when --user is passed)
CURRENT_UID=$(id -u)
if [ "$CURRENT_UID" != "0" ] && ! getent passwd "$CURRENT_UID" > /dev/null 2>&1; then
  echo "ai-support-agent:x:${CURRENT_UID}:$(id -g):ai-support-agent:/workspace:/bin/bash" >> /etc/passwd 2>/dev/null || true
fi

# ECS oneshot mode: AGENT_MODE=oneshot is injected at RunTask time via
# containerOverrides. The CLI entry point detects it and runs exactly one
# command (getCommand -> execute -> submitResult) before exiting, so any
# container CMD is ignored in this mode.
if [ "$AGENT_MODE" = "oneshot" ]; then
  exec ai-support-agent
fi

exec "$@"
