"""D1 synthetic guard tests; these are NOT actual Docker lifecycle proof."""
import importlib.util
from pathlib import Path
import sys
import json
import copy
import unittest
FILES=Path(__file__).parents[1]
for name in ('ufw_kernel','ufw_integrity','ufw_kernel_mapping','ufw_docker_kernel'):
 spec=importlib.util.spec_from_file_location(name,FILES/(name+'.py'))
 module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
k=sys.modules['ufw_kernel'];d=sys.modules['ufw_docker_kernel']

def setUpModule():
 # Other pure test modules load the same reviewed helper names during discovery.
 # Bind this test's D1 module to the final shared source classes, once, so class
 # identity does not depend on file-discovery order. No production imports change.
 global k,d
 k=sys.modules['ufw_kernel']
 spec=importlib.util.spec_from_file_location('ufw_docker_kernel',FILES/'ufw_docker_kernel.py')
 d=importlib.util.module_from_spec(spec);sys.modules[spec.name]=d;spec.loader.exec_module(d)

class AllocationBoundaryTests(unittest.TestCase):
 def domain(self):return d.validate_allocation_domain(('203.0.113.0/24',),('192.0.2.0/24',),('198.51.100.0/24',))
 def bridge(self,**extra):return {'name':'cfbr-fixture','kind':'bridge','prefix':'203.0.113.0/28','gateway':'203.0.113.1',**extra}
 def test_finite_explicit_disjoint_domain(self):
  domain=self.domain();self.assertEqual(domain.pools,('203.0.113.0/24',))
  self.assertTrue(d.validate_bridge(domain,self.bridge()))
 def test_pool_overlapping_host_or_admin_domain_refused(self):
  for host,admin in [(('203.0.113.10/32',),()),((),('203.0.113.128/25',))]:
   with self.subTest(host=host,admin=admin):
    with self.assertRaises(k.KernelError):d.validate_allocation_domain(('203.0.113.0/24',),host,admin)
 def test_unknown_unbounded_overlapping_or_noncanonical_pool_refused(self):
  for pools in [(),('0.0.0.0/0',),('203.0.113.1/24',),('203.0.113.0/24','203.0.113.0/28'),('::/0',),('127.0.0.0/8',)]:
   with self.subTest(pools=pools):
    with self.assertRaises(k.KernelError):d.validate_allocation_domain(pools,(),())
 def test_outside_domain_or_unproved_interface_kind_refused(self):
  for bridge in [self.bridge(prefix='198.18.0.0/28',gateway='198.18.0.1'),self.bridge(kind='ether'),self.bridge(gateway='203.0.113.16')]:
   with self.subTest(bridge=bridge):
    with self.assertRaises(k.KernelError):d.validate_bridge(self.domain(),bridge)
 def test_endpoint_drop_cannot_touch_host_gateway_or_admin(self):
  domain=self.domain();bridge=self.bridge()
  self.assertTrue(d.validate_endpoint(domain,bridge,'203.0.113.2',('192.0.2.10',)))
  for endpoint,locals in [('203.0.113.1',()),('203.0.113.2',('203.0.113.2',)),('198.51.100.2',()),('203.0.113.0',()),('203.0.113.15',())]:
   with self.subTest(endpoint=endpoint):
    with self.assertRaises(k.KernelError):d.validate_endpoint(domain,bridge,endpoint,locals)
 def test_boolean_or_integer_host_address_is_not_a_valid_context(self):
  for malformed in ((True,),(1,),(False,)):
   with self.subTest(malformed=malformed):
    with self.assertRaises(k.KernelError):d.validate_endpoint(self.domain(),self.bridge(),'203.0.113.2',malformed)
 def test_current_r_cannot_expand_approved_domain(self):
  domain=self.domain()
  with self.assertRaises(k.KernelError):d.validate_bridge(domain,self.bridge(prefix='198.18.0.0/28',gateway='198.18.0.1'))
  self.assertEqual(domain.pools,('203.0.113.0/24',))

