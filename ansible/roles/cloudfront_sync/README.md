# CloudFront origin-facing range synchronization

> **Stage S0: the runtime actor is not connected.** This role currently
> installs nothing and no synchronization, firewall change or nginx change can
> run. The runtime is being connected in reviewed stages; see the admin-docs
> specification `docs/specifications/server-setup-cloudfront-sync.md`, section
> "ランタイム接続の段階（S0–S8）" (`#runtime-connection-stages`). Do not use this
> role on an operational host to synchronize CloudFront ranges yet.

This document describes what the code does in S0 and S1: the S0 refusal state
(every non-read command refused, nothing installed) plus the S1 read-only
observation (`inspect-runtime`'s firewall and nginx observation and admission,
the shared lock of inspections and the guardian). Behaviour planned for later
stages is named as such and is not available.

## Role behaviour in S0

The role (`tasks/main.yml`) first runs `install_cloudfront_sync.py --validate-only`
with the payload built from the role variables. That payload still has the
pre-C4 schema (no `version`, four legacy assets), so the installer refuses it as
`invalid_candidate_schema` and prints only the generic
`{"error": "candidate_validation_or_installation_unavailable"}`. The play
therefore fails at the validation task and the host is not changed.

Even for a valid new-schema candidate, the installation step itself is closed:
without `--validate-only` the installer exits 1 with
`{"error": "cohort_installer_unavailable"}`. The installer is connected again in
stage C4, after the CLI contract is frozen.

The public variables and defaults are in `defaults/main.yml`. Project variables
arrive as strings: use `from_json` for JSON booleans, numbers and arrays.

## CLI (`files/cloudfront-sync.py`)

The CLI is root-only and uses the fixed config path
`/etc/cloudfront-sync/config.json`. Only three subcommands run; each first
authenticates the bundled code generation and validates the config. Every
string in the config (keys and values) must be ASCII, and `host_address` must
be an IP address without an IPv6 scope id (`fe80::1%eth0` is rejected); a
rejected config fails as `sync_failed`.

- `verify-cohort`: authenticates the installed bundle generation. It takes the
  exclusive lock `/run/lock/cloudfront-sync.lock` (creating it if absent) and
  reports `cohort_verified: true` with `runtime_ready: false` and
  `policy_verified: false`. It is not a policy or health check.
- `inspect-state`: reads the private state under
  `/var/lib/cloudfront-sync/private` and reports dispositions only. It never
  creates the lock: it opens the existing lock and takes it shared, or, when
  given an inherited `--lock-fd`, takes that descriptor exclusive (see the
  lock table below). It never creates directories. Only the
  absence of `private` itself below an intact parent is a disposition
  (`private_directory_absent`); an absent, non-directory or unreadable parent,
  and a private file or name that changes while it is read (the directory is
  listed again after every file has been reread), including `private` itself
  replaced between its check and its open and a file that grows past its
  checked size while it is read, fail as `sync_failed`. Replacement is
  decided by identity, never by an error number: the listing records the
  lstat of each known name, and a name that is not a safe regular file there
  (symlink, directory, FIFO, socket, owner, mode, link count, size) is unsafe,
  while a name whose lstat later differs from the listing's (rebound or
  removed before or during its read or reread) is a change. After a failed
  open or read the name (or `private` itself, after its failed open) is
  lstat-ed again: gone or different is a change, unchanged is the I/O failure
  itself. Every one of these fails as `sync_failed`.

  Whether a missing `state.json`/`journal.json` is reported as `absent`
  depends on how far the read got (the same values in `inspect-state`'s
  `state_disposition`/`journal_disposition` and `inspect-runtime`'s
  `state`/`journal`):

  | Private state disposition | Read of the files | State | Journal |
  |---|---|---|---|
  | `private_directory_absent` | the directory does not exist | `absent` | `absent` |
  | `unknown_private_entries_manual` | listed only, no file read | `not_read` | `not_read` |
  | any other disposition | every file read and parsed | the parsed disposition, or `absent` when the file does not exist | the parsed disposition, or `absent` when the file does not exist |

  `absent` therefore always means the file does not exist; with unknown
  entries a `state.json` or `journal.json` may exist and is `not_read`. A
  read that fails prints no dispositions (`sync_failed`).
- `inspect-runtime`: read-only observation of the firewall and nginx with an
  admission result per component, plus an unverified project-context
  observation, reported as fixed status codes (`runtime_ready: false`). It
  locks like `inspect-state`: the existing lock opened by itself shared, an
  inherited `--lock-fd` exclusive, never creating the lock. The
  nginx component (see "nginx observation" below) is measured on the host and
  reported as `nginx_policy_verified`, `nginx_policy_unsupported`,
  `nginx_sandbox_unavailable` or `nginx_observation_failed`
  (`not_applicable` when nginx is disabled). The
  state's baseline is used for admission only when the whole private
  namespace is data-only (private state disposition `pt_state_data_only`);
  with a journal, a pending or companion file, unknown entries or a legacy
  state there is no baseline (the firewall reports `baseline_required` or
  another failure, never admission). The config hash is computed only with
  that baseline and is then compared with it; it is the
  bundled `cloudfront_snapshot` module's public `config_hash` (SHA-256 of its
  canonical config JSON), the same function the ledger uses.

