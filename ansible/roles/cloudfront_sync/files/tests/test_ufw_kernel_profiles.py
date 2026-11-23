"""Actual public 3OS golden verification; no target credentials or policy writes."""
import copy
import json
from pathlib import Path
import sys
import unittest
from test_ufw_kernel_mapping import k,m,FILES

PROFILES={'22.04':'nftables-1.0.2-schema1','24.04':'nftables-1.0.9-schema1','26.04':'nftables-1.1.6-schema1'}
ROOT=FILES/'tests/fixtures/kernel'
def sources(version,state='before'):
 f=ROOT/version
 return {'selected':tuple(k.KernelSave.parse((f/(state+'.'+tool)).read_bytes()) for tool in ('iptables-save','ip6tables-save')),
 'native':k.NativeRuleset.parse((f/(state+'.native.json')).read_bytes(),profile=PROFILES[version]),
 'legacy':tuple((f/(state+'.'+tool)).read_bytes() for tool in ('iptables-legacy-save','ip6tables-legacy-save')),
 'versions':json.loads((f/'manifest.json').read_bytes())['kernel_tool_versions']}
def raw_sources(version,state='before'):
 f=ROOT/version
 raw={p.name:p.read_bytes() for p in (f/'stock').iterdir()}
 raw.update({leaf:(f/(state+'.'+leaf)).read_bytes() for leaf in ('user.rules','user6.rules')})
 return raw
def proof(version,state='before',data=None,raw=None):
 return m.validate_raw(m.validate_semantics(m.validate_structure(m.validate_envelope(**(data or sources(version,state))))),raw or raw_sources(version,state))

class ThreeOSProfileTests(unittest.TestCase):
 def test_all_whole_generations_and_before_command_owned_transitions(self):
  u=sys.modules['ufw_integrity']
  for version in PROFILES:
   with self.subTest(version=version):
    expected=proof(version)
    for row in json.loads((ROOT/version/'manifest.json').read_bytes())['operations']:
     argv=row['argv'];state=row['after_state']
     if state!='after_noop':
      rule=u.ManagedTuple(argv[argv.index('from')+1],int(argv[argv.index('port')+1]),argv[argv.index('comment')+1])
      expected=m.predict_transition(expected,'delete' if '--force' in argv else 'add',rule,index=int(argv[2])-1 if argv[1]=='insert' else None)
     self.assertEqual(expected,proof(version,state))
 def test_opaque_argument_change_rejected_with_unchanged_native(self):
  for version in PROFILES:
   with self.subTest(version=version):
    data=sources(version);data['selected']=(k.KernelSave.parse(data['selected'][0].canonical.replace(b'[UFW ALLOW]',b'[OTHER]')),data['selected'][1])
    with self.assertRaises(k.KernelError):proof(version,data=data)
 def test_native_only_hook_and_extra_xt_statement_rejected(self):
  for version in PROFILES:
   for kind in ('hook','extra_xt'):
    with self.subTest(version=version,kind=kind):
     data=sources(version);rows=json.loads(data['native'].canonical)['nftables']
     if kind=='hook':rows.append({'table':{'family':'inet','name':'other'}})
     else:next(r['rule'] for r in rows if 'rule' in r)['expr'].insert(0,{'xt':None})
     data['native']=k.NativeRuleset.parse(json.dumps({'nftables':rows}).encode(),profile=PROFILES[version])
     with self.assertRaises(k.KernelError):proof(version,data=data)
 def test_mixed_version_triples_and_other_metainfo_rejected(self):
  for version in PROFILES:
   with self.subTest(version=version):
    data=sources(version);data['versions']['ip6tables']='ip6tables v9.0.0 (nf_tables)'
    with self.assertRaises(k.KernelError):proof(version,data=data)
    raw=(ROOT/version/'before.native.json').read_bytes()
    wrong=next(p for v,p in PROFILES.items() if v!=version)
    with self.assertRaises(k.KernelError):k.NativeRuleset.parse(raw,profile=wrong)
 def test_wrong_raw_stock_and_unknown_unmanaged_owner_rejected(self):
  for version in PROFILES:
   with self.subTest(version=version):
    raw=raw_sources(version);raw['before.rules']+=b'# unknown\\n'
    with self.assertRaises(k.KernelError):proof(version,raw=raw)
    data=sources(version);text=data['selected'][0].canonical.replace(b'-A ufw-user-input -p tcp',b'-A ufw-user-input -m owner --uid-owner 1001 -p tcp',1)
    data['selected']=(k.KernelSave.parse(text),data['selected'][1])
    with self.assertRaises(k.KernelError):proof(version,data=data)
 def test_all_profiles_keep_native_numeric_types_strict(self):
  u=sys.modules['ufw_integrity']
  for version in PROFILES:
   projected=m.predict_transition(proof(version),'add',u.ManagedTuple('128.0.0.0/1',1,'cloudfront-sync'))
   for field in ('prefixlen','port','counter','priority','float'):
    with self.subTest(version=version,field=field):
     env=projected.correspondence.structure.envelope
     data={'selected':env.selected,'native':env.native,'legacy':env.legacy,'versions':dict(env.versions)}
     rows=json.loads(env.native.canonical)['nftables']
     target=next(r['rule'] for r in rows if 'rule' in r and any(x.get('match',{}).get('right')=={'prefix':{'addr':'128.0.0.0','len':1}} for x in r['rule']['expr']))
     if field=='prefixlen':
      next(x['match']['right']['prefix'] for x in target['expr'] if isinstance(x.get('match',{}).get('right'),dict))['len']=True
     elif field=='counter':next(x['counter'] for x in target['expr'] if 'counter' in x)['bytes']=False
     elif field=='priority':next(r['chain'] for r in rows if r.get('chain',{}).get('name')=='INPUT')['prio']=False
     else:
      matches=[x['match'] for x in target['expr'] if x.get('match',{}).get('left')=={'payload':{'protocol':'tcp','field':'dport'}}]
      if matches:matches[0]['right']=True if field=='port' else 1.0
      else:target['expr'].append({'match':{'op':'==','left':{'payload':{'protocol':'tcp','field':'dport'}},'right':True if field=='port' else 1.0}})
     with self.assertRaises(k.KernelError):
      data['native']=k.NativeRuleset.parse(json.dumps({'nftables':rows}).encode(),profile=PROFILES[version])
      proof(version,data=data,raw=dict(projected.raw_files))

if __name__=='__main__':unittest.main()
