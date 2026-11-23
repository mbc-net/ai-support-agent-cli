#!/usr/bin/env python3
"""Synchronize CloudFront origin-facing ranges without owning other host policy.

The CLI is intentionally root-only and uses fixed state/lock paths. Only the
read-only commands (verify-cohort, inspect-state, inspect-runtime) run in
stage S0; no host actor exists. Usage is printed (exit 0) only when the whole
argv is -h or --help. Every other outcome below prints one fixed JSON code
on stderr with empty stdout (argv is never echoed); the first case that
matches decides.
  exit 1 runtime_actor_not_connected: a token equals any other known command
  name, in any position, whatever the other arguments (including -h/--help);
  refused before anything is parsed.
  exit 2 unknown_command: no token is a command name of either kind (unknown
  or missing subcommand), even with -h/--help unless it is the whole argv.
  exit 2 invalid_arguments: an argument error of a read-only command
  (unknown option, extra argument, --lock-fd not a non-negative decimal
  integer of at most 10 digits, any -h/--help).
  exit 1 sync_failed: a read-only command failed (not root, other config
  path, lock absent or held, --lock-fd not an open descriptor of the lock
  file, bundle, config, state).
Production has no alternate URL or command configuration. Nginx
configuration is never logged.
"""
BUNDLE_GENERATION_ID = "0000000000000000000000000000000000000000000000000000000000000000"

# BEGIN FIXED BUNDLE ENTRY STUB
import hashlib as _bg_hashlib
import json as _bg_json
import math as _bg_math
import os as _bg_os
from pathlib import Path as _BgPath
import re as _bg_re
import stat as _bg_stat
import sys as _bg_sys
from types import ModuleType as _BgModule

_BG_ENTRIES = ('cloudfront-sync.py', 'cloudfront-integrity-guard.py', 'install_cloudfront_sync.py')
_BG_HELPERS = ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot')
_BG_BOOTS = ('bundle_manifest.py', 'bundled_source.py')
_BG_PROFILES = ('ufw_kernel_profile_22.json', 'ufw_kernel_profile_24.json', 'ufw_kernel_profile_26.json')
_BG_NAMES = tuple(sorted((*_BG_ENTRIES, *_BG_BOOTS, *(name+'.py' for name in _BG_HELPERS), *_BG_PROFILES)))
_BG_DIRECTORY = _BgPath('/usr/local/libexec/cloudfront-sync')
_BG_BOOT_MODULES = ('_cloudfront_bundle_manifest', '_cloudfront_bundle_source')
_BG_TOTAL = 8 * 1024 * 1024
_BUNDLE_RUNTIME = None


class BundleEntryError(ValueError):
    """Fixed failure codes, never source/config/subprocess content."""


def _bg_sha(raw):
    return _bg_hashlib.sha256(raw).hexdigest()


def _bg_hex(value):
    return type(value) is str and _bg_re.fullmatch('[0-9a-f]{64}', value) is not None


def _bg_canonical(value):
    return _bg_json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def _bg_json_bytes(raw, limit, *, integers_only=True):
    if type(raw) is not bytes or not 0 < len(raw) <= limit:
        raise BundleEntryError('bundle_json_budget')
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise BundleEntryError('bundle_duplicate_key')
            result[key] = value
        return result
    def invalid(unused):
        raise BundleEntryError('bundle_noninteger_number')
    def number(text):
        value=float(text)
        if not _bg_math.isfinite(value):
            raise BundleEntryError('bundle_nonfinite_number')
        return value
    def integer(text):
        if len(text) > 20:
            raise BundleEntryError('bundle_integer_budget')
        return int(text)
    try:
        value = _bg_json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                              parse_float=invalid if integers_only else number,
                              parse_constant=invalid, parse_int=integer)
        pending, count = [(value, 0)], 0
        while pending:
            item, depth = pending.pop(); count += 1
            if count > 100000 or depth > 64:
                raise BundleEntryError('bundle_json_structure_budget')
            if isinstance(item, dict):pending.extend((part, depth+1) for part in item.values())
            elif isinstance(item, list):pending.extend((part, depth+1) for part in item)
        return value
    except BundleEntryError:
        raise
    except Exception:
        raise BundleEntryError('invalid_bundle_json') from None


