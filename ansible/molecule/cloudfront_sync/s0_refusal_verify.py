#!/usr/bin/python3
"""Stage S0 container verification: the runtime actor is NOT connected.

This replaces the former live_verify.py, which drove the removed B-draft
actor (Engine, Host.add_rule/delete_rule/check_reload_nginx, snapshot,
preflight, import_plan/import_state, ApprovalRequired) through destructive
UFW/nginx forward, rollback and crash-recovery transactions. Those actors no
longer exist in S0. The destructive real UFW/nginx forward/rollback/crash
verification will be rebuilt against the newly reviewed RuntimeSession in
stage S6 (design: cloudfront-runtime-actor-connection-design.md, S6 row);
it must not be restored from the deleted code.

What this verifier proves, inside the disposable container only:

* converge installed nothing. The role still sends the pre-C4 payload (no
  ``version``), so the installer's validate_candidate refuses it as
  invalid_candidate_schema at the --validate-only step and main() collapses
  that to candidate_validation_or_installation_unavailable; the install step
  itself is closed as cohort_installer_unavailable even after a valid
  candidate (both pinned by roles/cloudfront_sync/files/tests/
  test_install_cloudfront_sync.py). The install target list is shared with
  converge.yml through install_targets.json;
* a bundle built from the role's own files with bundle_manifest.build_bundle
  (the same construction as the unit-test fixture ``tree()``) is staged as a
  test fixture so the real CLI passes its own cohort gate. Staging is not an
  installer and does not weaken any refusal: every gate still runs;
* every non read-only subcommand discovered from the real CLI parser exits 1
  with stdout empty and stderr exactly {"error":"runtime_actor_not_connected"}
  in every argv shape: with its former (secret-carrying) option, without any
  option, with surplus secret arguments and with global options before the
  subcommand (the CLI refuses from the raw token, so argparse never parses or
  echoes it; the refused subparsers define no options);
* verify-cohort, inspect-state and inspect-runtime return fixed expectations.
  The read commands fail with the generic sanitized code while
  /var/lib/cloudfront-sync is absent and return read-only JSON once only that
  root 0755 parent exists; toggling that one directory (and nothing else)
  flips the result both ways, which attributes the generic failure to it.
  Every read phase first confirms the lock file exists, so a missing lock
  (inspect-* open it without O_CREAT) cannot be the cause instead;
* verify-cohort creates the fixed lock /run/lock/cloudfront-sync.lock. Its
  presence, mode and owner at start are part of every host snapshot. When it
  was absent at start it must appear as a root 0600 regular file, is recorded
  as created by this run and removed in cleanup; a pre-existing lock is never
  removed and must keep its mode and owner;
* no command changes the compared host state (see host_snapshot): the
  trees /etc/ufw, /etc/default, /var/lib/ufw, /etc/nginx, /etc/ssh,
  /etc/systemd/system and the install targets (content, mode, owner, inode,
  link count, mtime and ctime of every entry; only atime is not compared,
  and for /etc/nginx itself not its own mtime/ctime, see host_snapshot), the
  lock (lstat identity including the inode, and content), the kernel rulesets (iptables-save/ip6tables-save, nft list
  ruleset, and iptables-legacy-save/ip6tables-legacy-save or their
  absence), and a limited view of /run: only the top-level entries named
  cloudfront*, ufw*, nginx*, ssh*/sshd* and xtables* (presence and lstat
  identity; see run_snapshot); and no argv secret is echoed;
* everything this verifier stages or causes (bundle, config, secret, state
  directory, a lock it caused verify-cohort to create) is removed again on
  success, on failure and on SIGTERM, SIGINT or SIGHUP, and the host is
  compared with its pre-staging snapshot, so verify can run repeatedly on one
  instance. A leftover from an earlier run is reported, never reused or
  removed. Each path is recorded before it is created. The termination
  signals (TERMINATION_SIGNALS) are blocked (pthread_sigmask) for the whole
  run, before anything is staged, and become SystemExit(128 + signum) only at
  the safe points listed in checkpoint(); cleanup contains no safe point and
  runs no command, so it always runs blocked and a signal can never split a
  create from its record or interrupt cleanup. The first signal taken unwinds
  to cleanup. While a command runs, the signals are unblocked so the command
  inherits an unblocked mask; the handler then only records them. A lock is
  recorded whenever verify-cohort ends (result, timeout, error or signal) if
  it was absent at start;
* per refused invocation only a light identity check (lock, install targets,
  state directory, secret directory) runs; the full host snapshot (trees,
  kernel rulesets) is compared after all argv shapes of each refused
  subcommand and after every read command, so a change is still attributed
  to one subcommand.

AWS is never contacted: no S0 subcommand reaches the fetcher.

The S0 fixture config mirrors converge: nginx disabled (role default
shared_dir, no bundles), so inspect-runtime's nginx component is
not_applicable there. Stage S1 connected the read-only nginx observer
(nginx_observation.py); after the S0 checks and their pristine comparison,
verify_nginx_phase() exercises it with nginx enabled, in its own staging:

* a fixture under /etc/common-sv/nginx (the two shared include files and
  NGINX_BUNDLE_NAMES geo/realip bundles, each bundle's map carrying its own
  random per-run secret, plus localhost-only server blocks on
  NGINX_FIXTURE_PORTS, which must be unused before the phase), included from
  NGINX_INCLUDE (/etc/nginx/conf.d, which the stock nginx.conf includes in
  http), validated with ``nginx -t -q`` and reloaded; the config is staged
  with nginx enabled for those bundles;
* inspect-runtime admits it (admitted/nginx_policy_verified); with one
  bundle's ``real_ip_recursive on`` it is failure/nginx_policy_unsupported,
  with one bundle file replaced by a symlink (to a same-content file)
  failure/nginx_observation_failed, and each restoration is admitted again;
* right after verify-cohort and each inspect-runtime (before any cleanup) the
  host is compared with a baseline taken after the last staging step
  (phase_snapshot: S0's full host_snapshot without any relaxation plus the
  /etc/common-sv fixture tree), so a change of the staged bundle, the config,
  the state directory (its private namespace included), the lock or the
  fixture is a failure; verify-cohort may only create an absent lock. Around
  every inspect-runtime while nginx runs, nginx's process identity
  (nginx_process_identity: MainPID, start timestamp and restart count,
  /run/nginx.pid by lstat identity and content, the master's start time and
  its children) must stay the same, so a reload, restart or effective signal
  fails;
* every refused subcommand is run again in every argv shape with the
  nginx-enabled config (verify_refused_with_nginx): fixed refusal, no argv or
  bundle secret echoed, host (light check per shape, phase_snapshot per
  subcommand) and nginx identity unchanged;
* with nginx stopped, inspect-runtime reports failure/nginx_policy_unsupported,
  its sandbox demonstrably ran nginx -T during that call (journal entries
  after a cursor taken right before it), nginx stays stopped and the host is
  unchanged (phase_snapshot and stopped_snapshot: /run/nginx.pid not created,
  /var/log/nginx, /var/lib/nginx, /var/cache/nginx including their presence,
  /dev/shm, the watched /run view, and /tmp and /var/tmp by entries and
  content without their own mtime/ctime);
* after every inspect-runtime, running or stopped, and again in cleanup, no
  run-*.service unit is loaded that was not loaded before the phase
  (reported, never stopped);
* no secret (bundle or argv) appears in any command's stdout/stderr, in any
  file below the state directory, /var/log/nginx, /tmp, /var/tmp, the
  install targets, the lock or the watched /run entries (searched before
  cleanup; the staged fixture files are excluded), or anywhere in the whole
  journal (journalctl --sync, then -o export, all fields), and the journal is
  shown to be live for the phase (its nginx stop job and sandbox unit
  entries).

Cleanup removes every staged path and then restores the nginx service
(NginxService.restore: a synchronous restart onto the original configuration,
skipped and reported when a path nginx reads could not be removed; main()
then requires nginx active with the fixture ports closed). Only the one
comparison around the whole nginx phase (host_snapshot(around_nginx_phase=True))
relaxes anything: stopping and starting nginx necessarily replaces
/run/nginx.pid, compared there by presence, type, mode and owner only, and
/etc/nginx/conf.d's own mtime/ctime (NGINX_INCLUDE was created and removed)
are not compared; everything else is compared as before.
The nginx package itself is installed by prepare.yml, so the pristine
snapshot is taken after it.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

SENTINEL = Path('/run/cloudfront-sync-disposable-test')
SENTINEL_CONTENT = 'CloudFront sync isolated verification only\n'
CLI = Path('/usr/local/libexec/cloudfront-sync/cloudfront-sync.py')
BUNDLE_DIR = CLI.parent
CONFIG_DIR = Path('/etc/cloudfront-sync')
CONFIG = CONFIG_DIR / 'config.json'
STATE_DIR = Path('/var/lib/cloudfront-sync')
NGINX_DIR = Path('/etc/nginx')
UFW_DIR = Path('/etc/ufw')
# Trees the read commands' collectors may read (ufw/sshd/systemd/nginx state)
# and a write there would change host policy. Compared by tree_digest.
POLICY_TREES = (UFW_DIR, Path('/etc/default'), Path('/var/lib/ufw'), NGINX_DIR, Path('/etc/ssh'),
                Path('/etc/systemd/system'))
RUN_DIR = Path('/run')
# The only /run entries compared (top level, by presence and lstat identity);
# nothing else in /run is compared, see run_snapshot.
RUN_WATCHED = re.compile(r'(?:cloudfront|ufw|nginx|sshd?|xtables)')
SECRET_DIR = NGINX_DIR / 'cloudfront-s0'
SECRET_FILE = SECRET_DIR / 'origin-verify.conf'
TARGETS_FILE = Path(__file__).resolve().with_name('install_targets.json')
# Fixed lock of the real CLI (cloudfront-sync.py LOCK). verify-cohort creates
# it; inspect-state/inspect-runtime only open an existing one.
LOCK = Path('/run/lock/cloudfront-sync.lock')
# S1 nginx phase fixture (verify_nginx_phase). /etc/common-sv is absent on the
# disposable host and is created (and removed) by this verifier only.
NGINX_FIXTURE_TOP = Path('/etc/common-sv')
NGINX_FIXTURE_ROOT = NGINX_FIXTURE_TOP / 'nginx'
NGINX_SHARED_DIR = NGINX_FIXTURE_ROOT / 'cloudfront'
# Must equal nginx_observation.GEO_NAME / REALIP_NAME (enforced by the tests).
NGINX_GEO_NAME = 'cloudfront-geo.conf'
NGINX_REALIP_NAME = 'cloudfront-realip.conf'
NGINX_BUNDLE_NAMES = ('cf01', 'cf02', 'cf03')
# One localhost-only server per bundle; listening on them shows that nginx
# runs the fixture, refusing that it runs the original configuration again.
NGINX_FIXTURE_PORTS = tuple(8101 + index for index in range(len(NGINX_BUNDLE_NAMES)))
# Documentation ranges only; the observer checks format and set equality.
NGINX_RANGES = ('192.0.2.0/24', '198.51.100.0/24', '2001:db8::/32')
NGINX_CONF_D = NGINX_DIR / 'conf.d'
# The stock nginx.conf includes /etc/nginx/conf.d/*.conf inside http.
NGINX_INCLUDE = NGINX_CONF_D / 'cloudfront-molecule.conf'
NGINX_SYMLINK_TARGET = NGINX_FIXTURE_ROOT / 'symlink-target-http.conf'
NGINX_PID = RUN_DIR / 'nginx.pid'
NGINX = '/usr/sbin/nginx'
SYSTEMCTL = '/usr/bin/systemctl'
JOURNALCTL = '/usr/bin/journalctl'
# inspect-runtime with nginx enabled runs nginx -T twice in a sandbox unit
# (Collector: 20 s per command, 60 s in all); leave room for the CLI itself.
NGINX_INSPECT_TIMEOUT = 120
# Paths nginx -T could write as a side effect; compared while nginx is
# stopped (stopped_snapshot). /tmp and /var/tmp change their own mtime/ctime
# by the sandbox's PrivateTmp directory, so only their entries and content
# are compared (own_times False).
STOPPED_TREES = ((Path('/var/log/nginx'), True), (Path('/var/lib/nginx'), True), (Path('/var/cache/nginx'), True),
                 (Path('/dev/shm'), True), (Path('/tmp'), False), (Path('/var/tmp'), False))


class VerifyError(Exception):
    """A failed S0 expectation. Messages never include command output or argv."""


def load_install_targets(path=TARGETS_FILE):
    """Single source shared with converge.yml: paths an S0 converge leaves absent.

    Never called at import (see install_targets()); an unreadable or malformed
    file is a VerifyError, so main() reports it as a fixed failure.
    """
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise VerifyError('install_targets.json is unreadable') from None
    targets = value.get('install_targets') if type(value) is dict and set(value) == {'install_targets'} else None
    if (type(targets) is not list or not targets or len(set(targets)) != len(targets)
            or any(type(item) is not str or not item.startswith('/') or Path(item).as_posix() != item
                   for item in targets)):
        raise VerifyError('install_targets.json is malformed')
    targets = tuple(Path(item) for item in targets)
    if not {BUNDLE_DIR, CONFIG_DIR, STATE_DIR} <= set(targets):
        raise VerifyError('install_targets.json misses a staged runtime path')
    return targets


_INSTALL_TARGETS = []


def install_targets():
    """The install targets, read from TARGETS_FILE on first use, never at import.

    main() calls it first, so a missing or malformed file fails through the
    fixed failure report of ``__main__``; importing this module (the role unit
    tests load it for parse_subcommands) reads no file.
    """
    if not _INSTALL_TARGETS:
        _INSTALL_TARGETS.append(load_install_targets())
    return _INSTALL_TARGETS[0]


def staged_roots():
    """Everything this verifier may create. A pre-existing one is a leftover."""
    return (*install_targets(), SECRET_DIR, NGINX_FIXTURE_TOP, NGINX_INCLUDE)

# Must equal READ_ONLY_COMMANDS / REFUSED_COMMANDS in
# roles/cloudfront_sync/files/tests/test_cloudfront_sync.py (enforced by
# molecule/cloudfront_sync/tests/test_s0_refusal_verify.py) and the real parser.
READ_ONLY_COMMANDS = frozenset({'verify-cohort', 'inspect-state', 'inspect-runtime'})
# The former required options (removed from the CLI parser) carry the secret.
REFUSED_ARGUMENTS = {
    'preflight': lambda secret: [],
    'plan': lambda secret: [],
    'sync': lambda secret: [],
    'apply': lambda secret: ['--approve=' + secret],
    'import': lambda secret: ['--approve=' + secret],
    'import-plan': lambda secret: ['--legacy-state=/root/' + secret + '.json'],
}
REFUSAL_STDERR = '{"error":"runtime_actor_not_connected"}\n'


def refused_invocations(subcommand, secret):
    """Every argv shape a refused command is run with: [(prefix, extra)], no duplicates.

    With its former option, with no option at all, with surplus secret
    arguments, and with secret-bearing global options before the subcommand.
    The CLI refuses all of them identically and never parses or echoes argv.
    """
    required = REFUSED_ARGUMENTS[subcommand](secret)
    shapes = [((), tuple(required)), ((), ()),
              ((), (*required, '--unexpected=' + secret, secret)),
              (('--config', '/root/' + secret + '.json', '--lock-fd=' + secret), tuple(required))]
    return list(dict.fromkeys(shapes))

# Fixed, deterministic expectations for this container (Ubuntu 24.04 image
# pinned by digest, enabled UFW with an administrator 22/tcp rule, the S0
# fixture config with nginx disabled as in converge). Changing any of them is
# a reviewed change.
# Phase A (and A'): /var/lib/cloudfront-sync is absent. The read commands never
# create it and fail with the generic sanitized code. The CLI deliberately has
# no distinguishing code for this in S0; the cause is attributed by toggling
# only that directory (Phase A -> B -> A'), see verify_with_fixture().
SANITIZED_FAILURE_STDERR = '{"error":"sync_failed"}\n'
# Phase B: the parent exists as the installer would create it (root, 0755),
# but the private namespace does not.
EXPECTED_INSPECT_STATE = {
    'inspection': 'read_only_state_only',
    'private_state_disposition': 'private_directory_absent',
    'state_disposition': 'absent',
    'journal_disposition': 'absent',
    'runtime_ready': False,
}
EXPECTED_INSPECT_RUNTIME = {
    'inspection': 'read_only_observation',
    'private_state': 'private_directory_absent',
    'state': 'absent',
    'journal': 'absent',
    'firewall': {'status': 'failure', 'code': 'stock_evidence_unsupported'},
    'nginx': {'status': 'not_applicable', 'component': 'nginx'},
    'context': {'status': 'failure', 'code': 'context_observation_failed'},
    'runtime_ready': False,
}
# The nginx component of inspect-runtime in the S1 nginx phase (nginx
# enabled for the fixture bundles); every other field is EXPECTED_INSPECT_RUNTIME's.
NGINX_VERIFIED = {'status': 'admitted', 'code': 'nginx_policy_verified'}
NGINX_POLICY_UNSUPPORTED = {'status': 'failure', 'code': 'nginx_policy_unsupported'}
NGINX_OBSERVATION_FAILED = {'status': 'failure', 'code': 'nginx_observation_failed'}
_CREATE_FLAGS = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC


def load_path(path, module_name):
    """Execute the Python file at ``path`` as a new module (never via sys.path).

    The single by-path loader of the disposable verifiers. s0_refusal_verify,
    vm_network_verify and ufw_reference_verify carry this function verbatim
    (tests/test_disposable_marker.py enforces it): it cannot live in
    disposable_marker.py, which is the first module it loads. Loading by path
    works unchanged under ``python -I``, which drops the script directory from
    sys.path.
    """
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


marker = load_path(Path(__file__).resolve().with_name('disposable_marker.py'), 'cloudfront_sync_disposable_marker')


def check_environment(sentinel=SENTINEL):
    if os.geteuid() != 0:
        raise VerifyError('root is required')
    state = marker.marker_state(sentinel, SENTINEL_CONTENT.encode(), exact_mode=0o600)
    if state == marker.ABSENT:
        raise VerifyError('disposable-host sentinel is required')
    if state != marker.VALID:
        raise VerifyError('disposable-host sentinel is invalid')


def require_clean_start(paths=None):
    """Refuse leftovers instead of reusing or deleting what this run did not create."""
    present = [str(path) for path in (staged_roots() if paths is None else paths) if os.path.lexists(path)]
    if present:
        raise VerifyError('already present (S0 converge must not install it and an earlier verifier '
                          'run must have removed it): ' + ', '.join(present))


class Termination:
    """Termination-signal state. The signals stay blocked; only checkpoint() acts on them."""

    def __init__(self):
        self.pending = None
        self.unwinding = False


TERMINATION = Termination()
# SIGTERM (Ansible/Molecule timeout), SIGINT (Ctrl-C) and SIGHUP (lost
# terminal) all mean "stop": each unwinds through cleanup with 128 + signum.
TERMINATION_SIGNALS = frozenset({signal.SIGTERM, signal.SIGINT, signal.SIGHUP})


def terminate(signum, frame):
    """Handler of every termination signal: records the first only, never raises.

    The signals are blocked for the whole run (install_termination) except
    while a command runs (see run()), so this runs only then; no exception can
    start at an arbitrary bytecode. The signal is acted on at the next checkpoint().
    """
    if TERMINATION.pending is None:
        TERMINATION.pending = signum


def install_termination():
    """Block the termination signals first, then install the recording handler.

    From here on such a signal stays pending in the kernel until a
    checkpoint() takes it. Called before anything is staged.
    """
    signal.pthread_sigmask(signal.SIG_BLOCK, TERMINATION_SIGNALS)
    for signum in sorted(TERMINATION_SIGNALS):
        signal.signal(signum, terminate)


def take_pending_termination():
    """Consume every pending, blocked termination signal (sigpending + sigwait).

    The first one taken is recorded in TERMINATION unless one already is.
    """
    while TERMINATION_SIGNALS & set(signal.sigpending()):
        signum = signal.sigwait(TERMINATION_SIGNALS)
        if TERMINATION.pending is None:
            TERMINATION.pending = signum


def checkpoint():
    """Safe point: the only place a termination signal becomes SystemExit (once).

    The safe points, and the only callers:

    * run(), before it starts any command (every CLI invocation including
      --help and each refused argv shape, and each firewall dump of a host
      snapshot);
    * Staging.mkdir() and Staging.write(), right after each path is created
      (and recorded);
    * with_cleanup(), after the cleanup of a successful body.

    Never inside cleanup. Once the run is unwinding (failure or signal), a
    later signal is only consumed.
    """
    take_pending_termination()
    if TERMINATION.pending is not None and not TERMINATION.unwinding:
        TERMINATION.unwinding = True
        raise SystemExit(128 + TERMINATION.pending)


class Staging:
    """Exclusive creation of fixture paths, each recorded for guaranteed removal.

    A path is recorded *before* it is created (cleanup ignores a recorded path
    that does not exist) and the record is withdrawn when the exclusive
    creation fails, so an existing path of someone else is never recorded.
    The termination signals are blocked and the only checkpoint follows the
    creation, so no window leaves a created path unrecorded.
    """

    def __init__(self):
        self.created = []

    def _create(self, path, create):
        """Record ``path``, then ``create()`` it exclusively.

        A failed exclusive create (OSError) created nothing, so its record is
        withdrawn; that also keeps an existing path of someone else unrecorded.
        """
        self.created.append(path)
        try:
            return create()
        except OSError:
            self.created.remove(path)
            raise

    def mkdir(self, path, mode):
        """Create ``path`` and any missing ancestor exclusively; never adopt an existing one."""
        path = Path(path)
        missing = []
        for current in (path, *path.parents):
            if os.path.lexists(current):
                break
            missing.append(current)
        if not missing or missing[0] != path:
            raise VerifyError('already present: ' + str(path))
        for current in reversed(missing):
            try:
                self._create(current, lambda: os.mkdir(current, mode))
            except FileExistsError:
                raise VerifyError('created concurrently: ' + str(current)) from None
            except OSError:
                raise VerifyError('cannot create directory: ' + str(current)) from None
            checkpoint()
            try:
                # Exact mode regardless of umask; lstat first so a swapped-in
                # symlink is never followed.
                if not stat.S_ISDIR(current.lstat().st_mode):
                    raise VerifyError('replaced concurrently: ' + str(current))
                os.chmod(current, mode)
            except OSError:
                raise VerifyError('cannot set directory mode: ' + str(current)) from None

    def write(self, path, data, mode):
        """O_EXCL|O_NOFOLLOW, created 0600 and only widened to ``mode`` after the write."""
        path = Path(path)
        try:
            fd = self._create(path, lambda: os.open(path, _CREATE_FLAGS, 0o600))
        except FileExistsError:
            raise VerifyError('already present: ' + str(path)) from None
        except OSError:
            raise VerifyError('cannot create file: ' + str(path)) from None
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
            os.fchmod(fd, mode)
        except OSError:
            raise VerifyError('cannot write file: ' + str(path)) from None
        finally:
            os.close(fd)
        checkpoint()

    def replace(self, path, data=None, mode=0o644, symlink_to=None):
        """Atomically replace the staged file ``path`` by new content or by a symlink.

        The new file (or symlink) is created exclusively next to it under a
        recorded temporary name and renamed over ``path``; both stay recorded,
        so cleanup removes whatever exists. Only a path this run staged is
        replaced. No new safe point: write() keeps its own checkpoint and a
        symlink creation is followed by none (the signals stay blocked until
        the next run()).
        """
        path = Path(path)
        if path not in self.created:
            raise VerifyError('not staged by this run: ' + str(path))
        temporary = path.with_name(path.name + '.replace')
        if symlink_to is None:
            self.write(temporary, data, mode)
        else:
            try:
                self._create(temporary, lambda: os.symlink(symlink_to, temporary))
            except OSError:
                raise VerifyError('cannot create symlink: ' + str(temporary)) from None
        try:
            os.replace(temporary, path)
        except OSError:
            raise VerifyError('cannot replace staged file: ' + str(path)) from None

    def record_created(self, path):
        """Record a path another process created on this run's behalf (the CLI lock).

        The caller must have observed it absent first; it is then removed in
        cleanup like any other staged path.
        """
        path = Path(path)
        if path in self.created or not os.path.lexists(path):
            raise VerifyError('cannot record as created by this run: ' + str(path))
        self.created.append(path)

    def remove(self, path):
        """Remove one recorded empty directory early (Phase A')."""
        path = Path(path)
        if path not in self.created:
            raise VerifyError('not staged by this run: ' + str(path))
        try:
            os.rmdir(path)
        except OSError:
            raise VerifyError('cannot remove staged directory: ' + str(path)) from None
        self.created.remove(path)

    def cleanup(self):
        """Remove every recorded path, newest first. Returns the paths that remain."""
        remaining = []
        for path in reversed(self.created):
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                remaining.append(str(path))
                continue
            try:
                if stat.S_ISDIR(info.st_mode):
                    shutil.rmtree(path)
                else:
                    path.unlink()
            except OSError:
                remaining.append(str(path))
        self.created = []
        return remaining


def parse_subcommands(help_text):
    """Return the subcommand set of the real CLI's argparse usage line."""
    # argparse prints the group in the usage line and again in the positional
    # argument section; every occurrence must be the same single group.
    groups = re.findall(r'\{([a-z][a-z,-]*)\}', help_text)
    if not groups or len(set(groups)) != 1:
        raise VerifyError('CLI usage must list exactly one subcommand group')
    names = groups[0].split(',')
    if len(set(names)) != len(names) or not all(names):
        raise VerifyError('CLI subcommand group is malformed')
    return frozenset(names)


def classify(subcommands):
    unknown = subcommands - READ_ONLY_COMMANDS - frozenset(REFUSED_ARGUMENTS)
    missing = (READ_ONLY_COMMANDS | frozenset(REFUSED_ARGUMENTS)) - subcommands
    if unknown or missing:
        raise VerifyError('CLI subcommands are not classified: unknown=%s missing=%s'
                          % (sorted(unknown), sorted(missing)))
    return sorted(subcommands - READ_ONLY_COMMANDS)


def _tree_entries(root):
    """Every entry below the directory ``root``, sorted; no symlink is followed.

    An own os.scandir walk instead of Path.rglob, which silently skips a
    directory it cannot list: a directory that vanishes or stops being a
    directory between its parent's listing and its own is a VerifyError
    naming the tree and that directory; any other error is raised as is.
    """
    entries, pending = [], [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as scan:
                for entry in scan:
                    path = directory / entry.name
                    entries.append(path)
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(path)
        except (FileNotFoundError, NotADirectoryError):
            raise VerifyError('tree changed while it was read: %s (vanished: %s)' % (root, directory)) from None
    return sorted(entries)


def tree_digest(root, own_times=True, times_exempt=()):
    """Identity, metadata and content digest of a tree; absence is distinct.

    Each entry's row (the root included) holds its path, mode, owner, group,
    inode, link count, mtime and ctime (nanoseconds; never atime, which a
    read may change), plus the sha256 of a regular file's content or a
    symlink's target. So a same-content replacement (another inode), an
    added hard link (link count, ctime) and a touch (mtime, ctime) are
    changes, not only content and mode changes. ``own_times=False`` drops the
    mtime and ctime of the root itself only (see host_snapshot: the verifier
    creates and removes its secret directory in NGINX_DIR); the root's inode,
    link count and mode and every entry below it stay compared.
    ``times_exempt`` names directories below the root whose own mtime and
    ctime are dropped the same way (NGINX_CONF_D, in which the nginx phase
    creates and removes NGINX_INCLUDE); their entries stay compared.

    An entry that vanishes between the listing and its read (also a
    directory between its parent's listing and its own, see _tree_entries)
    means the tree changed while it was being read: a VerifyError naming the
    tree and the entry (paths are not secret), never a raw exception.
    """
    root = Path(root)
    if not os.path.lexists(root):
        return 'absent'
    rows = []
    paths = [root] if not root.is_dir() or root.is_symlink() else [root, *_tree_entries(root)]
    for path in paths:
        try:
            info = path.lstat()
            row = [str(path), oct(info.st_mode), info.st_uid, info.st_gid, info.st_ino, info.st_nlink]
            if (own_times or path != root) and path not in times_exempt:
                row += [info.st_mtime_ns, info.st_ctime_ns]
            if stat.S_ISLNK(info.st_mode):
                row.append('link:' + os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                row.append(hashlib.sha256(path.read_bytes()).hexdigest())
        except (FileNotFoundError, NotADirectoryError):
            raise VerifyError('tree changed while it was read: %s (vanished: %s)' % (root, path)) from None
        rows.append(row)
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest()


def run(args, name, timeout=60, text=True):
    """Run a fixed command. Failures name only ``name``: argv may carry the secret.

    Starts with checkpoint(): the one safe point before every command.
    A child inherits the caller's signal mask, and subprocess resets none of
    it (restore_signals only resets the SIGPIPE/SIGXFSZ dispositions;
    process_group and start_new_session keep the mask). The termination
    signals are therefore unblocked exactly while the command runs, so the
    child starts with them unblocked and stays terminable; no preexec_fn and
    no wrapper process. Such a signal meanwhile only runs the recording
    handler (terminate), so nothing is interrupted; the next checkpoint() acts
    on it. The previous mask is restored however the command ends.
    ``text=False`` returns bytes (the journal export may hold binary fields).
    """
    checkpoint()
    previous = signal.pthread_sigmask(signal.SIG_UNBLOCK, TERMINATION_SIGNALS)
    try:
        return subprocess.run(args, capture_output=True, text=text, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise VerifyError('command failed: ' + name) from None
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def run_in_cleanup(args, name, timeout=60):
    """A fixed restoration command of cleanup (NginxService.restore): no checkpoint.

    Cleanup must never be split by a signal, so unlike run() this neither
    takes a checkpoint nor unblocks the termination signals; the child starts
    with them blocked and is bounded by ``timeout`` (SIGKILL). Returns
    whether the command succeeded; never raises for a failed command.
    """
    try:
        completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return completed.returncode == 0


_CHAIN_COUNTERS = re.compile(r' \[[0-9]+:[0-9]+\]$')
# Preceded by a space or a tab: a statement that starts a rule line (e.g.
# ufw's "\t\tcounter packets N bytes M jump ufw-before-input") counts too.
# A counter statement keeps its ``counter`` keyword (only its two numbers are
# dropped), so adding or removing a counter is still a ruleset change.
_NFT_COUNTER = re.compile(r'([ \t]counter) packets [0-9]+ bytes [0-9]+')
_NFT_VOLATILE = re.compile(r'[ \t](?:# handle [0-9]+|expires [0-9a-z]+)')


def normalize_iptables_save(text):
    """Drop generator comments and the per-chain ``[packets:bytes]`` counters."""
    return '\n'.join(_CHAIN_COUNTERS.sub('', line) if line.startswith(':') else line
                     for line in text.splitlines() if not line.startswith('#'))


def normalize_nft(text):
    """Drop the counter values, handles and set-element expiry, which change by themselves.

    ``counter packets N bytes M`` becomes ``counter``: the statement itself
    stays compared.
    """
    return '\n'.join(_NFT_VOLATILE.sub('', _NFT_COUNTER.sub(r'\1', line)) for line in text.splitlines())


# Required dumps: the configured iptables backend (nft-based on Ubuntu 24.04)
# and the nft ruleset itself.
FIREWALL_DUMPS = (('iptables-save', ['iptables-save'], normalize_iptables_save),
                  ('ip6tables-save', ['ip6tables-save'], normalize_iptables_save),
                  ('nft', ['nft', 'list', 'ruleset'], normalize_nft))
# The legacy (x_tables) rulesets, which the dumps above do not show. A host
# without the command records the distinct value 'absent', so before and after
# must agree on its presence too; a present command that fails is an error.
LEGACY_FIREWALL_DUMPS = ('iptables-legacy-save', 'ip6tables-legacy-save')


def firewall_rules():
    """Kernel rule dumps without generator comments, counters or handles.

    FIREWALL_DUMPS must run; each of LEGACY_FIREWALL_DUMPS runs by its
    resolved path when it is installed and is 'absent' otherwise.
    """
    dumps = list(FIREWALL_DUMPS)
    result = {}
    for name in LEGACY_FIREWALL_DUMPS:
        resolved = shutil.which(name)
        if resolved is None:
            result[name] = 'absent'
        else:
            dumps.append((name, [resolved], normalize_iptables_save))
    for name, argv, normalize in dumps:
        completed = run(argv, name)
        if completed.returncode:
            raise VerifyError(name + ' failed')
        result[name] = hashlib.sha256(normalize(completed.stdout).encode()).hexdigest()
    return result


def run_snapshot(run_dir=RUN_DIR, reduced=()):
    """A deliberately limited, non-flaky view of /run (limited comparison).

    Compared: only the top-level entries whose name matches RUN_WATCHED
    (starts with cloudfront, ufw, nginx, ssh/sshd or xtables), each by
    presence and lstat identity (device, inode, mode, owner, links, size,
    mtime, ctime; no content). So creating, removing or changing such an
    entry is detected. Not compared: every other top-level entry (its
    presence, name or metadata; systemd, user, lock, ... change by
    themselves) and anything below any entry. The CLI lock under /run/lock is
    compared separately (LOCK).

    A watched name in ``reduced`` is compared by presence, mode (type and
    permissions), owner, group and link count only: nginx.pid around the
    nginx phase, which stops and starts nginx and so replaces that file.
    """
    def identity(name):
        value = path_identity(Path(run_dir) / name)
        return value[2:6] if name in reduced and value != 'absent' else value
    watched = {name: identity(name) for name in sorted(os.listdir(run_dir)) if RUN_WATCHED.match(name)}
    return hashlib.sha256(json.dumps(watched).encode()).hexdigest()


def host_snapshot(around_nginx_phase=False):
    """The full comparison of host state; what is *not* listed is not compared.

    tree_digest (content, mode, owner, inode, link count, mtime and ctime of
    every entry; absence distinct) of POLICY_TREES (/etc/ufw, /etc/default,
    /var/lib/ufw, /etc/nginx, /etc/ssh, /etc/systemd/system) and of every
    install target; the lock by its lstat identity (path_identity: device,
    inode, mode, owner, links, size, mtime, ctime) together with its
    tree_digest, or 'absent'; the limited /run view of run_snapshot (watched
    top-level entries only); and the normalized kernel rulesets of
    firewall_rules (legacy dumps included, or 'absent'). The UFW rule files
    must exist.

    The commands under test may legitimately change only the atime of these
    paths (they read them; verify-cohort's O_CREAT open and flock of an
    existing lock change none of its times), so atime is the only timestamp
    left out. One exception: the mtime and ctime of NGINX_DIR itself, in
    which the verifier creates and removes SECRET_DIR (staging, not a
    command), so the pristine comparison after cleanup would always differ
    there; its inode, links and mode and everything below it are compared.

    ``around_nginx_phase=True`` is for one comparison only: the host before
    the nginx phase against the host after its cleanup (main()). Then, and
    never in the S0 pristine/baseline/per-command comparisons or the nginx
    phase's own per-command comparisons (phase_snapshot), the mtime and ctime
    of NGINX_CONF_D itself are dropped (the phase stages and removes
    NGINX_INCLUDE there) and the watched /run/nginx.pid is compared by
    presence, type, mode and owner only (see run_snapshot; the phase stops
    and restarts nginx, which replaces that file).
    """
    for name in ('user.rules', 'user6.rules'):
        if not (UFW_DIR / name).is_file():
            raise VerifyError('UFW ' + name + ' is missing')
    snapshot = {str(path): tree_digest(path, own_times=path != SECRET_DIR.parent,
                                       times_exempt=(NGINX_CONF_D,) if around_nginx_phase and path == NGINX_DIR
                                       else ())
                for path in (*POLICY_TREES, *install_targets())}
    lock = path_identity(LOCK)
    snapshot[str(LOCK)] = 'absent' if lock == 'absent' else (lock, tree_digest(LOCK))
    snapshot[str(RUN_DIR)] = run_snapshot(reduced=(NGINX_PID.name,) if around_nginx_phase else ())
    snapshot.update(firewall_rules())
    return snapshot


def changed_keys(before, after):
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))


def load_manifest_module(source_dir):
    return load_path(Path(source_dir) / 'bundle_manifest.py', 's0_fixture_bundle_manifest')


def stage_bundle(source_dir, staging):
    """Lay down the verified test bundle; returns its generation."""
    manifest = load_manifest_module(source_dir)
    built = manifest.build_bundle({name: (Path(source_dir) / name).read_bytes() for name in manifest.ASSET_NAMES})
    staging.mkdir(BUNDLE_DIR, 0o755)
    for name, raw in sorted(built.assets.items()):
        staging.write(BUNDLE_DIR / name, raw, 0o755 if name in manifest.ENTRY_NAMES else 0o644)
    staging.write(BUNDLE_DIR / 'bundle-manifest.json', built.manifest, 0o644)
    return built.generation


def stage_config(staging, nginx):
    """Stage the CLI config with the given nginx section."""
    staging.mkdir(CONFIG_DIR, 0o755)
    staging.write(CONFIG, json.dumps({
        'host_address': '192.0.2.10',
        'firewall': {'backend': 'ufw', 'ports': [443]},
        'nginx': nginx,
        'limits': {'max_changes': 10, 'min_ratio': 0.8},
        'notify_unit': '',
    }, sort_keys=True).encode(), 0o640)


# The converge vars: nginx disabled, the role default shared_dir, no bundles.
S0_NGINX_CONFIG = {'enabled': False, 'shared_dir': str(NGINX_DIR / 'cloudfront'), 'bundles': []}


def stage_fixture(source_dir, secret, staging):
    """Lay down the verified test bundle, a secret nginx file and the S0 config."""
    generation = stage_bundle(source_dir, staging)
    staging.mkdir(SECRET_DIR, 0o755)
    # Never included by nginx.conf and nginx is disabled in the S0 config, so
    # nothing reads it. The real file-secret test is the S1 nginx phase: its
    # secrets sit in bundles that nginx -T dumps, and it runs every refused
    # subcommand (every argv shape) again with nginx enabled for them
    # (verify_refused_with_nginx).
    staging.write(SECRET_FILE, ('if ($http_x_origin_verify != "' + secret + '") { return 403; }\n').encode(), 0o600)
    stage_config(staging, S0_NGINX_CONFIG)
    return generation


def require_lock_file(path=LOCK):
    """The lock exists as verify-cohort creates it: root 0600 regular, one link."""
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        raise VerifyError('CLI lock file is absent: ' + str(path)) from None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600):
        raise VerifyError('CLI lock file is not a root 0600 regular file: ' + str(path))


def invoke(subcommand, extra=(), prefix=(), timeout=60):
    completed = run(['/usr/bin/python3', str(CLI), *prefix, subcommand, *extra], subcommand, timeout)
    return {'command': subcommand, 'rc': completed.returncode,
            'stdout': completed.stdout, 'stderr': completed.stderr}


def require_unchanged(before, label, around_nginx_phase=False):
    """Full comparison (host_snapshot): trees, the lock's identity, /run view and kernel rulesets."""
    changed = changed_keys(before, host_snapshot(around_nginx_phase) if around_nginx_phase else host_snapshot())
    if changed:
        raise VerifyError(label + ' changed host state: ' + ', '.join(changed))


def path_identity(path):
    """lstat identity of one path (no content); absence is a distinct value."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return 'absent'
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def light_snapshot():
    """Cheap per-invocation check: the lock, each install target and the secret directory."""
    return {str(path): path_identity(path) for path in (LOCK, *install_targets(), SECRET_DIR)}


def require_light_unchanged(before, label):
    changed = changed_keys(before, light_snapshot())
    if changed:
        raise VerifyError(label + ' changed host state: ' + ', '.join(changed))


def check_refusal(result):
    if result['rc'] != 1 or result['stdout'] != '' or result['stderr'] != REFUSAL_STDERR:
        raise VerifyError(result['command'] + ' did not refuse with runtime_actor_not_connected '
                          '(rc=%d stdout_bytes=%d)' % (result['rc'], len(result['stdout'])))


def check_sanitized_failure(result):
    if result['rc'] != 1 or result['stdout'] != '' or result['stderr'] != SANITIZED_FAILURE_STDERR:
        raise VerifyError(result['command'] + ' did not fail with the sanitized code '
                          '(rc=%d stdout_bytes=%d)' % (result['rc'], len(result['stdout'])))


def check_json(result, expected, generation):
    if result['rc'] != 0 or result['stderr'] != '':
        raise VerifyError(result['command'] + ' failed (rc=%d)' % result['rc'])
    try:
        value = json.loads(result['stdout'])
    except ValueError:
        raise VerifyError(result['command'] + ' printed non-JSON') from None
    if type(value) is not dict or value.get('generation_id') != generation:
        raise VerifyError(result['command'] + ' reported another generation')
    if set(value) != set(expected) | {'generation_id'}:
        raise VerifyError(result['command'] + ' reported an unexpected field set')
    # Compared as canonical JSON, so the types must match too: true is not
    # 1, false is not 0 and 1.0 is not 1, at any depth.
    unexpected = {key: value.get(key) for key in expected
                  if json.dumps(value.get(key), sort_keys=True) != json.dumps(expected[key], sort_keys=True)}
    if unexpected:
        raise VerifyError(result['command'] + ' differs from the fixed S0 expectation: '
                          + ', '.join(sorted(unexpected)))
    return value


def check_argv_secret_not_echoed(results, secret):
    """The secret reaches the CLI only through argv (apply/import/import-plan)."""
    for result in results:
        if secret in result['stdout'] or secret in result['stderr']:
            raise VerifyError(result['command'] + ' echoed the argv secret')


def read_phase(subcommands, check, baseline, label, results):
    # inspect-* open the lock without O_CREAT and fail generically when it is
    # missing. Confirm it first, so a failure here is never the lock's absence.
    require_lock_file()
    for subcommand in subcommands:
        result = invoke(subcommand)
        results.append(result)
        check(result)
        require_unchanged(baseline, subcommand + ' (' + label + ')')


def invoke_verify_cohort(staging, lock_absent_at_start):
    try:
        return invoke('verify-cohort')
    finally:
        # Record a lock this run caused however verify-cohort ended (result,
        # timeout, error, signal at a checkpoint), before any check can fail,
        # so cleanup removes it; a lock that existed before is never recorded
        # or removed. The signals are blocked: nothing can interrupt this block.
        if lock_absent_at_start and os.path.lexists(LOCK):
            staging.record_created(LOCK)


def verify_with_fixture(source_dir, staging):
    secret = 'cf-s0-origin-secret-' + secrets.token_hex(16)
    generation = stage_fixture(source_dir, secret, staging)
    help_result = run(['/usr/bin/python3', str(CLI), '--help'], '--help')
    if help_result.returncode:
        raise VerifyError('CLI --help failed')
    refused = classify(parse_subcommands(help_result.stdout))
    before_cohort = host_snapshot()
    lock_absent_at_start = before_cohort[str(LOCK)] == 'absent'
    results = []

    cohort = invoke_verify_cohort(staging, lock_absent_at_start)
    results.append(cohort)
    check_json(cohort, {'cohort_verified': True, 'runtime_ready': False, 'policy_verified': False}, generation)
    require_lock_file()
    baseline = host_snapshot()
    # verify-cohort may change nothing but create the absent lock.
    if changed_keys(before_cohort, baseline) != ([str(LOCK)] if lock_absent_at_start else []):
        raise VerifyError('verify-cohort changed host state other than creating the absent lock')

    light = light_snapshot()
    for subcommand in refused:
        for shape, (prefix, extra) in enumerate(refused_invocations(subcommand, secret)):
            # run()'s checkpoint is the safe point before each invocation.
            result = invoke(subcommand, extra, prefix)
            results.append(result)
            check_refusal(result)
            require_light_unchanged(light, '%s (argv shape %d)' % (subcommand, shape))
        # The full snapshot once per subcommand still names the subcommand.
        require_unchanged(baseline, subcommand)

    reads = ('inspect-state', 'inspect-runtime')
    # Phase A: state parent absent; the read commands must not create it.
    read_phase(reads, check_sanitized_failure, baseline, 'state directory absent', results)
    # Phase B: only the installer-owned parent is added (root, 0755). The
    # snapshot difference must be exactly that directory (the lock is part of
    # the snapshot and stays present), so the A/B result change is caused by
    # it and nothing else.
    staging.mkdir(STATE_DIR, 0o755)
    present = host_snapshot()
    if changed_keys(baseline, present) != [str(STATE_DIR)]:
        raise VerifyError('Phase B changed more than the state directory')
    require_lock_file()
    for subcommand, expected in (('inspect-state', EXPECTED_INSPECT_STATE),
                                 ('inspect-runtime', EXPECTED_INSPECT_RUNTIME)):
        result = invoke(subcommand)
        results.append(result)
        check_json(result, expected, generation)
        require_unchanged(present, subcommand + ' (state directory present)')
    # Phase A': remove only that directory again; the generic failure returns.
    staging.remove(STATE_DIR)
    require_unchanged(baseline, 'state directory removal')
    read_phase(reads, check_sanitized_failure, baseline, 'state directory removed again', results)

    check_argv_secret_not_echoed(results, secret)
    if SECRET_FILE.read_text().count(secret) != 1:
        raise VerifyError('secret fixture was altered')
    return {
        's0_checks': 'passed',
        'runtime_actor_connected': False,
        'refused_commands': refused,
        'read_only_commands': sorted(READ_ONLY_COMMANDS),
        'host_state_unchanged': True,
        # S0 has no nginx reader (see stage_fixture); the file secrets are
        # tested with nginx enabled in the nginx phase.
        'argv_secret_not_echoed': True,
        'state_directory_attribution': 'absent_fails_present_reads_absent_fails',
        'lock_at_start': 'absent' if lock_absent_at_start else 'present',
    }


def nginx_bundle_paths(name):
    """(geo_file, realip_file) of one fixture bundle, as in the config."""
    directory = NGINX_FIXTURE_ROOT / (name + '-origin')
    return directory / 'http.conf', directory / 'server.conf'


def nginx_geo_bundle(name, secret):
    """A bundle's http-level file: the bound geo block and a map holding the secret."""
    return ('geo $realip_remote_addr $cloudfront_origin_%s {\n'
            '    include %s;\n'
            '    default 0;\n'
            '}\n'
            'map $http_x_origin_verify $origin_verify_%s {\n'
            '    default 0;\n'
            '    "%s" 1;\n'
            '}\n' % (name, NGINX_SHARED_DIR / NGINX_GEO_NAME, name, secret)).encode()


def nginx_realip_bundle(recursive='off'):
    """A bundle's server-level file; ``recursive='on'`` is the policy-violating variant."""
    return ('include %s;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive %s;\n'
            % (NGINX_SHARED_DIR / NGINX_REALIP_NAME, recursive)).encode()


def nginx_fixture_files(secrets_by_bundle):
    """Every fixture file in creation order: [(path, bytes)]; NGINX_INCLUDE comes last."""
    files = [(NGINX_SHARED_DIR / NGINX_GEO_NAME, ''.join('%s 1;\n' % cidr for cidr in NGINX_RANGES).encode()),
             (NGINX_SHARED_DIR / NGINX_REALIP_NAME,
              ''.join('set_real_ip_from %s;\n' % cidr for cidr in NGINX_RANGES).encode())]
    servers, includes = [], []
    for index, name in enumerate(NGINX_BUNDLE_NAMES):
        geo_file, realip_file = nginx_bundle_paths(name)
        files += [(geo_file, nginx_geo_bundle(name, secrets_by_bundle[name])), (realip_file, nginx_realip_bundle())]
        includes.append('include %s;\n' % geo_file)
        servers.append('server {\n'
                       '    listen 127.0.0.1:%d;\n'
                       '    server_name %s.example.test;\n'
                       '    include %s;\n'
                       '    location / {\n'
                       '        if ($cloudfront_origin_%s = 0) { return 403; }\n'
                       '        if ($origin_verify_%s = 0) { return 403; }\n'
                       '        return 204;\n'
                       '    }\n'
                       '}\n' % (NGINX_FIXTURE_PORTS[index], name, realip_file, name, name))
    vhosts = NGINX_FIXTURE_ROOT / 'vhosts.conf'
    files.append((vhosts, ''.join(servers).encode()))
    files.append((NGINX_INCLUDE, (''.join(includes) + 'include %s;\n' % vhosts).encode()))
    return files


def nginx_phase_config():
    """The nginx section of the nginx phase config: enabled for every fixture bundle."""
    return {'enabled': True, 'shared_dir': str(NGINX_SHARED_DIR),
            'bundles': [dict(zip(('geo_file', 'realip_file'), map(str, nginx_bundle_paths(name))))
                        for name in NGINX_BUNDLE_NAMES]}


def stage_nginx_fixture(staging, secrets_by_bundle):
    """Create the fixture directories (root 0755) and files (root 0644)."""
    staging.mkdir(NGINX_SHARED_DIR, 0o755)
    for name in NGINX_BUNDLE_NAMES:
        staging.mkdir(nginx_bundle_paths(name)[0].parent, 0o755)
    for path, data in nginx_fixture_files(secrets_by_bundle):
        staging.write(path, data, 0o644)


def nginx_reads(path):
    """True for a staged path nginx's configuration reads (NGINX_INCLUDE, the fixture)."""
    path = Path(path)
    return path == NGINX_INCLUDE or path == NGINX_FIXTURE_TOP or NGINX_FIXTURE_TOP in path.parents


class NginxService:
    """What the nginx phase did to the nginx service, recorded before doing it.

    ``units_before`` holds the run-*.service units loaded before the phase
    staged anything (transient_units); cleanup reports any other one left.
    """

    def __init__(self):
        self.reloaded = False
        self.stopped = False
        self.units_before = None

    def restore(self, remaining=()):
        """Cleanup: restart nginx if this run reloaded or stopped it; report leftover units.

        Runs after the staged files are removed; ``remaining`` are the staged
        paths that cleanup could not remove. When one of them is read by
        nginx's configuration (nginx_reads: NGINX_INCLUDE or the fixture),
        nginx is *not* restarted, since it would start on a partial fixture;
        that is reported instead. Otherwise ``systemctl restart`` is
        synchronous (a reload only signals the master), so once it returns
        nginx runs the original configuration again (main() then requires the
        fixture ports closed); then requires it active. Every run-*.service
        unit loaded now but not before the phase is reported as left (never
        stopped here). Returns the items it could not restore (empty on
        success); no checkpoint.
        """
        problems = []
        if self.reloaded or self.stopped:
            if any(nginx_reads(path) for path in remaining):
                problems.append('nginx.service (not restarted: the nginx fixture could not be removed)')
            elif (run_in_cleanup([SYSTEMCTL, 'restart', 'nginx.service'], 'systemctl restart')
                  and run_in_cleanup([SYSTEMCTL, 'is-active', '--quiet', 'nginx.service'], 'systemctl is-active')):
                self.reloaded = self.stopped = False
            else:
                problems.append('nginx.service (restart)')
        if self.units_before is not None:
            listing = output_in_cleanup(TRANSIENT_UNITS_COMMAND)
            if listing is None:
                problems.append('transient units (systemctl list-units failed)')
            else:
                problems += ['transient unit left: ' + name
                             for name in parse_transient_units(listing) if name not in self.units_before]
        return problems


def command_without_secret(args, name, secrets_):
    """Run a fixed service command that must succeed and print no secret."""
    completed = run(args, name)
    if completed.returncode:
        raise VerifyError(name + ' failed (rc=%d)' % completed.returncode)
    if any(secret in completed.stdout or secret in completed.stderr for secret in secrets_):
        raise VerifyError(name + ' printed a fixture secret')
    return completed


def nginx_active():
    """True when nginx.service is active (systemctl is-active rc 0)."""
    return run([SYSTEMCTL, 'is-active', '--quiet', 'nginx.service'], 'systemctl is-active').returncode == 0


def fixture_ports_listening():
    """The NGINX_FIXTURE_PORTS that accept a TCP connection on 127.0.0.1."""
    listening = []
    for port in NGINX_FIXTURE_PORTS:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=5):
                listening.append(port)
        except OSError:
            pass
    return listening


