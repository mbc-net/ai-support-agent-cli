"""Source/cache generation proofs run in fresh subprocesses, never host assets."""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest


SOURCE = Path(__file__).parents[1] / 'bundled_source.py'
PRELUDE = r'''
import builtins, hashlib, json, os, py_compile, sys, tempfile, types
from pathlib import Path
source = Path(SOURCE_PATH)
loader = types.ModuleType('fixture_bundled_source')
sys.modules[loader.__name__] = loader
exec(compile(source.read_bytes(), str(source), 'exec'), loader.__dict__)
temporary = tempfile.TemporaryDirectory(prefix='cf-bundle-', dir=str(Path('/tmp').resolve()))  # canonical sticky /tmp on Linux and macOS
root = Path(temporary.name).resolve()
names = ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot')
content = {
 'ufw_integrity': b'from dataclasses import dataclass\nVALUE = "old"\n@dataclass\nclass Box:\n    value: int\n',
 'ufw_kernel': b'VALUE = "old"\n',
 'ufw_kernel_mapping': b'import ufw_integrity\nimport ufw_kernel\nVALUE = "old"\n',
 'ufw_docker_kernel': b'import ufw_kernel\nVALUE = "old"\n',
 'ufw_docker_transition': b'import ufw_docker_kernel\nimport ufw_kernel_mapping\nVALUE = "old"\n',
 'ufw_observation': b'import ufw_integrity\nimport ufw_kernel\nimport ufw_kernel_mapping\nVALUE = "old"\n',
 'nginx_observation': b'VALUE = "old"\n',
 'cloudfront_snapshot': b'import ufw_observation\nVALUE = "old"\n',
}
for name, raw in content.items():
 p=root/(name+'.py');p.write_bytes(raw);p.chmod(0o644)
bundle = loader.BundledSources(root, owner=os.getuid())
'''.replace('SOURCE_PATH', repr(str(SOURCE)))