def _bg_manifest(raw, literal):
    value = _bg_json_bytes(raw, 64*1024)
    if (not _bg_hex(literal) or type(value) is not dict
            or set(value) != {'version','generation_id','inputs','assets'}
            or type(value['version']) is not int or value['version'] != 1
            or value['generation_id'] != literal or _bg_canonical(value)+b'\n' != raw):
        raise BundleEntryError('running_generation_differs')
    inputs = value['inputs']
    if (type(inputs) is not dict or set(inputs) != {'version','assets'}
            or type(inputs['version']) is not int or inputs['version'] != 1
            or type(inputs['assets']) is not dict or set(inputs['assets']) != set(_BG_NAMES)
            or type(value['assets']) is not dict or set(value['assets']) != set(_BG_NAMES)):
        raise BundleEntryError('bundle_fixed_schema')
    total = 0
    for name in _BG_NAMES:
        row, actual = inputs['assets'][name], value['assets'][name]
        mode = 0o755 if name in _BG_ENTRIES else 0o644
        kind = 'entry' if name in _BG_ENTRIES else 'json' if name in _BG_PROFILES else 'source'
        if (type(row) is not dict or set(row) != {'kind','mode','size','source_sha256'}
                or type(row['kind']) is not str or row['kind'] != kind
                or type(row['mode']) is not int or row['mode'] != mode
                or type(row['size']) is not int or not 0 < row['size'] <= 2*1024*1024
                or not _bg_hex(row['source_sha256']) or type(actual) is not dict
                or set(actual) != {'mode','size','sha256'} or type(actual['mode']) is not int
                or actual['mode'] != mode or type(actual['size']) is not int
                or actual['size'] != row['size'] or not _bg_hex(actual['sha256'])):
            raise BundleEntryError('bundle_asset_schema')
        if name not in _BG_ENTRIES and actual['sha256'] != row['source_sha256']:
            raise BundleEntryError('bootstrap_not_inputs_bound')
        total += row['size']
    if total > _BG_TOTAL:
        raise BundleEntryError('bundle_aggregate_budget')
    if _bg_sha(_bg_canonical(inputs)) != literal:
        raise BundleEntryError('bundle_inputs_digest_differs')
    return value


