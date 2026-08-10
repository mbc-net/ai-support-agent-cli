/**
 * Thin developer-only CLI bootstrap for a local server-setup run.
 *
 * Deliberately NOT wired into `src/index.ts`'s customer-facing commander surface
 * — it is a dev tool invoked via the `server-setup:local-run` npm script. All
 * logic lives in (and is unit-tested through) `./server-setup-local-run`; this
 * file only parses `process.argv`, invokes the logic, prints the formatted
 * result, and sets the process exit code.
 *
 * Usage:
 *   npm run server-setup:local-run -- \
 *     --body ./recipe.yml \
 *     --host 203.0.113.10 --user ubuntu --key ./id_rsa \
 *     [--port 22] [--auth-type privateKey|password] \
 *     [--extra-vars ./vars.json] [--secret-names A,B] [--ssh-host-id my-host] \
 *     [--strict]
 *
 * The SSH private key / password is supplied ONLY via `--key <path>` (a file) —
 * there is deliberately no inline flag, so the secret never appears in argv
 * (`ps` / `/proc/<pid>/cmdline` / shell history).
 *
 * When `--extra-vars` is given WITHOUT `--secret-names`, those values are not
 * `no_log`-annotated or redacted and may print in plaintext; a warning is
 * emitted to stderr in that case (the run still proceeds — this is a dev tool).
 */

import { formatLocalRunResult, parseLocalRunArgs, runServerSetupLocalRun } from './server-setup-local-run'

async function main(): Promise<void> {
  const options = parseLocalRunArgs(process.argv.slice(2))
  const result = await runServerSetupLocalRun(options)
  // eslint-disable-next-line no-console
  console.log(formatLocalRunResult(result))
  process.exitCode = result.success ? 0 : 1
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
