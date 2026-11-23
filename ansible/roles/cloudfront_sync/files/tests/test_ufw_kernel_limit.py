"""Narrow typed limit grammar and actual references, isolated from shared loaders."""
import importlib.util
import copy
import hashlib
from dataclasses import replace
import json
from pathlib import Path
import sys
import unittest

if __name__ != '__main__':
    class IsolatedTypedLimitTests(unittest.TestCase):
        def test_all_typed_limit_cases_in_fresh_subprocess(self):
            import subprocess
            result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve())],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
            sys.stderr.write(result.stdout.decode())
            self.assertEqual(result.returncode, 0, 'isolated typed limit tests failed')
else:
    FILES=Path(__file__).parents[1]
    for name in ('ufw_kernel','ufw_integrity','ufw_kernel_mapping'):
        spec=importlib.util.spec_from_file_location(name,FILES/(name+'.py'))
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    k=sys.modules['ufw_kernel'];u=sys.modules['ufw_integrity'];m=sys.modules['ufw_kernel_mapping']

    class TypedLimitTests(unittest.TestCase):
        def profile(self,version='26'):
            return json.loads((FILES/('ufw_kernel_profile_'+version+'.json')).read_bytes())

        def raw_rows(self,family=4,source='198.51.100.130',port=22):
            p=u.UserFileProfile(family)
            block=u.TupleBlock(('limit','tcp',str(port),'0.0.0.0/0' if family==4 else '::/0','any',source,'in'))
            return [line.decode() for line in block.render(p).splitlines() if line.startswith(b'-A ')]

        def test_new_documentary_source_three_rows_translate_each_profile(self):
            for version in ('22','24','26'):
                for family,source in ((4,'198.51.100.130'),(6,'2001:db8:feed::/64')):
                    with self.subTest(version=version,family=family):
                        rows=self.raw_rows(family,source,2222)
                        self.assertEqual(len(rows),3)
                        selected=[m._raw_to_compat(row,'ip' if family==4 else 'ip6',self.profile(version)) for row in rows]
                        self.assertTrue(all('--dport 2222' in row for row in selected))
                        self.assertIn('--seconds 30 --hitcount 6',selected[1])
                        self.assertTrue(selected[2].endswith('-user-limit-accept'))
                        for row in selected:
                            self.assertIsNotNone(m._narrow_limit(row,'ip' if family==4 else 'ip6',self.profile(version)))

        def test_native_new_limit_form_requires_calibrated_typed_meaning(self):
            for version in ('22','24','26'):
                for family,source in ((4,'198.51.100.130'),(6,'2001:db8:feed::/64')):
                    with self.subTest(version=version,family=family):
                        for ordinal,raw in enumerate(self.raw_rows(family,source,2222)):
                            row=m._raw_to_compat(raw,'ip' if family==4 else 'ip6',self.profile(version))
                            native=m._expected_native(m.RulePair('ip' if family==4 else 'ip6','filter',row.split()[1],ordinal,row.encode(),b''),self.profile(version))
                            self.assertIsInstance(native['expr'],list)

        def test_limit_extension_does_not_accept_parameter_changes(self):
            rows=self.raw_rows()
            for row in (rows[0].replace('--ctstate NEW','--ctstate ESTABLISHED'),rows[1].replace('--seconds 30','--seconds 31'),
                        rows[1].replace('--hitcount 6','--hitcount 7'),rows[2].replace('limit-accept','limit'),
                        rows[0].replace('-p tcp','-p udp'),rows[0].replace('198.51.100.130','0.0.0.0/0')):
                # Last verdict change can match another valid row only with the
                # complete fixed update prefix; this bare jump is not sufficient.
                with self.subTest(row=row):
                    with self.assertRaises(k.KernelError):m._raw_to_compat(row,'ip',self.profile())

        def test_noncanonical_source_port_extra_match_and_interface_reject(self):
            row=self.raw_rows()[1]
            variants=[row.replace('--dport 22','--dport 0'),row.replace('--dport 22','--dport 022'),
                row.replace('--dport 22','--dport 22:23'),row.replace('198.51.100.130','198.51.100.130/32'),
                row.replace('198.51.100.130','198.51.100.129/25'),row.replace('-p tcp','-i eth0 -p tcp'),
                row+' -m comment --comment arbitrary',row.replace('-user-input','-user-output'),
                row.replace('--ctstate NEW','--ctstate NEW,ESTABLISHED')]
            for row in variants:
                with self.subTest(row=row):
                    with self.assertRaises(k.KernelError):m._raw_to_compat(row,'ip',self.profile())


    FIXTURES=FILES/'tests/fixtures/kernel_limit'

    class ActualLimitCalibrationTests(unittest.TestCase):
        def actual(self,version,case_index=0):
            manifest=json.loads((FIXTURES/'manifest.json').read_bytes())
            raw=(FIXTURES/(version+'.json')).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),manifest['files'][version+'.json'])
            data=json.loads(raw);case=data['cases'][case_index];views=case['after']
            inputs={'selected':tuple(k.KernelSave.parse(bytes.fromhex(views[n])) for n in ('selected4','selected6')),
                    'native':k.NativeRuleset.parse(bytes.fromhex(views['native']),profile=data['native_profile']),
                    'legacy':tuple(bytes.fromhex(views[n]) for n in ('legacy4','legacy6')),'versions':data['tool_versions']}
            return inputs,{n:bytes.fromhex(v) for n,v in case['raw_sources_hex'].items()}

        def semantics(self,data):
            return m.validate_semantics(m.validate_structure(m.validate_envelope(**data)))

        def test_all_six_independent_whole_raw_selected_native_captures(self):
            for version in ('22.04','24.04','26.04'):
                for case in (0,1):
                    with self.subTest(version=version,case=case):
                        data,raw=self.actual(version,case)
                        proof=m.validate_raw(self.semantics(data),raw)
                        self.assertTrue(proof.raw_verified)
                        self.assertEqual(data['selected'],m._selected_from_raw(raw,m._profile_for(proof.correspondence.structure.envelope)))

        def test_hidden_compatibility_parameter_change_is_not_masked(self):
            changes=((b'--seconds 30',b'--seconds 31'),(b'--hitcount 6',b'--hitcount 7'),
                     (b'--name DEFAULT',b'--name OTHER'),(b'--mask 255.255.255.255',b'--mask 255.255.255.0'),
                     (b'--rsource',b'--rdest'),(b'--ctstate NEW',b'--ctstate ESTABLISHED'))
            for version in ('22.04','24.04','26.04'):
                for old,new in changes:
                    data,raw=self.actual(version)
                    tables=[]
                    for table in data['selected'][0].tables:
                        rules=list(table.rules)
                        index=next(i for i,line in enumerate(rules) if b'198.51.100.130/32' in line and b'--update' in line)
                        self.assertIn(old,rules[index]);rules[index]=rules[index].replace(old,new)
                        tables.append(k.KernelTable(table.name,table.chains,tuple(rules)))
                    data['selected']=(k.KernelSave(tuple(tables)),data['selected'][1])
                    # Opaque native slots may be unchanged. Complete compatibility
                    # arguments must reject each hidden semantic policy change.
                    with self.subTest(version=version,changed=old):
                        with self.assertRaises(k.KernelError):self.semantics(data)

        def test_missing_duplicate_and_reordered_limit_row_fail_complete_raw_agreement(self):
            for version in ('22.04','24.04','26.04'):
                for operation in ('missing','duplicate','reorder'):
                    data,raw=self.actual(version)
                    envelope=m.validate_envelope(**data);profile=m._profile_for(envelope)
                    table=data['selected'][0].tables[0];rules=list(table.rules)
                    indices=[i for i,line in enumerate(rules) if b'198.51.100.130/32' in line]
                    self.assertEqual(len(indices),3)
                    if operation=='missing':del rules[indices[0]]
                    elif operation=='duplicate':rules.insert(indices[0],rules[indices[0]])
                    else:rules[indices[0]],rules[indices[1]]=rules[indices[1]],rules[indices[0]]
                    data['selected']=(k.KernelSave((k.KernelTable(table.name,table.chains,tuple(rules)),)),data['selected'][1])
                    data['native']=m._native_from_selected(envelope.native,data['selected'],profile)
                    with self.subTest(version=version,operation=operation):
                        with self.assertRaises(k.KernelError):m.validate_raw(self.semantics(data),raw)

        def test_boolean_limit_port_one_is_not_integer_one(self):
            for version in ('24.04','26.04'):
                data,raw=self.actual(version)
                envelope=m.validate_envelope(**data);profile=m._profile_for(envelope)
                table=data['selected'][0].tables[0]
                rules=tuple(line.replace(b'--dport 22',b'--dport 1') if b'198.51.100.130/32' in line else line for line in table.rules)
                data['selected']=(k.KernelSave((k.KernelTable(table.name,table.chains,rules),)),data['selected'][1])
                data['native']=m._native_from_selected(envelope.native,data['selected'],profile)
                # Semantic positive at integer1, then a type-only forgery that old
                # Python dict equality could confuse with True.
                self.semantics(data)
                native=json.loads(data['native'].canonical)
                changed=0
                for record in native['nftables']:
                    rule=record.get('rule',{})
                    if rule.get('family')!='ip' or rule.get('chain')!='ufw-user-input':continue
                    if not any(expr.get('match',{}).get('right')=='198.51.100.130' for expr in rule['expr']):continue
                    for expr in rule['expr']:
                        match=expr.get('match',{})
                        if match.get('left',{}).get('payload',{}).get('field')=='dport':match['right']=True;changed+=1
                self.assertEqual(changed,3)
                data['native']=k.NativeRuleset.parse(json.dumps(native).encode(),profile=m.BACKEND_PROFILES[version]['native'])
                with self.subTest(version=version):
                    with self.assertRaises(k.KernelError):self.semantics(data)

    if __name__=='__main__':unittest.main()