def _bg_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _bg_capture(directory, names, *, owner=0):
    """Fixed asset reads only. All paths/FDs are NOFOLLOW and metadata checked."""
    directory = _BgPath(directory)
    if (not directory.is_absolute() or '..' in directory.parts or type(owner) is not int
            or not 0 <= owner < 2**32-1 or type(names) is not tuple
            or (not set(names) <= {*_BG_NAMES, 'bundle-manifest.json'}
                and not (directory == _BgPath('/etc/cloudfront-sync') and names == ('config.json',)))
            or len(set(names)) != len(names)):
        raise BundleEntryError('invalid_bundle_capture')
    fd = _bg_os.open('/', _bg_os.O_RDONLY | _bg_os.O_DIRECTORY)
    anchors, sources, total = [], {}, 0
    try:
        current = _BgPath('/')
        for component in directory.parts[1:]:
            child = _bg_os.open(component, _bg_os.O_RDONLY | _bg_os.O_DIRECTORY | _bg_os.O_NOFOLLOW, dir_fd=fd)
            _bg_os.close(fd); fd = child; current /= component
            info = _bg_os.fstat(fd)
            sticky = current in (_BgPath('/tmp'),_BgPath('/private/tmp')) and info.st_uid == 0 and info.st_mode & _bg_stat.S_ISVTX
            if info.st_uid not in (0,owner) or (info.st_mode & 0o022 and not sticky):
                raise BundleEntryError('unsafe_bundle_directory')
            anchors.append((current,_bg_identity(info)))
        identities = {}
        for name in names:
            before = _bg_os.stat(name, dir_fd=fd, follow_symlinks=False)
            mode = 0o640 if name == 'config.json' else 0o755 if name in _BG_ENTRIES else 0o644
            limit = 64*1024 if name in ('bundle-manifest.json','config.json') else 2*1024*1024
            if (not _bg_stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != owner
                    or _bg_stat.S_IMODE(before.st_mode) != mode or not 0 < before.st_size <= limit):
                raise BundleEntryError('unsafe_bundle_asset')
            leaf = _bg_os.open(name, _bg_os.O_RDONLY | _bg_os.O_NOFOLLOW | _bg_os.O_NONBLOCK | getattr(_bg_os,'O_NOATIME',0), dir_fd=fd)
            try:
                if _bg_identity(_bg_os.fstat(leaf)) != _bg_identity(before):
                    raise BundleEntryError('bundle_changed_during_read')
                data = bytearray()
                while True:
                    part = _bg_os.read(leaf,min(65536,limit+1-len(data)))
                    if not part:break
                    data.extend(part); total += len(part)
                    if len(data) > limit or total > _BG_TOTAL+64*1024:
                        raise BundleEntryError('bundle_capture_budget')
                if (_bg_identity(_bg_os.fstat(leaf)) != _bg_identity(before)
                        or _bg_identity(_bg_os.stat(name,dir_fd=fd,follow_symlinks=False)) != _bg_identity(before)):
                    raise BundleEntryError('bundle_changed_during_read')
                sources[name] = bytes(data); identities[name] = _bg_identity(before)
            finally:
                _bg_os.close(leaf)
        if (any(_bg_identity(path.lstat()) != identity for path,identity in anchors)
                or any(_bg_identity(_bg_os.stat(name,dir_fd=fd,follow_symlinks=False)) != identity for name,identity in identities.items())):
            raise BundleEntryError('bundle_changed_during_read')
        return sources
    finally:
        _bg_os.close(fd)


def _bundle_config():
    directory=_BgPath('/etc/cloudfront-sync')
    first=_bg_capture(directory,('config.json',))['config.json']
    if _bg_capture(directory,('config.json',))['config.json'] != first:
        raise BundleEntryError('config_changed_during_read')
    return _bg_json_bytes(first,64*1024,integers_only=False)


def _bg_snapshot(assets):
    if type(assets) is not dict or set(assets) != set(_BG_NAMES) or any(type(name) is not str for name in assets):
        raise BundleEntryError('bundle_fixed_asset_set')
    copied = dict(assets)
    if (any(type(raw) is not bytes or not 0 < len(raw) <= 2*1024*1024 for raw in copied.values())
            or sum(map(len,copied.values())) > _BG_TOTAL):
        raise BundleEntryError('bundle_source_budget')
    return copied


def _bundle_verified(manifest_bytes, assets, literal):
    """Authenticate both bootstrap byte strings before either compile/exec."""
    assets = _bg_snapshot(assets)
    manifest = _bg_manifest(manifest_bytes,literal)
    if any(len(assets[name]) != manifest['assets'][name]['size']
           or _bg_sha(assets[name]) != manifest['assets'][name]['sha256'] for name in _BG_NAMES):
        raise BundleEntryError('bundle_bytes_differ')
    if any(name in _bg_sys.modules for name in _BG_BOOT_MODULES):
        raise BundleEntryError('unverified_bootstrap_registry')
    created = []
    try:
        # Compile only the exact hash-verified bytes already captured above.
        codes = [compile(assets[name],name,'exec',dont_inherit=True) for name in _BG_BOOTS]
        modules = []
        for name,filename,code in zip(_BG_BOOT_MODULES,_BG_BOOTS,codes):
            module = _BgModule(name); module.__file__ = str(_BG_DIRECTORY/filename)
            module.__cached__ = None; module.__package__ = ''
            _bg_sys.modules[name] = module; created.append((name,module))
            exec(code,module.__dict__); modules.append(module)
        checked = modules[0].validate_bundle(manifest_bytes,assets,running_generation=literal)
        expected = modules[0].helper_expectations(checked)
        return modules[1],expected,checked
    except BaseException:
        for name,module in reversed(created):
            if _bg_sys.modules.get(name) is module:del _bg_sys.modules[name]
        raise BundleEntryError('bundle_bootstrap_failed') from None


