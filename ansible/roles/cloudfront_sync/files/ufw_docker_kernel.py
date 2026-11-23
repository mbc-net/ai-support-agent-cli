#!/usr/bin/python3
"""D1 pure bounded residual guards. No commands, enrollment or policy writes.

These candidate checks do not authorize a deployment. They must be composed
with complete protected/raw/native/compat validation and an explicitly approved
persistent domain. Actual Docker lifecycle calibration is a separate gate.
"""
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import re
from ufw_kernel import KernelError


@dataclass(frozen=True)
class AllocationDomain:
    pools: tuple
    host_networks: tuple
    admin_networks: tuple

    @property
    def fingerprint(self):
        return hashlib.sha256(json.dumps([self.pools,self.host_networks,self.admin_networks],separators=(',', ':')).encode()).hexdigest()


def _networks(values, *, pools=False, max_entries=64):
    if not isinstance(values, tuple) or len(values) > max_entries or (pools and not values):
        raise KernelError('invalid finite allocation domain')
    result = []
    try:
        for text in values:
            if type(text) is not str:
                raise KernelError('invalid network value type')
            network = ipaddress.ip_network(text, strict=True)
            if str(network) != text:
                raise KernelError('noncanonical network value')
            if pools:
                forbidden = ('0.0.0.0/8','127.0.0.0/8','169.254.0.0/16','224.0.0.0/4','240.0.0.0/4')
                if network.version != 4 or not 8 <= network.prefixlen <= 30 or any(network.overlaps(ipaddress.ip_network(x)) for x in forbidden):
                    raise KernelError('unsupported allocation pool')
            result.append(network)
    except (ValueError, TypeError) as exc:
        raise KernelError('invalid allocation network') from exc
    if len(set(result)) != len(result):
        raise KernelError('duplicate allocation network')
    return tuple(sorted(result,key=lambda n:(n.version,int(n.network_address),n.prefixlen)))


def validate_allocation_domain(pools, host_networks, admin_networks):
    """Validate an explicit proposal; never infer or widen pools from current R."""
    candidates = _networks(pools,pools=True)
    host,admin = _networks(host_networks),_networks(admin_networks)
    for i,pool in enumerate(candidates):
        if any(pool.overlaps(other) for other in candidates[i+1:]):
            raise KernelError('overlapping allocation pools')
        if any(pool.version == n.version and pool.overlaps(n) for n in (*host,*admin)):
            raise KernelError('allocation domain intersects protected host or administration')
    return AllocationDomain(tuple(map(str,candidates)),tuple(map(str,host)),tuple(map(str,admin)))


def _domain(domain):
    if not isinstance(domain,AllocationDomain) or validate_allocation_domain(domain.pools,domain.host_networks,domain.admin_networks) != domain:
        raise KernelError('unverified allocation domain')
    return domain


@dataclass(frozen=True)
class BridgeBinding:
    name: str
    prefix: str
    gateway: str


def validate_bridge(domain, bridge):
    domain = _domain(domain)
    if (not isinstance(bridge,dict) or set(bridge) != {'name','kind','prefix','gateway'}
            or bridge['kind'] != 'bridge' or type(bridge['name']) is not str
            or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}',bridge['name'])):
        raise KernelError('unverified kernel bridge identity')
    try:
        prefix = ipaddress.ip_network(bridge['prefix'],strict=True)
        gateway = ipaddress.ip_address(bridge['gateway'])
    except (ValueError,TypeError) as exc:
        raise KernelError('invalid bridge address binding') from exc
    if (prefix.version != 4 or gateway.version != 4 or str(prefix) != bridge['prefix'] or str(gateway) != bridge['gateway']
            or prefix.prefixlen > 30 or not any(prefix.subnet_of(ipaddress.ip_network(p)) for p in domain.pools)
            or gateway not in prefix or gateway in (prefix.network_address,prefix.broadcast_address)):
        raise KernelError('bridge outside approved allocation domain')
    return BridgeBinding(bridge['name'],str(prefix),str(gateway))


def validate_endpoint(domain, bridge, endpoint, host_local_addresses):
    binding = validate_bridge(domain,bridge)
    if not isinstance(host_local_addresses,tuple) or len(host_local_addresses) > 256 or type(endpoint) is not str:
        raise KernelError('invalid endpoint context')
    try:
        address = ipaddress.ip_address(endpoint)
        local = _addresses(host_local_addresses)
    except (ValueError,TypeError) as exc:
        raise KernelError('invalid endpoint address') from exc
    prefix = ipaddress.ip_network(binding.prefix)
    if (address.version != 4 or str(address) != endpoint or address not in prefix
            or address in (prefix.network_address,prefix.broadcast_address,ipaddress.ip_address(binding.gateway))
            or address in local or any(address.version == n.version and address in n for n in _networks(domain.admin_networks))):
        raise KernelError('endpoint touches protected or invalid address')
    return str(address)


