import importlib.util
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PATH = Path(__file__).parents[1] / 'vm_network_verify.py'
spec = importlib.util.spec_from_file_location('vm_network_verify', PATH)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class SafetyTests(unittest.TestCase):
    def test_root_and_exact_sentinel_required_before_any_network_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / 'sentinel'
            with mock.patch.object(verify.os, 'geteuid', return_value=1000):
                self.assertRaises(verify.NetworkCheckError, verify.check_environment, sentinel)
            sentinel.write_text('wrong marker\n')
            sentinel.chmod(0o600)
            with mock.patch.object(verify.os, 'geteuid', return_value=0):
                self.assertRaises(verify.NetworkCheckError, verify.check_environment, sentinel)

    def test_guest_addresses_are_fixture_only_and_denied_addresses_not_owned(self):
        state = {'ranges': ['192.0.2.0/28', '2001:db8:1::/48']}
        self.assertEqual(len(verify.client_definitions(state)), 2)
        for ranges in [[], ['192.0.2.0/28'], ['192.0.2.0/28', '2001:db8:1::/48', '10.0.0.0/8']]:
            with self.subTest(ranges=ranges):
                self.assertRaises(verify.NetworkCheckError, verify.client_definitions, {'ranges': ranges})

    def test_container_is_rejected_even_if_marker_is_valid(self):
        result = mock.Mock(returncode=0, stdout='docker\n')
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / 'sentinel'
            sentinel.write_text(verify.SENTINEL_CONTENT)
            sentinel.chmod(0o600)
            with mock.patch.object(verify.os, 'geteuid', return_value=0), mock.patch.object(verify.sys, 'platform', 'linux'), mock.patch.object(verify, 'run', return_value=result):
                with mock.patch.object(verify, 'check_sentinel'):
                    self.assertRaises(verify.NetworkCheckError, verify.check_environment, sentinel)

    def test_valid_virtual_machine_environment_is_accepted(self):
        results = [mock.Mock(returncode=1, stdout='none\n'),
                   mock.Mock(returncode=0, stdout='apple\n'),
                   mock.Mock(returncode=0, stdout='active\n'),
                   mock.Mock(returncode=1, stdout='disabled\n'),
                   mock.Mock(returncode=1, stdout='inactive\n'),
                   mock.Mock(returncode=3, stdout='inactive\n'),
                   mock.Mock(returncode=0, stdout='Status: active\n'),
                   mock.Mock(returncode=0, stdout='')]
        with mock.patch.object(verify.os, 'geteuid', return_value=0), mock.patch.object(verify.sys, 'platform', 'linux'), mock.patch.object(verify, 'check_sentinel'), mock.patch.object(verify, 'run', side_effect=results):
            self.assertEqual(verify.check_environment(), {'evidence_method': 'systemd-detect-virt', 'virtual_model': 'apple'})

    def test_bare_metal_is_rejected_before_services_or_network_mutations(self):
        results = [mock.Mock(returncode=1, stdout='none\n'), mock.Mock(returncode=1, stdout='none\n')]
        with mock.patch.object(verify.os, 'geteuid', return_value=0), mock.patch.object(verify.sys, 'platform', 'linux'), mock.patch.object(verify, 'check_sentinel'), mock.patch.object(verify, 'run', side_effect=results) as command:
            self.assertRaises(verify.NetworkCheckError, verify.check_environment)
            self.assertEqual(command.call_count, 2)

    def test_active_but_disabled_timer_is_rejected(self):
        def command(args, **kwargs):
            if args == ['systemd-detect-virt', '--container']:
                return mock.Mock(returncode=1, stdout='none\n')
            if args == ['systemd-detect-virt', '--vm']:
                return mock.Mock(returncode=0, stdout='apple\n')
            if args == ['systemctl', 'is-active', 'nginx.service']:
                return mock.Mock(returncode=0, stdout='active\n')
            if args == ['systemctl', 'is-enabled', '--quiet', 'cloudfront-sync.timer']:
                return mock.Mock(returncode=1, stdout='disabled\n')
            if args == ['systemctl', 'is-active', '--quiet', 'cloudfront-sync.timer']:
                return mock.Mock(returncode=0, stdout='active\n')
            raise AssertionError('active timer must be rejected before further host access')
        with mock.patch.object(verify.os, 'geteuid', return_value=0), mock.patch.object(verify.sys, 'platform', 'linux'), mock.patch.object(verify, 'check_sentinel'), mock.patch.object(verify, 'run', side_effect=command):
            self.assertRaises(verify.NetworkCheckError, verify.check_environment)

    def test_old_systemd_exact_apple_vz_dmi_is_accepted(self):
        results = [mock.Mock(returncode=1, stdout='none\n'),
                   mock.Mock(returncode=1, stdout='none\n'),
                   mock.Mock(returncode=0, stdout='active\n'),
                   mock.Mock(returncode=1, stdout='disabled\n'),
                   mock.Mock(returncode=1, stdout='inactive\n'),
                   mock.Mock(returncode=3, stdout='inactive\n'),
                   mock.Mock(returncode=0, stdout='Status: active\n'),
                   mock.Mock(returncode=0, stdout='')]
        values = ['Apple Inc.\n', 'Apple Virtualization Generic Platform\n', 'Apple Inc.\n']
        with mock.patch.object(verify.os, 'geteuid', return_value=0), mock.patch.object(verify.sys, 'platform', 'linux'), mock.patch.object(verify, 'check_sentinel'), mock.patch.object(verify, 'run', side_effect=results), mock.patch.object(verify.Path, 'read_text', side_effect=values):
            result = verify.check_environment()
        self.assertEqual(result['evidence_method'], 'apple-vz-dmi')
        self.assertEqual(result['virtual_model'], 'Apple Virtualization Generic Platform')

    def test_apple_dmi_near_matches_and_physical_asahi_are_rejected(self):
        for values in [('Apple Inc.', 'MacBookPro18,3', 'Apple Inc.'),
                       ('Not Apple Inc.', 'Apple Virtualization Generic Platform', 'Apple Inc.'),
                       ('Apple Inc.', 'Apple Virtualization Generic Platform extra', 'Apple Inc.'),
                       ('Apple Inc.', 'Apple Virtualization Generic Platform ', 'Apple Inc.'),
                       ('Apple Inc.', 'Apple Virtualization Generic Platform', 'Other BIOS')]:
            with self.subTest(values=values), mock.patch.object(verify.Path, 'read_text', side_effect=values):
                self.assertIsNone(verify.apple_vz_dmi())

    def test_failure_reports_only_safe_fixture_reason(self):
        output = io.StringIO()
        reason = 'network acceptance case failed: ipv4-allowed-valid-origin'
        with mock.patch.object(verify, 'check_environment', side_effect=verify.NetworkCheckError(reason)), contextlib.redirect_stderr(output):
            self.assertEqual(verify.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'error': 'vm_network_acceptance_failed', 'reason': reason, 'passed_cases': []})

    def test_raw_system_errors_are_not_logged(self):
        output = io.StringIO()
        with mock.patch.object(verify, 'check_environment', side_effect=OSError('DO_NOT_LOG_SECRET')), contextlib.redirect_stderr(output):
            self.assertEqual(verify.main(), 1)
        self.assertNotIn('DO_NOT_LOG_SECRET', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['error'], 'vm_network_acceptance_failed')

    def test_cleanup_accepts_owned_veth_already_removed_by_namespace_teardown(self):
        harness = verify.Harness()
        harness.links = ['cfvm-va']
        results = [mock.Mock(returncode=0), mock.Mock(returncode=1), mock.Mock(returncode=1)]
        with mock.patch.object(verify, 'run', side_effect=results):
            self.assertIsNone(harness.cleanup())

    def test_cleanup_rejects_owned_veth_that_remains_after_failed_delete(self):
        harness = verify.Harness()
        harness.links = ['cfvm-va']
        results = [mock.Mock(returncode=0), mock.Mock(returncode=1), mock.Mock(returncode=0)]
        with mock.patch.object(verify, 'run', side_effect=results):
            self.assertRaises(verify.NetworkCheckError, harness.cleanup)

    def test_sentinel_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target'
            target.write_text(verify.SENTINEL_CONTENT)
            target.chmod(0o600)
            sentinel = Path(directory) / 'sentinel'
            sentinel.symlink_to(target)
            self.assertRaises(verify.NetworkCheckError, verify.check_sentinel, sentinel)


if __name__ == '__main__':
    unittest.main()