### nginx observation

`inspect-runtime` (and the guardian's shared snapshot) observe nginx with
`nginx_observation.Collector`, read-only, when `nginx.enabled` is true; with
nginx disabled nothing is read and the component is `not_applicable`. The
guardian's part is wiring only: its `main` stops with
`guardian_components_not_connected` (reported as `guardian_not_ready`) right
after authenticating the bundle under the shared lock, before taking any
snapshot, so it does not monitor nginx (or anything else) yet. The
configured `nginx.shared_dir` and `nginx.bundles` are passed as they are. If
the Collector refuses them at construction (for example a `shared_dir` with
a trailing `/` or a `.` component, a relative path, a duplicated bundle or a
bundle file that is one of the shared include files), only the nginx
component fails, as `nginx_observation_failed`, with nothing read or run;
the firewall component is still observed.

- Preconditions, checked before any command or file read: Linux, root, the
  default `SIGCHLD` handler, and `/usr/bin/systemd-run`, `/usr/sbin/nginx`
  and `/usr/bin/systemctl`, each checked at that absolute host path (the
  executables that run, never a copy under another root): reached through
  `O_NOFOLLOW` directories owned by root (uid 0) and not group/world
  writable, a regular executable file owned by root (uid 0) and not
  group/world writable. The executables' owner is fixed at uid 0; the
  Collector's `owner` applies to the managed files only (a managed file of
  another owner is `nginx_observation_failed`, not
  `nginx_sandbox_unavailable`). And `/run`, `/var/log/nginx` and
  `/var/lib/nginx` (the host targets of the sandbox's
  `TemporaryFileSystem=`, see below) are each a directory itself (`lstat`:
  a symbolic link, even to a directory, is refused).
  Otherwise, or if any of these checks itself fails, the result is
  `nginx_sandbox_unavailable`; nginx is never run outside the sandbox (there
  is no unsandboxed fallback).
