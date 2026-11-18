"""Installer failures must preserve old assets and never start an uninitialized timer."""
import importlib.util
import io
import contextlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'install_cloudfront_sync.py'
spec = importlib.util.spec_from_file_location('install_cloudfront_sync', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def parameters():
    return {
        'config': {'host_address': '192.0.2.10', 'firewall': {'backend': 'none', 'ports': [443]},
                   'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
                   'limits': {'max_changes': 10, 'min_ratio': 0.8}, 'notify_unit': ''},
        'timer_enabled': False, 'approve_token': '',
        'assets': {'engine': '#!/usr/bin/python3\nprint("engine")\n',
                   'service': '[Service]\nType=oneshot\n', 'timer': '[Timer]\nOnCalendar=hourly\n',
                   'monitor': '{"zabbix_export": {}}\n'},
    }


class FakeRun:
    def __init__(self):
        self.calls = []
        self.enabled = False
        self.active = False
        self.fail_engine = False
        self.fail_enable = False
        self.fail_disable = False
        self.notification_loaded = True
        self.active_service = False

    def __call__(self, args, **kwargs):
        self.calls.append((args, {key: value for key, value in kwargs.items() if key != 'env'}))
        if args[:2] == ['systemctl', 'show']:
            return subprocess.CompletedProcess(args, 0, 'loaded\n' if self.notification_loaded else 'not-found\n', '')
        if args[:2] == ['systemctl', 'is-enabled']:
            return subprocess.CompletedProcess(args, 0 if self.enabled else 1,
                                               'enabled\n' if self.enabled else 'disabled\n', '')
        if args[:2] == ['systemctl', 'is-active']:
            active = self.active if args[-1] == 'cloudfront-sync.timer' else self.active_service
            return subprocess.CompletedProcess(args, 0 if active else 3,
                                               'active\n' if active else 'inactive\n', '')
        if args[:2] == ['systemctl', 'stop']:
            self.active = False
        if args[:2] == ['systemctl', 'enable']:
            if self.fail_enable:
                raise subprocess.CalledProcessError(1, args)
            self.enabled = True
        if args[:2] == ['systemctl', 'disable']:
            if self.fail_disable:
                return subprocess.CompletedProcess(args, 1, '', '')
            self.enabled = False
            if '--now' in args:
                self.active = False
        if args[:2] == ['systemctl', 'start']:
            self.active = True
        if args[0] == '/usr/bin/python3':
            self.lock_fd = kwargs.get('pass_fds', ())
            if self.fail_engine:
                self.fail_engine = False
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, '{"changes": 0, "approve_token": "sample-token"}\n', '')
        return subprocess.CompletedProcess(args, 0, '', '')


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.paths = module.Paths(self.root)
        self.run = FakeRun()
        self.installer = module.Installer(self.paths, runner=self.run, owner=os.getuid())

    def tearDown(self):
        self.temp.cleanup()

    def test_plan_only_install_is_idempotent_and_passes_held_lock(self):
        first = self.installer.install(parameters())
        second = self.installer.install(parameters())
        self.assertTrue(first['changed'])
        self.assertFalse(second['changed'])
        self.assertTrue(self.run.lock_fd)
        self.assertFalse(any('apply' in args for args, _ in self.run.calls))
        self.assertFalse(self.run.enabled)
        self.assertEqual(self.paths.config.stat().st_mode & 0o777, 0o640)
        self.assertFalse(self.paths.journal.exists())
        self.assertTrue(any(args[:3] == ['systemctl', 'disable', '--now'] for args, _ in self.run.calls))

    def test_approval_does_not_replan_and_reset_the_approved_token(self):
        data = parameters()
        data['approve_token'] = 'a' * 43
        self.installer.install(data)
        engine_calls = [args for args, _ in self.run.calls if args[0] == '/usr/bin/python3']
        self.assertTrue(any('apply' in args for args in engine_calls))
        self.assertFalse(any('plan' in args for args in engine_calls))
        self.assertNotIn(data['approve_token'], self.paths.config.read_text())

    def test_urlsafe_token_may_start_with_a_dash(self):
        data = parameters()
        data['approve_token'] = '-' + 'a' * 42
        self.installer.install(data)
        args = next(args for args, _ in self.run.calls if 'apply' in args)
        self.assertIn('--approve=' + data['approve_token'], args)

    def test_failure_restores_previous_assets_and_timer(self):
        self.installer.install(parameters())
        old = self.paths.engine.read_bytes()
        self.run.enabled = self.run.active = True
        self.run.fail_engine = True
        data = parameters()
        data['assets']['engine'] = 'print("new")\n'
        with self.assertRaises(module.InstallError):
            self.installer.install(data)
        self.assertEqual(self.paths.engine.read_bytes(), old)
        self.assertTrue(self.run.active)
        self.assertTrue(self.run.enabled)
        self.assertFalse(self.paths.journal.exists())

    def test_disable_failure_restores_timer_and_never_updates_assets(self):
        self.installer.install(parameters())
        old = self.paths.engine.read_bytes()
        self.run.enabled = self.run.active = True
        self.run.fail_disable = True
        self.run.calls = []
        data = parameters()
        data['assets']['engine'] = 'print("unapproved candidate")\n'
        with self.assertRaisesRegex(module.InstallError, 'safely disabled'):
            self.installer.install(data)
        self.assertEqual(self.paths.engine.read_bytes(), old)
        self.assertTrue(self.run.enabled)
        self.assertTrue(self.run.active)
        self.assertFalse(any(args[0] == '/usr/bin/python3' for args, _ in self.run.calls))

    def test_busy_sync_lock_restores_prior_timer_without_touching_assets(self):
        self.installer.install(parameters())
        old = self.paths.engine.read_bytes()
        self.run.enabled = self.run.active = True
        original = self.installer.lock
        def busy(path):
            if path == self.paths.sync_lock:
                raise module.InstallError('synchronization already running')
            return original(path)
        with patch.object(self.installer, 'lock', side_effect=busy):
            with self.assertRaisesRegex(module.InstallError, 'already running'):
                self.installer.install(parameters())
        self.assertTrue(self.run.enabled)
        self.assertTrue(self.run.active)
        self.assertEqual(self.paths.engine.read_bytes(), old)
        self.assertFalse(self.paths.journal.exists())

    def test_permissive_calling_umask_does_not_create_writable_parent_directories(self):
        previous = os.umask(0)
        try:
            self.installer.install(parameters())
        finally:
            os.umask(previous)
        for parent in (self.paths.at('/usr/local/libexec'), self.paths.engine.parent,
                       self.paths.at('/var/lib/cloudfront-sync'), self.paths.private):
            self.assertFalse(parent.stat().st_mode & 0o022)

    def test_nonexistent_notification_unit_is_rejected_before_any_changes(self):
        data = parameters()
        data['config']['notify_unit'] = 'missing-notification.service'
        self.run.notification_loaded = False
        with self.assertRaisesRegex(module.InstallError, 'existing loadable'):
            self.installer.install(data)
        self.assertFalse(self.paths.engine.exists())
        self.assertTrue(all(args[:2] == ['systemctl', 'show'] for args, _ in self.run.calls))

    def test_initial_timer_request_fails_before_host_mutation(self):
        data = parameters()
        data['timer_enabled'] = True
        with self.assertRaisesRegex(module.InstallError, 'initialized'):
            self.installer.install(data)
        self.assertEqual(self.run.calls, [])
        self.assertFalse(self.paths.engine.exists())

    def test_invalid_types_and_ssh_port_rejected_before_mutation(self):
        for key, value in [('timer_enabled', 'false'), ('approve_token', '--evil')]:
            data = parameters()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(module.InstallError):
                self.installer.install(data)
        for ports in [[22], [True], ['443'], [443, 443], []]:
            data = parameters()
            data['config']['firewall']['ports'] = ports
            with self.subTest(ports=ports), self.assertRaises(module.InstallError):
                self.installer.install(data)
        self.assertEqual(self.run.calls, [])

    def test_invalid_config_values_fail_before_any_system_command(self):
        changes = [
            lambda d: d['config'].update(host_address='invalid'),
            lambda d: d['config'].update(host_address=True),
            lambda d: d['config']['firewall'].update(backend='iptables'),
            lambda d: d['config']['nginx'].update(enabled='false'),
            lambda d: d['config']['nginx'].update(enabled=True),
            lambda d: d['config']['nginx'].update(shared_dir='/etc/nginx/../../evil'),
            lambda d: d['config']['nginx'].update(shared_dir='/etc/nginx/.'),
            lambda d: d['config']['nginx'].update(shared_dir='/tmp/evil'),
            lambda d: d['config']['nginx'].update(bundles=[{'geo_file': '/etc/nginx/a'}]),
            lambda d: d['config']['limits'].update(max_changes=1001),
            lambda d: d['config']['limits'].update(max_changes=True),
            lambda d: d['config']['limits'].update(min_ratio=float('nan')),
            lambda d: d['config'].update(notify_unit='bad:unit.service'),
            lambda d: d['config'].update(notify_unit='a.service\nb.service'),
            lambda d: d['assets'].update(engine='invalid python %'),
            lambda d: d['assets'].update(monitor='invalid json'),
        ]
        for mutate in changes:
            data = parameters()
            mutate(data)
            with self.subTest(change=mutate), self.assertRaises(module.InstallError):
                self.installer.install(data)
        self.assertEqual(self.run.calls, [])

    def test_symlink_target_is_rejected_without_following(self):
        self.paths.engine.parent.mkdir(parents=True)
        victim = self.root / 'victim'
        victim.write_text('keep')
        self.paths.engine.symlink_to(victim)
        with self.assertRaises(module.InstallError):
            self.installer.install(parameters())
        self.assertEqual(victim.read_text(), 'keep')

    def test_rollback_failure_keeps_journal_and_stops_timer(self):
        self.installer.install(parameters())
        self.run.fail_engine = True
        with patch.object(self.installer, 'restore', side_effect=OSError('disk unavailable')):
            with self.assertRaisesRegex(module.InstallError, 'recovery'):
                self.installer.install(parameters())
        self.assertTrue(self.paths.journal.exists())
        self.assertFalse(self.run.active)

    def test_crash_after_apply_boundary_does_not_restore_old_installation(self):
        self.installer.install(parameters())
        data = parameters()
        data['assets']['engine'] = 'print("candidate")\n'
        data['approve_token'] = 'a' * 43
        original = self.installer.command

        def interrupted(args, **kwargs):
            if args[0] == '/usr/bin/python3' and 'apply' in args:
                self.paths.state.write_text('{"version": 1, "committed": true}')
                raise KeyboardInterrupt('parent died after child commit')
            return original(args, **kwargs)

        with patch.object(self.installer, 'command', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.installer.install(data)
        self.assertEqual(json.loads(self.paths.journal.read_text())['phase'], 'applying')
        with self.assertRaisesRegex(module.InstallError, 'recovery'):
            self.installer.install(parameters())
        self.assertEqual(self.paths.engine.read_text(), data['assets']['engine'])
        self.assertFalse(self.run.active)
        self.assertFalse(self.run.enabled)

    def test_rejected_approval_with_unchanged_runtime_restores_without_manual_recovery(self):
        self.installer.install(parameters())
        data = parameters()
        data['approve_token'] = 'a' * 43
        original = self.installer.command
        def rejected(args, **kwargs):
            if args[0] == '/usr/bin/python3' and 'apply' in args:
                raise module.InstallError('approval rejected')
            return original(args, **kwargs)
        with patch.object(self.installer, 'command', side_effect=rejected):
            with self.assertRaisesRegex(module.InstallError, 'approval rejected'):
                self.installer.install(data)
        self.assertFalse(self.paths.journal.exists())

    def test_corrupt_recovery_records_fail_closed_before_changing_files(self):
        self.installer.install(parameters())
        old = self.paths.engine.read_bytes()
        mutations = [
            lambda journal: journal.update(phase='unknown'),
            lambda journal: journal.update(timer={'enabled': 'false', 'active': False}),
            lambda journal: journal['snapshot']['engine'].update(mode=0o777),
        ]
        for mutate in mutations:
            self.installer.write_journal(self.installer.snapshot(), {'enabled': False, 'active': False})
            journal = json.loads(self.paths.journal.read_text())
            mutate(journal)
            self.paths.journal.write_text(json.dumps(journal))
            with self.subTest(mutation=mutate), self.assertRaisesRegex(module.InstallError, 'recovery'):
                self.installer.install(parameters())
            self.assertEqual(self.paths.engine.read_bytes(), old)
            self.assertTrue(self.paths.journal.exists())
            self.assertFalse(self.run.enabled)
            self.assertFalse(self.run.active)

    def test_initialized_timer_enable_and_second_install_are_idempotent(self):
        self.installer.install(parameters())
        self.paths.state.write_text(json.dumps({'version': 1, 'initialized': True,
                                               'ranges': ['192.0.2.0/24'], 'last_success': 1}))
        data = parameters()
        data['timer_enabled'] = True
        self.assertTrue(self.installer.install(data)['changed'])
        self.assertTrue(self.run.enabled)
        self.assertTrue(self.run.active)
        self.assertFalse(self.installer.install(data)['changed'])

    def test_install_lock_contention_does_not_touch_timer(self):
        fd = self.installer.lock(self.paths.install_lock)
        try:
            with self.assertRaisesRegex(module.InstallError, 'already running'):
                self.installer.install(parameters())
        finally:
            os.close(fd)
        self.assertEqual(self.run.calls, [])

    def test_active_service_timeout_leaves_old_assets_and_timer_safely_disabled(self):
        self.installer.install(parameters())
        old = self.paths.engine.read_bytes()
        self.run.enabled = self.run.active = self.run.active_service = True
        with patch.object(module.time, 'monotonic', side_effect=[0, 121]):
            with self.assertRaisesRegex(module.InstallError, 'did not finish'):
                self.installer.install(parameters())
        self.assertEqual(self.paths.engine.read_bytes(), old)
        self.assertFalse(self.run.enabled)
        self.assertFalse(self.run.active)

    def test_runtime_recovery_uses_previous_engine_before_any_asset_update(self):
        self.installer.install(parameters())
        runtime_journal = self.paths.private / 'journal.json'
        runtime_journal.write_text('{}')
        os.chmod(runtime_journal, 0o600)
        old = self.paths.engine.read_bytes()
        data = parameters()
        data['assets']['engine'] = 'print("candidate")\n'
        original = self.installer.command
        recovered = []
        def recover_first(args, **kwargs):
            if args[0] == '/usr/bin/python3' and runtime_journal.exists():
                self.assertEqual(self.paths.engine.read_bytes(), old)
                recovered.append(True)
                runtime_journal.unlink()
            return original(args, **kwargs)
        with patch.object(self.installer, 'command', side_effect=recover_first):
            self.installer.install(data)
        self.assertEqual(recovered, [True])
        self.assertEqual(self.paths.engine.read_text(), data['assets']['engine'])

    def test_failed_previous_runtime_recovery_never_installs_candidate(self):
        self.installer.install(parameters())
        (self.paths.private / 'journal.json').write_text('{}')
        old = self.paths.engine.read_bytes()
        data = parameters()
        data['assets']['engine'] = 'print("candidate")\n'
        self.run.fail_engine = True
        with self.assertRaises(module.InstallError):
            self.installer.install(data)
        self.assertEqual(self.paths.engine.read_bytes(), old)
        self.assertTrue((self.paths.private / 'journal.json').exists())
        self.assertFalse(self.run.enabled)
        self.assertFalse(self.run.active)

    def test_timer_failure_after_committed_apply_preserves_coherent_candidate(self):
        self.installer.install(parameters())
        data = parameters()
        data['assets']['engine'] = 'print("committed candidate")\n'
        data['timer_enabled'] = True
        data['approve_token'] = 'a' * 43
        original = self.installer.command
        def commit(args, **kwargs):
            if args[0] == '/usr/bin/python3' and 'apply' in args:
                self.paths.state.write_text(json.dumps({'version': 1, 'initialized': True,
                                                       'ranges': ['192.0.2.0/24'], 'last_success': 1}))
            return original(args, **kwargs)
        self.run.fail_enable = True
        with patch.object(self.installer, 'command', side_effect=commit):
            with self.assertRaisesRegex(module.InstallError, 'recovery'):
                self.installer.install(data)
        self.assertEqual(self.paths.engine.read_text(), data['assets']['engine'])
        self.assertTrue(self.paths.journal.exists())
        self.assertFalse(self.run.enabled)
        self.assertFalse(self.run.active)

    def test_schema_asset_and_bundle_validation_boundaries(self):
        mutations = [
            lambda d: d.update(unexpected=True),
            lambda d: d['config'].pop('host_address'),
            lambda d: d['config']['limits'].update(unexpected=True),
            lambda d: d['assets'].pop('timer'),
            lambda d: d['assets'].update(engine=''),
            lambda d: d['assets'].update(engine='x' * 2_000_001),
            lambda d: d['config']['nginx'].update(bundles=[{'geo_file': '/tmp/x', 'realip_file': '/etc/nginx/b'}]),
            lambda d: d['config']['nginx'].update(bundles=[{'geo_file': 1, 'realip_file': '/etc/nginx/b'}]),
            lambda d: d['config']['nginx'].update(bundles=[{'geo_file': '/etc/nginx/a', 'realip_file': '/etc/nginx/b'}] * 2),
        ]
        for mutate in mutations:
            data = parameters()
            mutate(data)
            with self.subTest(mutation=mutate), self.assertRaises(module.InstallError):
                self.installer.install(data)
        self.assertEqual(self.run.calls, [])

    def test_subprocess_failures_do_not_echo_output_or_approval_arguments(self):
        args = ['/usr/bin/python3', '--approve=do-not-log-this']
        with patch.object(self.installer, 'runner', return_value=subprocess.CompletedProcess(args, 1, 'private output', 'private error')):
            with self.assertRaises(module.InstallError) as failure:
                self.installer.command(args)
            self.assertNotIn('private', str(failure.exception))
            self.assertNotIn('do-not-log-this', str(failure.exception))
        with patch.object(self.installer, 'runner', side_effect=subprocess.TimeoutExpired(args, 180)):
            with self.assertRaises(module.InstallError) as failure:
                self.installer.command(args)
            self.assertNotIn('do-not-log-this', str(failure.exception))

    def test_writable_ancestors_and_wrong_file_types_are_refused(self):
        self.paths.engine.parent.mkdir(parents=True)
        self.paths.engine.write_text('old')
        os.chmod(self.paths.engine.parent, 0o777)
        with self.assertRaisesRegex(module.InstallError, 'writable'):
            self.installer.safe_path(self.paths.engine)
        os.chmod(self.paths.engine.parent, 0o755)
        with self.assertRaisesRegex(module.InstallError, 'type'):
            self.installer.safe_path(self.paths.engine, directory=True)
        with self.assertRaisesRegex(module.InstallError, 'type'):
            self.installer.safe_path(self.paths.engine.parent)

    def test_atomic_replace_failure_preserves_original_and_removes_staging_file(self):
        self.installer.install(parameters())
        original = self.paths.config.read_bytes()
        with patch.object(module.os, 'replace', side_effect=OSError('injected replace failure')):
            with self.assertRaises(OSError):
                self.installer.atomic_write(self.paths.config, b'new config', 0o640)
        self.assertEqual(self.paths.config.read_bytes(), original)
        self.assertFalse(list(self.paths.config.parent.glob('.cloudfront-sync-*')))

    def test_timer_state_mismatch_cannot_be_reported_as_success(self):
        self.installer.install(parameters())
        with patch.object(self.installer, 'timer_state', return_value={'enabled': False, 'active': False}):
            with self.assertRaisesRegex(module.InstallError, 'verification failed'):
                self.installer.set_timer({'enabled': True, 'active': True})

    def test_crash_journal_is_recovered_before_a_new_update(self):
        self.installer.install(parameters())
        snapshot = self.installer.snapshot()
        self.installer.write_journal(snapshot, {'enabled': False, 'active': False})
        self.paths.engine.write_text('print("partial")\n')
        self.installer.install(parameters())
        self.assertEqual(self.paths.engine.read_text(), parameters()['assets']['engine'])
        self.assertFalse(self.paths.journal.exists())


class CliTests(unittest.TestCase):
    def run_cli(self, data, *args, root=True):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(module.sys, 'argv', ['install-cloudfront-sync', *args]), \
             patch.object(module.sys, 'stdin', io.StringIO(data)), \
             patch.object(module.os, 'geteuid', return_value=0 if root else 123), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = module.main()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_validate_only_does_not_require_root_or_invoke_installer(self):
        with patch.object(module.Installer, 'install', side_effect=AssertionError('must not run')):
            code, out, err = self.run_cli(json.dumps(parameters()), '--validate-only', root=False)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'valid': True})
        self.assertEqual(err, '')

    def test_root_required_and_malformed_or_oversized_payload_rejected(self):
        code, _, err = self.run_cli(json.dumps(parameters()), root=False)
        self.assertEqual(code, 1)
        self.assertIn('requires root', err)
        for raw in ('not json', 'x' * 8_000_001):
            code, out, err = self.run_cli(raw)
            self.assertEqual(code, 1)
            self.assertEqual(out, '')
            self.assertIsInstance(json.loads(err)['error'], str)

    def test_success_and_sanitized_installer_failure(self):
        with patch.object(module.Installer, 'install', return_value={'changed': False}):
            code, out, err = self.run_cli(json.dumps(parameters()))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {'changed': False})
        self.assertEqual(err, '')
        with patch.object(module.Installer, 'install', side_effect=module.InstallError('timer recovery failed')):
            code, out, err = self.run_cli(json.dumps(parameters()))
        self.assertEqual(code, 1)
        self.assertEqual(out, '')
        self.assertEqual(json.loads(err)['error'], 'timer recovery failed')


if __name__ == '__main__':
    unittest.main()
