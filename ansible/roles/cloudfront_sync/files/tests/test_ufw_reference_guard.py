import importlib.util
from pathlib import Path
import stat
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[4] / 'molecule/cloudfront_sync/ufw_reference_verify.py'
SPEC = importlib.util.spec_from_file_location('ufw_reference_verify_under_test', SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class TestDisposableNetworkGuard(unittest.TestCase):
    DEFAULT = object()

    def setUp(self):
        self.host = types.SimpleNamespace(st_dev=1, st_ino=100, st_mode=stat.S_IFREG | 0o444)
        self.current = types.SimpleNamespace(st_dev=1, st_ino=200, st_mode=stat.S_IFREG | 0o444)

    def run_guard(self, host=DEFAULT, current=DEFAULT):
        host = self.host if host is self.DEFAULT else host
        current = self.current if current is self.DEFAULT else current

        def fake_stat(path, *args, **kwargs):
            if str(path) == str(VERIFY.HOST_NETNS):
                if host is None:
                    raise FileNotFoundError('host network namespace reference missing')
                return host
            if str(path) == '/proc/self/ns/net':
                return current
            raise AssertionError('unexpected stat path: ' + str(path))

        with patch.object(VERIFY.os, 'geteuid', return_value=0), \
                patch.object(VERIFY.os.path, 'ismount', return_value=True), \
                patch.object(VERIFY, 'host_namespace_mount_is_readonly', return_value=True), \
                patch.object(VERIFY.Path, 'is_file', return_value=True), \
                patch.object(VERIFY.marker, 'marker_state', return_value=VERIFY.marker.VALID) as marker_state, \
                patch.object(VERIFY.Path, 'stat', autospec=True, side_effect=fake_stat):
            try:
                VERIFY.require_disposable()
            finally:
                # The marker policy itself is covered by test_disposable_marker.
                marker_state.assert_called_once_with(VERIFY.MARKER, VERIFY.MARKER_TEXT, exact_mode=0o600,
                                                     single_link=True)

    def test_refuses_shared_host_network_namespace(self):
        shared = types.SimpleNamespace(st_dev=1, st_ino=100, st_mode=stat.S_IFREG | 0o444)
        with self.assertRaisesRegex(RuntimeError, 'host network namespace'):
            self.run_guard(host=shared, current=shared)

    def test_refuses_missing_host_network_reference(self):
        with self.assertRaisesRegex(RuntimeError, 'host network namespace reference'):
            self.run_guard(host=None)

    def test_accepts_distinct_network_namespaces(self):
        self.run_guard()

    def test_host_reference_must_be_a_readonly_bind_mount(self):
        readonly = b'35 25 0:31 / /run/cloudfront-sync-host-netns ro,nosuid - nsfs nsfs rw\n'
        writable = b'35 25 0:31 / /run/cloudfront-sync-host-netns rw,nosuid - nsfs nsfs rw\n'
        self.assertTrue(VERIFY.host_namespace_mount_is_readonly_from(readonly))
        self.assertFalse(VERIFY.host_namespace_mount_is_readonly_from(writable))


if __name__ == '__main__':
    unittest.main()