_D1_TOOL_VERSIONS = {'iptables':'iptables v1.8.11 (nf_tables)',
                     'ip6tables':'ip6tables v1.8.11 (nf_tables)',
                     'nft':'nftables v1.1.6 (Commodore Bullmoose #7)'}
_HOOKS = {
    'filter': {'INPUT':('filter','input',0),'FORWARD':('filter','forward',0),'OUTPUT':('filter','output',0)},
    'nat': {'PREROUTING':('nat','prerouting',-100),'INPUT':('nat','input',100),
            'OUTPUT':('nat','output',-100),'POSTROUTING':('nat','postrouting',100)},
    'raw': {'PREROUTING':('filter','prerouting',-300),'OUTPUT':('filter','output',-300)},
}


@dataclass(frozen=True)
class RepresentationProof:
    selected: tuple
    native: object
    versions: tuple
    virtual_chains: tuple

    @property
    def policy_verified(self):
        # Structural representation is deliberately not a semantic admission.
        return False


def _references(value, result):
    if isinstance(value,dict):
        for key,body in value.items():
            if key in ('jump','goto') and isinstance(body,dict) and type(body.get('target')) is str:
                result.add(body['target'])
            _references(body,result)
    elif isinstance(value,list):
        for item in value:
            _references(item,result)


def validate_representation(*, selected, native, versions):
    """Map every chain/rule position, including ONLY proven virtual builtins.

    This returns a partial proof, never approval of an unmanaged rule, residual
    class, or protected path. Subsequent D1 typed policy composition is required.
    """
    import shlex
    from ufw_kernel import KernelSave, NativeRuleset
    if type(versions) is not dict or versions != _D1_TOOL_VERSIONS or any(type(x) is not str for x in versions.values()):
        raise KernelError('unsupported Docker representation tool profile')
    if not isinstance(selected,tuple) or len(selected)!=2 or any(not isinstance(x,KernelSave) for x in selected):
        raise KernelError('missing compatibility representation family')
    if not isinstance(native,NativeRuleset) or NativeRuleset.parse(native.canonical,profile='nftables-1.1.6-schema1')!=native:
        raise KernelError('invalid native representation evidence')
    selected_tables, declarations, selected_rules, incoming = {}, {}, {}, {}
    for family,view in zip(('ip','ip6'),selected):
        if KernelSave.parse(view.canonical)!=view:
            raise KernelError('noncanonical compatibility representation')
        for table in view.tables:
            if table.name not in _HOOKS:
                raise KernelError('uncalibrated table representation')
            selected_tables[(family,table.name)]=True
            for name,policy in table.chains:
                declarations[(family,table.name,name)]=policy
            for line in table.rules:
                tokens=shlex.split(line.decode('utf-8'))
                key=(family,table.name,tokens[1])
                selected_rules.setdefault(key,[]).append(line)
                for i,token in enumerate(tokens[:-1]):
                    if token in ('-j','-g','--jump','--goto'):
                        incoming.setdefault((family,table.name),set()).add(tokens[i+1])
    native_tables, chains, native_rules = {}, {}, {}
    for record in json.loads(native.canonical)['nftables'][1:]:
        kind,body=next(iter(record.items()))
        if kind not in ('table','chain','rule') or not isinstance(body,dict):
            raise KernelError('unknown native representation object')
        if body.get('family') not in ('ip','ip6'):
            raise KernelError('unknown native representation family')
        family=body['family']
        if kind=='table':
            if set(body)!={'family','name'} or type(body['name']) is not str or body['name'] not in _HOOKS:
                raise KernelError('unknown native table representation')
            key=(family,body['name'])
            if key in native_tables:
                raise KernelError('duplicate native table representation')
            native_tables[key]=True
            continue
        if type(body.get('table')) is not str or body['table'] not in _HOOKS:
            raise KernelError('unknown native table reference')
        table=body['table']
        name=body.get('name') if kind=='chain' else body.get('chain')
        if type(name) is not str or not re.fullmatch(r'[A-Za-z0-9_.:+-]{1,255}',name):
            raise KernelError('invalid native chain identity')
        key=(family,table,name)
        if kind=='chain':
            if key in chains:
                raise KernelError('duplicate native chain identity')
            chains[key]=body
        else:
            if (set(body) not in ({'family','table','chain','expr'},{'family','table','chain','expr','comment'})
                    or ('comment' in body and type(body['comment']) is not str)):
                raise KernelError('unknown native rule representation fields')
            native_rules.setdefault(key,[]).append(body)
            refs=incoming.setdefault((family,table),set())
            _references(body['expr'],refs)
    if set(selected_tables)!=set(native_tables) or not set(chains)<=set(declarations) or not set(native_rules)<=set(chains):
        raise KernelError('unrepresented native table chain or rule')
    virtual=[]
    for key,policy in declarations.items():
        family,table,name=key
        hook=_HOOKS[table].get(name)
        if key not in chains:
            # The sole absent-native exception, justified by pinned upstream
            # fake-builtin cache behavior. Never apply it to filter/user/unknown.
            if (table not in ('nat','raw') or hook is None or policy!='ACCEPT'
                    or selected_rules.get(key) or native_rules.get(key)
                    or name in incoming.get((family,table),set())):
                raise KernelError('unsafe missing native chain')
            if any(body.get('family')==family and body.get('table')==table and body.get('hook')==hook[1] for body in chains.values()):
                raise KernelError('hidden native hook behind virtual builtin')
            virtual.append(key)
            continue
        body=chains[key]
        expected={'family':family,'table':table,'name':name}
        if hook is None:
            if policy!='-':
                raise KernelError('unsupported user chain default policy')
        else:
            if policy not in ('ACCEPT','DROP') or (table in ('nat','raw') and policy!='ACCEPT') or type(body.get('prio')) is not int:
                raise KernelError('invalid builtin policy or priority type')
            expected.update(type=hook[0],hook=hook[1],prio=hook[2],policy=policy.lower())
        if json.dumps(body,sort_keys=True,separators=(',',':'))!=json.dumps(expected,sort_keys=True,separators=(',',':')):
            raise KernelError('native physical chain differs from fixed hook profile')
        if len(selected_rules.get(key,[]))!=len(native_rules.get(key,[])):
            raise KernelError('native compatibility rule position count differs')
    return RepresentationProof(selected,native,tuple(sorted(versions.items())),tuple(sorted(virtual)))


