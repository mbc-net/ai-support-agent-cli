#!/usr/bin/python3
"""Install trusted bundled assets while the sync timer is quiesced.

The helper is run from bundled source with a JSON payload on stdin. Paths and
commands are fixed here; recipe variables cannot select executable locations.
"""
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    try:
        raw = sys.stdin.read(8_000_001)
        if len(raw) > 8_000_000:
            raise InstallError('installer payload too large')
        data = json.loads(raw)
        validate(data)
        if args.validate_only:
            print(json.dumps({'valid': True}))
            return 0
        if os.geteuid() != 0:
            raise InstallError('installer requires root')
        print(json.dumps(Installer().install(data)))
        return 0
    except (InstallError, ValueError, OSError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
