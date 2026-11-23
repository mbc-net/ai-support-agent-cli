"""Unit tests and S0 runtime-actor refusal characterization; no host firewall access."""
import ast
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import contextlib
import functools
import io
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import types
import urllib.request

MODULE_PATH = Path(__file__).parents[1] / 'cloudfront-sync.py'
spec = importlib.util.spec_from_file_location('cloudfront_sync', MODULE_PATH)
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)

def config():
    return {'host_address': '192.0.2.10', 'firewall': {'backend': 'ufw', 'ports': [443]},
            'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
            'limits': {'max_changes': 10, 'min_ratio': .8}, 'notify_unit': ''}



class ConfigTests(unittest.TestCase):
    """validate_config is on the read path (main validates the config for every read command)."""
    def test_config_types_and_path_injection(self):
        for mutate in [lambda c: c['firewall'].update(ports=[True]), lambda c: c['firewall'].update(ports=[22]),
                       lambda c: c['limits'].update(max_changes=True), lambda c: c['nginx'].update(enabled='false'),
                       lambda c: c['nginx'].update(shared_dir='/etc/nginx/a;evil'), lambda c: c.update(notify_unit='a\nb.service')]:
            c = config(); mutate(c)
            with self.subTest(c=c), self.assertRaises(cf.SyncError):
                cf.validate_config(c)

    def test_extra_config_keys_and_invalid_values(self):
        for modify in [lambda c: c.update(extra='value'), lambda c: c.update(host_address=1),
                       lambda c: c['nginx'].update(enabled=True), lambda c: c['limits'].update(min_ratio=float('nan')),
                       lambda c: c['firewall'].update(backend='iptables'), lambda c: c['firewall'].update(ports=[443, 443])]:
            c = config(); modify(c)
            self.assertRaises(cf.SyncError, cf.validate_config, c)

    def test_host_address_scope_id_and_non_ascii_strings_rejected(self):
        # A scoped IPv6 address is never a public host address, and every
        # string must be ASCII: config_hash (canonical JSON, ensure_ascii=False)
        # then equals the ASCII-escaped form already persisted on hosts.
        surrogate = json.loads('"fe80::1%\\ud800"')
        self.assertEqual(surrogate, 'fe80::1%\ud800')
        cases = [(lambda c: c.update(host_address='fe80::1%\u00e9th0'), 'config strings must be ASCII'),
                 (lambda c: c.update(host_address=surrogate), 'config strings must be ASCII'),
                 (lambda c: c.update(host_address=json.loads('"\\ud800"')), 'config strings must be ASCII'),
                 (lambda c: c.update(notify_unit=json.loads('"a\\ud800.service"')), 'config strings must be ASCII'),
                 (lambda c: c['nginx'].update(shared_dir='/etc/nginx/\u00e9'), 'config strings must be ASCII'),
                 (lambda c: c['limits'].update({'\u00e9': 1}), 'config strings must be ASCII'),
                 (lambda c: c.update(host_address='fe80::1%eth0'), 'host_address must not carry an IPv6 scope id'),
                 (lambda c: c.update(host_address='fe80::1%1'), 'host_address must not carry an IPv6 scope id')]
        for mutate, message in cases:
            c = config(); mutate(c)
            with self.subTest(c=repr(c)), self.assertRaisesRegex(cf.SyncError, '^' + re.escape(message) + '$'):
                cf.validate_config(c)
        for host in ('192.0.2.10', '2001:db8::10', 'fe80::1'):
            c = config(); c['host_address'] = host
            self.assertIs(cf.validate_config(c), c)

    def test_accepted_config_is_ascii_so_both_json_forms_agree(self):
        c = config()
        c['nginx'].update(enabled=True, bundles=[{'geo_file': '/etc/nginx/g.conf', 'realip_file': '/etc/nginx/r.conf'}])
        c['notify_unit'] = 'cloudfront-reload@web-01.service'
        cf.validate_config(c)
        wide = json.dumps(c, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        self.assertTrue(wide.isascii())
        self.assertEqual(wide, json.dumps(c, sort_keys=True, separators=(',', ':')))

    def test_duplicate_or_malformed_nginx_bundles_rejected(self):
        cfg = config()
        bundle = {'geo_file': '/etc/nginx/geo.conf', 'realip_file': '/etc/nginx/server.conf'}
        cfg['nginx'].update(enabled=True, bundles=[bundle, bundle])
        self.assertRaises(cf.SyncError, cf.validate_config, cfg)
        cfg['nginx']['bundles'] = [{'geo_file': '/etc/nginx/geo.conf'}]
        self.assertRaises(cf.SyncError, cf.validate_config, cfg)


class FilesystemTests(unittest.TestCase):
    def test_lock_exclusion_and_inherited_descriptor(self):
        # Exercise the real flock behavior without relying on production paths.
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'lock'
            with mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf, 'check_path'), mock.patch.object(cf.os, 'geteuid', return_value=0):
                # On macOS tests run as a non-root user; mock only fstat/lstat uid.
                real_fstat, real_lstat = cf.os.fstat, cf.Path.lstat
                def fstat(fd):
                    st = real_fstat(fd)
                    return mock.Mock(st_mode=st.st_mode, st_uid=0, st_dev=st.st_dev, st_ino=st.st_ino, st_nlink=st.st_nlink)
                def lstat(p):
                    st = real_lstat(p)
                    return mock.Mock(st_mode=st.st_mode, st_uid=0, st_dev=st.st_dev, st_ino=st.st_ino, st_nlink=st.st_nlink)
                with mock.patch.object(cf.os, 'fstat', side_effect=fstat), mock.patch.object(cf.Path, 'lstat', lstat):
                    with cf.exclusive_lock():
                        self.assertRaises(cf.SyncError, cf.exclusive_lock().__enter__)
                    fd = os.open(lock, os.O_RDWR)
                    try:
                        with cf.exclusive_lock(fd):
                            os.fstat(fd)
                    finally:
                        os.close(fd)

    @contextlib.contextmanager
    def root_owned_lock(self, lock, flock=None, owner=None):
        """LOCK -> a temporary path, owner faked as root (tests run as non-root).

        Only the lock is faked: Path.lstat of the lock path, and os.fstat of a
        descriptor whose (st_dev, st_ino) is an inode that has been at the lock
        path while patched. Every other call returns the real result. ``owner``
        ({'uid': n}) lets a test change the faked owner while the lock is taken.
        """
        real_fstat, real_lstat = cf.os.fstat, cf.Path.lstat
        owner = {'uid': 0} if owner is None else owner
        lock_inodes = set()
        def fake(st):
            return mock.Mock(st_mode=st.st_mode, st_uid=owner['uid'], st_dev=st.st_dev, st_ino=st.st_ino, st_nlink=st.st_nlink)
        def note_lock_inode():
            try:
                st = real_lstat(lock)
            except FileNotFoundError:
                return
            lock_inodes.add((st.st_dev, st.st_ino))
        def lstat(path):
            st = real_lstat(path)
            if path != lock:
                return st
            lock_inodes.add((st.st_dev, st.st_ino))
            return fake(st)
        def fstat(fd):
            st = real_fstat(fd)
            note_lock_inode()
            return fake(st) if (st.st_dev, st.st_ino) in lock_inodes else st
        with (mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf, 'check_path'),
              mock.patch.object(cf.os, 'fstat', side_effect=fstat),
              mock.patch.object(cf.Path, 'lstat', lstat),
              mock.patch.object(cf.fcntl, 'flock', side_effect=flock) if flock else contextlib.nullcontext()):
            yield

    def test_root_owned_lock_fakes_only_the_lock(self):
        """The owner fake is narrow: other paths and descriptors keep their real stat."""
        with tempfile.TemporaryDirectory() as tmp:
            lock, other = Path(tmp) / 'lock', Path(tmp) / 'other'
            lock.write_bytes(b''); other.write_bytes(b'')
            real_uid = os.lstat(other).st_uid
            self.assertNotEqual(real_uid, 0)  # tests run as non-root
            with self.root_owned_lock(lock):
                self.assertEqual(lock.lstat().st_uid, 0)
                self.assertEqual(other.lstat().st_uid, real_uid)
                self.assertEqual(Path(tmp).lstat().st_uid, real_uid)
                fds = os.open(lock, os.O_RDONLY), os.open(other, os.O_RDONLY)
                try:
                    self.assertEqual(cf.os.fstat(fds[0]).st_uid, 0)
                    self.assertEqual(cf.os.fstat(fds[1]).st_uid, real_uid)
                finally:
                    os.close(fds[0]); os.close(fds[1])

    def test_self_opened_lock_replaced_before_flock_is_refused_and_released(self):
        """The path is checked again after flock: a lock unlinked (and recreated) meanwhile is refused."""
        real = cf.fcntl.flock
        for create, shared in ((False, True), (True, False)):
            for recreate in (True, False):
                with self.subTest(create=create, shared=shared, recreate=recreate), tempfile.TemporaryDirectory() as tmp:
                    lock = Path(tmp) / 'lock'
                    lock.write_bytes(b''); lock.chmod(0o600)
                    original = os.open(lock, os.O_RDONLY)  # keeps the replaced inode reachable
                    calls = []
                    def flock(fd, operation):
                        calls.append((fd, operation))
                        if len(calls) == 1:
                            lock.unlink()
                            if recreate:
                                lock.write_bytes(b''); lock.chmod(0o600)
                        return real(fd, operation)
                    entered = []
                    try:
                        with self.root_owned_lock(lock, flock):
                            with self.assertRaises(cf.SyncError):
                                with cf.exclusive_lock(create=create, shared=shared):
                                    entered.append(True)
                        self.assertEqual(entered, [])
                        self.assertEqual(len(calls), 1)
                        # The command's descriptor was closed: the replaced inode is unlocked.
                        real(original, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB)
                        real(original, cf.fcntl.LOCK_UN)
                    finally:
                        os.close(original)

    def test_self_opened_lock_changed_owner_after_flock_is_refused(self):
        """The post-flock check is the full lock-file check, not only an inode comparison."""
        real = cf.fcntl.flock
        for create, shared in ((False, True), (True, False)):
            with self.subTest(create=create, shared=shared), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / 'lock'
                lock.write_bytes(b''); lock.chmod(0o600)
                owner = {'uid': 0}
                def flock(fd, operation):
                    owner['uid'] = 1000
                    return real(fd, operation)
                with self.root_owned_lock(lock, flock, owner):
                    with self.assertRaises(cf.SyncError):
                        with cf.exclusive_lock(create=create, shared=shared):
                            self.fail('entered with a lock no longer owned by root')

    def test_main_lock_replaced_before_flock_is_sync_failed(self):
        """Through main(): a replaced lock is the fixed sync_failed, before the bundle is touched."""
        real = cf.fcntl.flock
        for command in ('inspect-state', 'inspect-runtime', 'verify-cohort'):
            with self.subTest(command=command), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / 'lock'
                lock.write_bytes(b''); lock.chmod(0o600)
                def flock(fd, operation):
                    lock.unlink(); lock.write_bytes(b''); lock.chmod(0o600)
                    return real(fd, operation)
                output, error = io.StringIO(), io.StringIO()
                with (self.root_owned_lock(lock, flock), mock.patch.object(cf.os, 'geteuid', return_value=0),
                      mock.patch.object(cf, '_bundle_runtime') as runtime, mock.patch.object(cf, '_bundle_config') as read,
                      contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                    self.assertEqual(cf.main([command]), 1)
                runtime.assert_not_called(); read.assert_not_called()
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(error.getvalue(), cf.canonical({'error': 'sync_failed'}) + '\n')

    def flock_recorder(self):
        """A pass-through fcntl.flock that records each (fd, operation)."""
        real, calls = cf.fcntl.flock, []
        def flock(fd, operation):
            calls.append((fd, operation))
            return real(fd, operation)
        return calls, flock

    def test_self_opened_shared_lock_is_lock_sh_nonblocking_and_never_created(self):
        """U5 B3: an inspection's own lock fd is LOCK_SH|LOCK_NB, opened read-only, never created."""
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'lock'
            lock.write_bytes(b''); lock.chmod(0o600)
            calls, flock = self.flock_recorder()
            with self.root_owned_lock(lock, flock):
                with cf.exclusive_lock(create=False, shared=True):
                    pass
            self.assertEqual([op for _fd, op in calls], [cf.fcntl.LOCK_SH | cf.fcntl.LOCK_NB])
            missing = Path(tmp) / 'missing'
            with self.root_owned_lock(missing):
                with self.assertRaises(FileNotFoundError):
                    with cf.exclusive_lock(create=False, shared=True):
                        pass
            self.assertFalse(missing.exists())

    def test_inherited_descriptor_is_never_downgraded_to_shared(self):
        """flock is per open file description: LOCK_SH on the deployer's fd would downgrade its EX."""
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'lock'
            lock.write_bytes(b''); lock.chmod(0o600)
            calls, flock = self.flock_recorder()
            deployer = os.open(lock, os.O_RDWR)
            try:
                cf.fcntl.flock(deployer, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB)
                with self.root_owned_lock(lock, flock):
                    with cf.exclusive_lock(deployer, create=False, shared=True):
                        pass
                self.assertEqual(calls, [(deployer, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB)])
                # The deployer still holds EX afterwards: a shared reader is refused.
                reader = os.open(lock, os.O_RDONLY)
                try:
                    self.assertRaises(BlockingIOError, cf.fcntl.flock, reader, cf.fcntl.LOCK_SH | cf.fcntl.LOCK_NB)
                finally:
                    os.close(reader)
            finally:
                os.close(deployer)

    def test_guardian_and_inspection_share_while_deployment_and_verify_cohort_exclude(self):
        """Real flock: guardian SH + inspection SH coexist; deployment EX / verify-cohort EX are exclusive."""
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'lock'
            lock.write_bytes(b''); lock.chmod(0o600)
            with self.root_owned_lock(lock):
                guardian = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                deployer = os.open(lock, os.O_RDWR)
                try:
                    # Guardian (cloudfront-integrity-guard.py) holds LOCK_SH|LOCK_NB.
                    cf.fcntl.flock(guardian, cf.fcntl.LOCK_SH | cf.fcntl.LOCK_NB)
                    with cf.exclusive_lock(create=False, shared=True):
                        with cf.exclusive_lock(create=False, shared=True):
                            pass  # a second inspection shares too
                        self.assertRaises(BlockingIOError, cf.fcntl.flock, deployer, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB)
                        self.assertRaises(cf.SyncError, cf.exclusive_lock().__enter__)
                    cf.fcntl.flock(guardian, cf.fcntl.LOCK_UN)
                    # Deployment holds EX: an inspection (and verify-cohort) is refused, never waits.
                    cf.fcntl.flock(deployer, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB)
                    self.assertRaises(cf.SyncError, cf.exclusive_lock(create=False, shared=True).__enter__)
                    self.assertRaises(cf.SyncError, cf.exclusive_lock().__enter__)
                    cf.fcntl.flock(deployer, cf.fcntl.LOCK_UN)
                    # verify-cohort holds EX: guardian and inspection are refused.
                    with cf.exclusive_lock():
                        self.assertRaises(BlockingIOError, cf.fcntl.flock, guardian, cf.fcntl.LOCK_SH | cf.fcntl.LOCK_NB)
                        self.assertRaises(cf.SyncError, cf.exclusive_lock(create=False, shared=True).__enter__)
                finally:
                    os.close(guardian); os.close(deployer)

    def test_main_lock_mode_per_command_and_descriptor_origin(self):
        """Through main(): inspections SH on their own fd, EX on an inherited fd; verify-cohort EX (may create)."""
        SH, EX = cf.fcntl.LOCK_SH | cf.fcntl.LOCK_NB, cf.fcntl.LOCK_EX | cf.fcntl.LOCK_NB
        evidence = types.SimpleNamespace(disposition='private_namespace_empty', state=None, journal=None, state_files_read=True)
        class NotApplicable:
            def __init__(self, component): self.component = component
        class Snapshotter:
            def __init__(self, **kwargs): pass
            def collect(self): return 'snapshot'
        class ContextCollector:
            def __init__(self, **kwargs): pass
            def collect(self): return NotApplicable('context')
        admission = types.SimpleNamespace(firewall=NotApplicable('firewall'), nginx=NotApplicable('nginx'))
        helper = types.SimpleNamespace(read_private_state=mock.Mock(return_value=evidence), Snapshotter=Snapshotter,
                                       ContextCollector=ContextCollector, NotApplicable=NotApplicable,
                                       ComponentResult=type('ComponentResult', (), {}),
                                       admit_snapshot=mock.Mock(return_value=admission))
        for command, inherited, expected in (('inspect-state', False, SH), ('inspect-state', True, EX),
                                             ('inspect-runtime', False, SH), ('inspect-runtime', True, EX),
                                             ('verify-cohort', False, EX), ('verify-cohort', True, EX)):
            with self.subTest(command=command, inherited=inherited), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / 'lock'
                if command != 'verify-cohort' or inherited:
                    lock.write_bytes(b''); lock.chmod(0o600)
                calls, flock = self.flock_recorder()
                fd = os.open(lock, os.O_RDWR) if inherited else None
                try:
                    argv = (['--lock-fd', str(fd)] if inherited else []) + [command]
                    with (self.root_owned_lock(lock, flock), mock.patch.object(cf.os, 'geteuid', return_value=0),
                          mock.patch.object(cf, '_bundle_runtime', return_value={'cloudfront_snapshot': helper}),
                          mock.patch.object(cf, '_bundle_config', return_value=config()),
                          contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO())):
                        self.assertEqual(cf.main(argv), 0)
                finally:
                    if fd is not None:
                        os.close(fd)
                self.assertEqual([op for _fd, op in calls], [expected])
                self.assertTrue(lock.exists())  # verify-cohort without a lock created it

    def test_self_opened_lock_on_a_fifo_is_refused_without_blocking(self):
        """A FIFO at the lock path never blocks the read-only open (O_NONBLOCK): sync_failed at once.

        Run in a child process with a timeout: a blocking open would hang it
        (O_RDONLY on a FIFO waits for a writer) instead of failing the test.
        """
        child = textwrap.dedent('''
            import contextlib, importlib.util, io, os, sys
            from pathlib import Path
            from unittest import mock
            spec = importlib.util.spec_from_file_location('cloudfront_sync', sys.argv[1])
            cf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cf)
            lock = Path(sys.argv[2]); os.mkfifo(lock, 0o600)
            with (mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf, 'check_path'),
                  mock.patch.object(cf.os, 'geteuid', return_value=0),
                  mock.patch.object(cf, '_bundle_runtime', side_effect=AssertionError('bundle')),
                  mock.patch.object(cf, '_bundle_config', side_effect=AssertionError('config'))):
                try:
                    with cf.exclusive_lock(create=False, shared=True):
                        sys.exit(3)
                except cf.SyncError:
                    pass
                for command in ('inspect-state', 'inspect-runtime'):
                    if cf.main([command]) != 1:
                        sys.exit(4)
        ''')
        with tempfile.TemporaryDirectory() as tmp:
            try:
                done = subprocess.run([sys.executable, '-B', '-c', child, str(MODULE_PATH), str(Path(tmp) / 'lock')],
                                      capture_output=True, text=True, timeout=20)
            except subprocess.TimeoutExpired:
                self.fail('opening a FIFO lock blocked')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, '')
        self.assertEqual(done.stderr, (cf.canonical({'error': 'sync_failed'}) + '\n') * 2)

    def test_lock_mode_must_be_exactly_0600(self):
        """The lock is a root-owned 0600 file: 0400 or 0700 (no group/other bits either) is refused."""
        for mode in (0o400, 0o700, 0o640, 0o4600):
            for origin in ('shared', 'exclusive', 'inherited'):
                if origin == 'exclusive' and not mode & 0o200 and os.geteuid() != 0:
                    continue  # this non-root user could not open it O_RDWR at all (root can)
                with self.subTest(mode=oct(mode), origin=origin), tempfile.TemporaryDirectory() as tmp:
                    lock = Path(tmp) / 'lock'
                    lock.write_bytes(b''); lock.chmod(0o600)
                    fd = os.open(lock, os.O_RDONLY) if origin == 'inherited' else None
                    lock.chmod(mode)
                    try:
                        with self.root_owned_lock(lock):
                            with self.assertRaises(cf.SyncError):
                                with cf.exclusive_lock(fd, create=origin == 'exclusive', shared=origin != 'exclusive'):
                                    self.fail('entered with a lock of mode ' + oct(mode))
                    finally:
                        if fd is not None:
                            os.close(fd)
        # 0600 itself is accepted on every path.
        for origin in ('shared', 'exclusive', 'inherited'):
            with self.subTest(mode='0o600', origin=origin), tempfile.TemporaryDirectory() as tmp:
                lock = Path(tmp) / 'lock'
                lock.write_bytes(b''); lock.chmod(0o600)
                fd = os.open(lock, os.O_RDONLY) if origin == 'inherited' else None
                try:
                    entered = []
                    with self.root_owned_lock(lock):
                        with cf.exclusive_lock(fd, create=origin == 'exclusive', shared=origin != 'exclusive'):
                            entered.append(True)
                    self.assertEqual(entered, [True])
                finally:
                    if fd is not None:
                        os.close(fd)

    def test_secure_paths_reject_symlink_ownership_modes_and_shapes(self):
        def info(mode, uid=0):
            return mock.Mock(st_mode=mode, st_uid=uid)
        paths = {'/': info(0o040755), '/safe': info(0o040755), '/safe/file': info(0o100600)}
        def lstat(path):
            if str(path) not in paths:
                raise FileNotFoundError()
            return paths[str(path)]
        with mock.patch.object(cf.os, 'geteuid', return_value=0), mock.patch.object(cf.Path, 'lstat', lstat):
            cf.check_path('/safe/file', writable=True)
            cf.check_path('/safe', directory=True)
            for mode, uid in [(0o120777, 0), (0o100600, 1000), (0o100622, 0), (0o040700, 0)]:
                paths['/safe/file'] = info(mode, uid)
                self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', writable=True)
            paths['/safe/file'] = info(0o100644)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', writable=True)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', directory=True)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/missing')
            del paths['/safe']
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file')
            paths['/safe'] = info(0o100600)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file')

    def test_sticky_root_lock_directory_and_invalid_descriptor(self):
        lock = Path('/run/lock/cloudfront-sync.lock')
        parent = mock.Mock(st_mode=0o041777, st_uid=0, st_dev=1, st_ino=1)
        file = mock.Mock(st_mode=0o100600, st_uid=0, st_dev=1, st_ino=2, st_nlink=1)
        def lstat(path):
            return parent if path == lock.parent else file
        with mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf.Path, 'lstat', lstat), mock.patch.object(cf, 'check_path') as check, mock.patch.object(cf.os, 'fstat', return_value=file), mock.patch.object(cf.fcntl, 'flock'):
            with cf.exclusive_lock(7):
                pass
            check.assert_called_with(Path('/run'), directory=True)
            file.st_mode = 0o100644
            self.assertRaises(cf.SyncError, cf.exclusive_lock(7).__enter__)
            file.st_mode = 0o100600; file.st_uid = 1000
            self.assertRaises(cf.SyncError, cf.exclusive_lock(7).__enter__)