META={'version':'1.1.6','release_name':'Commodore Bullmoose #7','json_schema_version':1}
VERSIONS={'iptables':'iptables v1.8.11 (nf_tables)','ip6tables':'ip6tables v1.8.11 (nf_tables)','nft':'nftables v1.1.6 (Commodore Bullmoose #7)'}
def representation_inputs(table='nat'):
 names=('PREROUTING','INPUT','OUTPUT','POSTROUTING') if table=='nat' else ('PREROUTING','OUTPUT')
 raw=('*'+table+'\n'+''.join(':'+name+' ACCEPT [0:0]\n' for name in names)+':CF_TEST - [0:0]\nCOMMIT\n').encode()
 native={'nftables':[{'metainfo':META}]+[row for family in ('ip','ip6') for row in ({'table':{'family':family,'name':table}},{'chain':{'family':family,'table':table,'name':'CF_TEST'}})]}
 return {'selected':(k.KernelSave.parse(raw),k.KernelSave.parse(raw)),'native':k.NativeRuleset.parse(json.dumps(native).encode(),profile='nftables-1.1.6-schema1'),'versions':VERSIONS}
def mutate_native(data,change):
 raw=json.loads(data['native'].canonical);change(raw['nftables']);data['native']=k.NativeRuleset.parse(json.dumps(raw).encode(),profile='nftables-1.1.6-schema1')

class VirtualRepresentationTests(unittest.TestCase):
 def test_only_documented_empty_accept_nat_raw_builtins_virtual(self):
  for table,count in [('nat',8),('raw',4)]:
   with self.subTest(table=table):
    proof=d.validate_representation(**representation_inputs(table))
    self.assertEqual(len(proof.virtual_chains),count)
    self.assertFalse(proof.policy_verified)
 def test_filter_or_unknown_table_never_uses_virtual_exception(self):
  for table in ('filter','mangle'):
   data=representation_inputs('raw');data['selected']=tuple(k.KernelSave.parse(v.canonical.replace(b'*raw',('*'+table).encode())) for v in data['selected'])
   mutate_native(data,lambda rows:[row[next(iter(row))].update(table=table) if 'chain' in row else row['table'].update(name=table) for row in rows if 'chain' in row or 'table' in row])
   with self.subTest(table=table):
    with self.assertRaises(k.KernelError):d.validate_representation(**data)
 def test_virtual_nonaccept_or_userchain_rejected(self):
  data=representation_inputs();data['selected']=(k.KernelSave.parse(data['selected'][0].canonical.replace(b':INPUT ACCEPT',b':INPUT DROP')),data['selected'][1])
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
  data=representation_inputs();mutate_native(data,lambda rows:rows.__setitem__(slice(None),[r for r in rows if not('chain' in r and r['chain']['family']=='ip')]))
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
 def test_virtual_referenced_chain_is_not_safe(self):
  data=representation_inputs();raw=data['selected'][0].canonical.replace(b'COMMIT',b'-A CF_TEST -j INPUT\nCOMMIT');data['selected']=(k.KernelSave.parse(raw),data['selected'][1])
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
 def test_hidden_native_hook_or_wrong_priority_rejected(self):
  data=representation_inputs();mutate_native(data,lambda rows:rows.append({'chain':{'family':'ip','table':'nat','name':'OTHER','type':'nat','hook':'prerouting','prio':-100,'policy':'accept'}}))
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
  data=representation_inputs();mutate_native(data,lambda rows:rows.append({'chain':{'family':'ip','table':'nat','name':'OUTPUT','type':'nat','hook':'output','prio':0,'policy':'accept'}}))
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
 def test_physical_standard_hook_is_preserved_not_masked(self):
  data=representation_inputs();mutate_native(data,lambda rows:rows.append({'chain':{'family':'ip','table':'nat','name':'OUTPUT','type':'nat','hook':'output','prio':-100,'policy':'accept'}}))
  proof=d.validate_representation(**data)
  self.assertEqual(len(proof.virtual_chains),7)
  self.assertIn(b'"prio":-100',proof.native.canonical)
 def test_wrong_version_or_native_object_is_not_accepted(self):
  data=representation_inputs();data['versions']={**VERSIONS,'iptables':'iptables v1.8.10 (nf_tables)'}
  with self.assertRaises(k.KernelError):d.validate_representation(**data)
  data=representation_inputs();mutate_native(data,lambda rows:rows.append({'set':{'family':'ip','table':'nat','name':'UNKNOWN','elem':[1]}}))
  with self.assertRaises(k.KernelError):d.validate_representation(**data)

