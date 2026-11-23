"""Byte-conservation and secure capture proofs, independent of the sync engine."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('ufw_integrity', Path(__file__).parents[1] / 'ufw_integrity.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)

HEADER = (b'*filter\n:ufw-user-input - [0:0]\n:ufw-user-output - [0:0]\n:ufw-user-forward - [0:0]\n'
          b':ufw-before-logging-input - [0:0]\n:ufw-before-logging-output - [0:0]\n:ufw-before-logging-forward - [0:0]\n'
          b':ufw-user-logging-input - [0:0]\n:ufw-user-logging-output - [0:0]\n:ufw-user-logging-forward - [0:0]\n'
          b':ufw-after-logging-input - [0:0]\n:ufw-after-logging-output - [0:0]\n:ufw-after-logging-forward - [0:0]\n'
          b':ufw-logging-deny - [0:0]\n:ufw-logging-allow - [0:0]\n### RULES ###\n')
FOOTER = (b'\n### END RULES ###\n\n### LOGGING ###\n'
          b'-I ufw-user-logging-input -j RETURN\n-I ufw-user-logging-output -j RETURN\n'
          b'-I ufw-user-logging-forward -j RETURN\n### END LOGGING ###\nCOMMIT\n')
ALLOW = (b'\n### tuple ### allow tcp 443 0.0.0.0/0 any 13.124.199.0/24 in comment=636c6f756466726f6e742d73796e63\n'
         b'-A ufw-user-input -p tcp --dport 443 -s 13.124.199.0/24 -j ACCEPT\n')
UNOWNED = b'\n### tuple ### allow tcp 22 0.0.0.0/0 any 203.0.113.1 in\n-A ufw-user-input -p tcp --dport 22 -s 203.0.113.1 -j ACCEPT\n'

class DocumentTests(unittest.TestCase):
    def setUp(self): self.profile = m.UserFileProfile(family=4, loglevel='off', limit_supported=False)
    def parse(self, raw): return m.UserRulesDocument.parse(raw, self.profile)
    def test_roundtrip_entire_file(self):
        raw = HEADER + UNOWNED + ALLOW + FOOTER
        self.assertEqual(self.parse(raw).to_bytes(), raw)
    def test_add_conserves_all_unowned_bytes(self):
        before = HEADER + UNOWNED + FOOTER
        doc = self.parse(before)
        after = doc.add(m.ManagedTuple('13.124.199.0/24', 443, 'cloudfront-sync'))
        self.assertEqual(after.to_bytes(), HEADER + UNOWNED + ALLOW + FOOTER)
        m.assert_transition(doc, after.to_bytes(), 'add', m.ManagedTuple('13.124.199.0/24',443,'cloudfront-sync'))
    def test_delete_and_restore_exact_original(self):
        original = HEADER + ALLOW + UNOWNED + FOOTER
        doc = self.parse(original)
        rule = m.ManagedTuple('13.124.199.0/24',443,'cloudfront-sync')
        self.assertEqual(doc.delete(rule).add(rule, index=0).to_bytes(), original)
    def test_does_not_claim_same_tuple_with_different_comment(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + UNOWNED + ALLOW + FOOTER).add(m.ManagedTuple('13.124.199.0/24',443,'another'))
    def test_unknown_comment_rejected_before_mutation(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + b'# admin edit\n' + UNOWNED + FOOTER)
    def test_extra_pending_iptables_row_rejected(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + UNOWNED + b'-A ufw-user-input -j ACCEPT\n' + FOOTER)
    def test_changed_tuple_body_rejected(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + ALLOW.replace(b'-j ACCEPT', b'-j DROP') + FOOTER)
    def test_modified_footer_rejected(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + ALLOW + FOOTER.replace(b'COMMIT',b'# hidden\nCOMMIT'))
    def test_changed_unowned_bytes_not_masked(self):
        doc = self.parse(HEADER + UNOWNED + FOOTER)
        actual = HEADER + UNOWNED.replace(b'203.0.113.1', b'203.0.113.2') + ALLOW + FOOTER
        with self.assertRaises(m.IntegrityError): m.assert_transition(doc, actual,'add',m.ManagedTuple('13.124.199.0/24',443,'cloudfront-sync'))
    def test_unknown_profile_rejected(self):
        with self.assertRaises(m.IntegrityError): m.UserFileProfile(family=4, profile='future-ufw')
    def test_duplicate_exact_tuple_rejected(self):
        with self.assertRaises(m.IntegrityError): self.parse(HEADER + ALLOW + ALLOW + FOOTER)

class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'etc/ufw/applications.d').mkdir(parents=True)
        (self.root/'etc/default').mkdir()
        (self.root/'etc/default/ufw').write_bytes(b'IPV6=yes\n')
        for name in ('user.rules','user6.rules','before.rules','before6.rules','after.rules','after6.rules','ufw.conf'):
            (self.root/'etc/ufw'/name).write_bytes(b'fixture-content\n')
    def capture(self): return m.capture_ufw(self.root, owner=os.geteuid())
    def test_complete_stable_fingerprint(self):
        a = self.capture(); b = self.capture()
        self.assertEqual(a.manifest,b.manifest)
        self.assertEqual(a.fingerprint,b.fingerprint)
        self.assertIn('/etc/default/ufw',a.contents)
        self.assertIn('/etc/ufw/before.rules',a.contents)
    def test_mode_byte_and_added_file_changes_are_detected(self):
        initial=self.capture()
        (self.root/'etc/ufw/before.rules').write_bytes(b'changed\n')
        self.assertNotEqual(initial.fingerprint,self.capture().fingerprint)
        prior=self.capture();os.chmod(self.root/'etc/ufw/after.rules',0o600)
        self.assertNotEqual(prior.fingerprint,self.capture().fingerprint)
        prior=self.capture();(self.root/'etc/ufw/extra').write_bytes(b'new')
        self.assertNotEqual(prior.fingerprint,self.capture().fingerprint)
    def test_symlink_refused(self):
        p=self.root/'etc/ufw/after.rules';p.unlink();p.symlink_to('/etc/passwd')
        with self.assertRaises(m.IntegrityError): self.capture()
    def test_hardlink_refused(self):
        os.link(self.root/'etc/ufw/before.rules',self.root/'etc/ufw/extra')
        with self.assertRaises(m.IntegrityError): self.capture()
    def test_writable_parent_refused(self):
        os.chmod(self.root/'etc/ufw',0o777)
        with self.assertRaises(m.IntegrityError): self.capture()
    def test_fifo_refused_without_reading(self):
        os.mkfifo(self.root/'etc/ufw/fifo')
        with self.assertRaises(m.IntegrityError): self.capture()
    def test_file_size_limit(self):
        with self.assertRaises(m.IntegrityError): m.capture_ufw(self.root,owner=os.geteuid(),max_file=2)


class AdditionalConservationTests(unittest.TestCase):
    setUp=DocumentTests.setUp
    parse=DocumentTests.parse
    def test_unowned_action_collision_is_rejected_before_prediction(self):
        deny = ALLOW.replace(b'allow tcp',b'deny tcp').replace(b'-j ACCEPT',b'-j DROP')
        with self.assertRaises(m.IntegrityError):
            self.parse(HEADER + deny + FOOTER).add(m.ManagedTuple('13.124.199.0/24',443,'cloudfront-sync'))
    def test_delete_empty_comment_does_not_delete_other_comment_tuple(self):
        no_comment = ALLOW.replace(b' comment=636c6f756466726f6e742d73796e63',b'')
        with self.assertRaises(m.IntegrityError):
            self.parse(HEADER + no_comment + ALLOW + FOOTER).delete(m.ManagedTuple('13.124.199.0/24',443,''))

class AdditionalCaptureTests(unittest.TestCase):
    setUp=CaptureTests.setUp
    capture=CaptureTests.capture
    def test_entry_limit_includes_default_file(self):
        current=self.capture()
        with self.assertRaises(m.IntegrityError):m.capture_ufw(self.root,owner=os.geteuid(),max_entries=len(current.manifest)-1)
    def test_open_uses_nonblocking_before_fstat(self):
        from unittest.mock import patch
        actual=os.open
        seen=[]
        def checked(path,flags,*args,**kwargs):
            if Path(path).is_file():
                self.assertTrue(flags & os.O_NONBLOCK,'a swapped FIFO must not block open before fstat')
                seen.append(path)
            return actual(path,flags,*args,**kwargs)
        with patch.object(m.os,'open',side_effect=checked):self.capture()
        self.assertTrue(seen)
    def test_changed_file_during_read_is_rejected(self):
        from unittest.mock import patch
        actual=os.read;mutated=False
        def race(fd,n):
            nonlocal mutated
            result=actual(fd,n)
            if not mutated:
                mutated=True
                path=self.root/'etc/default/ufw'
                path.write_bytes(b'IPV6=no\n')
            return result
        with patch.object(m.os,'read',side_effect=race):
            with self.assertRaises(m.IntegrityError):self.capture()
    def test_added_file_during_read_is_rejected(self):
        from unittest.mock import patch
        actual=os.read;mutated=False
        def race(fd,n):
            nonlocal mutated
            result=actual(fd,n)
            if not mutated:
                mutated=True;(self.root/'etc/ufw/applications.d/added').write_bytes(b'new')
            return result
        with patch.object(m.os,'read',side_effect=race):
            with self.assertRaises(m.IntegrityError):self.capture()
    def test_inventory_cannot_be_mutated_after_capture(self):
        inventory=self.capture()
        with self.assertRaises(TypeError):inventory.contents['/etc/default/ufw']=b'changed'
        with self.assertRaises(TypeError):inventory.manifest[0]['mode']=0o777

class InventoryTransitionTests(unittest.TestCase):
    setUp=CaptureTests.setUp
    capture=CaptureTests.capture
    def setUp(self):
        CaptureTests.setUp(self)
        self.profile=m.UserFileProfile(family=4,loglevel='off',limit_supported=False)
        self.path=self.root/'etc/ufw/user.rules'
        self.path.write_bytes(HEADER+UNOWNED+FOOTER)
        self.doc=m.UserRulesDocument.parse(self.path.read_bytes(),self.profile)
        self.before=self.capture()
        self.rule=m.ManagedTuple('13.124.199.0/24',443,'cloudfront-sync')
    def test_exact_owned_mutation_only(self):
        intent=m.predict_user_file(self.doc,'add',self.rule)
        self.path.write_bytes(intent.after_bytes)
        m.assert_inventory_transition(self.before,self.capture(),[intent])
    def test_protected_file_edit_not_absorbed(self):
        intent=m.predict_user_file(self.doc,'add',self.rule)
        self.path.write_bytes(intent.after_bytes)
        (self.root/'etc/ufw/before.rules').write_bytes(b'changed')
        with self.assertRaises(m.IntegrityError):m.assert_inventory_transition(self.before,self.capture(),[intent])
    def test_owned_plus_unknown_comment_not_absorbed(self):
        intent=m.predict_user_file(self.doc,'add',self.rule)
        self.path.write_bytes(intent.after_bytes+b'# concurrent root edit\n')
        with self.assertRaises(m.IntegrityError):m.assert_inventory_transition(self.before,self.capture(),[intent])
    def test_file_metadata_may_not_change_with_owned_mutation(self):
        intent=m.predict_user_file(self.doc,'add',self.rule)
        self.path.write_bytes(intent.after_bytes);os.chmod(self.path,0o600)
        with self.assertRaises(m.IntegrityError):m.assert_inventory_transition(self.before,self.capture(),[intent])
    def test_unexpected_file_addition_rejected(self):
        intent=m.predict_user_file(self.doc,'add',self.rule)
        self.path.write_bytes(intent.after_bytes);(self.root/'etc/ufw/new').write_bytes(b'extra')
        with self.assertRaises(m.IntegrityError):m.assert_inventory_transition(self.before,self.capture(),[intent])
    def test_noop_proves_all_bytes(self):
        m.assert_inventory_transition(self.before,self.capture(),[])
        self.path.write_bytes(self.path.read_bytes()+b'# not a noop\n')
        with self.assertRaises(m.IntegrityError):m.assert_inventory_transition(self.before,self.capture(),[])

class RealUfwGoldenTests(unittest.TestCase):
    directory=Path(__file__).parent/'fixtures/ufw'
    def test_stock_roundtrip_all_three_oses(self):
        import json,hashlib
        for version in ('22.04','24.04','26.04'):
            folder=self.directory/version;manifest=json.loads((folder/'manifest.json').read_text())
            self.assertTrue(manifest['real_enabled_ufw'])
            self.assertTrue(manifest['rollback_exact_bytes']);self.assertTrue(manifest['noop_exact_bytes'])
            for file in sorted(folder.glob('*.rules')):
                with self.subTest(version=version,file=file.name):
                    family=6 if file.name.endswith('user6.rules') else 4
                    raw=file.read_bytes();doc=m.UserRulesDocument.parse(raw,m.UserFileProfile(family))
                    self.assertEqual(doc.to_bytes(),raw)
    def test_actual_owned_operation_sequence(self):
        import json,ipaddress
        for version in ('22.04','24.04','26.04'):
            folder=self.directory/version;manifest=json.loads((folder/'manifest.json').read_text())
            docs={family:m.UserRulesDocument.parse((folder/('before.'+name)).read_bytes(),m.UserFileProfile(family)) for family,name in ((4,'user.rules'),(6,'user6.rules'))}
            for operation in manifest['operations']:
                argv=operation['argv'];source=argv[argv.index('from')+1]
                rule=m.ManagedTuple(source,int(argv[argv.index('port')+1]),argv[argv.index('comment')+1])
                family=ipaddress.ip_network(source).version
                for current,name in ((4,'user.rules'),(6,'user6.rules')):
                    actual=(folder/(operation['after_state']+'.'+name)).read_bytes()
                    with self.subTest(version=version,state=operation['after_state'],family=current):
                        if current!=family or operation['after_state']=='after_noop':self.assertEqual(docs[current].to_bytes(),actual)
                        else:
                            index=None
                            if 'insert' in argv:
                                index=int(argv[argv.index('insert')+1])-1
                                if family==6:index-=len(docs[4].blocks)
                            docs[current]=m.assert_transition(docs[current],actual,'delete' if 'delete' in argv else 'add',rule,index=index)
    def test_actual_logging_defaults_and_extended_rule_matrix(self):
        import json
        folder=self.directory/'profiles/26.04';manifest=json.loads((folder/'manifest.json').read_text())
        for case in manifest['cases']:
            for family,name in ((4,'user.rules'),(6,'user6.rules')):
                with self.subTest(profile=case['name'],family=family):
                    profile=m.UserFileProfile(family=family,**case['profile'])
                    raw=(folder/case['files'][name]['file']).read_bytes()
                    self.assertEqual(m.UserRulesDocument.parse(raw,profile).to_bytes(),raw)

class RejectBeforeRewriteTests(unittest.TestCase):
    setUp=DocumentTests.setUp
    parse=DocumentTests.parse
    def test_unsupported_protocol_ufw_would_skip_is_rejected(self):
        raw=ALLOW.replace(b' tcp ',b' inventedproto ').replace(b'-p tcp',b'-p inventedproto')
        with self.assertRaises(m.IntegrityError):self.parse(HEADER+raw+FOOTER)
    def test_invalid_port_ufw_would_skip_is_rejected(self):
        raw=ALLOW.replace(b'tcp 443 ',b'tcp 0 ').replace(b'--dport 443',b'--dport 0')
        with self.assertRaises(m.IntegrityError):self.parse(HEADER+raw+FOOTER)
    def test_invalid_equal_port_range_is_rejected(self):
        block=m.TupleBlock(('allow','tcp','443:443','0.0.0.0/0','any','13.124.199.0/24','in'))
        with self.assertRaises(m.IntegrityError):block.render(self.profile)
    def test_invalid_interface_alias_is_rejected(self):
        block=m.TupleBlock(('allow','tcp','443','0.0.0.0/0','any','13.124.199.0/24','in_eth0:1'))
        with self.assertRaises(m.IntegrityError):block.render(self.profile)
    def test_invalid_overlong_interface_is_rejected(self):
        block=m.TupleBlock(('allow','tcp','443','0.0.0.0/0','any','13.124.199.0/24','in_'+'a'*16))
        with self.assertRaises(m.IntegrityError):block.render(self.profile)

class CanonicalReadEligibilityTests(unittest.TestCase):
    def test_combined_interface_ufw_reader_would_drop_is_rejected(self):
        # UFW _read_rules uses in_\w+/out_\w+ when decoding a combined token.
        # A serializer-only proof must not accept a block its reader skips.
        block=m.TupleBlock(('route:allow','tcp','443','0.0.0.0/0','any','13.124.199.0/24','in_+!out_eth1'))
        with self.assertRaises(m.IntegrityError):block.render(m.UserFileProfile(4))

class CombinedInterfaceExtractionTests(unittest.TestCase):
    def test_internal_marker_is_not_used_as_the_extracted_interface(self):
        # Actual UFW uses search only for eligibility, then partition('_') for
        # extraction. Oracle recorded on real UFW readers on all three OSes.
        cases=(('in_+in_eth0!out_eth1','+in_eth0','eth1'),
               ('in_eth0!out_+out_eth1','eth0','+out_eth1'),
               ('in_+in_eth0!out_+out_eth1','+in_eth0','+out_eth1'))
        for token,interface_in,interface_out in cases:
            with self.subTest(token=token):
                fields=('route:allow','tcp','443','0.0.0.0/0','any','13.124.199.0/24',token)
                expected=('\n### tuple ### '+' '.join(fields)+'\n-A ufw-user-forward -i '+interface_in+' -o '+interface_out+' -p tcp --dport 443 -s 13.124.199.0/24 -j ACCEPT\n').encode()
                self.assertEqual(m.TupleBlock(fields).render(m.UserFileProfile(4)),expected)
    def test_outbound_combined_marker_without_reader_match_is_rejected(self):
        fields=('route:allow','tcp','443','0.0.0.0/0','any','13.124.199.0/24','in_eth0!out_+')
        with self.assertRaises(m.IntegrityError):m.TupleBlock(fields).render(m.UserFileProfile(4))

if __name__ == '__main__':
    unittest.main()