def _addresses(values):
    if not isinstance(values,tuple) or len(values)>256:
        raise KernelError('invalid bounded host address context')
    result=[]
    try:
        for text in values:
            if type(text) is not str or '%' in text:
                raise KernelError('invalid host address type or scope')
            address=ipaddress.ip_address(text)
            if str(address)!=text:
                raise KernelError('noncanonical host address')
            result.append(address)
    except (ValueError,TypeError) as exc:
        raise KernelError('invalid host address') from exc
    if len(set(result))!=len(result):
        raise KernelError('ambiguous duplicate host address')
    return tuple(sorted(result,key=lambda a:(a.version,int(a))))


def _ports(values):
    if (not isinstance(values,tuple) or not values or len(values)>64
            or any(type(x) is not int or not 1<=x<=65535 for x in values) or len(set(values))!=len(values)):
        raise KernelError('invalid protected port context')
    return tuple(sorted(values))


@dataclass(frozen=True)
class ProtectedPaths:
    domain: AllocationDomain
    cf_sources: tuple
    cf_ports: tuple
    ssh_ports: tuple
    host_addresses: tuple
    admin_routes: tuple

    @property
    def fingerprint(self):
        value=[self.domain.fingerprint,self.cf_sources,self.cf_ports,self.ssh_ports,self.host_addresses,self.admin_routes]
        return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()


def validate_protected_paths(domain, *, cf_sources, cf_ports, ssh_ports, host_addresses, admin_routes):
    """Validate a candidate path specification, NOT its enrollment authority.

    CF sources include confirmed and candidate source/routing domains; a caller
    must bind them to the protected raw/owned manifest before policy admission.
    The current helper alone is not full P or kernel policy verification.
    """
    domain=_domain(domain)
    sources=_networks(cf_sources,max_entries=512)
    host=_addresses(host_addresses)
    admin=_networks(admin_routes)
    cf,ssh=_ports(cf_ports),_ports(ssh_ports)
    if not sources or not host or not admin or tuple(map(str,admin))!=domain.admin_networks or set(cf)&set(ssh):
        raise KernelError('incomplete or conflicting protected path context')
    if any(not any(a.version==n.version and a in n for n in _networks(domain.host_networks)) for a in host):
        raise KernelError('static host address outside approved context')
    pools=_networks(domain.pools,pools=True)
    if any(p.version==s.version and p.overlaps(s) for p in pools for s in sources):
        raise KernelError('allocation domain intersects protected CF source routing')
    return ProtectedPaths(domain,tuple(map(str,sources)),cf,ssh,tuple(map(str,host)),tuple(map(str,admin)))