def check_secrets_not_echoed(results, secrets_):
    for result in results:
        if any(secret in result['stdout'] or secret in result['stderr'] for secret in secrets_):
            raise VerifyError(result['command'] + ' echoed a fixture secret')


# nginx.service properties that change when systemd restarts the service.
NGINX_SERVICE_PROPERTIES = ('MainPID', 'ExecMainStartTimestampMonotonic', 'NRestarts')


def _proc_stat(pid, proc):
    """(ppid, starttime) of /proc/PID/stat, or None when the process is gone."""
    try:
        data = (Path(proc) / str(pid) / 'stat').read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    fields = data.rsplit(')', 1)[1].split()
    # Field 4 is the ppid and field 22 the start time; fields[0] is field 3.
    return int(fields[1]), int(fields[19])


def nginx_process_identity(proc=Path('/proc')):
    """What a reload, restart or effective signal of nginx changes.

    systemd's MainPID, its start timestamp and restart count; /run/nginx.pid
    by lstat identity (device, inode, mode, owner, links, size, mtime, ctime)
    and content, which must name MainPID; the master's start time; and the
    set of its children (pid, start time). A restart changes MainPID and the
    pid file; a reload (SIGHUP), SIGWINCH, SIGQUIT or SIGUSR2 replaces or
    ends the workers (or renames the pid file). A signal without such an
    effect (SIGUSR1, reopen the logs) is not observable here.
    """
    completed = run([SYSTEMCTL, 'show', *('--property=' + name for name in NGINX_SERVICE_PROPERTIES),
                     'nginx.service'], 'systemctl show')
    properties = dict(line.split('=', 1) for line in completed.stdout.splitlines() if '=' in line)
    if completed.returncode or set(properties) != set(NGINX_SERVICE_PROPERTIES):
        raise VerifyError('systemctl show nginx.service failed')
    main_pid = properties['MainPID']
    if not re.fullmatch(r'[1-9][0-9]*', main_pid):
        raise VerifyError('nginx.service has no main process')
    try:
        content = NGINX_PID.read_bytes()
    except FileNotFoundError:
        raise VerifyError('nginx pid file is absent while nginx runs') from None
    if content.strip() != main_pid.encode():
        raise VerifyError('nginx pid file does not name the main process of nginx.service')
    master = _proc_stat(main_pid, proc)
    if master is None:
        raise VerifyError('nginx main process is gone')
    children = []
    for entry in sorted(os.listdir(proc)):
        if entry.isdigit():
            info = _proc_stat(entry, proc)
            if info is not None and info[0] == int(main_pid):
                children.append((int(entry), info[1]))
    return {'service': sorted(properties.items()), 'pid_file': [path_identity(NGINX_PID), content.decode()],
            'master_start': master[1], 'children': children}


