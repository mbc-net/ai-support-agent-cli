import * as fs from 'fs'

import { shellQuote } from './wrapper-helpers'

/** Directory mode restricting access to the owner only (used for dirs holding tokens/secrets). */
const SECURE_DIR_MODE = 0o700

/** Creates `dir` (and parents) if it does not already exist. */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Creates `dir` (and parents) if it does not already exist, restricted to
 * owner-only access. Used for directories holding per-project tokens/secrets
 * (service wrapper scripts, project config, logs).
 */
export function ensureSecureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE })
  }
}

/**
 * Build the bash snippet that runs a docker container, optionally routing
 * its stdout/stderr through `ai-support-agent log-rotate` subprocesses.
 *
 * Both Linux (systemd) and macOS (launchd) wrappers share the same FIFO +
 * background-rotator pattern; only the surrounding `docker run` flags differ
 * between platforms. This helper encapsulates the shared structure:
 *
 * - With `logDir`: sets up named FIFOs, starts two rotator subprocesses,
 *   runs the docker command (provided by `buildDockerRun`) with output
 *   redirected to those FIFOs, then waits for the rotators to drain before
 *   the wrapper exits.
 * - Without `logDir`: runs the docker command directly with no log rotation.
 *
 * In both cases the result ends with `EXIT_CODE=$?` so the caller can check
 * for the exit-42 self-update sentinel.
 *
 * @param opts.buildDockerRun  Function that builds the `docker run …` command
 *                             string. Receives `outputRedirect` — the bash
 *                             fragment to append for stdout/stderr redirection
 *                             (e.g. `> "$FIFO/out" 2> "$FIFO/err"` when log
 *                             rotation is active, or `""` when not). The
 *                             returned string must NOT include a trailing
 *                             newline; the helper adds line endings as needed.
 * @param opts.logDir          When set, the directory under which `agent.out.log`
 *                             and `agent.err.log` are written via log-rotate.
 * @param opts.supervisorLabel Human-readable label for the inline comment
 *                             ("systemd" or "launchd"). No effect on behaviour.
 */
export function buildDockerRunWithLogRotate(opts: {
  buildDockerRun: (outputRedirect: string) => string
  logDir: string | undefined
  supervisorLabel: 'systemd' | 'launchd'
}): string {
  const { buildDockerRun, logDir, supervisorLabel } = opts

  if (!logDir) {
    return `${buildDockerRun('')}\n\nEXIT_CODE=$?\n`
  }

  const qOutLog = shellQuote(`${logDir}/agent.out.log`)
  const qErrLog = shellQuote(`${logDir}/agent.err.log`)
  const dockerRunLine = buildDockerRun(' \\\n   > "$_ROT_DIR/out" 2> "$_ROT_DIR/err"')

  return `\
# Pipe stdout and stderr through SEPARATE \`ai-support-agent log-rotate\`
# subprocesses so the active log files are bounded (default 5MB × 5
# generations) AND each stream lands in its own file (agent.out.log /
# agent.err.log) — matching the pre-rotation layout that operators tail.
#
# Both rotators are invoked with \`--no-tee\` so they DO NOT echo back to
# stdout/stderr. The ${supervisorLabel} unit's StandardOutput/Error is pointed at
# separate wrapper.*.log files (NOT the agent.*.log paths owned by the
# rotators), so we don't get a double-write race where ${supervisorLabel}
# silently keeps appending to a rotated generation.
#
# We use named FIFOs + background rotators so we have EXPLICIT PIDs to wait
# on. Background jobs started with \`&\` set \$! reliably on every supported
# bash, so this layout is portable across bash 3.2 (macOS) and later.
_ROT_DIR=$(mktemp -d -t ai-support-agent-rot.XXXXXX)
trap 'rm -rf "\$_ROT_DIR" 2>/dev/null || true' EXIT
mkfifo "\$_ROT_DIR/out" "\$_ROT_DIR/err"
ai-support-agent log-rotate --no-tee ${qOutLog} < "\$_ROT_DIR/out" &
_ROT_OUT_PID=$!
ai-support-agent log-rotate --no-tee ${qErrLog} < "\$_ROT_DIR/err" >&2 &
_ROT_ERR_PID=$!

${dockerRunLine}

# Redirecting to a FIFO does not propagate the rotator's exit into \$?,
# so EXIT_CODE is purely docker's exit status. The exit-42 update path is
# preserved (the rotator can never mask it).
EXIT_CODE=$?

# Wait on the rotators explicitly so they drain their FIFO before the
# wrapper exits (${supervisorLabel} will SIGKILL stragglers otherwise). docker
# closed its write end on exit, so each rotator sees EOF on stdin and
# exits naturally; the wait is bounded by pipe-buffer drain time.
wait "\$_ROT_OUT_PID" "\$_ROT_ERR_PID" 2>/dev/null || true
`
}
