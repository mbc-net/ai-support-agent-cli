"""P2a supplied-model planner contract; no host observation or enforcement."""
import copy
import importlib.util
import ipaddress
import json
import os
import types
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[1] / 'service_access_policy.py'
SPEC = importlib.util.spec_from_file_location('service_access_policy_under_test', MODULE_PATH)
policy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = policy
SPEC.loader.exec_module(policy)

DIGEST = 'a' * 64
FLAGS = ('runtime_ready', 'observation_verified', 'edge_verified', 'enforcement_verified')
ERRORS = {
    'policy_schema_invalid', 'policy_limit_exceeded', 'policy_reference_invalid',
    'policy_cidr_invalid', 'policy_selection_empty', 'policy_ssh_deny_all_unsupported',
    'policy_port_conflict', 'policy_web_only_ssh_overlap', 'policy_route_unsupported',
    'policy_edge_not_exclusive', 'policy_effective_ssh_unknown',
    'policy_effective_ssh_mismatch', 'policy_scope_mismatch',
}


def refs(*definitions, categories=()):
    return {'definition_ids': list(definitions), 'category_ids': list(categories)}


def fixture():
    return {
        'schema': 'service-access-input-v1',
        'catalog': {
            'tenant_id': 'tenant-demo', 'project_id': 'project-demo', 'version': 1,
            'definitions': [
                {'id': 'admins', 'cidrs': ['192.0.2.10/32'], 'category_id': None},
                {'id': 'customer-a', 'cidrs': ['198.51.100.0/25'], 'category_id': 'customers'},
                {'id': 'customer-b', 'cidrs': ['198.51.100.128/25'], 'category_id': 'customers'},
            ],
            'categories': [{'id': 'customers'}, {'id': 'empty-category'}],
        },
        'host': {
            'id': 'host-demo', 'tenant_id': 'tenant-demo', 'project_id': 'project-demo',
            'generation': 1, 'rules_digest': DIGEST, 'ssh_ports': [22], 'management_ports': [10050],
        },
        'ssh': {
            'mode': 'restricted', 'sources': refs('admins'),
            'effective_allows': {'complete': True, 'entries': [
                {'id': 'ssh-rule', 'cidrs': ['192.0.2.10/32'], 'origin': 'managed'},
            ]},
        },
        'web_only': refs(categories=('customers',)),
        'web': [{
            'id': 'site-a', 'binding_id': 'binding-a', 'project_id': 'project-demo',
            'version': 1, 'port': 443, 'route': 'direct_only',
            'direct': {'mode': 'restricted', 'sources': refs('customer-a')},
            'viewer': None, 'proxy': None,
        }],
        'cloudfront': None,
    }


def edge(binding='binding-a', distribution='distribution-a', suffix='a'):
    resources = []
    for kind, aws_kind in [('web_acl', 'webacl'), ('ip_set', 'ipset'), ('custom_rule_group', 'rulegroup')]:
        resources.append({
            'arn': f'arn:aws:wafv2:us-east-1:123456789012:global/{aws_kind}/demo-{suffix}/id-{suffix}',
            'kind': kind, 'owner_binding_id': binding, 'referrer_binding_ids': [binding],
        })
    return {
        'profile': 'dedicated-edge-input-v1', 'account_id': '123456789012',
        'distribution_id': distribution, 'config_digest': DIGEST,
        'references_version': 1, 'resources': resources,
    }


def with_cloudfront(value, route='cloudfront_only', restricted=True):
    site = value['web'][0]
    site['route'] = route
    if route == 'cloudfront_only':
        site['direct'] = {'mode': 'deny_all', 'sources': refs()}
    site['viewer'] = {
        'mode': 'restricted' if restricted else 'public',
        'sources': refs('customer-a') if restricted else refs(),
        'edge': edge() if restricted else None,
    }
    site['proxy'] = {
        'profile': 'cloudfront-direct-nginx-candidate-v1',
        'distribution_id': 'distribution-a', 'secret_ref': {'id': 'secret-origin-demo', 'version': 1},
    }
    value['cloudfront'] = {
        'service': 'CLOUDFRONT_ORIGIN_FACING', 'sync_token': '123', 'digest': DIGEST,
        'cidrs': ['203.0.113.0/24', '2001:db8:ffff::/48'],
    }
    return value


def ordered_cidrs(values):
    return sorted(values, key=lambda c: (ipaddress.ip_network(c).version,
                                         int(ipaddress.ip_network(c).network_address),
                                         ipaddress.ip_network(c).prefixlen))


