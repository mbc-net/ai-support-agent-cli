"""Transaction tests use a fake host; real traffic is checked separately."""
import importlib.util
import errno
import json
from pathlib import Path
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
import time
from unittest.mock import patch
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'ansible/roles/haproxy/files/haproxy_setup.py'
spec = importlib.util.spec_from_file_location('haproxy_setup', MODULE)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

PARAMS = {'mode': 'http', 'bind_address': '127.0.0.1', 'bind_port': 8080,
          'backends': [{'name': 'app', 'address': 'localhost', 'port': 9001}]}

class FakeHost(h.Host):
    def __init__(self, root, installed=True, active=True, enabled=True):
        super().__init__(root)
        self.installed, self.active, self.enabled = installed, active, enabled
        self.calls = []
        self.fail_action = None
        self.fail_recovery = False
        self.valid = True
        self.worker = 1
    def worker_pids(self): return {self.worker}
    def package_present(self): return self.installed
    def service_exists(self): return self.installed
    def service_state(self): return {'active': self.active, 'enabled': self.enabled}
    def install(self): self.calls.append('install'); self.installed = True
    def validate_config(self, path):
        self.calls.append('validate')
        if not self.valid: raise RuntimeError('invalid config')
    def service(self, action):
        self.calls.append(action)
        if action == self.fail_action:
            self.fail_action = None
            raise RuntimeError('service failure')
        if self.fail_recovery and action == 'restart': raise RuntimeError('recovery failure')
        if action in ('start', 'restart', 'reload'):
            self.active = True
            self.worker += 1
        if action == 'stop': self.active = False
        if action == 'enable': self.enabled = True
        if action == 'disable': self.enabled = False
    def verify(self, params, previous_workers=None):
        if previous_workers is not None and not self.worker_pids() - previous_workers:
            raise RuntimeError('new worker not started')
        if not self.active: raise RuntimeError('not running')

