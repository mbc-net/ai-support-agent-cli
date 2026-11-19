# Transactional SSH source policy helper

This helper is shipped with the resident agent and invoked only by the dedicated
`ssh_source_ip_inspect` / `ssh_source_ip_sync` handlers. Recipes do not receive the
confirmation nonce or choose a command to execute. The runner uses a new SSH
connection for each operation, private-key authentication only, and a registered
SHA256 host-key pin. The confirmation nonce exists only in the running agent;
the root-owned server state stores its SHA256 hash.

Supported targets are Ubuntu with an active `ssh.service`, non-socket-activated
OpenSSH and active UFW with IPv6 enabled and default-deny incoming traffic.
Custom UFW base files, unrecognized input chains, complex/ambiguous SSH rules,
port ranges, and source-dependent SSH `Match` configurations for key-only mode
are rejected for manual review. The standard systemd launch path and actual
daemon executable, arguments and `SSHD_OPTS` must also match the supported
configuration. The reload command must be the standard sshd validation plus
HUP signal, with no service drop-ins; a custom `-o`/`-f` cannot bypass the effective-authentication check.
The initial inspection returns the precise SSH
rules to adopt. Automatic revisions accept only the exact rule set recorded by
the previous successful transaction; external changes stop the update.

`/var/lib/ai-support-agent/ssh-policy/attempt.json` is canonical. Every operation
uses the same `flock` (`lock`), including deadline and boot recovery. Snapshots,
intent, versions, target identity, deadlines and nonce hash are fsync'ed before
changing SSH/UFW. `attempts/<id>.json` is a repairable historical projection.
Replays read the existing receipt; a recovered attempt is never reapplied.
`managed.json` marks an active source restriction for cooperating setup recipes;
`owner.json` prevents another project/host alias taking over key-only or source
management. Failed release retains the previous marker and rules. Source release
retains ownership while key-only management remains enabled.

A persistent systemd boot service and a per-attempt 600-second monotonic timer
restore the snapshots independently of the API and agent. Apply subprocesses
share a 180-second total budget; recovery has its own 120-second budget, so a
long UFW update cannot hold the transaction lock past the 600-second timer.
Timed-out process groups are killed before recovery starts. Confirmation rejects
expired, rebooted, mismatched, foreign-source, old-version and wrong-nonce
requests. It checks both wall-clock and kernel-uptime deadlines. A terminal
receipt repairs marker/history writes after a crash. Ordinary API result loss is
handled through the agent's existing durable pending-result store; unresolved
server transactions remain `pending` and reconciliation reads the same attempt.
After rollback, later revisions compare against the successful attempt referenced
by the restored managed marker. A separate delayed command cannot decrease either
server-observed policy or definition version; replaying the same attempt only
returns its recorded outcome.

Only the dedicated confirmation connection retries transient transport failures
before SSH authentication: at most three new clients within 20 seconds (at most
10 seconds each, including SOCKS setup). Host-key rejection, authentication
failure and disconnects after the remote command starts do not retry. The same
attempt, version and nonce are used; apply is never repeated. Exhaustion leaves
the transaction pending for recovery. This handles the listener restart interval
after `sshd` reload without accepting stale or weaker proof.

## Verification

- `npm run test:ssh-policy`: parsing, confirmation, ownership and crash recovery.
- `npx jest --selectProjects unit --runInBand __tests__/ssh-source-ip-sync.spec.ts __tests__/ssh-source-ip-transport.spec.ts`: pinned fresh connections, attempt replay, failed verification, pending recovery and inspection completion.
- `tests/live_container.py HOST PRIVATE_KEY KNOWN_HOSTS`: **disposable fixture only**.
  Requires a separately prepared Ubuntu systemd/UFW/OpenSSH target with broad
  SSH allows and unrelated 443/tcp rules. Executes real IPv4/IPv6 adoption,
  fresh SSH confirmation, automatic revision, timer-service rollback, successful
  release and independent key-only configuration. It deliberately changes the
  fixture's SSH firewall. It is not part of ordinary unit test discovery.

See [the validation record](tests/VALIDATION.md) for separate real systemd-container
and isolated QEMU guest results, including a real guest reboot. A successful
Agent connection does not guarantee that the administrator can connect.
