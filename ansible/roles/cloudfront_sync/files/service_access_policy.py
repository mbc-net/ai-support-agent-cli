"""Pure service access projections from an explicitly supplied v1 model.

This module neither observes nor changes a host or AWS resource. Completeness,
identity, ownership and digests in input are claims supplied by the caller.
A candidate establishes model consistency only; every readiness/verification
flag remains false. It is not an authorization, executable plan or runtime API.
"""
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import re


_CODES = frozenset({
    'policy_schema_invalid', 'policy_limit_exceeded', 'policy_reference_invalid',
    'policy_cidr_invalid', 'policy_selection_empty', 'policy_ssh_deny_all_unsupported',
    'policy_port_conflict', 'policy_web_only_ssh_overlap', 'policy_route_unsupported',
    'policy_edge_not_exclusive', 'policy_effective_ssh_unknown',
    'policy_effective_ssh_mismatch', 'policy_scope_mismatch',
})
_FLAGS = ('runtime_ready', 'observation_verified', 'edge_verified', 'enforcement_verified')
_ID = re.compile(r'[A-Za-z0-9_-]{1,100}')
_HEX = re.compile(r'[0-9a-f]{64}')
_ARN = re.compile(r'arn:aws:wafv2:us-east-1:([0-9]{12}):global/(webacl|ipset|rulegroup)/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+')
_INPUT_BYTES = 1_048_576
_CANDIDATE_BYTES = 16_777_216
_MAX_ROWS = 65_536


class PolicyError(Exception):
    """A fixed, non-sensitive code; never retain a supplied invalid value."""
    def __init__(self, code):
        safe = code if type(code) is str and code in _CODES else 'policy_schema_invalid'
        self.code = safe
        super().__init__(safe)


def _fail(code='policy_schema_invalid'):
    raise PolicyError(code)


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def _bounded_input(value):
    """Inspect exact JSON builtin types before recursion or serialization.

    A cycle exceeds the depth bound. Count dictionary keys too. Integers beyond
    the v1 numeric domain and all floats are invalid, without formatting them.
    """
    stack = [(value, 0)]
    visited = 0
    while stack:
        item, depth = stack.pop()
        visited += 1
        if visited > 100_000 or depth > 16:
            _fail('policy_limit_exceeded')
        kind = type(item)
        if kind is str:
            if len(item) > 1024:
                _fail('policy_limit_exceeded')
            # Reject lone surrogates before UTF-8 serialization, without an
            # exception that embeds the supplied string.
            if any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                _fail()
        elif kind is dict:
            if visited + len(stack) + 2 * len(item) > 100_000:
                _fail('policy_limit_exceeded')
            for key, child in item.items():
                if type(key) is not str:
                    _fail()
                stack.append((key, depth + 1))
                stack.append((child, depth + 1))
        elif kind is list:
            if visited + len(stack) + len(item) > 100_000:
                _fail('policy_limit_exceeded')
            stack.extend((child, depth + 1) for child in item)
        elif kind is int:
            if not -9_007_199_254_740_991 <= item <= 9_007_199_254_740_991:
                _fail()
        elif kind is not bool and item is not None:
            _fail()
    if len(_json(value)) > _INPUT_BYTES:
        _fail('policy_limit_exceeded')


def _record(value, keys, code='policy_schema_invalid'):
    if type(value) is not dict or set(value) != set(keys):
        _fail(code)
    return value


def _array(value, limit=None, code='policy_schema_invalid'):
    if type(value) is not list:
        _fail(code)
    if limit is not None and len(value) > limit:
        _fail('policy_limit_exceeded')
    return value


def _identifier(value, code='policy_schema_invalid'):
    if type(value) is not str or _ID.fullmatch(value) is None:
        _fail(code)
    return value


def _positive(value):
    if type(value) is not int or not 1 <= value <= 9_007_199_254_740_991:
        _fail()
    return value


def _digest(value):
    if type(value) is not str or _HEX.fullmatch(value) is None:
        _fail()
    return value


def _port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        _fail()
    return value


def _ports(values, *, nonempty=False):
    values = _array(values)
    checked = [_port(value) for value in values]
    if len(checked) != len(set(checked)) or (nonempty and not checked):
        _fail()
    return sorted(checked)


