"""B1 pure semantic ledger tests in fresh processes; never kernel actors."""
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
for name in ('ufw_integrity','ufw_kernel','ufw_kernel_mapping','ufw_docker_kernel','ufw_docker_transition','ufw_observation','nginx_observation','cloudfront_snapshot'):
 module=types.ModuleType(name);module.__file__=str(files/(name+'.py'));sys.modules[name]=module
 exec(compile((files/(name+'.py')).read_bytes(),module.__file__,'exec'),module.__dict__)
m=sys.modules['cloudfront_snapshot']
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

def config(backend='none',ports=None):
 return {'host_address':'192.0.2.10','firewall':{'backend':backend,'ports':ports or [443]},'nginx':{'enabled':False,'shared_dir':'/etc/nginx/cloudfront','bundles':[]},'limits':{'max_changes':10,'min_ratio':.8},'notify_unit':''}
def none_inputs():
 c=config();p={'integrity_format':'pt-kernel-v1','backend':'none','config_hash':hashlib.sha256(encoded(c)).hexdigest(),'enrollment_id':'b'*32,'profile_id':'none','inventory':None,'owned_rules':[],'protected_context':None}
 return {'config_bytes':encoded(c),'before_state_bytes':None,'baseline_bytes':encoded(p),'before':None,'protected_context':None,
         'target':{'ranges':['192.0.2.0/24','2001:db8::/32'],'aws_sync_token':'11'},'nginx':m.nginx_ledger_input(m.NotApplicable('nginx')),
         'code_generation':'c'*64,'created_at':10,'companions':{}}
OLD_GEO=b'198.51.100.0/24 1;\n2001:db8:1::/48 1;\n'
OLD_REALIP=b'set_real_ip_from 198.51.100.0/24;\nset_real_ip_from 2001:db8:1::/48;\n'
NGINX_ORIGIN=('/etc/nginx/cloudfront',(('/etc/nginx/geo.conf','/etc/nginx/site.conf'),))
def nginx_inputs(geo=OLD_GEO,realip=OLD_REALIP):
 """none_inputs with nginx enabled and an issued input standing in for
 nginx_ledger_input of an admitted observation (that path, with a collected
 observation, is tested in test_nginx_collector)."""
 args=none_inputs();cfg=json.loads(args['config_bytes']);cfg['nginx'].update(enabled=True,bundles=[{'geo_file':'/etc/nginx/geo.conf','realip_file':'/etc/nginx/site.conf'}]);args['config_bytes']=encoded(cfg)
 p=json.loads(args['baseline_bytes']);p['config_hash']=hashlib.sha256(encoded(cfg)).hexdigest();args['baseline_bytes']=encoded(p)
 args['nginx']=m._issue_nginx_ledger_input({'observation_code':'nginx_observed','before_shared':{'cloudfront-geo.conf':geo,'cloudfront-realip.conf':realip},'before_bundles':{'/etc/nginx/geo.conf':b'private-header','/etc/nginx/site.conf':b'private-origin-secret'}},NGINX_ORIGIN)
 return args
def stock_inputs(os_id='26.04'):
 # Existing independent recorded-kernel fixture builder, no new predictor oracle.
 setup=types.ModuleType('snapshot_fixture_setup');setup.__file__=str(files/'tests/test_cloudfront_snapshot.py')
 exec(compile((files/'tests/test_cloudfront_snapshot.py').read_bytes(),setup.__file__,'exec'),setup.__dict__)
 exec(setup.PRELUDE[setup.PRELUDE.index('def fixture('):],globals())
 value,captured=fixture(os_id)
 c=config('ufw');data=p_data(captured);u=sys.modules['ufw_integrity'];owned=[]
 for family,leaf in ((4,'user.rules'),(6,'user6.rules')):
  document=u.UserRulesDocument.parse(captured.inventory.contents['/etc/ufw/'+leaf],u.UserFileProfile(family))
  for block in document.blocks:
   f=block.fields
   if f[0:2]==('allow','tcp') and f[2]=='443' and f[-1]=='in':
    source=str(__import__('ipaddress').ip_network(f[5],strict=True));owned.append({'source':source,'port':443,'comment':bytes.fromhex(block.comment_hex).decode()})
 data['owned_rules']=owned;data['config_hash']=hashlib.sha256(encoded(c)).hexdigest()
 data['protected_context']={'kind':'stock','host_addresses':['192.0.2.10'],'ssh_ports':[22],'admin_networks':['203.0.113.0/24'],'cf_ports':[443]}
 sources=sorted({row['source'] for row in owned},key=lambda s:(__import__('ipaddress').ip_network(s).version,int(__import__('ipaddress').ip_network(s).network_address),__import__('ipaddress').ip_network(s).prefixlen))
 state=state_data(data);state['config_hash']=data['config_hash'];state['ranges']=sources;state['aws_sync_token']='10'
 args=none_inputs();args.update(config_bytes=encoded(c),before_state_bytes=encoded(state),baseline_bytes=encoded(data),before=captured,
     protected_context={'projection_profile':'supplied-pure-data-v1','membership':{'bridges':[],'host_local_addresses':['192.0.2.10'],'admin_peers':['203.0.113.8']},'raw_views':{'links':b'private runtime capture retained'},'canonical_views':{'links':b'complete pure fixture canonical context'}},
     target={'ranges':sources+['2001:db8:feed::/64'],'aws_sync_token':'11'},owner=os.geteuid())
 return value,args