def _bundle_runtime(*, directory=_BG_DIRECTORY, owner=0):
    global _BUNDLE_RUNTIME
    if _BUNDLE_RUNTIME is not None:
        raise BundleEntryError('bundle_runtime_reentry')
    try:
        # A journal's mere presence blocks runtime; it is not repaired here.
        try:
            _BgPath('/var/lib/cloudfront-sync/private/install-journal.json').lstat()
        except FileNotFoundError:
            pass
        else:
            raise BundleEntryError('pending_installation')
        first = _bg_capture(directory,('bundle-manifest.json',),owner=owner)['bundle-manifest.json']
        _bg_manifest(first,BUNDLE_GENERATION_ID)
        assets = _bg_capture(directory,_BG_NAMES,owner=owner)
        again = _bg_capture(directory,('bundle-manifest.json',*_BG_NAMES),owner=owner)
        if again.pop('bundle-manifest.json') != first or again != assets:
            raise BundleEntryError('bundle_changed_during_read')
        bootstrap,expected,checked = _bundle_verified(first,assets,BUNDLE_GENERATION_ID)
        modules = bootstrap.BundledSources(directory,owner=owner,expected_hashes=expected).load()
        _BUNDLE_RUNTIME = (modules,checked)
        return modules
    except BundleEntryError:
        raise
    except BaseException:
        raise BundleEntryError('bundle_runtime_failed') from None
# END FIXED BUNDLE ENTRY STUB

import argparse
import contextlib
import fcntl
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import stat
import sys

CONFIG = Path('/etc/cloudfront-sync/config.json')
LOCK = Path('/run/lock/cloudfront-sync.lock')
# The only subcommands that run in stage S0; argparse selects one of them.
READ_ONLY_COMMANDS = frozenset({'verify-cohort', 'inspect-state', 'inspect-runtime'})
# Known actor commands. Any argv token equal to one of them, wherever it is
# (also as an option value such as ``--config apply``: over-refusal is the safe
# side), refuses before argparse runs, so a missing or surplus (secret)
# argument cannot turn the refusal into an argparse error. Their subparsers
# exist only for --help and define no options.
REFUSED_COMMANDS = frozenset({'preflight', 'plan', 'sync', 'apply', 'import', 'import-plan'})
def lock_fd_number(value):
    """argparse type of --lock-fd: a non-negative decimal integer of at most 10
    digits (ASCII digits only, leading zeros allowed).

    Only the syntax is checked here (anything else, including an 11th digit,
    is invalid_arguments, so int() never sees a long string); whether the
    number is an open descriptor of the lock file is checked when the lock is
    taken, and its failure is sync_failed.
    """
    if re.fullmatch(r'[0-9]{1,10}', value) is None:
        raise ValueError('lock fd')
    return int(value)


# The global options, each taking exactly one value.
GLOBAL_OPTIONS = (('--config', {'default': str(CONFIG)}), ('--lock-fd', {'type': lock_fd_number}))
# Usage is printed only when one of these is the whole argv.
HELP_OPTIONS = ('-h', '--help')