class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.host = FakeHost(Path(self.tmp.name))
        self.host.config.parent.mkdir(parents=True)
        self.host.config.write_text('old config\n')
    def tearDown(self): self.tmp.cleanup()
    def records(self): return list(self.host.backups.glob('*/state.json'))
    def test_invalid_input_changes_nothing(self):
        for params in [dict(PARAMS, bind_port=True), dict(PARAMS, bind_port=65536),
                       dict(PARAMS, mode='HTTP'), dict(PARAMS, bind_address='::1'),
                       dict(PARAMS, backends=[]),
                       dict(PARAMS, backends=[{'name':'app','address':'localhost\nfoo','port':80}]),
                       dict(PARAMS, backends=PARAMS['backends'] * 2)]:
            with self.assertRaises(ValueError): h.apply(params, self.host)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.records(), [])
    def test_port_owned_by_another_process_is_not_success(self):
        with patch.object(h.Host, 'service_state', return_value={'active': True, 'enabled': True}), \
             patch.object(h.Host, 'owns_listener', return_value=False), \
             patch.object(h.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'listen'):
                h.Host.verify(self.host, PARAMS)
    def test_render_modes_and_dns_ipv4(self):
        for mode in ['http', 'tcp']:
            text = h.render(dict(PARAMS, mode=mode))
            self.assertIn('mode ' + mode, text)
            self.assertIn('server app ipv4@localhost:9001 check', text)
    def test_verify_rejects_the_old_worker_even_when_it_owns_the_port(self):
        with patch.object(h.Host, 'worker_pids', return_value={1}), \
             patch.object(h.Host, 'service_state', return_value={'active': True, 'enabled': True}), \
             patch.object(h.Host, 'owns_listener', return_value=True), \
             patch.object(h.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'listen'):
                h.Host.verify(self.host, PARAMS, {1})
    def test_recovery_timeout_stops_further_recovery_and_keeps_lock(self):
        service = self.host.service
        def fail(action):
            if action == 'reload': raise RuntimeError('reload failure')
            if action == 'restart':
                self.host.process_uncertain = True
                raise subprocess.TimeoutExpired('systemctl', 600)
            raise AssertionError('must not continue recovery after timeout')
        self.host.service = fail
        with self.assertRaisesRegex(RuntimeError, 'manual'):
            h.apply(PARAMS, self.host)
        self.assertTrue(self.host.lock.exists())
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'interrupted')
    def test_package_timeout_retains_policy_for_manual_recovery(self):
        self.host.installed = False
        self.host.active = False
        self.host.enabled = False
        self.host.policy.parent.mkdir(parents=True)
        self.host.policy.write_text('original policy')
        def timeout(*args, **kwargs):
            self.host.process_uncertain = True
            raise subprocess.TimeoutExpired('apt-get', 600)
        self.host.run = timeout
        self.host.install = lambda: h.Host.install(self.host)
        with self.assertRaisesRegex(RuntimeError, 'manual'):
            h.apply(PARAMS, self.host)
        self.assertTrue(self.host.lock.exists())
        self.assertTrue((self.host.lock / 'policy-state.json').exists())
        self.assertEqual((self.host.lock / 'policy-rc.d.original').read_text(), 'original policy')
        self.assertIn('exit 101', self.host.policy.read_text())
    def test_reload_without_a_new_worker_rolls_back(self):
        service = self.host.service
        self.host.service = lambda action: None if action == 'reload' else service(action)
        with self.assertRaisesRegex(RuntimeError, 'new worker'):
            h.apply(PARAMS, self.host)
        self.assertEqual(self.host.config.read_text(), 'old config\n')
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'rolled_back')
    def test_timeout_keeps_lock_and_does_not_start_recovery(self):
        def uncertain(action):
            self.host.process_uncertain = True
            raise subprocess.TimeoutExpired('systemctl', 600)
        self.host.service = uncertain
        with self.assertRaisesRegex(RuntimeError, 'manual'):
            h.apply(PARAMS, self.host)
        self.assertTrue(self.host.lock.exists())
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'interrupted')
    @unittest.skipUnless(sys.platform == 'linux', 'Linux process-group behavior is verified on the Ubuntu target')
    def test_timeout_kills_child_process_group(self):
        marker = Path(self.tmp.name) / 'late-child'
        child_code = "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); import time,pathlib; time.sleep(.6); pathlib.Path(%r).touch()" % str(marker)
        code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',%r],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(5)" % child_code
        with self.assertRaises(subprocess.TimeoutExpired):
            self.host.run([sys.executable, '-c', code], timeout=0.1)
        time.sleep(.7)
        self.assertFalse(marker.exists())
    def test_success_and_idempotence(self):
        self.assertTrue(h.apply(PARAMS, self.host)['changed'])
        self.assertIn('reload', self.host.calls)
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'complete')
        self.host.calls.clear()
        self.assertFalse(h.apply(PARAMS, self.host)['changed'])
        self.assertNotIn('reload', self.host.calls)
        self.assertEqual(len(self.records()), 1)
    def test_validation_failure_preserves_config(self):
        self.host.valid = False
        with self.assertRaisesRegex(RuntimeError, 'invalid config'): h.apply(PARAMS, self.host)
        self.assertEqual(self.host.config.read_text(), 'old config\n')
        self.assertEqual(self.records(), [])
    def test_reload_failure_restores_exact_state(self):
        self.host.enabled = False
        self.host.fail_action = 'reload'
        with self.assertRaisesRegex(RuntimeError, 'service failure'): h.apply(PARAMS, self.host)
        self.assertEqual(self.host.config.read_text(), 'old config\n')
        self.assertTrue(self.host.active)
        self.assertFalse(self.host.enabled)
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'rolled_back')
    def test_stopped_service_is_restored(self):
        self.host.active = False
        self.host.enabled = False
        self.host.fail_action = 'enable'
        with self.assertRaises(RuntimeError): h.apply(PARAMS, self.host)
        self.assertFalse(self.host.active)
        self.assertFalse(self.host.enabled)
    def test_missing_old_config_restored(self):
        self.host.config.unlink()
        self.host.active = False
        self.host.fail_action = 'start'
        with self.assertRaises(RuntimeError): h.apply(PARAMS, self.host)
        self.assertFalse(self.host.config.exists())
    def test_partial_install_failure_disables_an_unconfigured_unit(self):
        self.host.installed = False
        self.host.active = False
        self.host.enabled = False
        self.host.service_exists = lambda: True
        def partial_install():
            self.host.enabled = True
            raise RuntimeError('package configuration failed')
        self.host.install = partial_install
        with self.assertRaisesRegex(RuntimeError, 'package configuration failed'):
            h.apply(PARAMS, self.host)
        self.assertFalse(self.host.active)
        self.assertFalse(self.host.enabled)
    def test_first_install_failure_keeps_diagnostics(self):
        self.host.installed = False
        self.host.active = False
        self.host.enabled = False
        self.host.config.unlink()
        self.host.fail_action = 'start'
        with self.assertRaises(RuntimeError): h.apply(PARAMS, self.host)
        self.assertTrue(self.host.installed)
        self.assertFalse(self.host.active)
        self.assertFalse(self.host.enabled)
        self.assertEqual(self.host.config.read_text(), h.render(PARAMS))
    def test_recovery_failure_is_reported_and_preserved(self):
        self.host.fail_action = 'reload'
        self.host.fail_recovery = True
        with self.assertRaisesRegex(RuntimeError, 'recovery failure'): h.apply(PARAMS, self.host)
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'recovery_failed')
        self.assertTrue(self.host.lock.exists())
    def test_config_restore_failure_preserves_service_and_lock(self):
        for failure in ['write', 'ownership', 'validation']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                host = FakeHost(Path(root))
                host.config.parent.mkdir(parents=True)
                host.config.write_text('old config\n')
                host.fail_action = 'reload'
                atomic_write = h.atomic_write
                def write(path, data, mode=0o600):
                    if failure == 'write' and path == host.config and data == b'old config\n':
                        raise OSError(errno.ENOSPC, 'No space left on device')
                    return atomic_write(path, data, mode)
                def chown(*args):
                    if failure == 'ownership': raise PermissionError('ownership restore failed')
                validate = host.validate_config
                def validate_restored(path):
                    if failure == 'validation' and path == host.config:
                        raise RuntimeError('restored config invalid')
                    validate(path)
                host.validate_config = validate_restored
                with patch.object(h, 'atomic_write', side_effect=write), \
                     patch.object(h.os, 'chown', side_effect=chown):
                    with self.assertRaisesRegex(RuntimeError, 'manual recovery required'):
                        h.apply(PARAMS, host)
                self.assertNotIn('restart', host.calls)
                self.assertNotIn('stop', host.calls)
                self.assertNotIn('enable', host.calls)
                self.assertTrue(host.active)
                self.assertTrue(host.lock.exists())
                record = next(host.backups.glob('*/state.json'))
                self.assertEqual(json.loads(record.read_text())['status'], 'recovery_failed')
                calls = list(host.calls)
                with self.assertRaisesRegex(RuntimeError, 'locked'):
                    h.apply(PARAMS, host)
                self.assertEqual(host.calls, calls)
    def test_concurrent_execution_only_one_mutates(self):
        entered, release = threading.Event(), threading.Event()
        validate = self.host.validate_config
        def blocked_validate(path):
            entered.set()
            if not release.wait(5): raise RuntimeError('test timed out')
            validate(path)
        self.host.validate_config = blocked_validate
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(h.apply, PARAMS, self.host)
            try:
                self.assertTrue(entered.wait(5))
                other = FakeHost(Path(self.tmp.name))
                with self.assertRaisesRegex(RuntimeError, 'locked'): h.apply(PARAMS, other)
                self.assertEqual(other.calls, [])
            finally:
                release.set()
            self.assertTrue(first.result()['changed'])
        self.assertEqual(len(self.records()), 1)
    def test_killed_process_keeps_pending_record_and_lock(self):
        marker = Path(self.tmp.name) / 'entered'
        code = """
import pathlib, time
scope = {'__name__': 'fixture', '__file__': %r}
exec(pathlib.Path(%r).read_text(), scope)
host = scope['FakeHost'](pathlib.Path(%r))
def interrupted(action):
    pathlib.Path(%r).touch()
    time.sleep(60)
host.service = interrupted
scope['h'].apply(scope['PARAMS'], host)
""" % (str(Path(__file__).resolve()), str(Path(__file__).resolve()), self.tmp.name, str(marker))
        child = subprocess.Popen([sys.executable, '-c', code])
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
        finally:
            child.kill()
            child.wait(timeout=5)
        self.assertTrue(self.host.lock.exists())
        self.assertTrue((self.host.lock / 'owner.json').exists())
        self.assertEqual(json.loads(self.records()[0].read_text())['status'], 'pending')
        self.assertEqual((self.records()[0].parent / 'haproxy.cfg').read_text(), 'old config\n')
    def test_existing_lock_rejects_before_changes(self):
        self.host.lock.parent.mkdir(parents=True, exist_ok=True)
        self.host.lock.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'locked'): h.apply(PARAMS, self.host)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.records(), [])
    def test_lock_removed_on_handled_failure(self):
        self.host.valid = False
        with self.assertRaises(RuntimeError): h.apply(PARAMS, self.host)
        self.assertFalse(self.host.lock.exists())
    def test_retain_five_complete_and_all_unresolved(self):
        for i in range(7): h.apply(dict(PARAMS, bind_port=8100+i), self.host)
        self.assertEqual(len(self.records()), 5)
        self.host.fail_action = 'reload'
        with self.assertRaises(RuntimeError): h.apply(dict(PARAMS, bind_port=8200), self.host)
        h.apply(dict(PARAMS, bind_port=8300), self.host)
        states = [json.loads(p.read_text())['status'] for p in self.records()]
        self.assertEqual(states.count('complete'), 5)
        self.assertIn('rolled_back', states)

if __name__ == '__main__': unittest.main()