def require_nginx_identity(before, label):
    """nginx was neither reloaded, restarted nor (effectively) signalled during ``label``."""
    changed = changed_keys(before, nginx_process_identity())
    if changed:
        raise VerifyError(label + ' reloaded, restarted or signalled nginx: ' + ', '.join(changed))


def settled_nginx_identity(attempts=60, interval=0.5):
    """After a reload or start: wait until every fixture port listens and the identity is stable.

    A reload is asynchronous (the old workers end after the new ones start),
    so the identity is taken only once two reads ``interval`` apart agree.
    """
    previous = None
    for _ in range(attempts):
        current = nginx_process_identity()
        if current == previous and fixture_ports_listening() == list(NGINX_FIXTURE_PORTS):
            return current
        previous = current
        time.sleep(interval)
    raise VerifyError('nginx did not settle on the fixture')


def phase_snapshot():
    """The nginx phase's per-command comparison: host_snapshot() plus the fixture.

    Exactly what S0's require_unchanged compares (no relaxation: /etc/nginx
    and /etc/nginx/conf.d with their own times, /run/nginx.pid by full
    identity; the install targets include the staged bundle, the config and
    the state directory with its private namespace; the lock), plus
    /etc/common-sv (the fixture) as a tree. Taken after each staging step, so
    the staging itself and the lock created by verify-cohort are never
    compared as changes.
    """
    snapshot = host_snapshot()
    snapshot[str(NGINX_FIXTURE_TOP)] = tree_digest(NGINX_FIXTURE_TOP)
    return snapshot


