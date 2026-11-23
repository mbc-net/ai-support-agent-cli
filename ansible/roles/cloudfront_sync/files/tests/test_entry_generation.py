"""Real entry gates in isolated processes; no host policy commands or services."""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest

FILES=Path(__file__).parents[1]
PRELUDE=r'''
import ast,base64,builtins,contextlib,hashlib,io,json,os,subprocess,sys,tempfile,types
from pathlib import Path
from unittest.mock import patch
files=Path(FILES_PATH)
def module(filename,name):
    value=types.ModuleType(name);sys.modules[name]=value
    exec(compile((files/filename).read_bytes(),str(files/filename),'exec'),value.__dict__)
    return value
manifest=module('bundle_manifest.py','fixture_manifest')
assets={name:(files/name).read_bytes() for name in manifest.ASSET_NAMES}
built=manifest.build_bundle(assets)
def entry(name='cloudfront-sync.py',generation=None):
    value=types.ModuleType('fixture_entry');sys.modules[value.__name__]=value
    source=built.assets[name] if generation is None else assets[name].replace(b'0'*64,generation.encode(),1)
    exec(compile(source,str(files/name),'exec'),value.__dict__)
    return value

def config():
    return {'host_address':'192.0.2.10','firewall':{'backend':'none','ports':[443]},'nginx':{'enabled':False,'shared_dir':'/etc/nginx/cloudfront','bundles':[]},'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
def payload(bundle=built):
    return {'version':2,'bundle_manifest':base64.b64encode(bundle.manifest).decode(),
            'bundle_assets':{name:base64.b64encode(raw).decode() for name,raw in bundle.assets.items()},
            'config':config(),'timer_enabled':False,'approve_token':'',
            'rendered_assets':{'sync_service':'[Service]\nType=oneshot\n','sync_timer':'[Timer]\nOnCalendar=hourly\n','guard_service':'[Service]\nType=oneshot\n','guard_timer':'[Timer]\nOnCalendar=hourly\n','monitor':'{"zabbix_export":{}}\n'}}
def encode(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def tree(bundle=built):
    temporary=tempfile.TemporaryDirectory(prefix='cf-real-entries-',dir='/fixture' if Path('/fixture').is_dir() else None)
    root=Path(temporary.name).resolve()
    for name,raw in bundle.assets.items():
        path=root/name;path.write_bytes(raw);path.chmod(0o755 if name in manifest.ENTRY_NAMES else 0o644)
    (root/'bundle-manifest.json').write_bytes(bundle.manifest);(root/'bundle-manifest.json').chmod(0o644)
    return temporary,root
'''.replace('FILES_PATH',repr(str(FILES)))
class EntryGenerationTests(unittest.TestCase):
    def check(self,body):
        result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout.decode())
    def test_actual_three_entries_share_one_stamp_and_identical_fixed_stub(self):
        self.check('''
            stubs=[]
            for name in manifest.ENTRY_NAMES:
                raw=assets[name].decode();tree=ast.parse(raw)
                assert raw.count('BUNDLE_GENERATION_ID = "'+'0'*64+'"')==1
                stubs.append(raw.split('# BEGIN FIXED BUNDLE ENTRY STUB',1)[1].split('# END FIXED BUNDLE ENTRY STUB',1)[0])
            assert len(set(stubs))==1
            assert len(built.assets)==16
        ''')
    def test_actual_candidate_installer_validate_only_authenticates_inline_generation(self):
        self.check('''
            installer=entry('install_cloudfront_sync.py')
            with patch.object(installer.os,'open',side_effect=AssertionError('file open')) as opened,patch.object(installer.os,'mkdir',side_effect=AssertionError('mkdir')) as made,patch.object(installer.Installer,'install',side_effect=AssertionError('old actor')) as installed:
                checked=installer.validate_candidate(encode(payload()))
            assert checked.generation==built.generation
            assert not opened.called and not made.called and not installed.called
        ''')
    def test_inline_cli_validate_only_and_mutating_fail_closed(self):
        self.check('''
            for arguments in (['--validate-only'],[]):
                result=subprocess.run([sys.executable,'-B','-c',built.assets['install_cloudfront_sync.py'].decode(),*arguments],input=encode(payload()),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
                if arguments:
                    assert result.returncode==0 and json.loads(result.stdout)['installation_ready'] is False
                else:
                    assert result.returncode==1 and json.loads(result.stderr)=={'error':'cohort_installer_unavailable'}
        ''')
    def test_old_running_literal_cannot_accept_new_bundle_before_any_compile(self):
        self.check('''
            old=entry();changed=dict(assets);changed['ufw_observation.py']+=b'# generation B\\n';new=manifest.build_bundle(changed)
            with patch.object(builtins,'compile',side_effect=AssertionError('pre-exec')) as compiled:
                try:old._bundle_verified(new.manifest,dict(new.assets),built.generation)
                except old.BundleEntryError:pass
                else:raise AssertionError('old literal accepted new assets')
            assert not compiled.called
            assert not any(name in sys.modules for name in old._BG_BOOT_MODULES+old._BG_HELPERS)
        ''')
    def test_old_loaded_entry_refuses_correct_new_disk_before_config_or_engine(self):
        self.check('''
            old=entry();changed=dict(assets);changed['ufw_observation.py']+=b'# generation B\\n';new=manifest.build_bundle(changed)
            temporary,root=tree(new)
            assert hashlib.sha256((root/'cloudfront-sync.py').read_bytes()).hexdigest()==json.loads(new.manifest)['assets']['cloudfront-sync.py']['sha256']
            gate=old._bundle_runtime;fixture_owner=os.geteuid();refused=[]
            def stale_gate():
                try:return gate(directory=root,owner=fixture_owner)
                except old.BundleEntryError as error:
                    assert str(error)=='running_generation_differs'
                    refused.append(str(error))
                    raise
            # verify-cohort is a read command, so it really reaches the bundle
            # gate (refused commands now stop before the gate is consulted).
            with patch.object(old,'_bundle_runtime',side_effect=stale_gate),patch.object(old,'exclusive_lock',return_value=contextlib.nullcontext()),patch.object(old.os,'geteuid',return_value=0),patch.object(old,'_bundle_config',side_effect=AssertionError('config read')) as config_read,contextlib.redirect_stderr(io.StringIO()):
                assert old.main(['verify-cohort'])==1
            assert refused==['running_generation_differs']
            assert not config_read.called
            assert old._BUNDLE_RUNTIME is None
            temporary.cleanup()
        ''')
    def test_actual_disk_gate_loads_seven_class_consistent_modules_without_cache(self):
        self.check('''
            runtime=entry();temporary,root=tree()
            cache=root/'__pycache__';cache.mkdir();(cache/'ufw_observation.cpython-bad.pyc').write_bytes(b'bad old cache')
            def audit(event,args):
                if event=='open' and isinstance(args[0],(str,bytes)) and str(root) in os.fsdecode(args[0]) and '.pyc' in os.fsdecode(args[0]):raise AssertionError('cache read')
            sys.addaudithook(audit)
            modules=runtime._bundle_runtime(directory=root,owner=os.geteuid())
            assert tuple(modules)==runtime._BG_HELPERS
            assert modules['ufw_observation'].KernelSave is modules['ufw_kernel'].KernelSave
            assert modules['ufw_docker_transition'].KernelSave is modules['ufw_kernel'].KernelSave
            assert modules['ufw_docker_transition'].TransactionProof.actual_docker_calibrated.fget(None) is False
        ''')
    def test_sixth_helper_race_prevents_all_helper_execution(self):
        self.check('''
            changed=dict(assets);changed['ufw_integrity.py']+=b'\\nimport builtins;builtins.helper_executed=True\\n';candidate=manifest.build_bundle(changed)
            runtime=entry(generation=candidate.generation);temporary,root=tree(candidate)
            verified=runtime._bundle_verified
            def racing(*args):
                result=verified(*args)
                path=root/'ufw_observation.py';path.write_bytes(path.read_bytes()+b'# concurrent drift\\n')
                return result
            runtime._bundle_verified=racing
            try:runtime._bundle_runtime(directory=root,owner=os.geteuid())
            except runtime.BundleEntryError:pass
            else:raise AssertionError('raced helper accepted')
            assert not hasattr(builtins,'helper_executed')
            assert not any(name in sys.modules for name in runtime._BG_HELPERS)
        ''')
    def test_bootstrap_hash_rows_inputs_and_unknown_schema_fail_before_compile(self):
        self.check('''
            runtime=entry()
            for kind in ('row','inputs','unknown','bool','eleven'):
                value=json.loads(built.manifest)
                if kind=='row':value['assets']['bundle_manifest.py']['sha256']='f'*64
                elif kind=='inputs':
                    value['assets']['bundle_manifest.py']['sha256']='f'*64;value['inputs']['assets']['bundle_manifest.py']['source_sha256']='f'*64
                elif kind=='unknown':value['extra']=True
                elif kind=='bool':value['inputs']['version']=True
                else:del value['inputs']['assets']['ufw_observation.py'];del value['assets']['ufw_observation.py']
                raw=encode(value)+b'\\n'
                with patch.object(builtins,'compile',side_effect=AssertionError('pre-exec')) as compiled:
                    try:runtime._bundle_verified(raw,dict(built.assets),built.generation)
                    except runtime.BundleEntryError:pass
                    else:raise AssertionError('forged manifest accepted')
                assert not compiled.called,kind
        ''')
    def test_whole_source_budget_precedes_ast_compile_and_exec(self):
        self.check('''
            runtime=entry();huge={name:b'#'+b'x'*(650*1024)+b'\\n' for name in runtime._BG_NAMES}
            with patch.object(builtins,'compile',side_effect=AssertionError('pre-exec')) as compiled:
                try:runtime._bundle_verified(built.manifest,huge,built.generation)
                except runtime.BundleEntryError:pass
                else:raise AssertionError('whole source budget ignored')
            assert not compiled.called
            assert not any(name in sys.modules for name in runtime._BG_HELPERS)
        ''')
    def test_candidate_schema_encoding_and_deployment_budgets(self):
        self.check('''
            installer=entry('install_cloudfront_sync.py')
            for kind in ('legacy','unknown','float_version','bool_version','bad64','extra_asset','unit','monitor','monitor_float','config','token'):
                value=payload()
                if kind=='legacy':value={'config':config(),'assets':{},'timer_enabled':False,'approve_token':''}
                elif kind=='unknown':value['extra']=True
                elif kind=='float_version':value['version']=2.0
                elif kind=='bool_version':value['version']=True
                elif kind=='bad64':value['bundle_manifest']+='\\n'
                elif kind=='extra_asset':value['bundle_assets']['extra.py']='cGFzcw=='
                elif kind=='unit':value['rendered_assets']['guard_timer']='x'*(64*1024+1)
                elif kind=='monitor':value['rendered_assets']['monitor']='[]'
                elif kind=='monitor_float':value['rendered_assets']['monitor']='{"unsupported":0.5}'
                elif kind=='config':value['config']['host_address']='x'*(64*1024+1)
                else:value['approve_token']='secret-invalid'
                with patch.object(builtins,'compile',side_effect=AssertionError('pre-exec')) as compiled:
                    try:installer.validate_candidate(encode(value))
                    except (installer.InstallError,installer.BundleEntryError):pass
                    else:raise AssertionError('invalid candidate accepted')
                assert not compiled.called,kind
            raw=encode(payload()).replace(b'"version":2',b'"version":2,"version":2')
            try:installer.validate_candidate(raw)
            except installer.BundleEntryError:pass
            else:raise AssertionError('duplicate payload key accepted')
        ''')
    def test_disk_missing_symlink_hardlink_mode_owner_rejected(self):
        self.check('''
            runtime=entry()
            for kind in ('missing','symlink','hardlink','mode','owner'):
                temporary,root=tree();path=root/'ufw_observation.py'
                if kind=='missing':path.unlink()
                elif kind=='symlink':path.unlink();path.symlink_to(root/'ufw_kernel.py')
                elif kind=='hardlink':path.unlink();os.link(root/'ufw_kernel.py',path)
                elif kind=='mode':path.chmod(0o666)
                try:runtime._bundle_runtime(directory=root,owner=os.geteuid()+1 if kind=='owner' else os.geteuid())
                except runtime.BundleEntryError:pass
                else:raise AssertionError('unsafe disk asset accepted')
                assert not any(name in sys.modules for name in runtime._BG_HELPERS)
                temporary.cleanup()
        ''')
    def test_guard_generation_success_is_never_healthy(self):
        self.check('''
            guard=entry('cloudfront-integrity-guard.py');error=io.StringIO()
            with patch.object(guard,'existing_shared_lock',return_value=contextlib.nullcontext()),patch.object(guard,'_bundle_runtime',return_value={}),patch.object(guard.os,'geteuid',return_value=0),patch.object(guard.sys,'argv',['guardian']),contextlib.redirect_stderr(error):
                assert guard.main()==1
            assert json.loads(error.getvalue())=={'error':'guardian_not_ready','healthy':False}
        ''')
    def test_guard_missing_lock_never_creates_one(self):
        self.check('''
            guard=entry('cloudfront-integrity-guard.py');opened=[]
            class Parent:
                st_mode=0o41777;st_uid=0
            def opening(path,flags):
                opened.append(flags);raise FileNotFoundError()
            def parent_stat(path):
                result=Parent();result.st_mode=0o41777 if path==Path('/run/lock') else 0o40755;return result
            with patch.object(Path,'lstat',parent_stat),patch.object(guard.os,'open',side_effect=opening):
                try:
                    with guard.existing_shared_lock():raise AssertionError('missing lock accepted')
                except FileNotFoundError:pass
            assert opened and not any(flags&os.O_CREAT for flags in opened)
        ''')
    def test_actual_host_actor_and_engine_refuse_without_a_verified_cohort(self):
        self.check('''
            runtime=entry();assert runtime._BUNDLE_RUNTIME is None
            with patch.object(runtime.os,'replace') as replaced,patch.object(runtime.Path,'mkdir') as made,patch.object(runtime,'_bundle_runtime') as gate:
                for operation in (lambda:runtime.Host().command(['ufw','enable']),lambda:runtime.Host().write_nginx(config(),{}),lambda:runtime.Engine(config())):
                    try:operation()
                    except runtime.SyncError as error:assert str(error)=='runtime_actor_not_connected'
                    else:raise AssertionError('ungated actor accepted')
            assert not replaced.called and not made.called and not gate.called
        ''')
    def test_actual_disk_gate_refuses_preexisting_unverified_adapter_alias(self):
        # Two fresh processes differing only in the seeded alias: the gate is
        # one-shot per process, so the control cannot be a retry in-process.
        for seeded in (True,False):
            with self.subTest(seeded=seeded):
                self.check('''
                    runtime=entry();temporary,root=tree();alias='_cloudfront_sync_integrity_adapter'
                    if SEEDED:
                        prior=types.ModuleType('unverified');sys.modules[alias]=prior
                        try:runtime._bundle_runtime(directory=root,owner=os.geteuid())
                        except runtime.BundleEntryError:pass
                        else:raise AssertionError('unverified adapter alias adopted')
                        assert sys.modules[alias] is prior
                        assert not any(name in sys.modules for name in runtime._BG_HELPERS)
                        assert runtime._BUNDLE_RUNTIME is None
                    else:
                        modules=runtime._bundle_runtime(directory=root,owner=os.geteuid())
                        assert sys.modules[alias] is modules['ufw_integrity']
                    temporary.cleanup()
                '''.replace('SEEDED',repr(seeded)))
    def test_engine_config_is_read_only_after_lock_and_generation_gate(self):
        self.check('''
            runtime=entry();events=[]
            @contextlib.contextmanager
            def lock(fd):events.append('lock');yield
            def gate():events.append('gate');return {}
            def config_read():events.append('config');return config()
            with patch.object(runtime,'exclusive_lock',lock),patch.object(runtime,'_bundle_runtime',gate),patch.object(runtime.os,'geteuid',return_value=0),patch.object(runtime,'check_path'),patch.object(runtime,'_bundle_config',config_read),contextlib.redirect_stdout(io.StringIO()):
                assert runtime.main(['verify-cohort'])==0
            assert events==['lock','gate','config']
        ''')
    def test_inherited_lock_rejects_wrong_descriptor_inode_mode_and_links(self):
        self.check('''
            runtime=entry();temporary=tempfile.TemporaryDirectory(dir='/fixture' if Path('/fixture').is_dir() else None);root=Path(temporary.name).resolve()
            lock=root/'sync.lock';lock.write_bytes(b'');lock.chmod(0o600);other=root/'other.lock';other.write_bytes(b'');other.chmod(0o600)
            runtime.LOCK=lock;fd=os.open(lock,os.O_RDWR);wrong=os.open(other,os.O_RDWR)
            try:
                if os.geteuid()==0:
                    with runtime.exclusive_lock(fd):pass
                for kind in ('wrong','mode','link'):
                    if kind=='mode':lock.chmod(0o644)
                    if kind=='link':lock.chmod(0o600);os.link(lock,root/'linked.lock')
                    try:
                        with runtime.exclusive_lock(wrong if kind=='wrong' else fd):raise AssertionError('unsafe inherited lock accepted')
                    except runtime.SyncError:pass
            finally:os.close(fd);os.close(wrong);temporary.cleanup()
        ''')
    def test_config_double_read_and_duplicate_keys_are_fail_closed(self):
        self.check('''
            runtime=entry()
            for rows in ((b'{"a":1}',b'{"a":2}'),(b'{"a":1,"a":1}',b'{"a":1,"a":1}')):
                iterator=iter(rows)
                with patch.object(runtime,'_bg_capture',side_effect=lambda *args,**kw:{'config.json':next(iterator)}):
                    try:runtime._bundle_config()
                    except runtime.BundleEntryError:pass
                    else:raise AssertionError('changed/duplicate config accepted')
            try:runtime._bg_json_bytes(b'{"ratio":1e999}',1024,integers_only=False)
            except runtime.BundleEntryError:pass
            else:raise AssertionError('overflow nonfinite float accepted')
            raw=encode(config())
            with patch.object(runtime,'_bg_capture',return_value={'config.json':raw}):
                assert runtime._bundle_config()['limits']['min_ratio']==.8
        ''')
    def test_installer_candidate_old_literal_refused_before_any_mutation(self):
        self.check('''
            installer=entry('install_cloudfront_sync.py');changed=dict(assets);changed['ufw_observation.py']+=b'# newer\\n';new=manifest.build_bundle(changed)
            with patch.object(installer.os,'open',side_effect=AssertionError('open')) as opened,patch.object(installer.Installer,'install',side_effect=AssertionError('old actor')) as installed:
                try:installer.validate_candidate(encode(payload(new)))
                except installer.BundleEntryError:pass
                else:raise AssertionError('inline A accepted candidate B')
            assert not opened.called and not installed.called
        ''')
    def test_direct_default_installer_actor_is_closed_before_locks(self):
        self.check('''
            installer=entry('install_cloudfront_sync.py')
            with patch.object(installer.Installer,'lock',side_effect=AssertionError('lock')) as locked,patch.object(installer.os,'mkdir',side_effect=AssertionError('mkdir')) as made:
                try:installer.Installer().install({})
                except installer.InstallError as error:assert str(error)=='cohort_installer_unavailable'
                else:raise AssertionError('C3 old actor is reachable')
            assert not locked.called and not made.called
        ''')
    def test_secure_config_fd_reads_and_unsafe_modes(self):
        self.check('''
            runtime=entry();temporary=tempfile.TemporaryDirectory(dir='/fixture' if Path('/fixture').is_dir() else None);root=Path(temporary.name).resolve()
            path=root/'config.json';path.write_bytes(encode(config()));path.chmod(0o640)
            original_path=runtime._BgPath
            def mapped(value):return root if str(value)=='/etc/cloudfront-sync' else original_path(value)
            with patch.object(runtime,'_BgPath',mapped):
                if os.geteuid()==0:
                    assert runtime._bundle_config()==config()
                else:
                    try:runtime._bundle_config()
                    except runtime.BundleEntryError:pass
                    else:raise AssertionError('non-root owned production config accepted')
                path.chmod(0o666)
                try:runtime._bundle_config()
                except runtime.BundleEntryError:pass
                else:raise AssertionError('writable config accepted')
            temporary.cleanup()
        ''')
    def test_verified_cohort_is_not_permission_for_old_host_or_transaction(self):
        self.check('''
            runtime=entry();temporary,root=tree();runtime._bundle_runtime(directory=root,owner=os.geteuid())
            with patch.object(runtime.os,'replace') as replaced,patch.object(runtime.Path,'mkdir') as made:
                for operation in (lambda:runtime.Host().command(['ufw','enable']),lambda:runtime.Host().write_nginx(config(),{}),lambda:runtime.Engine(config())):
                    try:operation()
                    except runtime.SyncError as error:assert str(error)=='runtime_actor_not_connected'
                    else:raise AssertionError('cohort authentication authorized old actor')
            assert not replaced.called and not made.called
        ''')
    def test_engine_all_old_cli_commands_stop_before_private_directory_or_actor(self):
        self.check('''
            runtime=entry()
            for args in (['preflight'],['plan'],['sync'],['apply','--approve=secret'],['import','--approve=secret'],['import-plan','--legacy-state=/tmp/not-read']):
                error=io.StringIO()
                with patch.object(runtime,'exclusive_lock',return_value=contextlib.nullcontext()) as lock,patch.object(runtime,'_bundle_runtime',return_value={}) as gate,patch.object(runtime,'_bundle_config',return_value=config()) as config_read,patch.object(runtime.os,'geteuid',return_value=0),patch.object(runtime.Path,'mkdir') as made,patch.object(runtime,'Engine') as engine,contextlib.redirect_stderr(error):
                    assert runtime.main(args)==1
                assert not any(spy.called for spy in (lock,gate,config_read,made,engine))
                assert json.loads(error.getvalue())=={'error':'runtime_actor_not_connected'}
                assert 'secret' not in error.getvalue()
        ''')
    def test_guard_shares_only_verified_snapshot_module(self):
        self.check('''
            runtime=entry();temporary,root=tree();modules=runtime._bundle_runtime(directory=root,owner=os.geteuid())
            guard=entry('cloudfront-integrity-guard.py');guard._BUNDLE_RUNTIME=runtime._BUNDLE_RUNTIME
            settings=config();settings['nginx'].update(enabled=True,bundles=[{'geo_file':'/etc/nginx/geo.conf','realip_file':'/etc/nginx/site.conf'}])
            shared=modules['cloudfront_snapshot'];nginx=modules['nginx_observation']
            # The guardian passes the config's nginx settings to the bundle's own
            # nginx Collector. Its sandbox precondition is made to fail explicitly,
            # whatever host runs the test (root Linux with systemd-run and nginx
            # included): not root; or root on Linux with the executables it
            # checks absent. Either way it stops before any command.
            with tempfile.TemporaryDirectory() as empty:
                missing=tuple(empty+path for path in nginx.SANDBOX_EXECUTABLES)
                not_root=(patch.object(nginx.os,'geteuid',return_value=1000),)
                root_without_executables=(patch.object(nginx.sys,'platform','linux'),patch.object(nginx.os,'geteuid',return_value=0),
                                          patch.object(nginx,'SANDBOX_EXECUTABLES',missing))
                for precondition in (not_root,root_without_executables):
                    with contextlib.ExitStack() as stack:
                        for patcher in precondition:stack.enter_context(patcher)
                        stream=stack.enter_context(patch.object(modules['ufw_observation'],'_stream',side_effect=AssertionError('command')))
                        other=guard.readonly_components(settings)
                    assert not stream.called
                    assert type(other.firewall) is shared.NotApplicable
                    assert type(other.nginx) is shared.ComponentResult and other.nginx==shared.ComponentResult('failure','nginx_sandbox_unavailable')
                    assert not hasattr(other,'healthy')
            # Disabled nginx: not applicable, nothing read.
            other=guard.readonly_components(config())
            assert other.nginx==shared.NotApplicable('nginx')
            # Enabled without bundles is not a snapshot.
            settings['nginx']['bundles']=[]
            try:guard.readonly_components(settings)
            except guard.BundleEntryError as error:assert str(error)=='readonly_snapshot_unavailable'
            else:raise AssertionError('enabled nginx without bundles accepted')
        ''')
if __name__=='__main__':unittest.main()
