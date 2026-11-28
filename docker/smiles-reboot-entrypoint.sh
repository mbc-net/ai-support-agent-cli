#!/bin/sh
set -eu
[ "${AGENT_MODE:-}" = oneshot ] || { echo 'SMILES_ONESHOT_MODE_REQUIRED' >&2; exit 1; }
# Fargate task definition must also set both core ulimits to zero. This cannot
# raise a limit; runtime profile checks the actual hard limit and swap state.
ulimit -c 0
exec node -e "require('/opt/agent/dist/oneshot-runner.js').runOneshotFromEnv()"
