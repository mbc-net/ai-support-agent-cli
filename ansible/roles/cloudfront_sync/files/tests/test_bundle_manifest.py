"""Pure C1 proofs. Entry bodies are synthetic, never installed/runtime programs."""
import copy
import dataclasses
import hashlib
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).parents[1] / 'bundle_manifest.py'
m = types.ModuleType('fixture_bundle_manifest')
sys.modules[m.__name__] = m
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), m.__dict__)
ENTRIES = ('cloudfront-sync.py', 'cloudfront-integrity-guard.py', 'install_cloudfront_sync.py')
HELPERS = ('bundled_source.py', 'bundle_manifest.py', 'ufw_integrity.py', 'ufw_kernel.py', 'ufw_kernel_mapping.py', 'ufw_docker_kernel.py', 'ufw_docker_transition.py', 'ufw_observation.py', 'nginx_observation.py', 'cloudfront_snapshot.py')
PROFILES = ('ufw_kernel_profile_22.json', 'ufw_kernel_profile_24.json', 'ufw_kernel_profile_26.json')


def sources():
    result = {name: ('BUNDLE_GENERATION_ID = "' + '0' * 64 + '"\nVALUE = 1\n').encode() for name in ENTRIES}
    result.update({name: ('# synthetic ' + name + '\nVALUE = 1\n').encode() for name in HELPERS})
    result.update({name: b'{"synthetic":true}\n' for name in PROFILES})
    return result


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.initial = sources()
        self.built = m.build_bundle(self.initial)

    def test_build_is_deterministic_order_independent_and_includes_installer(self):
        other = m.build_bundle(dict(reversed(list(self.initial.items()))))
        self.assertEqual(other.manifest, self.built.manifest)
        self.assertEqual(dict(other.assets), dict(self.built.assets))
        self.assertEqual(m.build_bundle(dict(self.built.assets)).manifest, self.built.manifest)
        manifest = json.loads(self.built.manifest)
        self.assertIn('install_cloudfront_sync.py', manifest['assets'])
        self.assertEqual(len(manifest['assets']), 16)
        self.assertEqual(hashlib.sha256(encoded(manifest['inputs'])[:-1]).hexdigest(), self.built.generation)
        for name in ENTRIES:
            self.assertIn(self.built.generation.encode(), self.built.assets[name])

    def test_full_validation_and_expectations_are_immutable_and_bound(self):
        verified = m.validate_bundle(self.built.manifest, self.built.assets, running_generation=self.built.generation)
        expected = m.helper_expectations(verified)
        self.assertEqual(set(expected), {'ufw_integrity', 'ufw_kernel', 'ufw_kernel_mapping', 'ufw_docker_kernel', 'ufw_docker_transition', 'ufw_observation', 'nginx_observation', 'cloudfront_snapshot'})
        for name, digest in expected.items():
            self.assertEqual(digest, hashlib.sha256(self.built.assets[name + '.py']).hexdigest())
        with self.assertRaises(TypeError):
            expected['ufw_kernel'] = '0' * 64
        with self.assertRaises(TypeError):
            self.built.assets['ufw_kernel.py'] = b'changed\n'

    def test_eight_actual_helper_sources_and_profiles_with_synthetic_entries(self):
        actual = {name:self.initial[name] for name in ENTRIES}
        for name in (*HELPERS,*PROFILES):
            actual[name] = (SOURCE.parent/name).read_bytes()
        built = m.build_bundle(actual)
        self.assertEqual(len(built.assets),16)
        verified = m.validate_bundle(built.manifest,built.assets,running_generation=built.generation)
        expected = m.helper_expectations(verified)
        self.assertEqual(tuple(expected),m.HELPER_NAMES)
        for name in expected:
            self.assertEqual(expected[name],hashlib.sha256(actual[name+'.py']).hexdigest())
        for name in ('ufw_docker_kernel','ufw_docker_transition','ufw_observation', 'nginx_observation', 'cloudfront_snapshot'):
            changed=dict(actual);changed[name+'.py'] += b'# changed generation\n'
            candidate=m.build_bundle(changed)
            self.assertNotEqual(candidate.generation,built.generation)
            with self.assertRaises(m.ManifestError):m.bootstrap_expectations(candidate.manifest,running_generation=built.generation)
    def test_previous_s0_fifteen_asset_shape_without_nginx_observation_is_rejected(self):
        # S0 shipped 15 assets; S1 adds nginx_observation.py. The S0 set is no bundle.
        old = {name: raw for name, raw in self.initial.items() if name != 'nginx_observation.py'}
        self.assertEqual(len(old), 15)
        with self.assertRaises(m.ManifestError) as caught:
            m.build_bundle(old)
        self.assertEqual(caught.exception.args, ('wrong_fixed_bundle_asset_set',))

    def test_old_running_literal_rejects_new_manifest_before_bootstrap(self):
        changed = sources()
        changed['ufw_kernel.py'] += b'# new generation\n'
        new = m.build_bundle(changed)
        self.assertNotEqual(self.built.generation, new.generation)
        with self.assertRaises(m.ManifestError):
            m.bootstrap_expectations(new.manifest, running_generation=self.built.generation)
        with self.assertRaises(m.ManifestError):
            m.validate_bundle(new.manifest, new.assets, running_generation=self.built.generation)

    def test_bootstrap_hashes_are_inputs_bound_not_unsigned_manifest_rows(self):
        expected = m.bootstrap_expectations(self.built.manifest, running_generation=self.built.generation)
        self.assertEqual(set(expected), {'bundle_manifest.py', 'bundled_source.py'})
        for name, digest in expected.items():
            self.assertEqual(digest, hashlib.sha256(self.built.assets[name]).hexdigest())
        altered = json.loads(self.built.manifest)
        altered['assets']['bundle_manifest.py']['sha256'] = 'f' * 64
        with self.assertRaises(m.ManifestError):
            m.bootstrap_expectations(encoded(altered), running_generation=self.built.generation)
        altered['inputs']['assets']['bundle_manifest.py']['source_sha256'] = 'f' * 64
        with self.assertRaises(m.ManifestError):
            m.bootstrap_expectations(encoded(altered), running_generation=self.built.generation)

    def test_source_change_with_same_stamp_is_not_an_approved_bundle(self):
        changed = dict(self.built.assets)
        changed['ufw_kernel.py'] = changed['ufw_kernel.py'].replace(b'VALUE = 1', b'VALUE = 2')
        altered = json.loads(self.built.manifest)
        altered['assets']['ufw_kernel.py']['sha256'] = hashlib.sha256(changed['ufw_kernel.py']).hexdigest()
        with self.assertRaises(m.ManifestError):
            m.validate_bundle(encoded(altered), changed, running_generation=self.built.generation)

    def test_entry_change_and_unsigned_raw_hash_cannot_evade_normalized_hash(self):
        changed = dict(self.built.assets)
        name = 'cloudfront-sync.py'
        changed[name] = changed[name].replace(b'VALUE = 1', b'VALUE = 2')
        altered = json.loads(self.built.manifest)
        altered['assets'][name]['sha256'] = hashlib.sha256(changed[name]).hexdigest()
        with self.assertRaises(m.ManifestError):
            m.validate_bundle(encoded(altered), changed, running_generation=self.built.generation)

    def test_one_fixed_literal_stamp_is_required(self):
        for body in (b'VALUE=1\n', b'BUNDLE_GENERATION_ID = "bad"\n',
                     sources()[ENTRIES[0]] + b'BUNDLE_GENERATION_ID = "' + b'0' * 64 + b'"\n',
                     b'BUNDLE_GENERATION_ID = "' + b'0' * 64 + b'"; VALUE=1\n',
                     sources()[ENTRIES[0]] + b'def BUNDLE_GENERATION_ID(): pass\n',
                     sources()[ENTRIES[0]] + b'del BUNDLE_GENERATION_ID\n'):
            with self.subTest(body=body):
                changed = sources()
                changed[ENTRIES[0]] = body
                with self.assertRaises(m.ManifestError):
                    m.build_bundle(changed)

    def test_fixed_asset_set_and_types_are_not_recipe_selectable(self):
        for change in ('extra', 'missing', 'text', 'mutable'):
            changed = sources()
            if change == 'extra': changed['unknown_helper.py'] = b'VALUE=1\n'
            elif change == 'missing': del changed['ufw_kernel.py']
            elif change == 'text': changed['ufw_kernel.py'] = 'VALUE=1\n'
            else: changed['ufw_kernel.py'] = bytearray(b'VALUE=1\n')
            with self.subTest(change=change):
                with self.assertRaises(m.ManifestError): m.build_bundle(changed)

    def test_manifest_duplicate_unknown_nonnumeric_and_noncanonical_data_rejected(self):
        bad = [self.built.manifest.replace(b'"version":1', b'"version":1,"version":1'),
               self.built.manifest.replace(b'"version":1', b'"version":true'),
               self.built.manifest.replace(b'"version":1', b'"version":1.0'),
               self.built.manifest.replace(b'"version":1', b'"version":NaN'),
               b' ' + self.built.manifest]
        extra = json.loads(self.built.manifest); extra['unknown'] = 1; bad.append(encoded(extra))
        for raw in bad:
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(m.ManifestError):
                    m.bootstrap_expectations(raw, running_generation=self.built.generation)

    def test_profile_and_file_lookup_trailing_bytes_are_not_normalized_away(self):
        changed = dict(self.built.assets)
        changed[PROFILES[2]] = changed[PROFILES[2]].rstrip()
        with self.assertRaises(m.ManifestError):
            m.validate_bundle(self.built.manifest, changed, running_generation=self.built.generation)
        self.assertNotEqual(m.build_bundle(changed).generation, self.built.generation)

    def test_size_aggregate_and_manifest_budgets(self):
        changed = sources(); changed['ufw_kernel.py'] = b'#' + b'x' * (2 * 1024 * 1024) + b'\n'
        with self.assertRaises(m.ManifestError): m.build_bundle(changed)
        changed = sources()
        for name in HELPERS: changed[name] = b'#' + b'x' * (1800 * 1024) + b'\n'
        with self.assertRaises(m.ManifestError): m.build_bundle(changed)
        with self.assertRaises(m.ManifestError):
            m.bootstrap_expectations(b' ' * (64 * 1024 + 1), running_generation=self.built.generation)

    def test_builder_and_validator_never_execute_source(self):
        changed = sources(); changed['ufw_kernel.py'] = b'raise RuntimeError("must not execute")\n'
        bundle = m.build_bundle(changed)
        m.validate_bundle(bundle.manifest, bundle.assets, running_generation=bundle.generation)

    def test_caller_dict_change_does_not_mix_an_already_captured_generation(self):
        caller = sources()
        original = m._source_inputs
        def mutate_after_inputs(assets):
            result = original(assets)
            caller[ENTRIES[0]] = caller[ENTRIES[0]].replace(b'VALUE = 1', b'VALUE = 2')
            return result
        with patch.object(m, '_source_inputs', side_effect=mutate_after_inputs):
            built = m.build_bundle(caller)
        m.validate_bundle(built.manifest, built.assets, running_generation=built.generation)
        self.assertIn(b'VALUE = 1', built.assets[ENTRIES[0]])

    def test_invalid_budget_is_rejected_before_any_python_ast_or_compile(self):
        changed = sources()
        for name in HELPERS: changed[name] = b'#' + b'x' * (1800 * 1024) + b'\n'
        with patch.object(m, 'compile', create=True, side_effect=AssertionError('source compiled before budget')):
            with patch.object(m.ast, 'parse', side_effect=AssertionError('source parsed before budget')):
                with self.assertRaises(m.ManifestError): m.build_bundle(changed)

    def test_current_helpers_and_profiles_with_synthetic_entries(self):
        # Provenance: only these three entry bodies remain synthetic. This is
        # not a packaged runtime or installer execution acceptance test.
        actual = sources()
        for name in (*HELPERS, *PROFILES): actual[name] = (SOURCE.parent / name).read_bytes()
        built = m.build_bundle(actual)
        verified = m.validate_bundle(built.manifest, built.assets, running_generation=built.generation)
        self.assertEqual(m.helper_expectations(verified)['ufw_kernel'], hashlib.sha256(actual['ufw_kernel.py']).hexdigest())

    def test_forged_verified_dataclass_does_not_authorize_hash_expectations(self):
        verified = m.validate_bundle(self.built.manifest, self.built.assets, running_generation=self.built.generation)
        assets = dict(verified.assets); assets['ufw_kernel.py'] += b'# changed\n'
        forged = dataclasses.replace(verified, assets=tuple(assets.items()))
        with self.assertRaises(m.ManifestError): m.helper_expectations(forged)