def _paths(paths):
    if (not isinstance(paths,ProtectedPaths) or validate_protected_paths(paths.domain,
            cf_sources=paths.cf_sources,cf_ports=paths.cf_ports,ssh_ports=paths.ssh_ports,
            host_addresses=paths.host_addresses,admin_routes=paths.admin_routes)!=paths):
        raise KernelError('invalid persistent protected path candidate')
    return paths


@dataclass(frozen=True)
class MembershipProof:
    paths: ProtectedPaths
    bridges: tuple
    host_local_addresses: tuple
    admin_peers: tuple

    @property
    def policy_verified(self):
        return False


def validate_membership(paths, bridges, host_local_addresses, admin_peers):
    """Check concrete current R/address bindings without changing protected P."""
    paths=_paths(paths)
    if not isinstance(bridges,tuple) or len(bridges)>32:
        raise KernelError('invalid bounded bridge context')
    bindings=tuple(validate_bridge(paths.domain,b) for b in bridges)
    if len({b.name for b in bindings})!=len(bindings):
        raise KernelError('duplicate bridge identity')
    for i,binding in enumerate(bindings):
        if any(ipaddress.ip_network(binding.prefix).overlaps(ipaddress.ip_network(other.prefix)) for other in bindings[i+1:]):
            raise KernelError('overlapping current bridge networks')
    local,peers=_addresses(host_local_addresses),_addresses(admin_peers)
    expected=set(paths.host_addresses)|{b.gateway for b in bindings}
    if set(map(str,local))!=expected:
        raise KernelError('unrecognized host address or missing bridge gateway')
    # Empty peer observation is valid for a passive local guardian. It neither
    # clears nor widens the persistent approved route domain. Every concrete
    # observed peer must still belong to that domain.
    routes=_networks(paths.admin_routes)
    if any(not any(a.version==n.version and a in n for n in routes) for a in peers):
        raise KernelError('administration peer outside approved route domain')
    pools=_networks(paths.domain.pools,pools=True)
    if any(p.version==a.version and a in p for p in pools for a in peers):
        raise KernelError('current administration path intersects allocation domain')
    return MembershipProof(paths,tuple(sorted(bindings,key=lambda b:b.name)),tuple(map(str,local)),tuple(map(str,peers)))