def _normalize_sets(value):
    """Every v1 array has set semantics; retain records and reference IDs."""
    if type(value) is dict:
        return {key: _normalize_sets(child) for key, child in value.items()}
    if type(value) is list:
        normalized = [_normalize_sets(child) for child in value]
        return sorted(normalized, key=_json)
    return value


def _intervals(networks):
    result = []
    ordered = sorted((net.version, int(net.network_address), int(net.broadcast_address))
                     for net in networks)
    for family, start, end in ordered:
        if result and result[-1][0] == family and start <= result[-1][2] + 1:
            previous = result[-1]
            result[-1] = (family, previous[1], max(previous[2], end))
        else:
            result.append((family, start, end))
    return tuple(result)


def _intersects(left, right):
    a = b = 0
    while a < len(left) and b < len(right):
        lv, ls, le = left[a]
        rv, rs, re_ = right[b]
        if lv < rv or (lv == rv and le < rs):
            a += 1
        elif rv < lv or (lv == rv and re_ < ls):
            b += 1
        else:
            return True
    return False


def _whole_family(intervals):
    return any(start == 0 and end == (1 << (32 if family == 4 else 128)) - 1
               for family, start, end in intervals)


@dataclass(frozen=True, slots=True, repr=False)
class PolicyCandidate:
    """Immutable private serialization. Public callers use public_summary()."""
    _raw: bytes = field(repr=False)

    def __repr__(self):
        return 'PolicyCandidate(status=\'supplied_model_consistent\')'

    def to_dict(self):
        return json.loads(self._raw)

    def public_summary(self):
        value = self.to_dict()
        projection = value['projections']
        return {
            'status': 'supplied_model_consistent', 'input_digest': value['input_digest'],
            **{name: False for name in _FLAGS},
            'counts': {
                'sites': len(projection['sites']), 'firewall_rules': len(projection['firewall']),
                'ssh_sources': len(projection['ssh_sources'] or []),
                'web_only_sources': len(projection['web_only_sources']),
            },
        }