class ProtectedPathContextTests(unittest.TestCase):
 def candidate(self,**changes):
  args={'cf_sources':('198.51.100.0/28','2001:db8:cf::/64'),'cf_ports':(80,443),'ssh_ports':(22,),'host_addresses':('192.0.2.10',),'admin_routes':('192.0.2.128/25',)}
  args.update(changes)
  domain=d.validate_allocation_domain(('203.0.113.0/24',),('192.0.2.0/24',),('192.0.2.128/25',))
  return d.validate_protected_paths(domain,**args)
 def bridge(self):return {'name':'cfbr-fixture','kind':'bridge','prefix':'203.0.113.0/28','gateway':'203.0.113.1'}
 def test_complete_explicit_path_candidate_and_current_membership(self):
  paths=self.candidate();proof=d.validate_membership(paths,(self.bridge(),),('192.0.2.10','203.0.113.1'),('192.0.2.130',))
  self.assertFalse(proof.policy_verified)
 def test_missing_cf_or_admin_context_and_source_pool_overlap_refused(self):
  for changes in ({'cf_sources':()},{'cf_sources':('203.0.113.0/28',)},{'admin_routes':()},{'host_addresses':()}):
   with self.subTest(changes=changes):
    with self.assertRaises(k.KernelError):self.candidate(**changes)
 def test_port_types_or_ssh_cf_collision_refused(self):
  for changes in ({'cf_ports':(True,)},{'ssh_ports':(22.0,)},{'cf_ports':(22,443)},{'cf_ports':(0,)},{'ssh_ports':()}):
   with self.subTest(changes=changes):
    with self.assertRaises(k.KernelError):self.candidate(**changes)
 def test_static_host_or_admin_route_membership_cannot_be_changed_by_r(self):
  paths=self.candidate()
  for locals,peers in [(('192.0.2.11','203.0.113.1'),()),(('192.0.2.10','203.0.113.1'),('203.0.113.2',)),(('192.0.2.10','203.0.113.1','198.18.0.1'),())]:
   with self.subTest(locals=locals,peers=peers):
    with self.assertRaises(k.KernelError):d.validate_membership(paths,(self.bridge(),),locals,peers)
 def test_concrete_admin_peer_must_belong_to_approved_routes(self):
  paths=self.candidate()
  for peers in [('198.18.0.1',),('2001:db8::1',),('203.0.113.2',)]:
   with self.subTest(peers=peers):
    with self.assertRaises(k.KernelError):d.validate_membership(paths,(self.bridge(),),('192.0.2.10','203.0.113.1'),peers)
 def test_empty_peer_is_passive_observation_not_domain_enrollment(self):
  paths=self.candidate()
  observed=d.validate_membership(paths,(self.bridge(),),('192.0.2.10','203.0.113.1'),())
  self.assertEqual(observed.paths.admin_routes,('192.0.2.128/25',))
  self.assertEqual(observed.admin_peers,())
 def test_bridge_overlap_or_missing_gateway_not_accepted(self):
  paths=self.candidate()
  for bridges,locals in [((self.bridge(),self.bridge()),('192.0.2.10','203.0.113.1')),((self.bridge(),),('192.0.2.10',))]:
   with self.assertRaises(k.KernelError):d.validate_membership(paths,bridges,locals,())
 def test_noncanonical_or_boolean_host_address_context_rejected(self):
  for changes in ({'host_addresses':(True,)},{'host_addresses':('203.0.113.2',)}):
   with self.assertRaises(k.KernelError):self.candidate(**changes)

