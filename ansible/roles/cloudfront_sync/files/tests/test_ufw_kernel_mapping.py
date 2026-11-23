"""Pure mapping boundaries; actual golden files, no host commands."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
FILES=Path(__file__).parents[1]
for name in ('ufw_kernel','ufw_kernel_mapping','ufw_integrity'):
 spec=importlib.util.spec_from_file_location(name,FILES/(name+'.py'))
 module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
k=sys.modules['ufw_kernel'];m=sys.modules['ufw_kernel_mapping']
FIXTURE=Path(__file__).parent/'fixtures/kernel/26.04'
PROFILE='nftables-1.1.6-schema1'
def inputs(state='before'):
 return {'selected':tuple(k.KernelSave.parse((FIXTURE/(state+'.'+tool)).read_bytes()) for tool in ('iptables-save','ip6tables-save')),
 'native':k.NativeRuleset.parse((FIXTURE/(state+'.native.json')).read_bytes(),profile=PROFILE),
 'legacy':tuple((FIXTURE/(state+'.'+tool)).read_bytes() for tool in ('iptables-legacy-save','ip6tables-legacy-save')),
 'versions':json.loads((FIXTURE/'manifest.json').read_text())['kernel_tool_versions']}
def change_native(data,change):
 raw=json.loads(data['native'].canonical);change(raw['nftables']);data['native']=k.NativeRuleset.parse(json.dumps(raw).encode(),profile=PROFILE)

class EnvelopeTests(unittest.TestCase):
 def test_actual_before_envelope_covers_both_families(self):
  proof=m.validate_envelope(**inputs())
  self.assertEqual(proof.families,('ip','ip6'))
 def test_wrong_backend_or_version_is_not_accepted(self):
  for tool,value in [('iptables','iptables v1.8.11 (legacy)'),('ip6tables','ip6tables v1.8.10 (nf_tables)'),('nft','nftables v9.0.0')]:
   data=inputs();data['versions'][tool]=value
   with self.subTest(tool=tool):
    with self.assertRaises(k.KernelError):m.validate_envelope(**data)
 def test_parallel_legacy_policy_not_ignored(self):
  data=inputs();data['legacy']=(b'*filter\n:INPUT DROP [0:0]\nCOMMIT\n',b'')
  with self.assertRaises(k.KernelError):m.validate_envelope(**data)
 def test_native_other_family_hook_rejected(self):
  data=inputs();change_native(data,lambda rows:rows.extend([{'table':{'family':'inet','name':'other'}},{'chain':{'family':'inet','table':'other','name':'early','type':'filter','hook':'input','prio':-10,'policy':'accept'}}]))
  with self.assertRaises(k.KernelError):m.validate_envelope(**data)
 def test_unmapped_nat_is_not_silently_ignored(self):
  data=inputs();raw=data['selected'][0].canonical+b'*nat\n:PREROUTING ACCEPT [0:0]\nCOMMIT\n';data['selected']=(k.KernelSave.parse(raw),data['selected'][1])
  with self.assertRaises(k.KernelError):m.validate_envelope(**data)

class StructureTests(unittest.TestCase):
 def test_all_actual194_rules_have_structural_pairs(self):
  proof=m.validate_structure(m.validate_envelope(**inputs()))
  self.assertEqual(len(proof.pairs),194)
 def test_equal_counts_wrong_hook_priority_rejected(self):
  data=inputs()
  def change(rows):next(r['chain'] for r in rows if r.get('chain',{}).get('name')=='INPUT')['prio']=-10
  change_native(data,change)
  with self.assertRaises(k.KernelError):m.validate_structure(m.validate_envelope(**data))
 def test_equal_counts_wrong_default_policy_rejected(self):
  data=inputs()
  def change(rows):next(r['chain'] for r in rows if r.get('chain',{}).get('name')=='INPUT')['policy']='accept'
  change_native(data,change)
  with self.assertRaises(k.KernelError):m.validate_structure(m.validate_envelope(**data))
 def test_duplicate_chain_or_unknown_object_rejected(self):
  for extra in ({'chain':{'family':'ip','table':'filter','name':'INPUT'}},{'set':{'family':'ip','table':'filter','name':'unknown','elem':[1,2]}}):
   data=inputs();change_native(data,lambda rows:rows.append(extra))
   with self.subTest(extra=extra):
    with self.assertRaises(k.KernelError):m.validate_structure(m.validate_envelope(**data))
 def test_extra_rule_never_masked_as_counter(self):
  data=inputs()
  def change(rows):rows.append(copy.deepcopy(next(r for r in rows if 'rule' in r)))
  change_native(data,change)
  with self.assertRaises(k.KernelError):m.validate_structure(m.validate_envelope(**data))
 def test_structural_success_does_not_claim_semantic_approval(self):
  proof=m.validate_structure(m.validate_envelope(**inputs()))
  self.assertFalse(proof.semantic_verified)
class NativeSemanticTests(unittest.TestCase):
 def proof(self,data):return m.validate_semantics(m.validate_structure(m.validate_envelope(**data)))
 def test_every_actual_state_rule_has_exact_native_compat_mapping(self):
  manifest=json.loads((FIXTURE/'manifest.json').read_text())
  for state in manifest['states']:
   with self.subTest(state=state['name']):
    proof=self.proof(inputs(state['name']))
    self.assertTrue(proof.native_compat_verified)
    self.assertFalse(proof.raw_verified)
    self.assertGreaterEqual(len(proof.structure.pairs),194)
 def test_same_counts_native_source_change_rejected(self):
  data=inputs()
  def change(rows):
   for row in rows:
    rule=row.get('rule',{})
    for expr in rule.get('expr',[]):
     match=expr.get('match',{})
     if match.get('right')=={'prefix':{'addr':'192.0.2.0','len':28}}:
      match['right']={'prefix':{'addr':'198.18.0.0','len':28}};return
   raise AssertionError('fixture source not found')
  change_native(data,change)
  with self.assertRaises(k.KernelError):self.proof(data)
 def test_native_expression_order_is_significant(self):
  data=inputs()
  def change(rows):
   row=next(r['rule'] for r in rows if r.get('rule',{}).get('chain')=='ufw-user-input')
   row['expr'].reverse()
  change_native(data,change)
  with self.assertRaises(k.KernelError):self.proof(data)
 def test_opaque_log_prefix_change_not_accepted_by_shape_alone(self):
  data=inputs();raw=data['selected'][0].canonical.replace(b'[UFW ALLOW]',b'[UNKNOWN]')
  self.assertNotEqual(raw,data['selected'][0].canonical)
  data['selected']=(k.KernelSave.parse(raw),data['selected'][1])
  with self.assertRaises(k.KernelError):self.proof(data)
 def test_unmanaged_unknown_extension_is_not_opaque_wildcard(self):
  data=inputs();raw=data['selected'][0].canonical.replace(b'-A ufw-user-input -p tcp',b'-A ufw-user-input -m owner --uid-owner 123 -p tcp',1)
  data['selected']=(k.KernelSave.parse(raw),data['selected'][1])
  with self.assertRaises(k.KernelError):self.proof(data)
 def test_same_chain_rule_reorder_detected(self):
  data=inputs()
  def change(rows):
   indices=[i for i,r in enumerate(rows) if r.get('rule',{}).get('chain')=='INPUT']
   rows[indices[0]],rows[indices[1]]=rows[indices[1]],rows[indices[0]]
  change_native(data,change)
  with self.assertRaises(k.KernelError):self.proof(data)

def raw_inputs(state='before'):
 raw={p.name:p.read_bytes() for p in (FIXTURE/'stock').iterdir()}
 raw.update({leaf:(FIXTURE/(state+'.'+leaf)).read_bytes() for leaf in ('user.rules','user6.rules')})
 return raw

def semantic(data):return m.validate_semantics(m.validate_structure(m.validate_envelope(**data)))

class RawAgreementTests(unittest.TestCase):
 def test_all8_actual_raw_generations_match_full_kernel_views(self):
  for row in json.loads((FIXTURE/'manifest.json').read_text())['states']:
   with self.subTest(state=row['name']):
    proof=m.validate_raw(semantic(inputs(row['name'])),raw_inputs(row['name']))
    self.assertTrue(proof.raw_verified)
 def test_unmanaged_raw_tuple_port_change_rejected(self):
  raw=raw_inputs();raw['user.rules']=raw['user.rules'].replace(b'9000',b'9001')
  with self.assertRaises(k.KernelError):m.validate_raw(semantic(inputs()),raw)
 def test_opaque_prefix_raw_edit_rejected_even_with_same_native_shape(self):
  raw=raw_inputs();raw['user.rules']=raw['user.rules'].replace(b'[UFW ALLOW]',b'[OTHER]')
  with self.assertRaises(k.KernelError):m.validate_raw(semantic(inputs()),raw)
 def test_entire_stock_before_after_bytes_checked(self):
  for leaf in ('before.rules','before6.rules','after.rules','after6.rules'):
   raw=raw_inputs();raw[leaf]+=b'# extra administrator policy\n'
   with self.subTest(leaf=leaf):
    with self.assertRaises(k.KernelError):m.validate_raw(semantic(inputs()),raw)
 def test_missing_or_unexpected_raw_policy_source_rejected(self):
  for key in ('missing','extra'):
   raw=raw_inputs()
   if key=='missing':raw.pop('before.rules')
   else:raw['other.rules']=b'unknown'
   with self.assertRaises(k.KernelError):m.validate_raw(semantic(inputs()),raw)
 def test_constructor_boolean_or_pairs_does_not_authorize_missing_evidence(self):
  from dataclasses import replace
  valid=semantic(inputs());forged=m.CompatNativeProof(replace(valid.structure,pairs=()))
  with self.assertRaises(k.KernelError):m.validate_raw(forged,raw_inputs())

class ExpectedTransitionTests(unittest.TestCase):
 def assert_generation(self,predicted,state):
  actual=m.validate_raw(semantic(inputs(state)),raw_inputs(state))
  self.assertEqual(predicted,actual)
 def test_each_expected_owned_generation_matches_next_actual_cli_state(self):
  u=sys.modules['ufw_integrity'];proof=m.validate_raw(semantic(inputs()),raw_inputs())
  for step in json.loads((FIXTURE/'manifest.json').read_text())['operations']:
   argv=step['argv'];state=step['after_state']
   with self.subTest(state=state):
    if state!='after_noop':
     rule=u.ManagedTuple(argv[argv.index('from')+1],int(argv[argv.index('port')+1]),argv[argv.index('comment')+1])
     action='delete' if '--force' in argv else 'add'
     index=int(argv[2])-1 if argv[1]=='insert' else None
     # This prediction is calculated before the next actual fixture is read.
     proof=m.predict_transition(proof,action,rule,index=index)
    self.assert_generation(proof,state)
 def test_tampered_raw_proof_never_projects_unknown_baseline(self):
  from dataclasses import replace
  u=sys.modules['ufw_integrity'];proof=m.validate_raw(semantic(inputs()),raw_inputs());raw=dict(proof.raw_files);raw['before.rules']+=b'# change\n'
  forged=replace(proof,raw_files=tuple(sorted(raw.items())))
  with self.assertRaises(k.KernelError):m.predict_transition(forged,'add',u.ManagedTuple('198.18.0.0/28',443,'cloudfront-sync'))
 def test_unrecognized_operation_and_wrong_index_rejected(self):
  u=sys.modules['ufw_integrity'];proof=m.validate_raw(semantic(inputs()),raw_inputs());rule=u.ManagedTuple('198.18.0.0/28',443,'cloudfront-sync')
  for operation,index in [('reload',None),('delete',1),('add',True),('add',9999)]:
   with self.subTest(operation=operation,index=index):
    with self.assertRaises(k.KernelError):m.predict_transition(proof,operation,rule,index=index)

class NativeNumericTypeRegressionTests(unittest.TestCase):
 def setUp(self):
  u=sys.modules['ufw_integrity'];base=m.validate_raw(semantic(inputs()),raw_inputs())
  self.proof=m.predict_transition(base,'add',u.ManagedTuple('128.0.0.0/1',1,'cloudfront-sync'))
 def mutated(self,change):
  env=self.proof.correspondence.structure.envelope
  data={'selected':env.selected,'native':env.native,'legacy':env.legacy,'versions':dict(env.versions)}
  def change_rule(rows):
   for row in rows:
    rule=row.get('rule',{})
    for expr in rule.get('expr',[]):
     if expr.get('match',{}).get('right')=={'prefix':{'addr':'128.0.0.0','len':1}}:
      change(rule);return
   raise AssertionError('generated rule not found')
  change_native(data,change_rule)
  return data
 def test_boolean_port_cannot_equal_integer_one_through_full_raw_proof(self):
  def change(rule):
   match=next(x['match'] for x in rule['expr'] if x.get('match',{}).get('left')=={'payload':{'protocol':'tcp','field':'dport'}})
   match['right']=True
  data=self.mutated(change)
  with self.assertRaises(k.KernelError):m.validate_raw(semantic(data),dict(self.proof.raw_files))
 def test_boolean_prefixlen_cannot_equal_integer_one(self):
  def change(rule):
   match=next(x['match'] for x in rule['expr'] if isinstance(x.get('match',{}).get('right'),dict))
   match['right']['prefix']['len']=True
  data=self.mutated(change)
  with self.assertRaises(k.KernelError):m.validate_raw(semantic(data),dict(self.proof.raw_files))
 def test_false_counter_and_priority_are_not_integer_zero(self):
  def counter(rule):next(x['counter'] for x in rule['expr'] if 'counter' in x)['packets']=False
  with self.assertRaises(k.KernelError):self.mutated(counter)
  data=inputs()
  def priority(rows):next(r['chain'] for r in rows if r.get('chain',{}).get('name')=='INPUT')['prio']=False
  change_native(data,priority)
  with self.assertRaises(k.KernelError):semantic(data)
 def test_float_port_is_rejected_before_semantic_comparison(self):
  def change(rule):
   match=next(x['match'] for x in rule['expr'] if x.get('match',{}).get('left')=={'payload':{'protocol':'tcp','field':'dport'}})
   match['right']=1.0
  with self.assertRaises(k.KernelError):self.mutated(change)

if __name__=='__main__':unittest.main()
