"""Pure, precomputed Docker/UFW owned transitions; no actors or admission."""
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import ufw_docker_kernel as docker
import ufw_kernel_mapping as mapping
from ufw_kernel import KernelError, KernelSave, KernelTable, NativeRuleset
from ufw_integrity import ManagedTuple, UserFileProfile, UserRulesDocument, UfwInventory, predict_user_file, assert_inventory_transition

NoPublishCandidate = docker.NoPublishCandidate
NEW_COMMENT = 'cloudfront-sync'  # Existing engine MARKER; new keys only.

def _bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def _id(value):
    return hashlib.sha256(_bytes(value)).hexdigest()

@dataclass(frozen=True)
class OwnedIntent:
    operation: str
    source: str
    port: int
    comment: str
    index: object = None

    def __post_init__(self):
        if self.operation not in ('add', 'delete') or type(self.port) is not int or not 1 <= self.port <= 65535:
            raise KernelError('invalid owned intent')
        if self.index is not None and (type(self.index) is not int or self.index < 0 or self.operation != 'add'):
            raise KernelError('invalid insertion ordinal')
        try:
            network = ipaddress.ip_network(self.source)
            if type(self.source) is not str or str(network) != self.source:
                raise ValueError()
            self.rule.block(UserFileProfile(network.version))
        except (ValueError, TypeError, AttributeError) as exc:
            raise KernelError('noncanonical owned intent') from exc

    @property
    def rule(self):
        return ManagedTuple(self.source, self.port, self.comment)

@dataclass(frozen=True)
class IntermediateGeneration:
    transaction_id: str
    ordinal: int
    owned_rules: tuple
    inventory: object
    representation: object
    residual_rules: tuple
    residual_native: tuple

    @property
    def actual_docker_calibrated(self):
        return False

    @property
    def identity(self):
        return _id([self.transaction_id, self.ordinal, self.owned_rules,
                    [dict(r) for r in self.inventory.manifest], {p:b.hex() for p,b in self.inventory.contents.items()},
                    [v.canonical.hex() for v in self.representation.selected], self.representation.native.canonical.hex()])

@dataclass(frozen=True)
class TransactionProof:
    before: object
    approved_final_sources: tuple
    ordered_intents: tuple
    generations: tuple
    final_candidate: object
    inverse_intents: tuple
    transaction_id: str

    @property
    def actual_docker_calibrated(self):
        return False


def _sources(values):
    if not isinstance(values, tuple) or not values or len(values) > 512:
        raise KernelError('finite nonempty source generation required')
    try:
        if any(type(s) is not str or str(ipaddress.ip_network(s)) != s for s in values) or len(set(values)) != len(values):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise KernelError('noncanonical source generation') from exc
    return tuple(sorted(values))


def validate_prospective_sources(before, approved_final_sources):
    before = docker._verified_no_publish(before)
    final = _sources(approved_final_sources)
    paths = before.membership.paths
    union = tuple(sorted(set(paths.cf_sources) | set(final)))
    # A separate proposed context validates routes, without pretending that its
    # source union is the before generation's confirmed owned set.
    docker.validate_protected_paths(paths.domain, cf_sources=union, cf_ports=paths.cf_ports,
        ssh_ports=paths.ssh_ports, host_addresses=paths.host_addresses, admin_routes=paths.admin_routes)
    return final


def _inventory(before, intent):
    family = ipaddress.ip_network(intent.source).version
    path = '/etc/ufw/user.rules' if family == 4 else '/etc/ufw/user6.rules'
    document = UserRulesDocument.parse(before.contents[path], UserFileProfile(family))
    mutation = predict_user_file(document, intent.operation, intent.rule, index=intent.index)
    contents = dict(before.contents); contents[path] = mutation.after_bytes
    manifest = []
    for entry in before.manifest:
        row = dict(entry)
        if row['path'] == path:
            row['size'] = len(contents[path]); row['sha256'] = hashlib.sha256(contents[path]).hexdigest()
        manifest.append(row)
    after = UfwInventory(tuple(manifest), contents)
    assert_inventory_transition(before, after, (mutation,))
    return after, document


def _chain(line):
    return line.split()[1].decode('ascii')