def require_phase_unchanged(before, label):
    changed = changed_keys(before, phase_snapshot())
    if changed:
        raise VerifyError(label + ' changed host state: ' + ', '.join(changed))


def inspect_nginx(results, generation, nginx, label):
    """inspect-runtime with the nginx phase config; only the nginx component differs from S0."""
    result = invoke('inspect-runtime', timeout=NGINX_INSPECT_TIMEOUT)
    results.append(result)
    try:
        check_json(result, dict(EXPECTED_INSPECT_RUNTIME, nginx=nginx), generation)
    except VerifyError as error:
        raise VerifyError(label + ': ' + str(error)) from None


def inspect_running(results, generation, nginx, label, service):
    """inspect-runtime while nginx runs: expectation, host and nginx unchanged, no unit left.

    The baseline is taken right before the command, after every staging step.
    """
    baseline, identity = phase_snapshot(), nginx_process_identity()
    inspect_nginx(results, generation, nginx, label)
    require_phase_unchanged(baseline, 'inspect-runtime (' + label + ')')
    require_nginx_identity(identity, 'inspect-runtime (' + label + ')')
    require_no_transient_unit(service, 'inspect-runtime (' + label + ')')


def stopped_snapshot():
    """Host paths nginx -T could write, compared around inspect-runtime while nginx is stopped."""
    snapshot = {str(path): tree_digest(path, own_times=own_times) for path, own_times in STOPPED_TREES}
    snapshot[str(NGINX_PID)] = path_identity(NGINX_PID)
    snapshot[str(RUN_DIR)] = run_snapshot()
    return snapshot


