"""D2 pure transaction contract; no actors or deployment authority."""
import importlib.util
from pathlib import Path
import sys
import unittest
import test_ufw_docker_kernel as fixture
from dataclasses import replace

FILES = Path(__file__).resolve().parents[1]


def load_transition():
    fixture.setUpModule()
    spec = importlib.util.spec_from_file_location('ufw_docker_transition', FILES / 'ufw_docker_transition.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class TransactionBoundaryTests(unittest.TestCase):
    def test_missing_before_cannot_compile_transaction(self):
        module = load_transition()
        with self.assertRaises(ValueError):
            module.compile_transaction(None, approved_final_sources=('192.0.2.0/28',), ordered_intents=())

    def test_boolean_insertion_ordinal_is_not_an_integer(self):
        module = load_transition()
        with self.assertRaises(ValueError):
            module.OwnedIntent('add', '192.0.2.0/28', 443, 'CF', index=True)

    def test_intermediate_is_not_a_steady_candidate(self):
        module = load_transition()
        self.assertFalse(issubclass(module.IntermediateGeneration, module.NoPublishCandidate))


class WholePredictionTests(unittest.TestCase):
    def setup(self):
        module = load_transition()
        before = fixture.d.validate_no_publish(**fixture.full_fixture())
        return module, before

    def test_noop_has_exact_final_identity(self):
        module, before = self.setup()
        proof = module.compile_transaction(before, approved_final_sources=before.membership.paths.cf_sources, ordered_intents=())
        self.assertEqual(proof.final_candidate, before)
        self.assertFalse(proof.actual_docker_calibrated)

    def test_v4_add_has_exact_inverse_and_observation(self):
        module, before = self.setup()
        intent = module.OwnedIntent('add','198.18.0.0/28',443,'cloudfront-sync')
        sources = tuple(sorted(before.membership.paths.cf_sources+('198.18.0.0/28',)))
        proof = module.compile_transaction(before,approved_final_sources=sources,ordered_intents=(intent,))
        step = proof.generations[0]
        self.assertEqual(module.assert_observed(proof,1,inventory=step.inventory,representation=step.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package),step)
        self.assertEqual(proof.inverse_intents[0].operation,'delete')
        with self.assertRaises(ValueError):
            module.assert_observed(proof,1,inventory=before.inventory,representation=before.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package)

    def test_multiport_partial_owned_is_transaction_only(self):
        module,before=self.setup()
        inventory=before.inventory
        extra=[]
        for source in before.membership.paths.cf_sources:
            intent=module.OwnedIntent('add',source,80,'cloudfront-sync')
            inventory,_=module._inventory(inventory,intent);extra.append(intent.rule)
        paths=replace(before.membership.paths,cf_ports=(80,443))
        member=replace(before.membership,paths=paths)
        representation=module._compose(before.representation,inventory,member)
        before=fixture.d.validate_no_publish(representation=representation,membership=member,
            protected_inventory=inventory,inventory=inventory,owned_rules=tuple(module.ManagedTuple(*r) for r in before.owned_rules)+tuple(extra),
            legacy=before.legacy,docker_package=before.docker_package)
        intents=tuple(module.OwnedIntent('add','198.18.0.0/28',port,'cloudfront-sync') for port in (80,443))
        sources=tuple(sorted(before.membership.paths.cf_sources+('198.18.0.0/28',)))
        proof=module.compile_transaction(before,approved_final_sources=sources,ordered_intents=intents)
        self.assertEqual(len(proof.generations),2)
        partial=proof.generations[0]
        with self.assertRaises(ValueError):
            fixture.d.validate_no_publish(representation=partial.representation,membership=proof.final_candidate.membership,
                protected_inventory=partial.inventory,inventory=partial.inventory,
                owned_rules=tuple(module.ManagedTuple(*r) for r in partial.owned_rules),legacy=before.legacy,docker_package=before.docker_package)
        with self.assertRaises(ValueError):
            module.compile_transaction(partial,approved_final_sources=sources,ordered_intents=intents[1:])
        self.assertEqual(proof.final_candidate.membership.paths.cf_ports,(80,443))

    def test_v6_insert_and_delete_restore_exact_before(self):
        module,before=self.setup()
        source='2001:db8:beef::/64'
        intent=module.OwnedIntent('add',source,443,'cloudfront-sync',index=0)
        sources=tuple(sorted(before.membership.paths.cf_sources+(source,)))
        forward=module.compile_transaction(before,approved_final_sources=sources,ordered_intents=(intent,))
        reverse=module.compile_transaction(forward.final_candidate,approved_final_sources=before.membership.paths.cf_sources,
            ordered_intents=(module.OwnedIntent('delete',source,443,'cloudfront-sync'),))
        self.assertEqual(reverse.final_candidate.inventory,before.inventory)
        self.assertEqual(reverse.final_candidate.representation,before.representation)

    def test_actual_metadata_context_legacy_and_native_drift_reject(self):
        module,before=self.setup()
        proof=module.compile_transaction(before,approved_final_sources=before.membership.paths.cf_sources,ordered_intents=())
        u=sys.modules['ufw_integrity']
        rows=[dict(r) for r in before.inventory.manifest];rows[0]['mode'] ^= 1
        changed=u.UfwInventory(tuple(rows),dict(before.inventory.contents))
        cases=[{'inventory':changed}, {'legacy':(b'unknown',b'')},
            {'membership':replace(before.membership,admin_peers=())}, {'docker_package':'docker.io unknown'}]
        for changes in cases:
            kwargs=dict(inventory=before.inventory,representation=before.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package)
            kwargs.update(changes)
            with self.subTest(changes=tuple(changes)):
                with self.assertRaises(ValueError):module.assert_observed(proof,0,**kwargs)

    def test_boolean_generation_identity_is_not_equal_to_one(self):
        module,before=self.setup()
        intent=module.OwnedIntent('add','198.18.0.0/28',443,'cloudfront-sync')
        proof=module.compile_transaction(before,approved_final_sources=tuple(sorted(before.membership.paths.cf_sources+('198.18.0.0/28',))),ordered_intents=(intent,))
        step=proof.generations[0]
        forged=replace(proof,generations=(replace(step,ordinal=True),))
        with self.assertRaises(ValueError):module.assert_observed(forged,1,inventory=step.inventory,representation=step.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package)

    def test_duplicate_intents_and_empty_final_are_not_plans(self):
        module,before=self.setup()
        intent=module.OwnedIntent('add','198.18.0.0/28',443,'cloudfront-sync')
        for final,intents in [((),()),(tuple(sorted(before.membership.paths.cf_sources+('198.18.0.0/28',))),(intent,intent))]:
            with self.assertRaises(ValueError):module.compile_transaction(before,approved_final_sources=final,ordered_intents=intents)

    def empty_comment_before(self, module, before):
        # Documentary baseline: raw tuple comments differ; complete kernel/R
        # remains regenerated and independently validated by public D1.
        import hashlib
        u=sys.modules['ufw_integrity']
        contents=dict(before.inventory.contents)
        for family,leaf in ((4,'user.rules'),(6,'user6.rules')):
            path='/etc/ufw/'+leaf
            document=u.UserRulesDocument.parse(contents[path],u.UserFileProfile(family))
            contents[path]=replace(document,blocks=tuple(replace(block,comment_hex='') for block in document.blocks)).to_bytes()
        rows=[]
        for entry in before.inventory.manifest:
            row=dict(entry)
            if row['kind']=='file':row.update(size=len(contents[row['path']]),sha256=hashlib.sha256(contents[row['path']]).hexdigest())
            rows.append(row)
        inventory=u.UfwInventory(tuple(rows),contents)
        representation=module._compose(before.representation,inventory,before.membership)
        return fixture.d.validate_no_publish(representation=representation,membership=before.membership,
            protected_inventory=inventory,inventory=inventory,owned_rules=tuple(u.ManagedTuple(source,port,'') for source,port,unused in before.owned_rules),
            legacy=before.legacy,docker_package=before.docker_package)

    def test_empty_old_comment_new_tag_and_mixed_next_generation(self):
        module,before=self.setup();before=self.empty_comment_before(module,before)
        first='198.18.0.0/28';second='198.18.1.0/28'
        sources=tuple(sorted(before.membership.paths.cf_sources+(first,)))
        proof=module.compile_transaction(before,approved_final_sources=sources,
            ordered_intents=(module.OwnedIntent('add',first,443,'cloudfront-sync'),))
        self.assertIn((first,443,'cloudfront-sync'),proof.final_candidate.owned_rules)
        self.assertTrue(all((source,port,'') in proof.final_candidate.owned_rules for source,port,unused in before.owned_rules))
        restored=module.compile_transaction(proof.final_candidate,
            approved_final_sources=before.membership.paths.cf_sources,
            ordered_intents=(module.OwnedIntent('delete',first,443,'cloudfront-sync'),))
        self.assertEqual(restored.final_candidate.inventory,before.inventory)
        self.assertEqual(restored.final_candidate.representation,before.representation)
        self.assertEqual(restored.final_candidate.residual_native,before.residual_native)
        sources=tuple(sorted(sources+(second,)))
        next_proof=module.compile_transaction(proof.final_candidate,approved_final_sources=sources,
            ordered_intents=(module.OwnedIntent('add',second,443,'cloudfront-sync'),))
        # Removing an old untagged tuple must use its exact old identity.
        old_source=before.owned_rules[0][0]
        remaining=tuple(s for s in sources if s!=old_source)
        deleted=module.compile_transaction(next_proof.final_candidate,approved_final_sources=remaining,
            ordered_intents=(module.OwnedIntent('delete',old_source,443,''),))
        self.assertNotIn((old_source,443,''),deleted.final_candidate.owned_rules)
        self.assertIn((first,443,'cloudfront-sync'),deleted.final_candidate.owned_rules)

    def test_retagging_and_arbitrary_new_tag_are_rejected(self):
        module,before=self.setup();before=self.empty_comment_before(module,before)
        source='198.18.0.0/28';sources=tuple(sorted(before.membership.paths.cf_sources+(source,)))
        for comment in ('','arbitrary'):
            with self.subTest(comment=comment):
                with self.assertRaises(ValueError):module.compile_transaction(before,approved_final_sources=sources,
                    ordered_intents=(module.OwnedIntent('add',source,443,comment),))
        existing=before.owned_rules[0][0]
        with self.assertRaises(ValueError):module.compile_transaction(before,
            approved_final_sources=before.membership.paths.cf_sources,
            ordered_intents=(module.OwnedIntent('delete',existing,443,''),module.OwnedIntent('add',existing,443,'cloudfront-sync')))

    def test_wrong_final_delta_and_overlap_are_rejected(self):
        module,before=self.setup()
        for sources in (('203.0.113.0/28',),('198.18.0.0/28',)):
            with self.subTest(sources=sources):
                with self.assertRaises(ValueError):
                    module.compile_transaction(before,approved_final_sources=sources,ordered_intents=())

    def test_forged_transaction_and_boolean_observation_ordinal_reject(self):
        module,before=self.setup()
        proof=module.compile_transaction(before,approved_final_sources=before.membership.paths.cf_sources,ordered_intents=())
        for bad in (replace(proof,transaction_id='0'*64),):
            with self.assertRaises(ValueError):
                module.assert_observed(bad,0,inventory=before.inventory,representation=before.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package)
        with self.assertRaises(ValueError):
            module.assert_observed(proof,False,inventory=before.inventory,representation=before.representation,membership=before.membership,legacy=before.legacy,docker_package=before.docker_package)


if __name__ == '__main__':
    unittest.main()
