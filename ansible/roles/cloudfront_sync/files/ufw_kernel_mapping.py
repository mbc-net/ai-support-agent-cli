#!/usr/bin/python3
"""Pure, partial fixed-profile proof stages. No commands or policy mutations.

Envelope/structure proofs DO NOT establish rule semantics or authorize an
operation. Unknown tables/backends fail closed; no nft/legacy view is dropped.
"""
from dataclasses import dataclass
import json
from ufw_kernel import KernelError, KernelSave, NativeRuleset

VERSIONS_26 = {'iptables': 'iptables v1.8.11 (nf_tables)',
               'ip6tables': 'ip6tables v1.8.11 (nf_tables)',
               'nft': 'nftables v1.1.6 (Commodore Bullmoose #7)'}


BACKEND_PROFILES = {
    '22.04': {'versions': {'iptables': 'iptables v1.8.7 (nf_tables)', 'ip6tables': 'ip6tables v1.8.7 (nf_tables)', 'nft': 'nftables v1.0.2 (Lester Gooch)'}, 'native': 'nftables-1.0.2-schema1', 'asset': 'ufw_kernel_profile_22.json', 'sha256': '3a367e806cd2e41868253068ef5ce13d30a313fafda936f44623e82de1451416'},
    '24.04': {'versions': {'iptables': 'iptables v1.8.10 (nf_tables)', 'ip6tables': 'ip6tables v1.8.10 (nf_tables)', 'nft': 'nftables v1.0.9 (Old Doc Yak #3)'}, 'native': 'nftables-1.0.9-schema1', 'asset': 'ufw_kernel_profile_24.json', 'sha256': '0b20bdc621ed23c879d985cec61236c35d9202d81dbbb66d019e4f3945033b4c'},
    '26.04': {'versions': VERSIONS_26, 'native': 'nftables-1.1.6-schema1', 'asset': 'ufw_kernel_profile_26.json', 'sha256': '770d0019ec70f61ffe2b1f1b7b6a3b403858bf23026fd4c4c910f3920eb31b1b'},
}


def _backend_id(versions):
    if not isinstance(versions, dict) or set(versions) != set(VERSIONS_26) or any(type(x) is not str for x in versions.values()):
        raise KernelError('invalid selected tool metadata')
    for identifier, profile in BACKEND_PROFILES.items():
        if versions == profile['versions']:
            return identifier
    raise KernelError('unsupported selected tool/backend profile')


@dataclass(frozen=True)
class EnvelopeProof:
    selected: tuple
    native: NativeRuleset
    legacy: tuple
    versions: tuple
    profile_id: str
    families: tuple = ('ip', 'ip6')


@dataclass(frozen=True)
class RulePair:
    family: str
    table: str
    chain: str
    ordinal: int
    compatibility: bytes
    native: bytes


@dataclass(frozen=True)
class StructureProof:
    envelope: EnvelopeProof
    pairs: tuple
    semantic_verified: bool = False


def validate_envelope(*, selected, native, legacy, versions):
    identifier = _backend_id(versions)
    if not isinstance(selected, tuple) or len(selected) != 2 or any(not isinstance(x, KernelSave) for x in selected):
        raise KernelError('missing selected compatibility family')
    for view in selected:
        if KernelSave.parse(view.canonical) != view:
            raise KernelError('noncanonical selected compatibility evidence')
        if len(view.tables) != 1 or view.tables[0].name != 'filter':
            raise KernelError('uncalibrated selected table')
    if not isinstance(legacy, tuple) or len(legacy) != 2 or any(type(x) is not bytes or x for x in legacy):
        raise KernelError('parallel legacy policy unsupported')
    if not isinstance(native, NativeRuleset):
        raise KernelError('missing native evidence')
    parsed = NativeRuleset.parse(native.canonical, profile=BACKEND_PROFILES[identifier]['native'])
    if parsed != native:
        raise KernelError('noncanonical native evidence')
    records = json.loads(native.canonical)['nftables']
    tables = []
    for record in records[1:]:
        kind, body = next(iter(record.items()))
        if not isinstance(body, dict) or body.get('family') not in ('ip', 'ip6'):
            raise KernelError('unmapped native family or object')
        if kind == 'table':
            if set(body) != {'family', 'name'} or body['name'] != 'filter':
                raise KernelError('unmapped native table')
            tables.append((body['family'], body['name']))
    if len(tables) != 2 or set(tables) != {('ip', 'filter'), ('ip6', 'filter')}:
        raise KernelError('duplicate or missing native table')
    return EnvelopeProof(selected, native, legacy, tuple(sorted(versions.items())), identifier)