def inventory_fixture():
 import hashlib
 u=sys.modules['ufw_integrity'];fixture=FILES/'tests/fixtures/kernel/26.04'
 contents={'/etc/ufw/'+p.name:p.read_bytes() for p in (fixture/'stock').iterdir()}
 contents.update({'/etc/ufw/'+leaf:(fixture/('before.'+leaf)).read_bytes() for leaf in ('user.rules','user6.rules')})
 contents['/etc/default/ufw']=b'DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="DROP"\n'
 contents['/etc/ufw/ufw.conf']=b'ENABLED=yes\nLOGLEVEL=low\n'
 for i in range(6):contents['/etc/ufw/applications.d/fixture-'+str(i)]=('public fixture '+str(i)+'\n').encode()
 manifest=[{'path':path,'kind':'directory','mode':0o755,'uid':0,'gid':0} for path in ('/etc/ufw','/etc/ufw/applications.d')]
 manifest.extend({'path':path,'kind':'file','mode':0o640,'uid':0,'gid':0,'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for path,raw in contents.items())
 return u.UfwInventory(tuple(sorted(manifest,key=lambda row:row['path'])),contents)

class WholeInventoryTests(unittest.TestCase):
 def test_every_extra_file_byte_and_metadata_remains_protected(self):
  reference=inventory_fixture();self.assertEqual(d.validate_inventory_unchanged(reference,reference),reference.fingerprint)
  u=sys.modules['ufw_integrity']
  for kind in ('bytes','mode','owner','path'):
   rows=[dict(row) for row in reference.manifest];contents=dict(reference.contents)
   path='/etc/ufw/applications.d/fixture-5';row=next(r for r in rows if r['path']==path)
   if kind=='bytes':
    import hashlib
    contents[path]=b'changed\n';row.update(size=len(contents[path]),sha256=hashlib.sha256(contents[path]).hexdigest())
   elif kind=='mode':row['mode']=0o600
   elif kind=='owner':row['gid']=33
   else:row['path']=path+'-moved';contents[row['path']]=contents.pop(path)
   observed=u.UfwInventory(tuple(sorted(rows,key=lambda row:row['path'])),contents)
   with self.subTest(kind=kind):
    with self.assertRaises(k.KernelError):d.validate_inventory_unchanged(reference,observed)
 def test_forged_bool_metadata_or_content_digest_rejected(self):
  reference=inventory_fixture();u=sys.modules['ufw_integrity']
  for kind in ('uid','size','digest'):
   rows=[dict(row) for row in reference.manifest];contents=dict(reference.contents);row=next(r for r in rows if r['kind']=='file')
   if kind=='uid':row['uid']=False
   elif kind=='size':row['size']=True
   else:contents[row['path']]=b'inconsistent content'
   malformed=u.UfwInventory(tuple(rows),contents)
   with self.subTest(kind=kind):
    with self.assertRaises(k.KernelError):d.validate_inventory_unchanged(malformed,malformed)
 def test_missing_required_file_or_unbounded_inventory_refused(self):
  reference=inventory_fixture();u=sys.modules['ufw_integrity'];path='/etc/ufw/ufw.conf'
  rows=tuple(dict(r) for r in reference.manifest if r['path']!=path);contents=dict(reference.contents);contents.pop(path)
  malformed=u.UfwInventory(rows,contents)
  with self.assertRaises(k.KernelError):d.validate_inventory_unchanged(malformed,malformed)

def full_fixture():
 import hashlib
 u=sys.modules['ufw_integrity']
 fixture=json.loads((FILES/'tests/fixtures/docker/synthetic-no-publish-26.json').read_bytes())
 selected=tuple(k.KernelSave.parse(x.encode()) for x in fixture['selected'])
 native=k.NativeRuleset.parse(json.dumps(fixture['native']).encode(),profile='nftables-1.1.6-schema1')
 reference=inventory_fixture();contents=dict(reference.contents)
 for leaf,raw in fixture['raw_files'].items():contents['/etc/ufw/'+leaf]=raw.encode()
 rows=[dict(row) for row in reference.manifest]
 for row in rows:
  if row['kind']=='file':row.update(size=len(contents[row['path']]),sha256=hashlib.sha256(contents[row['path']]).hexdigest())
 inventory=u.UfwInventory(tuple(rows),contents)
 ctx=fixture['ctx'];domain=d.validate_allocation_domain(tuple(ctx['allocation_domains']),('198.51.100.0/24',),tuple(ctx['admin_routes']))
 paths=d.validate_protected_paths(domain,cf_sources=('192.0.2.0/28','2001:db8:cf::/64'),cf_ports=(443,),ssh_ports=(22,),host_addresses=tuple(ctx['host_addresses']),admin_routes=tuple(ctx['admin_routes']))
 membership=d.validate_membership(paths,tuple(ctx['bridges']),tuple(ctx['host_addresses'])+tuple(b['gateway'] for b in ctx['bridges']),tuple(ctx['admin_peers']))
 return {'representation':d.validate_representation(selected=selected,native=native,versions=fixture['versions']),
 'membership':membership,'protected_inventory':inventory,'inventory':inventory,
 'owned_rules':(u.ManagedTuple('192.0.2.0/28',443,'cloudfront-sync'),u.ManagedTuple('2001:db8:cf::/64',443,'cloudfront-sync')),
 'legacy':(b'',b''),'docker_package':'docker.io 29.1.3-0ubuntu4.1'}

def change_full_graph(data,selected_transform,native_transform):
 rep=data['representation'];selected=selected_transform(rep.selected)
 raw=json.loads(rep.native.canonical);native_transform(raw['nftables'])
 native=k.NativeRuleset.parse(json.dumps(raw).encode(),profile='nftables-1.1.6-schema1')
 data['representation']=d.validate_representation(selected=selected,native=native,versions=dict(rep.versions))

class NoPublishCompositionTests(unittest.TestCase):
 def test_independent_synthetic19_graph_composes_all_protected_planes(self):
  proof=d.validate_no_publish(**full_fixture())
  self.assertTrue(proof.policy_verified)
  self.assertEqual(len(proof.residual_rules),19)
  self.assertFalse(proof.actual_docker_calibrated)
 def test_changed_forward_attachment_order_rejected(self):
  data=full_fixture()
  def selected(views):
   view=views[0];table=view.tables[0];rules=list(table.rules);rules[0],rules[1]=rules[1],rules[0]
   return (k.KernelSave((k.KernelTable(table.name,table.chains,tuple(rules)),*view.tables[1:])),views[1])
  def native(rows):
   indices=[i for i,r in enumerate(rows) if r.get('rule',{}).get('family')=='ip' and r['rule'].get('chain')=='FORWARD']
   rows[indices[0]],rows[indices[1]]=rows[indices[1]],rows[indices[0]]
  change_full_graph(data,selected,native)
  with self.assertRaises(k.KernelError):d.validate_no_publish(**data)
 def test_native_meaning_mismatch_or_extra_owner_not_accepted_by_counts(self):
  data=full_fixture()
  def native(rows):
   rule=next(r['rule'] for r in rows if r.get('rule',{}).get('chain')=='DOCKER-CT' and r['rule']['family']=='ip')
   rule['expr'].insert(0,{'match':{'op':'==','left':{'meta':{'key':'skuid'}},'right':1001}})
  change_full_graph(data,lambda views:views,native)
  with self.assertRaises(k.KernelError):d.validate_no_publish(**data)
 def test_dnat_protected_and_disjoint_publish_both_unsupported(self):
  for port in (22,443,8443):
   data=full_fixture()
   def selected(views):
    view=views[0];tables=[]
    for table in view.tables:
     line=('-A DOCKER -p tcp -m tcp --dport '+str(port)+' -j DNAT --to-destination 203.0.113.2:443').encode()
     tables.append(k.KernelTable(table.name,table.chains,table.rules+(line,)) if table.name=='nat' else table)
    return (k.KernelSave(tuple(tables)),views[1])
   def native(rows):rows.append({'rule':{'family':'ip','table':'nat','chain':'DOCKER','expr':[{'counter':{'packets':0,'bytes':0}},{'dnat':{'addr':'203.0.113.2','port':443}}]}})
   change_full_graph(data,selected,native)
   with self.subTest(port=port):
    with self.assertRaises(k.KernelError):d.validate_no_publish(**data)
 def test_whole_inventory_and_ownership_context_are_not_rebaselined(self):
  data=full_fixture();data['inventory']=inventory_fixture()
  with self.assertRaises(k.KernelError):d.validate_no_publish(**data)
  data=full_fixture();data['owned_rules']=()
  with self.assertRaises(k.KernelError):d.validate_no_publish(**data)
 def test_legacy_or_daemon_profile_unknown_refused(self):
  for field,value in [('legacy',(b'*filter\n:INPUT DROP [0:0]\nCOMMIT\n',b'')),('docker_package','docker.io 30.0.0')]:
   data=full_fixture();data[field]=value
   with self.subTest(field=field):
    with self.assertRaises(k.KernelError):d.validate_no_publish(**data)

class ResidualTransactionTests(unittest.TestCase):
 def test_recognized_bridge_churn_is_fresh_t_only(self):
  before=d.validate_no_publish(**full_fixture());data=full_fixture();rep=data['representation']
  selected=tuple(k.KernelSave.parse(v.canonical.replace(b'cfbr0',b'cfbr1')) for v in rep.selected)
  native=k.NativeRuleset.parse(rep.native.canonical.replace(b'cfbr0',b'cfbr1'),profile='nftables-1.1.6-schema1')
  data['representation']=d.validate_representation(selected=selected,native=native,versions=dict(rep.versions))
  member=data['membership'];data['membership']=d.validate_membership(member.paths,({'name':'cfbr1','kind':'bridge','prefix':'203.0.113.0/28','gateway':'203.0.113.1'},),member.host_local_addresses,member.admin_peers)
  after=d.validate_no_publish(**data)
  self.assertEqual(before.persistent_constraints,after.persistent_constraints)
  self.assertNotEqual(before.transaction_identity,after.transaction_identity)
  with self.assertRaises(k.KernelError):d.assert_same_residual(before,after)
 def test_native_declaration_structure_change_is_not_adopted_mid_transaction(self):
  before=d.validate_no_publish(**full_fixture());data=full_fixture()
  def change(rows):
   indices=[i for i,r in enumerate(rows) if r.get('chain',{}).get('family')=='ip' and r['chain'].get('name') in ('DOCKER-BRIDGE','DOCKER-CT')]
   rows[indices[0]],rows[indices[1]]=rows[indices[1]],rows[indices[0]]
  change_full_graph(data,lambda views:views,change)
  after=d.validate_no_publish(**data)
  with self.assertRaises(k.KernelError):d.assert_same_residual(before,after)
 def test_precomputed_protected_cf_change_does_not_change_docker_r(self):
  import hashlib
  u=sys.modules['ufw_integrity'];before=d.validate_no_publish(**full_fixture());data=full_fixture()
  original=data['inventory'];contents=dict(original.contents);path='/etc/ufw/user.rules'
  self.assertEqual(contents[path].count(b'192.0.2.0/28'),2)
  contents[path]=contents[path].replace(b'192.0.2.0/28',b'198.18.0.0/28')
  rows=[dict(r) for r in original.manifest]
  next(r for r in rows if r['path']==path).update(size=len(contents[path]),sha256=hashlib.sha256(contents[path]).hexdigest())
  expected=u.UfwInventory(tuple(rows),contents)
  data['inventory']=expected;data['protected_inventory']=expected
  data['owned_rules']=(u.ManagedTuple('198.18.0.0/28',443,'cloudfront-sync'),u.ManagedTuple('2001:db8:cf::/64',443,'cloudfront-sync'))
  member=data['membership'];old=member.paths
  paths=d.validate_protected_paths(old.domain,cf_sources=('198.18.0.0/28','2001:db8:cf::/64'),cf_ports=old.cf_ports,ssh_ports=old.ssh_ports,host_addresses=old.host_addresses,admin_routes=old.admin_routes)
  data['membership']=d.validate_membership(paths,({'name':'cfbr0','kind':'bridge','prefix':'203.0.113.0/28','gateway':'203.0.113.1'},),member.host_local_addresses,member.admin_peers)
  def selected(views):return tuple(k.KernelSave.parse(v.canonical.replace(b'192.0.2.0/28',b'198.18.0.0/28')) for v in views)
  def native(rows):
   for r in rows:
    for expr in r.get('rule',{}).get('expr',[]):
     match=expr.get('match',{})
     if match.get('right')=={'prefix':{'addr':'192.0.2.0','len':28}}:match['right']={'prefix':{'addr':'198.18.0.0','len':28}}
  change_full_graph(data,selected,native)
  after=d.validate_no_publish(**data)
  self.assertNotEqual(before.persistent_constraints,after.persistent_constraints)
  self.assertNotEqual(before.transaction_identity,after.transaction_identity)
  # A separate D2 predictor/approval must authorize the P change. This guard
  # proves only that known Docker R did not change and never enrolls anything.
  d.assert_same_residual(before,after)
 def test_forged_residual_proof_is_revalidated_not_trusted_by_class(self):
  from dataclasses import replace
  before=d.validate_no_publish(**full_fixture());forged=replace(before,residual_rules=())
  with self.assertRaises(k.KernelError):d.assert_same_residual(forged,forged)

if __name__=='__main__':unittest.main()