class RecoveryClassificationTests(unittest.TestCase):
    """Classification of supplied metadata only, not installer/kernel recovery proof."""
    def data(self):
        before = {'generation_id': 'a' * 64, 'state_sha256': '1' * 64, 'protected_sha256': '2' * 64,
                  'enrollment_id': '3' * 32, 'intent_sha256': '4' * 64, 'state_version': 2}
        return {'journal_kind': 'none', 'candidate_phase': 'proven_uncommitted',
                'candidate_generation': 'b' * 64, 'before': before,
                'observed': {**before, 'generation_id': 'b' * 64}, 'old_cohort_verified': True}

    def test_legacy_pending_never_becomes_automatic_mutable_recovery(self):
        data = self.data(); data['journal_kind'] = 'legacy23_pending'
        self.assertEqual(m.classify_recovery(**data), 'manual_legacy_pending')

    def test_true_kernel_pending_still_requires_independent_recovery_proof(self):
        data = self.data(); data['journal_kind'] = 'true_kernel_v2_pending'
        self.assertEqual(m.classify_recovery(**data), 'requires_independent_recovery_proof')

    def test_existing_v2_unchanged_before_can_only_be_a_rollback_candidate(self):
        self.assertEqual(m.classify_recovery(**self.data()), 'rollback_candidate_only')

    def test_committed_or_unknown_outcome_does_not_restore_even_with_same_hashes(self):
        for phase in ('applying', 'committed'):
            data = self.data(); data['candidate_phase'] = phase
            self.assertEqual(m.classify_recovery(**data), 'preserve_candidate')

    def test_state_protected_identity_intent_and_old_cohort_divergence_stops(self):
        for field, value in [('state_sha256', '5' * 64), ('protected_sha256', '5' * 64),
                             ('enrollment_id', '5' * 32), ('intent_sha256', '5' * 64), ('state_version', 1)]:
            data = self.data(); data['observed'][field] = value
            with self.subTest(field=field): self.assertEqual(m.classify_recovery(**data), 'manual_divergence')
        data = self.data(); data['old_cohort_verified'] = False
        self.assertEqual(m.classify_recovery(**data), 'manual_divergence')


if __name__ == '__main__':
    unittest.main()