class SyncError(Exception):
    """A sanitized operational failure; never include subprocess/config content."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def snapshot_config_hash(snapshot, config):
    """The config hash the persisted baseline/ledger records (cloudfront_snapshot).

    Delegates to the bundle's public config_hash, the one definition the
    ledger also uses, instead of a CLI re-implementation.
    """
    return snapshot.config_hash(config)


def safe_path(value, prefixes):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in value.split('/') or '//' in value:
        raise SyncError('unsafe filesystem path')
    p = Path(value)
    if not any(p != Path(base) and p.is_relative_to(base) for base in prefixes):
        raise SyncError('path outside permitted directory')
    return p


def validate_config(c):
    def ascii_only(value):
        # True when every string (key or value) in the JSON value is ASCII.
        if isinstance(value, str):
            return value.isascii()
        if isinstance(value, dict):
            return all(ascii_only(key) and ascii_only(item) for key, item in value.items())
        if isinstance(value, list):
            return all(ascii_only(item) for item in value)
        return True

    # Checked first and for the whole value (keys too): an accepted config is
    # ASCII, so its canonical JSON is the same bytes with or without
    # ensure_ascii and the bundle's config_hash (ensure_ascii=False) equals
    # the value already persisted in P, state and journal. A lone surrogate
    # (JSON "\ud800") is not ASCII either.
    if not ascii_only(c):
        raise SyncError('config strings must be ASCII')
    if not isinstance(c, dict) or set(c) != {'host_address', 'firewall', 'nginx', 'limits', 'notify_unit'}:
        raise SyncError('invalid config keys')
    try:
        if not isinstance(c['host_address'], str):
            raise ValueError()
        ipaddress.ip_address(c['host_address'])
    except (ValueError, TypeError) as exc:
        raise SyncError('host_address must be an IP address') from exc
    # A public host address never has a zone; ipaddress accepts "fe80::1%eth0".
    if '%' in c['host_address']:
        raise SyncError('host_address must not carry an IPv6 scope id')
    f, n, limits = c['firewall'], c['nginx'], c['limits']
    if not isinstance(f, dict) or set(f) != {'backend', 'ports'} or f['backend'] not in ('ufw', 'none'):
        raise SyncError('invalid firewall config')
    ports = f['ports']
    if not isinstance(ports, list) or not ports or any(type(p) is not int or not 1 <= p <= 65535 or p == 22 for p in ports) or len(set(ports)) != len(ports):
        raise SyncError('invalid or SSH firewall port')
    if not isinstance(n, dict) or set(n) != {'enabled', 'shared_dir', 'bundles'} or type(n['enabled']) is not bool or not isinstance(n['bundles'], list):
        raise SyncError('invalid nginx config')
    safe_path(n['shared_dir'], ['/etc/nginx', '/etc/common-sv/nginx'])
    if n['enabled'] and not n['bundles']:
        raise SyncError('nginx bundles must not be empty')
    seen = set()
    for bundle in n['bundles']:
        if not isinstance(bundle, dict) or set(bundle) != {'geo_file', 'realip_file'}:
            raise SyncError('invalid nginx bundle')
        for path in bundle.values():
            safe_path(path, ['/etc/nginx', '/etc/common-sv/nginx'])
        key = (bundle['geo_file'], bundle['realip_file'])
        if key in seen:
            raise SyncError('duplicate nginx bundle')
        seen.add(key)
    if not isinstance(limits, dict) or set(limits) != {'max_changes', 'min_ratio'}:
        raise SyncError('invalid limits config')
    if type(limits['max_changes']) is not int or not 1 <= limits['max_changes'] <= 1000:
        raise SyncError('invalid max_changes')
    ratio = limits['min_ratio']
    if type(ratio) not in (int, float) or not math.isfinite(ratio) or not 0 < ratio <= 1:
        raise SyncError('invalid min_ratio')
    if not isinstance(c['notify_unit'], str) or (c['notify_unit'] and not re.fullmatch(r'[A-Za-z0-9_@.-]+\.service', c['notify_unit'])):
        raise SyncError('invalid notify unit')
    return c


def check_path(path, *, directory=False, writable=False):
    """Reject symlinks and writable-by-other ancestors, including target itself."""
    p = Path(path)
    for current in [*reversed(p.parents), p]:
        try:
            info = current.lstat()
        except FileNotFoundError:
            if current == p:
                raise SyncError('required path is missing')
            raise SyncError('required parent directory is missing')
        if stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise SyncError('unsafe ownership, mode, or symlink')
        if current != p and not stat.S_ISDIR(info.st_mode):
            raise SyncError('non-directory path ancestor')
    if directory and not stat.S_ISDIR(info.st_mode):
        raise SyncError('expected directory')
    if not directory and not stat.S_ISREG(info.st_mode):
        raise SyncError('expected regular file')
    if writable and info.st_mode & 0o077:
        raise SyncError('private file is accessible by other users')


class Host:
    """Refusal points only; S0 has no host-command, fetch or mutation actor.

    S0 removed the old B-draft command runner, AWS fetcher, UFW/nginx parsers,
    observers and mutation helpers, so deleting a refusal can no longer revive
    them. Neither class is reachable from main(). C4 must connect a separately
    reviewed actor instead of restoring the removed code.
    """
    # Every signature accepts any arguments, so the refusal never depends on
    # how a caller (old or new) spells the call: no TypeError path exists.
    def command(self, *_args, **_kwargs):
        # Refuse first: no bundle/adapter lookup, no argv inspection.
        raise SyncError('runtime_actor_not_connected')

    def write_nginx(self, *_args, **_kwargs):
        # Refuse first: neither the config nor the rendered files are inspected.
        raise SyncError('runtime_actor_not_connected')


class Engine:
    """Refusal point only: the old B-draft transaction actor was removed in S0.

    Construction fails for every host, real or injected, until C4 connects a new
    actor; no state directory is created and no host operation is reachable.
    """
    def __init__(self, *_args, **_kwargs):
        # Refuse first: no config validation or adapter lookup can make the
        # refusal depend on input or on bundle state.
        raise SyncError('runtime_actor_not_connected')


@contextlib.contextmanager
def exclusive_lock(inherited=None, *, create=True, shared=False):
    # shared=True (inspect-state/inspect-runtime) takes LOCK_SH only on a
    # descriptor opened here, so inspections and the integrity guardian
    # (LOCK_SH) coexist while a deployment or verify-cohort (LOCK_EX) excludes
    # them. An inherited --lock-fd is always LOCK_EX: flock locks the open file
    # description, so LOCK_SH on the deployer's descriptor would downgrade its
    # exclusive lock.
    # Ubuntu uses a root-owned sticky /run/lock (1777). Its sticky bit
    # protects the root-owned lock from replacement by other users. Other
    # writable parents remain forbidden.
    parent = LOCK.parent.lstat()
    if LOCK.parent == Path('/run/lock') and parent.st_uid == 0 and stat.S_ISDIR(parent.st_mode) and parent.st_mode & stat.S_ISVTX:
        check_path(LOCK.parent.parent, directory=True)
    else:
        check_path(LOCK.parent, directory=True)
    if inherited is None:
        # Flags stay literal at each call: the static test allowlists exactly
        # this one creating open (verify-cohort) and requires every other
        # os.open reachable from main() to be provably read-only. The
        # read-only open is O_NONBLOCK (as the guardian's): a FIFO at the
        # lock path would otherwise block it until a writer appears; it is
        # then refused by the file-type check below (sync_failed).
        fd=(os.open(LOCK,os.O_RDWR|os.O_NOFOLLOW|os.O_CREAT,0o600) if create
            else os.open(LOCK,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK))
    else:
        fd = inherited
    def is_lock_file(st, lst):
        # The descriptor is the root-owned 0600 single-link regular file that
        # LOCK names right now (same device, inode, file type and owner). The
        # mode is exactly 0600, as the guardian requires (existing_shared_lock):
        # 0400, 0700 or a set-id bit is refused too.
        return (stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and not stat.S_ISLNK(lst.st_mode) and st.st_uid == 0
                and stat.S_IMODE(st.st_mode) == 0o600 and (st.st_dev, st.st_ino, stat.S_IFMT(st.st_mode), st.st_uid)
                == (lst.st_dev, lst.st_ino, stat.S_IFMT(lst.st_mode), lst.st_uid))
    try:
        if not is_lock_file(os.fstat(fd), LOCK.lstat()):
            raise SyncError('invalid lock descriptor')
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared and inherited is None else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SyncError('another sync or deployment holds the lock') from exc
        if inherited is None:
            # A lock opened here may have been unlinked (and recreated) between
            # the open and the flock: the flock then guards an orphaned inode
            # that no other locker can see. Check the path again now that the
            # lock is held; on a mismatch the finally closes (unlocks) the fd.
            # An inherited --lock-fd is the caller's: it is checked against the
            # path once, above, and its lifetime is the caller's to guard.
            try:
                replaced = not is_lock_file(os.fstat(fd), LOCK.lstat())
            except OSError as exc:
                raise SyncError('lock file replaced while locking') from exc
            if replaced:
                raise SyncError('lock file replaced while locking')
        yield
    finally:
        if inherited is None:
            os.close(fd)


class ArgumentRejected(Exception):
    """An argv error. Carries no text: argparse messages quote argv values."""


class FixedErrorParser(argparse.ArgumentParser):
    """argparse whose errors never reach stderr; main() prints a fixed code."""

    def error(self, message):
        raise ArgumentRejected()


def build_parser():
    # The full command set stays in --help (the S0 verifier discovers it there),
    # but only the read-only subparsers are ever used to parse argv. No parser
    # has a help action (add_help=False), so parsing can never exit; main()
    # prints the usage itself for a sole -h/--help.
    parser = FixedErrorParser(description=__doc__, allow_abbrev=False, add_help=False)
    for name, options in GLOBAL_OPTIONS:
        parser.add_argument(name, **options)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in sorted(READ_ONLY_COMMANDS | REFUSED_COMMANDS):
        sub.add_parser(name, allow_abbrev=False, add_help=False)
    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) == 1 and argv[0] in HELP_OPTIONS:
        build_parser().print_help()
        return 0
    if any(token in REFUSED_COMMANDS for token in argv):
        # S0 authenticates a cohort, not true-kernel/P/T transaction safety.
        # Refuse before argparse, root/config-path checks, the lock (O_CREAT),
        # the bundle bootstrap and the config read, so a refused command
        # touches nothing and its arguments are never parsed or echoed.
        # C4 must connect a newly reviewed actor here instead of removing this.
        print(canonical({'error': 'runtime_actor_not_connected'}), file=sys.stderr)
        return 1
    if not any(token in READ_ONLY_COMMANDS for token in argv):
        # No read-only command name at all (unknown, missing or option-like
        # tokens only): fixed code, argv never parsed.
        print(canonical({'error': 'unknown_command'}), file=sys.stderr)
        return 2
    try:
        # -h/--help anywhere but alone is an argument error, never usage.
        if any(token in HELP_OPTIONS for token in argv):
            raise ArgumentRejected()
        # argparse alone decides which read-only command argv selects.
        args = build_parser().parse_args(argv)
        if args.command not in READ_ONLY_COMMANDS:
            raise ArgumentRejected()
    except ArgumentRejected:
        print(canonical({'error': 'invalid_arguments'}), file=sys.stderr)
        return 2
    try:
        if os.geteuid() != 0:
            raise SyncError('root is required')
        if Path(args.config) != CONFIG:
            raise SyncError('only the fixed config path is permitted')
        lock=(exclusive_lock(args.lock_fd,create=False,shared=True) if args.command in ('inspect-state','inspect-runtime')
              else exclusive_lock(args.lock_fd))
        with lock:
            modules = _bundle_runtime()
            config = validate_config(_bundle_config())
            if args.command == 'verify-cohort':
                print(canonical({'generation_id':BUNDLE_GENERATION_ID,'cohort_verified':True,
                                 'runtime_ready':False,'policy_verified':False}))
                return 0
            # Both inspections read the private state exactly once.
            module=modules['cloudfront_snapshot']
            evidence=module.read_private_state('/var/lib/cloudfront-sync/private',owner=0,group=0)
            # A missing state/journal is 'absent' only when the reader knows
            # the file does not exist (state_files_read: directory absent, or
            # every file read); when it stopped at the listing (unknown
            # entries) the files were never read: 'not_read'.
            unparsed='absent' if evidence.state_files_read is True else 'not_read'
            if args.command == 'inspect-state':
                print(canonical({'generation_id':BUNDLE_GENERATION_ID,'inspection':'read_only_state_only',
                                 'private_state_disposition':evidence.disposition,
                                 'state_disposition':evidence.state.disposition if evidence.state else unparsed,
                                 'journal_disposition':evidence.journal.disposition if evidence.journal else unparsed,
                                 'runtime_ready':False}))
                return 0
            if args.command == 'inspect-runtime':
                snapshot=module.Snapshotter(backend=config['firewall']['backend'],
                                            nginx_enabled=config['nginx']['enabled'],
                                            nginx_shared_dir=config['nginx']['shared_dir'],
                                            nginx_bundles=config['nginx']['bundles']).collect()
                state=evidence.state
                # The state's baseline is the admission baseline only when the
                # whole private namespace is data-only (no journal, pending or
                # companion entry next to the state); any other disposition is
                # manual and admits nothing. The config hash is compared only
                # with that baseline; without one it is neither computed nor
                # passed.
                data_state=(state if evidence.disposition=='pt_state_data_only' and state is not None
                            and state.disposition=='pt_state_data_only' else None)
                admission=module.admit_snapshot(snapshot,data_state.baseline if data_state else None,
                    config_hash=snapshot_config_hash(module,config) if data_state else None,
                    enrollment_id=data_state.enrollment_id if data_state else None,owner=0)
                try:
                    context=module.ContextCollector(backend=config['firewall']['backend']).collect()
                    if type(context) is module.NotApplicable:
                        context_status={'status':'not_applicable','component':'context'}
                    else:
                        context_status={'status':'observed_unverified','stable_raw':context.stable_raw}
                except Exception:
                    context_status={'status':'failure','code':'context_observation_failed'}
                def public_component(value):
                    if type(value) is module.NotApplicable:
                        return {'status':'not_applicable','component':value.component}
                    if type(value) is module.ComponentResult:
                        return {'status':value.status,'code':value.code}
                    raise SyncError('invalid readonly component result')
                print(canonical({'generation_id':BUNDLE_GENERATION_ID,'inspection':'read_only_observation',
                                 'private_state':evidence.disposition,
                                 'state':state.disposition if state else unparsed,
                                 'journal':evidence.journal.disposition if evidence.journal else unparsed,
                                 'firewall':public_component(admission.firewall),
                                 'nginx':public_component(admission.nginx),
                                 'context':context_status,'runtime_ready':False}))
                return 0
            # Unreachable while READ_ONLY_COMMANDS matches the branches above;
            # fails closed (sanitized) if they ever diverge.
            raise SyncError('unclassified_read_only_command')
    except Exception:
        # Exception chains can include headers, configuration, and subprocess
        # output. Only a fixed code reaches stdout/stderr or service logs.
        print(canonical({'error': 'sync_failed'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
