"""Root-only HAProxy setup transaction. JSON parameters arrive on stdin.

The role executes this bundled source with python3 -c: no helper is installed on
hosts. Persistent records and a mkdir lock allow manual recovery after SSH loss.
Only configuration and service state are rolled back, never package dependencies.
"""
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def validate(params):
    if not isinstance(params, dict) or set(params) != {'mode', 'bind_address', 'bind_port', 'backends'}:
        raise ValueError('Expected mode, bind_address, bind_port and backends')
    if params['mode'] not in ('http', 'tcp'):
        raise ValueError('mode must be http or tcp')
    try:
        ipaddress.IPv4Address(params['bind_address'])
    except (ValueError, TypeError):
        raise ValueError('bind_address must be an IPv4 string')
    if not isinstance(params['bind_address'], str):
        raise ValueError('bind_address must be a string')
    def port(value):
        if type(value) is not int or not 1 <= value <= 65535:
            raise ValueError('port must be an integer from 1 to 65535')
    port(params['bind_port'])
    backends = params['backends']
    if not isinstance(backends, list) or not 1 <= len(backends) <= 256:
        raise ValueError('backends must contain 1 to 256 entries')
    names = set()
    for backend in backends:
        if not isinstance(backend, dict) or set(backend) != {'name', 'address', 'port'}:
            raise ValueError('Each backend requires only name, address and port')
        name, address = backend['name'], backend['address']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,62}', name):
            raise ValueError('Invalid backend name')
        if name in names:
            raise ValueError('Duplicate backend name')
        names.add(name)
        port(backend['port'])
        if not isinstance(address, str) or not 1 <= len(address) <= 253:
            raise ValueError('Invalid backend address')
        try:
            ipaddress.IPv4Address(address)
        except ValueError:
            if re.fullmatch(r'[0-9.]+', address):
                raise ValueError('Invalid IPv4 backend address')
            if not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                       for label in (address[:-1] if address.endswith('.') else address).split('.')):
                raise ValueError('Invalid DNS backend address')


