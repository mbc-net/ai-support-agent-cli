import importlib.util
import hashlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / 'molecule/cloudfront_sync/compile_kernel_profile.py'
SPEC = importlib.util.spec_from_file_location('compile_kernel_profile_under_test', SCRIPT)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)
FILES = ROOT / 'roles/cloudfront_sync/files'


class TestCompileKernelProfile(unittest.TestCase):
    def test_current_reviewed_source_reproduces_all_checked_in_profiles(self):
        for os_version in ('22.04', '24.04', '26.04'):
            with self.subTest(os_version=os_version):
                generated = PROFILE.generate(FILES, FILES / 'tests/fixtures/kernel' / os_version, os_version)
                checked_in = (FILES / ('ufw_kernel_profile_' + os_version.split('.')[0] + '.json')).read_bytes()
                self.assertEqual(hashlib.sha256(generated).hexdigest(), hashlib.sha256(checked_in).hexdigest())
                self.assertEqual(generated, checked_in)

    def test_mapping_source_change_fails_closed(self):
        with patch.dict(PROFILE.SOURCE_SHA256, {'ufw_kernel_mapping': '0' * 64}):
            with self.assertRaisesRegex(ValueError, 'reviewed source/fixture hash differs: ufw_kernel_mapping.py'):
                PROFILE.generate(FILES, FILES / 'tests/fixtures/kernel/26.04', '26.04')

    def test_generation_restores_module_registry(self):
        names = ('ufw_kernel', 'ufw_kernel_mapping', 'ufw_integrity')
        missing = object()
        before = {name: sys.modules.get(name, missing) for name in names}
        PROFILE.generate(FILES, FILES / 'tests/fixtures/kernel/26.04', '26.04')
        for name in names:
            with self.subTest(module=name):
                if before[name] is missing:
                    self.assertNotIn(name, sys.modules)
                else:
                    self.assertIs(sys.modules.get(name), before[name])

    def test_failed_module_load_restores_module_registry(self):
        missing = object()
        before = sys.modules.get('ufw_kernel', missing)
        with self.assertRaises(SyntaxError):
            PROFILE.load_modules({'ufw_kernel': b'if'}, FILES)
        if before is missing:
            self.assertNotIn('ufw_kernel', sys.modules)
        else:
            self.assertIs(sys.modules.get('ufw_kernel'), before)


if __name__ == '__main__':
    unittest.main()