def docker_inputs():
 tree=ast.parse((files/'tests/test_ufw_docker_kernel.py').read_bytes())
 definitions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('inventory_fixture','full_fixture')]
 namespace={'FILES':files,'sys':sys,'d':sys.modules['ufw_docker_kernel'],'k':sys.modules['ufw_kernel'],'json':json}
 exec(compile(ast.Module(body=definitions,type_ignores=[]),'independent-docker-synthetic-fixture','exec'),namespace)
 data=namespace['full_fixture']();d=sys.modules['ufw_docker_kernel'];before=d.validate_no_publish(**data)
 paths=before.membership.paths;domain=paths.domain
 c=config('ufw');c['host_address']=paths.host_addresses[0]
 p={'integrity_format':'pt-kernel-v1','backend':'ufw','config_hash':hashlib.sha256(encoded(c)).hexdigest(),'enrollment_id':'b'*32,'profile_id':'docker29-no-publish-26-candidate-v1',
    'inventory':{'manifest':[dict(row) for row in before.inventory.manifest],'contents':{path:base64.b64encode(raw).decode() for path,raw in before.inventory.contents.items()}},
    'owned_rules':[{'source':s,'port':port,'comment':comment} for s,port,comment in before.owned_rules],
    'protected_context':{'kind':'docker_candidate','domain':{'pools':list(domain.pools),'host_networks':list(domain.host_networks),'admin_networks':list(domain.admin_networks)},
                         'paths':{name:list(getattr(paths,name)) for name in ('cf_sources','cf_ports','ssh_ports','host_addresses','admin_routes')}}}
 state={'version':2,'integrity_format':'pt-kernel-v1','generation_id':'a'*64,'config_hash':p['config_hash'],'enrollment_id':p['enrollment_id'],'baseline':p,'ranges':list(paths.cf_sources),'aws_sync_token':'10','last_success':None}
 member=before.membership
 context={'projection_profile':'supplied-pure-data-v1','membership':{'bridges':[{'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in member.bridges],
         'host_local_addresses':list(member.host_local_addresses),'admin_peers':list(member.admin_peers)},'raw_views':{'links':b'private complete runtime context, not a live measurement'},'canonical_views':{'links':b'complete pure fixture canonical Docker context'}}
 args=none_inputs();args.update(config_bytes=encoded(c),before_state_bytes=encoded(state),baseline_bytes=encoded(p),before=before,protected_context=context,
   target={'ranges':['192.0.2.0/28','198.18.0.0/28','2001:db8:cf::/64'],'aws_sync_token':'11'})
 return args


def d1_unowned_inputs(action,source):
 args=docker_inputs();before=args['before'];u=sys.modules['ufw_integrity'];d=sys.modules['ufw_docker_kernel'];t=sys.modules['ufw_docker_transition']
 family=__import__('ipaddress').ip_network(source).version;path='/etc/ufw/'+('user.rules' if family==4 else 'user6.rules')
 doc=u.UserRulesDocument.parse(before.inventory.contents[path],u.UserFileProfile(family))
 extra=u.TupleBlock((action,'tcp','443','0.0.0.0/0' if family==4 else '::/0','any',source,'in'),b'unmanaged preserve'.hex())
 raw=u.UserRulesDocument(doc.profile,(extra,)+doc.blocks).to_bytes();contents=dict(before.inventory.contents);contents[path]=raw
 rows=[dict(r) for r in before.inventory.manifest]
 next(r for r in rows if r['path']==path).update(size=len(raw),sha256=hashlib.sha256(raw).hexdigest())
 inv=u.UfwInventory(tuple(rows),contents);rep=t._compose(before.representation,inv,before.membership)
 candidate=d.validate_no_publish(representation=rep,membership=before.membership,protected_inventory=inv,inventory=inv,owned_rules=tuple(u.ManagedTuple(*r) for r in before.owned_rules),legacy=before.legacy,docker_package=before.docker_package)
 p=json.loads(args['baseline_bytes']);p['inventory']={'manifest':[dict(r) for r in inv.manifest],'contents':{p:base64.b64encode(raw).decode() for p,raw in inv.contents.items()}}
 state=json.loads(args['before_state_bytes']);state['baseline']=p
 args.update(before=candidate,baseline_bytes=encoded(p),before_state_bytes=encoded(state))
 return args

def two_port_inputs(kind):
 # Coherent PURE generated before-data for encoded-size tests; never an actual
 # vendor/kernel oracle. Initial stock goldens/D1 synthetic source stay distinct.
 from dataclasses import replace
 if kind=='stock':
  cleanup,args=stock_inputs();captured=args['before'];proof=sys.modules['ufw_observation'].admit_stock(captured,owner=args['owner']);inventory=captured.inventory
  p=json.loads(args['baseline_bytes']);rows=p['owned_rules']
  for row in list(rows):
   rule=sys.modules['ufw_integrity'].ManagedTuple(row['source'],9443,row['comment']);proof=sys.modules['ufw_kernel_mapping'].predict_transition(proof,'add',rule);inventory=m._ledger_apply_inventory(inventory,proof)
   rows.append({'source':row['source'],'port':9443,'comment':row['comment']})
  env=proof.correspondence.structure.envelope
  outputs={('iptables-save',):env.selected[0].canonical,('ip6tables-save',):env.selected[1].canonical,('nft','-j','list','ruleset'):env.native.canonical,('iptables-legacy-save',):b'',('ip6tables-legacy-save',):b''}
  args['before']=replace(captured,inventory=inventory,selected=env.selected,native=env.native,legacy=env.legacy,commands=tuple((argv,outputs.get(argv,raw)) for argv,raw in captured.commands))
  p['inventory']={'manifest':[dict(row) for row in inventory.manifest],'contents':{path:base64.b64encode(raw).decode() for path,raw in inventory.contents.items()}}
  p['protected_context']['cf_ports']=[443,9443]
 else:
  cleanup=None;args=docker_inputs();before=args['before'];p=json.loads(args['baseline_bytes']);inventory=before.inventory;rows=p['owned_rules']
  for row in list(rows):
   intent=sys.modules['ufw_docker_transition'].OwnedIntent('add',row['source'],9443,row['comment']);inventory,_=sys.modules['ufw_docker_transition']._inventory(inventory,intent);rows.append({'source':row['source'],'port':9443,'comment':row['comment']})
  paths=before.membership.paths;d=sys.modules['ufw_docker_kernel'];member=before.membership
  newpaths=d.validate_protected_paths(paths.domain,cf_sources=paths.cf_sources,cf_ports=(443,9443),ssh_ports=paths.ssh_ports,host_addresses=paths.host_addresses,admin_routes=paths.admin_routes)
  membership=d.validate_membership(newpaths,tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in member.bridges),member.host_local_addresses,member.admin_peers)
  representation=sys.modules['ufw_docker_transition']._compose(before.representation,inventory,membership)
  args['before']=d.validate_no_publish(representation=representation,membership=membership,protected_inventory=inventory,inventory=inventory,owned_rules=tuple(sys.modules['ufw_integrity'].ManagedTuple(r['source'],r['port'],r['comment']) for r in rows),legacy=before.legacy,docker_package=before.docker_package)
  p['inventory']={'manifest':[dict(row) for row in inventory.manifest],'contents':{path:base64.b64encode(raw).decode() for path,raw in inventory.contents.items()}}
  p['protected_context']['paths']['cf_ports']=[443,9443]

 # Seed 40 dual-family sources x two ports as coherent generated data. This
 # makes +10 ranges satisfy both max_changes=10 and ratio50/40=1.25.
 u=sys.modules['ufw_integrity'];t=sys.modules['ufw_docker_transition'];d=sys.modules['ufw_docker_kernel'];mapping=sys.modules['ufw_kernel_mapping']
 old_sources={row['source'] for row in rows}
 seed=['198.18.'+str(i)+'.0/28' for i in range(19)]+['2001:db8:cafe:'+str(i)+'::/64' for i in range(1,20)]
 for source in seed:
  for port in (443,9443):
   intent=t.OwnedIntent('add',source,port,'cloudfront-sync');inventory,_=t._inventory(inventory,intent);rows.append({'source':source,'port':port,'comment':'cloudfront-sync'})
 # Match the actual sizing input's complete14-file footprint without using any
 # private policy values. These application bytes remain fully protected.
 contents=dict(inventory.contents);meta=[dict(row) for row in inventory.manifest];paths={row['path'] for row in meta};owner=meta[0]['uid'];gid=meta[0]['gid']
 if '/etc/ufw/applications.d' not in paths:meta.append({'path':'/etc/ufw/applications.d','kind':'directory','mode':0o755,'uid':owner,'gid':gid})
 count=sum(row['kind']=='file' for row in meta)
 for i in range(max(0,14-count)):
  path='/etc/ufw/applications.d/b1-size-'+str(i);contents[path]=b'[B1 size only]\ntitle=fixture\nports=9999/tcp\n';meta.append({'path':path,'kind':'file','mode':0o644,'uid':owner,'gid':gid,'size':0,'sha256':'0'*64})
 need=max(0,32865-sum(map(len,contents.values())))
 application=next(path for path in contents if path.startswith('/etc/ufw/applications.d/'));contents[application]+=b'#'*need
 for row in meta:
  if row['kind']=='file':row.update(size=len(contents[row['path']]),sha256=hashlib.sha256(contents[row['path']]).hexdigest())
 inventory=u.UfwInventory(tuple(sorted(meta,key=lambda row:row['path'])),contents)
 sources=sorted(old_sources|set(seed),key=lambda source:(__import__('ipaddress').ip_network(source).version,int(__import__('ipaddress').ip_network(source).network_address),__import__('ipaddress').ip_network(source).prefixlen))
 if kind=='stock':
  raw={leaf:inventory.contents['/etc/ufw/'+leaf] for leaf in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules')}
  profile=mapping._profile_for(proof.correspondence.structure.envelope);selected=mapping._selected_from_raw(raw,profile);native=mapping._native_from_selected(env.native,selected,profile)
  env=mapping.validate_envelope(selected=selected,native=native,legacy=(b'',b''),versions=dict(env.versions));mapping.validate_raw(mapping.validate_semantics(mapping.validate_structure(env)),raw)
  outputs={('iptables-save',):selected[0].canonical,('ip6tables-save',):selected[1].canonical,('nft','-j','list','ruleset'):native.canonical,('iptables-legacy-save',):b'',('ip6tables-legacy-save',):b''}
  args['before']=replace(args['before'],inventory=inventory,selected=selected,native=native,commands=tuple((argv,outputs.get(argv,body)) for argv,body in args['before'].commands))
 else:
  before=args['before'];paths=before.membership.paths;member=before.membership
  newpaths=d.validate_protected_paths(paths.domain,cf_sources=tuple(sources),cf_ports=(443,9443),ssh_ports=paths.ssh_ports,host_addresses=paths.host_addresses,admin_routes=paths.admin_routes)
  membership=d.validate_membership(newpaths,tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in member.bridges),member.host_local_addresses,member.admin_peers)
  representation=t._compose(before.representation,inventory,membership)
  args['before']=d.validate_no_publish(representation=representation,membership=membership,protected_inventory=inventory,inventory=inventory,owned_rules=tuple(u.ManagedTuple(r['source'],r['port'],r['comment']) for r in rows),legacy=before.legacy,docker_package=before.docker_package)
  p['protected_context']['paths']['cf_sources']=sources
 p['inventory']={'manifest':[dict(row) for row in inventory.manifest],'contents':{path:base64.b64encode(body).decode() for path,body in inventory.contents.items()}}
 cfg=json.loads(args['config_bytes']);cfg['firewall']['ports']=[443,9443];args['config_bytes']=encoded(cfg);p['config_hash']=hashlib.sha256(encoded(cfg)).hexdigest()
 args['baseline_bytes']=encoded(p);state=json.loads(args['before_state_bytes']);state['baseline']=p;state['config_hash']=p['config_hash'];state['ranges']=sources;args['before_state_bytes']=encoded(state)
 old=list(state['ranges']);new=['198.19.'+str(i)+'.0/28' for i in range(5)]+['2001:db8:feed:'+str(i)+'::/64' for i in range(1,6)]
 args['target']={'ranges':sorted(old+new,key=lambda s:(__import__('ipaddress').ip_network(s).version,int(__import__('ipaddress').ip_network(s).network_address),__import__('ipaddress').ip_network(s).prefixlen)),'aws_sync_token':'11'}
 return cleanup,args

def generated_after_inputs(args,result):
 # Pure expected-after data, never promoted to a vendor observation oracle.
 from dataclasses import replace
 core=json.loads(result.wire)['ledger'];raws={ref:base64.b64decode(row['data']) for ref,row in core['blobs'].items()};last=core['generations'][-1]
 owner=args.get('owner',0);inv=m._ledger_decode_inventory(last['inventory'],raws,owner);k=sys.modules['ufw_kernel']
 selected=tuple(k.KernelSave.parse(raws[last[name]]) for name in ('selected4','selected6'));native=k.NativeRuleset.parse(raws[last['native']],profile='nftables-1.1.6-schema1')
 state_bytes=raws[core['expected_state']];state=json.loads(state_bytes);p=state['baseline'];changed=dict(args)
 if core['kind']=='stock':
  outputs={('iptables-save',):selected[0].canonical,('ip6tables-save',):selected[1].canonical,('nft','-j','list','ruleset'):native.canonical,('iptables-legacy-save',):b'',('ip6tables-legacy-save',):b''}
  changed['before']=replace(args['before'],inventory=inv,selected=selected,native=native,commands=tuple((argv,outputs.get(argv,body)) for argv,body in args['before'].commands))
 else:
  d=sys.modules['ufw_docker_kernel'];before=args['before'];cfg=json.loads(args['config_bytes']);ctx=args['protected_context']['membership']
  paths=m._ledger_docker_paths(p['protected_context'],cfg);member=d.validate_membership(paths,tuple(ctx['bridges']),tuple(ctx['host_local_addresses']),tuple(ctx['admin_peers']))
  rep=d.validate_representation(selected=selected,native=native,versions=dict(before.representation.versions))
  changed['before']=d.validate_no_publish(representation=rep,membership=member,protected_inventory=inv,inventory=inv,owned_rules=tuple(sys.modules['ufw_integrity'].ManagedTuple(r['source'],r['port'],r['comment']) for r in p['owned_rules']),legacy=before.legacy,docker_package=before.docker_package)
 changed.update(before_state_bytes=state_bytes,baseline_bytes=encoded(p),created_at=20)
 return changed
'''.replace('FILES_PATH',repr(str(FILES)))
class LedgerTests(unittest.TestCase):
 def check(self,body):
  result=subprocess.run([sys.executable,'-B','-c',PRELUDE+'\n'+textwrap.dedent(body)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout.decode())
  return result.stdout.decode()
 def test_builder_exists_but_never_grants_actor_permission(self):
  self.check('''
   assert callable(m.compile_ledger) and callable(m.validate_ledger)
   # compile_ledger maps any Exception to SnapshotError, so the I/O tripwires
   # are also checked by their call record, not only by the raise.
   with patch.object(os,'open',side_effect=AssertionError('open')) as opened,patch.object(os,'mkdir',side_effect=AssertionError('mkdir')) as made:
    try:m.compile_ledger(config_bytes=b'{}',before_state_bytes=None,baseline_bytes=b'{}',before=None,protected_context={},target={},nginx={},code_generation='a'*64,created_at=1,companions={})
    except m.SnapshotError:pass
    else:raise AssertionError('empty semantic inputs accepted')
   assert not opened.called and not made.called
  ''')
 def test_none_full_roundtrip_no_io_or_actor(self):
  self.check('''
   args=none_inputs()
   with patch.object(os,'open',side_effect=AssertionError('open')),patch.object(os,'mkdir',side_effect=AssertionError('mkdir')):
    result=m.compile_ledger(**args)
    again=m.validate_ledger(result.wire,code_generation=args['code_generation'],companions={})
   assert result==again and result.disposition=='validated_data_only'
   assert not hasattr(result,'authorized') and result.journal_peak<=m.JOURNAL_LIMIT and result.whole_peak<=m.WHOLE_LIMIT
  ''')
 def test_stock_full_semantic_roundtrip(self):
  self.check('''
   value,args=stock_inputs()
   try:
    result=m.compile_ledger(**args)
    again=m.validate_ledger(result.wire,code_generation=args['code_generation'],companions={},owner=os.geteuid())
    assert again==result
    body=json.loads(result.wire)['ledger'];assert len(body['steps'])==1
    assert body['steps'][0]['inverse_after_id']==body['generations'][0]['id']
   finally:value.doCleanups()
  ''')
 def test_ranges_ownership_config_and_last_inverse_corruption(self):
  self.check('''
   value,args=stock_inputs()
   try:
    for kind in ('ranges','ports','comment'):
     changed=dict(args)
     if kind=='ranges':
      state=json.loads(changed['before_state_bytes']);state['ranges']=['198.51.100.0/24','2001:db8::/32'];changed['before_state_bytes']=encoded(state)
     elif kind=='ports':
      cfg=json.loads(changed['config_bytes']);cfg['firewall']['ports']=[443,8443];changed['config_bytes']=encoded(cfg)
     else:
      p=json.loads(changed['baseline_bytes']);p['owned_rules'][0]['comment']='retag';changed['baseline_bytes']=encoded(p)
     try:m.compile_ledger(**changed)
     except m.SnapshotError:pass
     else:raise AssertionError('semantic mismatch accepted')
    result=m.compile_ledger(**args);wire=json.loads(result.wire);core=wire['ledger'];core['steps'][-1]['inverse_after_id']='f'*64
    core['transaction_id']=hashlib.sha256(encoded({key:part for key,part in core.items() if key!='transaction_id'})).hexdigest();wire['progress']['ledger_id']=core['transaction_id']
    try:m.validate_ledger(encoded(wire)+b'\\n',code_generation=args['code_generation'],companions={},owner=os.geteuid())
    except m.SnapshotError:pass
    else:raise AssertionError('internally rehashed last inverse accepted')
   finally:value.doCleanups()
  ''')
 def test_exact_wip_red_state_and_boolean_progress_regressions(self):
  self.check('''
   args=none_inputs();result=m.compile_ledger(**args)
   wire=m.encode_progress(result,'rollback_verified',0,code_generation=args['code_generation'],companions={});rollback=m.validate_ledger(wire,code_generation=args['code_generation'],companions={})
   core=json.loads(wire)['ledger'];raw=base64.b64decode(core['blobs'][core['expected_state']]['data'])
   kwargs={'code_generation':args['code_generation'],'companions':{},'nginx_current':args['nginx']}
   assert m.classify_frontier(rollback,None,observed_state_bytes=None,**kwargs)=='exact_frontier_data_only'
   assert m.classify_frontier(rollback,None,observed_state_bytes=raw,**kwargs)=='manual_divergence'
   value,stock=stock_inputs()
   try:
    complete=m.compile_ledger(**stock);wire=m.encode_progress(complete,'forward_armed',0,code_generation=stock['code_generation'],companions={},owner=os.geteuid())
    for bad in (False,True,'0'):
     data=json.loads(wire);data['progress']['attempted_step']=bad
     try:m.validate_ledger(encoded(data)+b'\\n',code_generation=stock['code_generation'],companions={},owner=os.geteuid())
     except m.SnapshotError:pass
     else:raise AssertionError('bool/string attempted step accepted')
   finally:value.doCleanups()
  ''')
 def test_state_nginx_temporal_table_including_zero_firewall_steps(self):
  self.check('''
   args=nginx_inputs();origin=NGINX_ORIGIN
   result=m.compile_ledger(**args);core=json.loads(result.wire)['ledger'];blobs={ref:base64.b64decode(row['data']) for ref,row in core['blobs'].items()};newstate=blobs[core['expected_state']]
   # The current nginx component is an issued input too (nginx_ledger_input of
   # the current admitted observation), of the configured shared_dir and bundles.
   def issued(data):return m._issue_nginx_ledger_input(data,origin)
   old={'observation_code':'nginx_observed','before_shared':dict(args['nginx']['before_shared']),'before_bundles':dict(args['nginx']['before_bundles'])}
   new=copy.deepcopy(old);new['before_shared']={name:blobs[ref] for name,ref in core['nginx']['target_shared'].items()}
   oldng,newng=issued(old),issued(new)
   def classify(phase,state,ng):
    wire=m.encode_progress(result,phase,0,code_generation=args['code_generation'],companions={});parsed=m.validate_ledger(wire,code_generation=args['code_generation'],companions={})
    return m.classify_frontier(parsed,None,code_generation=args['code_generation'],companions={},observed_state_bytes=state,nginx_current=ng)
   assert classify('prepared',None,oldng)=='exact_frontier_data_only'
   assert classify('prepared',None,newng)=='manual_divergence'
   assert classify('nginx_armed',None,newng)=='exact_nginx_after_data_only'
   assert classify('nginx_verified',None,newng)=='exact_frontier_data_only'
   assert classify('rollback_verified',newstate,newng)=='manual_divergence'
   assert classify('state_prepared',None,newng)=='exact_precommit_data_only'
   assert classify('state_prepared',newstate,newng)=='exact_committed_data_only'
   assert classify('state_committed',None,newng)=='manual_divergence'
   assert classify('state_committed',newstate,oldng)=='manual_divergence'
   assert classify('state_committed',newstate,args['nginx'])=='manual_divergence'
   assert classify('state_committed',newstate,newng)=='exact_committed_data_only'
   broken=copy.deepcopy(new);broken['before_bundles']['/etc/nginx/site.conf']=b'unknown'
   assert classify('state_committed',newstate,issued(broken))=='manual_divergence'
   # Only an issued current input of the ledger's configured shared_dir and
   # bundles is compared: a hand-made or copied dict with the very same bytes,
   # an input issued for another shared_dir or other bundle pairs, and the
   # not_applicable input are manual.
   for current in (dict(newng),copy.deepcopy(new),copy.copy(newng),
                   m._issue_nginx_ledger_input(new,('/etc/nginx/other',origin[1])),
                   m._issue_nginx_ledger_input(new,(origin[0],(('/etc/nginx/site.conf','/etc/nginx/geo.conf'),))),
                   m._issue_nginx_ledger_input(new,None),m.nginx_ledger_input(m.NotApplicable('nginx'))):
    assert classify('state_committed',newstate,current)=='manual_divergence',current
   changed=issued(copy.deepcopy(new));changed['observation_code']='not_applicable'
   assert classify('state_committed',newstate,changed)=='manual_divergence'
   assert classify('state_committed',newstate,issued(new))=='exact_committed_data_only'
   assert 'private-origin' not in repr(result)
   # Only nginx_observed is evidence: the retired S0 codes, the retired
   # nginx_config_invalid (a negative case: no code path issues it any more, and
   # a ledger input carrying it must still be refused), the collection failure
   # codes, other component codes and non-strings are refused as ledger input
   # and never match as the current component (the same bytes with
   # nginx_observed do).
   assert classify('prepared',None,oldng)=='exact_frontier_data_only' and classify('state_committed',newstate,newng)=='exact_committed_data_only'
   for code in ('nginx_readonly_not_connected','nginx_fixture_observed','nginx_policy_verified','nginx_sandbox_unavailable',
                'nginx_config_invalid','nginx_observation_failed','nginx_policy_unsupported','not_applicable',None,1):
    refused=dict(args);refused['nginx']=m._issue_nginx_ledger_input(dict(args['nginx'],observation_code=code),origin)
    try:m.compile_ledger(**refused)
    except m.SnapshotError as error:assert str(error)=='ledger_nginx_evidence' and 'private' not in repr(error.args)
    else:raise AssertionError('ledger accepted nginx code %r'%(code,))
    assert classify('prepared',None,issued(dict(old,observation_code=code)))=='manual_divergence'
    assert classify('state_committed',newstate,issued(dict(new,observation_code=code)))=='manual_divergence'
  ''')
 def test_rebuilt_nginx_before_shared_must_parse_as_shared_files(self):
  self.check('''
   n=sys.modules['nginx_observation']
   def code_of(function,*a,**k):
    try:function(*a,**k)
    except m.SnapshotError as error:return str(error)
    return None
   # Well-formed shared files (the same ranges in both) round-trip.
   args=nginx_inputs();result=m.compile_ledger(**args)
   assert m.validate_ledger(result.wire,code_generation=args['code_generation'],companions={})==result
   bad=((b'old geo',b'old realip'),(OLD_GEO,b'set_real_ip_from 198.51.100.0/24;\\n'),(OLD_GEO,OLD_GEO),(OLD_REALIP,OLD_REALIP),
        (OLD_GEO[:-1],OLD_REALIP),(b'198.51.100.0/24 1;\\n',b'set_real_ip_from 198.51.100.0/24;\\n'),
        (OLD_GEO,OLD_REALIP.replace(b'198.51.100.0/24',b'203.0.113.0/24')),(b'',b''))
   for geo,realip in bad:
    # compile_ledger refuses the issued input itself ...
    assert code_of(m.compile_ledger,**nginx_inputs(geo,realip))=='ledger_nginx_shared_invalid',(geo,realip)
    # ... and a ledger whose before_shared got past it (parse_shared
    # disabled while compiling, so its digests are self-consistent) is refused
    # on reconstruction: validate_ledger parses the shared bytes again.
    with patch.object(n,'parse_shared',return_value=('192.0.2.0/24',)):wire=m.compile_ledger(**nginx_inputs(geo,realip)).wire
    assert code_of(m.validate_ledger,wire,code_generation=args['code_generation'],companions={})=='ledger_nginx_shared_invalid',(geo,realip)
  ''')
 def test_publication_lower_rejected_equal_and_newer_allowed(self):
  self.check('''
   value,args=stock_inputs()
   try:
    for token in ('10','11'):
     changed=dict(args);changed['target']={**args['target'],'aws_sync_token':token}
     assert m.compile_ledger(**changed).disposition=='validated_data_only'
    changed=dict(args);changed['target']={**args['target'],'aws_sync_token':'9'}
    try:m.compile_ledger(**changed)
    except m.SnapshotError as error:assert str(error)=='ledger_stale_publication'
    else:raise AssertionError('older publication accepted')
   finally:value.doCleanups()
  ''')
 def test_docker_candidate_complete_roundtrip_and_exact_r_only(self):
  self.check('''
   args=docker_inputs();result=m.compile_ledger(**args)
   assert result==m.validate_ledger(result.wire,code_generation=args['code_generation'],companions={})
   core=json.loads(result.wire)['ledger'];assert core['kind']=='docker_candidate' and len(core['steps'])==1
   assert args['before'].actual_docker_calibrated is False
   transition=sys.modules['ufw_docker_transition'];intent=transition.OwnedIntent('add','198.18.0.0/28',443,'cloudfront-sync')
   proof=transition.compile_transaction(args['before'],approved_final_sources=tuple(args['target']['ranges']),ordered_intents=(intent,))
   after=proof.generations[0]
   current={'inventory':after.inventory,'representation':after.representation,'membership':args['before'].membership,'legacy':args['before'].legacy,'docker_package':args['before'].docker_package}
   armed=m.validate_ledger(m.encode_progress(result,'forward_armed',0,code_generation=args['code_generation'],companions={}),code_generation=args['code_generation'],companions={})
   kwargs={'code_generation':args['code_generation'],'companions':{},'protected_context':args['protected_context'],'nginx_current':args['nginx'],'observed_state_bytes':args['before_state_bytes']}
   assert m.classify_frontier(armed,current,**kwargs)=='exact_expected_after_data_only'
   from dataclasses import replace
   k=sys.modules['ufw_kernel'];raw=json.loads(current['representation'].native.canonical);raw['nftables'].append({'table':{'family':'inet','name':'unknown-R'}})
   current['representation']=replace(current['representation'],native=k.NativeRuleset.parse(encoded(raw),profile='nftables-1.1.6-schema1'))
   assert m.classify_frontier(armed,current,**kwargs)=='manual_divergence'
  ''')
 def test_d1_prospective_unowned_shadow_rejected_before_compile(self):
  self.check('''
   for action in ('limit','allow'):
    for source in ('198.18.0.1','198.18.0.0/29','2001:db8:feed::1','2001:db8:feed::/65'):
     args=d1_unowned_inputs(action,source);original=args['before'].inventory
     if ':' in source:args['target']['ranges'].append('2001:db8:feed::/64')
     try:m.compile_ledger(**args)
     except m.SnapshotError as error:assert str(error)=='ledger_unowned_shadow_or_collision',str(error)
     else:raise AssertionError('D1 future '+action+' shadow accepted')
     assert args['before'].inventory==original
   args=d1_unowned_inputs('limit','198.19.0.1');before=args['before'].inventory
   result=m.compile_ledger(**args);core=json.loads(result.wire)['ledger']
   raws={ref:base64.b64decode(row['data']) for ref,row in core['blobs'].items()}
   final=m._ledger_decode_inventory(core['generations'][-1]['inventory'],raws,0)
   u=sys.modules['ufw_integrity'];profile=u.UserFileProfile(4)
   old=u.UserRulesDocument.parse(before.contents['/etc/ufw/user.rules'],profile)
   new=u.UserRulesDocument.parse(final.contents['/etc/ufw/user.rules'],profile)
   assert new.blocks[:len(old.blocks)]==old.blocks
  ''')
 def test_d1_rehashed_shadow_wire_rejected_during_semantic_rebuild(self):
  self.check('''
   args=d1_unowned_inputs('limit','198.18.0.1')
   name='_ledger_ufw_policy' if hasattr(m,'_ledger_ufw_policy') else '_ledger_stock_policy'
   with patch.object(m,name,return_value=None):result=m.compile_ledger(**args)
   wire=json.loads(result.wire);core=wire['ledger']
   core['transaction_id']=hashlib.sha256(encoded({key:part for key,part in core.items() if key!='transaction_id'})).hexdigest()
   wire['progress']['ledger_id']=core['transaction_id']
   try:m.validate_ledger(encoded(wire)+bytes([10]),code_generation=args['code_generation'],companions={})
   except m.SnapshotError as error:assert str(error)=='ledger_unowned_shadow_or_collision',str(error)
   else:raise AssertionError('rehashed D1 shadow wire accepted')
  ''')
 def test_docker_domain_context_and_empty_ownership_are_not_coerced(self):
  self.check('''
   args=docker_inputs()
   for kind in ('peer','bridge','domain','owned','profile'):
    changed=dict(args);p=json.loads(args['baseline_bytes']);context=copy.deepcopy(args['protected_context'])
    if kind=='peer':context['membership']['admin_peers']=['203.0.113.2']
    elif kind=='bridge':context['membership']['bridges'][0]['gateway']='203.0.113.2'
    elif kind=='domain':p['protected_context']['domain']['pools']=['192.0.2.0/24']
    elif kind=='owned':p['owned_rules']=[]
    else:context['projection_profile']='actual-authorized-by-name'
    changed['baseline_bytes']=encoded(p);changed['protected_context']=context
    try:m.compile_ledger(**changed)
    except m.SnapshotError:pass
    else:raise AssertionError('changed/empty Docker premise accepted')
  ''')
 def test_full_encoded_twenty_operations_and_physical_companions(self):
  output=self.check('''
   measurements={}
   for kind in ('stock','docker_candidate'):
    cleanup,args=two_port_inputs('stock' if kind=='stock' else 'docker')
    try:
     args['companions']={'pending':b'actual captured pending fixture','backup':b'old retained backup fixture','old_install_assets':b'o'*(1024*1024),'new_install_assets':b'n'*(1024*1024),'intent_before':b'oldintent','intent_after':b'newintent'}
     result=m.compile_ledger(**args);body=json.loads(result.wire)['ledger']
     assert len(body['steps'])==20 and len(body['generations'])==21
     assert len(body['blobs'])<200 and all(step['inverse_after_id']==body['generations'][index]['id'] for index,step in enumerate(body['steps']))
     assert m.validate_ledger(result.wire,code_generation=args['code_generation'],companions=args['companions'],owner=args.get('owner',0))==result
     assert result.journal_peak<16*1024*1024 and result.whole_peak<32*1024*1024
     measurements[kind]={'journal_peak':result.journal_peak,'whole_peak':result.whole_peak,'wire':len(result.wire),'steps':20,'blobs':len(body['blobs']),'before_files':sum(row['kind']=='file' for row in json.loads(args['baseline_bytes'])['inventory']['manifest']),'before_raw_bytes':sum(row.get('size',0) for row in json.loads(args['baseline_bytes'])['inventory']['manifest']),'approval_policy':body['inputs']['approval_policy']}
    finally:
     if cleanup:cleanup.doCleanups()
   print(json.dumps({'pure_generated_size_fixture_not_actual_common_kernel':measurements}))
  ''')
  sys.stderr.write(output)
 def test_encoded_budget_exact_boundary_plus_one_without_truncation(self):
  self.check('''
   args=none_inputs();args['companions']={'backup':b'b'*(1024*1024),'old_install_assets':b'x'*(1024*1024)}
   result=m.compile_ledger(**args)
   with patch.object(m,'JOURNAL_LIMIT',result.journal_peak),patch.object(m,'WHOLE_LIMIT',result.whole_peak):assert m.compile_ledger(**args)==result
   for name,value in (('JOURNAL_LIMIT',result.journal_peak-1),('WHOLE_LIMIT',result.whole_peak-1)):
    with patch.object(m,name,value):
     try:m.compile_ledger(**args)
     except m.SnapshotError:pass
     else:raise AssertionError('encoded peak overflow accepted')
   changed={**args['companions'],'old_install_assets':b'y'*(1024*1024)}
   try:m.validate_ledger(result.wire,code_generation=args['code_generation'],companions=changed)
   except m.SnapshotError:pass
   else:raise AssertionError('changed physical companion accepted')
   try:m.compile_ledger(**{**args,'companions':{'arbitrary-attachment':b'fake'}})
   except m.SnapshotError:pass
   else:raise AssertionError('generic attachment accepted')
  ''')
 def test_max_legal_delete_and_mixed_twenty_step_ledgers(self):
  output=self.check('''
   measurements={}
   for kind in ('stock','docker'):
    cleanup,args=two_port_inputs(kind)
    try:
     first=m.compile_ledger(**args);before_ranges=json.loads(args['before_state_bytes'])['ranges']
     delete=generated_after_inputs(args,first);delete['target']={'ranges':before_ranges,'aws_sync_token':'12'}
     v4=[s for s in before_ranges if ':' not in s];v6=[s for s in before_ranges if ':' in s]
     retained=set(before_ranges)-set(v4[:3])-set(v6[:2]);add=['198.20.0.0/28','198.20.1.0/28','2001:db8:ff00:1::/64','2001:db8:ff00:2::/64','2001:db8:ff00:3::/64']
     mixed=dict(args);mixed['target']={'ranges':sorted(retained|set(add),key=lambda source:(__import__('ipaddress').ip_network(source).version,int(__import__('ipaddress').ip_network(source).network_address),__import__('ipaddress').ip_network(source).prefixlen)),'aws_sync_token':'12'}
     for name,current in (('delete',delete),('mixed',mixed)):
      result=m.compile_ledger(**current);core=json.loads(result.wire)['ledger']
      assert len(core['steps'])==20 and core['inputs']['approval_policy']=='automatic_candidate'
      assert result==m.validate_ledger(result.wire,code_generation=current['code_generation'],companions={},owner=current.get('owner',0))
      assert all(step['inverse_after_id']==core['generations'][i]['id'] for i,step in enumerate(core['steps']))
      measurements[kind+'_'+name]={'journal_peak':result.journal_peak,'whole_peak':result.whole_peak,'steps':20,'range_delta':10}
    finally:
     if cleanup:cleanup.doCleanups()
   print(json.dumps({'pure_generated_not_actual_common':measurements}))
  ''')
  sys.stderr.write(output)
 def test_rehashed_blob_and_schema_forgery_never_becomes_expected_truth(self):
  self.check('''
   args=none_inputs();result=m.compile_ledger(**args)
   for kind in ('missing','unused','sizebool','bad64','expected_state','generation','companion','policy'):
    data=json.loads(result.wire);core=data['ledger'];ref=next(iter(core['blobs']))
    if kind=='missing':del core['blobs'][ref]
    elif kind=='unused':
     raw=b'unused private bytes';core['blobs'][hashlib.sha256(raw).hexdigest()]={'size':len(raw),'data':base64.b64encode(raw).decode()}
    elif kind=='sizebool':core['blobs'][ref]['size']=True
    elif kind=='bad64':core['blobs'][ref]['data']+='\\n'
    elif kind=='expected_state':core['expected_state']=ref
    elif kind=='generation':core['generations'][0]['context_id']='f'*64
    elif kind=='companion':core['inputs']['companions']['pending']={'size':0,'sha256':hashlib.sha256(b'').hexdigest()}
    else:core['inputs']['approval_policy']='automatic_candidate'
    core['transaction_id']=hashlib.sha256(encoded({key:part for key,part in core.items() if key!='transaction_id'})).hexdigest();data['progress']['ledger_id']=core['transaction_id']
    try:m.validate_ledger(encoded(data)+b'\\n',code_generation=args['code_generation'],companions={})
    except m.SnapshotError:pass
    else:raise AssertionError('rehashed '+kind+' accepted')
   try:m.validate_ledger(result.wire,code_generation='f'*64,companions={})
   except m.SnapshotError:pass
   else:raise AssertionError('wrong current G accepted')
  ''')
 def test_caller_mutation_and_state_baseline_boolean_not_equal_integer(self):
  self.check('''
   args=none_inputs();result=m.compile_ledger(**args);wire=result.wire;args['target']['ranges'].append('198.18.0.0/28');args['companions']['backup']=b'changed'
   assert result.wire==wire and m.validate_ledger(wire,code_generation=args['code_generation'],companions={})==result
   docker=docker_inputs();state=json.loads(docker['before_state_bytes']);state['baseline']['inventory']['manifest'][0]['uid']=False;docker['before_state_bytes']=encoded(state)
   try:m.compile_ledger(**docker)
   except m.SnapshotError as error:assert str(error)=='ledger_state_p_differs'
   else:raise AssertionError('False uid equalled0 in state/P context')
  ''')
 def test_noop_equal_old_new_state_has_explicit_ambiguity(self):
  self.check('''
   args=none_inputs();first=m.compile_ledger(**args);core=json.loads(first.wire)['ledger'];state=base64.b64decode(core['blobs'][core['expected_state']]['data'])
   args['before_state_bytes']=state;again=m.compile_ledger(**args);body=json.loads(again.wire)['ledger'];assert base64.b64decode(body['blobs'][body['expected_state']]['data'])==state
   prepared=m.validate_ledger(m.encode_progress(again,'state_prepared',0,code_generation=args['code_generation'],companions={}),code_generation=args['code_generation'],companions={})
   assert m.classify_frontier(prepared,None,code_generation=args['code_generation'],companions={},nginx_current=args['nginx'],observed_state_bytes=state)=='exact_precommit_or_committed_data_only'
  ''')
 def test_current_observation_and_canonical_context_not_descriptor_hash(self):
  self.check('''
   value,args=stock_inputs()
   try:
    result=m.compile_ledger(**args);core=json.loads(result.wire)['ledger']
    kwargs={'code_generation':args['code_generation'],'companions':{},'owner':args['owner'],'protected_context':args['protected_context'],'nginx_current':args['nginx'],'observed_state_bytes':args['before_state_bytes']}
    assert m.classify_frontier(result,args['before'],**kwargs)=='exact_frontier_data_only'
    assert m.classify_frontier(result,core['generations'][0],**kwargs)=='manual_divergence'
    context=copy.deepcopy(args['protected_context']);context['canonical_views']['links']=b'changed configured policy or unknown field'
    assert m.classify_frontier(result,args['before'],**{**kwargs,'protected_context':context})=='manual_divergence'
    # Explicit supplied pure projection: raw bytes retained, canonicalT stable.
    # This does NOT prove a real volatile-field projection; profile stays pure.
    context=copy.deepcopy(args['protected_context']);context['raw_views']['links']=b'new raw runtime timer bytes'
    assert m.classify_frontier(result,args['before'],**{**kwargs,'protected_context':context})=='exact_frontier_data_only'
   finally:value.doCleanups()
  ''')
 def test_legacy_state_and_header_records_never_implicitly_upgrade(self):
  self.check('''
   args=none_inputs();old=json.loads(args['baseline_bytes']);del old['protected_context']
   try:m.compile_ledger(**{**args,'baseline_bytes':encoded(old)})
   except m.SnapshotError:pass
   else:raise AssertionError('B0 P gained semantic context implicitly')
   try:m.compile_ledger(**{**args,'before_state_bytes':b'{"version":1}'})
   except m.SnapshotError as error:assert str(error)=='ledger_legacy_state_manual'
   else:raise AssertionError('legacy state converted')
   assert m.parse_journal(b'{"version":1}').disposition=='manual_legacy_pending'
  ''')
 def test_noop_retains_large_backup_in_full_physical_peak(self):
  self.check('''
   args=none_inputs();args['companions']={'backup':b'b'*(16*1024*1024)};result=m.compile_ledger(**args)
   assert result.whole_peak>=16*1024*1024+2*result.journal_peak
   args['companions']['old_install_assets']=b'o'*(16*1024*1024)
   try:m.compile_ledger(**args)
   except m.SnapshotError as error:assert str(error)=='ledger_whole_budget'
   else:raise AssertionError('physical backup copy omitted')
  ''')
 def test_inputs_are_snapshotted_before_config_or_profile_work(self):
  self.check('''
   args=none_inputs();original=m._ledger_config
   def changing(raw):
    args['target']['ranges'].append('not-a-network');args['companions']['backup']=b'b'*(m.WHOLE_LIMIT+1)
    return original(raw)
   with patch.object(m,'_ledger_config',side_effect=changing):result=m.compile_ledger(**args)
   assert m.validate_ledger(result.wire,code_generation=args['code_generation'],companions={})==result
   assert len(json.loads(result.wire)['ledger']['inputs']['target']['ranges'])==2
  ''')
 def test_profile_source_drift_is_not_hidden_by_constant_profile_name(self):
  self.check('''
   from dataclasses import replace
   value,args=stock_inputs()
   try:
    result=m.compile_ledger(**args);before=args['before'];sources=tuple((name,raw+b'\\n# changed outside pinned function\\n' if name=='common.py' else raw) for name,raw in before.metadata[1])
    changed=replace(before,metadata=(before.metadata[0],sources))
    # The existing function pins remain valid; T's full-source identity changes.
    sys.modules['ufw_observation'].admit_stock(changed,owner=args['owner'])
    assert m.classify_frontier(result,changed,code_generation=args['code_generation'],companions={},owner=args['owner'],protected_context=args['protected_context'],nginx_current=args['nginx'],observed_state_bytes=args['before_state_bytes'])=='manual_divergence'
   finally:value.doCleanups()
  ''')
 def test_none_empty_container_types_and_finite_config_are_strict(self):
  self.check('''
   args=none_inputs()
   for owned in ({},False,None):
    p=json.loads(args['baseline_bytes']);p['owned_rules']=owned
    try:m.compile_ledger(**{**args,'baseline_bytes':encoded(p)})
    except m.SnapshotError:pass
    else:raise AssertionError('falsy non-list owned mapping accepted')
   cfg=json.loads(args['config_bytes']);cfg['notify_unit']='mail-alert@cloudfront-sync.service';p=json.loads(args['baseline_bytes']);p['config_hash']=hashlib.sha256(encoded(cfg)).hexdigest()
   assert m.compile_ledger(**{**args,'config_bytes':encoded(cfg),'baseline_bytes':encoded(p)}).disposition=='validated_data_only'
   raw=args['config_bytes'].replace(b'0.8',b'1e999')
   try:m.compile_ledger(**{**args,'config_bytes':raw})
   except m.SnapshotError:pass
   else:raise AssertionError('nonfinite config float accepted')
  ''')
 def test_cartesian_growth_is_rejected_before_materialization(self):
  self.check('''
   value,args=stock_inputs()
   try:
    cfg=json.loads(args['config_bytes']);cfg['firewall']['ports']=list(range(10000,17999))
    p=json.loads(args['baseline_bytes']);p['owned_rules']=[];p['config_hash']=hashlib.sha256(encoded(cfg)).hexdigest();p['protected_context']['cf_ports']=cfg['firewall']['ports']
    ranges=['10.'+str(i//256)+'.'+str(i%256)+'.1/32' for i in range(4095)]+['2001:db8::/32']
    changed={**args,'config_bytes':encoded(cfg),'baseline_bytes':encoded(p),'before_state_bytes':None,'before':None,'target':{'ranges':ranges,'aws_sync_token':'11'}}
    # Do not allocate32million tuples in the negative test. The old source
    # reaches this tripwire; the fixed source refuses using integer counts.
    with patch.object(m,'_ledger_intents',side_effect=AssertionError('Cartesian allocation reached')) as intents,patch.object(m.observation,'admit_stock',side_effect=AssertionError('invalid before inspected')) as admitted:
     try:m.compile_ledger(**changed)
     except m.SnapshotError as error:assert str(error)=='ledger_owned_cardinality_budget'
     else:raise AssertionError('amplification accepted')
    assert not intents.called and not admitted.called
    # backend=none has no Cartesian owner domain and no firewall collection.
    none=none_inputs();nonecfg=json.loads(none['config_bytes']);nonecfg['firewall']['ports']=cfg['firewall']['ports'];nonep=json.loads(none['baseline_bytes']);nonep['config_hash']=hashlib.sha256(encoded(nonecfg)).hexdigest()
    with patch.object(m,'_ledger_intents',side_effect=AssertionError('none intents')),patch.object(m.observation,'Collector',side_effect=AssertionError('none collector')):
     assert m.compile_ledger(**{**none,'config_bytes':encoded(nonecfg),'baseline_bytes':encoded(nonep)}).disposition=='validated_data_only'
   finally:value.doCleanups()
  ''')
if __name__=='__main__':unittest.main()