- Each of two passes reads `/usr/lib/os-release`, runs
  `systemctl show --property=Id,LoadState,ActiveState,SubState,MainPID,ExecStart
  nginx.service` (a read of the service manager, not sandboxed), runs
  `nginx -T -q` only as
  `systemd-run --quiet --wait --pipe --collect --service-type=exec` (systemd
  names the transient unit, so two runs never collide on a fixed name; stdin
  is left to `--pipe`) with `ProtectSystem=strict`, `PrivateTmp=yes`,
  `TemporaryFileSystem=/run /var/log/nginx /var/lib/nginx
  /dev/shm /dev/mqueue /dev/hugepages /dev/pts` (`PrivateDevices=yes` alone
  keeps the host's instances of those four `/dev` directories),
  `BindReadOnlyPaths=-/run/systemd/resolve` (the host's systemd-resolved
  directory, read-only, when it exists: `/etc/resolv.conf` points there on
  Ubuntu, so names in the configuration resolve), `NoNewPrivileges=yes`,
  `PrivateDevices=yes`, `PrivateIPC=yes`,
  `ReadOnlyPaths=/proc/sys -/proc/sysrq-trigger /sys /sys/fs/cgroup`
  (readable, not writable, as with `ProtectKernelTunables=`: reads such as
  OpenSSL's `/proc/sys/crypto/fips_enabled` behave as in nginx's own reload;
  `/proc/sysrq-trigger` optional for kernels without `CONFIG_MAGIC_SYSRQ`,
  the other three mandatory),
  `InaccessiblePaths=` (the non-process entries of `/proc` collected on
  three aarch64 VMs, Ubuntu 22.04, 24.04 and 26.04, and one amd64 host,
  common-sv on 26.04, plus `apm`, `asound` and `timer_stats` of systemd 249's
  `ProtectKernelTunables=` table; `/proc/kcore`, `/proc/kallsyms`,
  `/proc/meminfo` and `/proc/dma` among them; each optional with a leading
  `-`; not hidden: `self`, `thread-self`, the links `mounts` and `net`,
  `kmsg`, which `ProtectKernelLogs=` hides, and the read-only `sys` and
  `sysrq-trigger`; no path is in both lists, since systemd keeps one mount
  per path and would drop the other entry with its mandatory flag),
  `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
  AF_NETLINK` (`AF_NETLINK`: glibc's `getaddrinfo` reads the configured
  addresses through it for nginx's `AI_ADDRCONFIG`; without it the resolved
  address families differ from those of nginx's own reload),
  `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`,
  `ProtectClock=yes`, `ProtectHostname=yes`,
  `RestrictNamespaces=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`,
  `RestrictRealtime=yes`, `SystemCallArchitectures=native`,
  `SystemCallFilter=@system-service`,
  `CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH
  CAP_SETUID CAP_SETGID` (no `CAP_SYS_ADMIN`, `CAP_KILL` or
  `CAP_SYS_PTRACE`, no ambient capabilities) and `RuntimeMaxSec=15` (the
  argv is a fixed constant checked against an allow list, one argv for every
  OS; every property exists in systemd 249, Ubuntu 22.04's). The same argv
  was verified on Ubuntu 22.04 (systemd 249), 24.04 (systemd 255) and 26.04
  (systemd 259) VMs: `nginx -T -q` exits 0 with the same dump as unsandboxed,
  `/run` is a private tmpfs, `/proc/sys` is readable but not writable,
  `/sys` and the cgroup tree are not writable, with nginx stopped the host is
  unchanged (no `/run/nginx.pid`, the nginx log and state directories
  untouched, an absent `/var/cache/nginx` not created), two concurrent runs
  succeed and no transient unit is left behind.
  `TemporaryFileSystem=` creates a missing target directory on the host file
  system before mounting over it (measured on all three VMs with
  `/var/cache/nginx` absent: the host then had an empty `/var/cache/nginx`).
  Its targets are therefore only `/run`, `/var/log/nginx` and
  `/var/lib/nginx`, each checked to be a directory itself (`lstat`, a
  symbolic link refused) with the preconditions above
  (`nginx_sandbox_unavailable`) and again right before every start (one
  that no longer is: `nginx_observation_failed`, the unit is not started), and
  the four `/dev` directories, which are created in the private `/dev` of
  `PrivateDevices=yes`. `/var/cache/nginx` is not a target (Ubuntu's nginx
  keeps nothing there and it may be absent, as on common-sv): under
  `ProtectSystem=strict` it is read-only. So on a host whose configuration
  puts `proxy_cache_path` or a `*_temp_path` (`client_body_temp_path`,
  `proxy_temp_path` and the like) under `/var/cache/nginx`, `nginx -T`
  fails inside the unit with `EROFS` and the result is
  `nginx_observation_failed` (Ubuntu's default configuration and
  common-sv's do not). Their parents (`/var/log`,
  `/var/lib`) cannot be the targets instead: `nginx -T` then fails, as
  `/var/log/nginx` and `/var/lib/nginx` are missing inside the unit.
  `ProtectProc=`, `ProcSubset=`, `ProtectKernelTunables=` and
  `ProtectControlGroups=` are deliberately not used: each implies
  `MountAPIVFS`, and on systemd 249 the resulting `/run` API mount takes
  precedence over `TemporaryFileSystem=/run` and leaves the host's `/run` in
  place (measured on 22.04: `nginx -T` left an empty `/run/nginx.pid` on the
  host). `ReadOnlyPaths=` and `InaccessiblePaths=` write their effect out
  instead, with these limits: there is no equivalent of `ProtectProc=`
  (measured: this root unit saw every `/proc/<pid>` with
  `ProtectProc=invisible` too); the `/proc` list is fixed (the entries
  sampled on the four machines above), so an entry a future kernel adds, or
  one that only other hardware has, is not hidden automatically: it stays
  visible (fail-open: readable, and writable only where the kernel itself
  makes it so) (`/proc` is the host's procfs, not a `subset=pid` instance);
  the `/proc` entries of systemd's tables are copies, so whatever a future
  systemd adds to them is not picked up.
  The sandbox is only started with the whole per-command timeout left in
  the collection budget (otherwise `nginx_observation_failed`): a shorter
  client timeout would kill `systemd-run` alone while its unit runs on.
  `systemctl show` is given at most 5 seconds. Each pass therefore runs two
  commands with a timeout, and the Collector accepts only a per-command
  (sandbox) timeout of at least 20 seconds (`RuntimeMaxSec=15` plus 5) and a
  whole timeout of at least twice the sum of the two (per-command plus 5)
  plus 10 seconds, `whole >= 2 * (command + 5) + 10` (defaults 20 and 60,
  the smallest such pair; both at most 120, so the per-command timeout is at
  most 50); anything else is `nginx_collector_invalid`.
- Threat model of that sandbox. Its purpose is that `nginx -T`'s incidental
  side effects (the error log, pid file and temporary directories it opens
  or creates, shared memory, IPC objects) leave the host unchanged. It
  prevents: writes to the file system outside `/proc` (the file system is
  read-only and the writable places are private and discarded with the
  unit, the shared areas of `/dev` included: `/dev/shm`, `/dev/mqueue`,
  `/dev/hugepages`, `/dev/pts`, so no host pty can be opened either; no
  missing `TemporaryFileSystem=` target is created, see above, short of the
  start race under the residual risks below), System V
  and POSIX IPC with the host (a private IPC namespace: no host object is
  visible, none created reaches the host), reading the non-process entries
  of `/proc` in the fixed list (`InaccessiblePaths=`), writes to kernel
  tunables, `/proc/sysrq-trigger`, `/sys` and the cgroup tree
  (`ReadOnlyPaths=`) and socket families other
  than the four above (for example `AF_PACKET`). It does not prevent:
  writes to the writable files under `/proc/<pid>/` (for example
  `oom_score_adj`; `/proc` is the host's procfs and only the paths listed
  above are read-only or hidden); the temporary host directories of
  `PrivateTmp=yes` (systemd creates a `systemd-private-*` directory in the
  host's `/tmp` and `/var/tmp` for the unit and removes it when the unit
  ends);
  signals to processes of the same uid, root (systemd 249 has no PID
  namespace for units; `PrivatePIDs=` needs a newer systemd); reading
  another process's `/proc/<pid>` (no `ProtectProc=`; it would not hide
  them from this root unit anyway, the kernel exempts group 0 from
  `hidepid`); reading a `/proc` entry that is not in the fixed list (one a
  future kernel adds or only other hardware has; it is not hidden
  automatically); network
  connections (`PrivateNetwork=` and `IPAddressDeny=localhost` would break
  resolving upstream names through the `127.0.0.53` stub); reading files
  root may read. It is not meant to contain a hostile module or
  configuration: modules loaded by `load_module` and the initialisation code
  of embedded perl or lua run as root inside the unit, and nginx runs the
  same code as root, unsandboxed, on every reload of the same configuration,
  so containing them during `nginx -T` would protect nothing. The sandbox is
  what keeps `nginx -T`'s incidental writes off the host, which is why it is
  a precondition and there is no unsandboxed fallback.
  Residual risks of rare timing, accepted and not removed structurally: the
  per-command timeout does not guarantee that no unit outlives the
  Collector. `RuntimeMaxSec` counts only from the unit's start, so when
  PID1 is busy and the client (`systemd-run`) is killed by its timeout
  before the unit has started, the unit may still start afterwards and run
  for up to `RuntimeMaxSec` unwatched by the Collector (its `PrivateTmp=`
  directories staying on the host meanwhile). And between the directory
  check right before the start and the start itself, a target removed by
  something else (for example `apt purge nginx` removing `/var/log/nginx`
  or `/var/lib/nginx`) is created again, empty, on the host by systemd's
  `TemporaryFileSystem=`.
- It then reads the managed files: the two
  shared include files in `nginx.shared_dir` and every bundle file. Managed
  files are opened through
  `O_NOFOLLOW` directory descriptors from `/` (no symbolic link anywhere on
  the path, the bundle file itself included); every directory is owned by root
  and not group/world writable, so every ancestor directory of a bundle file
  (and of the shared include files) must be owned by root; each file is a
  regular file owned by root,
  not group/world writable, with one link and at most 2 MiB, and its identity
  is the same before and after the read. Every section of the dump that names
  a managed path must hold exactly the bytes read from it, and every section
  must lex with nginx's rules. Both passes must be
  identical: their raw evidence (os-release values, the `systemctl show`
  properties, the dump, nginx's stderr and the managed files' bytes) is
  compared first, and only identical passes are parsed, once (the binding of
  the dump to the managed bytes and its lexing above). Limits: 20 s (the sandbox; 5 s for `systemctl show`) and 4 MiB
  per command, 60 s and 16 MiB for the whole observation.
- `nginx -T -q` is accepted only with exit 0 and a stderr made only of
  complete `nginx: [warn] ` lines (only their count is kept, privately).
  Every other outcome is `nginx_observation_failed`: any non-zero exit
  whatever its cause (the configuration, the sandbox, systemd or a signal;
  nginx's failures are deliberately not classified further, so a failure
  caused by the sandbox or systemd is never reported as a configuration
  error; the cause is read from nginx's and systemd's own logs), any other
  stderr, a timeout, an exceeded budget, unstable passes, an unsafe or
  changed file, a dump that does not hold the managed bytes and a dump that
  cannot be parsed (for example `nginx_lexer_unsupported` for a
  `*_by_lua_block` or another lexical refusal of `parse_dump`; those codes
  are not printed). A successful observation is `nginx_observed` (not
  printed: the admission below decides).
- Admission (`admit_policy`): only an observation that `Collector.collect()`
  returned, unchanged (a hand-made one, `dataclasses.replace`, a copy, a deep
  copy or an unpickled clone is refused), whose `shared_dir` and bundles are
  the ones the Snapshotter was configured with; Ubuntu 22.04, 24.04 or 26.04,
  `nginx.service`
  `LoadState=loaded`, `ActiveState=active`, `SubState=running` with a main PID,
  started by the packaged command line, and the dump-wide address policy
  (shared include files, bound geo block, realip include and trust rules) over
  the dump parsed again from the observation's bytes. Passing is
  `nginx_policy_verified`; any violation is `nginx_policy_unsupported`.
  The command line is `systemctl show`'s `ExecStart`
  (`{ path=... ; argv[]=... ; ignore_errors=... ; ... }`, the argv joined by
  spaces without quoting, as systemd 249, 255 and 259 print it): exactly one
  command, path `/usr/sbin/nginx`, argv `/usr/sbin/nginx` or Ubuntu's
  packaged `/usr/sbin/nginx -g daemon on; master_process on;`. Any `-c`,
  `-p`, other `-g` or other option (for example from a drop-in) makes the
  daemon read another configuration than the one `nginx -T` dumped, and is
  `nginx_policy_unsupported`; so is an `ExecStart` that cannot be parsed in
  that format. `ExecReload` is not read (a reload signals the master, which
  rereads the file it was started with).
  `nginx_policy_verified` is a verdict on the default configuration on disk
  (`/etc/nginx/nginx.conf` and what it includes, as `nginx -T` read it). It
  does not prove that the running master uses that configuration: changes
  not yet reloaded, or a master whose configuration differs from the files
  (one started by hand, for example), are not detected.
- Nothing is written, persisted or printed but the `{status, code}` pair:
  configuration text, secret values, paths (`shared_dir` and the bundle
  paths included), nginx's stderr and the warning count stay in the
  in-memory observation (omitted from its representation, which shows only
  the OS version) and never reach an exception, stdout or stderr. The ledger
  accepts nginx evidence only as the input `nginx_ledger_input` returned (from
  an admitted component, or `not_applicable` for a disabled nginx), the same
  instance and unchanged (a hand-made or copied dict is refused with
  `ledger_nginx_not_issued`), as `nginx_observed` for an enabled nginx, with
  the observation's `shared_dir` equal to the configured `nginx.shared_dir`
  (`ledger_nginx_shared_dir`) and its bundles equal to the configured
  `nginx.bundles`, pair for pair (`ledger_nginx_bundle_evidence`). Its shared
  include bytes must parse as the two shared files (`parse_shared`: their
  format and the same ranges in both, `ledger_nginx_shared_invalid`), both
  when the ledger is compiled and when `validate_ledger` rebuilds it from its
  own digests; the bundle bytes of a rebuilt ledger cannot be checked again
  (the dump they were bound to is not kept), only their paths. The current
  nginx component given to `classify_frontier` is held to the same rules: an
  input `nginx_ledger_input` returned, unchanged, of the ledger's configured
  `shared_dir` and bundles; anything else classifies as `manual_divergence`.
- The bundle files are whole nginx configuration files and may hold the
  origin verification secret (for example the `map` of the origin header).
  Their bytes are kept in the ledger's `before_bundles`, in plain text, in
  the journal. Its storage is therefore a precondition: the journal lives in
  `/var/lib/cloudfront-sync/private` (owned by root, mode `0700`), each file
  in it owned by root with mode `0600` (the private state reader refuses any
  other owner or mode), and it must not be copied to a place readable by
  anyone else.

Status: unit-tested with a fake command runner and temporary file trees,
verified on Ubuntu 22.04, 24.04 and 26.04 VMs (see above), and exercised
against a real nginx by the molecule scenario (Ubuntu 24.04 container; see
Verification).

Locking of `/run/lock/cloudfront-sync.lock` (`flock`, always non-blocking:
a conflicting holder makes the command fail at once, it never waits):

| Caller | Descriptor | Lock |
|---|---|---|
| `inspect-state`, `inspect-runtime` | opened by the command itself (read-only and non-blocking, never created) | shared, `LOCK_SH\|LOCK_NB` |
| `inspect-state`, `inspect-runtime` | inherited `--lock-fd` | exclusive, `LOCK_EX\|LOCK_NB` |
| `verify-cohort` | opened by the command itself (created if absent) or inherited `--lock-fd` | exclusive, `LOCK_EX\|LOCK_NB` |
| integrity guardian (`cloudfront-integrity-guard.py`) | opened by the guardian itself (never created) | shared, `LOCK_SH\|LOCK_NB` |
| deployment (`install_cloudfront_sync.py`) | its own descriptor (created if absent), passed as `--lock-fd` only to `preflight`, `plan` and `apply` | exclusive, `LOCK_EX\|LOCK_NB` |

The deployment passes `--lock-fd` only to `preflight`, `plan` and `apply`,
which are all refused (`runtime_actor_not_connected`) before the lock is
touched. No caller passes `--lock-fd` to `inspect-state`, `inspect-runtime` or
`verify-cohort`; the inherited rows above describe what the commands do with
one, not an existing caller.

Every command checks the lock before its `flock`: a root-owned regular file
of mode exactly `0600` (as the guardian requires; `0400`, `0700` or a set-id
bit is refused) with one link, the file `/run/lock/cloudfront-sync.lock`
names. A command opening it read-only does so with `O_NONBLOCK` (like the
guardian), so a FIFO at the lock path is refused at once (`sync_failed`)
instead of blocking the open until a writer appears.

Inspections therefore run alongside each other and alongside the guardian,
and are refused (`sync_failed`) while a deployment or `verify-cohort` holds
the lock exclusively; a deployment or `verify-cohort` is likewise refused
while any shared holder exists. An inherited `--lock-fd` is never locked
shared: `flock` locks the open file description, so `LOCK_SH` on the
deployer's descriptor would downgrade the deployer's own exclusive lock.

A command that opened the lock itself checks the path again once the `flock`
succeeded: `/run/lock/cloudfront-sync.lock` must still be the file it locked
(same device, inode, file type and owner, and still a root-owned regular
file of mode exactly `0600`, with one link). A lock unlinked, or unlinked and recreated,
between the open and the `flock` would leave the command holding a lock that
no other locker sees; the command closes its descriptor (releasing that lock)
and fails as `sync_failed`. An inherited `--lock-fd` is checked against the
path once, before the `flock`; keeping that descriptor's file in place is the
caller's responsibility.

Known limitations of the locking:

- Shared holders can starve exclusive ones. Every lock is taken with
  `LOCK_NB`, and `flock` grants a shared lock while another shared lock is
  held, so if inspections and the guardian keep overlapping without a gap, a
  deployment or `verify-cohort` (exclusive, non-blocking) keeps failing.
  Waiting for and retrying the lock on the deployment side is a C4
  requirement; this role does not do it.
- A shared descriptor must not be passed as `--lock-fd`. The commands take an
  inherited descriptor exclusive; if the caller holds a shared lock on it and
  the conversion to exclusive fails, Linux has already dropped the caller's
  shared lock (its `flock` removes the old lock before trying the new one, and
  the `LOCK_NB` failure does not restore it). Passing a descriptor that holds
  a shared lock is therefore not supported; pass an unlocked or exclusively
  locked descriptor.

`inspect-state` and `inspect-runtime` never create the lock: while
`/run/lock/cloudfront-sync.lock` does not exist (for example before the first
`verify-cohort`, which creates it) they fail with the generic
`{"error":"sync_failed"}`, which does not name the missing lock. `/run/lock`
is a tmpfs, so the lock is gone after every reboot until something creates
it again; creating it at boot (a `tmpfiles.d` entry) is a C4 requirement and
is not done by this role yet.

Every other subcommand (`preflight`, `plan`, `sync`, `apply`, `import`,
`import-plan`) exits 1 with `{"error":"runtime_actor_not_connected"}` before the
root check, the lock, the bundle or the config is touched. The refusal is
decided before argparse runs: any argv token that equals one of these names, in
any position, refuses. That includes a name used as a separate option value
(`--config apply`); this over-refusal is deliberate (the safe side). A name
inside an `=` option token (`--config=apply`) is not a separate token and is
left to argparse. So the refusal is the same with any arguments (their
subparsers define no options; the former `--approve`/`--legacy-state` are not
parsed), with surplus secret arguments, with `-h`/`--help` and with global
options in front; those arguments are never parsed.

An argv without any read-only subcommand name as a token is `unknown_command`
and is not parsed either. Otherwise argparse alone decides which read-only
subcommand runs; there is no second, hand-written argv grammar. The CLI never prints argv: argparse
abbreviations are disabled, no parser has a help action (so argparse never
exits) and every argparse error is replaced by a fixed code. All error output
is a single JSON line on stderr with empty stdout:

| Case | Exit | stderr |
|------|------|--------|
| Non read-only subcommand, any arguments (including `-h`/`--help`) | 1 | `{"error":"runtime_actor_not_connected"}` |
| No subcommand name of either kind among the tokens (unknown or missing subcommand), even with `-h`/`--help` unless it is the whole argv | 2 | `{"error":"unknown_command"}` |
| Argument error of a read-only subcommand (unknown option, extra argument, `--lock-fd` not a non-negative decimal integer of at most 10 digits, any `-h`/`--help`) | 2 | `{"error":"invalid_arguments"}` |
| Failure of a read-only subcommand (not root, other config path, lock absent or held, `--lock-fd` not an open descriptor of the lock file, bundle, config, state) | 1 | `{"error":"sync_failed"}` |

A global option whose value is missing takes the next token as its value, as
argparse does: in `--lock-fd verify-cohort` and `--config inspect-state` the
subcommand is consumed and argparse reports it missing (`invalid_arguments`);
`--config verify-cohort inspect-state` selects `inspect-state` with the config
path `verify-cohort`, which then fails as `sync_failed` (only the fixed config
path is permitted).

Usage is printed (exit 0) only when the whole argv is `-h` or `--help`. It lists
every subcommand (the S0 verifier discovers them there) and no subcommand
options; help text never contains argv. `-h`/`--help` together with anything
else is never usage: it follows the table above. Command output and
configuration are never printed.

The `Host` and `Engine` classes are kept only as refusal points: any call raises
`runtime_actor_not_connected`. The former actor code was removed in S0 and is
replaced by newly reviewed components in later stages, not restored.

## Bundled units and monitoring (not aligned with the S0 CLI)

`templates/cloudfront-sync.service.j2` / `cloudfront-sync.timer.j2` run the
`sync` subcommand, which the S0 CLI refuses, and `files/zabbix-template.json`
monitors a public status file that nothing writes in S0. They are not installed
in S0 (the role refuses before installing) and are rebuilt for the connected
runtime in C4/S6. Do not import the Zabbix template or retire existing
drift/mail checks on the basis of this role.

## Verification

Unit tests (part of the CI static job, which installs ansible-core first;
`test_install_cloudfront_sync.py` evaluates the role's payload with ansible-core):

```sh
python3 -m unittest discover -s ansible/roles/cloudfront_sync/files/tests -p 'test_*.py' -v
python3 -m unittest discover -s ansible/molecule/cloudfront_sync/tests -p 'test_*.py' -v
```

The `ansible/molecule/cloudfront_sync` scenario verifies the S0 refusal state
and the S1 read-only nginx observation in one disposable privileged systemd
container (`molecule test -s cloudfront_sync`). The scenario has a single
platform, Ubuntu 24.04, so the nginx phase below runs on Ubuntu 24.04 only.
What it does not show is checked separately on Ubuntu 22.04, 24.04 and 26.04
VMs (see the nginx section): that the observer's `systemd-run` sandbox is
really isolated there (a container's systemd cannot show that), and that a
`/etc/common-sv`-style nginx configuration like the production one is
observed as expected. The container fixture under `/etc/common-sv` is a
minimal stand-in, not that configuration:

- converge runs the role and requires exactly the fixed validation refusal, then
  checks that none of the install targets in `install_targets.json` exists;
- verify (`s0_refusal_verify.py`) stages a test bundle built from the role
  files, runs every CLI subcommand discovered from the real parser, and requires
  the refusal for every non read-only subcommand in every argv shape (with and
  without its former option, with surplus secret arguments, with global
  options first) and the fixed read-only results. Its config mirrors converge
  (nginx disabled), so `inspect-runtime` reports the nginx component as
  `{"status":"not_applicable","component":"nginx"}`. After each refused
  invocation it checks the identity of the lock, the install targets and the
  secret directory; after all argv shapes of each refused subcommand and after
  each read command it compares the full snapshot, so a change is attributed
  to one subcommand. The full snapshot compares exactly: for every entry of
  the trees `/etc/ufw`, `/etc/default`, `/var/lib/ufw`, `/etc/nginx`,
  `/etc/ssh`, `/etc/systemd/system` and of every install target its content
  (or symlink target), mode, owner, inode, link count, mtime and ctime, so a
  same-content replacement, an added hard link or a touch is a change (only
  atime, which a read may change, is not compared; nor are the mtime/ctime of
  `/etc/nginx` itself, in which the verifier creates and removes its secret
  directory); the CLI lock by its lstat identity (device, inode, mode, owner,
  links, size, mtime, ctime) and content, or its absence;
  the normalized kernel rulesets (`iptables-save`, `ip6tables-save`,
  `nft list ruleset` without counter values, handles and set-element expiry, and
  `iptables-legacy-save`/`ip6tables-legacy-save`; a
  legacy command that is not installed is recorded as absent, so its presence
  must also be the same before and after); and a limited comparison of
  `/run`: only the top-level entries named `cloudfront*`, `ufw*`, `nginx*`,
  `ssh*`/`sshd*` and `xtables*`, each by presence and lstat identity (no
  content). Every other top-level entry of `/run` (its presence, name or
  metadata) and anything below any entry (for example `/run/systemd`) changes
  by itself and is not compared; nothing outside this list is compared. A
  tree entry that vanishes while it is being read fails the run with a
  message naming the tree and the entry. It removes everything
  it staged (including a lock that its `verify-cohort` call created, however
  that call ended), also on failure or on SIGTERM, SIGINT or SIGHUP. Each
  staged path is recorded before it is created. These signals are blocked for
  the whole run before anything is staged and are taken only at the safe
  points (the start of every command run, right after each created path, and
  after the cleanup of a successful run), never during cleanup; the process
  then exits with 128 + the signal number. They are unblocked only while one
  of the verifier's commands runs (a signal then only runs a recording
  handler), so the commands inherit an unblocked mask;
- after that S0 run has been cleaned up and compared with the pristine
  snapshot, the same verifier runs the S1 nginx phase in its own staging. It
  requires nginx active and the fixture ports 127.0.0.1:8101-8103 unused,
  records the transient `run-*.service` units already loaded, then stages the
  test bundle and a config with nginx enabled, a fixture under
  `/etc/common-sv/nginx` (the shared `cloudfront-geo.conf` and
  `cloudfront-realip.conf`, three geo/realip bundles whose `map` blocks each
  hold their own random per-run secret, and localhost-only server blocks on
  those ports) included from `/etc/nginx/conf.d/cloudfront-molecule.conf`,
  checks it with `nginx -t -q`, reloads nginx and waits until the fixture
  ports listen and nginx's process identity is stable. `inspect-runtime` must
  then report the nginx component `admitted`/`nginx_policy_verified`; with
  one bundle's `real_ip_recursive on` it must be
  `failure`/`nginx_policy_unsupported`, with one bundle file replaced by a
  symlink `failure`/`nginx_observation_failed`, and each restoration is
  admitted again. Every refused subcommand is run again, in every argv shape
  and with an argv secret, against the nginx-enabled config, so the bundle
  secrets sit in files that nginx -T would dump: each must refuse exactly as
  in S0 without echoing an argv or bundle secret.
  Right after `verify-cohort`, each `inspect-runtime` and each refused
  subcommand (before any cleanup), the host must equal a baseline taken
  after the last staging step: the S0 full snapshot without any relaxation
  (so including `/etc/nginx/conf.d`'s own times and `/run/nginx.pid` by full
  identity, the install targets with the staged bundle, the config and the
  state directory including its private namespace, and the lock) plus the
  `/etc/common-sv` fixture tree; `verify-cohort` may only create an absent
  lock. Around each `inspect-runtime` and refused subcommand while nginx
  runs, nginx's process identity must not change: systemd's `MainPID`, start
  timestamp and restart count, `/run/nginx.pid` by lstat identity (inode,
  size, mtime, ctime, ...) and content (which must name `MainPID`), the
  master's start time and the set of its children. So a restart, a reload
  (new workers) or a signal with such an effect (SIGHUP, SIGWINCH, SIGQUIT,
  SIGUSR2) fails; a signal without one (SIGUSR1) is not observable this way.
  With nginx stopped, `inspect-runtime` must be
  `failure`/`nginx_policy_unsupported`, journal entries after a cursor taken
  right before that call must show its sandbox running `nginx -T`, nginx must
  stay stopped and the host unchanged: the baseline above plus no
  `/run/nginx.pid` created, `/var/log/nginx`, `/var/lib/nginx`,
  `/var/cache/nginx` (including whether it exists), `/dev/shm` and the
  watched `/run` entries, and `/tmp` and `/var/tmp` by their entries and
  content (their own mtime/ctime change with the sandbox's `PrivateTmp`
  directory). After every `inspect-runtime`, running or stopped, no
  `run-*.service` unit may be loaded that was not loaded before the phase.
  Before cleanup, no secret (bundle or argv) may appear in any command's
  output or in the content of any file below `/var/lib/cloudfront-sync`,
  `/var/log/nginx`, `/tmp`, `/var/tmp`, the install targets, the lock or the
  watched `/run` entries (the staged fixture files, which hold them by
  design, are excluded), nor anywhere in the whole journal
  (`journalctl --sync`, then `journalctl -o export`, every field); the
  journal must show the phase's nginx stop job and sandbox units, so a
  silent journal cannot pass. `nft list ruleset` is normalized by dropping
  only the counter values (`counter packets N bytes M` becomes `counter`), so
  an added or removed counter is still a change.
  Cleanup removes the fixture and restarts nginx (synchronously) onto its
  original configuration; when a path that nginx reads (the include file or
  the fixture) could not be removed it does not restart nginx and reports
  that instead. It also reports (and does not stop) any transient
  `run-*.service` unit loaded since the phase started, on success and on
  failure. The verifier then requires nginx active with the fixture ports
  closed and compares the host with the snapshot taken before the phase.
  Only this one comparison is relaxed: stopping and starting nginx replaces
  `/run/nginx.pid`, compared there by presence, type, mode and owner only,
  and the own mtime/ctime of `/etc/nginx/conf.d` (the include file was
  created and removed there) are not compared. The `nginx` package itself is
  installed by `prepare.yml`, before the pristine snapshot;
- `verify.yml` creates the verifier's work directory
  `/root/cloudfront-sync-s0-verify` fresh (removing a leftover of an
  interrupted run) and removes it in an `always` section, on success and on
  failure.

The scenario does not test synchronization, firewall changes, nginx changes
made by the runtime, rollback or crash recovery: those return with the S6
runtime session. The
verifier requires `/run/cloudfront-sync-disposable-test`; never create that
marker on an operational host. The marker check is shared by
`s0_refusal_verify.py`, `vm_network_verify.py` and `ufw_reference_verify.py`
through `ansible/molecule/cloudfront_sync/disposable_marker.py`, which each of
them loads by path from its own directory with the same `load_path` function
(also under `python -I`): copy it together with the verifier.

### Real-VM ingress harness

`ansible/molecule/cloudfront_sync/vm_network_verify.py` (copied to the VM
together with `disposable_marker.py`) is a disposable-VM ingress harness (UFW/nginx reachability from temporary network namespaces). It
reads `/etc/cloudfront-sync/config.json` and the private synchronization state,
which only a connected runtime can produce, so it cannot be used as evidence in
S0. Its safety tests run without VMs or network interfaces as part of the
second unit-test command above. Container results never replace the Ubuntu
22.04/24.04/26.04 VM release checks.

### S2-A context collection gate

For `backend=ufw`, `ContextCollector.collect()` without an injected runner
refuses with `context_sshd_sandbox_unavailable` before reading the clock,
files or directories, or running commands. `backend=none` still returns
NotApplicable without observations. The internal sshd command guard remains
as a second boundary. The public `inspect-runtime` context failure remains
`context_observation_failed`; no private diagnostic is exposed. This does
not add an isolated sshd runner or enable `preflight` or runtime actors.