def validate_structure(envelope):
    if not isinstance(envelope, EnvelopeProof):
        raise KernelError('missing backend envelope')
    # Revalidate even a directly constructed proof, rather than treating its
    # class name as authority. Evidence remains immutable bytes/tuples.
    if validate_envelope(selected=envelope.selected, native=envelope.native,
                         legacy=envelope.legacy, versions=dict(envelope.versions)) != envelope:
        raise KernelError('noncanonical or incorrect backend proof identity')
    records = json.loads(envelope.native.canonical)['nftables']
    chains, native_rules = {}, {}
    for record in records[1:]:
        kind, body = next(iter(record.items()))
        if kind == 'table':
            continue
        if kind not in ('chain', 'rule') or body.get('table') != 'filter':
            raise KernelError('unsupported native policy object')
        key = (body['family'], body['table'], body.get('name') if kind == 'chain' else body.get('chain'))
        if kind == 'chain':
            if key in chains:
                raise KernelError('duplicate native chain')
            chains[key] = body
        else:
            if (set(body) not in ({'family', 'table', 'chain', 'expr'}, {'family', 'table', 'chain', 'expr', 'comment'})
                    or ('comment' in body and not isinstance(body['comment'], str))):
                raise KernelError('unknown native rule fields')
            native_rules.setdefault(key, []).append(body)
    selected_chains = {}
    pairs = []
    hooks = {'INPUT': 'input', 'FORWARD': 'forward', 'OUTPUT': 'output'}
    for family, view in zip(('ip', 'ip6'), envelope.selected):
        table = view.tables[0]
        for name, policy in table.chains:
            key = (family, table.name, name)
            selected_chains[key] = True
            if key not in chains:
                raise KernelError('selected chain missing from native view')
            body = chains[key]
            if name in hooks:
                expected = {'family': family, 'table': table.name, 'name': name, 'type': 'filter',
                            'hook': hooks[name], 'prio': 0, 'policy': policy.lower()}
                if policy not in ('ACCEPT', 'DROP') or type(body.get('prio')) is not int or body != expected:
                    raise KernelError('native base hook/default policy differs')
            elif policy != '-' or body != {'family': family, 'table': table.name, 'name': name}:
                raise KernelError('native user chain structure differs')
            selected_rows = [line for line in table.rules if line.split()[1].decode('ascii') == name]
            native_rows = native_rules.get(key, [])
            if len(selected_rows) != len(native_rows):
                raise KernelError('selected/native chain rule count differs')
            for ordinal, (compat, rule) in enumerate(zip(selected_rows, native_rows)):
                pairs.append(RulePair(family, table.name, name, ordinal, compat,
                                      json.dumps(rule, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()))
    if set(chains) != set(selected_chains) or not set(native_rules) <= set(selected_chains):
        raise KernelError('unmapped native chain or rule')
    return StructureProof(envelope, tuple(pairs))


PROFILE_26_SHA256 = '770d0019ec70f61ffe2b1f1b7b6a3b403858bf23026fd4c4c910f3920eb31b1b'


def _profile_for(envelope):
    import hashlib
    from pathlib import Path
    identifier = _backend_id(dict(envelope.versions))
    if identifier != envelope.profile_id:
        raise KernelError('backend proof identity changed')
    entry = BACKEND_PROFILES[identifier]
    raw = Path(__file__).with_name(entry['asset']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise KernelError('fixed kernel grammar asset changed')
    profile = json.loads(raw)
    if profile['os'] != identifier:
        raise KernelError('grammar asset backend identity differs')
    return profile


def _narrow_tuple(line, family, *, raw=False):
    """Typed canonical source/one-TCP-port inbound accept, no extra options."""
    import ipaddress
    import re
    chain = 'ufw-user-input' if family == 'ip' else 'ufw6-user-input'
    pattern = (r'-A ' + chain + r' -p tcp --dport ([0-9]+) -s (\S+) -j ACCEPT' if raw else
               r'-A ' + chain + r' -s (\S+) -p tcp -m tcp --dport ([0-9]+) -j ACCEPT')
    match = re.fullmatch(pattern, line)
    if not match:
        return None
    port_text, source = match.groups() if raw else (match.group(2), match.group(1))
    try:
        network = ipaddress.ip_network(source, strict=True)
        port = int(port_text)
    except ValueError as exc:
        raise KernelError('invalid typed kernel source/port') from exc
    if network.version != (4 if family == 'ip' else 6) or not network.prefixlen or not 1 <= port <= 65535 or str(port) != port_text:
        raise KernelError('unsupported typed kernel source/port')
    if not raw and source != network.with_prefixlen:
        raise KernelError('noncanonical selected kernel source')
    return chain, network, port


def _limit_suffixes(family, profile, *, raw=False):
    chain = 'ufw' if family == 'ip' else 'ufw6'
    recent = '' if raw else (' --name DEFAULT --mask ' +
        ('255.255.255.255' if family == 'ip' else 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') + ' --rsource')
    return {
        'set': ' -m conntrack --ctstate NEW -m recent --set' + recent +
               (' ' if not raw and profile['os'] == '22.04' else ''),
        'update': ' -m conntrack --ctstate NEW -m recent --update --seconds 30 --hitcount 6' + recent + ' -j ' + chain + '-user-limit',
        'accept': ' -j ' + chain + '-user-limit-accept',
    }


def _narrow_limit(line, family, profile, *, raw=False):
    """Only finite-source, one-port, inbound TCP limit's exact three forms.

    Complete UserRulesDocument agreement binds all three row multiplicities and
    order. Individual compatibility recognition is not raw/ownership admission.
    """
    import ipaddress
    import re
    if family not in ('ip', 'ip6'):
        raise KernelError('unsupported typed limit family')
    chain = 'ufw-user-input' if family == 'ip' else 'ufw6-user-input'
    head = (r'-A ' + chain + r' -p tcp --dport ([0-9]+) -s (\S+)' if raw else
            r'-A ' + chain + r' -s (\S+) -p tcp -m tcp --dport ([0-9]+)')
    for kind, suffix in _limit_suffixes(family, profile, raw=raw).items():
        match = re.fullmatch(head + re.escape(suffix), line)
        if match is None:
            continue
        port_text, source = match.groups() if raw else (match.group(2), match.group(1))
        try:
            network = ipaddress.ip_network(source, strict=True)
            port = int(port_text)
        except ValueError as exc:
            raise KernelError('invalid typed limit source port') from exc
        canonical = str(network.network_address) if raw and network.prefixlen == network.max_prefixlen else network.with_prefixlen
        if (network.version != (4 if family == 'ip' else 6) or not network.prefixlen or source != canonical
                or not 1 <= port <= 65535 or str(port) != port_text):
            raise KernelError('noncanonical typed limit source port')
        return chain, network, port, kind
    return None


def _limit_compat(typed, family, profile):
    chain, network, port, kind = typed
    return ('-A ' + chain + ' -s ' + network.with_prefixlen + ' -p tcp -m tcp --dport ' +
            str(port) + _limit_suffixes(family, profile)[kind])


def _expected_native(pair, profile):
    line = pair.compatibility.decode('utf-8')
    typed = _narrow_tuple(line, pair.family)
    if typed is not None:
        chain, network, port = typed
        address = str(network.network_address)
        source = address if network.prefixlen == network.max_prefixlen else {'prefix': {'addr': address, 'len': network.prefixlen}}
        source_expression = {'match': {'op': '==', 'left': {'payload': {'protocol': pair.family, 'field': 'saddr'}}, 'right': source}}
        if profile['os'] == '22.04':
            # Only this exact known full TCP compatibility/raw form permits
            # the one opaque xt slot. Port semantics remain in selected bytes.
            return {'expr': [{'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}},
                             source_expression, {'xt': None},
                             {'counter': {'packets': 0, 'bytes': 0}}, {'accept': None}]}
        return {'expr': [source_expression,
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': port}},
            {'counter': {'packets': 0, 'bytes': 0}}, {'accept': None}]}
    limit = _narrow_limit(line, pair.family, profile)
    if limit is not None:
        chain, network, port, kind = limit
        address = str(network.network_address)
        source = address if network.prefixlen == network.max_prefixlen else {'prefix': {'addr': address, 'len': network.prefixlen}}
        source_expression = {'match': {'op': '==', 'left': {'payload': {'protocol': pair.family, 'field': 'saddr'}}, 'right': source}}
        if profile['os'] == '22.04':
            # Real nft1.0.2 source-limit fixtures: TCP, conntrack and recent
            # remain opaque. Full exact compatibility arguments and raw three-
            # row agreement carry their semantics; no extra xt slot is allowed.
            expressions = [{'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}},
                           source_expression, {'xt': None}]
            if kind != 'accept': expressions += [{'xt': None}, {'xt': None}]
        else:
            expressions = [source_expression, {'match': {'op': '==',
                'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': port}}]
            if kind != 'accept': expressions += [{'xt': {'type': 'match', 'name': 'conntrack'}},
                                                {'xt': {'type': 'match', 'name': 'recent'}}]
        expressions.append({'counter': {'packets': 0, 'bytes': 0}})
        if kind != 'set':
            expressions.append({'jump': {'target': ('ufw' if pair.family == 'ip' else 'ufw6') +
                                         ('-user-limit' if kind == 'update' else '-user-limit-accept')}})
        return {'expr': expressions}
    try:
        return profile['families'][pair.family]['native_rule_map'][line]
    except KeyError as exc:
        raise KernelError('unrecognized compatibility rule grammar') from exc


@dataclass(frozen=True)
class CompatNativeProof:
    structure: StructureProof

    @property
    def native_compat_verified(self):
        return True

    @property
    def raw_verified(self):
        return False


def validate_semantics(structure):
    if not isinstance(structure, StructureProof) or validate_structure(structure.envelope) != structure:
        raise KernelError('invalid or stale structural proof')
    profile = _profile_for(structure.envelope)
    for pair in structure.pairs:
        expected = {'family': pair.family, 'table': pair.table, 'chain': pair.chain,
                    **_expected_native(pair, profile)}
        # JSON equality must preserve numeric types: Python dict equality makes
        # True == 1 and False == 0. Compare exact canonical JSON bytes instead.
        encoded = json.dumps(expected, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
        if pair.native != encoded:
            raise KernelError('native expression differs from complete recognized compatibility rule')
    # Opaque xt arguments remain in the complete compatibility bytes and will
    # additionally require exact raw agreement. The native shape alone never
    # proves those arguments. This is not the final raw/kernel proof.
    return CompatNativeProof(structure)


@dataclass(frozen=True)
class RawKernelProof:
    correspondence: CompatNativeProof
    raw_files: tuple

    @property
    def native_compat_verified(self):
        return True

    @property
    def raw_verified(self):
        return True


def _raw_to_compat(line, family, profile):
    typed = _narrow_tuple(line, family, raw=True)
    if typed is not None:
        chain, network, port = typed
        return '-A ' + chain + ' -s ' + network.with_prefixlen + ' -p tcp -m tcp --dport ' + str(port) + ' -j ACCEPT'
    limit = _narrow_limit(line, family, profile, raw=True)
    if limit is not None:
        return _limit_compat(limit, family, profile)
    try:
        return profile['families'][family]['raw_rule_map'][line]
    except KeyError as exc:
        raise KernelError('unsupported raw tuple-to-kernel grammar') from exc


def _selected_from_raw(raw_files, profile):
    import hashlib
    from ufw_kernel import KernelTable
    from ufw_integrity import UserRulesDocument, UserFileProfile, IntegrityError
    expected_keys = set(profile['stock_raw_sha256']) | {'user.rules', 'user6.rules'}
    if not isinstance(raw_files, dict) or set(raw_files) != expected_keys or any(type(x) is not bytes for x in raw_files.values()):
        raise KernelError('incomplete or unknown raw policy sources')
    for leaf, expected in profile['stock_raw_sha256'].items():
        if hashlib.sha256(raw_files[leaf]).hexdigest() != expected:
            raise KernelError('unsupported stock before/after raw policy bytes')
    projections = []
    for family in ('ip', 'ip6'):
        number = 4 if family == 'ip' else 6
        leaf = 'user.rules' if number == 4 else 'user6.rules'
        try:
            document = UserRulesDocument.parse(raw_files[leaf], UserFileProfile(number))
        except (IntegrityError, ValueError, UnicodeError) as exc:
            raise KernelError('unsupported raw user document grammar') from exc
        body_rules = {}
        for block in document.blocks:
            for line in block.render(document.profile).splitlines():
                if line.startswith(b'-A '):
                    try:
                        translated = _raw_to_compat(line.decode('utf-8'), family, profile)
                    except UnicodeError as exc:
                        raise KernelError('unsupported raw rule encoding') from exc
                    chain = translated.split()[1]
                    body_rules.setdefault(chain, []).append(translated)
                elif line.startswith(b'-'):
                    raise KernelError('unsupported raw rule operation')
        template = profile['families'][family]
        chains = tuple(tuple(row) for row in template['chains'])
        if not set(body_rules) <= {name for name, unused in chains}:
            raise KernelError('raw tuple targets unrecognized chain')
        base_rules = {}
        for line in template['base_rules']:
            base_rules.setdefault(line.split()[1], []).append(line)
        expected_rules = []
        for chain, unused in chains:
            expected_rules.extend(line.encode('utf-8') for line in body_rules.get(chain, []) + base_rules.get(chain, []))
        expected = KernelSave((KernelTable('filter', chains, tuple(expected_rules)),))
        projections.append(expected)
    return tuple(projections)


def validate_raw(correspondence, raw_files):
    """Prove the six complete raw sources under the fixed stock grammar."""
    if (not isinstance(correspondence, CompatNativeProof)
            or validate_semantics(correspondence.structure) != correspondence):
        raise KernelError('invalid compatibility/native correspondence proof')
    if _selected_from_raw(raw_files, _profile_for(correspondence.structure.envelope)) != correspondence.structure.envelope.selected:
        raise KernelError('complete raw policy differs from selected kernel generation')
    return RawKernelProof(correspondence, tuple(sorted(raw_files.items())))


def _native_from_selected(before, selected, profile):
    """Keep table/chain/global presentation order; regenerate exact rule rows.

    The caller verifies identity when projecting the existing before generation
    first, so unusual input ordering cannot be silently canonicalized away.
    """
    records = json.loads(before.canonical)['nftables']
    groups = []
    for record in records[1:]:
        kind, body = next(iter(record.items()))
        if kind == 'table':
            groups.append((record, []))
        elif kind == 'chain':
            if not groups or body['family'] != groups[-1][0]['table']['family']:
                raise KernelError('unsupported native table presentation order')
            groups[-1][1].append(record)
        elif kind != 'rule':
            raise KernelError('unsupported native presentation object')
    output = [records[0]]
    tables = {family: view.tables[0] for family, view in zip(('ip', 'ip6'), selected)}
    for table_record, chain_records in groups:
        output.append(table_record)
        if profile['os'] != '22.04':
            output.extend(chain_records)
        for record in chain_records:
            if profile['os'] == '22.04':
                # nft1.0.2 serializes each chain immediately with its rules.
                output.append(record)
            body = record['chain']
            family, chain = body['family'], body['name']
            rows = [line for line in tables[family].rules if line.split()[1].decode('ascii') == chain]
            for ordinal, line in enumerate(rows):
                pair = RulePair(family, 'filter', chain, ordinal, line, b'')
                output.append({'rule': {'family': family, 'table': 'filter', 'chain': chain,
                                        **_expected_native(pair, profile)}})
    return NativeRuleset.parse(json.dumps({'nftables': output}, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode(),
                               profile=BACKEND_PROFILES[profile['os']]['native'])


def predict_transition(before, operation, rule, *, index=None):
    """Pure before-command prediction; never accepts observed after evidence."""
    import ipaddress
    from ufw_integrity import ManagedTuple, UserRulesDocument, UserFileProfile, IntegrityError
    if not isinstance(before, RawKernelProof) or validate_raw(before.correspondence, dict(before.raw_files)) != before:
        raise KernelError('invalid complete raw/kernel proof')
    if operation not in ('add', 'delete') or (operation == 'delete' and index is not None) or not isinstance(rule, ManagedTuple):
        raise KernelError('unsupported owned transition request')
    profile = _profile_for(before.correspondence.structure.envelope)
    envelope = before.correspondence.structure.envelope
    if _native_from_selected(envelope.native, envelope.selected, profile) != envelope.native:
        raise KernelError('unsupported native global record order')
    raw_files = dict(before.raw_files)
    try:
        family = ipaddress.ip_network(rule.source).version
        leaf = 'user.rules' if family == 4 else 'user6.rules'
        document = UserRulesDocument.parse(raw_files[leaf], UserFileProfile(family))
        after = document.add(rule, index=index) if operation == 'add' else document.delete(rule)
        raw_files[leaf] = after.to_bytes()
    except (IntegrityError, ValueError, TypeError, AttributeError) as exc:
        raise KernelError('invalid owned raw transition') from exc
    selected = _selected_from_raw(raw_files, profile)
    native = _native_from_selected(envelope.native, selected, profile)
    projected = validate_structure(validate_envelope(selected=selected, native=native,
                                                    legacy=envelope.legacy, versions=dict(envelope.versions)))
    return validate_raw(validate_semantics(projected), raw_files)
