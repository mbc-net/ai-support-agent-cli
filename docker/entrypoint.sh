#!/bin/sh
# Dynamically add passwd entry for arbitrary UIDs (e.g., when --user is passed)
CURRENT_UID=$(id -u)
if [ "$CURRENT_UID" != "0" ] && ! getent passwd "$CURRENT_UID" > /dev/null 2>&1; then
  echo "ai-support-agent:x:${CURRENT_UID}:$(id -g):ai-support-agent:/workspace:/bin/bash" >> /etc/passwd
fi
exec "$@"