class CliTests(unittest.TestCase):
    def test_read_only_commands_are_root_only_with_sanitized_errors(self):
        # main() converts every Exception into sync_failed, so a raising
        # tripwire would be swallowed. The lock, bundle and config are
        # recording mocks that would succeed; only the call record proves the
        # root check ran first.
        for command in sorted(READ_ONLY_COMMANDS):
            with self.subTest(command=command):
                err = io.StringIO()
                with (mock.patch.object(cf.os, 'geteuid', return_value=501),
                      mock.patch.object(cf, 'exclusive_lock', return_value=contextlib.nullcontext()) as lock,
                      mock.patch.object(cf, '_bundle_runtime', return_value={}) as bundle,
                      mock.patch.object(cf, '_bundle_config', return_value=config()) as read_config,
                      contextlib.redirect_stderr(err)):
                    self.assertEqual(cf.main([command]), 1)
                lock.assert_not_called(); bundle.assert_not_called(); read_config.assert_not_called()
                self.assertEqual(json.loads(err.getvalue()), {'error': 'sync_failed'})

    def test_refused_commands_refuse_even_without_root_or_fixed_config(self):
        for argv in (['preflight'], ['--config', '/etc/other-cloudfront-sync.json', 'plan']):
            err = io.StringIO()
            with mock.patch.object(cf.os, 'geteuid', return_value=501), contextlib.redirect_stderr(err):
                self.assertEqual(cf.main(argv), 1)
            self.assertEqual(json.loads(err.getvalue()), {'error': 'runtime_actor_not_connected'})

    def test_cohort_verify_is_not_policy_success(self):
        with (mock.patch.object(cf,'_bundle_runtime',return_value={}),mock.patch.object(cf,'_bundle_config',return_value=config()),
              mock.patch.object(cf.os,'geteuid',return_value=0),mock.patch.object(cf,'exclusive_lock',return_value=contextlib.nullcontext())):
            output=io.StringIO()
            with contextlib.redirect_stdout(output):self.assertEqual(cf.main(['verify-cohort']),0)
        result=json.loads(output.getvalue())
        self.assertTrue(result['cohort_verified']);self.assertFalse(result['runtime_ready']);self.assertFalse(result['policy_verified'])

    def test_inspect_state_is_sanitized_and_read_only(self):
        evidence=types.SimpleNamespace(disposition='private_namespace_empty',state=None,journal=None,state_files_read=True)
        helper=types.SimpleNamespace(read_private_state=mock.Mock(return_value=evidence))
        private=Path('/var/lib/cloudfront-sync/private')
        output=io.StringIO();error=io.StringIO()
        # main() uses the modules _bundle_runtime() returns, nothing global.
        with (mock.patch.object(cf,'_bundle_runtime',return_value={'cloudfront_snapshot':helper}),
              mock.patch.object(cf,'_bundle_config',return_value=config()),
              mock.patch.object(cf,'exclusive_lock',side_effect=lambda *a,**k:contextlib.nullcontext()) as lock,
              mock.patch.object(cf.os,'geteuid',return_value=0),
              contextlib.redirect_stdout(output),contextlib.redirect_stderr(error)):
            self.assertEqual(cf.main(['inspect-state']),0)
        lock.assert_called_once_with(None,create=False,shared=True)
        helper.read_private_state.assert_called_once_with(str(private),owner=0,group=0)
        result=json.loads(output.getvalue())
        self.assertEqual(result,{'generation_id':cf.BUNDLE_GENERATION_ID,'inspection':'read_only_state_only',
                                 'private_state_disposition':'private_namespace_empty','state_disposition':'absent',
                                 'journal_disposition':'absent','runtime_ready':False})
        self.assertEqual(error.getvalue(),'')

    def test_readonly_lock_never_creates_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock=Path(tmp)/'missing.lock'
            with mock.patch.object(cf,'LOCK',lock),mock.patch.object(cf,'check_path'):
                with self.assertRaises(FileNotFoundError):
                    with cf.exclusive_lock(create=False):pass
            self.assertFalse(lock.exists())

    def test_inspect_runtime_hashes_the_config_only_for_a_data_state_baseline(self):
        # Without a pt_state_data_only baseline nothing is compared, so the
        # config is not hashed at all and admit_snapshot gets no hash.
        class Result:
            def __init__(self,status,code):self.status,self.code=status,code
        class NotApplicable:
            def __init__(self,component):self.component=component
        class Snapshotter:
            def __init__(self,**kwargs):pass
            def collect(self):return 'snapshot'
        class ContextCollector:
            def __init__(self,**kwargs):pass
            def collect(self):return NotApplicable('context')
        legacy=types.SimpleNamespace(disposition='manual_legacy_or_unproven_state',baseline='not-a-baseline',
                                     config_hash='a'*64,enrollment_id='b'*32)
        for state in (None,legacy):
            with self.subTest(state=state and state.disposition):
                evidence=types.SimpleNamespace(disposition='private_namespace_empty' if state is None else legacy.disposition,
                                               state=state,journal=None,state_files_read=True)
                admission=types.SimpleNamespace(firewall=Result('failure','baseline_required'),
                                                nginx=NotApplicable('nginx'))
                module=types.SimpleNamespace(read_private_state=mock.Mock(return_value=evidence),
                    Snapshotter=Snapshotter,ContextCollector=ContextCollector,NotApplicable=NotApplicable,
                    ComponentResult=Result,admit_snapshot=mock.Mock(return_value=admission),
                    config_hash=mock.Mock(side_effect=AssertionError('config hashed without a data-state baseline')))
                output=io.StringIO();error=io.StringIO()
                with (mock.patch.object(cf,'_bundle_runtime',return_value={'cloudfront_snapshot':module}),
                      mock.patch.object(cf,'_bundle_config',return_value=config()),
                      mock.patch.object(cf,'exclusive_lock',side_effect=lambda *a,**k:contextlib.nullcontext()),
                      mock.patch.object(cf.os,'geteuid',return_value=0),
                      contextlib.redirect_stdout(output),contextlib.redirect_stderr(error)):
                    self.assertEqual(cf.main(['inspect-runtime']),0,error.getvalue())
                module.config_hash.assert_not_called()
                module.admit_snapshot.assert_called_once_with('snapshot',None,config_hash=None,enrollment_id=None,owner=0)
                result=json.loads(output.getvalue())
                self.assertEqual(result['firewall'],{'status':'failure','code':'baseline_required'})
                self.assertEqual(error.getvalue(),'')

    def test_inspect_runtime_is_readonly_and_reports_independent_components(self):
        class Result:
            def __init__(self,status,code):self.status,self.code=status,code
        class NotApplicable:
            def __init__(self,component):self.component=component
        state=types.SimpleNamespace(disposition='pt_state_data_only',baseline='persisted-p',
                                    config_hash='a'*64,enrollment_id='b'*32)
        state_evidence=types.SimpleNamespace(disposition='pt_state_data_only',state=state,journal=None,state_files_read=True)
        snapshot=object();snapshotters=[]
        class Snapshotter:
            def __init__(self,**kwargs):self.kwargs=kwargs;snapshotters.append(kwargs)
            def collect(self):return snapshot
        class ContextCollector:
            def __init__(self,**kwargs):self.kwargs=kwargs
            def collect(self):return types.SimpleNamespace(stable_raw=True)
        admission=types.SimpleNamespace(firewall=Result('failure','baseline_context_mismatch'),
                                        nginx=Result('failure','nginx_sandbox_unavailable'))
        module_hash='d'*64
        module=types.SimpleNamespace(read_private_state=mock.Mock(return_value=state_evidence),
            Snapshotter=Snapshotter,ContextCollector=ContextCollector,NotApplicable=NotApplicable,
            ComponentResult=Result,admit_snapshot=mock.Mock(return_value=admission),
            config_hash=mock.Mock(return_value=module_hash))
        output=io.StringIO();error=io.StringIO()
        with (mock.patch.object(cf,'_bundle_runtime',return_value={'cloudfront_snapshot':module}),
              mock.patch.object(cf,'_bundle_config',return_value=config()),
              mock.patch.object(cf,'exclusive_lock',side_effect=lambda *a,**k:contextlib.nullcontext()) as lock,
              mock.patch.object(cf.os,'geteuid',return_value=0),
              contextlib.redirect_stdout(output),contextlib.redirect_stderr(error)):
            self.assertEqual(cf.main(['inspect-runtime']),0)
        lock.assert_called_once_with(None,create=False,shared=True)
        module.read_private_state.assert_called_once_with('/var/lib/cloudfront-sync/private',owner=0,group=0)
        # The hash is the bundle snapshot module's public config_hash, the one
        # the ledger uses; the CLI has no canonicalization or hashing of its own.
        module.config_hash.assert_called_once_with(config())
        module.admit_snapshot.assert_called_once_with(mock.ANY,'persisted-p',
                                                     config_hash=module_hash,
                                                     enrollment_id='b'*32,owner=0)
        result=json.loads(output.getvalue())
        self.assertEqual(result['inspection'],'read_only_observation')
        self.assertEqual(result['firewall'],{'status':'failure','code':'baseline_context_mismatch'})
        self.assertEqual(result['nginx'],{'status':'failure','code':'nginx_sandbox_unavailable'})
        self.assertEqual(result['context'],{'status':'observed_unverified','stable_raw':True})
        # The config's nginx settings are passed as they are; nothing else.
        self.assertEqual(snapshotters,[{'backend':'ufw','nginx_enabled':False,
                                        'nginx_shared_dir':'/etc/nginx/cloudfront','nginx_bundles':[]}])
        self.assertEqual(result['state'],'pt_state_data_only')
        self.assertFalse(result['runtime_ready'])
        self.assertEqual(error.getvalue(),'')

    # Real bundle snapshot module, a real private namespace on disk (the fixed
    # path/owner read_private_state receives is redirected to it) and backend
    # none, whose firewall component is accepted only with a baseline.
    RUNTIME_BASELINE_CODE = textwrap.dedent('''
        import contextlib, io, importlib.util, json, os, sys, tempfile, types
        from pathlib import Path
        from unittest import mock
        files = Path(sys.argv[1])
        if sys.platform == 'linux' and os.geteuid() != 0 and hasattr(os, 'O_NOATIME'):
            del os.O_NOATIME  # Linux refuses O_NOATIME on root-owned ancestors for non-root
        for name in ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel',
                     'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot'):
            module = types.ModuleType(name); module.__file__ = str(files / (name + '.py')); sys.modules[name] = module
            exec(compile((files / (name + '.py')).read_bytes(), module.__file__, 'exec'), module.__dict__)
        m = sys.modules['cloudfront_snapshot']
        spec = importlib.util.spec_from_file_location('cli', files / 'cloudfront-sync.py')
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        config = {'host_address': '192.0.2.10', 'firewall': {'backend': 'none', 'ports': [443]},
                  'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
                  'limits': {'max_changes': 10, 'min_ratio': 0.8}, 'notify_unit': ''}
        digest = m.config_hash(config)
        def encoded(value):
            return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        p = {'integrity_format': m.FORMAT, 'backend': 'none', 'config_hash': digest, 'enrollment_id': 'b' * 32,
             'profile_id': 'none', 'inventory': None, 'owned_rules': []}
        state = encoded({'version': 2, 'integrity_format': m.FORMAT, 'generation_id': 'c' * 64, 'config_hash': digest,
                         'enrollment_id': 'b' * 32, 'baseline': p, 'ranges': ['192.0.2.0/24'],
                         'aws_sync_token': '11', 'last_success': None})
        journal = encoded({'version': 2, 'journal_format': m.FORMAT, 'generation_id': 'c' * 64, 'config_hash': digest,
                           'enrollment_id': 'b' * 32, 'transaction_id': 'd' * 64, 'phase': 'prepared',
                           'frontier': 0, 'step_count': 0, 'baseline': p})
        legacy_journal = encoded({'version': 1, 'config_hash': digest})
        cases = {'state_only': {'state.json': state},
                 'state_and_journal': {'state.json': state, 'journal.json': journal},
                 'state_and_pending': {'state.json': state, 'pending.json': b'{"version":1}'},
                 'state_and_legacy_journal': {'state.json': state, 'journal.json': legacy_journal}}
        owner = os.geteuid()
        tmp_root = str(Path('/tmp').resolve())
        rows = {}
        for label, names in cases.items():
            with tempfile.TemporaryDirectory(dir=tmp_root) as td:
                private = Path(td) / 'private'; private.mkdir(mode=0o700)
                for name, raw in names.items():
                    (private / name).write_bytes(raw); (private / name).chmod(0o600)
                group = os.stat(private).st_gid
                proxy = types.SimpleNamespace(**vars(m))
                proxy.read_private_state = lambda path, **kw: m.read_private_state(private, owner=owner, group=group)
                proxy.config_hash = mock.Mock(wraps=m.config_hash)
                proxy.admit_snapshot = mock.Mock(wraps=m.admit_snapshot)
                output, error = io.StringIO(), io.StringIO()
                with (mock.patch.object(cli, '_bundle_runtime', return_value={'cloudfront_snapshot': proxy}),
                      mock.patch.object(cli, '_bundle_config', return_value=config),
                      mock.patch.object(cli, 'exclusive_lock', side_effect=lambda *a, **k: contextlib.nullcontext()),
                      mock.patch.object(cli.os, 'geteuid', return_value=0),
                      contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                    code = cli.main(['inspect-runtime'])
                result = json.loads(output.getvalue()) if code == 0 else None
                call = proxy.admit_snapshot.call_args
                rows[label] = {'code': code, 'error': error.getvalue(),
                               'private_state': result and result['private_state'], 'state': result and result['state'],
                               'firewall': result and result['firewall'],
                               'hashed': proxy.config_hash.call_count,
                               'baseline_passed': call is not None and call.args[1] is not None,
                               'hash_passed': call is not None and call.kwargs['config_hash'] is not None,
                               'enrollment_passed': call is not None and call.kwargs['enrollment_id'] is not None}
        print(json.dumps(rows))
    ''')

    def test_inspect_runtime_uses_the_state_baseline_only_when_the_namespace_is_data_only(self):
        """The baseline is admitted only for private_state disposition pt_state_data_only.

        A v2 state next to a journal (recognized or legacy) or a pending
        companion is a manual namespace: the firewall is not admitted from that
        state's baseline and the config is not hashed.
        """
        done = subprocess.run([sys.executable, '-I', '-B', '-c', self.RUNTIME_BASELINE_CODE, str(MODULE_PATH.parent)],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = json.loads(done.stdout)
        # Control: the same v2 state alone is a data-only namespace and its
        # baseline (with the config hash) is what admits the none backend.
        self.assertEqual(rows['state_only'], {'code': 0, 'error': '', 'private_state': 'pt_state_data_only',
                                              'state': 'pt_state_data_only',
                                              'firewall': {'status': 'not_applicable', 'component': 'firewall'},
                                              'hashed': 1, 'baseline_passed': True, 'hash_passed': True,
                                              'enrollment_passed': True})
        for label, disposition in (('state_and_journal', 'manual_ledger_not_connected'),
                                   ('state_and_pending', 'pending_or_companion_manual'),
                                   ('state_and_legacy_journal', 'manual_legacy_pending')):
            with self.subTest(case=label):
                self.assertEqual(rows[label], {'code': 0, 'error': '', 'private_state': disposition,
                                               'state': 'pt_state_data_only',
                                               'firewall': {'status': 'failure', 'code': 'baseline_required'},
                                               'hashed': 0, 'baseline_passed': False, 'hash_passed': False,
                                               'enrollment_passed': False})


    # The real bundle snapshot module reads real private namespaces; both
    # inspections report what that one read decided about state.json and
    # journal.json.
    STATE_REPORT_CODE = textwrap.dedent('''
        import contextlib, io, importlib.util, json, os, sys, tempfile, types
        from pathlib import Path
        from unittest import mock
        files = Path(sys.argv[1])
        if sys.platform == 'linux' and os.geteuid() != 0 and hasattr(os, 'O_NOATIME'):
            del os.O_NOATIME  # Linux refuses O_NOATIME on root-owned ancestors for non-root
        for name in ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel',
                     'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot'):
            module = types.ModuleType(name); module.__file__ = str(files / (name + '.py')); sys.modules[name] = module
            exec(compile((files / (name + '.py')).read_bytes(), module.__file__, 'exec'), module.__dict__)
        m = sys.modules['cloudfront_snapshot']
        spec = importlib.util.spec_from_file_location('cli', files / 'cloudfront-sync.py')
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        config = {'host_address': '192.0.2.10', 'firewall': {'backend': 'none', 'ports': [443]},
                  'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
                  'limits': {'max_changes': 10, 'min_ratio': 0.8}, 'notify_unit': ''}
        legacy_state = b'{"initialized":true,"version":1}'
        legacy_journal = b'{"version":1}'
        cases = {'directory_absent': None, 'empty': {}, 'state_only': {'state.json': legacy_state},
                 'pending_only': {'pending.json': b'{"version":1}'},
                 'unknown_only': {'stray': b'x'},
                 'unknown_with_state_and_journal': {'stray': b'x', 'state.json': legacy_state,
                                                    'journal.json': legacy_journal}}
        owner = os.geteuid()
        tmp_root = str(Path('/tmp').resolve())
        rows = {}
        for label, names in cases.items():
            with tempfile.TemporaryDirectory(dir=tmp_root) as td:
                private = Path(td) / 'private'
                if names is not None:
                    private.mkdir(mode=0o700)
                    for name, raw in names.items():
                        (private / name).write_bytes(raw); (private / name).chmod(0o600)
                group = os.stat(td).st_gid
                proxy = types.SimpleNamespace(**vars(m))
                proxy.read_private_state = lambda path, **kw: m.read_private_state(private, owner=owner, group=group)
                for command in ('inspect-state', 'inspect-runtime'):
                    output, error = io.StringIO(), io.StringIO()
                    with (mock.patch.object(cli, '_bundle_runtime', return_value={'cloudfront_snapshot': proxy}),
                          mock.patch.object(cli, '_bundle_config', return_value=config),
                          mock.patch.object(cli, 'exclusive_lock', side_effect=lambda *a, **k: contextlib.nullcontext()),
                          mock.patch.object(cli.os, 'geteuid', return_value=0),
                          contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                        code = cli.main([command])
                    result = json.loads(output.getvalue()) if code == 0 else {'code': code, 'error': error.getvalue()}
                    keys = (('private_state_disposition', 'state_disposition', 'journal_disposition')
                            if command == 'inspect-state' else ('private_state', 'state', 'journal'))
                    rows.setdefault(label, {})[command] = [result.get(key, result) for key in keys]
        print(json.dumps(rows))
    ''')

    # Expected [private state, state, journal] per namespace, the same for
    # inspect-state and inspect-runtime.
    STATE_REPORTS = {
        'directory_absent': ['private_directory_absent', 'absent', 'absent'],
        'empty': ['private_namespace_empty', 'absent', 'absent'],
        'state_only': ['manual_legacy_or_unproven_state', 'manual_legacy_or_unproven_state', 'absent'],
        'pending_only': ['pending_or_companion_manual', 'absent', 'absent'],
        # Only listed, never read: state.json and journal.json may exist.
        'unknown_only': ['unknown_private_entries_manual', 'not_read', 'not_read'],
        'unknown_with_state_and_journal': ['unknown_private_entries_manual', 'not_read', 'not_read'],
    }

    def test_inspections_report_not_read_unless_the_files_were_read_or_proven_absent(self):
        """'absent' only when state.json/journal.json is known not to exist; 'not_read' when never read."""
        done = subprocess.run([sys.executable, '-I', '-B', '-c', self.STATE_REPORT_CODE, str(MODULE_PATH.parent)],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = json.loads(done.stdout)
        for label, expected in self.STATE_REPORTS.items():
            for command in ('inspect-state', 'inspect-runtime'):
                with self.subTest(case=label, command=command):
                    self.assertEqual(rows[label][command], expected)

    def test_readme_states_when_state_and_journal_are_absent_or_not_read(self):
        readme = ' '.join((MODULE_PATH.parents[1] / 'README.md').read_text().split())
        for row in ('| `private_directory_absent` | the directory does not exist | `absent` | `absent` |',
                    '| `unknown_private_entries_manual` | listed only, no file read | `not_read` | `not_read` |',
                    '| any other disposition | every file read and parsed | the parsed disposition, or `absent` when the file does not exist | the parsed disposition, or `absent` when the file does not exist |'):
            with self.subTest(row=row):
                self.assertIn(row, readme)

    def test_inspections_never_report_absent_for_an_unread_namespace(self):
        """A fake reader result that read nothing (state_files_read False) is never 'absent'."""
        class NotApplicable:
            def __init__(self, component): self.component = component
        class Snapshotter:
            def __init__(self, **kwargs): pass
            def collect(self): return 'snapshot'
        class ContextCollector:
            def __init__(self, **kwargs): pass
            def collect(self): return NotApplicable('context')
        for read, expected in ((False, 'not_read'), (True, 'absent')):
            evidence = types.SimpleNamespace(disposition='some_disposition', state=None, journal=None,
                                             state_files_read=read)
            admission = types.SimpleNamespace(firewall=NotApplicable('firewall'), nginx=NotApplicable('nginx'))
            module = types.SimpleNamespace(read_private_state=mock.Mock(return_value=evidence),
                Snapshotter=Snapshotter, ContextCollector=ContextCollector, NotApplicable=NotApplicable,
                ComponentResult=type('Result', (), {}), admit_snapshot=mock.Mock(return_value=admission),
                config_hash=mock.Mock(side_effect=AssertionError('hashed')))
            for command, keys in (('inspect-state', ('state_disposition', 'journal_disposition')),
                                  ('inspect-runtime', ('state', 'journal'))):
                with self.subTest(read=read, command=command):
                    output, error = io.StringIO(), io.StringIO()
                    with (mock.patch.object(cf, '_bundle_runtime', return_value={'cloudfront_snapshot': module}),
                          mock.patch.object(cf, '_bundle_config', return_value=config()),
                          mock.patch.object(cf, 'exclusive_lock', side_effect=lambda *a, **k: contextlib.nullcontext()),
                          mock.patch.object(cf.os, 'geteuid', return_value=0),
                          contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                        self.assertEqual(cf.main([command]), 0, error.getvalue())
                    result = json.loads(output.getvalue())
                    self.assertEqual([result[key] for key in keys], [expected, expected])


READ_ONLY_COMMANDS = frozenset({'verify-cohort', 'inspect-state', 'inspect-runtime'})
REFUSED_COMMANDS = {'preflight': [], 'plan': [], 'sync': [], 'apply': ['--approve=private-token'],
                    'import': ['--approve=private-token'], 'import-plan': ['--legacy-state=/root/not-read.json']}
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND

# Host-effect entry points. Names a platform lacks (e.g. os.spawnlp on some
# builds) are skipped, never silently replaced by a weaker check.
FORBIDDEN_SUBPROCESS = ('run', 'Popen', 'call', 'check_call', 'check_output', 'getoutput', 'getstatusoutput')
FORBIDDEN_OS = ('system', 'popen', 'replace', 'rename', 'renames', 'mkdir', 'makedirs', 'unlink', 'remove', 'rmdir',
                'removedirs', 'chmod', 'fchmod', 'lchmod', 'chown', 'fchown', 'lchown', 'symlink', 'link',
                'truncate', 'ftruncate', 'fork', 'forkpty', 'kill', 'killpg', 'utime',
                'write', 'writev', 'pwrite', 'pwritev', 'sendfile', 'copy_file_range', 'splice',
                'posix_fallocate', 'setxattr', 'removexattr', 'chflags', 'lchflags', 'chroot',
                'execl', 'execle', 'execlp', 'execlpe', 'execv', 'execve', 'execvp', 'execvpe',
                'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe',
                'posix_spawn', 'posix_spawnp', 'mkfifo', 'mknod',
                # Descriptor redirection, credentials, environment and scheduling
                # change the process or what its children inherit.
                'dup', 'dup2', 'setuid', 'seteuid', 'setgid', 'setegid', 'setreuid', 'setregid',
                'setresuid', 'setresgid', 'setgroups', 'initgroups', 'putenv', 'unsetenv',
                'nice', 'setpriority', 'sched_setaffinity', 'sched_setparam', 'sched_setscheduler',
                'setsid', 'setpgid', 'setpgrp', 'tcsetpgrp', 'login_tty',
                # Namespaces (Linux, Python 3.12+); os has no mount API.
                'unshare', 'setns')
FORBIDDEN_SHUTIL = ('copy', 'copy2', 'copyfile', 'copymode', 'copystat', 'copytree', 'move', 'rmtree', 'chown')
FORBIDDEN_SOCKET = ('socket', 'create_connection')
FORBIDDEN_URLLIB = ('urlopen',)
# copy/copy_into/move/move_into exist from Python 3.14. Path.open,
# write_text and write_bytes reach io.open, which the guard also checks.
FORBIDDEN_PATH = ('mkdir', 'write_text', 'write_bytes', 'touch', 'unlink', 'rmdir', 'symlink_to',
                  'hardlink_to', 'link_to', 'chmod', 'lchmod', 'rename', 'replace',
                  'copy', 'copy_into', 'move', 'move_into')


def forbidden_targets():
    for module, names in ((subprocess, FORBIDDEN_SUBPROCESS), (os, FORBIDDEN_OS), (shutil, FORBIDDEN_SHUTIL),
                          (socket, FORBIDDEN_SOCKET), (urllib.request, FORBIDDEN_URLLIB), (Path, FORBIDDEN_PATH)):
        for name in names:
            if hasattr(module, name):
                yield module, name


class HostEffectAttempt(BaseException):
    """Raised by the guard. BaseException, so main()'s ``except Exception`` cannot swallow it."""


@contextlib.contextmanager
def no_host_effects():
    """Fail on any process start, filesystem mutation, network use or writable open.

    Every attempt is recorded *and* raises HostEffectAttempt. The record is
    checked on exit, so even code that catches BaseException cannot hide one.
    """
    real_open, real_os_open = open, os.open
    attempts = []
    def refuse(name):
        attempts.append(name)
        raise HostEffectAttempt('forbidden host effect: ' + name)
    def forbidden(name):
        return lambda *args, **kwargs: refuse(name)
    def guarded_open(file, mode='r', *args, **kwargs):
        if any(flag in mode for flag in 'wax+'):
            refuse('writable open')
        return real_open(file, mode, *args, **kwargs)
    def guarded_os_open(path, flags, *args, **kwargs):
        if flags & _WRITE_FLAGS:
            refuse('writable os.open')
        return real_os_open(path, flags, *args, **kwargs)
    with contextlib.ExitStack() as stack:
        for target, name in forbidden_targets():
            stack.enter_context(mock.patch.object(target, name, side_effect=forbidden(name)))
        stack.enter_context(mock.patch('builtins.open', guarded_open))
        stack.enter_context(mock.patch.object(io, 'open', guarded_open))
        stack.enter_context(mock.patch.object(os, 'open', guarded_os_open))
        yield attempts
    if attempts:
        raise AssertionError('forbidden host effects attempted: ' + ', '.join(attempts))


def cli_subcommands():
    """The subcommands of the real parser main() uses (and prints in --help)."""
    actions = [a for a in cf.build_parser()._actions if isinstance(a, cf.argparse._SubParsersAction)]
    return frozenset(actions[0].choices)


_DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
_BLOCKS = tuple(getattr(ast, name) for name in ('If', 'Try', 'TryStar', 'With', 'AsyncWith', 'For', 'AsyncFor',
                                                'While', 'Match') if hasattr(ast, name))


def _bound_names(target):
    if isinstance(target, ast.Name):
        yield target.id
    elif isinstance(target, (ast.Tuple, ast.List)):
        for element in target.elts:
            yield from _bound_names(element)
    elif isinstance(target, ast.Starred):
        yield from _bound_names(target.value)


def module_definitions(tree):
    """(name, node) for every module-scope binding, in source order.

    Covers def/async def/class, plain, annotated and augmented assignments, and
    for/with targets, including those nested in module-level if/try/with/for/
    while/match blocks (never inside a function or class body).
    """
    rows, pending = [], list(tree.body)
    while pending:
        node = pending.pop(0)
        if isinstance(node, _DEFINITIONS):
            rows.append((node.name, node))
            continue
        if isinstance(node, ast.Assign):
            rows.extend((name, node) for target in node.targets for name in _bound_names(target))
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            rows.extend((name, node) for name in _bound_names(node.target))
        if isinstance(node, _BLOCKS):
            if isinstance(node, (ast.For, ast.AsyncFor)):
                rows.extend((name, node) for name in _bound_names(node.target))
            for item in getattr(node, 'items', ()):
                if item.optional_vars is not None:
                    rows.extend((name, node) for name in _bound_names(item.optional_vars))
            blocks = [getattr(node, field, []) for field in ('body', 'orelse', 'finalbody')]
            blocks += [handler.body for handler in getattr(node, 'handlers', ())]
            blocks += [case.body for case in getattr(node, 'cases', ())]
            pending[:0] = [statement for block in blocks for statement in block]
    return sorted(rows, key=lambda row: (row[1].lineno, row[1].col_offset))


def reachable_from_main(tree):
    """Module-scope definitions (see module_definitions) that main names, transitively.

    A name bound more than once (e.g. in both branches of a module-level if)
    reaches every binding. Scope: this file only; the bundle helper modules
    are covered by test_bundle_modules_open_read_only and their own tests.
    """
    defs = {}
    for name, node in module_definitions(tree):
        defs.setdefault(name, []).append(node)
    reached, pending = {}, ['main']
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        nodes = defs[name]
        reached[name] = nodes[0] if len(nodes) == 1 else ast.Module(body=list(nodes), type_ignores=[])
        pending.extend(n.id for node in nodes for n in ast.walk(node) if isinstance(n, ast.Name) and n.id in defs)
    return reached


_OS_MODULES = ('os', '_bg_os')
_READ_ONLY_OPEN_FLAGS = frozenset({'O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_NOATIME', 'O_CLOEXEC'})
# The only creating/writable os.open reachable from main(): verify-cohort's
# lock file. Any other non-read-only os.open, or flags that cannot be read
# statically, fails test_code_reachable_from_main_opens_only_read_only.
ALLOWED_WRITABLE_OPENS = (('exclusive_lock', frozenset({'O_RDWR', 'O_NOFOLLOW', 'O_CREAT'})),)


def _is_optional_flag(node, modules):
    """getattr(os, 'O_NOATIME', 0): an optional flag spelled as data."""
    return (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'getattr'
            and len(node.args) == 3 and not node.keywords
            and isinstance(node.args[0], ast.Name) and node.args[0].id in modules
            and isinstance(node.args[1], ast.Constant) and type(node.args[1].value) is str
            and node.args[1].value.startswith('O_')
            and isinstance(node.args[2], ast.Constant) and node.args[2].value == 0)


def _open_flag_names(node, modules=_OS_MODULES):
    """Flag names of a literal flags expression, or None when not statically known."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = _open_flag_names(node.left, modules), _open_flag_names(node.right, modules)
        return None if left is None or right is None else left | right
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
        return frozenset({node.attr}) if node.attr.startswith('O_') else None
    if _is_optional_flag(node, modules):
        return frozenset({node.args[1].value})
    return None


def os_open_calls(reached, modules=_OS_MODULES):
    """(definition, flag names or None) for every os.open call (any alias in ``modules``)."""
    calls = []
    for name, definition in reached.items():
        for item in ast.walk(definition):
            if (isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute) and item.func.attr == 'open'
                    and isinstance(item.func.value, ast.Name) and item.func.value.id in modules):
                flags = item.args[1] if len(item.args) > 1 else next(
                    (k.value for k in item.keywords if k.arg == 'flags'), None)
                calls.append((name, None if flags is None else _open_flag_names(flags, modules)))
    return calls


def unexpected_opens(reached):
    """Opens that are neither provably read-only nor the single allowlisted lock open."""
    calls = os_open_calls(reached)
    allowed = [call for call in calls if call in ALLOWED_WRITABLE_OPENS]
    other = [call for call in calls if call not in ALLOWED_WRITABLE_OPENS
             and (call[1] is None or not call[1] <= _READ_ONLY_OPEN_FLAGS)]
    if len(allowed) != len(ALLOWED_WRITABLE_OPENS):
        other.append(('allowlisted lock open count', len(allowed)))
    # Builtin/io/pathlib opens and descriptor wrappers bypass the flag check.
    for name, definition in reached.items():
        for item in ast.walk(definition):
            if isinstance(item, ast.Call) and (
                    (isinstance(item.func, ast.Name) and item.func.id in ('open', 'fdopen'))
                    or (isinstance(item.func, ast.Attribute) and item.func.attr == 'fdopen')
                    or (isinstance(item.func, ast.Attribute) and item.func.attr == 'open'
                        and not (isinstance(item.func.value, ast.Name) and item.func.value.id in _OS_MODULES))):
                other.append((name, 'non-os open'))
    return other


def host_effect_references(reached):
    """Static host-effect API references in ``reached``: (definition, line, api)."""
    os_names = set(FORBIDDEN_OS)
    # str.replace(old, new[, count]) has two or more positional arguments;
    # Path.replace(target) has one. Every other use of .replace is flagged.
    string_replace = {id(node.func) for definition in reached.values() for node in ast.walk(definition)
                      if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                      and node.func.attr == 'replace' and len(node.args) >= 2}
    offenders = []
    for name, node in reached.items():
        for item in ast.walk(node):
            if isinstance(item, ast.Name) and item.id in ('subprocess', 'shutil', 'socket', 'urllib', 'tempfile'):
                offenders.append((name, item.lineno, item.id))
            elif isinstance(item, ast.Attribute):
                owner = item.value.id if isinstance(item.value, ast.Name) else None
                if owner in _OS_MODULES and item.attr in os_names:
                    offenders.append((name, item.lineno, owner + '.' + item.attr))
                elif item.attr == 'replace' and id(item) in string_replace:
                    continue
                elif item.attr in FORBIDDEN_PATH or item.attr in FORBIDDEN_URLLIB + ('build_opener',):
                    offenders.append((name, item.lineno, item.attr))
    return offenders


class RuntimeActorRefusalTests(unittest.TestCase):
    """S0 characterization: only read commands run; every actor path stops before host effects."""

    def read_cli(self, argv):
        # Read commands need a verified bundle and the lock; both are stubbed
        # here and covered for real by test_entry_generation.
        output, error = io.StringIO(), io.StringIO()
        with (mock.patch.object(cf, '_bundle_runtime', return_value={}),
              mock.patch.object(cf, '_bundle_config', return_value=config()),
              mock.patch.object(cf.os, 'geteuid', return_value=0),
              mock.patch.object(cf, 'exclusive_lock', side_effect=lambda *a, **k: contextlib.nullcontext()),
              no_host_effects(), contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
            code = cf.main(argv)
        return code, output.getvalue(), error.getvalue()

    def refused_cli(self, argv, euid):
        """Run main with the REAL lock/bundle/config functions (spied, not replaced)."""
        output, error = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'cloudfront-sync.lock'
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(cf, 'LOCK', lock))
                spies = {name: stack.enter_context(mock.patch.object(cf, name, wraps=getattr(cf, name)))
                         for name in ('exclusive_lock', 'check_path', '_bundle_runtime', '_bundle_config',
                                      'validate_config')}
                if euid is not None:
                    stack.enter_context(mock.patch.object(cf.os, 'geteuid', return_value=euid))
                for context in (no_host_effects(), contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                    stack.enter_context(context)
                code = cf.main(argv)
            for name, spy in spies.items():
                self.assertEqual(spy.call_count, 0, name)
            self.assertFalse(lock.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])
        self.assertIsNone(cf._BUNDLE_RUNTIME)
        return code, output.getvalue(), error.getvalue()

    def test_every_cli_subcommand_is_classified(self):
        self.assertEqual(cli_subcommands(), READ_ONLY_COMMANDS | frozenset(REFUSED_COMMANDS))
        self.assertEqual(cf.READ_ONLY_COMMANDS, READ_ONLY_COMMANDS)
        self.assertEqual(cf.REFUSED_COMMANDS, frozenset(REFUSED_COMMANDS))

    def test_non_read_cli_commands_refuse_before_lock_bundle_config_or_any_host_effect(self):
        for command, extra in REFUSED_COMMANDS.items():
            for euid in (None, 0):
                with self.subTest(command=command, euid='actual' if euid is None else euid):
                    code, output, error = self.refused_cli([command, *extra], euid)
                    self.assertEqual(code, 1)
                    self.assertEqual(output, '')
                    self.assertEqual(json.loads(error), {'error': 'runtime_actor_not_connected'})
                    self.assertNotIn('private-token', error)

    def test_verify_cohort_stays_read_only_under_the_same_guard(self):
        code, output, error = self.read_cli(['verify-cohort'])
        self.assertEqual(code, 0)
        self.assertEqual(error, '')
        self.assertFalse(json.loads(output)['runtime_ready'])

    def test_guard_detects_every_forbidden_effect(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = str(Path(tmp) / 'x')
            # Every attempt is a lambda so the patched attribute is looked up
            # inside the guard (a captured real function would really run).
            attempts = {
                'os.remove': lambda: os.remove(target), 'os.rmdir': lambda: os.rmdir(tmp),
                'os.chmod': lambda: os.chmod(tmp, 0o700), 'os.symlink': lambda: os.symlink(tmp, target),
                'os.truncate': lambda: os.truncate(target, 0), 'os.fork': lambda: os.fork(),
                'os.execv': lambda: os.execv('/bin/true', ['true']),
                'os.posix_spawn': lambda: os.posix_spawn('/bin/true', ['true'], {}),
                'os.mkfifo': lambda: os.mkfifo(target), 'shutil.rmtree': lambda: shutil.rmtree(tmp),
                'shutil.copy': lambda: shutil.copy(tmp, target), 'shutil.move': lambda: shutil.move(tmp, target),
                'socket.socket': lambda: socket.socket(), 'socket.create_connection': lambda: socket.create_connection(('192.0.2.1', 443)),
                'urlopen': lambda: urllib.request.urlopen('https://192.0.2.1/'),
                'subprocess.run': lambda: subprocess.run(['true']), 'open(w)': lambda: open(target, 'w'),
                'os.open(O_CREAT)': lambda: os.open(target, os.O_RDONLY | os.O_CREAT),
                'Path.mkdir': lambda: Path(target).mkdir(),
                # Harmless even unguarded: signal 0, a bad descriptor, a missing path.
                'os.kill': lambda: os.kill(os.getpid(), 0), 'os.killpg': lambda: os.killpg(os.getpgrp(), 0),
                'os.write': lambda: os.write(-1, b''), 'os.utime': lambda: os.utime(target),
                'Path.replace': lambda: Path(target).replace(target + '.moved'),
            }
            if hasattr(os, 'popen'):
                attempts['os.popen'] = lambda: os.popen('true')
            if hasattr(os, 'dup2'):
                attempts['os.dup2'] = lambda: os.dup2(-1, -1)
            if hasattr(os, 'setuid'):
                attempts['os.setuid'] = lambda: os.setuid(os.getuid())
            attempts['os.putenv'] = lambda: os.putenv('CF_GUARD_TEST', '1')
            attempts['os.environ'] = lambda: os.environ.__setitem__('CF_GUARD_TEST', '1')
            attempts['Path.open(w)'] = lambda: Path(target).open('w')
            attempts['os.fdopen(w)'] = lambda: os.fdopen(-1, 'w')
            for name in ('copy', 'move'):
                if hasattr(Path, name):  # Python 3.14+
                    attempts['Path.' + name] = lambda name=name: getattr(Path(tmp), name)(target)
            with self.assertRaisesRegex(AssertionError, 'forbidden host effects attempted'):
                with no_host_effects() as recorded:
                    # Nothing real may run: refuse to attempt anything unless
                    # every forbidden target is replaced by the tripwire.
                    unguarded = [module.__name__ + '.' + name for module, name in forbidden_targets()
                                 if not isinstance(getattr(module, name), mock.Mock)]
                    self.assertEqual(unguarded, [])
                    for name, attempt in attempts.items():
                        with self.subTest(effect=name), self.assertRaisesRegex(HostEffectAttempt, 'forbidden host effect'):
                            attempt()
                    # A swallowing `except Exception` cannot catch the tripwire.
                    try:
                        os.remove(target)
                    except Exception:
                        self.fail('HostEffectAttempt was caught by except Exception')
                    except HostEffectAttempt:
                        pass
            self.assertEqual(len(recorded), len(attempts) + 1)
            self.assertEqual(list(Path(tmp).iterdir()), [])
        self.assertNotIn('CF_GUARD_TEST', os.environ)

    def test_forbidden_lists_cover_process_credential_environment_and_new_path_apis(self):
        required_os = {'popen', 'dup', 'dup2', 'setuid', 'seteuid', 'setgid', 'setegid', 'setreuid', 'setregid',
                       'setresuid', 'setresgid', 'setgroups', 'initgroups', 'putenv', 'unsetenv', 'nice',
                       'setpriority', 'sched_setaffinity', 'sched_setparam', 'sched_setscheduler'}
        required_path = {'copy', 'copy_into', 'move', 'move_into', 'hardlink_to', 'symlink_to', 'touch', 'chmod',
                         'lchmod', 'rename', 'replace', 'unlink', 'rmdir', 'write_text', 'write_bytes', 'mkdir'}
        self.assertLessEqual(required_os, set(FORBIDDEN_OS))
        self.assertLessEqual(required_path, set(FORBIDDEN_PATH))
        # Every os.set*/os.sched_set* function this interpreter has is listed
        # (descriptor flag setters excepted: they change no host or process state).
        setters = {name for name in dir(os) if name.startswith(('set', 'sched_set'))
                   and name not in ('set_blocking', 'set_inheritable') and callable(getattr(os, name))}
        self.assertLessEqual(setters, set(FORBIDDEN_OS))
        # The installed pathlib's writers are all guarded (3.14 adds copy/move).
        targets = list(forbidden_targets())
        for name in FORBIDDEN_PATH:
            if hasattr(Path, name):
                self.assertIn((Path, name), targets)
        # Path.open and os.fdopen in a write mode reach the checked io.open.
        with self.assertRaisesRegex(AssertionError, 'forbidden host effects attempted: writable open'):
            with no_host_effects():
                for mode in ('w', 'a', 'x', 'r+'):
                    with self.subTest(mode=mode), self.assertRaises(HostEffectAttempt):
                        Path('/nonexistent-cf-guard').open(mode)
                with self.assertRaises(HostEffectAttempt):
                    os.fdopen(-1, 'w')

    def test_guard_reports_attempts_hidden_by_a_base_exception_handler(self):
        with self.assertRaisesRegex(AssertionError, 'forbidden host effects attempted: fork'):
            with no_host_effects():
                try:
                    os.fork()
                except BaseException:
                    pass

    def test_host_actor_and_engine_refuse_before_any_input_or_bundle_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            injected = types.SimpleNamespace(name='injected-host')
            geo = {'cloudfront-geo.conf': '192.0.2.0/24 1;\n'}
            # Positional, keyword, missing and surplus arguments: the refusal
            # never depends on the call shape (no TypeError path).
            shapes = (((), {}), ((['ufw', 'enable'],), {}), ((), {'args': ['ufw', 'enable']}),
                      ((['ufw', 'enable'], 'extra'), {'timeout': 5}), ((config(), geo), {}),
                      ((), {'config': config(), 'files': geo}), ((config(), geo, 'extra'), {'unexpected': True}),
                      ((config(), state, injected), {}), ((config(),), {'state_dir': state, 'host': cf.Host(), 'clock': None}),
                      (({'invalid': 1}, None, None, None, 'extra'), {'other': 1}))
            calls = {'Host.command': lambda *a, **k: cf.Host().command(*a, **k),
                     'Host.write_nginx': lambda *a, **k: cf.Host().write_nginx(*a, **k),
                     'Engine': lambda *a, **k: cf.Engine(*a, **k)}
            with (mock.patch.object(cf, 'validate_config') as validated, mock.patch.object(cf, 'check_path') as checked,
                  mock.patch.object(cf, '_bundle_runtime') as bundle, mock.patch.object(cf, '_bundle_config') as read_config,
                  no_host_effects()):
                for label, call in calls.items():
                    for args, kwargs in shapes:
                        with self.subTest(call=label, args=len(args), kwargs=sorted(kwargs)):
                            with self.assertRaises(cf.SyncError) as caught:
                                call(*args, **kwargs)
                            self.assertEqual(str(caught.exception), 'runtime_actor_not_connected')
                            self.assertIsNone(caught.exception.__context__)
            for spy in (validated, checked, bundle, read_config):
                spy.assert_not_called()
            self.assertFalse(state.exists())

    # Every definition outside the fixed bundle entry stub, by reachability.
    # Reached from main(): read path (verify-cohort/inspect-state/inspect-runtime)
    # and the lock/config gate it runs first.
    RETAINED_REACHABLE = frozenset({'CONFIG', 'LOCK', 'READ_ONLY_COMMANDS', 'REFUSED_COMMANDS', 'GLOBAL_OPTIONS',
                                    'HELP_OPTIONS', 'lock_fd_number', 'SyncError', 'canonical', 'snapshot_config_hash', 'safe_path',
                                    'validate_config', 'check_path', 'exclusive_lock', 'ArgumentRejected',
                                    'FixedErrorParser', 'build_parser', 'main'})
    # Kept unreachable on purpose: explicit refusal points C4 replaces.
    RETAINED_REFUSAL_POINTS = frozenset({'Host', 'Engine'})

    def test_removed_actor_surface_stays_removed(self):
        tree = ast.parse(MODULE_PATH.read_text())
        stub_end = next(i for i, line in enumerate(MODULE_PATH.read_text().splitlines(), 1)
                        if line == '# END FIXED BUNDLE ENTRY STUB')
        defined = {name for name, node in module_definitions(tree) if node.lineno > stub_end}
        self.assertEqual(defined, self.RETAINED_REACHABLE | self.RETAINED_REFUSAL_POINTS)
        reached = set(reachable_from_main(tree))
        self.assertTrue(self.RETAINED_REACHABLE <= reached)
        self.assertFalse(self.RETAINED_REFUSAL_POINTS & reached)
        self.assertEqual({name for name in vars(cf.Host) if not name.startswith('__')}, {'command', 'write_nginx'})
        self.assertEqual({name for name in vars(cf.Engine) if not name.startswith('__')}, set())

    def test_no_statement_follows_a_refusal_or_return(self):
        """Deleting one raise/return must never revive dead actor code."""
        tree = ast.parse(MODULE_PATH.read_text())
        dead = []
        for node in ast.walk(tree):
            for field in ('body', 'orelse', 'finalbody'):
                block = getattr(node, field, None)
                if isinstance(block, list):
                    dead.extend(statement.lineno for statement, following in zip(block, block[1:])
                                if isinstance(statement, (ast.Raise, ast.Return, ast.Continue, ast.Break)))
        self.assertEqual(dead, [])

    def test_cli_module_never_imports_subprocess(self):
        tree = ast.parse(MODULE_PATH.read_text())
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or '').split('.')[0])
        self.assertNotIn('subprocess', imported)
        # No dynamic import either (__import__/importlib with the name as data).
        self.assertFalse([n.lineno for n in ast.walk(tree) if isinstance(n, ast.Constant) and n.value == 'subprocess'])

    def test_code_reachable_from_main_references_no_host_effect_api(self):
        """Static complement of no_host_effects(): covers branches the CLI tests do not execute."""
        reached = reachable_from_main(ast.parse(MODULE_PATH.read_text()))
        # The actor refusal points and the AWS fetcher are not reachable at all.
        self.assertFalse({'Host', 'Engine'} & set(reached))
        self.assertEqual(host_effect_references(reached), [])

    def test_static_host_effect_scan_flags_new_apis_and_path_replace(self):
        """Self-test of the static scan, including str.replace vs Path.replace."""
        def scan(source):
            tree = ast.parse(textwrap.dedent(source))
            return [row[2] for row in host_effect_references({node.name: node for node in tree.body})]
        self.assertEqual(scan("def f(text):\n    return text.replace('a', 'b')\n"), [])
        for call in ('os.kill(pid, 15)', 'os.killpg(pgid, 15)', 'os.utime(path)', 'os.write(fd, data)',
                     'os.writev(fd, parts)', 'os.pwrite(fd, data, 0)', 'os.setxattr(path, k, v)',
                     'os.removexattr(path, k)', 'os.sendfile(a, b, 0, 1)', 'os.copy_file_range(a, b, 1)',
                     '_bg_os.kill(pid, 9)', 'Path(path).replace(target)', 'path.replace(target)',
                     'mover = path.replace', 'Path(path).rename(target)', 'subprocess.run(argv)',
                     'os.popen(command)', 'os.dup2(a, b)', 'os.setuid(0)', 'os.setresgid(0, 0, 0)',
                     'os.putenv(k, v)', 'os.unsetenv(k)', 'os.nice(1)', 'os.sched_setaffinity(0, cpus)',
                     'Path(path).copy(target)', 'path.copy_into(directory)', 'path.move(target)',
                     'path.move_into(directory)', 'path.hardlink_to(target)', 'path.touch()'):
            with self.subTest(call=call):
                self.assertNotEqual(scan('def f():\n    ' + call + '\n'), [])

    def test_code_reachable_from_main_opens_only_read_only(self):
        """os.open is a host effect too: only the verify-cohort lock may create/write."""
        reached = reachable_from_main(ast.parse(MODULE_PATH.read_text()))
        calls = os_open_calls(reached)
        self.assertIn(ALLOWED_WRITABLE_OPENS[0], calls)
        self.assertIn(('exclusive_lock', frozenset({'O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK'})), calls)
        self.assertEqual(unexpected_opens(reached), [])

    def test_open_analyzer_rejects_writable_unknown_and_duplicate_opens(self):
        """Self-test of the static open check on synthetic definitions."""
        def analyze(source):
            tree = ast.parse(textwrap.dedent(source))
            return unexpected_opens({node.name: node for node in tree.body})
        lock = """
            def exclusive_lock():
                os.open(LOCK, os.O_RDWR|os.O_NOFOLLOW|os.O_CREAT, 0o600)
            """
        self.assertEqual(analyze(lock + """
            def reader():
                _bg_os.open(name, _bg_os.O_RDONLY|_bg_os.O_NOFOLLOW|getattr(_bg_os,'O_NOATIME',0), dir_fd=fd)
            """), [])
        for bad in ("os.open(path, os.O_WRONLY|os.O_TRUNC)", "os.open(path, os.O_RDONLY|os.O_CREAT)",
                    "_bg_os.open(path, flags=_bg_os.O_APPEND)", "os.open(path, flags)", "os.open(path)",
                    "os.open(path, os.O_RDONLY|getattr(os,'O_TRUNC',0))", "open(path, 'r')",
                    "Path(path).open()", "os.fdopen(fd, 'w')"):
            with self.subTest(call=bad):
                self.assertNotEqual(analyze(lock + "\n            def other():\n                " + bad + "\n"), [])
        # The allowlisted lock open itself must exist exactly once, unchanged.
        self.assertNotEqual(analyze(lock.replace('|os.O_CREAT', '|os.O_CREAT|os.O_TRUNC')), [])
        self.assertNotEqual(analyze(lock + lock.replace('exclusive_lock', 'second_lock')), [])
        self.assertNotEqual(analyze("def nothing():\n    pass\n"), [])


SECRET = 'cf-argv-secret-0123456789'


class ArgvContractTests(unittest.TestCase):
    """Refusal, unknown commands and argv errors print one fixed code and never echo argv."""

    def run_main(self, argv, euid=None):
        output, error = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            spies = {name: stack.enter_context(mock.patch.object(cf, name, wraps=getattr(cf, name)))
                     for name in ('build_parser', 'exclusive_lock', 'check_path', '_bundle_runtime',
                                  '_bundle_config', 'validate_config')}
            parse = stack.enter_context(mock.patch.object(cf.argparse.ArgumentParser, 'parse_args',
                                                          autospec=True, side_effect=cf.argparse.ArgumentParser.parse_args))
            geteuid = stack.enter_context(mock.patch.object(cf.os, 'geteuid', return_value=0 if euid is None else euid))
            for context in (no_host_effects(), contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                stack.enter_context(context)
            code = cf.main(argv)
        calls = {name: spy.call_count for name, spy in spies.items()}
        calls['parse_args'], calls['geteuid'] = parse.call_count, geteuid.call_count
        return code, output.getvalue(), error.getvalue(), calls

    def refused_argvs(self):
        for command, required in REFUSED_COMMANDS.items():
            required = [arg.replace('private-token', SECRET) for arg in required]
            yield [command, *required]
            yield [command]                                     # required option missing
            yield [command, *required, '--unknown=' + SECRET, SECRET]  # surplus secret arguments
            yield [command, '--approve', SECRET, '--legacy-state=' + SECRET]
            yield ['--config', '/root/' + SECRET, '--lock-fd=' + SECRET, command, *required]  # global options first
            # -h/--help never turn a refusal into usage: the refusal wins.
            yield ['--config=' + SECRET, command, '--help']
            yield ['-h', command, *required]
            yield [command, '-h']
            yield ['--help', '--lock-fd', SECRET, command, SECRET]
            yield ['--lock-fd', SECRET, '-h', command]
            # Anywhere, not only as the subcommand: after a read-only command,
            # after unknown tokens or '--', and as an option value.
            yield ['verify-cohort', command]
            yield ['inspect-state', '--config', command]
            yield [SECRET, '--x=' + SECRET, command, 'inspect-runtime']
            yield ['--', command]
            yield ['--lock-fd', command]
            yield ['--config', command, 'verify-cohort']

    def test_refused_commands_are_never_parsed_in_any_argv_shape(self):
        for argv in self.refused_argvs():
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv)
                self.assertEqual((code, output, error), (1, '', '{"error":"runtime_actor_not_connected"}\n'))
                self.assertEqual(calls, dict.fromkeys(calls, 0))

    def test_a_refused_name_inside_an_equals_option_is_left_to_argparse(self):
        """Only whole tokens refuse; ``--config=apply`` is an option value that argparse handles."""
        for argv, expected in ((['--config=apply'], (2, 'unknown_command')),
                               (['--config=plan', 'verify-cohort'], (1, 'sync_failed')),
                               (['verify-cohort', '--approve=apply'], (2, 'invalid_arguments'))):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv, euid=501)
                self.assertEqual((code, output, error), (expected[0], '', canonical_error(expected[1])))
                self.assertEqual(calls['exclusive_lock'], 0)

    def test_argparse_alone_selects_the_read_only_command(self):
        """A read-only name as an option value is the value; the parsed subcommand runs."""
        for argv in (['--config', 'verify-cohort', 'inspect-state'], ['--config=inspect-runtime', 'verify-cohort']):
            with self.subTest(argv=argv):
                parsed = cf.build_parser().parse_args(argv)
                self.assertEqual(parsed.command, argv[-1])
                code, output, error, calls = self.run_main(argv, euid=501)
                self.assertEqual((code, output, error), (1, '', canonical_error('sync_failed')))
                self.assertEqual((calls['parse_args'], calls['geteuid']), (1, 1))

    def test_unknown_or_missing_commands_print_a_fixed_code_without_parsing(self):
        for argv in ([], [SECRET], ['bogus', '--approve=' + SECRET], ['--bogus=' + SECRET, 'Plan'],
                     ['--config'], ['--config=' + SECRET], ['--lock-fd', SECRET], ['--', 'bogus'],
                     ['Plan'], ['inspect'], ['-x', SECRET], ['--config=apply'], ['verify-cohort=1'],
                     # -h/--help not alone, without a read-only command token.
                     ['-h', 'bogus'], ['-h', '-h'], ['--help', '--help'], ['-h', SECRET], ['-hh'],
                     ['--help=' + SECRET], ['-h', '--', 'bogus'], ['--he']):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv)
                self.assertEqual((code, output, error), (2, '', '{"error":"unknown_command"}\n'))
                self.assertEqual(calls, dict.fromkeys(calls, 0))

    def test_read_command_argument_errors_print_a_fixed_code_before_root_check(self):
        for argv in (['inspect-state', '--x=' + SECRET], ['verify-cohort', SECRET],
                     ['inspect-runtime', '--config', SECRET], ['--lock-fd=' + SECRET, 'verify-cohort'],
                     ['--lock-fd', SECRET, 'inspect-state'], ['--config', '--lock-fd', 'inspect-state'],
                     ['inspect-state', '--approve=' + SECRET], ['verify-cohort', 'inspect-state'],
                     ['--conf', SECRET, 'inspect-state'],
                     # A global option without its value takes the subcommand
                     # token as its value: the subcommand is then missing.
                     ['--lock-fd', 'verify-cohort'], ['--config', 'inspect-state'],
                     # -h/--help with a read-only command is an argument error, not usage.
                     ['verify-cohort', '-h'], ['-h', 'verify-cohort'], ['--help', 'inspect-state'],
                     ['inspect-runtime', '--help'], ['--config=' + SECRET, '--help', 'inspect-runtime'],
                     ['verify-cohort', SECRET, '-h'], ['--config', '-h', 'verify-cohort'],
                     ['verify-cohort', '-hh'], ['verify-cohort', '--he'],
                     # --lock-fd must be a non-negative decimal integer.
                     ['--lock-fd=-1', 'inspect-state'], ['--lock-fd', '-1', 'verify-cohort'],
                     ['--lock-fd=-3', 'inspect-runtime'], ['--lock-fd=1.5', 'inspect-state'],
                     ['--lock-fd=', 'verify-cohort'], ['--lock-fd=+3', 'inspect-state'],
                     ['--lock-fd= 3', 'inspect-state'], ['--lock-fd=0x3', 'verify-cohort'],
                     # ... of at most 10 digits.
                     ['--lock-fd=' + '1' * 11, 'inspect-state'], ['--lock-fd', '0' * 11, 'verify-cohort'],
                     ['--lock-fd=' + '7' * 4301, 'inspect-runtime']):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv)
                self.assertEqual((code, output, error), (2, '', '{"error":"invalid_arguments"}\n'))
                self.assertEqual(calls['geteuid'], 0)
                for name in ('exclusive_lock', 'check_path', '_bundle_runtime', '_bundle_config', 'validate_config'):
                    self.assertEqual(calls[name], 0, name)

    def test_valid_read_command_argv_shapes_reach_the_root_check(self):
        for argv in (['inspect-state'], ['--config', str(cf.CONFIG), 'verify-cohort'],
                     ['--config=' + str(cf.CONFIG), '--lock-fd', '3', 'inspect-runtime'], ['--lock-fd=0', 'inspect-state'],
                     ['--lock-fd', '007', 'verify-cohort'], ['--lock-fd', '9' * 10, 'inspect-state']):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv, euid=501)
                self.assertEqual((code, output, error), (1, '', '{"error":"sync_failed"}\n'))
                self.assertEqual(calls['parse_args'], 1)
                self.assertEqual(calls['geteuid'], 1)
                self.assertEqual(calls['exclusive_lock'], 0)

    def test_lock_fd_parses_only_non_negative_decimal_integers(self):
        parser = cf.build_parser()
        for value, expected in (('0', 0), ('3', 3), ('007', 7), ('4096', 4096), ('9' * 10, 9999999999),
                                ('0' * 10, 0), ('0' * 9 + '5', 5)):
            with self.subTest(value=value):
                self.assertEqual(parser.parse_args(['--lock-fd', value, 'inspect-state']).lock_fd, expected)
        # At most 10 digits: longer values (with leading zeros, too, and far
        # past int()'s 4300-digit string limit) are rejected by their length.
        for value in ('-1', '-0', '+3', '1.5', '', ' 3', '3 ', '0x3', '1_0', '\u0663', SECRET,
                      '1' * 11, '0' * 11, '0' * 10 + '1', '9' * 4300, '1' * 4301, '0' * 5000):
            with self.subTest(value=value), self.assertRaises(cf.ArgumentRejected):
                parser.parse_args(['--lock-fd=' + value, 'inspect-state'])
        self.assertIsNone(parser.parse_args(['inspect-state']).lock_fd)

    def test_a_non_negative_lock_fd_that_is_not_the_held_lock_is_sync_failed(self):
        """0 or more parses; a descriptor that is not open, or not the lock file, fails at run time (exit 1)."""
        with tempfile.TemporaryDirectory() as tmp:
            lock, other = Path(tmp) / 'lock', Path(tmp) / 'other'
            for path in (lock, other):
                path.write_bytes(b''); path.chmod(0o600)
            real_fstat, real_lstat = os.fstat, cf.Path.lstat
            # Tests run unprivileged: present the files as root-owned only.
            def as_root(st):
                return mock.Mock(st_mode=st.st_mode, st_uid=0, st_dev=st.st_dev, st_ino=st.st_ino, st_nlink=st.st_nlink)
            lock_fd, other_fd = os.open(lock, os.O_RDWR), os.open(other, os.O_RDONLY)
            closed = os.open(other, os.O_RDONLY); os.close(closed)  # a free descriptor number
            try:
                for fd, reaches_bundle in ((closed, False), (other_fd, False), (lock_fd, True)):
                    for command in ('verify-cohort', 'inspect-state', 'inspect-runtime'):
                        with self.subTest(fd=('closed', 'other', 'lock')[(closed, other_fd, lock_fd).index(fd)], command=command):
                            output, error = io.StringIO(), io.StringIO()
                            with (mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf, 'check_path'),
                                  mock.patch.object(cf.os, 'geteuid', return_value=0),
                                  mock.patch.object(cf.os, 'fstat', side_effect=lambda f: as_root(real_fstat(f))),
                                  mock.patch.object(cf.Path, 'lstat', lambda p: as_root(real_lstat(p))),
                                  mock.patch.object(cf, '_bundle_runtime', side_effect=cf.BundleEntryError('stop')) as bundle,
                                  contextlib.redirect_stdout(output), contextlib.redirect_stderr(error)):
                                code = cf.main(['--lock-fd', str(fd), command])
                            self.assertEqual((code, output.getvalue(), error.getvalue()), (1, '', canonical_error('sync_failed')))
                            self.assertEqual(bundle.call_count, 1 if reaches_bundle else 0)
            finally:
                os.close(lock_fd); os.close(other_fd)

    def test_help_only_for_a_sole_help_token_and_lists_every_command(self):
        for argv in (['--help'], ['-h']):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv)
                self.assertEqual((code, error), (0, ''))
                # Exactly the parser's usage text: nothing else (no argv) is printed.
                self.assertEqual(output, cf.build_parser().format_help())
                # The S0 verifier's own usage parser discovers every command,
                # while no refused command's (removed) options are shown.
                self.assertEqual(s0_verifier()[0].parse_subcommands(output), READ_ONLY_COMMANDS | frozenset(REFUSED_COMMANDS))
                for option in ('--approve', '--legacy-state'):
                    self.assertNotIn(option, output)
                self.assertEqual(calls['parse_args'], 0)
                self.assertEqual(calls['geteuid'], 0)
        # Anything else with -h/--help is never usage (exit 0).
        for argv in (['--config=' + SECRET, '--help'], ['--lock-fd', SECRET, '-h'], ['-h', '-h'],
                     ['verify-cohort', '-h'], ['-h', 'plan']):
            with self.subTest(argv=argv):
                code, output, error, calls = self.run_main(argv)
                self.assertNotEqual(code, 0)
                self.assertEqual(output, '')
                self.assertNotIn(SECRET, error)

    def test_help_text_and_readme_state_the_same_outcome_table(self):
        """The module docstring (printed by --help) lists the README table's cases, in order.

        Same exit codes and codes in the same (first match decides) order,
        the same parenthesized case details and the same -h/--help clauses;
        each case is then checked against main() with a representative argv.
        """
        readme = (MODULE_PATH.parents[1] / 'README.md').read_text()
        rows = re.findall(r'^\| (.+?) \| ([0-9]) \| `\{"error":"([a-z_]+)"\}` \|$', readme, re.MULTILINE)
        doc = ' '.join(cf.__doc__.split())
        clauses = re.findall(r'exit ([0-9]) ([a-z_]+): (.*?)(?= exit [0-9] [a-z_]+:| Production has )', doc)
        self.assertEqual([(int(rc), code) for _, rc, code in rows], [(int(rc), code) for rc, code, _ in clauses])
        self.assertEqual([code for _, _, code in rows],
                         ['runtime_actor_not_connected', 'unknown_command', 'invalid_arguments', 'sync_failed'])
        self.assertIn('Usage is printed (exit 0) only when the whole argv is -h or --help.', doc)
        self.assertIn('Usage is printed (exit 0) only when the whole argv is `-h` or `--help`.',
                      ' '.join(readme.split()))
        for (case, _, code), (_, _, clause) in zip(rows, clauses):
            with self.subTest(code=code):
                case = case.replace('`', '')
                self.assertEqual(re.findall(r'\(([^)]*)\)', case), re.findall(r'\(([^)]*)\)', clause))
                for phrase in ('-h/--help', 'unless it is the whole argv'):
                    self.assertEqual(phrase in case, phrase in clause, phrase)
        # --lock-fd: only its syntax is an argument error; an fd that parses
        # but is not the open lock file fails at run time.
        lock_fd_phrases = {'invalid_arguments': '--lock-fd not a non-negative decimal integer of at most 10 digits',
                           'sync_failed': '--lock-fd not an open descriptor of the lock file'}
        for (case, _, code), (_, _, clause) in zip(rows, clauses):
            with self.subTest(code=code, lock_fd=True):
                case = case.replace('`', '')
                self.assertEqual('--lock-fd' in clause, code in lock_fd_phrases)
                self.assertEqual('--lock-fd' in case, code in lock_fd_phrases)
                if code in lock_fd_phrases:
                    self.assertIn(lock_fd_phrases[code], clause)
                    self.assertIn(lock_fd_phrases[code], case)
        # The help text states what main() does.
        examples = {'runtime_actor_not_connected': (['plan', '-h'], ['-h', 'plan'], ['--help', 'apply', SECRET]),
                    'unknown_command': (['-h', SECRET], ['--help', '-h'], ['bogus', '--help'], []),
                    'invalid_arguments': (['verify-cohort', '-h'], ['--help', 'inspect-state'],
                                          ['inspect-runtime', '--x=' + SECRET], ['--lock-fd=-1', 'inspect-state'],
                                          ['--lock-fd', SECRET, 'verify-cohort'], ['--lock-fd=' + '1' * 11, 'inspect-state']),
                    'sync_failed': (['verify-cohort'], ['--lock-fd=0', 'inspect-state'])}
        for (rc, code, _) in clauses:
            for argv in examples[code]:
                with self.subTest(code=code, argv=argv):
                    exit_code, output, error, _ = self.run_main(argv, euid=501)
                    self.assertEqual((exit_code, output, error), (int(rc), '', canonical_error(code)))

    def test_main_returns_for_every_argv_shape_and_never_exits(self):
        """No parser has a help action and every argparse error raises ArgumentRejected."""
        pool = ('-h', '--help', '-hh', '--he', '--help=x', '--config', '--config=' + SECRET, '--lock-fd',
                '--lock-fd=3', '--lock-fd=' + SECRET, 'verify-cohort', 'inspect-state', 'plan', 'apply',
                'bogus', '--', '-', '--approve=' + SECRET, SECRET)
        fixed = {'{"error":"%s"}\n' % code for code in ('runtime_actor_not_connected', 'unknown_command',
                                                         'invalid_arguments', 'sync_failed')}
        shapes = [()] + [(a,) for a in pool] + [(a, b) for a in pool for b in pool] \
            + [(a, b, c) for a in pool for b in pool for c in pool[::3]]
        with (mock.patch.object(cf.os, 'geteuid', return_value=501), no_host_effects()):
            for argv in shapes:
                output, error = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                    try:
                        code = cf.main(list(argv))
                    except SystemExit:
                        self.fail('main() exited for %r' % (argv,))
                if list(argv) in (['-h'], ['--help']):
                    self.assertEqual((code, error.getvalue()), (0, ''))
                    continue
                with self.subTest(argv=argv):
                    self.assertIn(code, (1, 2))
                    self.assertEqual(output.getvalue(), '')
                    self.assertIn(error.getvalue(), fixed)

    def test_no_parser_has_a_help_action_and_refused_subparsers_define_no_options(self):
        parser = cf.build_parser()
        subparsers = [a for a in parser._actions if isinstance(a, cf.argparse._SubParsersAction)][0]
        for name, sub in [('', parser), *subparsers.choices.items()]:
            with self.subTest(parser=name):
                self.assertFalse(sub.add_help)
                self.assertFalse([a for a in sub._actions if isinstance(a, cf.argparse._HelpAction)])
                if name:
                    # No subcommand defines an option: required options of the
                    # refused commands (--approve, --legacy-state) are gone.
                    self.assertEqual([a.option_strings for a in sub._actions if a.option_strings], [])
        self.assertEqual(set(subparsers.choices), cf.READ_ONLY_COMMANDS | cf.REFUSED_COMMANDS)

    def test_the_parser_has_exactly_the_fixed_global_options(self):
        """No option beyond GLOBAL_OPTIONS; each stores exactly one value."""
        options = [a for a in cf.build_parser()._actions if a.option_strings]
        self.assertEqual([s for a in options for s in a.option_strings], [name for name, _ in cf.GLOBAL_OPTIONS])
        self.assertEqual([name for name, _ in cf.GLOBAL_OPTIONS], ['--config', '--lock-fd'])
        for action in options:
            with self.subTest(option=action.option_strings):
                self.assertIsNone(action.nargs)
                self.assertIsInstance(action, cf.argparse._StoreAction)

    def test_every_parser_and_subparser_reports_errors_only_by_exception(self):
        parser = cf.build_parser()
        subparsers = [a for a in parser._actions if isinstance(a, cf.argparse._SubParsersAction)][0]
        self.assertFalse(parser.allow_abbrev)
        for name, sub in [('', parser), *subparsers.choices.items()]:
            with self.subTest(parser=name):
                self.assertIsInstance(sub, cf.FixedErrorParser)
                self.assertFalse(sub.allow_abbrev)
                error = io.StringIO()
                with contextlib.redirect_stderr(error), self.assertRaises(cf.ArgumentRejected) as caught:
                    sub.error('unrecognized arguments: ' + SECRET)
                self.assertEqual(error.getvalue(), '')
                self.assertEqual(caught.exception.args, ())

    def test_real_cli_process_never_echoes_argv(self):
        # Every case returns before the root check, so nothing on this host is read or changed.
        cases = [(argv, 1, 'runtime_actor_not_connected') for argv in (['sync', '--approve=' + SECRET], ['apply'],
                                                                         ['import-plan'], ['--config', SECRET, 'import'])]
        cases += [(['bogus', SECRET], 2, 'unknown_command'), (['inspect-state', '--x=' + SECRET], 2, 'invalid_arguments'),
                  (['--lock-fd=' + SECRET, 'verify-cohort'], 2, 'invalid_arguments'),
                  (['verify-cohort', '-h'], 2, 'invalid_arguments'), (['plan', '--help', SECRET], 1, 'runtime_actor_not_connected'),
                  (['-h', SECRET], 2, 'unknown_command')]
        for argv, rc, code in cases:
            with self.subTest(argv=argv):
                done = subprocess.run([sys.executable, '-I', '-B', str(MODULE_PATH), *argv],
                                      capture_output=True, text=True, timeout=30)
                self.assertEqual((done.returncode, done.stdout, done.stderr), (rc, '', canonical_error(code)))


def canonical_error(code):
    return json.dumps({'error': code}, separators=(',', ':')) + '\n'


S0_VERIFIER_PATH = Path(__file__).resolve().parents[4] / 'molecule/cloudfront_sync/s0_refusal_verify.py'


def load_s0_verifier(path=S0_VERIFIER_PATH):
    """Load the molecule S0 verifier by path (its parse_subcommands is used above).

    Returns the module and every process-level side effect its import
    attempted. The import must not run main(), exit, install a signal handler
    or change the signal mask; the calls are recorded (and not performed).
    """
    attempted = []
    def record(name):
        return lambda *args, **kwargs: attempted.append(name)
    handler, mask = signal.getsignal(signal.SIGTERM), signal.pthread_sigmask(signal.SIG_BLOCK, [])
    spec = importlib.util.spec_from_file_location('cloudfront_sync_s0_verifier', path)
    module = importlib.util.module_from_spec(spec)
    with (mock.patch.object(signal, 'signal', side_effect=record('signal.signal')),
          mock.patch.object(signal, 'pthread_sigmask', side_effect=record('signal.pthread_sigmask')),
          mock.patch.object(signal, 'sigwait', side_effect=record('signal.sigwait')),
          mock.patch.object(sys, 'exit', side_effect=record('sys.exit'))):
        spec.loader.exec_module(module)
    if signal.getsignal(signal.SIGTERM) is not handler:
        attempted.append('SIGTERM handler changed')
    if signal.pthread_sigmask(signal.SIG_BLOCK, []) != mask:
        attempted.append('signal mask changed')
    return module, attempted


@functools.cache
def s0_verifier():
    """(module, import effects), loaded on first use rather than at import.

    A broken verifier then fails only the tests that use it, never the import
    of this whole role test module.
    """
    return load_s0_verifier()


class S0VerifierLoadTests(unittest.TestCase):
    def test_loading_the_verifier_has_no_process_side_effects(self):
        verifier, effects = s0_verifier()
        self.assertEqual(effects, [])
        self.assertNotEqual(verifier.__name__, '__main__')
        self.assertTrue(callable(verifier.parse_subcommands))

    def test_the_verifier_is_not_loaded_when_this_module_is_imported(self):
        source = Path(__file__).read_text()
        tree = ast.parse(source)
        module_level_calls = [node.value.func.id for node in tree.body
                              if isinstance(node, (ast.Assign, ast.Expr)) and isinstance(node.value, ast.Call)
                              and isinstance(node.value.func, ast.Name)]
        self.assertNotIn('load_s0_verifier', module_level_calls)
        self.assertNotIn('s0_verifier', module_level_calls)
        # A verifier that cannot even be imported fails its load, not this module.
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / 'broken.py'
            broken.write_text('raise ImportError("broken verifier")\n')
            self.assertRaises(ImportError, load_s0_verifier, broken)

    def test_the_side_effect_probe_detects_handler_mask_and_exit_at_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            for line in ('import signal\nsignal.signal(signal.SIGTERM, lambda *a: None)\n',
                         'import signal\nsignal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})\n',
                         'import sys\nsys.exit(0)\n'):
                with self.subTest(source=line):
                    path = Path(tmp) / 'probe.py'
                    path.write_text(line)
                    self.assertNotEqual(load_s0_verifier(path)[1], [])


class SnapshotConfigHashTests(unittest.TestCase):
    """inspect-runtime's config_hash is the one the ledger records and checks.

    Main check: for realistic configs that pass validate_config (ASCII only:
    validate_config first rejects any non-ASCII string, key or value, lone
    surrogates included, and its address, path and unit checks accept
    nothing else either; ConfigTests covers that), the hash
    snapshot_config_hash computes is accepted by the real bundle module's
    _ledger_basic_p, and a wrong or another config's hash is not.
    """

    CODE = textwrap.dedent('''
        import copy, hashlib, importlib.util, json, sys, types
        from pathlib import Path
        files = Path(sys.argv[1])
        for name in ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel',
                     'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot'):
            module = types.ModuleType(name); module.__file__ = str(files / (name + '.py')); sys.modules[name] = module
            exec(compile((files / (name + '.py')).read_bytes(), module.__file__, 'exec'), module.__dict__)
        m = sys.modules['cloudfront_snapshot']
        spec = importlib.util.spec_from_file_location('cli', files / 'cloudfront-sync.py')
        cli = importlib.util.module_from_spec(spec); spec.loader.exec_module(cli)
        def p(config, config_hash):
            backend = config['firewall']['backend']
            return json.dumps({'integrity_format': m.FORMAT, 'backend': backend, 'config_hash': config_hash,
                               'enrollment_id': 'b' * 32, 'profile_id': 'none', 'inventory': None,
                               'owned_rules': [], 'protected_context': None}).encode()
        def ledger(config, config_hash):
            # backend none: P is complete, so acceptance is total. backend ufw:
            # the hash/context check passed when the next check (the protected
            # context, absent in this P) is the one that fails.
            try:
                m._ledger_basic_p(p(config, config_hash), config, 0)
                return 'accepted'
            except m.SnapshotError as error:
                if config['firewall']['backend'] == 'ufw' and str(error) == 'ledger_protected_context':
                    return 'accepted'
                return str(error)
        base = {'host_address': '192.0.2.10', 'firewall': {'backend': 'none', 'ports': [443]},
                'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
                'limits': {'max_changes': 10, 'min_ratio': 0.8}, 'notify_unit': ''}
        def variant(**changes):
            config = copy.deepcopy(base)
            for path, value in changes.items():
                target = config
                *parents, leaf = path.split('__')
                for part in parents:
                    target = target[part]
                target[leaf] = value
            return config
        configs = [base,
                   variant(firewall__backend='ufw', firewall__ports=[443, 8443, 80]),
                   variant(host_address='2001:db8::10', limits__min_ratio=1, limits__max_changes=1000),
                   variant(firewall__backend='ufw', nginx__enabled=True, notify_unit='cloudfront-reload@web-01.service',
                           nginx__shared_dir='/etc/common-sv/nginx/cloudfront',
                           nginx__bundles=[{'geo_file': '/etc/nginx/conf.d/cf-geo.conf',
                                            'realip_file': '/etc/nginx/conf.d/cf-realip.conf'},
                                           {'geo_file': '/etc/common-sv/nginx/site_b/geo.conf',
                                            'realip_file': '/etc/common-sv/nginx/site_b/realip.conf'}]),
                   variant(limits__min_ratio=0.05, firewall__ports=[65535, 1])]
        rows = []
        for config in configs:
            cli.validate_config(config)
            own = cli.snapshot_config_hash(m, config)
            others = [cli.snapshot_config_hash(m, other) for other in configs if other is not config]
            rows.append({'cli': ledger(config, own), 'zero': ledger(config, '0' * 64),
                         'other_configs': sorted({ledger(config, digest) for digest in others}),
                         'distinct': own not in others})
        # Discriminator only. validate_config rejects every non-ASCII string
        # (its explicit ASCII check, before any field check), so
        # a valid config never tells the bundle's UTF-8 canonical form from an
        # ensure_ascii re-implementation; this config bypasses validate_config
        # to show the CLI uses the bundle's form. Its premise is checked too.
        wide = variant(notify_unit='\\u00e9.service')
        try:
            cli.validate_config(wide)
            wide_rejected = False
        except cli.SyncError:
            wide_rejected = True
        ascii_digest = lambda c: hashlib.sha256(json.dumps(c, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        print(json.dumps({'valid': rows, 'wide_rejected_by_validate_config': wide_rejected,
                          'wide_cli': ledger(wide, cli.snapshot_config_hash(m, wide)),
                          'wide_ascii_reimplementation': ledger(wide, ascii_digest(wide))}))
    ''')

    def run_code(self):
        done = subprocess.run([sys.executable, '-I', '-B', '-c', self.CODE, str(MODULE_PATH.parent)],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_cli_config_hash_is_accepted_by_the_ledger_for_valid_configs(self):
        result = self.run_code()
        self.assertEqual(len(result['valid']), 5)
        for index, row in enumerate(result['valid']):
            with self.subTest(config=index):
                self.assertEqual(row, {'cli': 'accepted', 'zero': 'ledger_p_context',
                                       'other_configs': ['ledger_p_context'], 'distinct': True})

    def test_non_ascii_discriminator_and_its_premise(self):
        result = self.run_code()
        self.assertTrue(result['wide_rejected_by_validate_config'])
        self.assertEqual((result['wide_cli'], result['wide_ascii_reimplementation']), ('accepted', 'ledger_p_context'))


# Every import of the CLI, exactly. Aliased host modules (import os as o,
# from os import open) would hide calls from the name-based scans above.
EXPECTED_IMPORTS = frozenset({
    ('import', 'hashlib', '_bg_hashlib'), ('import', 'json', '_bg_json'), ('import', 'math', '_bg_math'),
    ('import', 'os', '_bg_os'), ('from', 'pathlib.Path', '_BgPath'), ('import', 're', '_bg_re'),
    ('import', 'stat', '_bg_stat'), ('import', 'sys', '_bg_sys'), ('from', 'types.ModuleType', '_BgModule'),
    ('import', 'argparse', None), ('import', 'contextlib', None), ('import', 'fcntl', None),
    ('import', 'ipaddress', None), ('import', 'json', None), ('import', 'math', None),
    ('import', 'os', None), ('from', 'pathlib.Path', None), ('import', 're', None), ('import', 'stat', None),
    ('import', 'sys', None)})
_HOST_MODULE_NAMES = ('os', '_bg_os', 'fcntl')
# exec/compile run only the hash-verified bootstrap bytes in _bundle_verified.
_DYNAMIC_NAMES = ('__import__', 'importlib', 'eval', 'globals', 'locals', 'vars', 'setattr', 'delattr', '__builtins__')


def alias_or_dynamic_access(tree):
    """Spellings that would let a host API escape the name-based scans: (line, reason)."""
    rows = []
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(('import', alias.name, alias.asname) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.update(('from', '%s.%s' % (node.module, alias.name), alias.asname) for alias in node.names)
    rows.extend((0, 'import ' + repr(row)) for row in sorted(imports - EXPECTED_IMPORTS, key=repr))
    called = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    optional_flags = {id(node.args[0]) for node in ast.walk(tree) if _is_optional_flag(node, _OS_MODULES)}
    owners = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
    allowed_exec = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == '_bundle_verified':
            allowed_exec.update(id(item) for item in ast.walk(node))
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in _HOST_MODULE_NAMES:
            # A host function may only be called in place (no f = os.open, no
            # callback); constants such as os.O_RDONLY and fcntl.LOCK_EX are data.
            if id(node) not in called and not node.attr.isupper():
                rows.append((node.lineno, 'uncalled ' + node.value.id + '.' + node.attr))
        elif isinstance(node, ast.Name) and node.id in _HOST_MODULE_NAMES:
            if id(node) not in owners and id(node) not in optional_flags:
                rows.append((node.lineno, 'bare module ' + node.id))
        elif isinstance(node, ast.Name) and node.id in _DYNAMIC_NAMES:
            rows.append((node.lineno, 'dynamic ' + node.id))
        elif isinstance(node, ast.Name) and node.id in ('exec', 'compile') and id(node) not in allowed_exec:
            rows.append((node.lineno, 'dynamic ' + node.id))
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'getattr'
              and not _is_optional_flag(node, _OS_MODULES)):
            rows.append((node.lineno, 'getattr'))
    return rows


class AliasAndDynamicAccessTests(unittest.TestCase):
    def test_cli_has_no_aliased_or_dynamic_host_api_access(self):
        self.assertEqual(alias_or_dynamic_access(ast.parse(MODULE_PATH.read_text())), [])

    def test_alias_checker_rejects_every_known_spelling(self):
        base = MODULE_PATH.read_text()
        for source in ('import os as o\n', 'from os import open as x\n', 'from os import open\n',
                       'import subprocess as s\n', 'f = os.open\n', 'g = _bg_os.kill\n', 'h = getattr(os, "open")\n',
                       'm = os\n', 'call(os)\n', '__import__("os").open("/x", 1)\n', 'eval("os")\n',
                       'exec("pass")\n', 'getattr(os, "O_TRUNC")\n', 'getattr(os, "O_TRUNC", 1)\n',
                       'import importlib\n', 'vars(os)["open"]\n', 'opener = fcntl.flock\n'):
            with self.subTest(source=source):
                self.assertNotEqual(alias_or_dynamic_access(ast.parse(base + '\n' + source)), [])


class ModuleDefinitionTests(unittest.TestCase):
    def test_definitions_in_nested_module_blocks_and_annotations_are_found(self):
        tree = ast.parse(textwrap.dedent("""
            async def a(): pass
            b: int = 1
            c = d = 2
            e, (f, *g) = 1, (2, 3)
            h += 1
            if X:
                def i(): pass
            else:
                class j: pass
            try:
                k = 1
            except Exception:
                def l(): pass
            finally:
                m: str
            with open('x') as n:
                def o(): pass
            for p in ():
                q = 1
            while False:
                r = 1
            def outer():
                inner = 1
            class Holder:
                member = 1
        """))
        self.assertEqual([name for name, _ in module_definitions(tree)],
                         ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
                          'outer', 'Holder'])

    def test_reachability_follows_nested_and_async_definitions(self):
        tree = ast.parse(textwrap.dedent("""
            if X:
                async def helper(): os.kill(1, 9)
            else:
                helper = None
            def main(): helper()
        """))
        reached = reachable_from_main(tree)
        self.assertEqual(set(reached), {'main', 'helper'})
        self.assertNotEqual(host_effect_references(reached), [])


BUNDLE_MODULES = ('bundle_manifest.py', 'bundled_source.py', 'ufw_integrity.py', 'ufw_kernel.py',
                  'ufw_kernel_mapping.py', 'ufw_docker_kernel.py', 'ufw_docker_transition.py',
                  'ufw_observation.py', 'nginx_observation.py', 'cloudfront_snapshot.py')


# Module names whose ``open`` takes os-style flags, and those whose ``open``
# takes a builtin-style mode (``builtins`` is ``open`` itself).
_OS_LIKE_MODULES = frozenset({'os', 'posix', 'nt'})
_IO_LIKE_MODULES = frozenset({'io', '_io', 'builtins'})
# Filesystem/descriptor writers of os/posix/nt. Process APIs are out of scope
# here (ufw_observation runs its fixed read-only commands; see its own tests).
_OS_WRITERS = frozenset({'write', 'writev', 'pwrite', 'pwritev', 'truncate', 'ftruncate', 'unlink', 'remove',
                         'rmdir', 'removedirs', 'rename', 'renames', 'replace', 'mkdir', 'makedirs', 'symlink',
                         'link', 'chmod', 'fchmod', 'lchmod', 'chown', 'fchown', 'lchown', 'utime', 'mkfifo',
                         'mknod', 'posix_fallocate', 'setxattr', 'removexattr', 'copy_file_range', 'sendfile',
                         'splice', 'fdopen'})
# pathlib writers. str.replace(old, new[, count]) has two or more positional
# arguments while Path.replace(target) has one, as in host_effect_references.
_PATH_WRITERS = frozenset({'write_bytes', 'write_text', 'touch', 'mkdir', 'unlink', 'rmdir', 'rename', 'replace',
                           'symlink_to', 'hardlink_to', 'link_to', 'chmod', 'lchmod', 'copy', 'copy_into',
                           'move', 'move_into'})


def _open_mode(call, position):
    """The literal mode of an open-like call: 'r' when omitted, None when not literal."""
    node = call.args[position] if len(call.args) > position else next(
        (k.value for k in call.keywords if k.arg == 'mode'), None)
    if node is None:
        return 'r'
    return node.value if isinstance(node, ast.Constant) and type(node.value) is str else None


def _writable_mode(mode):
    return mode is None or any(flag in mode for flag in 'wax+')


def module_open_problems(tree):
    """Writes or unanalyzable opens in a bundle module, any import spelling: (rows, os aliases).

    Rows name builtin open / io.open / _io.open / builtins.open / Path.open
    in a writable or non-literal mode, os/posix/nt.open with non-read-only or
    non-literal flags, every os/posix/nt filesystem writer (fdopen included),
    pathlib writers, ``from <os/io module> import``, and open-like functions
    taken without a call (``f = os.open``) or through getattr.
    """
    os_aliases, io_aliases, rows = set(), set(), []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in _OS_LIKE_MODULES:
                    os_aliases.add(alias.asname or alias.name)
                elif alias.name in _IO_LIKE_MODULES:
                    io_aliases.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module in _OS_LIKE_MODULES | _IO_LIKE_MODULES:
            rows.append((node.lineno, 'from ' + node.module + ' import'))
    module_aliases = os_aliases | io_aliases
    called = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in module_aliases:
            if node.attr in ('open', 'fdopen') and id(node) not in called:
                rows.append((node.lineno, 'uncalled ' + node.value.id + '.' + node.attr))
            elif node.value.id in os_aliases and node.attr in _OS_WRITERS:
                rows.append((node.lineno, node.value.id + '.' + node.attr))
        elif isinstance(node, ast.Name) and node.id in ('open', '__builtins__') and id(node) not in called:
            rows.append((node.lineno, 'uncalled ' + node.id))
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (isinstance(func, ast.Name) and func.id == 'getattr' and node.args and isinstance(node.args[0], ast.Name)
                and node.args[0].id in module_aliases | {'__builtins__'} and not _is_optional_flag(node, os_aliases)):
            rows.append((node.lineno, 'getattr(' + node.args[0].id + ', ...)'))
        elif isinstance(func, ast.Name) and func.id == 'open':
            if _writable_mode(_open_mode(node, 1)):
                rows.append((node.lineno, 'open mode'))
        elif isinstance(func, ast.Attribute) and func.attr == 'open':
            owner = func.value.id if isinstance(func.value, ast.Name) else None
            if owner in io_aliases:
                if _writable_mode(_open_mode(node, 1)):
                    rows.append((node.lineno, owner + '.open mode'))
            elif owner not in os_aliases and _writable_mode(_open_mode(node, 0)):
                # Any other receiver is treated as Path.open(mode='r', ...).
                rows.append((node.lineno, 'Path.open mode'))
        elif isinstance(func, ast.Attribute) and func.attr in _PATH_WRITERS and not (
                isinstance(func.value, ast.Name) and func.value.id in os_aliases):
            if func.attr == 'replace' and len(node.args) >= 2:
                continue
            rows.append((node.lineno, 'Path.' + func.attr))
    for _, flags in os_open_calls({'module': tree}, frozenset(os_aliases)):
        if flags is None or not flags <= _READ_ONLY_OPEN_FLAGS:
            rows.append((0, 'os.open flags ' + repr(None if flags is None else sorted(flags))))
    return rows, os_aliases


class BundleModuleOpenTests(unittest.TestCase):
    """Read-only check of the helper modules main() loads (the modules are not edited here)."""

    def test_bundle_module_list_matches_the_entry_stub(self):
        self.assertEqual(set(BUNDLE_MODULES), {*(name + '.py' for name in cf._BG_HELPERS), *cf._BG_BOOTS})

    def test_bundle_modules_open_read_only(self):
        opened = 0
        for name in BUNDLE_MODULES:
            with self.subTest(module=name):
                tree = ast.parse((MODULE_PATH.parent / name).read_text())
                rows, aliases = module_open_problems(tree)
                self.assertEqual(rows, [])
                self.assertLessEqual(aliases, {'os'})
                opened += len(os_open_calls({'module': tree}, frozenset(aliases)))
        self.assertGreater(opened, 0)

    def test_module_open_checker_rejects_writable_and_aliased_opens(self):
        bad = (
            # os / posix / nt open flags, aliases and spellings.
            'import os\nos.open(p, os.O_RDWR)\n', 'import os as o\no.open(p, o.O_WRONLY|o.O_CREAT)\n',
            'def f():\n    import os as q\n    q.open(p, flags)\n', 'from os import open\n',
            'import os\nf = os.open\n', 'import os\ngetattr(os, "open")(p, 0)\n',
            'import os\nos.open(p, os.O_RDONLY|getattr(os, "O_TRUNC", 1))\n',
            'import posix\nposix.open(p, posix.O_WRONLY)\n', 'import posix as px\npx.open(p, flags)\n',
            'import nt\nnt.open(p, nt.O_RDWR)\n', 'from posix import open\n', 'import posix\nf = posix.open\n',
            # Descriptor wrappers and os-level writers.
            'import os\nos.fdopen(fd, "w")\n', 'import os\nos.fdopen(fd)\n', 'import os\nos.write(fd, b"x")\n',
            'import posix\nposix.write(fd, b"x")\n', 'import os\nos.replace(a, b)\n', 'import os\nos.unlink(p)\n',
            'import os\nos.ftruncate(fd, 0)\n', 'import os\nos.mkdir(p)\n', 'import os\nos.chmod(p, 0o777)\n',
            # builtin open.
            'open(p, "w")\n', 'open(p, "a")\n', 'open(p, "x")\n', 'open(p, "r+")\n', 'open(p, "wb")\n',
            'open(p, mode="w")\n', 'open(p, mode)\n', 'opener = open\n', '__builtins__.open(p, "w")\n',
            # io / _io / builtins modules.
            'import io\nio.open(p, "w")\n', 'import io as i\ni.open(p, mode="ab")\n', 'import _io\n_io.open(p, "w")\n',
            'import io\nio.open(p, m)\n', 'from io import open\n', 'from _io import open\n', 'import io\nf = io.open\n',
            'import builtins\nbuiltins.open(p, "w")\n', 'import io\ngetattr(io, "open")(p, "w")\n',
            # pathlib.
            'Path(p).open("w")\n', 'path.open(mode="a")\n', 'path.open("r+")\n', 'path.open(m)\n',
            'Path(p).write_bytes(b"x")\n', 'path.write_text("x")\n', 'path.touch()\n', 'path.mkdir()\n',
            'path.unlink()\n', 'path.rmdir()\n', 'path.rename(t)\n', 'path.replace(t)\n', 'path.symlink_to(t)\n',
            'path.hardlink_to(t)\n', 'path.chmod(0o600)\n', 'path.copy(t)\n', 'path.move(t)\n')
        for source in bad:
            with self.subTest(source=source):
                self.assertNotEqual(module_open_problems(ast.parse(source))[0], [])
        good = ('import os\nos.open(p, os.O_RDONLY|os.O_NOFOLLOW|getattr(os, "O_NOATIME", 0), dir_fd=d)\n',
                'open(p)\n', 'open(p, "rb")\n', 'open(p, mode="r")\n', 'import io\nio.open(p, "rb")\n',
                'import _io\n_io.open(p)\n', 'Path(p).open()\n', 'path.open("rb")\n', 'Path(p).read_bytes()\n',
                'path.read_text()\n', 'text.replace("a", "b")\n', 'text.replace("a", "b", 1)\n',
                'import os\nos.read(fd, 1)\nos.fstat(fd)\nos.close(fd)\n', 'import os\nos.path.join(a, b)\n')
        for source in good:
            with self.subTest(source=source):
                self.assertEqual(module_open_problems(ast.parse(source))[0], [])


if __name__ == '__main__':
    unittest.main()
