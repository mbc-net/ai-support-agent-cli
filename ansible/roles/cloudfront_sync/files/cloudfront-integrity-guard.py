#!/usr/bin/python3
"""Generation-bound guardian entry; component checks are not yet connected."""
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

import contextlib
import fcntl
import json
import os
from pathlib import Path
import stat
import sys

@contextlib.contextmanager
def existing_shared_lock():
    path=Path('/run/lock/cloudfront-sync.lock')
    for ancestor in (path.parent.parent,path.parent):
        parent=ancestor.lstat()
        sticky=ancestor==path.parent and parent.st_mode&stat.S_ISVTX
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=0 or (parent.st_mode&0o022 and not sticky):
            raise BundleEntryError('unsafe_guard_lock_directory')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        current=os.fstat(fd);named=path.lstat()
        if (not stat.S_ISREG(current.st_mode) or current.st_nlink!=1 or current.st_uid!=0
                or stat.S_IMODE(current.st_mode)!=0o600 or _bg_identity(current)!=_bg_identity(named)):
            raise BundleEntryError('unsafe_guard_lock')
        fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
        yield
    finally:os.close(fd)

def readonly_components(config):
    """Internal B0 shared observation only; no operational CLI/health grant."""
    if _BUNDLE_RUNTIME is None:
        raise BundleEntryError('verified_snapshot_registry_required')
    try:
        shared=_BUNDLE_RUNTIME[0]['cloudfront_snapshot']
        return shared.Snapshotter(backend=config['firewall']['backend'],
                                  nginx_enabled=config['nginx']['enabled'],
                                  nginx_shared_dir=config['nginx']['shared_dir'],
                                  nginx_bundles=config['nginx']['bundles']).collect()
    except Exception:
        raise BundleEntryError('readonly_snapshot_unavailable') from None



def main():
    try:
        if os.geteuid()!=0 or len(sys.argv)!=1:
            raise BundleEntryError('guardian_fixed_invocation_required')
        with existing_shared_lock():
            _bundle_runtime()
            # Generation success is not state/intent/UFW/nginx health.
            raise BundleEntryError('guardian_components_not_connected')
    except Exception:
        print(json.dumps({'error':'guardian_not_ready','healthy':False}),file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