class ServiceAccessPolicyTests(unittest.TestCase):
    def reject(self, value, expected=None):
        with self.assertRaises(policy.PolicyError) as raised:
            policy.plan_policy(value)
        error = raised.exception
        self.assertIn(error.code, ERRORS)
        if expected is not None:
            self.assertEqual(error.code, expected)
        self.assertEqual(str(error), error.code)
        for sensitive in ('192.0.2.', '198.51.100.', 'secret-origin-demo', 'arn:aws:', 'private-input-marker'):
            self.assertNotIn(sensitive, str(error))
            self.assertNotIn(sensitive, repr(error))
        return error

    def candidate(self, value=None):
        return policy.plan_policy(fixture() if value is None else value)

    def test_direct_candidate_exact_contract(self):
        candidate = self.candidate()
        self.assertIsInstance(candidate, policy.PolicyCandidate)
        result = candidate.to_dict()
        self.assertEqual(set(result), {'schema', 'status', 'input_digest', 'host_id', 'projections', *FLAGS})
        self.assertEqual(result['schema'], 'service-access-candidate-v1')
        self.assertEqual(result['status'], 'supplied_model_consistent')
        self.assertRegex(result['input_digest'], r'^[0-9a-f]{64}$')
        self.assertEqual(result['host_id'], 'host-demo')
        for name in FLAGS:
            self.assertIs(result[name], False)
        projection = result['projections']
        self.assertEqual(set(projection), {'ssh_sources', 'web_only_sources', 'sites', 'firewall'})
        self.assertEqual(projection['ssh_sources'], ['192.0.2.10/32'])
        self.assertEqual(set(projection['web_only_sources']), {'198.51.100.0/25', '198.51.100.128/25'})
        site = projection['sites'][0]
        self.assertEqual(set(site), {'id', 'binding_id', 'project_id', 'port', 'route', 'direct_sources',
                                    'viewer_mode', 'viewer_sources', 'peer_sources', 'trusted_proxy_sources',
                                    'secret_ref', 'edge'})
        self.assertEqual(site['direct_sources'], ['198.51.100.0/25'])
        for name in ('viewer_mode', 'viewer_sources', 'secret_ref', 'edge'):
            self.assertIsNone(site[name])
        self.assertEqual(site['peer_sources'], [])
        self.assertEqual(site['trusted_proxy_sources'], [])
        self.assertEqual(projection['firewall'], [
            {'service': 'ssh', 'protocol': 'tcp', 'port': 22, 'source': '192.0.2.10/32', 'owners': ['ssh']},
            {'service': 'web', 'protocol': 'tcp', 'port': 443, 'source': '198.51.100.0/25', 'owners': ['binding-a']},
        ])

    def test_candidate_and_input_are_defensively_copied(self):
        value = with_cloudfront(fixture())
        original = copy.deepcopy(value)
        candidate = self.candidate(value)
        self.assertEqual(value, original)
        before = candidate.to_dict()
        value['web'][0]['proxy']['secret_ref']['id'] = 'changed-input'
        exposed = candidate.to_dict()
        exposed['projections']['sites'][0]['secret_ref']['id'] = 'changed-output'
        exposed['projections']['firewall'].clear()
        self.assertEqual(candidate.to_dict(), before)

    def test_summary_and_repr_never_expose_private_input(self):
        candidate = self.candidate(with_cloudfront(fixture()))
        summary = candidate.public_summary()
        self.assertEqual(set(summary), {'status', 'input_digest', 'counts', *FLAGS})
        self.assertEqual(summary['status'], 'supplied_model_consistent')
        self.assertEqual(summary['input_digest'], candidate.to_dict()['input_digest'])
        self.assertEqual(summary['counts'], {'sites': 1, 'firewall_rules': 3, 'ssh_sources': 1, 'web_only_sources': 2})
        for name in FLAGS:
            self.assertIs(summary[name], False)
        summary['counts']['sites'] = 100
        self.assertEqual(candidate.public_summary()['counts']['sites'], 1)
        for raw in (json.dumps(candidate.public_summary()), repr(candidate)):
            for sensitive in ('192.0.2.', '203.0.113.', '2001:db8', 'site-a', 'binding-a', 'host-demo',
                              'project-demo', 'secret-origin-demo', 'arn:aws:'):
                self.assertNotIn(sensitive, raw)

    def test_permuting_sets_and_records_preserves_digest_and_projection(self):
        value = with_cloudfront(fixture())
        value['web'][0]['viewer']['sources'] = refs('customer-a', 'customer-b', categories=('customers',))
        another = copy.deepcopy(value['web'][0])
        another.update(id='site-b', binding_id='binding-b')
        another['viewer']['edge'] = edge('binding-b', 'distribution-b', 'b')
        another['proxy']['distribution_id'] = 'distribution-b'
        value['web'].append(another)
        expected = self.candidate(value).to_dict()
        changed = copy.deepcopy(value)
        changed['catalog']['definitions'].reverse()
        changed['catalog']['categories'].reverse()
        changed['web'].reverse()
        changed['cloudfront']['cidrs'].reverse()
        for site in changed['web']:
            site['viewer']['sources']['definition_ids'].reverse()
            site['viewer']['edge']['resources'].reverse()
        self.assertEqual(self.candidate(changed).to_dict(), expected)

    def test_semantic_versions_references_and_host_change_digest(self):
        value = with_cloudfront(fixture())
        baseline = self.candidate(value).to_dict()['input_digest']
        changes = [
            ('catalog', lambda x: x['catalog'].__setitem__('version', 2)),
            ('host generation', lambda x: x['host'].__setitem__('generation', 2)),
            ('rules digest', lambda x: x['host'].__setitem__('rules_digest', 'b' * 64)),
            ('site version', lambda x: x['web'][0].__setitem__('version', 2)),
            ('secret version', lambda x: x['web'][0]['proxy']['secret_ref'].__setitem__('version', 2)),
            ('edge version', lambda x: x['web'][0]['viewer']['edge'].__setitem__('references_version', 2)),
            ('feed token', lambda x: x['cloudfront'].__setitem__('sync_token', '124')),
            ('source refs', lambda x: x['web'][0]['viewer'].__setitem__('sources', refs('customer-b'))),
        ]
        for label, change in changes:
            with self.subTest(label=label):
                changed = copy.deepcopy(value)
                change(changed)
                self.assertNotEqual(self.candidate(changed).to_dict()['input_digest'], baseline)

    def test_unknown_keys_and_schema_are_rejected(self):
        for target in ('top', 'catalog', 'host', 'ssh', 'definition', 'site', 'sources'):
            with self.subTest(target=target):
                value = fixture()
                obj = {'top': value, 'catalog': value['catalog'], 'host': value['host'], 'ssh': value['ssh'],
                       'definition': value['catalog']['definitions'][0], 'site': value['web'][0],
                       'sources': value['web_only']}[target]
                obj['private-input-marker'] = 'private-input-marker'
                self.reject(value, 'policy_schema_invalid')
        value = fixture()
        value['schema'] = 'service-access-input-v2'
        self.reject(value, 'policy_schema_invalid')

    def test_scope_mismatches_are_rejected(self):
        for target, key in (('host', 'tenant_id'), ('host', 'project_id'), ('site', 'project_id')):
            with self.subTest(target=target, key=key):
                value = fixture()
                (value['host'] if target == 'host' else value['web'][0])[key] = 'foreign-scope'
                self.reject(value, 'policy_scope_mismatch')

    def test_versions_are_positive_safe_integers(self):
        for bad in (0, -1, True, 1.0, '1', 2**53):
            for field in ('catalog', 'host', 'site'):
                with self.subTest(bad=bad, field=field):
                    value = fixture()
                    obj, key = (value['catalog'], 'version') if field == 'catalog' else (value['host'], 'generation') if field == 'host' else (value['web'][0], 'version')
                    obj[key] = bad
                    self.reject(value, 'policy_schema_invalid')
        value = fixture()
        value['host']['generation'] = 2**53 - 1
        self.candidate(value)

    def test_ascii_identifiers_and_digest_types_are_strict(self):
        for field, bad in (('id', '秘密'), ('rules_digest', 'G' * 64), ('rules_digest', 'a' * 63)):
            with self.subTest(field=field, bad=bad):
                value = fixture()
                value['host'][field] = bad
                self.reject(value, 'policy_schema_invalid')

    def test_port_types_bounds_uniqueness_and_ssh_presence(self):
        for ports in ([], [0], [65536], [True], ['22'], [22, 22]):
            with self.subTest(ports=ports):
                value = fixture()
                value['host']['ssh_ports'] = ports
                self.reject(value, 'policy_schema_invalid')
        value = fixture()
        value['host']['management_ports'] = []
        self.candidate(value)

    def test_unknown_or_duplicate_source_references(self):
        for source in (refs('missing'), refs(categories=('missing',)), refs('admins', 'admins'), refs(categories=('customers', 'customers'))):
            with self.subTest(source=source):
                value = fixture()
                value['web_only'] = source
                self.reject(value, 'policy_reference_invalid')

    def test_empty_selected_category_and_restricted_selection_fail(self):
        for source in (refs(), refs(categories=('empty-category',))):
            with self.subTest(source=source):
                value = fixture()
                value['web'][0]['direct']['sources'] = source
                self.reject(value, 'policy_selection_empty')
        value = fixture()
        value['web_only'] = refs(categories=('empty-category',))
        self.reject(value, 'policy_selection_empty')

    def test_catalog_duplicate_ids_and_dangling_category_fail(self):
        for kind in ('definition duplicate', 'category duplicate', 'dangling category'):
            with self.subTest(kind=kind):
                value = fixture()
                if kind == 'definition duplicate':
                    value['catalog']['definitions'].append(copy.deepcopy(value['catalog']['definitions'][0]))
                elif kind == 'category duplicate':
                    value['catalog']['categories'].append(copy.deepcopy(value['catalog']['categories'][0]))
                else:
                    value['catalog']['definitions'][0]['category_id'] = 'missing'
                self.reject(value, 'policy_reference_invalid')

    def test_noncanonical_unsafe_and_universal_static_cidrs_fail(self):
        for cidr in ('198.51.100.1/25', '198.51.100.1', '2001:0db8::/32', 'fe80::%eth0/64',
                     '::ffff:c000:201/128', '0.0.0.0/0', '::/0', '１２７.0.0.1/32'):
            with self.subTest(cidr=cidr):
                value = fixture()
                value['catalog']['definitions'][1]['cidrs'] = [cidr]
                self.reject(value, 'policy_cidr_invalid')

    def test_duplicate_cidrs_are_rejected_in_each_input_set(self):
        for target in ('catalog', 'effective', 'cloudfront'):
            with self.subTest(target=target):
                value = with_cloudfront(fixture()) if target == 'cloudfront' else fixture()
                cidrs = value['catalog']['definitions'][0]['cidrs'] if target == 'catalog' else value['ssh']['effective_allows']['entries'][0]['cidrs'] if target == 'effective' else value['cloudfront']['cidrs']
                cidrs.append(cidrs[0])
                self.reject(value)

    def test_source_union_deduplicates_without_collapsing(self):
        value = fixture()
        value['web'][0]['direct']['sources'] = refs('customer-a', categories=('customers',))
        sources = self.candidate(value).to_dict()['projections']['sites'][0]['direct_sources']
        self.assertEqual(set(sources), {'198.51.100.0/25', '198.51.100.128/25'})
        self.assertEqual(len(sources), 2)

    def test_restricted_services_cannot_cover_whole_family_via_split_cidrs(self):
        for cidrs in (['0.0.0.0/1', '128.0.0.0/1'], ['::/1', '8000::/1']):
            for service in ('ssh', 'direct', 'viewer'):
                with self.subTest(cidrs=cidrs, service=service):
                    value = with_cloudfront(fixture()) if service == 'viewer' else fixture()
                    target = 0 if service == 'ssh' else 1
                    value['catalog']['definitions'][target]['cidrs'] = cidrs
                    value['web_only'] = refs()
                    if service == 'ssh':
                        value['ssh']['effective_allows']['entries'] = []
                    self.reject(value, 'policy_cidr_invalid')

    def test_web_only_overlap_checks_full_intervals_not_test_address(self):
        for cidrs in (['198.51.100.64/26'], ['198.51.100.200/32'], ['198.51.100.0/24'], ['0.0.0.0/0']):
            with self.subTest(cidrs=cidrs):
                value = fixture()
                value['ssh']['effective_allows']['entries'][0].update(cidrs=cidrs, origin='unmanaged')
                self.reject(value, 'policy_web_only_ssh_overlap')
        value = fixture()
        value['catalog']['definitions'][1]['cidrs'] = ['2001:db8:1::/48']
        value['ssh']['effective_allows']['entries'][0]['cidrs'] = ['2001:db8:1:abcd::/64']
        self.reject(value, 'policy_web_only_ssh_overlap')

    def test_chosen_ssh_sources_cannot_be_omitted_from_overlap_check(self):
        value = fixture()
        value['web_only'] = refs('admins')
        value['ssh']['effective_allows']['entries'] = []
        self.reject(value, 'policy_web_only_ssh_overlap')

    def test_effective_ssh_requires_explicit_complete_true(self):
        for complete in (False, None, 1, 'true'):
            with self.subTest(complete=complete):
                value = fixture()
                value['ssh']['effective_allows']['complete'] = complete
                self.reject(value, 'policy_effective_ssh_unknown')

    def test_restricted_ssh_rejects_residual_permissions_outside_selection(self):
        for residual in ('0.0.0.0/0', '192.0.2.0/24', '2001:db8::/32'):
            with self.subTest(residual=residual):
                value = fixture()
                value['web_only'] = refs()
                value['ssh']['effective_allows']['entries'][0].update(cidrs=[residual], origin='default_allow')
                self.reject(value, 'policy_effective_ssh_mismatch')

    def test_restricted_ssh_accepts_semantically_narrow_or_split_residuals(self):
        for residuals in ([], ['192.0.2.0/25'], ['192.0.2.0/25', '192.0.2.128/25']):
            with self.subTest(residuals=residuals):
                value = fixture()
                value['catalog']['definitions'][0]['cidrs'] = ['192.0.2.0/24']
                value['ssh']['effective_allows']['entries'] = [] if not residuals else [{'id': 'residual', 'cidrs': residuals, 'origin': 'other_path'}]
                self.assertEqual(self.candidate(value).to_dict()['projections']['ssh_sources'], ['192.0.2.0/24'])

    def test_unmanaged_ssh_has_no_mutation_but_still_enforces_web_only(self):
        value = fixture()
        value['ssh'].update(mode='unmanaged', sources=refs())
        result = self.candidate(value)
        self.assertIsNone(result.to_dict()['projections']['ssh_sources'])
        self.assertTrue(all(r['service'] != 'ssh' for r in result.to_dict()['projections']['firewall']))
        self.assertEqual(result.public_summary()['counts']['ssh_sources'], 0)
        value['ssh']['effective_allows']['entries'][0]['cidrs'] = ['0.0.0.0/0']
        self.reject(value, 'policy_web_only_ssh_overlap')
        value = fixture()
        value['ssh']['mode'] = 'unmanaged'
        self.reject(value, 'policy_schema_invalid')

    def test_ssh_deny_all_is_explicitly_unsupported(self):
        value = fixture()
        value['ssh'].update(mode='deny_all', sources=refs())
        self.reject(value, 'policy_ssh_deny_all_unsupported')

    def test_web_cannot_overlap_actual_ssh_or_management_ports(self):
        for kind, port in (('ssh_ports', 2222), ('management_ports', 8443)):
            with self.subTest(kind=kind):
                value = fixture()
                value['host'][kind] = [port]
                value['web'][0]['port'] = port
                self.reject(value, 'policy_port_conflict')

    def test_direct_deny_all_creates_no_web_permission(self):
        value = fixture()
        value['web'][0]['direct'] = {'mode': 'deny_all', 'sources': refs()}
        result = self.candidate(value).to_dict()['projections']
        self.assertEqual(result['sites'][0]['direct_sources'], [])
        self.assertTrue(all(r['service'] != 'web' for r in result['firewall']))

    def test_mixed_projection_separates_customer_viewer_peer_and_proxy(self):
        value = with_cloudfront(fixture(), route='mixed')
        result = self.candidate(value).to_dict()['projections']
        site = result['sites'][0]
        self.assertEqual(site['direct_sources'], ['198.51.100.0/25'])
        self.assertEqual(site['viewer_sources'], ['198.51.100.0/25'])
        self.assertEqual(site['peer_sources'], value['cloudfront']['cidrs'])
        self.assertEqual(site['trusted_proxy_sources'], value['cloudfront']['cidrs'])
        self.assertEqual(site['secret_ref'], {'id': 'secret-origin-demo', 'version': 1})
        self.assertNotIn('198.51.100.0/25', site['trusted_proxy_sources'])
        self.assertTrue(all(r['source'] == '192.0.2.10/32' for r in result['firewall'] if r['service'] == 'ssh'))

    def test_cloudfront_viewers_do_not_become_origin_firewall_sources(self):
        value = with_cloudfront(fixture())
        result = self.candidate(value).to_dict()['projections']
        self.assertEqual(result['sites'][0]['direct_sources'], [])
        self.assertEqual({r['source'] for r in result['firewall'] if r['service'] == 'web'}, set(value['cloudfront']['cidrs']))
        expected_edge = copy.deepcopy(value['web'][0]['viewer']['edge'])
        expected_edge['resources'].sort(key=lambda resource: resource['arn'])
        self.assertEqual(result['sites'][0]['edge'], expected_edge)

    def test_public_cloudfront_requires_explicit_mode_and_no_viewer_refs_or_edge(self):
        value = with_cloudfront(fixture(), restricted=False)
        site = self.candidate(value).to_dict()['projections']['sites'][0]
        self.assertEqual(site['viewer_mode'], 'public')
        self.assertIsNone(site['viewer_sources'])
        self.assertIsNone(site['edge'])
        for change in ('sources', 'edge'):
            with self.subTest(change=change):
                changed = copy.deepcopy(value)
                changed['web'][0]['viewer'][change] = refs('customer-a') if change == 'sources' else edge()
                self.reject(changed, 'policy_schema_invalid')

    def test_route_shapes_and_unsupported_proxy_profiles_fail(self):
        cases = []
        direct = fixture()
        direct['web'][0]['viewer'] = {'mode': 'public', 'sources': refs(), 'edge': None}
        cases.append(direct)
        cf = with_cloudfront(fixture())
        cf['web'][0]['direct'] = {'mode': 'restricted', 'sources': refs('customer-a')}
        cases.append(cf)
        mixed = with_cloudfront(fixture(), route='mixed')
        mixed['web'][0]['direct'] = {'mode': 'deny_all', 'sources': refs()}
        cases.append(mixed)
        unknown = fixture()
        unknown['web'][0]['route'] = 'automatic'
        cases.append(unknown)
        alb = with_cloudfront(fixture())
        alb['web'][0]['proxy']['profile'] = 'cloudfront-alb-nginx-candidate-v1'
        cases.append(alb)
        for value in cases:
            with self.subTest(route=value['web'][0]['route']):
                self.reject(value, 'policy_route_unsupported')

    def test_cloudfront_feed_required_exactly_when_used(self):
        value = with_cloudfront(fixture())
        value['cloudfront'] = None
        self.reject(value, 'policy_schema_invalid')
        value = with_cloudfront(fixture())
        value['web'] = fixture()['web']
        self.reject(value, 'policy_schema_invalid')

    def test_feed_service_token_digest_and_family_contract(self):
        for key, bad in (('service', 'EC2'), ('sync_token', '01'), ('sync_token', '-1'), ('sync_token', '1' * 21),
                         ('sync_token', 123), ('digest', 'x' * 64), ('cidrs', ['203.0.113.0/24'])):
            with self.subTest(key=key, bad=bad):
                value = with_cloudfront(fixture())
                value['cloudfront'][key] = bad
                self.reject(value)
        value = with_cloudfront(fixture())
        value['cloudfront']['sync_token'] = '0'
        self.candidate(value)

    def test_edge_requires_supplied_exclusive_ownership_and_references(self):
        for change in ('owner', 'foreign ref', 'empty refs', 'duplicate refs'):
            with self.subTest(change=change):
                value = with_cloudfront(fixture())
                resource = value['web'][0]['viewer']['edge']['resources'][0]
                if change == 'owner':
                    resource['owner_binding_id'] = 'binding-foreign'
                elif change == 'foreign ref':
                    resource['referrer_binding_ids'].append('binding-foreign')
                elif change == 'empty refs':
                    resource['referrer_binding_ids'] = []
                else:
                    resource['referrer_binding_ids'].append('binding-a')
                self.reject(value, 'policy_edge_not_exclusive')

    def test_edge_arn_account_region_scope_and_resource_kind_match(self):
        for arn in ('arn:aws:wafv2:eu-west-1:123456789012:global/webacl/demo/id',
                    'arn:aws:wafv2:us-east-1:999999999999:global/webacl/demo/id',
                    'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/demo/id',
                    'arn:aws:wafv2:us-east-1:123456789012:global/ipset/demo/id', 'not-an-arn'):
            with self.subTest(arn=arn):
                value = with_cloudfront(fixture())
                value['web'][0]['viewer']['edge']['resources'][0]['arn'] = arn
                self.reject(value, 'policy_edge_not_exclusive')

    def test_edge_requires_one_acl_at_least_one_ipset_and_matching_distribution(self):
        for kind in ('no acl', 'two acl', 'no ipset', 'distribution', 'profile', 'account'):
            with self.subTest(kind=kind):
                value = with_cloudfront(fixture())
                model = value['web'][0]['viewer']['edge']
                if kind == 'no acl':
                    model['resources'] = [r for r in model['resources'] if r['kind'] != 'web_acl']
                elif kind == 'two acl':
                    extra = copy.deepcopy(model['resources'][0])
                    extra['arn'] += '-other'
                    model['resources'].append(extra)
                elif kind == 'no ipset':
                    model['resources'] = [r for r in model['resources'] if r['kind'] != 'ip_set']
                elif kind == 'distribution':
                    model['distribution_id'] = 'foreign-distribution'
                elif kind == 'profile':
                    model['profile'] = 'measured-exclusivity-v1'
                else:
                    model['account_id'] = '123'
                self.reject(value)

    def test_duplicate_resource_arns_local_and_across_sites_fail(self):
        value = with_cloudfront(fixture())
        resources = value['web'][0]['viewer']['edge']['resources']
        resources.append(copy.deepcopy(resources[1]))
        self.reject(value, 'policy_edge_not_exclusive')
        value = with_cloudfront(fixture())
        other = copy.deepcopy(value['web'][0])
        other.update(id='site-b', binding_id='binding-b')
        for resource in other['viewer']['edge']['resources']:
            resource.update(owner_binding_id='binding-b', referrer_binding_ids=['binding-b'])
        value['web'].append(other)
        self.reject(value, 'policy_edge_not_exclusive')

    def test_shared_web_permission_aggregates_all_owners_once(self):
        value = fixture()
        other = copy.deepcopy(value['web'][0])
        other.update(id='site-b', binding_id='binding-b')
        value['web'].append(other)
        web_rules = [r for r in self.candidate(value).to_dict()['projections']['firewall'] if r['service'] == 'web']
        self.assertEqual(web_rules, [{'service': 'web', 'protocol': 'tcp', 'port': 443,
                                    'source': '198.51.100.0/25', 'owners': ['binding-a', 'binding-b']}])
        value['web'].pop(0)
        surviving = [r for r in self.candidate(value).to_dict()['projections']['firewall'] if r['service'] == 'web']
        self.assertEqual(surviving[0]['owners'], ['binding-b'])

    def test_duplicate_site_and_binding_ids_fail(self):
        for duplicate in ('id', 'binding_id'):
            with self.subTest(duplicate=duplicate):
                value = fixture()
                other = copy.deepcopy(value['web'][0])
                other['id'] = 'site-b' if duplicate != 'id' else 'site-a'
                other['binding_id'] = 'binding-b' if duplicate != 'binding_id' else 'binding-a'
                value['web'].append(other)
                self.reject(value, 'policy_reference_invalid')

    def test_catalog_site_reference_and_definition_limits(self):
        for kind in ('definitions', 'categories', 'sites', 'references', 'definition cidrs'):
            with self.subTest(kind=kind):
                value = fixture()
                if kind == 'definitions':
                    value['catalog']['definitions'] += [{'id': f'def-{i}', 'cidrs': [f'10.0.{i}.1/32'], 'category_id': None} for i in range(126)]
                elif kind == 'categories':
                    value['catalog']['categories'] += [{'id': f'cat-{i}'} for i in range(127)]
                elif kind == 'sites':
                    value['web'] = [dict(copy.deepcopy(value['web'][0]), id=f'site-{i}', binding_id=f'binding-{i}') for i in range(33)]
                elif kind == 'references':
                    value['web_only']['definition_ids'] = [f'def-{i}' for i in range(129)]
                else:
                    value['catalog']['definitions'][1]['cidrs'] = [f'10.1.{i // 256}.{i % 256}/32' for i in range(257)]
                self.reject(value, 'policy_limit_exceeded')

    def test_selection_and_cloudfront_limits(self):
        value = fixture()
        value['catalog']['definitions'] += [{'id': f'many-{i}', 'cidrs': [f'10.{i}.{j // 256}.{j % 256}/32' for j in range(171)], 'category_id': None} for i in range(3)]
        value['web'][0]['direct']['sources'] = refs('many-0', 'many-1', 'many-2')
        self.reject(value, 'policy_limit_exceeded')
        value = with_cloudfront(fixture())
        value['cloudfront']['cidrs'] = ordered_cidrs([f'10.{i // 256}.{i % 256}.0/24' for i in range(4096)] + ['2001:db8::/32'])
        self.reject(value, 'policy_limit_exceeded')

    def test_effective_entry_and_cidr_limits(self):
        for kind in ('entries', 'cidrs'):
            with self.subTest(kind=kind):
                value = fixture()
                if kind == 'entries':
                    value['ssh']['effective_allows']['entries'] = [{'id': f'entry-{i}', 'cidrs': ['192.0.2.10/32'], 'origin': 'managed'} for i in range(1025)]
                else:
                    value['ssh']['effective_allows']['entries'][0]['cidrs'] = [f'10.{i // 65536}.{i // 256 % 256}.{i % 256}/32' for i in range(8193)]
                self.reject(value, 'policy_limit_exceeded')

    def test_final_firewall_product_limit_prevents_unbounded_projection(self):
        value = with_cloudfront(fixture(), restricted=False)
        value['cloudfront']['cidrs'] = ordered_cidrs([f'10.{i // 256}.{i % 256}.0/24' for i in range(4095)] + ['2001:db8::/32'])
        template = value['web'][0]
        value['web'] = []
        for i in range(17):
            site = copy.deepcopy(template)
            site.update(id=f'site-{i}', binding_id=f'binding-{i}', port=2000 + i)
            value['web'].append(site)
        self.reject(value, 'policy_limit_exceeded')

    def test_raw_shape_and_resource_budgets_fail_closed(self):
        for value in (None, [], 'private-input-marker'):
            with self.subTest(value_type=type(value).__name__):
                self.reject(value, 'policy_schema_invalid')
        value = fixture()
        value['host']['id'] = 'x' * 1025
        self.reject(value, 'policy_limit_exceeded')
        value = with_cloudfront(fixture())
        original = value['web'][0]['viewer']['edge']['resources']
        value['web'][0]['viewer']['edge']['resources'] = [original[0]] + [dict(original[1], arn=original[1]['arn'] + str(i)) for i in range(64)]
        self.reject(value, 'policy_limit_exceeded')

    def test_structural_input_and_candidate_byte_budgets(self):
        deep = None
        for _ in range(18):
            deep = [deep]
        value = fixture()
        value['extra'] = deep
        self.reject(value, 'policy_limit_exceeded')
        value = fixture()
        value['extra'] = list(range(100001))
        self.reject(value, 'policy_limit_exceeded')
        value = fixture()
        base = int(ipaddress.IPv6Address('aaaa:bbbb:cccc:dddd:eeee:ffff:1111:1111'))
        value['catalog']['definitions'] += [
            {'id': f'large-{i}', 'category_id': None,
             'cidrs': [str(ipaddress.ip_network((base + i * 256 + j, 128))) for j in range(256)]}
            for i in range(125)
        ]
        self.assertGreater(len(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()), 1048576)
        self.reject(value, 'policy_limit_exceeded')
        value = with_cloudfront(fixture(), restricted=False)
        value['cloudfront']['cidrs'] = ordered_cidrs(['203.0.113.0/24'] + [
            str(ipaddress.ip_network((base + i, 128))) for i in range(4095)
        ])
        template = value['web'][0]
        value['web'] = [dict(copy.deepcopy(template), id=f'site-{i}',
                            binding_id='binding-' + 'x' * 88 + f'{i:02d}') for i in range(32)]
        # The final rule product stays at 4096 Web rows. Full owner sets and
        # separate site peer/trust evidence exceed the independent byte budget.
        self.reject(value, 'policy_limit_exceeded')

    def test_planning_does_not_read_environment_clock_files_or_run_commands(self):
        value = with_cloudfront(fixture())
        source = compile(MODULE_PATH.read_bytes(), str(MODULE_PATH), 'exec')
        isolated = types.ModuleType('service_access_policy_import_check')
        isolated.__file__ = str(MODULE_PATH)
        sys.modules[isolated.__name__] = isolated
        self.addCleanup(sys.modules.pop, isolated.__name__, None)
        with patch('builtins.open', side_effect=AssertionError('I/O')), \
             patch('os.open', side_effect=AssertionError('I/O')), \
             patch('os.getenv', side_effect=AssertionError('environment')), \
             patch.object(type(os.environ), '__getitem__', side_effect=AssertionError('environment')), \
             patch('time.time', side_effect=AssertionError('clock')), \
             patch('time.monotonic', side_effect=AssertionError('clock')), \
             patch('subprocess.run', side_effect=AssertionError('command')), \
             patch('subprocess.Popen', side_effect=AssertionError('command')):
            exec(source, isolated.__dict__)
            result = self.candidate(value).to_dict()
        for flag in FLAGS:
            self.assertIs(result[flag], False)


if __name__ == '__main__':
    unittest.main()
