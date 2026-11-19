# SSH policy validation record (2026-11-19)

Worktree: `agent-worktrees/source-ip-sync`, based on agent `e5e0ca2`.
No production target, API deployment, commit, or merge was used.

## Automated checks

- New Python helper tests: 22 passed (CIDR validation, IPv4/IPv6 UFW parsing,
  all-chain runtime drift/default policy comparison, included `Match` / `Match=`
  rejection, proof expiry/identity/nonce, durable receipt repair, ownership,
  rollback baseline reuse, kernel-forwarding-disabled defaults, delayed stale
  commands and bounded subprocess/recovery budgets).
- Dedicated runner and API-client suites: 160 passed. Covers fresh pinned
  connections, nonce binding, replay, lost replies, pending reconciliation,
  inspection success/failure, durable dedicated result submission and bounded
  pre-auth transport retry (fatal host-key/auth failures do not retry).
- TypeScript production build: passed.
- Full `npm test -- --runInBand`: 347 suites passed; 25 failed under sandbox
  restrictions (local listeners, process listing, npm cache). Re-ran exactly
  those 25 suites outside the sandbox: **25 suites / 715 tests passed**.
  The initial full run had 10,432 tests (29 skipped); these retries resolve its
  failures. A detached original-HEAD run independently reproduced the 12
  project-agent failures within the sandbox before the escalated retry passed.
- Package test passed; `ansible/ssh-policy/tests/**` is excluded from publication.

## Real Ubuntu/systemd container

A new disposable Ubuntu 22.04 container, separate SSH client container and fresh
fixture keys were used. The target used stock UFW/OpenSSH, both IP families,
broad SSH rules and an unrelated 443/tcp allow. The following passed:

1. Existing broad IPv4/IPv6 SSH rules were removed and the selected sources
   installed. A new SSH session confirmed with the nonce; unrelated 443 survived.
2. A subsequent definition revision used the exact persisted managed rules.
3. The installed recovery service restored a pending release. Replaying that
   recovered attempt did not reapply it. Explicit successful release removed
   the source marker; key-only operation left firewall files byte-identical.
4. **Actual 600-second timer:** the applied sources deliberately excluded the
   client. New SSH connections failed. Without Agent/API involvement the server
   timer restored the snapshot and fresh SSH resumed; receipt was `recovered`.
5. A pending attempt survived container restart and was recovered by the enabled
   boot service (exit 0). This proves the boot service wiring, not host-VM reboot.
6. Four simultaneous confirm/recover races settled consistently with actual
   firewall rules: one `succeeded`, three `recovered`. No committed-and-restored
   state was observed. Later attempts after recovery used the prior successful
   marker's historical baseline.
7. Runtime-only ACCEPT injection into before/user/after chains and runtime
   INPUT default-policy changes were rejected for IPv4 and IPv6 (8 cases).
8. Custom real daemon SSHD_OPTS, ExecStart arguments and no-op ExecReload
   overrides were rejected before any policy mutation; restoring the standard
   service passed inspection.
9. The **exact** Rundeck firewall shell extracted from the companion maintenance
   worktree ran while managed. It preserved IPv4/IPv6 SSH restrictions and did
   not add a global SSH rule; unrelated 80/443 remained available.

Scripts: `live_container.py` and `live_race.py`. They accept target, fixture key,
known_hosts and optional port. They deliberately modify a fixture's firewall;
never run them against an existing server. Private keys remain only in disposable
containers, outside this repository.

## Isolated QEMU guest

A separate, resource-limited Docker container (`--cpus=2 --memory=2g`) is used as
an unprivileged QEMU host. It runs Ubuntu's official Jammy ARM64 cloud image under
`qemu-system-aarch64` TCG with 2 vCPUs and 1 GiB guest RAM. QEMU user networking
exposes guest SSH only to the container loopback. This guest has its own kernel
and boot ID, unlike the preceding systemd container.

Reproduction outline:

1. Install `qemu-system-arm qemu-efi-aarch64 cloud-image-utils openssh-client` in
   a new disposable Ubuntu 24.04 container.
2. Download `jammy-server-cloudimg-arm64.img` and `SHA256SUMS` from the same
   dated build. This run used `https://cloud-images.ubuntu.com/jammy/20261109/`
   and verified SHA256
   `e429865ad84a083a84fdbd51bf6fd6e4174bbb1610ba0d72ca01014c656d45bc`.
3. Generate a disposable SSH key. Make a cloud-init seed with root key login,
   OpenSSH port 2222, `ufw python3 sudo`, deny incoming, and initial 2222/443
   permits. Use `cloud-localds` and grow the guest disk to 8 GiB.
4. Boot QEMU with `-machine virt -cpu cortex-a72 -smp 2 -m 1024`, AAVMF firmware,
   virtio qcow2 and seed disks, `-netdev user,id=n,hostfwd=tcp:127.0.0.1:2222-:2222`,
   and a virtio network device. Keep serial output as test evidence.
5. Register the fixture host key, install the helper via SSH, then run the same
   scripts with host `127.0.0.1` and port `2222`. Record the guest boot ID before
   and after a real `systemctl reboot` with a pending transaction.

Guest results (Ubuntu kernel `5.15.0-203-generic`):

- Broad IPv4/IPv6 SSH adoption, unrelated 443 preservation, fresh confirmation,
  subsequent definition change, recovery-service rollback and explicit release passed.
- Key-only reload initially reproduced a fresh-connection reset twice. Both
  attempts stayed pending and recovered safely. The bounded dedicated-confirmation
  retry was then implemented and the actual built Agent runner passed key-only
  confirmation, byte-identical firewall preservation and lost-result replay.
- The final helper, including actual daemon launch and reload validation, passed
  inspection through the actual built Agent runner on the standard guest service.
- A pending transaction survived a real guest `systemctl reboot`. Boot IDs changed
  from `42c04100-82ac-4c18-adbe-2f7795c36b50` to
  `1d836644-d908-4eeb-ad6a-d78330f429cc`; the independent boot service recovered.
  Replaying the recovered attempt did not reapply it. A new policy/definition
  version then confirmed, and its durable receipt reconciled a lost result.
- The latest exact Rundeck **firewall shell stage** preserved both source restrictions
  on guest port 2222, added no global SSH permit, retained 80/443 and emitted
  `SSH_SOURCE_POLICY_MANAGED`. This was not a full Rundeck installation rerun;
  that recipe retains its existing whole-recipe port-22 prerequisite.

- A simultaneous confirm/recover race settled as `recovered`; an independent
  locked status read and actual UFW listing agreed: the attempted 192.0.2.20
  source was absent, previous IPv4/IPv6 restrictions and unrelated 80/443 remained.
  The controller was paused after launching both contenders to avoid starting
  further cases, then stopped only after terminal-state verification.

The actual 600-second wait was measured in the systemd container; the guest used
recovery-service invocation plus real guest reboot, rather than another ten-minute wait.
Reusable fixtures include `live_agent_driver.js`, `live_reboot.py`, `live_race.py`
and `live_daemon_options.py`. Fixture keys are excluded from the repository.

All five disposable fixture containers were stopped after verification. No fixture
private key was added to the repository. Final `git diff --check` passed.