def _compose(before, inventory, membership):
    """Exact supported chain-group layout, checked by before self-roundtrip."""
    profile = docker._load_ufw_profile()
    raw = {leaf: inventory.contents['/etc/ufw/'+leaf] for leaf in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules')}
    protected = mapping._selected_from_raw(raw, profile)
    selected = []
    for view, projection in zip(before.selected, protected):
        replacements = {name: [r for r in projection.tables[0].rules if _chain(r)==name] for name, unused in projection.tables[0].chains}
        tables = []
        for table in view.tables:
            if table.name != 'filter':
                tables.append(table); continue
            rows = []; seen=set()
            for line in table.rules:
                name=_chain(line)
                if name not in replacements:
                    rows.append(line); continue
                # Preserve shared FORWARD prefix and all global chain ordering.
                if name=='FORWARD' and line in docker._UFW_FORWARD:
                    rows.append(line); continue
                if name not in seen:
                    rows.extend(replacements[name]); seen.add(name)
            for name, replacement in replacements.items():
                if replacement and name not in seen:
                    raise KernelError('uncalibrated empty protected chain insertion')
            tables.append(KernelTable(table.name, table.chains, tuple(rows)))
        selected.append(KernelSave(tuple(tables)))
    records = json.loads(before.native.canonical)['nftables']
    output = []; emitted=set()
    by_family = dict(zip(('ip','ip6'), selected))
    protected_names={family:{name for name,unused in projection.tables[0].chains} for family,projection in zip(('ip','ip6'),protected)}
    for record in records:
        if 'rule' not in record:
            output.append(record); continue
        row=record['rule']; family,name,chain=row['family'],row['table'],row['chain']
        if name!='filter' or chain not in protected_names[family]:
            output.append(record); continue
        # Shared FORWARD Docker prefix is residual and retains its exact slot.
        catalog=docker._docker_catalog(membership)
        if chain=='FORWARD' and any(_bytes(row)==_bytes({'family':family,'table':name,'chain':chain,**body}) for (f,t,line),body in catalog.items() if f==family and t==name and _chain(line)==chain):
            output.append(record); continue
        key=(family,name,chain)
        if key in emitted: continue
        emitted.add(key)
        table=next(t for t in by_family[family].tables if t.name==name)
        for ordinal,line in enumerate(r for r in table.rules if _chain(r)==chain and (family,name,r) not in catalog):
            body=mapping._expected_native(mapping.RulePair(family,name,chain,ordinal,line,b''),profile)
            output.append({'rule':{'family':family,'table':name,'chain':chain,**body}})
    for family,projection in zip(('ip','ip6'),protected):
        for chain,unused in projection.tables[0].chains:
            if any(_chain(r)==chain for r in projection.tables[0].rules) and (family,'filter',chain) not in emitted:
                raise KernelError('uncalibrated empty native chain insertion')
    native = NativeRuleset.parse(_bytes({'nftables':output}),profile='nftables-1.1.6-schema1')
    return docker.validate_representation(selected=tuple(selected),native=native,versions=dict(before.versions))

def _owned_exact(inventory, expected):
    for family, leaf in ((4,'user.rules'),(6,'user6.rules')):
        document = UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],UserFileProfile(family))
        for row in expected:
            rule = ManagedTuple(*row)
            if ipaddress.ip_network(rule.source).version == family and document.blocks.count(rule.block(document.profile)) != 1:
                raise KernelError('intermediate exact owned block missing')