def _validated_inventory(inventory):
    from pathlib import PurePosixPath
    from ufw_integrity import UfwInventory
    if not isinstance(inventory,UfwInventory) or not 1<=len(inventory.manifest)<=256:
        raise KernelError('invalid protected UFW inventory')
    records=[dict(row) for row in inventory.manifest]
    paths=[]
    files=set()
    directories=set()
    total=0
    for row in records:
        kind=row.get('kind')
        required={'path','kind','mode','uid','gid'}|({'size','sha256'} if kind=='file' else set())
        if kind not in ('file','directory') or set(row)!=required:
            raise KernelError('invalid protected inventory fields')
        path=row['path']
        if (type(path) is not str or str(PurePosixPath(path))!=path or '\x00' in path
                or '..' in PurePosixPath(path).parts or not(path=='/etc/default/ufw' or path=='/etc/ufw' or path.startswith('/etc/ufw/'))):
            raise KernelError('invalid protected inventory path')
        if (any(type(row[key]) is not int for key in ('mode','uid','gid'))
                or not 0<=row['mode']<=0o7777 or row['mode']&0o022 or row['uid']!=0 or not 0<=row['gid']<2**32):
            raise KernelError('invalid protected inventory ownership or mode')
        paths.append(path)
        if kind=='directory':
            directories.add(path)
            continue
        files.add(path)
        raw=inventory.contents.get(path)
        if (type(row['size']) is not int or not 0<=row['size']<=4*1024*1024
                or type(row['sha256']) is not str or not re.fullmatch(r'[a-f0-9]{64}',row['sha256'])
                or type(raw) is not bytes or len(raw)!=row['size'] or hashlib.sha256(raw).hexdigest()!=row['sha256']):
            raise KernelError('invalid protected inventory content evidence')
        total+=len(raw)
    required_files={'/etc/default/ufw'}|{'/etc/ufw/'+leaf for leaf in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules','ufw.conf')}
    if (paths!=sorted(set(paths)) or not required_files<=files or '/etc/ufw' not in directories
            or set(inventory.contents)!=files or total>6*1024*1024):
        raise KernelError('incomplete or unbounded protected inventory')
    for path in paths:
        if path not in ('/etc/default/ufw','/etc/ufw') and str(PurePosixPath(path).parent) not in directories:
            raise KernelError('missing protected inventory parent')
    encoded=json.dumps(records,sort_keys=True,separators=(',',':')).encode()
    return encoded


def validate_inventory_unchanged(reference, current):
    """Keep ALL captured files/paths/modes/owners/bytes, not a six-file mask."""
    expected,observed=_validated_inventory(reference),_validated_inventory(current)
    if expected!=observed or dict(reference.contents)!=dict(current.contents):
        raise KernelError('protected UFW inventory changed')
    return hashlib.sha256(expected).hexdigest()


_DOCKER_CHAINS=('DOCKER','DOCKER-USER','DOCKER-FORWARD','DOCKER-BRIDGE','DOCKER-CT','DOCKER-INTERNAL')
_DOCKER_FORWARD=(b'-A DOCKER-FORWARD -j DOCKER-CT',b'-A DOCKER-FORWARD -j DOCKER-INTERNAL',b'-A DOCKER-FORWARD -j DOCKER-BRIDGE')
_UFW_FORWARD=(b'-A FORWARD -j DOCKER-USER',b'-A FORWARD -j DOCKER-FORWARD')


def _json_bytes(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def _match(left,right,op='=='):
    return {'match':{'op':op,'left':left,'right':right}}


def _counter():
    return {'counter':{'packets':0,'bytes':0}}


def _jump(target):
    return {'jump':{'target':target}}


def _meta(key,value,op='=='):
    return _match({'meta':{'key':key}},value,op)


def _network_value(network):
    return str(network.network_address) if network.prefixlen==network.max_prefixlen else {'prefix':{'addr':str(network.network_address),'len':network.prefixlen}}


def _docker_catalog(membership):
    """Complete recognized byte grammar -> exact native shape, not wildcards."""
    catalog={}
    for family in ('ip','ip6'):
        for chain,target in [('FORWARD','DOCKER-USER'),('FORWARD','DOCKER-FORWARD'),
                             ('DOCKER-FORWARD','DOCKER-CT'),('DOCKER-FORWARD','DOCKER-INTERNAL'),('DOCKER-FORWARD','DOCKER-BRIDGE')]:
            line=('-A '+chain+' -j '+target).encode()
            catalog[(family,'filter',line)]={'expr':[_counter(),_jump(target)]}
        line=b'-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER'
        catalog[(family,'nat',line)]={'expr':[{'xt':{'type':'match','name':'addrtype'}},_counter(),_jump('DOCKER')]}
        loop='127.0.0.0/8' if family=='ip' else '::1/128'
        line=('-A OUTPUT ! -d '+loop+' -m addrtype --dst-type LOCAL -j DOCKER').encode()
        catalog[(family,'nat',line)]={'expr':[_match({'payload':{'protocol':family,'field':'daddr'}},_network_value(ipaddress.ip_network(loop)),'!='),
                                                       {'xt':{'type':'match','name':'addrtype'}},_counter(),_jump('DOCKER')]}
    for bridge in membership.bridges:
        name,prefix=bridge.name,bridge.prefix
        definitions=[
            ('filter','-A DOCKER ! -i '+name+' -o '+name+' -j DROP',[_meta('iifname',name,'!='),_meta('oifname',name),_counter(),{'drop':None}]),
            ('filter','-A DOCKER-BRIDGE -o '+name+' -j DOCKER',[_meta('oifname',name),_counter(),_jump('DOCKER')]),
            ('filter','-A DOCKER-CT -o '+name+' -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',[_meta('oifname',name),{'xt':{'type':'match','name':'conntrack'}},_counter(),{'accept':None}]),
            ('filter','-A DOCKER-FORWARD -i '+name+' -j ACCEPT',[_meta('iifname',name),_counter(),{'accept':None}]),
            ('nat','-A POSTROUTING -s '+prefix+' ! -o '+name+' -j MASQUERADE',[_match({'payload':{'protocol':'ip','field':'saddr'}},_network_value(ipaddress.ip_network(prefix))),
                                                                          _meta('oifname',name,'!='),_counter(),{'xt':{'type':'target','name':'MASQUERADE'}}]),
        ]
        for table,line,expr in definitions:
            catalog[('ip',table,line.encode())]={'expr':expr}
    return catalog


def _raw_endpoint_expression(line,membership):
    match=re.fullmatch(rb'-A PREROUTING -d (\S+) ! -i ([A-Za-z0-9_.:-]{1,15}) -j DROP',line)
    if not match:
        raise KernelError('unsupported raw residual rule')
    try:
        endpoint=ipaddress.ip_network(match.group(1).decode('ascii'),strict=True)
        name=match.group(2).decode('ascii')
    except (ValueError,UnicodeError) as exc:
        raise KernelError('invalid raw endpoint binding') from exc
    if endpoint.version!=4 or endpoint.prefixlen!=32 or endpoint.with_prefixlen!=match.group(1).decode():
        raise KernelError('unsupported raw endpoint prefix')
    bridges=[b for b in membership.bridges if b.name==name]
    if len(bridges)!=1:
        raise KernelError('unknown raw endpoint bridge')
    bridge=bridges[0]
    validate_endpoint(membership.paths.domain,{'name':bridge.name,'kind':'bridge','prefix':bridge.prefix,'gateway':bridge.gateway},
                      str(endpoint.network_address),membership.host_local_addresses)
    return {'expr':[_match({'payload':{'protocol':'ip','field':'daddr'}},str(endpoint.network_address)),
                    _meta('iifname',name,'!='),_counter(),{'drop':None}]}


def _load_ufw_profile():
    from pathlib import Path
    import ufw_kernel_mapping as mapping
    entry=mapping.BACKEND_PROFILES['26.04']
    raw=Path(__file__).with_name(entry['asset']).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=entry['sha256']:
        raise KernelError('protected raw grammar asset changed')
    return json.loads(raw)


def _owned_context(inventory,owned,paths):
    from ufw_integrity import ManagedTuple,UserRulesDocument,UserFileProfile,IntegrityError
    if not isinstance(owned,tuple) or len(owned)>4096:
        raise KernelError('invalid confirmed ownership context')
    documents={family:UserRulesDocument.parse(inventory.contents['/etc/ufw/'+leaf],UserFileProfile(family))
               for family,leaf in ((4,'user.rules'),(6,'user6.rules'))}
    identities=[]
    for rule in owned:
        if (not isinstance(rule,ManagedTuple) or type(rule.source) is not str or type(rule.port) is not int or type(rule.comment) is not str
                or rule.port not in paths.cf_ports):
            raise KernelError('invalid confirmed CloudFront ownership tuple')
        try:
            network=ipaddress.ip_network(rule.source,strict=True)
            if str(network)!=rule.source:
                raise KernelError('noncanonical confirmed CloudFront source')
            block=rule.block(documents[network.version].profile)
            if documents[network.version].blocks.count(block)!=1:
                raise KernelError('confirmed ownership absent from protected raw')
        except (IntegrityError,ValueError) as exc:
            raise KernelError('unconfirmed protected ownership tuple') from exc
        identities.append((rule.source,rule.port,rule.comment))
    keys={(source,port) for source,port,unused in identities}
    sources={source for source,port,unused in identities}
    if owned:
        if (len(keys)!=len(identities) or sources!=set(paths.cf_sources)
                or keys!={(source,port) for source in sources for port in paths.cf_ports}):
            raise KernelError('confirmed ownership differs from complete protected source port context')
    elif any(block.fields[0]=='allow' and block.fields[1]=='tcp' and block.fields[2] in {str(port) for port in paths.cf_ports}
             for document in documents.values() for block in document.blocks):
        raise KernelError('existing protected web tuples require explicit ownership import')
    return tuple(sorted(identities))


@dataclass(frozen=True)
class NoPublishCandidate:
    representation: RepresentationProof
    membership: MembershipProof
    inventory_fingerprint: str
    owned_rules: tuple
    residual_rules: tuple
    residual_native: tuple
    protected_inventory: object
    inventory: object
    legacy: tuple
    docker_package: str

    @property
    def policy_verified(self):
        # Complete within this pure typed candidate domain; not an enrollment,
        # actual Docker provenance assertion, or authority to invoke mutators.
        return True

    @property
    def actual_docker_calibrated(self):
        # Disposable real-daemon/lifecycle gate has NOT run for this D1 stage.
        return False

    @property
    def persistent_constraints(self):
        return hashlib.sha256(_json_bytes([self.inventory_fingerprint,self.membership.paths.fingerprint,self.owned_rules,'docker29-no-publish-candidate-v1'])).hexdigest()

    @property
    def transaction_identity(self):
        value=[[view.canonical.decode() for view in self.representation.selected],self.representation.native.canonical.decode(),
               [[b.name,b.prefix,b.gateway] for b in self.membership.bridges],self.membership.host_local_addresses,self.membership.admin_peers,self.persistent_constraints]
        return hashlib.sha256(_json_bytes(value)).hexdigest()


def validate_no_publish(*, representation, membership, protected_inventory, inventory, owned_rules, legacy, docker_package):
    """D1 candidate composition. No state/baseline writes and no policy actors.

    Synthetic positive tests establish this function's defined grammar only.
    Actual daemon/lifecycle reference calibration remains a separate required
    gate before engine integration; callers must not treat this as approval.
    """
    import collections
    import ufw_kernel_mapping as mapping
    if (type(docker_package) is not str or docker_package!='docker.io 29.1.3-0ubuntu4.1'
            or not isinstance(legacy,tuple) or len(legacy)!=2 or any(type(x) is not bytes or x for x in legacy)):
        raise KernelError('unsupported daemon profile or parallel legacy policy')
    if (not isinstance(representation,RepresentationProof) or validate_representation(selected=representation.selected,
            native=representation.native,versions=dict(representation.versions))!=representation):
        raise KernelError('invalid complete representation candidate')
    if not isinstance(membership,MembershipProof):
        raise KernelError('missing protected membership context')
    bridges=tuple({'name':b.name,'kind':'bridge','prefix':b.prefix,'gateway':b.gateway} for b in membership.bridges)
    if validate_membership(membership.paths,bridges,membership.host_local_addresses,membership.admin_peers)!=membership:
        raise KernelError('invalid protected membership candidate')
    inventory_id=validate_inventory_unchanged(protected_inventory,inventory)
    owned=_owned_context(inventory,owned_rules,membership.paths)
    residual,residual_native=_validate_policy_projection(representation,membership,inventory)
    return NoPublishCandidate(representation,membership,inventory_id,owned,tuple(residual),tuple(residual_native),
                              protected_inventory,inventory,legacy,docker_package)

def _validate_policy_projection(representation,membership,inventory):
    """Pure complete raw/kernel/R check; no ownership or admission authority.

    Public composition validates steady ownership first. Transaction callers
    must separately establish immutable-plan exact intermediate ownership.
    """
    import collections
    import ufw_kernel_mapping as mapping
    profile=_load_ufw_profile()
    raw={leaf:inventory.contents['/etc/ufw/'+leaf] for leaf in ('before.rules','before6.rules','after.rules','after6.rules','user.rules','user6.rules')}
    projection=mapping._selected_from_raw(raw,profile)
    native_rows={}
    for record in json.loads(representation.native.canonical)['nftables'][1:]:
        if 'rule' in record:
            row=record['rule'];native_rows.setdefault((row['family'],row['table'],row['chain']),[]).append(row)
    catalog=_docker_catalog(membership)
    residual=[]
    residual_native_counts=collections.Counter()
    for family,view,protected in zip(('ip','ip6'),representation.selected,projection):
        tables={t.name:t for t in view.tables}
        if not {'filter','nat'}<=set(tables) or not set(tables)<={'filter','nat','raw'}:
            raise KernelError('unsupported Docker table topology')
        expected_policies=dict(protected.tables[0].chains)
        expected_filter={**expected_policies,**{name:'-' for name in _DOCKER_CHAINS}}
        if dict(tables['filter'].chains)!=expected_filter:
            raise KernelError('unknown or changed protected filter chain policy')
        for table in tables.values():
            actual={name:[r for r in table.rules if r.split()[1].decode()==name] for name,unused in table.chains}
            expected={}
            if table.name=='filter':
                for name,unused in protected.tables[0].chains:
                    expected[name]=[r for r in protected.tables[0].rules if r.split()[1].decode()==name]
                expected['FORWARD']=list(_UFW_FORWARD)+expected['FORWARD']
                for name in _DOCKER_CHAINS:
                    expected[name]=[line for (f,t,line) in catalog if f==family and t=='filter' and line.split()[1].decode()==name]
                # Static delegation is ordered; only disjoint per-bridge R rows
                # may vary order between fresh runs. T retains every real byte.
                if actual['FORWARD']!=expected['FORWARD'] or actual['DOCKER-FORWARD'][:3]!=list(_DOCKER_FORWARD):
                    raise KernelError('protected Docker UFW attachment order changed')
            elif table.name=='nat':
                policies={name:('ACCEPT' if name!='DOCKER' else '-') for name in ('PREROUTING','INPUT','OUTPUT','POSTROUTING','DOCKER')}
                if dict(table.chains)!=policies:
                    raise KernelError('unsupported NAT chain topology')
                expected={name:[line for (f,t,line) in catalog if f==family and t=='nat' and line.split()[1].decode()==name] for name in policies}
            else:
                if dict(table.chains)!={'PREROUTING':'ACCEPT','OUTPUT':'ACCEPT'}:
                    raise KernelError('unsupported raw chain topology')
                if family!='ip' and table.rules:
                    raise KernelError('uncalibrated IPv6 raw endpoint policy')
                expected={'PREROUTING':actual['PREROUTING'],'OUTPUT':[]}
                if len(set(actual['PREROUTING']))!=len(actual['PREROUTING']):
                    raise KernelError('duplicate raw endpoint restriction')
                for line in actual['PREROUTING']:
                    catalog[(family,'raw',line)]=_raw_endpoint_expression(line,membership)
            for name,rows in actual.items():
                if name in expected_policies and table.name=='filter' and name!='FORWARD':
                    if rows!=expected[name]:
                        raise KernelError('unmanaged protected UFW order or rule changed')
                elif collections.Counter(rows)!=collections.Counter(expected[name]):
                    raise KernelError('unknown Docker residual rule or multiplicity')
                native=native_rows.get((family,table.name,name),[])
                for ordinal,(line,observed) in enumerate(zip(rows,native)):
                    key=(family,table.name,line)
                    if key in catalog:
                        body=catalog[key];residual.append((family,table.name,line))
                        residual_native_counts[_json_bytes({'rule':observed})]+=1
                    else:
                        pair=mapping.RulePair(family,table.name,name,ordinal,line,b'')
                        body=mapping._expected_native(pair,profile)
                    expected_row={'family':family,'table':table.name,'chain':name,**body}
                    if _json_bytes(observed)!=_json_bytes(expected_row):
                        raise KernelError('native meaning differs from complete protected or residual grammar')
    residual_native=[]
    for record in json.loads(representation.native.canonical)['nftables']:
        encoded=_json_bytes(record)
        if 'rule' not in record:
            residual_native.append(encoded)
        elif residual_native_counts[encoded]:
            residual_native.append(encoded)
            residual_native_counts[encoded]-=1
    if any(residual_native_counts.values()):
        raise KernelError('unaccounted residual native evidence')
    return tuple(residual),tuple(residual_native)



def _verified_no_publish(candidate):
    from ufw_integrity import ManagedTuple
    if not isinstance(candidate,NoPublishCandidate):
        raise KernelError('missing transaction residual candidate')
    owned=tuple(ManagedTuple(*row) for row in candidate.owned_rules)
    actual=validate_no_publish(representation=candidate.representation,membership=candidate.membership,
                              protected_inventory=candidate.protected_inventory,inventory=candidate.inventory,
                              owned_rules=owned,legacy=candidate.legacy,docker_package=candidate.docker_package)
    if actual!=candidate:
        raise KernelError('forged or stale residual candidate')
    return candidate


def _residual_context(candidate):
    member=candidate.membership
    paths=member.paths
    # CF source/rule bytes can change only through the separately predicted P
    # delta. Their changing values are not Docker R; static route/port/domain
    # requirements and concrete current address membership remain immutable.
    return _json_bytes([paths.domain.fingerprint,paths.cf_ports,paths.ssh_ports,paths.host_addresses,paths.admin_routes,
                        [[b.name,b.prefix,b.gateway] for b in member.bridges],member.host_local_addresses,member.admin_peers])


def assert_same_residual(before,after):
    """A fresh admissible R is never adopted inside an existing transaction."""
    before,after=_verified_no_publish(before),_verified_no_publish(after)
    layouts=lambda candidate:tuple(tuple((table.name,table.chains) for table in view.tables) for view in candidate.representation.selected)
    if (before.residual_rules!=after.residual_rules or before.residual_native!=after.residual_native
            or _residual_context(before)!=_residual_context(after) or layouts(before)!=layouts(after)
            or before.representation.virtual_chains!=after.representation.virtual_chains
            or before.representation.versions!=after.representation.versions):
        raise KernelError('residual or address context changed during transaction')