class BundledSourceTests(unittest.TestCase):
    def check(self, body):
        result = subprocess.run([sys.executable, '-B', '-c', PRELUDE + '\n' + textwrap.dedent(body)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_current_source_ignores_old_timestamp_cache_and_never_opens_it(self):
        self.check('''
            for name in names:
                p=root/(name+'.py');os.utime(p,ns=(1700000000000000000,1700000000000000000))
                py_compile.compile(str(p),doraise=True,invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)
                replacement=root/(name+'.next');replacement.write_bytes(p.read_bytes().replace(b'"old"',b'"new"'))
                os.utime(replacement,ns=(1700000000000000000,1700000000000000000));os.replace(replacement,p)
            before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            def audit(event,args):
                if event=='open' and isinstance(args[0],(str,bytes)):
                    path=os.fsdecode(args[0])
                    if str(root) in path and ('.pyc' in path or '__pycache__' in path):
                        raise AssertionError('bundled bytecode cache accessed')
            sys.addaudithook(audit)
            modules=bundle.load()
            assert all(modules[name].VALUE=='new' for name in names)
            # Disable the audit only by exiting this process: do not read cache
            # files to check them again after installing the guard.
            assert set(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())==set(before)
        ''')

    def test_rollback_ignores_newer_bytecode_with_same_size_and_mtime(self):
        self.check('''
            for name in names:
                p=root/(name+'.py');p.write_bytes(content[name].replace(b'"old"',b'"new"'))
                os.utime(p,ns=(1700000000000000000,1700000000000000000))
                py_compile.compile(str(p),doraise=True,invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP)
                replacement=root/(name+'.next');replacement.write_bytes(content[name])
                os.utime(replacement,ns=(1700000000000000000,1700000000000000000));os.replace(replacement,p)
            assert all(module.VALUE=='old' for module in bundle.load().values())
        ''')

    def test_dependency_order_alias_and_dataclass_identity_are_stable(self):
        self.check('''
            modules=bundle.load();inventory=modules['ufw_integrity'].Box(3)
            assert modules['ufw_kernel_mapping'].ufw_integrity is modules['ufw_integrity']
            assert modules['ufw_kernel_mapping'].ufw_kernel is modules['ufw_kernel']
            assert tuple(modules) == names
            assert modules['ufw_docker_transition'].ufw_docker_kernel is modules['ufw_docker_kernel']
            assert modules['ufw_observation'].ufw_integrity is modules['ufw_integrity']
            assert sys.modules['_cloudfront_sync_integrity_adapter'] is modules['ufw_integrity']
            for unused in range(3):
                again=bundle.load()
                assert again is modules and isinstance(inventory,again['ufw_integrity'].Box)
            try:modules['new']=None
            except TypeError:pass
            else:raise AssertionError('module registry is mutable')
        ''')

    def test_real_bundled_helpers_share_the_same_loaded_dependency_classes(self):
        self.check('''
            for name in names:
                (root/(name+'.py')).write_bytes((source.parent/(name+'.py')).read_bytes())
            modules=bundle.load()
            inventory=modules['ufw_integrity'].UfwInventory((),{})
            kernel=modules['ufw_kernel'].KernelSave.parse(b'*filter\\n:INPUT DROP [0:0]\\nCOMMIT\\n')
            assert modules['ufw_kernel_mapping'].KernelSave is modules['ufw_kernel'].KernelSave
            assert isinstance(kernel,modules['ufw_kernel_mapping'].KernelSave)
            assert isinstance(inventory,bundle.load()['ufw_integrity'].UfwInventory)
            assert modules['ufw_docker_transition'].docker is modules['ufw_docker_kernel']
            assert modules['ufw_docker_transition'].KernelSave is modules['ufw_kernel'].KernelSave
            assert modules['ufw_observation'].KernelSave is modules['ufw_kernel'].KernelSave
            assert modules['ufw_observation'].mapping is modules['ufw_kernel_mapping']
            assert modules['cloudfront_snapshot'].observation is modules['ufw_observation']
            assert modules['ufw_docker_transition'].TransactionProof.actual_docker_calibrated.fget(None) is False
            assert modules['ufw_docker_transition'].IntermediateGeneration.actual_docker_calibrated.fget(None) is False
            from unittest.mock import patch
            with patch.object(modules['ufw_observation'].os,'open',side_effect=AssertionError('constructor I/O')):
                modules['ufw_observation'].Collector()

        ''')

    def test_actual_fifteen_asset_manifest_binds_the_seven_source_graph(self):
        self.check('''
            manifest_source=source.parent/'bundle_manifest.py'
            manifest=types.ModuleType('fixture_manifest_preverified')
            sys.modules[manifest.__name__]=manifest
            exec(compile(manifest_source.read_bytes(),str(manifest_source),'exec'),manifest.__dict__)
            assets={name:('BUNDLE_GENERATION_ID = "'+'0'*64+'"\\nVALUE=1\\n').encode() for name in manifest.ENTRY_NAMES}
            for name in manifest.ASSET_NAMES:
                if name not in assets:assets[name]=(source.parent/name).read_bytes()
            built=manifest.build_bundle(assets)
            verified=manifest.validate_bundle(built.manifest,built.assets,running_generation=built.generation)
            expected=manifest.helper_expectations(verified)
            for name in names:(root/(name+'.py')).write_bytes(assets[name+'.py'])
            bound=loader.BundledSources(root,owner=os.getuid(),expected_hashes=expected)
            modules=bound.load()
            assert tuple(modules)==names and len(built.assets)==16
            assert modules['ufw_docker_transition'].KernelSave is modules['ufw_kernel'].KernelSave
            assert modules['ufw_observation'].KernelSave is modules['ufw_kernel'].KernelSave
            assert bound.load() is modules
        ''')

    def test_expected_hashes_bind_all_sources_before_any_execution(self):
        self.check('''
            (root/'ufw_integrity.py').write_text('import builtins; builtins.bundle_executed=True\\n')
            expected={name:hashlib.sha256((root/(name+'.py')).read_bytes()).hexdigest() for name in names}
            expected['cloudfront_snapshot']='0'*64
            bound=loader.BundledSources(root,owner=os.getuid(),expected_hashes=expected)
            try:bound.load()
            except loader.SourceError:pass
            else:raise AssertionError('wrong expected hash accepted')
            assert not hasattr(builtins,'bundle_executed')
            assert not any(name in sys.modules for name in names)
        ''')

    def test_expected_hash_input_is_copied_and_reuse_keeps_class_identity(self):
        self.check('''
            expected={name:hashlib.sha256((root/(name+'.py')).read_bytes()).hexdigest() for name in names}
            bound=loader.BundledSources(root,owner=os.getuid(),expected_hashes=expected)
            expected['ufw_kernel']='0'*64
            modules=bound.load();box=modules['ufw_integrity'].Box(3)
            assert bound.load() is modules and isinstance(box,modules['ufw_integrity'].Box)
            other=loader.BundledSources(root,owner=os.getuid(),expected_hashes={name:hashlib.sha256((root/(name+'.py')).read_bytes()).hexdigest() for name in names})
            try:other.load()
            except loader.SourceError:pass
            else:raise AssertionError('new loader rebound an existing module graph')
        ''')

    def test_expected_hash_map_has_fixed_exact_names_and_hex_values(self):
        self.check('''
            good={name:hashlib.sha256((root/(name+'.py')).read_bytes()).hexdigest() for name in names}
            for bad in ({}, {name:good[name] for name in names[:3]}, {name:good[name] for name in names[:6]}, {**good,'unknown':'0'*64}, {**good,'ufw_kernel':True},
                        {**good,'ufw_kernel':'bad'}, list(good)):
                try:loader.BundledSources(root,owner=os.getuid(),expected_hashes=bad)
                except loader.SourceError:pass
                else:raise AssertionError('invalid expected hash map accepted')
        ''')

    def test_same_size_and_mtime_source_change_after_load_is_not_reloaded(self):
        self.check('''
            modules=bundle.load();p=root/'ufw_integrity.py';before=p.stat()
            replacement=root/'next';replacement.write_bytes(p.read_bytes().replace(b'"old"',b'"new"'))
            os.utime(replacement,ns=(before.st_atime_ns,before.st_mtime_ns));os.replace(replacement,p)
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('source generation drift accepted')
            assert modules['ufw_integrity'].VALUE=='old'
        ''')

    def test_module_replacement_after_load_is_rejected(self):
        self.check('''
            bundle.load();sys.modules['ufw_kernel']=types.ModuleType('ufw_kernel')
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('module identity drift accepted')
        ''')

    def test_loaded_module_source_path_cannot_be_repointed(self):
        self.check('''
            modules=bundle.load();modules['ufw_kernel_mapping'].__file__='/other/ufw_kernel_mapping.py'
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('module source path drift accepted')
        ''')

    def test_unverified_public_or_private_module_is_never_adopted(self):
        for name in ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot', '_cloudfront_sync_integrity_adapter'):
            with self.subTest(name=name):
                self.check('''
                    name=COLLISION
                    prior=types.ModuleType(name);sys.modules[name]=prior
                    try:bundle.load()
                    except loader.SourceError:pass
                    else:raise AssertionError('unverified module adopted')
                    assert sys.modules[name] is prior
                '''.replace('COLLISION', repr(name)))

    def test_symlink_hardlink_and_missing_source_are_rejected(self):
        for mutation in ("p.unlink();p.symlink_to(root/'ufw_kernel.py')",
                         "p.unlink();os.link(root/'ufw_kernel.py',p)", "p.unlink()"):
            with self.subTest(mutation=mutation):
                self.check('''
                    p=root/'ufw_integrity.py'
                    MUTATION
                    try:bundle.load()
                    except loader.SourceError:pass
                    else:raise AssertionError('unsafe source accepted')
                    assert not any(name in sys.modules for name in names)
                '''.replace('MUTATION', mutation))

    def test_writable_source_or_ancestor_and_wrong_owner_are_rejected(self):
        for mutation in ("(root/'ufw_kernel.py').chmod(0o666)", 'root.chmod(0o777)',
                         'bundle=loader.BundledSources(root,owner=os.getuid()+1)'):
            with self.subTest(mutation=mutation):
                self.check('''
                    MUTATION
                    try:bundle.load()
                    except loader.SourceError:pass
                    else:raise AssertionError('unsafe metadata accepted')
                '''.replace('MUTATION', mutation))

    def test_size_and_aggregate_limits_precede_module_execution(self):
        for mutation in ("(root/'ufw_integrity.py').write_bytes(b'#'+b'x'*(2*1024*1024)+b'\\n')",
                         "[(root/(name+'.py')).write_bytes(b'#'+b'x'*(1500*1024)+b'\\n') for name in names]"):
            with self.subTest(mutation=mutation):
                self.check('''
                    MUTATION
                    try:bundle.load()
                    except loader.SourceError:pass
                    else:raise AssertionError('source budget exceeded')
                    assert not any(name in sys.modules for name in names)
                '''.replace('MUTATION', mutation))

    def test_all_sources_compile_before_any_module_executes(self):
        self.check('''
            (root/'ufw_integrity.py').write_text('import builtins; builtins.bundle_executed=True\\n')
            (root/'ufw_kernel_mapping.py').write_text('invalid ( source\\n')
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('invalid syntax accepted')
            assert not hasattr(builtins,'bundle_executed')
            assert not any(name in sys.modules for name in names)
        ''')

    def test_partial_exec_failure_cleans_only_its_registry_and_stays_failed(self):
        self.check('''
            unrelated=types.ModuleType('unrelated_fixture');sys.modules['unrelated_fixture']=unrelated
            (root/'ufw_observation.py').write_text('raise RuntimeError("sensitive-source-message")\\n')
            try:bundle.load()
            except loader.SourceError as error:assert 'sensitive-source-message' not in str(error)
            else:raise AssertionError('partial execution succeeded')
            assert not any(name in sys.modules for name in names)
            assert '_cloudfront_sync_integrity_adapter' not in sys.modules
            assert sys.modules['unrelated_fixture'] is unrelated
            (root/'ufw_observation.py').write_bytes(content['ufw_observation'])
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('failed process silently retried')
        ''')

    def test_read_race_fails_before_any_execution(self):
        self.check('''
            original=loader.os.read;changed=False
            def racing(fd,size):
                global changed
                value=original(fd,size)
                if not changed:
                    changed=True
                    p=root/'ufw_integrity.py';p.write_bytes(p.read_bytes().replace(b'"old"',b'"new"'))
                return value
            loader.os.read=racing
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('source race accepted')
            assert not any(name in sys.modules for name in names)
        ''')

    def test_import_time_systemexit_cleans_partial_registry_and_is_sanitized(self):
        self.check('''
            (root/'ufw_kernel.py').write_text('raise SystemExit("sensitive-source-message")\\n')
            try:bundle.load()
            except loader.SourceError as error:assert 'sensitive-source-message' not in str(error)
            else:raise AssertionError('unexpected import exit accepted')
            assert not any(name in sys.modules for name in names)
        ''')

    def test_coarse_timestamps_do_not_hide_changed_source_bytes(self):
        self.check('''
            # Model a filesystem tick that does not change mtime/ctime for a
            # same-size in-place write. Real26.04 tmpfs exposed this boundary.
            identity=loader._identity
            loader._identity=lambda info:identity(info)[:-2]+(0,0)
            original=loader.os.read;changed=False
            def racing(fd,size):
                global changed
                value=original(fd,size)
                if not changed:
                    changed=True
                    p=root/'ufw_integrity.py';p.write_bytes(p.read_bytes().replace(b'"old"',b'"new"'))
                return value
            loader.os.read=racing
            try:bundle.load()
            except loader.SourceError:pass
            else:raise AssertionError('same-tick source race accepted')
            assert not any(name in sys.modules for name in names)
        ''')


if __name__ == '__main__':
    unittest.main()
