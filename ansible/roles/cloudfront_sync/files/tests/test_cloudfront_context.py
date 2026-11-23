"""B2 context evidence tests; independent module graph, no actor or OS admission."""
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest
FILES=Path(os.environ.get('CLOUDFRONT_CONTEXT_TEST_FILES',str(Path(__file__).parents[1])))
PRELUDE=r'''
import copy,json,os,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
files=Path(FILES_PATH)
# Linux refuses O_NOATIME (EPERM) unless the caller owns the file or has
# CAP_FOWNER. The production readers run as root; an unprivileged test run
# (the CI runner) must open root-owned ancestors such as / and /tmp, so only
# this test process drops the optional flag. getattr(os,'O_NOATIME',0) in the
# readers then yields 0; nothing else about the opens changes.
if sys.platform=='linux' and os.geteuid()!=0 and hasattr(os,'O_NOATIME'):del os.O_NOATIME
for name in ('ufw_integrity','ufw_kernel','ufw_kernel_mapping','ufw_docker_kernel','ufw_docker_transition','ufw_observation','nginx_observation','cloudfront_snapshot'):
 module=types.ModuleType(name);module.__file__=str(files/(name+'.py'));sys.modules[name]=module
 exec(compile((files/(name+'.py')).read_bytes(),module.__file__,'exec'),module.__dict__)
m=sys.modules['cloudfront_snapshot'];ob=sys.modules['ufw_observation']
class Fixture:
 def __init__(self,os_id='26.04'):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.calls=[];self.now=0
  self.install('/usr/lib/os-release',('ID=ubuntu\nVERSION_ID="'+os_id+'"\n').encode())
  self.install('/etc/ssh/sshd_config',b'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n')
  self.install('/etc/ssh/sshd_config.d/10-fixture.conf',b'# packaged fixture only\n')
  self.install('/etc/default/ssh',b'# defaults\nSSHD_OPTS=\n')
  self.install('/usr/lib/systemd/system/ssh.service',b'[Service]\nExecStart=/usr/sbin/sshd -D $SSHD_OPTS\n')
  for binary in m._CONTEXT_BINARIES:self.install(binary,b'fake package binary; not a vendor oracle')
  self.output={argv:b'[]' if '-j' in argv else b'fixture tool version\n' for argv in m.CONTEXT_COMMANDS}
  self.output[m.CONTEXT_COMMANDS[8]]=b'' # VSOCK-only fixture has no TCP listener.
  self.output[m.CONTEXT_COMMANDS[9]]=b'port 22\nlistenaddress 0.0.0.0:22\n'
  self.output[m.CONTEXT_COMMANDS[10]]=b'Id=ssh.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nFragmentPath=/usr/lib/systemd/system/ssh.service\nExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D $SSHD_OPTS ; ignore_errors=no ; }\nDropInPaths=\n'
 def install(self,path,raw):
  p=self.root/path.lstrip('/');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw);p.chmod(0o644)
 def run(self,argv,**kwargs):
  assert argv in m.CONTEXT_COMMANDS,argv
  assert not any('ufw' in x or 'nft' in x or 'iptables' in x for x in argv)
  self.calls.append((argv,kwargs));return ob.CommandResult(self.output[argv],b'',0)
 def collector(self,**kwargs):return m.ContextCollector(backend='ufw',root=self.root,owner=os.geteuid(),runner=kwargs.pop('runner',self.run),clock=kwargs.pop('clock',lambda:self.now),**kwargs)
 def close(self):self.temp.cleanup()
'''.replace('FILES_PATH',repr(str(FILES)))
class ContextTests(unittest.TestCase):
 def check(self,body):
  p=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20)
  self.assertEqual(p.returncode,0,p.stdout.decode())
 def test_constructor_zero_and_none_zero_io(self):
  self.check(r'''
   with patch.object(os,'open',side_effect=AssertionError('open')),patch.object(os,'mkdir',side_effect=AssertionError('mkdir')),patch.object(ob,'_stream',side_effect=AssertionError('run')):
    m.ContextCollector(backend='ufw')
    c=m.ContextCollector(backend='none',runner=lambda *a,**kw:(_ for _ in ()).throw(AssertionError('run')),clock=lambda:(_ for _ in ()).throw(AssertionError('clock')))
    assert c.collect()==m.NotApplicable('context')
  ''')
 def test_missing_runner_refuses_before_any_observation(self):
  self.check(r'''
   c=m.ContextCollector(backend='ufw',runner=None)
   for method in ('_now','_pass','_read','_directory','_command'):
    calls=[]
    def forbidden(*args,**kwargs):
     calls.append(True);raise AssertionError('observation before runner gate')
    with patch.object(c,method,side_effect=forbidden),patch.object(os,'open',side_effect=forbidden),patch.object(ob,'_stream',side_effect=forbidden):
     try:c.collect()
     except m.SnapshotError as exc:assert str(exc)=='context_sshd_sandbox_unavailable',str(exc)
     else:raise AssertionError('missing runner admitted')
    assert calls==[],method
  ''')
 def test_none_without_runner_skips_all_observation(self):
  self.check(r'''
   c=m.ContextCollector(backend='none',runner=None)
   with patch.object(c,'_now',side_effect=AssertionError('clock')),patch.object(c,'_pass',side_effect=AssertionError('pass')),patch.object(os,'open',side_effect=AssertionError('open')),patch.object(ob,'_stream',side_effect=AssertionError('run')):
    assert c.collect()==m.NotApplicable('context')
  ''')
 def test_default_runner_refuses_unsandboxed_sshd(self):
  self.check(r'''
   c=m.ContextCollector(backend='ufw',runner=None,clock=lambda:0)
   with patch.object(ob,'_stream',side_effect=AssertionError('unsandboxed sshd executed')):
    try:c._command(('/usr/sbin/sshd','-T','-e'),[0,30,0])
    except m.SnapshotError as exc:assert str(exc)=='context_sshd_sandbox_unavailable'
    else:raise AssertionError('default runner allowed sshd -T -e')
  ''')
 def test_falsey_injected_runner_is_not_replaced_by_default_stream(self):
  self.check(r'''
   calls=[]
   class FalseyRunner:
    def __bool__(self):return False
    def __call__(self,argv,**kwargs):
     calls.append(argv);return ob.CommandResult(b'',b'',0)
   c=m.ContextCollector(backend='ufw',runner=FalseyRunner(),clock=lambda:0)
   with patch.object(ob,'_stream',side_effect=AssertionError('default runner selected')):
    assert c._command(('/usr/sbin/sshd','-T','-e'),[0,30,0])==b''
   assert calls==[('/usr/sbin/sshd','-T','-e')]
  ''')
 def test_three_os_exact_capture_is_observed_never_admitted(self):
  self.check(r'''
   for os_id in ('22.04','24.04','26.04'):
    f=Fixture(os_id)
    try:
     c=f.collector();value=c.collect()
     assert value.os_id==os_id and value.stable_raw is True and value.profile=='real-stock-context-observed-v1'
     assert value.disposition=='observed_unverified' and not hasattr(value,'authorized')
     assert tuple(a for a,k in f.calls)==m.CONTEXT_COMMANDS*2
     assert '-e' in m.CONTEXT_COMMANDS[9]
     assert value.samples[0][8][1]==b'' # no fake TCP SSH listener
     assert '192.0.2.' not in repr(value) and 'SSHD_OPTS' not in repr(value)
    finally:f.close()
  ''')
 def test_options_are_strict_finite_and_bounded(self):
  self.check(r'''
   for kwargs in ({'owner':True},{'owner':2**32-1},{'command_timeout':True},{'whole_timeout':float('nan')},{'whole_timeout':float('inf')},{'max_total':True},{'max_output':0},{'root':'relative'},{'root':'/a/../b'},{'runner':3}):
    try:m.ContextCollector(backend='ufw',**kwargs)
    except m.SnapshotError:pass
    else:raise AssertionError(kwargs)
  ''')
 def test_ssh_unknown_match_include_flags_and_unit_are_unsupported(self):
  self.check(r'''
   changes=(('/usr/lib/systemd/system/ssh.service',b'ExecStart=/usr/sbin/sshd -D $SSHD_OPTS\n Environment = SSHD_OPTS=-f/tmp/custom\n'),('/etc/ssh/sshd_config',b'Match all\n'),('/etc/ssh/sshd_config',b'Include /tmp/*.conf\n'),('/etc/ssh/sshd_config.d/10-fixture.conf',b'Include /etc/ssh/other.conf\n'),('/etc/default/ssh',b'SSHD_OPTS="-f /tmp/other"\n'),('/usr/lib/systemd/system/ssh.service',b'ExecStart=/usr/sbin/sshd -D -f /tmp/other\n'))
   for path,raw in changes:
    f=Fixture()
    try:
     f.install(path,raw)
     try:f.collector().collect()
     except m.SnapshotError:pass
     else:raise AssertionError(path)
     assert not f.calls
    finally:f.close()
  ''')
 def test_optional_equals_include_match_rejected_in_main_and_closure_before_commands(self):
  self.check(r'''
   forms=('Include=/tmp/unreviewed.conf','Include = /tmp/unreviewed.conf','Include= /tmp/unreviewed.conf','Include =/tmp/unreviewed.conf','  InClUdE\t=\t/tmp/unreviewed.conf','Include=/etc/ssh/sshd_config.d/*.conf','Match=all','Match = all','Match= all','Match =all','\tMaTcH\t=\tall')
   for path in ('/etc/ssh/sshd_config','/etc/ssh/sshd_config.d/10-fixture.conf'):
    for directive in forms:
     f=Fixture()
     try:
      f.install(path,(directive+'\nPort 22\n').encode())
      try:f.collector().collect()
      except m.SnapshotError as e:assert str(e)=='context_ssh_equals_unsupported',str(e)
      else:raise AssertionError((path,directive,'unreviewed SSH input reached runner'))
      assert f.calls==[],(path,directive,f.calls)
     finally:f.close()
  ''')
 def test_whitespace_include_remains_supported_and_commented_equals_is_not_active(self):
  self.check(r'''
   f=Fixture()
   try:
    f.install('/etc/ssh/sshd_config',b'  Include\t/etc/ssh/sshd_config.d/*.conf\n# Include=/tmp/not-active\nPort 22\n')
    f.install('/etc/ssh/sshd_config.d/10-fixture.conf',b' # Match=all is a comment\n')
    value=f.collector().collect();assert value.disposition=='observed_unverified'
    assert len(f.calls)==2*len(m.CONTEXT_COMMANDS)
   finally:f.close()
  ''')
 def test_symlink_writable_hardlink_and_missing_file_rejected(self):
  self.check(r'''
   for kind in ('symlink','writable','hardlink','missing'):
    f=Fixture()
    try:
     p=f.root/'etc/ssh/sshd_config.d/10-fixture.conf'
     if kind=='symlink':p.unlink();p.symlink_to('/etc/passwd')
     elif kind=='writable':p.chmod(0o666)
     elif kind=='hardlink':os.link(p,p.with_name('copy'))
     else:(f.root/'usr/bin/ip').unlink()
     try:f.collector().collect()
     except m.SnapshotError:pass
     else:raise AssertionError(kind)
     assert not f.calls
    finally:f.close()
  ''')
 def test_bad_command_output_is_not_empty_success(self):
  self.check(r'''
   for kind in ('missing','nonzero','stderr','boolcode','timeout','oversize'):
    f=Fixture()
    try:
     def run(argv,**kw):
      if kind=='missing':return None
      if kind=='timeout':raise ob.ObservationError('command_timeout')
      return ob.CommandResult(b'x'*(kw['max_output']+1) if kind=='oversize' else b'',b'private stderr' if kind=='stderr' else b'',True if kind=='boolcode' else 1 if kind=='nonzero' else 0)
     try:f.collector(runner=run).collect()
     except m.SnapshotError as e:assert 'private' not in str(e)
     else:raise AssertionError(kind)
    finally:f.close()
  ''')
 def test_json_duplicates_nonfinite_shape_and_budget(self):
  self.check(r'''
   for raw in (b'[1]',b'{}',b'[{"x":1,"x":2}]',b'[{"x":NaN}]',b'[{"x":1e999}]',b'['*30+b']'*30,b''):
    f=Fixture()
    try:
     f.output[m.CONTEXT_COMMANDS[1]]=raw
     try:f.collector().collect()
     except m.SnapshotError:pass
     else:raise AssertionError(raw)
    finally:f.close()
  ''')
 def test_raw_finite_float_is_retained_without_normalization_or_authority(self):
  self.check(r'''
   f=Fixture()
   try:
    raw=b'[{"unknown_timer":1.25}]';f.output[m.CONTEXT_COMMANDS[1]]=raw
    value=f.collector().collect();assert value.samples[0][1][1]==raw and value.disposition=='observed_unverified'
   finally:f.close()
  ''')
 def test_unstable_raw_and_files_are_not_promoted(self):
  self.check(r'''
   f=Fixture()
   try:
    count=0
    def run(argv,**kw):
     global count
     out=f.run(argv,**kw);count+=1
     if count==len(m.CONTEXT_COMMANDS):f.install('/etc/ssh/sshd_config.d/10-fixture.conf',b'# changed private config\n')
     if count==len(m.CONTEXT_COMMANDS)+2:return ob.CommandResult(b'[{"changed":true}]',b'',0)
     return out
    value=f.collector(runner=run).collect();assert value.stable_raw is False and value.disposition=='observed_unverified'
   finally:f.close()
  ''')
 def test_absolute_deadline_reaches_runner_without_outer_alarm(self):
  self.check(r'''
   f=Fixture()
   try:
    calls=[]
    def run(argv,**kw):
     calls.append(kw['timeout']);f.now+=.6;return f.run(argv,**kw)
    try:f.collector(runner=run,command_timeout=1,whole_timeout=2).collect()
    except m.SnapshotError as e:assert str(e)=='context_deadline'
    else:raise AssertionError('whole deadline ignored')
    assert len(calls)==4 and calls[0]==1 and 0<calls[-1]<.3
   finally:f.close()
  ''')
 def test_clock_reversal_and_whole_budget_fail_before_commands(self):
  self.check(r'''
   f=Fixture()
   try:
    for kwargs in ({'max_total':128},{'clock':iter((2,1)).__next__}):
     try:f.collector(**kwargs).collect()
     except m.SnapshotError:pass
     else:raise AssertionError(kwargs)
     assert not f.calls
   finally:f.close()
  ''')
 def test_service_custom_dropin_and_exec_argv_rejected(self):
  self.check(r'''
   for old,new in ((b'DropInPaths=',b'DropInPaths=/etc/systemd/system/ssh.service.d/custom.conf'),(b' -D $SSHD_OPTS ;',b' -D -f /tmp/custom ;')):
    f=Fixture()
    try:
     f.output[m.CONTEXT_COMMANDS[10]]=f.output[m.CONTEXT_COMMANDS[10]].replace(old,new)
     try:f.collector().collect()
     except m.SnapshotError as e:assert str(e)=='context_ssh_unit_unsupported'
     else:raise AssertionError(new)
    finally:f.close()
  ''')
 def test_os_identity_malformed_duplicate_unknown_rejected(self):
  self.check(r'''
   for raw in (b'ID=ubuntu\nVERSION_ID=99.04\n',b'ID=ubuntu\nID=ubuntu\nVERSION_ID=26.04\n',b'ID="ubuntu\nVERSION_ID=26.04\n'):
    f=Fixture()
    try:
     f.install('/usr/lib/os-release',raw)
     try:f.collector().collect()
     except m.SnapshotError as e:assert str(e)=='context_os_profile'
     else:raise AssertionError(raw)
     assert not f.calls
    finally:f.close()
  ''')
 def test_include_count_and_file_budget_are_bounded_before_commands(self):
  self.check(r'''
   for kind in ('count','file'):
    f=Fixture()
    try:
     if kind=='count':
      for i in range(129):f.install('/etc/ssh/sshd_config.d/'+str(i)+'.conf',b'# fixture\n')
     else:f.install('/etc/ssh/sshd_config',b'#'*(2*1024*1024+1))
     try:f.collector().collect()
     except m.SnapshotError:pass
     else:raise AssertionError(kind)
     assert not f.calls
    finally:f.close()
  ''')
 def test_hidden_glob_file_not_in_include_closure_and_no_policy_writes(self):
  self.check(r'''
   f=Fixture()
   try:
    f.install('/etc/ssh/sshd_config.d/.hidden.conf',b'Match unsupported-hidden\n')
    original=os.open
    def read_only(path,flags,*a,**kw):
     assert not flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)
     return original(path,flags,*a,**kw)
    with patch.object(os,'open',side_effect=read_only),patch.object(os,'mkdir',side_effect=AssertionError('mkdir')),patch.object(os,'rename',side_effect=AssertionError('rename')),patch.object(os,'fsync',side_effect=AssertionError('fsync')),patch.object(os,'unlink',side_effect=AssertionError('unlink')):
     value=f.collector().collect()
    assert all('/.hidden.conf' not in row[0] for rows in value.files for row in rows)
   finally:f.close()
  ''')
 def test_default_runner_stops_before_unsandboxed_sshd(self):
  self.check(r'''
   f=Fixture()
   try:
    with patch.object(ob,'_stream',side_effect=f.run) as stream:
     c=f.collector();c.runner=None
     try:c.collect()
     except m.SnapshotError as exc:assert str(exc)=='context_sshd_sandbox_unavailable'
     else:raise AssertionError('default runner completed without sshd sandbox')
     stream.assert_not_called()
     assert f.calls==[]
   finally:f.close()
  ''')
if __name__=='__main__':unittest.main()