# systemd-run's transient services; only .service units (a run-*.mount is
# not a command's sandbox).
TRANSIENT_UNITS_COMMAND = (SYSTEMCTL, 'list-units', '--all', '--no-legend', '--plain', 'run-*.service')


def parse_transient_units(listing):
    """The run-*.service unit names of a ``systemctl list-units`` listing, sorted."""
    names = []
    for line in listing.splitlines():
        tokens = [token for token in line.split() if token not in ('●', '*')]
        if tokens and tokens[0].startswith('run-') and tokens[0].endswith('.service'):
            names.append(tokens[0])
    return sorted(names)


def transient_units():
    """Names of the loaded run-*.service units (systemd-run's transient services)."""
    completed = run(list(TRANSIENT_UNITS_COMMAND), 'systemctl list-units')
    if completed.returncode:
        raise VerifyError('systemctl list-units failed')
    return parse_transient_units(completed.stdout)


def require_no_transient_unit(service, label):
    """No run-*.service unit is loaded that was not loaded before the phase."""
    left = [name for name in transient_units() if name not in service.units_before]
    if left:
        raise VerifyError(label + ' left a transient unit behind: ' + ', '.join(left))


def output_in_cleanup(args, timeout=60):
    """stdout of a fixed read command of cleanup, or None; like run_in_cleanup, no checkpoint."""
    try:
        completed = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return None
    return completed.stdout if completed.returncode == 0 else None


