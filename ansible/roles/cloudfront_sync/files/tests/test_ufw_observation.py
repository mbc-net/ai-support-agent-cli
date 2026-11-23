"""Fixed read-only collector: recorded kernel evidence, no host firewall calls."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

if __name__ != '__main__':
    class IsolatedCollectorTests(unittest.TestCase):
        def test_collector_in_fresh_subprocess(self):
            import subprocess
            result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve())],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
            sys.stderr.write(result.stdout.decode())
            self.assertEqual(result.returncode, 0, 'isolated collector tests failed')
else:
    FILES = Path(__file__).parents[1]
    for name in ('ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_observation'):
        if name in sys.modules:
            continue
        spec = importlib.util.spec_from_file_location(name, FILES / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    m = sys.modules['ufw_observation']

    class CollectorTests(unittest.TestCase):
        def test_constructor_has_zero_io(self):
            with patch.object(m.os, 'open', side_effect=AssertionError('open')), patch.object(m, 'capture_ufw', side_effect=AssertionError('capture')):
                m.Collector(runner=lambda argv, **kw: self.fail('command'))
        def test_strict_constructor_types(self):
            for kwargs in ({'owner':True}, {'timeout':True}, {'max_output':True}, {'max_total':True}, {'root':'relative'}):
                with self.subTest(kwargs=kwargs), self.assertRaises(m.ObservationError):
                    m.Collector(**kwargs)


    class FixtureTests(unittest.TestCase):
        def setUp(self):
            self.temp = tempfile.TemporaryDirectory()
            self.addCleanup(self.temp.cleanup)
            self.root = Path(self.temp.name).resolve()
            self.sources = {'backend_iptables.py': b'class Backend:\n    def _write_rules(self):\n        return 1\n    def _read_rules(self):\n        return 2\n',
                            'common.py': b'def format_rule():\n    return 3\n'}
            hashes = {}
            for name, function in m.SOURCE_HASHES:
                raw = self.sources[name]
                node = next(n for n in ast.walk(ast.parse(raw)) if isinstance(n, ast.FunctionDef) and n.name == function)
                hashes[name,function] = hashlib.sha256(b''.join(raw.splitlines(keepends=True)[node.lineno-1:node.end_lineno])).hexdigest()
            self.patcher = patch.object(m, 'SOURCE_HASHES', hashes)
            self.patcher.start(); self.addCleanup(self.patcher.stop)
            self.calls = []
            self.edit = None
            self.os_id = '26.04'
            self.install(self.os_id)
        def install(self, os_id):
            self.os_id = os_id
            self.fixture = FILES/'tests/fixtures/kernel'/os_id
            entries = {'/usr/lib/os-release': ('ID=ubuntu\nVERSION_ID="'+os_id+'"\n').encode(),
                       '/etc/default/ufw': b'IPV6=yes\nDEFAULT_INPUT_POLICY=DROP\nDEFAULT_OUTPUT_POLICY=ACCEPT\nDEFAULT_FORWARD_POLICY=DROP\nDEFAULT_APPLICATION_POLICY=SKIP\nMANAGE_BUILTINS=no\nIPT_SYSCTL=/etc/ufw/sysctl.conf\nIPT_MODULES=\"\"\n', '/etc/ufw/ufw.conf': b'ENABLED=yes\nLOGLEVEL=low\n'}
            entries.update({'/usr/lib/python3/dist-packages/ufw/'+k:v for k,v in self.sources.items()})
            entries.update({'/etc/ufw/'+p.name:p.read_bytes() for p in (self.fixture/'stock').iterdir()})
            entries.update({'/etc/ufw/'+leaf:(self.fixture/('before.'+leaf)).read_bytes() for leaf in ('user.rules','user6.rules')})
            for logical, raw in entries.items():
                path = self.root/logical.lstrip('/')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
        def runner(self, argv, **options):
            self.assertIn(argv, m.ALLOWED)
            self.assertNotEqual(argv[0], 'ufw')
            self.calls.append(argv)
            expected = m.mapping.BACKEND_PROFILES[self.os_id]['versions']
            if argv == m.PACKAGE:
                raw = ('install ok installed\n'+m.UFW_VERSIONS[self.os_id]+'\n').encode()
            elif len(argv) == 2 and argv[1] == '--version':
                tool = argv[0]
                value = expected.get(tool)
                if value is None:
                    value = ('ip6tables-save' if tool.startswith('ip6') else 'iptables-save')+' '+expected['iptables'].split()[1]+(' (legacy)' if 'legacy' in tool else ' (nf_tables)')
                raw = (value+'\n').encode()
            else:
                leaf = 'native.json' if argv[0] == 'nft' else argv[0]
                raw = (self.fixture/('before.'+leaf)).read_bytes()
            result = m.CommandResult(raw,b'',0)
            return self.edit(argv,result) if self.edit else result
        def collector(self, **kw):
            return m.Collector(self.root,owner=os.geteuid(),runner=self.runner,**kw)
        def test_all_three_recorded_stock_profiles(self):
            for os_id in m.UFW_VERSIONS:
                with self.subTest(os_id=os_id):
                    self.install(os_id); self.calls=[]
                    observation = self.collector().collect()
                    self.assertTrue(m.admit_stock(observation,owner=os.geteuid()).raw_verified)
                    self.assertEqual(len(self.calls),26)
                    self.assertNotIn('203.0.113.',repr(observation))
                    self.assertEqual(observation.mode,'read_only_observation')
        def test_constructor_and_collect_never_write(self):
            flags=[]
            original=m.os.open
            def opening(path, mode, *args, **kwargs):
                flags.append(mode)
                self.assertFalse(mode & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
                return original(path,mode,*args,**kwargs)
            with patch.object(m.os,'open',side_effect=opening), patch.object(m.os,'mkdir',side_effect=AssertionError('mkdir')):
                self.collector().collect()
            self.assertTrue(flags)
        def test_missing_stderr_exit_and_wrong_types_rejected(self):
            for result in (None, m.CommandResult(b'',b'',0),m.CommandResult(b'private',b'private',0),m.CommandResult(b'private',b'',1),m.CommandResult(b'private',b'',True),m.CommandResult('bad',b'',0)):
                with self.subTest(result=type(result).__name__):
                    self.edit=lambda argv,value: result
                    with self.assertRaises(m.ObservationError) as error:self.collector().collect()
                    self.assertNotIn('private',str(error.exception))
        def test_timeout_and_missing_never_empty(self):
            for error in (TimeoutError('secret'),FileNotFoundError('secret')):
                self.edit=lambda argv,value: (_ for _ in ()).throw(error)
                with self.assertRaises(m.ObservationError) as caught:self.collector().collect()
                self.assertNotIn('secret',str(caught.exception))
        def test_empty_selected_or_native_rejected_but_empty_legacy_valid(self):
            for argv in m.READS[:3]:
                self.edit=lambda command,value: m.CommandResult(b'',b'',0) if command==argv else value
                with self.assertRaises(m.ObservationError):self.collector().collect()
            self.edit=None
            self.assertEqual(self.collector().collect().legacy,(b'',b''))
        def test_legacy_is_observed_without_implicit_stock_admission(self):
            self.edit=lambda argv,value: m.CommandResult(b'*filter\n:INPUT DROP [0:0]\nCOMMIT\n',b'',0) if argv==m.READS[3] else value
            observed=self.collector().collect()
            self.assertTrue(observed.legacy[0])
            with self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=os.geteuid())
        def test_stable_raw_mismatch_returned_but_not_admitted(self):
            path=self.root/'etc/ufw/user.rules'
            path.write_bytes(path.read_bytes().replace(b'9000',b'9001'))
            observed=self.collector().collect()
            with self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=os.geteuid())
        def test_stable_opaque_native_extra_is_retained_and_not_admitted(self):
            def edit(argv,value):
                if argv==m.READS[2]:
                    data=json.loads(value.stdout);data['nftables'].append({'table':{'family':'inet','name':'opaque'}})
                    return m.CommandResult(json.dumps(data).encode(),b'',0)
                return value
            self.edit=edit
            observed=self.collector().collect()
            self.assertIn(b'opaque',observed.native.canonical)
            with self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=os.geteuid())
        def test_second_pass_changes_each_plane_rejected(self):
            for target in m.READS:
                counts={}
                def edit(argv,value):
                    counts[argv]=counts.get(argv,0)+1
                    if argv==target and counts[argv]==2:
                        if argv==m.READS[2]:
                            raw=json.loads(value.stdout);raw['nftables'].append({'table':{'family':'inet','name':'drift'}})
                            return m.CommandResult(json.dumps(raw).encode(),b'',0)
                        return m.CommandResult(value.stdout+b'*drift\n:DRIFT ACCEPT [0:0]\nCOMMIT\n',b'',0)
                    return value
                self.edit=edit
                with self.subTest(target=target),self.assertRaises(m.ObservationError):self.collector().collect()
        def test_file_change_between_passes_rejected(self):
            def edit(argv,value):
                if argv==m.READS[-1] and self.calls.count(argv)==1:
                    with (self.root/'etc/ufw/before.rules').open('ab') as file:file.write(b'# changed\n')
                return value
            self.edit=edit
            with self.assertRaises(m.ObservationError):self.collector().collect()
        def test_source_and_os_unknown_and_symlink_rejected(self):
            for logical,raw in (('/usr/lib/os-release',b'ID=ubuntu\nVERSION_ID="99"\n'),('/usr/lib/python3/dist-packages/ufw/common.py',b'def format_rule():\n    return 4\n')):
                path=self.root/logical.lstrip('/');original=path.read_bytes();path.write_bytes(raw)
                with self.assertRaises(m.ObservationError):self.collector().collect()
                path.write_bytes(original)
            path=self.root/'usr/lib/os-release';path.unlink();path.symlink_to('/etc/passwd')
            with self.assertRaises(m.ObservationError):self.collector().collect()
        def test_inactive_duplicate_unknown_and_defaults_do_not_admit(self):
            for leaf, data in (('ufw/ufw.conf', b'ENABLED=no\nLOGLEVEL=low\n'),
                               ('ufw/ufw.conf', b'ENABLED=yes\nENABLED=yes\nLOGLEVEL=low\n'),
                               ('ufw/ufw.conf', b'ENABLED=yes\nLOGLEVEL=low\nUNKNOWN=yes\n'),
                               ('default/ufw', b'IPV6=no\n')):
                path=self.root/'etc'/leaf; original=path.read_bytes();path.write_bytes(data)
                observed=self.collector().collect()
                with self.subTest(data=data),self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=os.geteuid())
                path.write_bytes(original)
        def test_command_and_aggregate_budgets(self):
            for options in ({'max_output':32},{'max_total':512}):
                with self.subTest(options=options),self.assertRaises(m.ObservationError):self.collector(**options).collect()
        def test_forged_fields_and_capture_bytes_rejected(self):
            from dataclasses import replace
            observed=self.collector().collect()
            for changed in (replace(observed,mode='approved'),replace(observed,os_id='22.04'),replace(observed,selected=observed.selected[::-1]),replace(observed,commands=observed.commands[:-1]),replace(observed,versions=()),replace(observed,source_hashes=())):
                with self.subTest(changed=changed.mode),self.assertRaises(m.ObservationError):m.admit_stock(changed,owner=os.geteuid())
        def test_reviewed_counters_only_can_change(self):
            counts={}
            def edit(argv,value):
                counts[argv]=counts.get(argv,0)+1
                if counts[argv]==2 and argv in m.READS[:2]:
                    return m.CommandResult(value.stdout.replace(b'[0:0]',b'[123:456]'),b'',0)
                if counts[argv]==2 and argv==m.READS[2]:
                    raw=json.loads(value.stdout)
                    for row in raw['nftables']:
                        for expr in row.get('rule',{}).get('expr',[]):
                            if 'counter' in expr:expr['counter']={'packets':123,'bytes':456}
                    return m.CommandResult(json.dumps(raw).encode(),b'',0)
                return value
            self.edit=edit
            self.assertTrue(m.admit_stock(self.collector().collect(),owner=os.geteuid()).raw_verified)
        def test_stable_native_compat_mismatch_is_not_admission(self):
            def edit(argv,value):
                if argv==m.READS[2]:
                    raw=json.loads(value.stdout)
                    next(row['chain'] for row in raw['nftables'] if row.get('chain',{}).get('name')=='INPUT')['prio']=-10
                    return m.CommandResult(json.dumps(raw).encode(),b'',0)
                return value
            self.edit=edit
            observed=self.collector().collect()
            with self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=os.geteuid())
        def test_source_comments_drift_despite_identical_function_hash(self):
            def edit(argv,value):
                if argv==m.READS[-1] and self.calls.count(argv)==1:
                    path=self.root/'usr/lib/python3/dist-packages/ufw/common.py'
                    path.write_bytes(path.read_bytes()+b'# drift\n')
                return value
            self.edit=edit
            with self.assertRaises(m.ObservationError):self.collector().collect()
        def test_os_duplicate_malformed_and_package_status_fail(self):
            path=self.root/'usr/lib/os-release';original=path.read_bytes()
            for raw in (original+b'ID=ubuntu\n',b'ID=ubuntu\nVERSION_ID=""26.04""\n'):
                path.write_bytes(raw)
                with self.assertRaises(m.ObservationError):self.collector().collect()
            path.write_bytes(original)
            self.edit=lambda argv,value:m.CommandResult(b'deinstall ok config-files\n'+m.UFW_VERSIONS[self.os_id].encode()+b'\n',b'',0) if argv==m.PACKAGE else value
            with self.assertRaises(m.ObservationError):self.collector().collect()
        def test_forged_inventory_byte_hash_mismatch(self):
            from dataclasses import replace
            observed=self.collector().collect();inventory=observed.inventory
            contents=dict(inventory.contents);contents['/etc/ufw/ufw.conf']+=b'# forge\n'
            forged=sys.modules['ufw_integrity'].UfwInventory(inventory.manifest,contents)
            with self.assertRaises(m.ObservationError):m.admit_stock(replace(observed,inventory=forged),owner=os.geteuid())
        def test_forged_inventory_metadata_strictly_rejected(self):
            from dataclasses import replace
            observed=self.collector().collect();inventory=observed.inventory
            def forged(rows,contents=None):
                return replace(observed,inventory=sys.modules['ufw_integrity'].UfwInventory(rows,dict(inventory.contents) if contents is None else contents))
            for key,value in (('uid',os.geteuid()+1),('uid',True),('gid',True),('gid',2**32-1),('gid',2**64),('mode',0o4755),('mode',0o777),('mode',True),('extra','unknown'),('path','/etc/ufw//user.rules'),('path','/etc/passwd')):
                rows=[dict(row) for row in inventory.manifest]
                next(row for row in rows if row['path']=='/etc/ufw/user.rules')[key]=value
                with self.subTest(key=key,value=value),self.assertRaises(m.ObservationError):m.admit_stock(forged(rows),owner=os.geteuid())
            rows=[dict(row) for row in inventory.manifest if row['path']!='/etc/ufw']
            with self.assertRaises(m.ObservationError):m.admit_stock(forged(rows),owner=os.geteuid())
            rows=[dict(row) for row in inventory.manifest];rows.append(dict(rows[-1]))
            with self.assertRaises(m.ObservationError):m.admit_stock(forged(rows),owner=os.geteuid())
            with self.assertRaises(m.ObservationError):m.admit_stock(observed,owner=True)
            if os.geteuid()!=0:
                with self.assertRaises(m.ObservationError):m.admit_stock(observed)
        def test_unexpected_command_rejected_before_runner(self):
            with self.assertRaises(m.ObservationError):self.collector()._command(('ufw','status'),[0],[])
            self.assertEqual(self.calls,[])

    if sys.platform == 'linux':
        class StreamingTests(unittest.TestCase):
            def test_stream_budget_and_timeout(self):
                for code, options in (("import os;os.write(1,b'x'*1000000)",{'max_output':100,'timeout':2}),('import time;time.sleep(10)',{'max_output':100,'timeout':.05})):
                    with self.subTest(code=code),self.assertRaises(m.ObservationError):m._stream((sys.executable,'-B','-c',code),**options)
            def test_exited_leader_pipe_holder_cleaned_on_timeout_and_limit(self):
                import signal
                import time
                code = __import__('textwrap').dedent("""
        import json,os,sys,time
        pid=os.fork()
        if pid: os._exit(7 if sys.argv[2]=='nonzero' else 0)
        with open(sys.argv[1],'x') as file: json.dump({'pid':os.getpid(),'group':os.getpgrp()},file)
        if sys.argv[2]=='limit': os.write(1,b'x'*4096)
        if sys.argv[2]=='readerror': os.write(1,b'owned-read-error')
        if sys.argv[2] in ('success','nonzero'):
            os.close(1);os.close(2)
        for i in range(1500):
            with open(sys.argv[1]+'.heartbeat','w') as file:file.write(str(i))
            time.sleep(.01)
        """)
                def running(record):
                    heartbeat=Path(str(record)+'.heartbeat')
                    before=heartbeat.read_bytes() if heartbeat.exists() else None
                    time.sleep(.06)
                    after=heartbeat.read_bytes() if heartbeat.exists() else None
                    return before != after
                for mode in ('timeout','limit','readerror','success','nonzero'):
                    with tempfile.TemporaryDirectory() as directory:
                        record=Path(directory)/'own-child.json'
                        child=None
                        try:
                            unrelated=m.subprocess.Popen((sys.executable,'-B','-c','import time;time.sleep(15)'),start_new_session=True)
                            try:
                                if mode in ('timeout','limit','readerror'):
                                    original_read=m.os.read
                                    def reading(fd,size):
                                        part=original_read(fd,size)
                                        if part.startswith(b'owned-read-error'):raise OSError('private error must not escape')
                                        return part
                                    with self.subTest(mode=mode),patch.object(m.os,'read',reading),self.assertRaises(m.ObservationError) as error:
                                        m._stream((sys.executable,'-B','-c',code,str(record),mode),timeout=.3,max_output=1024)
                                    self.assertNotIn('private',str(error.exception))
                                else:
                                    result=m._stream((sys.executable,'-B','-c',code,str(record),mode),timeout=2,max_output=1024)
                                    self.assertEqual(result.returncode,7 if mode=='nonzero' else 0)
                                self.assertIsNone(unrelated.poll(), 'unrelated owned group was killed')
                            finally:
                                unrelated.kill();unrelated.wait()

                            child=json.loads(record.read_text())
                            deadline=time.monotonic()+1
                            while running(record) and time.monotonic()<deadline:time.sleep(.02)
                            self.assertFalse(running(record), 'owned pipe holder survived')
                        finally:
                            if child and running(record):
                                os.kill(child['pid'],signal.SIGKILL)
            def test_unsupported_reapers_and_missing_wait_flags_launch_nothing(self):
                import signal
                with patch.object(m.signal,'getsignal',return_value=signal.SIG_IGN),patch.object(m.subprocess,'Popen',side_effect=AssertionError('launch')):
                    with self.assertRaises(m.ObservationError):m._stream(('unused',),timeout=1,max_output=100)
                flag=m.os.WNOWAIT
                try:
                    delattr(m.os,'WNOWAIT')
                    with patch.object(m.subprocess,'Popen',side_effect=AssertionError('launch')):
                        with self.assertRaises(m.ObservationError):m._stream(('unused',),timeout=1,max_output=100)
                finally:m.os.WNOWAIT=flag
            def test_wait_never_reaps_before_owned_group_cleanup(self):
                events=[]
                original_wait=m.subprocess.Popen.wait
                original_kill=m.os.killpg
                def waiting(process,*args,**kwargs):
                    events.append(('wait',process.pid))
                    return original_wait(process,*args,**kwargs)
                def killing(pid,sig):
                    events.append(('kill',pid))
                    return original_kill(pid,sig)
                with patch.object(m.subprocess.Popen,'wait',waiting),patch.object(m.os,'killpg',killing),patch.object(m.subprocess.Popen,'poll',side_effect=AssertionError('premature poll')):
                    result=m._stream((sys.executable,'-B','-c','pass'),timeout=2,max_output=100)
                self.assertEqual(result.returncode,0)
                self.assertEqual([event[0] for event in events],['kill','wait'])
            def test_owner_and_gid_stat_domain_are_bounded(self):
                for owner in (-1,True,2**32-1,2**32):
                    with self.subTest(owner=owner),self.assertRaises(m.ObservationError):m.Collector(owner=owner)
            def test_both_streams_retained_and_return_code(self):
                value=m._stream((sys.executable,'-B','-c',"import os;os.write(1,b'out');os.write(2,b'err');raise SystemExit(7)"),timeout=2,max_output=100)
                self.assertEqual((value.stdout,value.stderr,value.returncode),(b'out',b'err',7))

    else:
        class UnsupportedPlatformTests(unittest.TestCase):
            def test_default_stream_rejects_before_launch(self):
                with patch.object(m.subprocess,'Popen',side_effect=AssertionError('launch')):
                    with self.assertRaisesRegex(m.ObservationError,'unsupported_child_ownership'):
                        m._stream(('unused',),timeout=1,max_output=100)
                sys.stderr.write('Non-Linux: launch rejection verified; stream semantics require the separate Ubuntu 22/24/26 proofs.\n')

    if __name__ == '__main__':
        unittest.main()