class _Planner:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.networks = {}
        self.definitions = {}
        self.categories = {}
        self.resolved = {}
        self.intervals = {}
        self.arns = set()

    def cidr_key(self, value):
        network = self.networks[value]
        return network.version, int(network.network_address), network.prefixlen

    def cidrs(self, values, limit, *, allow_universal=False):
        values = _array(values, limit)
        result = []
        seen = set()
        for value in values:
            if type(value) is not str or value in seen or '%' in value:
                _fail('policy_cidr_invalid')
            seen.add(value)
            network = self.networks.get(value)
            if network is None:
                # Raise outside the handler: retain no parsing exception with
                # the original private input in a context chain.
                try:
                    network = ipaddress.ip_network(value, strict=True)
                except ValueError:
                    network = None
                if network is None or str(network) != value:
                    _fail('policy_cidr_invalid')
                if network.version == 6 and network.network_address.ipv4_mapped is not None:
                    _fail('policy_cidr_invalid')
                self.networks[value] = network
            if network.prefixlen == 0 and not allow_universal:
                _fail('policy_cidr_invalid')
            result.append(value)
        return tuple(sorted(result, key=self.cidr_key))

    def merged(self, cidrs):
        key = tuple(sorted(set(cidrs), key=self.cidr_key))
        if key not in self.intervals:
            self.intervals[key] = _intervals(self.networks[value] for value in key)
        return self.intervals[key]

    def references(self, value):
        _record(value, ('definition_ids', 'category_ids'))
        checked = []
        for name in ('definition_ids', 'category_ids'):
            values = _array(value[name], 128)
            ids = [_identifier(item, 'policy_reference_invalid') for item in values]
            if len(ids) != len(set(ids)):
                _fail('policy_reference_invalid')
            checked.append(tuple(sorted(ids)))
        return tuple(checked)

    def resolve(self, value, *, restricted=False, must_empty=False):
        key = self.references(value)
        if key not in self.resolved:
            definition_ids, category_ids = key
            found = set()
            for ident in definition_ids:
                if ident not in self.definitions:
                    _fail('policy_reference_invalid')
                found.update(self.definitions[ident])
            for ident in category_ids:
                if ident not in self.categories:
                    _fail('policy_reference_invalid')
                members = self.categories[ident]
                if not members:
                    _fail('policy_selection_empty')
                for member in members:
                    found.update(self.definitions[member])
            if len(found) > 512:
                _fail('policy_limit_exceeded')
            self.resolved[key] = tuple(sorted(found, key=self.cidr_key))
        result = self.resolved[key]
        if must_empty and (key[0] or key[1]):
            _fail()
        if restricted:
            if not result:
                _fail('policy_selection_empty')
            if _whole_family(self.merged(result)):
                _fail('policy_cidr_invalid')
        return result

    def catalog(self, value):
        _record(value, ('tenant_id', 'project_id', 'version', 'definitions', 'categories'))
        _identifier(value['tenant_id'])
        _identifier(value['project_id'])
        _positive(value['version'])
        definitions = _array(value['definitions'], 128)
        categories = _array(value['categories'], 128)
        for category in categories:
            _record(category, ('id',))
            ident = _identifier(category['id'])
            if ident in self.categories:
                _fail('policy_reference_invalid')
            self.categories[ident] = []
        for definition in definitions:
            _record(definition, ('id', 'cidrs', 'category_id'))
            ident = _identifier(definition['id'])
            if ident in self.definitions:
                _fail('policy_reference_invalid')
            self.definitions[ident] = self.cidrs(definition['cidrs'], 256)
            category = definition['category_id']
            if category is not None:
                _identifier(category)
                if category not in self.categories:
                    _fail('policy_reference_invalid')
                self.categories[category].append(ident)

    def host(self, value, catalog):
        _record(value, ('id', 'tenant_id', 'project_id', 'generation', 'rules_digest',
                        'ssh_ports', 'management_ports'))
        for key in ('id', 'tenant_id', 'project_id'):
            _identifier(value[key])
        _positive(value['generation'])
        _digest(value['rules_digest'])
        if any(value[name] != catalog[name] for name in ('tenant_id', 'project_id')):
            _fail('policy_scope_mismatch')
        return _ports(value['ssh_ports'], nonempty=True), _ports(value['management_ports'])

    def ssh(self, value, web_only):
        _record(value, ('mode', 'sources', 'effective_allows'))
        mode = value['mode']
        if mode == 'deny_all':
            _fail('policy_ssh_deny_all_unsupported')
        if type(mode) is not str or mode not in ('restricted', 'unmanaged'):
            _fail()
        selected = self.resolve(value['sources'], restricted=mode == 'restricted',
                                must_empty=mode == 'unmanaged')
        effective = value['effective_allows']
        _record(effective, ('complete', 'entries'), 'policy_effective_ssh_unknown')
        if effective['complete'] is not True:
            _fail('policy_effective_ssh_unknown')
        entries = _array(effective['entries'], 1024, 'policy_effective_ssh_unknown')
        entry_ids = set()
        cidr_count = 0
        residual = set(selected)
        for entry in entries:
            _record(entry, ('id', 'cidrs', 'origin'), 'policy_effective_ssh_unknown')
            ident = _identifier(entry['id'], 'policy_effective_ssh_unknown')
            if ident in entry_ids:
                _fail('policy_reference_invalid')
            entry_ids.add(ident)
            if type(entry['origin']) is not str or entry['origin'] not in (
                    'managed', 'unmanaged', 'default_allow', 'other_path'):
                _fail('policy_effective_ssh_unknown')
            cidrs = _array(entry['cidrs'], 8192, 'policy_effective_ssh_unknown')
            cidr_count += len(cidrs)
            if cidr_count > 8192:
                _fail('policy_limit_exceeded')
            residual.update(self.cidrs(cidrs, 8192, allow_universal=True))
        all_intervals = self.merged(residual)
        if _intersects(self.merged(web_only), all_intervals):
            _fail('policy_web_only_ssh_overlap')
        if mode == 'restricted' and all_intervals != self.merged(selected):
            _fail('policy_effective_ssh_mismatch')
        return selected if mode == 'restricted' else None

    def publication(self, value, needed):
        if not needed:
            if value is not None:
                _fail()
            return ()
        _record(value, ('service', 'sync_token', 'digest', 'cidrs'))
        token = value['sync_token']
        if (value['service'] != 'CLOUDFRONT_ORIGIN_FACING' or type(token) is not str
                or re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', token) is None):
            _fail()
        _digest(value['digest'])
        cidrs = self.cidrs(value['cidrs'], 4096)
        if {self.networks[item].version for item in cidrs} != {4, 6}:
            _fail('policy_cidr_invalid')
        return cidrs

    def edge(self, value, binding, distribution):
        _record(value, ('profile', 'account_id', 'distribution_id', 'config_digest',
                        'references_version', 'resources'))
        if value['profile'] != 'dedicated-edge-input-v1':
            _fail('policy_edge_not_exclusive')
        account = value['account_id']
        if type(account) is not str or re.fullmatch(r'[0-9]{12}', account) is None:
            _fail('policy_edge_not_exclusive')
        _identifier(value['distribution_id'])
        if value['distribution_id'] != distribution:
            _fail('policy_edge_not_exclusive')
        _digest(value['config_digest'])
        _positive(value['references_version'])
        resources = _array(value['resources'], 64)
        kinds = {'web_acl': 'webacl', 'ip_set': 'ipset', 'custom_rule_group': 'rulegroup'}
        counts = {kind: 0 for kind in kinds}
        normalized = []
        for resource in resources:
            _record(resource, ('arn', 'kind', 'owner_binding_id', 'referrer_binding_ids'))
            kind, arn = resource['kind'], resource['arn']
            if type(kind) is not str or kind not in kinds or type(arn) is not str:
                _fail('policy_edge_not_exclusive')
            match = _ARN.fullmatch(arn)
            if match is None or match.group(1) != account or match.group(2) != kinds[kind]:
                _fail('policy_edge_not_exclusive')
            if arn in self.arns:
                _fail('policy_edge_not_exclusive')
            self.arns.add(arn)
            _identifier(resource['owner_binding_id'])
            refs = _array(resource['referrer_binding_ids'], 128)
            for ident in refs:
                _identifier(ident)
            if resource['owner_binding_id'] != binding or refs != [binding]:
                _fail('policy_edge_not_exclusive')
            counts[kind] += 1
            normalized.append({'arn': arn, 'kind': kind, 'owner_binding_id': binding,
                               'referrer_binding_ids': [binding]})
        if counts['web_acl'] != 1 or counts['ip_set'] < 1:
            _fail('policy_edge_not_exclusive')
        return {
            'profile': value['profile'], 'account_id': account, 'distribution_id': distribution,
            'config_digest': value['config_digest'], 'references_version': value['references_version'],
            'resources': sorted(normalized, key=lambda item: item['arn']),
        }

    def sites(self, values, project, ssh_ports, management_ports, peers):
        sites = []
        ids = set()
        bindings = set()
        for value in values:
            _record(value, ('id', 'binding_id', 'project_id', 'version', 'port', 'route',
                            'direct', 'viewer', 'proxy'))
            for key in ('id', 'binding_id', 'project_id'):
                _identifier(value[key])
            if value['id'] in ids or value['binding_id'] in bindings:
                _fail('policy_reference_invalid')
            ids.add(value['id'])
            bindings.add(value['binding_id'])
            if value['project_id'] != project:
                _fail('policy_scope_mismatch')
            _positive(value['version'])
            port = _port(value['port'])
            if port in ssh_ports or port in management_ports:
                _fail('policy_port_conflict')
            route = value['route']
            if type(route) is not str or route not in ('direct_only', 'cloudfront_only', 'mixed'):
                _fail('policy_route_unsupported')
            direct = _record(value['direct'], ('mode', 'sources'))
            direct_mode = direct['mode']
            if type(direct_mode) is not str or direct_mode not in ('restricted', 'deny_all'):
                _fail('policy_route_unsupported')
            if (route == 'cloudfront_only' and direct_mode != 'deny_all') or (
                    route == 'mixed' and direct_mode != 'restricted'):
                _fail('policy_route_unsupported')
            direct_sources = self.resolve(direct['sources'], restricted=direct_mode == 'restricted',
                                          must_empty=direct_mode == 'deny_all')
            viewer_mode = viewer_sources = secret = edge = None
            peer_sources = ()
            if route == 'direct_only':
                if value['viewer'] is not None or value['proxy'] is not None:
                    _fail('policy_route_unsupported')
            else:
                proxy = _record(value['proxy'], ('profile', 'distribution_id', 'secret_ref'),
                                'policy_route_unsupported')
                if proxy['profile'] != 'cloudfront-direct-nginx-candidate-v1':
                    _fail('policy_route_unsupported')
                distribution = _identifier(proxy['distribution_id'])
                secret = _record(proxy['secret_ref'], ('id', 'version'))
                _identifier(secret['id'])
                _positive(secret['version'])
                secret = {'id': secret['id'], 'version': secret['version']}
                viewer = _record(value['viewer'], ('mode', 'sources', 'edge'),
                                 'policy_route_unsupported')
                viewer_mode = viewer['mode']
                if type(viewer_mode) is not str or viewer_mode not in ('public', 'restricted'):
                    _fail('policy_route_unsupported')
                resolved = self.resolve(viewer['sources'], restricted=viewer_mode == 'restricted',
                                        must_empty=viewer_mode == 'public')
                if viewer_mode == 'restricted':
                    viewer_sources = list(resolved)
                    edge = self.edge(viewer['edge'], value['binding_id'], distribution)
                elif viewer['edge'] is not None:
                    _fail()
                peer_sources = peers
            sites.append({
                'id': value['id'], 'binding_id': value['binding_id'], 'project_id': project,
                'port': port, 'route': route, 'direct_sources': list(direct_sources),
                'viewer_mode': viewer_mode, 'viewer_sources': viewer_sources,
                'peer_sources': list(peer_sources), 'trusted_proxy_sources': list(peer_sources),
                'secret_ref': secret, 'edge': edge,
            })
        return sorted(sites, key=lambda item: (item['id'], item['binding_id']))

    def firewall(self, selected, ssh_ports, sites):
        owners = {}

        def add(service, port, source, owner):
            key = (service, 'tcp', port, source)
            if key not in owners:
                if len(owners) >= _MAX_ROWS:
                    _fail('policy_limit_exceeded')
                owners[key] = set()
            owners[key].add(owner)

        if selected is not None:
            for port in ssh_ports:
                for source in selected:
                    add('ssh', port, source, 'ssh')
        for site in sites:
            for source in set(site['direct_sources']) | set(site['peer_sources']):
                add('web', site['port'], source, site['binding_id'])
        keys = sorted(owners, key=lambda key: (*key[:3], self.cidr_key(key[3])))
        return [{'service': service, 'protocol': protocol, 'port': port, 'source': source,
                 'owners': sorted(owners[(service, protocol, port, source)])}
                for service, protocol, port, source in keys]

    def plan(self):
        value = self.snapshot
        _record(value, ('schema', 'catalog', 'host', 'ssh', 'web_only', 'web', 'cloudfront'))
        if value['schema'] != 'service-access-input-v1':
            _fail()
        self.catalog(value['catalog'])
        ssh_ports, management_ports = self.host(value['host'], value['catalog'])
        values = _array(value['web'], 32)
        # Only inspect the discriminator before full site validation; no route
        # is silently mapped to direct access when its publication is absent.
        needed = any(type(site) is dict and site.get('route') in ('cloudfront_only', 'mixed')
                     for site in values)
        peers = self.publication(value['cloudfront'], needed)
        web_only = self.resolve(value['web_only'])
        selected = self.ssh(value['ssh'], web_only)
        sites = self.sites(values, value['catalog']['project_id'], ssh_ports, management_ports, peers)
        result = {
            'schema': 'service-access-candidate-v1', 'status': 'supplied_model_consistent',
            'input_digest': hashlib.sha256(_json(_normalize_sets(value))).hexdigest(),
            'host_id': value['host']['id'],
            'projections': {
                'ssh_sources': list(selected) if selected is not None else None,
                'web_only_sources': list(web_only), 'sites': sites,
                'firewall': self.firewall(selected, ssh_ports, sites),
            },
            **{name: False for name in _FLAGS},
        }
        raw = _json(result)
        if len(raw) > _CANDIDATE_BYTES:
            _fail('policy_limit_exceeded')
        return PolicyCandidate(raw)


def plan_policy(snapshot: dict) -> PolicyCandidate:
    """Validate a bounded supplied model and return a non-executable candidate."""
    _bounded_input(snapshot)
    return _Planner(snapshot).plan()
