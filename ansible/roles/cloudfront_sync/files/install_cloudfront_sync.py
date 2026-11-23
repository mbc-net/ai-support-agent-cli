#!/usr/bin/python3
"""Install trusted bundled assets while the sync timer is quiesced.

The helper is run from bundled source with a JSON payload on stdin. Paths and
commands are fixed here; recipe variables cannot select executable locations.
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
import base64
import fcntl
import ipaddress
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time


class InstallError(Exception):
    """An installation failed, possibly requiring operator recovery."""


class Paths:
    def __init__(self, root=Path('/')):
        self.root = Path(root)
        self.engine = self.at('/usr/local/libexec/cloudfront-sync/cloudfront-sync.py')
        self.config = self.at('/etc/cloudfront-sync/config.json')
        self.service = self.at('/etc/systemd/system/cloudfront-sync.service')
        self.timer = self.at('/etc/systemd/system/cloudfront-sync.timer')
        self.monitor = self.at('/usr/share/cloudfront-sync/zabbix-template.json')
        self.private = self.at('/var/lib/cloudfront-sync/private')
        self.state = self.private / 'state.json'
        self.journal = self.private / 'install-journal.json'
        self.sync_lock = self.at('/run/lock/cloudfront-sync.lock')
        self.install_lock = self.at('/run/lock/cloudfront-sync-install.lock')

    def at(self, absolute):
        return self.root / absolute.lstrip('/')

    def targets(self):
        return {'engine': (self.engine, 0o755), 'config': (self.config, 0o640),
                'service': (self.service, 0o644), 'timer': (self.timer, 0o644),
                'monitor': (self.monitor, 0o644)}


def validate(data):
    if not isinstance(data, dict) or set(data) != {'config', 'timer_enabled', 'approve_token', 'assets'}:
        raise InstallError('invalid installer payload')
    config = data['config']
    if not isinstance(config, dict) or set(config) != {'host_address', 'firewall', 'nginx', 'limits', 'notify_unit'}:
        raise InstallError('invalid config fields')
    try:
        if not isinstance(config['host_address'], str):
            raise ValueError()
        ipaddress.ip_address(config['host_address'])
    except ValueError as exc:
        raise InstallError('host_address must be an IP address') from exc
    firewall = config['firewall']
    if not isinstance(firewall, dict) or set(firewall) != {'backend', 'ports'} or firewall['backend'] not in ('ufw', 'none'):
        raise InstallError('invalid firewall configuration')
    ports = firewall['ports']
    if (not isinstance(ports, list) or not ports or any(type(port) is not int or port < 1 or port > 65535 or port == 22 for port in ports)
            or len(ports) != len(set(ports))):
        raise InstallError('ports must be unique integers, excluding SSH')
    nginx = config['nginx']
    if not isinstance(nginx, dict) or set(nginx) != {'enabled', 'shared_dir', 'bundles'} or type(nginx['enabled']) is not bool:
        raise InstallError('invalid nginx configuration')
    shared = nginx['shared_dir']
    if not isinstance(shared, str) or not re.fullmatch(r'/etc/(?:nginx|common-sv/nginx)/[A-Za-z0-9_./-]+', shared) or '..' in shared.split('/') or '//' in shared or Path(shared) in (Path('/etc/nginx'), Path('/etc/common-sv/nginx')):
        raise InstallError('nginx shared_dir must be a safe directory below /etc/nginx or /etc/common-sv/nginx')
    bundles = nginx['bundles']
    if not isinstance(bundles, list) or (nginx['enabled'] and not bundles):
        raise InstallError('enabled nginx requires bundles')
    seen_bundles = set()
    for bundle in bundles:
        if not isinstance(bundle, dict) or set(bundle) != {'geo_file', 'realip_file'}:
            raise InstallError('invalid nginx bundle')
        pair = (bundle['geo_file'], bundle['realip_file'])
        if not all(isinstance(path, str) for path in pair) or pair in seen_bundles:
            raise InstallError('invalid or duplicate nginx bundle')
        seen_bundles.add(pair)
        for path in bundle.values():
            if not isinstance(path, str) or not re.fullmatch(r'/etc/(?:nginx|common-sv/nginx)/[A-Za-z0-9_./-]+', path) or '..' in path.split('/') or '//' in path:
                raise InstallError('invalid nginx bundle path')
    limits = config['limits']
    if (not isinstance(limits, dict) or set(limits) != {'max_changes', 'min_ratio'}
            or type(limits['max_changes']) is not int or not 1 <= limits['max_changes'] <= 1000
            or type(limits['min_ratio']) not in (int, float) or not 0 < limits['min_ratio'] <= 1):
        raise InstallError('invalid automatic change limits')
    notify = config['notify_unit']
    if not isinstance(notify, str) or (notify and not re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', notify)):
        raise InstallError('notify_unit must be a single service unit name')
    if type(data['timer_enabled']) is not bool:
        raise InstallError('timer_enabled must be boolean')
    if not isinstance(data['approve_token'], str) or not re.fullmatch(r'(?:[A-Za-z0-9_-]{43})?', data['approve_token']):
        raise InstallError('invalid approval token')
    assets = data['assets']
    if not isinstance(assets, dict) or set(assets) != {'engine', 'service', 'timer', 'monitor'}:
        raise InstallError('invalid bundled assets')
    if any(not isinstance(value, str) or not value or len(value) > 2_000_000 for value in assets.values()):
        raise InstallError('invalid bundled asset size')
    try:
        compile(assets['engine'], '<bundled-cloudfront-sync>', 'exec')
        json.loads(assets['monitor'])
    except (SyntaxError, ValueError) as exc:
        raise InstallError('bundled asset validation failed') from exc


class Installer:
    def __init__(self, paths=None, runner=subprocess.run, owner=0):
        self.paths = paths or Paths()
        self.runner = runner
        self.owner = owner
        self.sync_fd = None

    def safe_path(self, path, directory=False):
        path = Path(path)
        for component in (path, *path.parents):
            if component == self.paths.root.parent and self.paths.root != Path('/'):
                break
            if component.exists() or component.is_symlink():
                info = component.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_uid != self.owner:
                    raise InstallError('unsafe installation path ownership or symlink')
                # The host /run/lock can be sticky world writable; only the fixed
                # root-owned lock file is trusted, never a caller-created file.
                if info.st_mode & 0o022:
                    if component == self.paths.at('/run/lock') and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX:
                        pass
                    elif component != self.paths.root:
                        raise InstallError('unsafe writable installation path')
        if path.exists() and directory != path.is_dir():
            raise InstallError('unexpected installation path type')

    def ensure_directory(self, path, mode):
        self.safe_path(path, directory=True)
        existed = path.exists()
        missing = []
        current = path
        while not current.exists():
            missing.append(current)
            current = current.parent
        # Never let an inherited umask=000 create writable intermediate parents.
        for directory in reversed(missing):
            directory.mkdir(mode=0o755)
            os.chmod(directory, mode if directory == path else 0o755)
        if not existed or path in (self.paths.private, self.paths.at('/var/lib/cloudfront-sync')):
            os.chmod(path, mode)
        self.safe_path(path, directory=True)

    def atomic_write(self, path, content, mode):
        self.ensure_directory(path.parent, 0o700 if path.parent == self.paths.private else 0o755)
        self.safe_path(path)
        fd, temporary = tempfile.mkstemp(prefix='.cloudfront-sync-', dir=str(path.parent))
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def command(self, args, *, allow_failure=False, pass_fds=()):
        try:
            result = self.runner(args, check=False, capture_output=True, text=True, timeout=180,
                                 env={**os.environ, 'LC_ALL': 'C'}, pass_fds=pass_fds)
            if result.returncode and not allow_failure:
                raise InstallError('installation command failed: ' + args[0])
            return result
        except (subprocess.SubprocessError, OSError) as exc:
            raise InstallError('installation command failed: ' + args[0]) from exc

    def timer_state(self):
        enabled = self.command(['systemctl', 'is-enabled', 'cloudfront-sync.timer'], allow_failure=True)
        active = self.command(['systemctl', 'is-active', 'cloudfront-sync.timer'], allow_failure=True)
        if enabled.stdout.strip() == 'masked':
            raise InstallError('cloudfront-sync.timer is masked; explicit operator action required')
        return {'enabled': enabled.stdout.strip() == 'enabled', 'active': active.stdout.strip() == 'active'}

    def stop_and_wait(self, prior):
        # Persistently quiesce it: a reboot during deployment must not run a
        # half-installed version before the installation journal is recovered.
        disabled = self.command(['systemctl', 'disable', '--now', 'cloudfront-sync.timer'], allow_failure=True)
        stopped = self.command(['systemctl', 'stop', 'cloudfront-sync.timer'], allow_failure=True)
        observed = self.timer_state()
        if observed['enabled'] or observed['active'] or ((disabled.returncode or stopped.returncode) and self.paths.timer.exists()):
            try:
                self.set_timer(prior, restore=True)
            except InstallError as exc:
                self.mark_recovery_failed()
                raise InstallError('timer quiescence and recovery failed; no assets changed') from exc
            raise InstallError('timer could not be safely disabled; no assets changed')
        deadline = time.monotonic() + 120
        while True:
            result = self.command(['systemctl', 'is-active', 'cloudfront-sync.service'], allow_failure=True)
            if result.stdout.strip() not in ('active', 'activating', 'deactivating', 'reloading'):
                return
            if time.monotonic() >= deadline:
                raise InstallError('running synchronization did not finish; timer left stopped')
            time.sleep(1)

    def lock(self, path):
        self.ensure_directory(path.parent, 0o755)
        self.safe_path(path)
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.owner or info.st_mode & 0o077:
                raise InstallError('unsafe installation lock')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except (OSError, InstallError) as exc:
            if 'fd' in locals():
                os.close(fd)
            raise InstallError('installation or synchronization is already running, or lock is unsafe') from exc

    def snapshot(self):
        snapshot = {}
        for key, (path, _mode) in self.paths.targets().items():
            self.safe_path(path)
            snapshot[key] = ({'content': base64.b64encode(path.read_bytes()).decode('ascii'),
                              'mode': path.stat().st_mode & 0o777} if path.exists() else None)
        return snapshot

    def write_journal(self, snapshot, timer, phase='installing', engine_before_hash=None):
        content = {'version': 1, 'snapshot': snapshot, 'timer': timer, 'phase': phase,
                   'engine_before_hash': engine_before_hash}
        self.atomic_write(self.paths.journal, json.dumps(content).encode(), 0o600)

    def restore(self, snapshot):
        if not isinstance(snapshot, dict) or set(snapshot) != set(self.paths.targets()):
            raise InstallError('invalid installation recovery journal')
        for key, (path, _mode) in self.paths.targets().items():
            item = snapshot[key]
            if item is None:
                self.safe_path(path)
                if path.exists():
                    path.unlink()
            else:
                if (not isinstance(item, dict) or set(item) != {'content', 'mode'} or type(item['mode']) is not int
                        or not 0 <= item['mode'] <= 0o777 or item['mode'] & 0o022):
                    raise InstallError('invalid recovery file record')
                self.atomic_write(path, base64.b64decode(item['content'], validate=True), item['mode'])
        self.command(['systemctl', 'daemon-reload'])
        if self.paths.engine.exists():
            compile(self.paths.engine.read_text(), '<restored-cloudfront-sync>', 'exec')
        if self.paths.config.exists():
            json.loads(self.paths.config.read_text())
        if self.paths.engine.exists() and self.paths.config.exists() and self.sync_fd is not None:
            self.command(['/usr/bin/python3', str(self.paths.engine), '--config', str(self.paths.config),
                          '--lock-fd', str(self.sync_fd), 'preflight'], pass_fds=(self.sync_fd,))

    def set_timer(self, desired, restore=False):
        self.command(['systemctl', 'enable' if desired['enabled'] else 'disable', 'cloudfront-sync.timer'], allow_failure=restore and not self.paths.timer.exists())
        self.command(['systemctl', 'start' if desired['active'] else 'stop', 'cloudfront-sync.timer'], allow_failure=restore and not self.paths.timer.exists())
        if self.paths.timer.exists() and self.timer_state() != desired:
            raise InstallError('timer state verification failed')

    def recover(self):
        if not self.paths.journal.exists():
            return
        self.safe_path(self.paths.journal)
        try:
            journal = json.loads(self.paths.journal.read_text())
            if journal.get('version') != 1 or journal.get('phase') not in ('installing', 'applying', 'applied'):
                raise InstallError('invalid installation journal version or phase')
            timer = journal.get('timer')
            if not isinstance(timer, dict) or set(timer) != {'enabled', 'active'} or any(type(value) is not bool for value in timer.values()):
                raise InstallError('invalid recovery timer state')
            if journal.get('phase') != 'installing' and not self.runtime_unchanged(journal.get('engine_before_hash')):
                raise InstallError('committed installation needs operator recovery; timer remains stopped')
            self.restore(journal['snapshot'])
            self.paths.journal.unlink()
            return journal['timer']
        except Exception as exc:
            self.mark_recovery_failed()
            raise InstallError('installation recovery failed; timer remains stopped') from exc

    def runtime_hash(self):
        self.safe_path(self.paths.state)
        return hashlib.sha256(self.paths.state.read_bytes()).hexdigest() if self.paths.state.exists() else 'absent'

    def runtime_unchanged(self, before):
        return (isinstance(before, str) and self.runtime_hash() == before
                and not (self.paths.private / 'journal.json').exists())

    def mark_recovery_failed(self):
        self.command(['systemctl', 'stop', 'cloudfront-sync.timer'], allow_failure=True)
        self.command(['systemctl', 'disable', 'cloudfront-sync.timer'], allow_failure=True)
        status_path = self.paths.at('/var/lib/cloudfront-sync/status.json')
        self.safe_path(status_path)
        previous = ({'version': 1, 'initialized': False, 'last_success': None, 'approval_required': False}
                    | (json.loads(status_path.read_text()) if status_path.exists() else {}))
        previous.update({'version': 1, 'recovery_failed': True, 'error_code': 'installation_recovery_failed',
                         'updated_at': int(time.time())})
        self.atomic_write(status_path, json.dumps(previous).encode(), 0o644)

    def initialized(self):
        self.safe_path(self.paths.state)
        if not self.paths.state.exists():
            return False
        state = json.loads(self.paths.state.read_text())
        return (state.get('version') == 1 and state.get('initialized') is True
                and isinstance(state.get('ranges'), list) and bool(state['ranges'])
                and type(state.get('last_success')) is int)

    def install(self, data):
        if self.runner is subprocess.run or self.paths.root == Path('/'):
            raise InstallError('cohort_installer_unavailable')
        validate(data)
        # Fail before stopping a timer or laying down files on a fresh host.
        if data['timer_enabled'] and not self.initialized() and not data['approve_token']:
            raise InstallError('timer requires initialized state or explicit initial approval')
        if data['config']['notify_unit']:
            notification = self.command(['systemctl', 'show', '--property=LoadState', '--value', data['config']['notify_unit']], allow_failure=True)
            if notification.returncode or notification.stdout.strip() != 'loaded':
                raise InstallError('notify_unit must identify an existing loadable service')
        install_fd = self.lock(self.paths.install_lock)
        sync_fd = None
        snapshot = None
        prior = None
        committed = False
        engine_before_hash = None
        try:
            prior = self.timer_state()
            self.stop_and_wait(prior)
            try:
                sync_fd = self.lock(self.paths.sync_lock)
            except InstallError:
                # No assets or runtime policy were touched. Do not silently
                # leave a previously healthy timer disabled on lock contention.
                try:
                    self.set_timer(prior, restore=True)
                except InstallError as exc:
                    self.mark_recovery_failed()
                    raise InstallError('lock acquisition and timer recovery failed') from exc
                raise
            self.sync_fd = sync_fd
            self.ensure_directory(self.paths.at('/var/lib/cloudfront-sync'), 0o755)
            self.ensure_directory(self.paths.private, 0o700)
            recovered_timer = self.recover()
            if recovered_timer is not None:
                prior = recovered_timer
            # Recover a runtime transaction using its original code/config before
            # deploying a new version. A changed config cannot safely recover it.
            if (self.paths.private / 'journal.json').exists():
                if not self.paths.engine.exists() or not self.paths.config.exists():
                    self.mark_recovery_failed()
                    raise InstallError('runtime recovery needs the previous installation')
                try:
                    self.command(['/usr/bin/python3', str(self.paths.engine), '--config', str(self.paths.config),
                                  '--lock-fd', str(sync_fd), 'preflight'], pass_fds=(sync_fd,))
                except InstallError:
                    self.mark_recovery_failed()
                    raise
            snapshot = self.snapshot()
            self.write_journal(snapshot, prior)
            changed = False
            assets = {**data['assets'], 'config': json.dumps(data['config'], sort_keys=True, indent=2) + '\n'}
            for key, (path, mode) in self.paths.targets().items():
                content = assets[key].encode()
                if not path.exists() or path.read_bytes() != content or path.stat().st_mode & 0o777 != mode:
                    self.atomic_write(path, content, mode)
                    changed = True
            self.command(['systemctl', 'daemon-reload'])
            engine = ['/usr/bin/python3', str(self.paths.engine), '--config', str(self.paths.config), '--lock-fd', str(sync_fd)]
            self.command(engine + ['preflight'], pass_fds=(sync_fd,))
            if data['approve_token']:
                # Persist the uncertain apply boundary BEFORE launching the child.
                # A parent crash after child commit must not restore old assets.
                engine_before_hash = self.runtime_hash()
                self.write_journal(snapshot, prior, 'applying', engine_before_hash)
                committed = True
                result = self.command(engine + ['apply', '--approve=' + data['approve_token']], pass_fds=(sync_fd,))
                self.write_journal(snapshot, prior, 'applied', engine_before_hash)
                changed = True
            else:
                result = self.command(engine + ['plan'], pass_fds=(sync_fd,))
            if data['timer_enabled'] and not self.initialized():
                raise InstallError('timer requires initialized state after approval')
            desired = {'enabled': data['timer_enabled'], 'active': data['timer_enabled']}
            self.set_timer(desired)
            changed = changed or prior != desired
            self.paths.journal.unlink()
            return {'changed': changed, 'plan': json.loads(result.stdout), 'timer_enabled': data['timer_enabled']}
        except Exception as exc:
            if snapshot is not None:
                try:
                    if committed and not self.runtime_unchanged(engine_before_hash):
                        raise InstallError('engine apply committed; preserve coherent installation for recovery')
                    self.restore(snapshot)
                    self.set_timer(prior, restore=True)
                    self.paths.journal.unlink(missing_ok=True)
                except Exception as recovery_exc:
                    self.mark_recovery_failed()
                    raise InstallError('installation recovery failed; timer stopped and journal retained') from recovery_exc
            if isinstance(exc, InstallError):
                raise
            raise InstallError('installation failed') from exc
        finally:
            self.sync_fd = None
            if sync_fd is not None:
                os.close(sync_fd)
            os.close(install_fd)


def validate_candidate(raw):
    """C3 authenticates exact candidate bytes; no locks, staging or actors."""
    data = _bg_json_bytes(raw,16*1024*1024,integers_only=False)
    keys = {'version','bundle_manifest','bundle_assets','config','timer_enabled','approve_token','rendered_assets'}
    if type(data) is not dict or set(data) != keys or type(data['version']) is not int or data['version'] != 2:
        raise InstallError('invalid_candidate_schema')
    def decode(text,limit):
        if type(text) is not str or len(text)>4*((limit+2)//3):
            raise InstallError('candidate_byte_budget')
        try:
            value=base64.b64decode(text,validate=True)
            if base64.b64encode(value).decode('ascii')!=text or not 0<len(value)<=limit:
                raise ValueError()
            return value
        except Exception:raise InstallError('invalid_candidate_bytes') from None
    manifest=decode(data['bundle_manifest'],64*1024)
    encoded=data['bundle_assets']
    if type(encoded) is not dict or set(encoded)!=set(_BG_NAMES):
        raise InstallError('invalid_candidate_asset_set')
    assets={name:decode(encoded[name],2*1024*1024) for name in _BG_NAMES}
    assets=_bg_snapshot(assets)
    rendered=data['rendered_assets']
    unit_names=('sync_service','sync_timer','guard_service','guard_timer')
    if type(rendered) is not dict or set(rendered)!={*unit_names,'monitor'}:
        raise InstallError('invalid_rendered_asset_set')
    rendered_bytes={}
    for name in (*unit_names,'monitor'):
        text=rendered[name]
        limit=2*1024*1024 if name=='monitor' else 64*1024
        if type(text) is not str or not 0<len(text)<=limit:
            raise InstallError('invalid_rendered_asset_bytes')
        value=text.encode('utf-8')
        if len(value)>limit:raise InstallError('rendered_asset_byte_budget')
        rendered_bytes[name]=value
    config_bytes=_bg_canonical(data['config'])
    if len(config_bytes)>64*1024:
        raise InstallError('candidate_config_budget')
    if len(manifest)+sum(map(len,assets.values()))+len(config_bytes)+sum(map(len,rendered_bytes.values()))>12*1024*1024:
        raise InstallError('candidate_aggregate_budget')
    if type(_bg_json_bytes(rendered_bytes['monitor'],2*1024*1024)) is not dict:
        raise InstallError('invalid_rendered_monitor')
    # Reuse only the old pure config/token validator, never its installer actor.
    validate({'config':data['config'],'timer_enabled':data['timer_enabled'],'approve_token':data['approve_token'],
              'assets':{'engine':'pass\n','service':rendered['sync_service'],'timer':rendered['sync_timer'],'monitor':rendered['monitor']}})
    _,_,checked=_bundle_verified(manifest,assets,BUNDLE_GENERATION_ID)
    return checked


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--validate-only',action='store_true')
    args=parser.parse_args()
    try:
        raw=sys.stdin.buffer.read(16*1024*1024+1)
        validate_candidate(raw)
        if args.validate_only:
            print(json.dumps({'valid':True,'generation_id':BUNDLE_GENERATION_ID,'installation_ready':False}))
            return 0
        # C4 full-cohort journaling, both timers and recovery are not connected.
        # Never authenticate a new bundle and then invoke the legacy 4-asset actor.
        print(json.dumps({'error':'cohort_installer_unavailable'}),file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({'error':'candidate_validation_or_installation_unavailable'}),file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
