"""B0 tests run with a private module graph in an independent interpreter."""
from pathlib import Path
import subprocess
import sys
import textwrap
import unittest
FILES=Path(__file__).parents[1]
PRELUDE=r'''
import ast,base64,copy,hashlib,json,os,sys,tempfile,types,unittest
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
m=sys.modules['cloudfront_snapshot']
# The OS's root-owned sticky temporary directory, canonical on every platform
# (/tmp on Linux, /private/tmp on macOS); never a per-user TMPDIR.
TMP=str(Path('/tmp').resolve())
# The group new entries under TMP receive: the parent's group on macOS (BSD
# semantics, 0 under /private/tmp) and the creating process's group on Linux.
with tempfile.TemporaryDirectory(dir=TMP) as _probe:GROUP=os.stat(_probe).st_gid
def encoded(data):return json.dumps(data,sort_keys=True,separators=(',',':')).encode()

def fixture(os_id='26.04'):
    # Reuse the established independent recorded-kernel fixture builder only;
    # no test methods or public-module loader are executed. Its stub package
    # source pins are scoped to this private test process, not production.
    tree=ast.parse((files/'tests/test_ufw_observation.py').read_bytes())
    node=next(node for node in ast.walk(tree) if isinstance(node,ast.ClassDef) and node.name=='FixtureTests')
    namespace={'unittest':unittest,'tempfile':tempfile,'Path':Path,'os':os,'m':sys.modules['ufw_observation'],
               'FILES':files,'ast':ast,'hashlib':hashlib,'patch':patch,'json':json,'sys':sys}
    exec(compile(ast.Module(body=[node],type_ignores=[]),'recorded-fixture','exec'),namespace)
    value=namespace['FixtureTests']();value.setUp();value.install(os_id)
    return value,value.collector().collect()
def p_data(captured=None):
    return {'integrity_format':'pt-kernel-v1','backend':'ufw' if captured else 'none',
            'config_hash':'a'*64,'enrollment_id':'b'*32,'profile_id':'stock-ubuntu-'+captured.os_id if captured else 'none',
            'inventory':{'manifest':[dict(row) for row in captured.inventory.manifest],
                         'contents':{path:base64.b64encode(raw).decode() for path,raw in captured.inventory.contents.items()}} if captured else None,
            'owned_rules':[]}
NGINX_SHARED='/etc/nginx/cloudfront'
NGINX_BUNDLES=[{'geo_file':'/etc/nginx/geo.conf','realip_file':'/etc/nginx/site.conf'}]
class Unavailable:
    def collect(self):raise sys.modules['nginx_observation'].NginxObservationError('nginx_sandbox_unavailable')
def snapshot(captured,nginx=False):
    class Captured:
        def collect(self):return captured
    options=dict(nginx_shared_dir=NGINX_SHARED,nginx_bundles=NGINX_BUNDLES,nginx_collector=Unavailable()) if nginx else {}
    return m.Snapshotter(backend='ufw',nginx_enabled=nginx,collector=Captured(),**options).collect()
def admit(value,p):return m.admit_snapshot(value,p,config_hash='a'*64,enrollment_id='b'*32,owner=os.geteuid())
def state_data(p):
    return {'version':2,'integrity_format':'pt-kernel-v1','generation_id':'c'*64,'config_hash':'a'*64,'enrollment_id':'b'*32,
            'baseline':p,'ranges':['192.0.2.0/24','2001:db8::/32'],'aws_sync_token':'10','last_success':None}
def journal_data(p):
    return {'version':2,'journal_format':'pt-kernel-v1','generation_id':'c'*64,'config_hash':'a'*64,'enrollment_id':'b'*32,
            'transaction_id':'d'*64,'phase':'prepared','frontier':0,'step_count':0,'baseline':p}
'''.replace('FILES_PATH',repr(str(FILES)))
class SnapshotTests(unittest.TestCase):
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
  self.assertEqual(result.returncode,0,result.stdout.decode())
 def test_constructor_zero_io_and_none_zero_collector(self):
  self.check('''
   class Forbidden:
    @property
    def collect(self):raise AssertionError('firewall read')
   with patch.object(m.observation,'Collector',side_effect=AssertionError('constructor')),patch.object(os,'open',side_effect=AssertionError('open')),patch.object(os,'mkdir',side_effect=AssertionError('mkdir')):
    snapshot=m.Snapshotter(backend='none',nginx_enabled=False,collector=Forbidden()).collect()
   assert type(snapshot.firewall) is m.NotApplicable and type(snapshot.nginx) is m.NotApplicable
  ''')
 def test_nginx_branch_runs_after_firewall_failure(self):
  self.check('''
   class Broken:
    def collect(self):raise RuntimeError('private IP/header secret')
   # The default nginx Collector: this test process is not a root Linux
   # with systemd-run, so it stops before any command or file read.
   ob=sys.modules['ufw_observation']
   with patch.object(ob,'_stream',side_effect=AssertionError('command')):
    value=m.Snapshotter(backend='ufw',nginx_enabled=True,collector=Broken(),nginx_shared_dir=NGINX_SHARED,nginx_bundles=NGINX_BUNDLES).collect()
   assert value.firewall.code=='firewall_observation_failed'
   assert value.nginx==m.ComponentResult('failure','nginx_sandbox_unavailable')
   assert 'secret' not in repr(value)
  ''')
 def test_stock_all_three_profiles_and_p_match(self):
  self.check('''
   for os_id in ('22.04','24.04','26.04'):
    value,captured=fixture(os_id)
    try:
     p=m.parse_p(encoded(p_data(captured)),owner=os.geteuid())
     result=admit(snapshot(captured),p)
     assert result.firewall.status=='admitted' and result.firewall.code=='stock_evidence_verified'
     assert result.firewall.evidence.proof.raw_verified
     assert type(result.nginx) is m.NotApplicable
     assert '192.0.2' not in repr(result) and 'contents' not in repr(p)
    finally:value.doCleanups()
  ''')
 def test_missing_baseline_is_not_enrollment(self):
  self.check('''
   value,captured=fixture()
   try:
    result=m.admit_snapshot(snapshot(captured,True),owner=os.geteuid())
    assert result.firewall.code=='baseline_required'
    assert result.nginx==m.ComponentResult('failure','nginx_sandbox_unavailable')
    assert result.firewall.evidence.proof.raw_verified
   finally:value.doCleanups()
  ''')
 def test_p_drift_config_id_and_profile_mismatch(self):
  self.check('''
   value,captured=fixture()
   try:
    original=p_data(captured)
    for kind in ('extra','mode','bytes','profile','config','enrollment'):
     data=copy.deepcopy(original)
     if kind=='extra':
      raw=b'admin-added\\n';path='/etc/ufw/extra';data['inventory']['contents'][path]=base64.b64encode(raw).decode();data['inventory']['manifest'].append({'path':path,'kind':'file','mode':0o644,'uid':os.geteuid(),'gid':os.getegid(),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()});data['inventory']['manifest'].sort(key=lambda row:row['path'])
     elif kind=='mode':next(row for row in data['inventory']['manifest'] if row['path']=='/etc/ufw/before.rules')['mode']=0o600
     elif kind=='bytes':
      path='/etc/ufw/before.rules';raw=base64.b64decode(data['inventory']['contents'][path])+b'# admin\\n';data['inventory']['contents'][path]=base64.b64encode(raw).decode();row=next(row for row in data['inventory']['manifest'] if row['path']==path);row.update(size=len(raw),sha256=hashlib.sha256(raw).hexdigest())
     elif kind=='profile':data['profile_id']='stock-ubuntu-22.04'
     elif kind=='config':data['config_hash']='e'*64
     else:data['enrollment_id']='e'*32
     p=m.parse_p(encoded(data),owner=os.geteuid());result=admit(snapshot(captured),p)
     assert result.firewall.status=='failure'
     assert result.firewall.code in ('persistent_baseline_mismatch','baseline_context_mismatch')
   finally:value.doCleanups()
  ''')
 def test_docker_extra_tables_are_kept_whole_and_not_admitted(self):
  self.check('''
   from dataclasses import replace
   k=sys.modules['ufw_kernel'];value,captured=fixture()
   try:
    p=m.parse_p(encoded(p_data(captured)),owner=os.geteuid())
    extra=b'*nat\\n:PREROUTING ACCEPT [0:0]\\nCOMMIT\\n'
    changed=replace(captured,selected=(k.KernelSave.parse(captured.selected[0].canonical+extra),captured.selected[1]))
    result=admit(snapshot(changed),p)
    assert result.firewall.code=='nonstock_or_docker_not_authorized'
    assert result.firewall.evidence is changed and b'*nat' in result.firewall.evidence.selected[0].canonical
   finally:value.doCleanups()
  ''')
 def test_mismatch_inactive_source_legacy_native_rejected(self):
  self.check('''
   from dataclasses import replace
   value,captured=fixture()
   try:
    p=m.parse_p(encoded(p_data(captured)),owner=os.geteuid());u=sys.modules['ufw_integrity'];k=sys.modules['ufw_kernel']
    for kind in ('kernel','inactive','source','legacy','native'):
     changed=captured
     if kind=='kernel':changed=replace(captured,selected=(k.KernelSave.parse(captured.selected[0].canonical.replace(b':INPUT DROP',b':INPUT ACCEPT')),captured.selected[1]))
     elif kind=='inactive':
      contents=dict(captured.inventory.contents);contents['/etc/ufw/ufw.conf']=b'ENABLED=no\\nLOGLEVEL=low\\n';rows=[dict(row) for row in captured.inventory.manifest];row=next(row for row in rows if row['path']=='/etc/ufw/ufw.conf');row.update(size=len(contents[row['path']]),sha256=hashlib.sha256(contents[row['path']]).hexdigest());changed=replace(captured,inventory=u.UfwInventory(tuple(rows),contents))
     elif kind=='source':changed=replace(captured,source_hashes=())
     elif kind=='legacy':changed=replace(captured,legacy=(b'*filter\\n:INPUT DROP [0:0]\\nCOMMIT\\n',b''))
     else:
      native=json.loads(captured.native.canonical);native['nftables'].append({'table':{'family':'inet','name':'private-extra'}});changed=replace(captured,native=k.NativeRuleset.parse(encoded(native),profile='nftables-1.1.6-schema1'))
     result=admit(snapshot(changed,True),p)
     assert result.firewall.code=='stock_evidence_unsupported' and result.nginx.code=='nginx_sandbox_unavailable'
   finally:value.doCleanups()
  ''')
 def test_strict_options_component_and_forged_data(self):
  self.check('''
   bundle={'geo_file':'/etc/nginx/geo.conf','realip_file':'/etc/nginx/site.conf'}
   for kwargs in ({'backend':True,'nginx_enabled':False},{'backend':'none','nginx_enabled':1},{'backend':'other','nginx_enabled':False},
                  # An enabled nginx needs its shared directory and bundles.
                  {'backend':'none','nginx_enabled':True},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED},
                  {'backend':'none','nginx_enabled':True,'nginx_bundles':[bundle]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[],'nginx_collector':Unavailable()},
                  {'backend':'none','nginx_enabled':True,'nginx_bundles':[bundle],'nginx_collector':Unavailable()},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[{'geo_file':'/etc/nginx/geo.conf'}]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[dict(bundle,extra='x')]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[{'geo_file':1,'realip_file':'/r'}]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':bundle},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':b'/etc/nginx/cloudfront','nginx_bundles':[bundle]}):
    try:m.Snapshotter(**kwargs)
    except m.SnapshotError as error:assert str(error)=='invalid_snapshot_options'
    else:raise AssertionError('bad option accepted')
   # Paths the default Collector refuses at construction fail the nginx
   # component only, without any read (test_nginx_collector covers more).
   for kwargs in ({'backend':'none','nginx_enabled':True,'nginx_shared_dir':'relative','nginx_bundles':[bundle]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,'nginx_bundles':[bundle,bundle]},
                  {'backend':'none','nginx_enabled':True,'nginx_shared_dir':NGINX_SHARED,
                   'nginx_bundles':[{'geo_file':'/etc/nginx/a/../geo.conf','realip_file':'/etc/nginx/site.conf'}]}):
    with patch.object(os,'open',side_effect=AssertionError('open')):value=m.Snapshotter(**kwargs).collect()
    assert value.nginx==m.ComponentResult('failure','nginx_observation_failed') and value.firewall==m.NotApplicable('firewall')
   # Disabled: nothing is constructed, validated or read, whatever is passed.
   class Exploding:
    @property
    def collect(self):raise AssertionError('nginx read')
   with patch.object(sys.modules['nginx_observation'],'Collector',side_effect=AssertionError('constructor')),patch.object(os,'open',side_effect=AssertionError('open')):
    for options in ({},{'nginx_shared_dir':'relative','nginx_bundles':'x','nginx_collector':Exploding()}):
     value=m.Snapshotter(backend='none',nginx_enabled=False,**options).collect()
     assert value.nginx==m.NotApplicable('nginx')
   for data in ({'version':True},{'version':2,'unknown':'private IP/header secret'}):
    for reader in (m.parse_state,m.parse_journal):
     try:reader(encoded(data))
     except m.SnapshotError as error:assert 'secret' not in str(error)
     else:raise AssertionError('unknown schema accepted')
   class Pretend:
    def __eq__(self,other):return True
   forged=m.ObservationSnapshot('none',False,Pretend(),m.NotApplicable('nginx'))
   try:m.admit_snapshot(forged)
   except m.SnapshotError:pass
   else:raise AssertionError('forged none accepted')
  ''')
 def test_p_state_and_journal_data_only_no_io(self):
  self.check('''
   data=p_data();state=state_data(data);journal=journal_data(data)
   with patch.object(os,'open',side_effect=AssertionError('open')),patch.object(os,'mkdir',side_effect=AssertionError('mkdir')):
    p=m.parse_p(encoded(data));s=m.parse_state(encoded(state));j=m.parse_journal(encoded(journal))
    assert s.disposition=='pt_state_data_only' and j.disposition=='manual_ledger_not_connected'
    assert m.parse_state(b'{"version":1}').disposition=='manual_legacy_or_unproven_state'
    for version in (1,2):assert m.parse_journal(encoded({'version':version})).disposition=='manual_legacy_pending'
   assert '192.0.2' not in repr(s) and 'contents' not in repr(j)
  ''')
 def test_unknown_private_schema_duplicates_float_and_size(self):
  self.check('''
   for reader in (m.parse_p,m.parse_state,m.parse_journal):
    for raw in (b'{"version":1,"version":1}',b'{"version":1.0}',b'x'*(m.MAX_RECORD+1),bytearray(b'{}')):
     try:reader(raw)
     except m.SnapshotError:pass
     else:raise AssertionError('invalid private bytes accepted')
   for reader,data in ((m.parse_p,p_data()),(m.parse_state,state_data(p_data())),(m.parse_journal,journal_data(p_data()))):
    changed=copy.deepcopy(data);changed['extra']=True
    try:reader(encoded(changed))
    except m.SnapshotError:pass
    else:raise AssertionError('unknown key accepted')
  ''')
 def test_inventory_metadata_base64_and_owned_identity_strict(self):
  self.check('''
   value,captured=fixture()
   try:
    original=p_data(captured)
    for kind in ('uid','gid','mode','size','path','extra','missing','base64','owned'):
     data=copy.deepcopy(original);row=next(row for row in data['inventory']['manifest'] if row['path']=='/etc/ufw/user.rules')
     if kind=='uid':row['uid']=True
     elif kind=='gid':row['gid']=2**32-1
     elif kind=='mode':row['mode']=0o666
     elif kind=='size':row['size']=True
     elif kind=='path':row['path']='/etc/ufw//user.rules'
     elif kind=='extra':row['unrecognized']=0
     elif kind=='missing':data['inventory']['manifest']=[r for r in data['inventory']['manifest'] if r['path']!='/etc/ufw']
     elif kind=='base64':data['inventory']['contents']['/etc/ufw/user.rules']+='\\n'
     else:data['owned_rules']=[{'source':'198.51.100.99/32','port':443,'comment':'unclaimed'}]
     try:m.parse_p(encoded(data),owner=os.geteuid())
     except m.SnapshotError as error:assert '198.51.100' not in str(error)
     else:raise AssertionError('invalid P accepted')
   finally:value.doCleanups()
  ''')
 def test_state_and_journal_strict_scalar_context(self):
  self.check('''
   p=p_data()
   for reader,initial,cases in ((m.parse_state,state_data(p),{'last_success':True,'enrollment_id':'f'*32,'aws_sync_token':10,'ranges':['0.0.0.0/0']}),(m.parse_journal,journal_data(p),{'frontier':True,'step_count':True,'phase':'unknown','enrollment_id':'f'*32})):
    for key,value in cases.items():
     data=copy.deepcopy(initial);data[key]=value
     try:reader(encoded(data))
     except m.SnapshotError:pass
     else:raise AssertionError('invalid scalar/context accepted')
  ''')
 def test_owned_mapping_order_and_comment_identity_preserved(self):
  self.check('''
   value,captured=fixture()
   try:
    u=sys.modules['ufw_integrity'];data=p_data(captured);rules=[]
    for family,leaf in ((4,'user.rules'),(6,'user6.rules')):
     document=u.UserRulesDocument.parse(captured.inventory.contents['/etc/ufw/'+leaf],u.UserFileProfile(family))
     for block in document.blocks:
      f=block.fields
      if f[0:2]==('allow','tcp') and f[2].isdigit() and f[6]=='in' and f[5]!='any':
       source=str(__import__('ipaddress').ip_network(f[5],strict=True));comment=bytes.fromhex(block.comment_hex).decode() if block.comment_hex else ''
       rule=u.ManagedTuple(source,int(f[2]),comment)
       if rule.block(document.profile)==block:rules.append({'source':source,'port':int(f[2]),'comment':comment})
    assert len(rules)>=2
    data['owned_rules']=list(reversed(rules))
    p=m.parse_p(encoded(data),owner=os.geteuid())
    assert p.owned_rules==tuple((r['source'],r['port'],r['comment']) for r in data['owned_rules'])
    assert admit(snapshot(captured),p).firewall.status=='admitted'
    data['owned_rules'][0]['comment']='changed-owner'
    try:m.parse_p(encoded(data),owner=os.geteuid())
    except m.SnapshotError:pass
    else:raise AssertionError('unconfirmed comment accepted')
   finally:value.doCleanups()
  ''')
 def test_state_reader_does_not_claim_transition_or_recovery_authority(self):
  self.check('''
   value,captured=fixture()
   try:
    data=p_data(captured);state=state_data(data)
    # B0 deliberately reads shape/context; B1 must verify the independent
    # ranges/owned/config-port/protected-domain relationship before actors.
    result=m.parse_state(encoded(state),owner=os.geteuid())
    assert result.disposition=='pt_state_data_only'
    assert not hasattr(result,'authorized') and not hasattr(result,'policy_verified')
    assert m.parse_journal(encoded(journal_data(data)),owner=os.geteuid()).disposition=='manual_ledger_not_connected'
   finally:value.doCleanups()
  ''')
 def test_private_state_reader_reports_typed_absence_without_creating_paths(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    base=Path(td);parent=base/'var'/'lib'/'cloudfront-sync';parent.mkdir(parents=True,mode=0o700)
    private=parent/'private';before=set(parent.iterdir())
    result=m.read_private_state(private,owner=os.geteuid(),group=GROUP)
    assert result.disposition=='private_directory_absent'
    assert not private.exists() and set(parent.iterdir())==before
  ''')
 def test_private_state_reader_keeps_legacy_state_manual_and_pending_blocks(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=Path(td)/'private';private.mkdir(mode=0o700)
    state={'version':1,'initialized':True}
    path=private/'state.json';path.write_bytes(encoded(state));path.chmod(0o600)
    result=m.read_private_state(private,owner=os.geteuid(),group=GROUP)
    assert result.disposition=='manual_legacy_or_unproven_state'
    assert result.state.raw==encoded(state)
    pending=private/'pending.json';pending.write_bytes(b'{"version":1}');pending.chmod(0o600)
    result=m.read_private_state(private,owner=os.geteuid(),group=GROUP)
    assert result.disposition=='pending_or_companion_manual'
  ''')
 def test_private_state_reader_rejects_symlink_and_unknown_entry(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    base=Path(td);private=base/'private';private.mkdir(mode=0o700)
    (private/'unexpected').write_bytes(b'x')
    result=m.read_private_state(private,owner=os.geteuid(),group=GROUP)
    assert result.disposition=='unknown_private_entries_manual'
    (private/'unexpected').unlink()
    target=base/'target';target.write_bytes(b'{"version":1}');target.chmod(0o600)
    (private/'state.json').symlink_to(target)
    try:m.read_private_state(private,owner=os.geteuid(),group=GROUP)
    except m.SnapshotError:pass
    else:raise AssertionError('symlink state accepted')
  ''')
 def test_private_state_reader_rebinds_named_path_after_parent_swap(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    root=Path(td);parent=root/'cloudfront-sync';parent.mkdir(mode=0o700);private=parent/'private';private.mkdir(mode=0o700)
    old=root/'old-parent';real_scandir=os.scandir;changed=[False]
    def swap(fd):
     if not changed[0]:
      os.rename(parent,old);parent.mkdir(mode=0o700);new=parent/'private';new.mkdir(mode=0o700)
      pending=new/'pending.json';pending.write_bytes(b'{"version":1}');pending.chmod(0o600);changed[0]=True
     return real_scandir(fd)
    with patch.object(m.os,'scandir',side_effect=swap):
     try:m.read_private_state(private,owner=os.geteuid(),group=GROUP)
     except m.SnapshotError:pass
     else:raise AssertionError('renamed private parent accepted')
    assert changed[0] and (parent/'private'/'pending.json').is_file()
  ''')
 def test_private_state_reader_rebinds_absent_path_and_bounds_entries_early(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    root=Path(td);parent=root/'cloudfront-sync';parent.mkdir(mode=0o700);private=parent/'private';old=root/'old-parent'
    real_stat=os.stat;changed=[False]
    def swap_absent(path,*args,**kwargs):
     if path=='private' and kwargs.get('dir_fd') is not None and not changed[0]:
      os.rename(parent,old);parent.mkdir(mode=0o700);new=parent/'private';new.mkdir(mode=0o700)
      pending=new/'pending.json';pending.write_bytes(b'{"version":1}');pending.chmod(0o600);changed[0]=True
     return real_stat(path,*args,**kwargs)
    with patch.object(m.os,'stat',side_effect=swap_absent):
     try:m.read_private_state(private,owner=os.geteuid(),group=GROUP)
     except m.SnapshotError:pass
     else:raise AssertionError('rebound absent path accepted')
    assert changed[0]
    crowded=parent/'crowded';crowded.mkdir(mode=0o700)
    for i in range(65):
     p=crowded/('x'+str(i));p.write_bytes(b'x');p.chmod(0o600)
    with patch.object(m.os,'read',side_effect=AssertionError('file contents read before entry cap')):
     try:m.read_private_state(crowded,owner=os.geteuid(),group=GROUP)
     except m.SnapshotError as exc:assert str(exc)=='private_state_entry_budget'
     else:raise AssertionError('over-budget entries accepted')
  ''')
 def test_private_state_reader_rechecks_every_file_after_complete_capture(self):
  self.check('''
   with tempfile.TemporaryDirectory(dir=TMP) as td:
    private=Path(td)/'private';private.mkdir(mode=0o700)
    pending=private/'pending.json';pending.write_bytes(b'{"version":1}');pending.chmod(0o600)
    real_scandir=os.scandir;calls=[0]
    def replace_after_file_read(fd):
     calls[0]+=1
     if calls[0]==2:
      pending.write_bytes(b'{"version":2}')
     return real_scandir(fd)
    with patch.object(m.os,'scandir',side_effect=replace_after_file_read):
     try:m.read_private_state(private,owner=os.geteuid(),group=GROUP)
     except m.SnapshotError as exc:assert str(exc)=='private_state_file_changed'
     else:raise AssertionError('changed captured file accepted')
    assert calls[0]==2 and pending.read_bytes()==b'{"version":2}'
  ''')
if __name__=='__main__':unittest.main()