def compile_transaction(before, *, approved_final_sources, ordered_intents):
    before = docker._verified_no_publish(before)
    final_sources = validate_prospective_sources(before,approved_final_sources)
    if not isinstance(ordered_intents,tuple) or len(ordered_intents)>4096 or any(type(i) is not OwnedIntent for i in ordered_intents):
        raise KernelError('bounded canonical ordered plan required')
    paths = before.membership.paths
    # Preserve each confirmed old key's exact comment. Only a key absent
    # from the before manifest receives the fixed engine ownership marker.
    # D1 already proves unique source/port ownership; do not retag retained rows.
    if not before.owned_rules: raise KernelError('confirmed nonempty ownership required')
    old = set(before.owned_rules)
    comments = {(source,port):comment for source,port,comment in before.owned_rules}
    target = {(source,port,comments.get((source,port),NEW_COMMENT))
              for source in final_sources for port in paths.cf_ports}
    expected_ops = {('delete',*r) for r in old-target}|{('add',*r) for r in target-old}
    actual_ops = [(i.operation,i.source,i.port,i.comment) for i in ordered_intents]
    if len(set(actual_ops))!=len(actual_ops) or set(actual_ops)!=expected_ops:
        raise KernelError('ordered plan differs from exact final owned delta')
    intent_data = [(i.operation,i.source,i.port,i.comment,i.index) for i in ordered_intents]
    transaction_id = _id([before.transaction_identity,final_sources,intent_data])
    # Layout regeneration must be identity before predicting any difference.
    if _compose(before.representation,before.inventory,before.membership)!=before.representation:
        raise KernelError('unsupported before layout roundtrip')
    inventory = before.inventory; owned=set(old); representation=before.representation
    generations=[]; inverses=[]
    for ordinal,intent in enumerate(ordered_intents,1):
        prior_inventory=inventory
        inventory,document=_inventory(inventory,intent)
        row=(intent.source,intent.port,intent.comment)
        if intent.operation=='add':
            if row in owned: raise KernelError('owned tuple already present')
            owned.add(row); inverse=OwnedIntent('delete',*row)
        else:
            if row not in owned: raise KernelError('nonowned deletion forbidden')
            index=document.blocks.index(intent.rule.block(document.profile))
            owned.remove(row); inverse=OwnedIntent('add',*row,index=index)
        restored,_=_inventory(inventory,inverse)
        if _bytes([dict(r) for r in restored.manifest])!=_bytes([dict(r) for r in prior_inventory.manifest]) or restored.contents!=prior_inventory.contents:
            raise KernelError('inverse does not restore exact prior inventory')
        _owned_exact(inventory,owned)
        representation=_compose(before.representation,inventory,before.membership)
        residual,native=docker._validate_policy_projection(representation,before.membership,inventory)
        if residual!=before.residual_rules or native!=before.residual_native:
            raise KernelError('residual differs from precomputed before')
        generations.append(IntermediateGeneration(transaction_id,ordinal,tuple(sorted(owned)),inventory,representation,residual,native))
        inverses.append(inverse)
    if owned!=target: raise KernelError('final Cartesian ownership mismatch')
    final_paths=docker.validate_protected_paths(paths.domain,cf_sources=final_sources,cf_ports=paths.cf_ports,
        ssh_ports=paths.ssh_ports,host_addresses=paths.host_addresses,admin_routes=paths.admin_routes)
    member=before.membership
    final_membership=docker.validate_membership(final_paths,tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in member.bridges),member.host_local_addresses,member.admin_peers)
    final_candidate=docker.validate_no_publish(representation=representation,membership=final_membership,
        protected_inventory=inventory,inventory=inventory,owned_rules=tuple(ManagedTuple(*r) for r in sorted(owned)),
        legacy=before.legacy,docker_package=before.docker_package)
    docker.assert_same_residual(before,final_candidate)
    # Validate the entire reverse generation sequence, not only local raw undo.
    rollback_inventory=inventory
    for inverse,previous in zip(reversed(inverses),reversed([before.inventory]+[g.inventory for g in generations[:-1]])):
        rollback_inventory,_=_inventory(rollback_inventory,inverse)
        if _bytes([dict(r) for r in rollback_inventory.manifest])!=_bytes([dict(r) for r in previous.manifest]) or rollback_inventory.contents!=previous.contents:
            raise KernelError('inverse sequence fails exact generation restoration')
        rollback_representation=_compose(before.representation,rollback_inventory,before.membership)
        docker._validate_policy_projection(rollback_representation,before.membership,rollback_inventory)
    return TransactionProof(before,final_sources,ordered_intents,tuple(generations),final_candidate,tuple(reversed(inverses)),transaction_id)


def assert_observed(proof, ordinal, *, inventory, representation, membership, legacy, docker_package):
    if type(proof) is not TransactionProof or type(ordinal) is not int or not 0<=ordinal<=len(proof.generations):
        raise KernelError('exact transaction generation required')
    actual=compile_transaction(proof.before,approved_final_sources=proof.approved_final_sources,ordered_intents=proof.ordered_intents)
    if (actual!=proof or [g.identity for g in actual.generations]!=[g.identity for g in proof.generations]):
        raise KernelError('forged transaction proof')
    member=proof.before.membership
    bridges=tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in membership.bridges)
    validated=docker.validate_membership(membership.paths,bridges,membership.host_local_addresses,membership.admin_peers)
    if (validated!=membership or membership!=member or membership.paths.fingerprint!=member.paths.fingerprint
            or type(legacy) is not tuple or any(type(raw) is not bytes for raw in legacy)
            or legacy!=proof.before.legacy or type(docker_package) is not str or docker_package!=proof.before.docker_package):
        raise KernelError('observed protected context changed')
    expected=proof.generations[ordinal-1] if ordinal else proof.before
    expected_inventory=expected.inventory
    # No caller-constructed canonical bytes escape revalidation of actual input.
    checked=docker.validate_representation(selected=representation.selected,native=representation.native,versions=dict(representation.versions))
    if checked!=representation: raise KernelError('invalid observed representation')
    docker.validate_inventory_unchanged(expected_inventory,inventory)
    if ([v.canonical for v in checked.selected]!=[v.canonical for v in expected.representation.selected]
            or checked.native.canonical!=expected.representation.native.canonical):
        raise KernelError('observed generation differs from exact prediction')
    return expected