def journal_cursor():
    completed = run([JOURNALCTL, '--quiet', '--lines=0', '--show-cursor'], 'journalctl cursor')
    match = re.fullmatch(r'-- cursor: (\S+)\n', completed.stdout)
    if completed.returncode or not match:
        raise VerifyError('journal cursor unavailable')
    return match.group(1)


def journal_sync():
    """journalctl --sync: everything logged so far is written before the journal is read."""
    if run([JOURNALCTL, '--sync'], 'journalctl sync').returncode:
        raise VerifyError('journalctl --sync failed')


def journal_entries_after(cursor):
    """Export-format entries (bytes) after ``cursor``, read after journal_sync()."""
    journal_sync()
    phase = run([JOURNALCTL, '--no-pager', '-o', 'export', '--after-cursor=' + cursor], 'journalctl phase',
                timeout=120, text=False)
    if phase.returncode:
        raise VerifyError('journalctl failed')
    return phase.stdout.split(b'\n\n')


# The UNIT field of a systemd-run transient service: run-u<N>.service
# (systemd 249 and 255: 22.04, 24.04) or run-p<PID>-i<N>.service (systemd 259:
# 26.04), each field on its own line of the export format.
SANDBOX_UNIT_FIELD = re.compile(rb'^UNIT=run-(?:u[0-9]+|p[0-9]+-i[0-9]+)\.service$', re.MULTILINE)


