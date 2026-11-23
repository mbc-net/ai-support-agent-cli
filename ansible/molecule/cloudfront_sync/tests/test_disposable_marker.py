"""Host-free tests of the shared disposable-host marker check and its three users."""
import ast
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('marker_test_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


marker = load('disposable_marker')
CONTENT = b'disposable only\n'


def as_root(info, **changes):
    """A stat result as if owned by root (test files are not); other fields kept."""
    fields = {name: getattr(info, name) for name in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid',
                                                      'st_nlink', 'st_size')}
    fields.update({'st_uid': 0, **changes})
    return types.SimpleNamespace(**fields)


class MarkerStateTests(unittest.TestCase):
    """Real files; only the owner (and explicitly faked fields) of lstat/fstat change."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.reads = []

    def marker(self, data=CONTENT, mode=0o600, name=None):
        path = self.root / (name or 'marker-%d' % len(list(self.root.iterdir())))
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def state(self, path, lstat_changes=None, fstat_changes=None, lstat_path=None, **options):
        real_lstat, real_fstat, real_read = os.lstat, os.fstat, os.read
        def lstat(target):
            return as_root(real_lstat(lstat_path or target), **(lstat_changes or {}))
        def fstat(fd):
            return as_root(real_fstat(fd), **(fstat_changes or {}))
        def read(fd, size):
            # Requested size and bytes returned: the reader never asks for more
            # than the remaining len(content) + 1 budget.
            data = real_read(fd, size)
            self.reads.append((size, len(data)))
            return data
        with mock.patch.object(marker.os, 'lstat', side_effect=lstat), \
             mock.patch.object(marker.os, 'fstat', side_effect=fstat), \
             mock.patch.object(marker.os, 'read', side_effect=read):
            return marker.marker_state(path, CONTENT, **options)

    def test_valid_only_for_root_regular_private_exact_content(self):
        self.assertEqual(self.state(self.marker()), marker.VALID)
        self.assertEqual(self.state(self.marker(mode=0o400)), marker.VALID)
        # Real group/other permission bits (seen identically by lstat and fstat).
        for mode in (0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o660):
            with self.subTest(mode=oct(mode)):
                self.assertEqual(self.state(self.marker(mode=mode)), marker.INVALID)
        # Another owner, seen identically by lstat and fstat.
        self.assertEqual(self.state(self.marker(), lstat_changes={'st_uid': 1000}, fstat_changes={'st_uid': 1000}),
                         marker.INVALID)
        for changes in ({'st_mode': stat.S_IFLNK | 0o777}, {'st_mode': stat.S_IFDIR | 0o700}):
            with self.subTest(changes=changes):
                self.assertEqual(self.state(self.marker(), lstat_changes=changes), marker.INVALID)
        self.assertEqual(self.state(self.marker(b'other\n')), marker.INVALID)
        self.assertEqual(self.state(self.marker(CONTENT + b'\n')), marker.INVALID)
        self.assertEqual(self.state(self.marker(CONTENT[:-1])), marker.INVALID)

    def test_exact_mode_and_single_link_options(self):
        self.assertEqual(self.state(self.marker(mode=0o400), exact_mode=0o600), marker.INVALID)
        self.assertEqual(self.state(self.marker(), exact_mode=0o600, single_link=True), marker.VALID)
        path = self.marker()
        os.link(path, self.root / 'second-link')
        self.assertEqual(self.state(path, exact_mode=0o600, single_link=True), marker.INVALID)
        self.assertEqual(self.state(path), marker.VALID)

    def test_absent_symlink_and_unreadable_markers(self):
        missing = self.root / 'missing'
        self.assertEqual(marker.marker_state(missing, CONTENT), marker.ABSENT)
        target = self.marker()
        link = self.root / 'link'
        link.symlink_to(target)
        self.assertEqual(self.state(link), marker.INVALID)
        with mock.patch.object(marker.os, 'lstat', side_effect=PermissionError('x')):
            self.assertEqual(marker.marker_state(target, CONTENT), marker.INVALID)
        with mock.patch.object(marker.os, 'open', side_effect=PermissionError('x')):
            self.assertEqual(self.state(target), marker.INVALID)
        with mock.patch.object(marker.os, 'read', side_effect=OSError('x')):
            self.assertEqual(marker.marker_state(target, CONTENT), marker.INVALID)
        self.assertRaises(TypeError, marker.marker_state, missing, CONTENT.decode())

    def test_symlink_swapped_in_after_lstat_is_never_followed(self):
        # lstat saw a regular root file; the path is a symlink at open time.
        target = self.marker()
        link = self.root / 'swapped'
        link.symlink_to(target)
        opened = []
        real_open = os.open
        def opener(path, flags, *args):
            opened.append(flags)
            return real_open(path, flags, *args)
        with mock.patch.object(marker.os, 'open', side_effect=opener):
            self.assertEqual(self.state(link, lstat_path=target), marker.INVALID)
        self.assertEqual(len(opened), 1)
        self.assertEqual(opened[0] & (os.O_NOFOLLOW | os.O_CLOEXEC), os.O_NOFOLLOW | os.O_CLOEXEC)
        self.assertEqual(opened[0] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC), 0)

    def test_inode_or_identity_swap_between_lstat_and_open_is_invalid(self):
        # Same content, another inode: lstat saw the first, open gets the second.
        first, second = self.marker(name='first'), self.marker(name='second')
        self.assertEqual(self.state(second, lstat_path=first), marker.INVALID)
        for changes in ({'st_nlink': 2}, {'st_uid': 0, 'st_mode': stat.S_IFREG | 0o644}, {'st_dev': -1}):
            with self.subTest(changes=changes):
                self.assertEqual(self.state(second, fstat_changes=changes), marker.INVALID)

    def test_fifo_swapped_in_never_blocks(self):
        fifo = self.root / 'fifo'
        os.mkfifo(fifo, 0o600)
        self.assertEqual(self.state(fifo, lstat_path=self.marker()), marker.INVALID)

    def test_huge_marker_is_read_only_up_to_content_plus_one_byte(self):
        path = self.marker(CONTENT + b'x' * (8 * 1024 * 1024))
        self.assertEqual(self.state(path), marker.INVALID)
        self.assertEqual(sum(size for _, size in self.reads), len(CONTENT) + 1)
        self.assertLessEqual(max(requested for requested, _ in self.reads), len(CONTENT) + 1)
        self.reads.clear()
        self.assertEqual(self.state(self.marker()), marker.VALID)
        self.assertEqual(sum(size for _, size in self.reads), len(CONTENT))
        self.assertLessEqual(max(requested for requested, _ in self.reads), len(CONTENT) + 1)


class SharedUseTests(unittest.TestCase):
    """The three verifiers delegate to the one helper with their own policy."""

    def test_every_verifier_uses_the_shared_helper_with_its_policy(self):
        cases = (('s0_refusal_verify', 'check_environment', {'exact_mode': 0o600}),
                 ('vm_network_verify', 'check_sentinel', {}),
                 ('ufw_reference_verify', 'require_disposable', {'exact_mode': 0o600, 'single_link': True}))
        for name, function, options in cases:
            with self.subTest(verifier=name):
                module = load(name)
                self.assertEqual(Path(module.marker.__file__).resolve(), HERE / 'disposable_marker.py')
                calls = []
                def fake(path, content, **kwargs):
                    calls.append((content, kwargs))
                    return module.marker.INVALID
                with mock.patch.object(module.marker, 'marker_state', side_effect=fake), \
                     mock.patch.object(module.os, 'geteuid', return_value=0), \
                     mock.patch.object(module.Path, 'is_file', return_value=True):
                    with self.assertRaises(Exception):
                        if function == 'check_sentinel':
                            getattr(module, function)(Path('/nonexistent-marker'))
                        else:
                            getattr(module, function)()
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][1], options)
                expected = getattr(module, 'MARKER_TEXT', None) or getattr(module, 'SENTINEL_CONTENT').encode()
                self.assertEqual(calls[0][0], expected)

    VERIFIERS = ('s0_refusal_verify', 'vm_network_verify', 'ufw_reference_verify')

    def test_one_loader_function_verbatim_in_every_verifier(self):
        """load_path cannot live in disposable_marker.py (it loads it); its copies may not drift."""
        dumps = set()
        for name in self.VERIFIERS:
            with self.subTest(verifier=name):
                tree = ast.parse((HERE / (name + '.py')).read_text())
                loaders = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'load_path']
                self.assertEqual(len(loaders), 1)
                dumps.add(ast.dump(loaders[0]))
                # No other by-path file loading: the old helper copies are gone.
                self.assertFalse([node.name for node in tree.body if isinstance(node, ast.FunctionDef)
                                  and node.name in ('_load_marker_helper', 'load_manifest_module')
                                  and 'spec_from_file_location' in ast.unparse(node)])
                outside = [node.lineno for node in ast.walk(tree) if isinstance(node, ast.Attribute)
                           and node.attr == 'spec_from_file_location' and not any(
                               node in set(ast.walk(loader)) for loader in loaders)]
                self.assertEqual(outside, [])
                # The marker is that loader's first use, from the script's own directory.
                assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                               and [t.id for t in node.targets if isinstance(t, ast.Name)] == ['marker']]
                self.assertEqual([ast.unparse(node.value) for node in assignments],
                                 ["load_path(Path(__file__).resolve().with_name('disposable_marker.py'), "
                                  "'cloudfront_sync_disposable_marker')"])
        self.assertEqual(len(dumps), 1)

    def test_verifiers_load_the_marker_under_isolated_python(self):
        # -I drops the script directory from sys.path; loading by path still works.
        code = ('import importlib.util,sys\n'
                'spec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec)\n'
                'spec.loader.exec_module(v)\n'
                'print(v.marker.__file__, sys.argv[2] in sys.path, "disposable_marker" in sys.modules)\n')
        for name in self.VERIFIERS:
            with self.subTest(verifier=name):
                done = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(HERE / (name + '.py')), str(HERE)],
                                      capture_output=True, text=True, timeout=30)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(done.stdout, '%s False False\n' % (HERE / 'disposable_marker.py'))

    def test_s0_loads_the_bundle_manifest_with_the_same_loader(self):
        module = load('s0_refusal_verify')
        with mock.patch.object(module, 'load_path', return_value='manifest') as loaded:
            self.assertEqual(module.load_manifest_module('/role/files'), 'manifest')
        loaded.assert_called_once_with(Path('/role/files/bundle_manifest.py'), 's0_fixture_bundle_manifest')

    def test_s0_distinguishes_absent_from_invalid(self):
        module = load('s0_refusal_verify')
        for state, message in ((module.marker.ABSENT, 'required'), (module.marker.INVALID, 'invalid')):
            with self.subTest(state=state), mock.patch.object(module.os, 'geteuid', return_value=0), \
                 mock.patch.object(module.marker, 'marker_state', return_value=state):
                self.assertRaisesRegex(module.VerifyError, message, module.check_environment)
        with mock.patch.object(module.os, 'geteuid', return_value=0), \
             mock.patch.object(module.marker, 'marker_state', return_value=module.marker.VALID):
            module.check_environment()


if __name__ == '__main__':
    unittest.main()