def render(params):
    validate(params)
    # Explicit ipv4@ forces libc DNS resolution to AF_INET, unlike resolve-prefer
    # (which only expresses a preference and can fall back to IPv6).
    text = ('# Managed by ai-support-agent haproxy role\n'
            'global\n    log /dev/log local0\n    user haproxy\n    group haproxy\n'
            '    maxconn 2048\n\ndefaults\n    log global\n'
            f"    mode {params['mode']}\n"
            '    timeout connect 5s\n    timeout client 50s\n    timeout server 50s\n'
            '\nfrontend frontend_main\n'
            f"    bind {params['bind_address']}:{params['bind_port']}\n"
            '    default_backend backend_main\n\nbackend backend_main\n    balance roundrobin\n')
    for backend in params['backends']:
        text += f"    server {backend['name']} ipv4@{backend['address']}:{backend['port']} check inter 2s fall 3 rise 2\n"
    return text


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.haproxy-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Host:
    def __init__(self, root=Path('/')):
        self.config = root / 'etc/haproxy/haproxy.cfg'
        self.backups = root / 'var/backups/ai-support-agent/haproxy'
        self.lock = root / 'var/lib/ai-support-agent/haproxy.lock'
        self.policy = root / 'usr/sbin/policy-rc.d'
        self.process_uncertain = False
    def run(self, args, allowed=(0,), timeout=600):
        process = subprocess.Popen(args, text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True,
                                   env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'))
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # systemctl jobs may outlive the CLI even after its group is killed.
            # Do not recover or unlock until an operator confirms all work stopped.
            self.process_uncertain = True
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    # Retain the lock when the group cannot be stopped.
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                if sig == signal.SIGTERM:
                    time.sleep(0.2)
            try:
                process.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                # A descendant escaped the group or still owns a pipe. Keep
                # persistent recovery state rather than waiting without a bound.
                for stream in (process.stdout, process.stderr):
                    if stream:
                        stream.close()
            raise
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        if result.returncode not in allowed:
            raise RuntimeError(f"{args[0]} {' '.join(args[1:])}: {result.stderr.strip() or result.stdout.strip()}")
        return result
    def package_present(self):
        result = self.run(['dpkg-query', '-W', '-f=${Status}', 'haproxy'], allowed=(0, 1))
        return result.returncode == 0 and result.stdout.strip() == 'install ok installed'
    def service_exists(self):
        result = self.run(['systemctl', 'show', '--property=LoadState', '--value', 'haproxy'])
        return result.stdout.strip() != 'not-found'
    def service_state(self):
        active = self.run(['systemctl', 'is-active', 'haproxy'], allowed=(0, 3, 4)).stdout.strip()
        enabled = self.run(['systemctl', 'is-enabled', 'haproxy'], allowed=(0, 1, 3, 4)).stdout.strip()
        if active not in ('active', 'inactive', 'failed', 'unknown', ''):
            raise RuntimeError('HAProxy is transitioning; retry when stable')
        if enabled not in ('enabled', 'disabled', 'not-found', ''):
            raise RuntimeError(f'Unsupported HAProxy enable state: {enabled}; unmask/normalize before setup')
        return {'active': active == 'active', 'enabled': enabled == 'enabled'}
    def install(self):
        # Always restore the distribution/operator policy, including symlinks.
        saved = self.lock / 'policy-rc.d.original'
        present = self.policy.exists() or self.policy.is_symlink()
        if present:
            shutil.copy2(self.policy, saved, follow_symlinks=False)
        original = self.policy.lstat() if present else None
        atomic_write(self.lock / 'policy-state.json', json.dumps({
            'present': present, 'uid': original.st_uid if original else None,
            'gid': original.st_gid if original else None}))
        if self.policy.is_symlink():
            self.policy.unlink()
        atomic_write(self.policy, '#!/bin/sh\nexit 101\n', 0o755)
        try:
            self.run(['apt-get', 'update'])
            self.run(['apt-get', 'install', '-y', '--no-install-recommends', 'haproxy'])
        finally:
            if self.process_uncertain:
                raise RuntimeError('Package command timed out; manual recovery required; policy and lock retained')
            self.policy.unlink(missing_ok=True)
            if present:
                shutil.copy2(saved, self.policy, follow_symlinks=False)
                os.lchown(self.policy, original.st_uid, original.st_gid)
            (self.lock / 'policy-state.json').unlink()
            saved.unlink(missing_ok=True)
    def validate_config(self, path):
        self.run(['/usr/sbin/haproxy', '-c', '-f', str(path)])
    def service(self, action):
        self.run(['systemctl', action, 'haproxy'])
    def worker_pids(self):
        master = int(self.run(['systemctl', 'show', '--property=MainPID', '--value', 'haproxy']).stdout.strip())
        if master <= 0:
            return set()
        pending, seen = [master], set()
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            try:
                for task in (Path('/proc') / str(current) / 'task').iterdir():
                    pending.extend(int(child) for child in (task / 'children').read_text().split())
            except (FileNotFoundError, ProcessLookupError):
                pass
        return seen - {master}
    def owns_listener(self, params, allowed_pids=None):
        # A successful reload exit code can leave the previous worker serving.
        # Attribute the exact IPv4 LISTEN socket to the unit's master/children.
        pid = int(self.run(['systemctl', 'show', '--property=MainPID', '--value', 'haproxy']).stdout.strip())
        if pid <= 0:
            return False
        address = socket.inet_aton(params['bind_address'])[::-1].hex().upper()
        endpoint = f"{address}:{params['bind_port']:04X}"
        inodes = set()
        for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
            columns = line.split()
            if columns[1] == endpoint and columns[3] == '0A':
                inodes.add(columns[9])
        if not inodes:
            return False
        pending, seen = [pid], set()
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            process = Path('/proc') / str(current)
            try:
                for fd in (process / 'fd').iterdir():
                    try:
                        if (allowed_pids is None or current in allowed_pids) and os.readlink(fd) in {f'socket:[{inode}]' for inode in inodes}:
                            return True
                    except FileNotFoundError:
                        pass
                for task in (process / 'task').iterdir():
                    pending.extend(int(child) for child in (task / 'children').read_text().split())
            except (FileNotFoundError, ProcessLookupError):
                continue
        return False
    def verify(self, params, previous_workers=None):
        # Operational checks do not prove backend HTTP application correctness.
        for _ in range(20):
            new_workers = None if previous_workers is None else self.worker_pids() - previous_workers
            if (previous_workers is None or new_workers) and self.service_state()['active'] and self.owns_listener(params, new_workers):
                try:
                    address = params['bind_address']
                    with socket.create_connection(('127.0.0.1' if address == '0.0.0.0' else address,
                                                   params['bind_port']), timeout=1):
                        return
                except OSError:
                    pass
            time.sleep(0.25)
        raise RuntimeError('HAProxy did not become active and listen on the requested address/port')


def save_state(directory, state):
    atomic_write(directory / 'state.json', json.dumps(state, indent=2))


def apply(params, host):
    validate(params)
    content = render(params)
    host.lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        host.lock.mkdir(mode=0o700)
    except FileExistsError:
        raise RuntimeError(f'HAProxy setup locked: {host.lock}; check the owner before manual recovery/unlock')
    transaction = None
    old = None
    state = None
    mutated = False
    retain_lock = False
    try:
        atomic_write(host.lock / 'owner.json', json.dumps({'id': uuid.uuid4().hex, 'pid': os.getpid(), 'time': time.time()}))
        if host.config.is_symlink():
            raise RuntimeError('Symlink HAProxy configuration is unsupported; use a regular file')
        installed = host.package_present()
        service = host.service_state()
        old = host.config.read_bytes() if host.config.exists() else None
        config_changed = old != content.encode()
        changed = not installed or config_changed or not service['active'] or not service['enabled']
        # Validate before any transaction or package mutation on an existing host.
        with tempfile.TemporaryDirectory(prefix='haproxy-') as temporary:
            candidate = Path(temporary) / 'haproxy.cfg'
            candidate.write_text(content)
            candidate.chmod(0o600)
            if installed:
                host.validate_config(candidate)
            if not changed:
                host.verify(params)
                return {'changed': False}
            host.backups.mkdir(parents=True, exist_ok=True, mode=0o700)
            host.backups.chmod(0o700)
            transaction = host.backups / f'{time.time_ns()}-{uuid.uuid4().hex}'
            transaction.mkdir(mode=0o700)
            metadata = host.config.stat() if old is not None else None
            state = dict(service, installed=installed, config_exists=old is not None,
                         mode=metadata.st_mode & 0o7777 if metadata else None,
                         uid=metadata.st_uid if metadata else None,
                         gid=metadata.st_gid if metadata else None,
                         status='pending', created=time.time())
            if old is not None:
                atomic_write(transaction / 'haproxy.cfg', old)
            atomic_write(transaction / 'candidate.cfg', content)
            save_state(transaction, state)
            atomic_write(host.lock / 'transaction', str(transaction))
            mutated = True
            if not installed:
                host.install()
                host.validate_config(candidate)
            if config_changed:
                atomic_write(host.config, content, 0o600)
            if not service['active']:
                host.service('start')
            elif config_changed:
                previous_workers = host.worker_pids()
                host.service('reload')
                host.verify(params, previous_workers)
            host.verify(params)
            if not service['enabled']:
                host.service('enable')
            state['status'] = 'complete'
            save_state(transaction, state)
        # Retain five successful generations. Never prune unresolved/failed ones.
        complete = []
        warnings = []
        for directory in sorted(host.backups.iterdir(), reverse=True):
            record = directory / 'state.json'
            try:
                if record.is_file() and json.loads(record.read_text()).get('status') == 'complete':
                    complete.append(directory)
            except (OSError, ValueError):
                warnings.append(f'Could not read backup record: {record}')
        for directory in complete[5:]:
            try:
                shutil.rmtree(directory)
            except OSError:
                warnings.append(f'Could not prune backup: {directory}')
        return {'changed': True, 'backup': str(transaction), 'warnings': warnings}
    except Exception as failure:
        if not mutated:
            raise
        if host.process_uncertain:
            state['status'] = 'interrupted'
            state['error'] = str(failure)
            save_state(transaction, state)
            raise RuntimeError(f'Command timeout; manual recovery required; lock retained; backup={transaction}') from failure
        recovery_errors = []
        def recover(operation):
            if host.process_uncertain:
                return False
            try:
                operation()
                return True
            except Exception as error:
                recovery_errors.append(str(error))
                return False
        if state['installed']:
            def restore_config():
                if old is None:
                    host.config.unlink(missing_ok=True)
                else:
                    atomic_write(host.config, old, state['mode'])
                    os.chown(host.config, state['uid'], state['gid'])
                if state['active']:
                    host.validate_config(host.config)
            # Do not stop a surviving worker until its configuration is restored.
            if recover(restore_config):
                if state['active']:
                    recover(lambda: host.service('restart'))
                else:
                    recover(lambda: host.service('stop'))
                recover(lambda: host.service('enable' if state['enabled'] else 'disable'))
        else:
            # Even failed package installs can leave a unit. Attempt both actions.
            present = []
            recover(lambda: present.append(host.service_exists()))
            if present and present[0]:
                recover(lambda: host.service('stop'))
                recover(lambda: host.service('disable'))
        def verify_recovery():
            if state['installed']:
                expected = {'active': state['active'], 'enabled': state['enabled']}
            elif host.service_exists():
                expected = {'active': False, 'enabled': False}
            else:
                return
            if host.service_state() != expected:
                raise RuntimeError('Recovered service state does not match the pre-install state')
        recover(verify_recovery)
        state['status'] = 'interrupted' if host.process_uncertain else ('recovery_failed' if recovery_errors else 'rolled_back')
        state['error'] = str(failure)
        state['recovery_errors'] = recovery_errors
        retain_lock = bool(recovery_errors)
        try:
            save_state(transaction, state)
        except Exception as record_error:
            recovery_errors.append(str(record_error))
            retain_lock = True
        if host.process_uncertain:
            raise RuntimeError(f'Recovery timeout; manual recovery required; lock retained; backup={transaction}') from failure
        raise RuntimeError(f'HAProxy setup failed: {failure}; backup={transaction}; '
                           f"recovery={'FAILED: ' + '; '.join(recovery_errors) if recovery_errors else 'completed'}"
                           + ('; manual recovery required; lock retained' if retain_lock else '')) from failure
    finally:
        # Unresolved recovery must be inspected before another setup can mutate it.
        if not retain_lock and not host.process_uncertain and not (host.lock / 'policy-state.json').exists():
            shutil.rmtree(host.lock)


def main():
    os.umask(0o077)
    params = json.load(sys.stdin)
    if '--validate-only' in sys.argv:
        validate(params)
        print(json.dumps({'valid': True}))
    else:
        print(json.dumps(apply(params, Host())))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