def sandbox_ran(entries):
    """An entry of a systemd-run transient unit (SANDBOX_UNIT_FIELD) running
    nginx -T (the observer's sandbox) is among ``entries``."""
    return any(SANDBOX_UNIT_FIELD.search(entry) and (NGINX + ' -T -q').encode() in entry for entry in entries)


def check_journal(cursor, secrets_):
    """No secret anywhere in the whole journal; the phase itself was journaled.

    journalctl --sync first. All fields of every entry (export format,
    bytes). Liveness: the entries after ``cursor`` hold nginx.service's stop
    job and a sandbox unit running nginx -T, so a journal that records
    nothing cannot pass.
    """
    journal_sync()
    whole = run([JOURNALCTL, '--no-pager', '-o', 'export'], 'journalctl', timeout=120, text=False)
    if whole.returncode or not whole.stdout:
        raise VerifyError('journalctl failed')
    if any(secret.encode() in whole.stdout for secret in secrets_):
        raise VerifyError('a fixture secret is in the journal')
    entries = journal_entries_after(cursor)
    def has(*fields):
        return any(all(b'\n' + field + b'\n' in b'\n' + entry + b'\n' for field in fields) for entry in entries)
    if not has(b'UNIT=nginx.service', b'JOB_TYPE=stop') or not sandbox_ran(entries):
        raise VerifyError('the journal did not record the nginx phase')


# Where a command of the phase could leave a secret in a file (besides the
# install targets, the lock and the watched /run entries; see
# secret_search_roots). Searched before cleanup.
SECRET_SEARCH_DIRS = (STATE_DIR, Path('/var/log/nginx'), Path('/tmp'), Path('/var/tmp'))


def secret_search_roots(run_dir=RUN_DIR):
    """The search roots: SECRET_SEARCH_DIRS, the install targets, the lock, the watched /run entries."""
    watched = [Path(run_dir) / name for name in sorted(os.listdir(run_dir)) if RUN_WATCHED.match(name)]
    return tuple(dict.fromkeys((*SECRET_SEARCH_DIRS, *install_targets(), LOCK, *watched)))


def files_holding_secret(roots, secrets_, exclude=()):
    """Regular files below ``roots`` (no symlink followed) whose content holds a secret.

    ``exclude`` are the staged fixture files that hold a secret by design.
    An entry that vanishes during the search is skipped (it cannot hold the
    secret afterwards); any other error is raised. Returns the paths (paths
    are not secret), sorted.
    """
    found, pending, exclude = [], [Path(root) for root in roots], {Path(path) for path in exclude}
    encoded = [secret.encode() for secret in secrets_]
    while pending:
        path = pending.pop()
        try:
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                with os.scandir(path) as scan:
                    pending.extend(path / entry.name for entry in scan)
            elif stat.S_ISREG(info.st_mode) and path not in exclude:
                data = path.read_bytes()
                if any(secret in data for secret in encoded):
                    found.append(str(path))
        except (FileNotFoundError, NotADirectoryError):
            continue
    return sorted(set(found))


def require_no_secret_in_files(secrets_, exclude):
    found = files_holding_secret(secret_search_roots(), secrets_, exclude)
    if found:
        raise VerifyError('a fixture secret is in a file: ' + ', '.join(found))


def verify_refused_with_nginx(results, argv_secret):
    """Every refused subcommand, every argv shape, with the nginx-enabled config.

    The bundle secrets sit in files nginx -T dumps and the argv secret is on
    the command line; the CLI must refuse each identically without reading or
    echoing anything (checked with the whole results later) and change
    neither the host (light check per shape, phase_snapshot per subcommand)
    nor nginx (require_nginx_identity per subcommand).
    """
    help_result = run(['/usr/bin/python3', str(CLI), '--help'], '--help')
    if help_result.returncode:
        raise VerifyError('CLI --help failed')
    refused = classify(parse_subcommands(help_result.stdout))
    for subcommand in refused:
        baseline, identity, light = phase_snapshot(), nginx_process_identity(), light_snapshot()
        for shape, (prefix, extra) in enumerate(refused_invocations(subcommand, argv_secret)):
            result = invoke(subcommand, extra, prefix)
            results.append(result)
            check_refusal(result)
            require_light_unchanged(light, '%s (nginx enabled, argv shape %d)' % (subcommand, shape))
        require_phase_unchanged(baseline, subcommand + ' (nginx enabled)')
        require_nginx_identity(identity, subcommand + ' (nginx enabled)')
    return refused


def verify_stopped(results, generation, service, secrets_):
    """inspect-runtime with nginx stopped: policy unsupported, the sandbox ran, no host change."""
    service.stopped = True
    command_without_secret([SYSTEMCTL, 'stop', 'nginx.service'], 'systemctl stop', secrets_)
    if nginx_active() or os.path.lexists(NGINX_PID):
        raise VerifyError('nginx did not stop')
    before = {'host': phase_snapshot(), 'stopped': stopped_snapshot()}
    cursor = journal_cursor()
    inspect_nginx(results, generation, NGINX_POLICY_UNSUPPORTED, 'nginx stopped')
    after = {'host': phase_snapshot(), 'stopped': stopped_snapshot()}
    changed = [area + ':' + key for area in ('host', 'stopped') for key in changed_keys(before[area], after[area])]
    if changed:
        raise VerifyError('inspect-runtime with nginx stopped changed host state: ' + ', '.join(changed))
    if nginx_active():
        raise VerifyError('inspect-runtime with nginx stopped started nginx')
    require_no_transient_unit(service, 'inspect-runtime (nginx stopped)')
    # The sandbox really ran nginx -T during this inspect (not only earlier).
    if not sandbox_ran(journal_entries_after(cursor)):
        raise VerifyError('inspect-runtime with nginx stopped did not run the nginx sandbox')
    command_without_secret([SYSTEMCTL, 'start', 'nginx.service'], 'systemctl start', secrets_)
    # start is synchronous: nginx now runs the fixture (positive control for
    # the closed ports main() requires after cleanup).
    if not nginx_active():
        raise VerifyError('nginx did not start again with the fixture')
    settled_nginx_identity()
    service.stopped = False


def verify_nginx_phase(source_dir, staging, service):
    """S1: inspect-runtime with nginx enabled against a real nginx fixture (see module doc)."""
    secrets_ = {name: secrets.token_hex(16) for name in NGINX_BUNDLE_NAMES}
    values = tuple(secrets_.values())
    argv_secret = 'cf-s1-argv-secret-' + secrets.token_hex(16)
    if not nginx_active():
        raise VerifyError('nginx is not active before the nginx phase')
    busy = fixture_ports_listening()
    if busy:
        raise VerifyError('a fixture port is already in use: ' + ', '.join(map(str, busy)))
    service.units_before = transient_units()
    cursor = journal_cursor()
    generation = stage_bundle(source_dir, staging)
    stage_config(staging, nginx_phase_config())
    stage_nginx_fixture(staging, secrets_)
    staging.mkdir(STATE_DIR, 0o755)
    results = []
    lock_absent_at_start = not os.path.lexists(LOCK)
    before_cohort = phase_snapshot()
    results.append(invoke_verify_cohort(staging, lock_absent_at_start))
    check_json(results[-1], {'cohort_verified': True, 'runtime_ready': False, 'policy_verified': False}, generation)
    require_lock_file()
    # verify-cohort may change nothing but create the absent lock.
    if changed_keys(before_cohort, phase_snapshot()) != ([str(LOCK)] if lock_absent_at_start else []):
        raise VerifyError('verify-cohort (nginx phase) changed host state other than creating the absent lock')
    command_without_secret([NGINX, '-t', '-q'], 'nginx -t', values)
    service.reloaded = True
    command_without_secret([SYSTEMCTL, 'reload', 'nginx.service'], 'systemctl reload', values)
    settled_nginx_identity()
    inspect_running(results, generation, NGINX_VERIFIED, 'fixture', service)
    refused = verify_refused_with_nginx(results, argv_secret)

    geo_file, realip_file = nginx_bundle_paths(NGINX_BUNDLE_NAMES[0])
    staging.replace(realip_file, nginx_realip_bundle('on'))
    command_without_secret([NGINX, '-t', '-q'], 'nginx -t', values)
    inspect_running(results, generation, NGINX_POLICY_UNSUPPORTED, 'real_ip_recursive on', service)
    staging.replace(realip_file, nginx_realip_bundle())
    inspect_running(results, generation, NGINX_VERIFIED, 'real_ip_recursive restored', service)

    geo = nginx_geo_bundle(NGINX_BUNDLE_NAMES[0], secrets_[NGINX_BUNDLE_NAMES[0]])
    staging.write(NGINX_SYMLINK_TARGET, geo, 0o644)
    staging.replace(geo_file, symlink_to=NGINX_SYMLINK_TARGET)
    command_without_secret([NGINX, '-t', '-q'], 'nginx -t', values)
    inspect_running(results, generation, NGINX_OBSERVATION_FAILED, 'bundle symlink', service)
    staging.replace(geo_file, geo, 0o644)
    inspect_running(results, generation, NGINX_VERIFIED, 'bundle symlink restored', service)

    verify_stopped(results, generation, service, values)
    check_secrets_not_echoed(results, (*values, argv_secret))
    # Before cleanup: no secret in any file a command could have written; the
    # staged fixture files hold them by design.
    require_no_secret_in_files((*values, argv_secret),
                               [path for path in staging.created if nginx_reads(path)])
    check_journal(cursor, (*values, argv_secret))
    return {
        'nginx_checks': 'passed',
        'bundles': len(NGINX_BUNDLE_NAMES),
        'policy_verified': NGINX_VERIFIED['code'],
        'recursive_on': NGINX_POLICY_UNSUPPORTED['code'],
        'bundle_symlink': NGINX_OBSERVATION_FAILED['code'],
        'nginx_stopped': NGINX_POLICY_UNSUPPORTED['code'],
        'stopped_host_unchanged': True,
        'stopped_sandbox_ran': True,
        'host_unchanged_per_command': True,
        'nginx_not_reloaded_by_commands': True,
        'refused_commands': refused,
        'refused_secret_not_echoed': True,
        'transient_units_left': 0,
        'secrets_not_echoed': True,
        'secret_files_absent': True,
        'journal_secret_free': True,
    }


def with_cleanup(staging, body, restore=None):
    """Run ``body`` and always remove the fixture; report both failures if any.

    The termination signals are blocked throughout and cleanup has no
    checkpoint, so nothing interrupts it. On failure the run is unwinding and
    a signal only keeps the original error; after a successful body a signal
    that arrived meanwhile is raised once cleanup is done. ``restore`` (the
    nginx phase's NginxService.restore) runs after the staged paths are
    removed, gets the paths that could not be removed and returns what it
    could not restore; it has no checkpoint either.
    """
    def cleanup():
        remaining = staging.cleanup()
        return [*remaining, *restore(remaining)] if restore is not None else remaining
    try:
        report = body()
    except BaseException as error:
        TERMINATION.unwinding = True
        remaining = cleanup()
        if remaining:
            reason = str(error) if isinstance(error, VerifyError) else type(error).__name__
            raise VerifyError(reason + '; fixture cleanup left: ' + ', '.join(remaining)) from None
        raise
    remaining = cleanup()
    if remaining:
        raise VerifyError('fixture cleanup left: ' + ', '.join(remaining))
    checkpoint()
    return report


def main(argv):
    if len(argv) != 2:
        raise VerifyError('usage: s0_refusal_verify.py ROLE_FILES_DIR')
    # The shared target list is read here, not at import: a missing or
    # malformed file is a VerifyError of main(), i.e. the fixed failure report.
    install_targets()
    check_environment()
    require_clean_start()
    # Includes the lock's presence, mode and owner at start.
    pristine = host_snapshot()
    staging = Staging()
    # The termination signals are blocked from here to process exit, before
    # anything is staged.
    install_termination()
    report = with_cleanup(staging, lambda: verify_with_fixture(argv[1], staging))
    require_clean_start()
    # The fixture, the state directory and a lock this run caused are gone, and
    # a pre-existing lock kept its mode and owner: the host equals pristine.
    require_unchanged(pristine, 'fixture cleanup')
    report['fixture_removed'] = True
    # S1 nginx phase, after the S0 host equals pristine again.
    before_nginx = host_snapshot(around_nginx_phase=True)
    nginx_staging, service = Staging(), NginxService()
    report['nginx_phase'] = with_cleanup(nginx_staging, lambda: verify_nginx_phase(argv[1], nginx_staging, service),
                                         service.restore)
    require_clean_start()
    if not nginx_active() or fixture_ports_listening():
        raise VerifyError('nginx does not run the original configuration again')
    require_unchanged(before_nginx, 'nginx phase cleanup', around_nginx_phase=True)
    report['nginx_phase']['fixture_removed'] = True
    report['nginx_phase']['nginx_restored'] = True
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except VerifyError as error:
        print(json.dumps({'s0_checks': 'failed', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # never print an unexpected message: it may hold argv
        print(json.dumps({'s0_checks': 'failed', 'reason': 'unexpected ' + type(error).__name__}), file=sys.stderr)
        sys.exit(1)
