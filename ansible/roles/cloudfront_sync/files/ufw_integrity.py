"""Pure UFW stock-file prediction and secure read-only inventory.

Phase A: deliberately not wired into the engine. No UFW imports, subprocesses,
capability probes, policy writes, state writes or implicit canonicalization.
Unknown documents fail before a caller may perform a mutation.
"""
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
from types import MappingProxyType

PROFILE = 'ufw-stock-036-v1'

class IntegrityError(ValueError):
    """Only fixed, non-sensitive error codes leave this module."""


def _fail(code):
    raise IntegrityError(code)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _metadata(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@dataclass(frozen=True)
class UfwInventory:
    manifest: tuple
    contents: dict

    def __post_init__(self):
        object.__setattr__(self, 'manifest', tuple(MappingProxyType(dict(item)) for item in self.manifest))
        object.__setattr__(self, 'contents', MappingProxyType(dict(self.contents)))

    @property
    def fingerprint(self):
        return _sha(json.dumps([dict(item) for item in self.manifest], sort_keys=True, separators=(',', ':')).encode())


def capture_ufw(root=Path('/'), *, owner=0, max_file=4_194_304,
                max_total=16_777_216, max_entries=256):
    """Capture fixed UFW paths, with nofollow FDs and before/after tree checks.

    `root`/`owner` only provide an isolated fixture filesystem. Runtime callers
    must use their defaults. contents is private evidence; never publish it.
    """
    root = Path(root)
    if not root.is_absolute() or root.is_symlink():
        _fail('unsafe_inventory_root')
    if any(type(v) is not int or v < 1 for v in (max_file, max_total, max_entries)):
        _fail('invalid_inventory_limits')
    anchors = [root, root / 'etc', root / 'etc/default', root / 'etc/ufw']

    def safe(path, directory=None):
        try:
            info = path.lstat()
        except OSError:
            _fail('inventory_path_unavailable')
        if info.st_uid != owner or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            _fail('unsafe_inventory_path')
        if directory is True and not stat.S_ISDIR(info.st_mode):
            _fail('inventory_directory_required')
        if directory is False and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            _fail('inventory_regular_single_link_required')
        return info

    def inventory_paths():
        found = []
        for anchor in anchors:
            safe(anchor, True)
        def walk(directory):
            safe(directory, True)
            found.append(directory)
            if len(found) > max_entries:
                _fail('inventory_entry_limit')
            try:
                children = sorted(directory.iterdir())
            except OSError:
                _fail('inventory_directory_unreadable')
            for child in children:
                info = safe(child)
                if stat.S_ISDIR(info.st_mode):
                    walk(child)
                elif stat.S_ISREG(info.st_mode):
                    safe(child, False)
                    found.append(child)
                else:
                    _fail('unsupported_inventory_entry')
                if len(found) > max_entries:
                    _fail('inventory_entry_limit')
        walk(root / 'etc/ufw')
        required = root / 'etc/default/ufw'
        safe(required, False)
        found.append(required)
        if len(found) > max_entries:
            _fail('inventory_entry_limit')
        for name in ('user.rules', 'user6.rules', 'ufw.conf', 'before.rules', 'before6.rules', 'after.rules', 'after6.rules'):
            safe(root / 'etc/ufw' / name, False)
        return sorted(set(found))

    try:
        paths = inventory_paths()
        identities = {p: _metadata(p.lstat()) for p in paths + anchors}
        records, contents, total = [], {}, 0
        for path in paths:
            info = safe(path)
            logical = '/' + str(path.relative_to(root))
            record = {'path': logical, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
            if stat.S_ISDIR(info.st_mode):
                record['kind'] = 'directory'
            else:
                if info.st_size > max_file:
                    _fail('inventory_file_limit')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_NOATIME', 0))
                try:
                    opened = os.fstat(fd)
                    if _metadata(opened) != identities[path]:
                        _fail('inventory_changed_during_read')
                    parts, size = [], 0
                    while True:
                        chunk = os.read(fd, min(65536, max_file + 1 - size))
                        if not chunk:
                            break
                        parts.append(chunk)
                        size += len(chunk)
                        if size > max_file:
                            _fail('inventory_file_limit')
                    data = b''.join(parts)
                    if _metadata(os.fstat(fd)) != _metadata(opened) or _metadata(path.lstat()) != _metadata(opened):
                        _fail('inventory_changed_during_read')
                finally:
                    os.close(fd)
                total += len(data)
                if total > max_total:
                    _fail('inventory_total_limit')
                record.update({'kind': 'file', 'size': len(data), 'sha256': _sha(data)})
                contents[logical] = data
            records.append(record)
        if inventory_paths() != paths or any(_metadata(p.lstat()) != before for p, before in identities.items()):
            _fail('inventory_changed_during_read')
        return UfwInventory(tuple(records), contents)
    except IntegrityError:
        raise
    except (OSError, ValueError, RecursionError):
        _fail('inventory_read_failed')


@dataclass(frozen=True)
class UserFileProfile:
    family: int
    loglevel: str = 'low'
    limit_supported: bool = True
    default_input: str = 'deny'
    default_output: str = 'allow'
    default_forward: str = 'deny'
    profile: str = PROFILE

    def __post_init__(self):
        if (type(self.family) is not int or self.family not in (4, 6) or self.profile != PROFILE
                or self.loglevel not in ('off', 'low', 'medium', 'high', 'full')
                or type(self.limit_supported) is not bool
                or any(p not in ('allow', 'deny', 'reject') for p in
                       (self.default_input, self.default_output, self.default_forward))):
            _fail('unsupported_user_file_profile')

    @property
    def prefix(self):
        return 'ufw' if self.family == 4 else 'ufw6'

    def header(self):
        names = ['user-input', 'user-output', 'user-forward']
        names += [part + '-logging-' + direction for part in ('before', 'user', 'after')
                  for direction in ('input', 'output', 'forward')]
        names += ['logging-deny', 'logging-allow']
        if self.limit_supported:
            names += ['user-limit', 'user-limit-accept']
        return ('*filter\n' + ''.join(':' + self.prefix + '-' + n + ' - [0:0]\n' for n in names) + '### RULES ###\n').encode()

    def footer(self):
        lines = ['\n### END RULES ###\n', '\n### LOGGING ###\n']
        p = self.prefix
        level = ('off', 'low', 'medium', 'high', 'full').index(self.loglevel)
        limit = '-m limit --limit 3/min --limit-burst 10'
        if not level:
            for direction in ('input', 'output', 'forward'):
                lines.append('-I ' + p + '-user-logging-' + direction + ' -j RETURN\n')
        if level:
            after_limit = ' ' + limit if level < 3 else ''
            for direction, policy in zip(('input', 'output', 'forward'),
                                         (self.default_input, self.default_output, self.default_forward)):
                if policy in ('deny', 'reject') or level >= 2:
                    text = 'BLOCK' if policy in ('deny', 'reject') else 'ALLOW'
                    lines.append('-A ' + p + '-after-logging-' + direction + ' -j LOG --log-prefix "[UFW ' + text + '] "' + after_limit + '\n')
            for action in ('deny', 'allow'):
                chain = p + '-logging-' + action
                if action == 'deny':
                    if level < 2:
                        lines.append('-I ' + chain + ' -m conntrack --ctstate INVALID -j RETURN -m limit --limit 3/min --limit-burst 10\n')
                    else:
                        lines.append('-A ' + chain + ' -m conntrack --ctstate INVALID -j LOG --log-prefix "[UFW AUDIT INVALID] "' + after_limit + '\n')
                lines.append('-A ' + chain + ' -j LOG --log-prefix "[UFW ' + ('BLOCK' if action == 'deny' else 'ALLOW') + '] "' + after_limit + '\n')
            if level >= 2:
                audit = '' if level == 4 else ' ' + limit
                if level == 2:
                    audit = ' -m conntrack --ctstate NEW' + audit
                for direction in ('input', 'output', 'forward'):
                    lines.append('-I ' + p + '-before-logging-' + direction + ' -j LOG --log-prefix "[UFW AUDIT] "' + audit + '\n')
        lines.append('### END LOGGING ###\n')
        if self.limit_supported:
            lines.append('\n### RATE LIMITING ###\n')
            if self.loglevel != 'off':
                lines.append('-A ' + p + '-user-limit -m limit --limit 3/minute -j LOG --log-prefix "[UFW LIMIT BLOCK] "\n')
            lines.extend(('-A ' + p + '-user-limit -j REJECT\n', '-A ' + p + '-user-limit-accept -j ACCEPT\n', '### END RATE LIMITING ###\n'))
        lines.append('COMMIT\n')
        return ''.join(lines).encode()


def _address(value, family):
    try:
        parsed = ipaddress.ip_network(value, strict=True)
    except ValueError:
        _fail('unsupported_tuple_address')
    if parsed.version != family:
        _fail('tuple_address_family')
    # UFW prints a host without /32 or /128, but preserves a default route.
    return str(parsed.network_address) if parsed.prefixlen == parsed.max_prefixlen else str(parsed)


def _port(value):
    if value == 'any':
        return value
    if not re.fullmatch(r'[0-9]+(?::[0-9]+)?(?:,[0-9]+(?::[0-9]+)?)*', value):
        _fail('unsupported_tuple_port')
    if value.count(',') + value.count(':') > 14:
        _fail('unsupported_tuple_port_count')
    natural = lambda x: tuple(int(v) if v.isdigit() else v for v in re.split(r'([0-9]+)', x))
    if sorted(value.split(','), key=natural) != value.split(','):
        _fail('noncanonical_tuple_port')
    for part in value.split(','):
        limits = [int(x) for x in part.split(':')]
        if any(x < 1 or x > 65535 for x in limits) or len(limits) == 2 and limits[0] >= limits[1]:
            _fail('unsupported_tuple_port')
    return value


@dataclass(frozen=True)
class TupleBlock:
    fields: tuple
    comment_hex: str = ''

    @property
    def identity(self):
        # UFW can replace the action/comment of an existing permission tuple.
        # Reject these collisions before executing anything, not after rewrite.
        return self.fields[1:6] + ((self.fields[6:8] if len(self.fields) == 9 else ('-', '-'))) + (self.fields[-1],)

    def render(self, profile):
        fields = self.fields
        if len(fields) not in (7, 9) or any(not isinstance(x, str) or not x for x in fields):
            _fail('unsupported_tuple_shape')
        action, proto, dport, dst, sport, src = fields[:6]
        token = fields[-1]
        route = action.startswith('route:')
        action_base = action[6:] if route else action
        logging = ''
        for suffix in ('_log-all', '_log'):
            if action_base.endswith(suffix):
                action_base, logging = action_base[:-len(suffix)], suffix
                break
        if action_base not in ('allow', 'deny', 'reject', 'limit') or proto not in ('tcp', 'udp', 'ipv6', 'esp', 'ah', 'igmp', 'gre', 'vrrp', 'any'):
            _fail('unsupported_tuple_action_protocol')
        _port(dport); _port(sport)
        if _address(src, profile.family) != src or _address(dst, profile.family) != dst:
            _fail('noncanonical_tuple_address')
        if self.comment_hex:
            if not re.fullmatch(r'(?:[0-9a-f]{2})+', self.comment_hex):
                _fail('invalid_tuple_comment')
            try:
                comment = bytes.fromhex(self.comment_hex).decode('utf-8')
            except (ValueError, UnicodeError):
                _fail('invalid_tuple_comment')
            if any(ord(c) < 32 or ord(c) == 127 for c in comment):
                _fail('invalid_tuple_comment')
        direction, iface_in, iface_out = 'in', '', ''
        if token in ('in', 'out'):
            direction = token
        elif re.fullmatch(r'in_[A-Za-z0-9_.+,=%@-]+!out_[A-Za-z0-9_.+,=%@-]+', token):
            if not route or not re.search(r'in_\w+', token) or not re.search(r'out_\w+', token):
                _fail('unsupported_tuple_interface')
            iface_in, iface_out = token[3:].split('!out_', 1)
        elif re.fullmatch(r'(in|out)_[A-Za-z0-9_.+,=%@-]+', token):
            direction, interface = token.split('_', 1)
            if direction == 'in': iface_in = interface
            else: iface_out = interface
        else:
            _fail('unsupported_tuple_interface')
        if any(len(name) > 15 or name in ('.', '..') for name in (iface_in, iface_out) if name):
            _fail('unsupported_tuple_interface')
        args = []
        if iface_in: args += ['-i', iface_in]
        if iface_out: args += ['-o', iface_out]
        args += ['-p', 'all' if proto == 'any' else proto]
        multi = any(',' in x or ':' in x for x in (dport, sport) if x != 'any')
        if multi and proto not in ('tcp', 'udp'):
            _fail('unsupported_tuple_multiport')
        if multi:
            args += ['-m', 'multiport']
            if dport != 'any': args += ['--dports', dport]
            if dport != 'any' and sport != 'any': args += ['-m', 'multiport']
            if sport != 'any': args += ['--sports', sport]
        if dst not in ('0.0.0.0/0', '::/0'): args += ['-d', dst]
        if not multi and dport != 'any': args += ['--dport', dport]
        if src not in ('0.0.0.0/0', '::/0'): args += ['-s', src]
        if not multi and sport != 'any': args += ['--sport', sport]
        target = {'allow':'ACCEPT', 'deny':'DROP', 'reject':'REJECT', 'limit':'LIMIT'}[action_base]
        args += ['-j', target + logging]
        if action_base == 'reject' and proto == 'tcp': args += ['--reject-with', 'tcp-reset']
        if len(fields) == 9:
            apps = []
            for prefix, app in zip(('dapp_', 'sapp_'), fields[6:8]):
                if app != '-':
                    if not re.fullmatch(r'[A-Za-z0-9_.%+-]+', app): _fail('unsupported_tuple_application')
                    apps.append(prefix + app)
            if not apps: _fail('noncanonical_tuple_application')
            args += ['-m', 'comment', '--comment', "'" + ','.join(apps) + "'"]
        chain = profile.prefix + '-user-' + ('forward' if route else 'output' if direction == 'out' else 'input')
        line = '-A ' + chain + ' ' + ' '.join(args) + '\n'
        variants = []
        if '-p all ' in line:
            if re.search(r'port ', line):
                tcp = line.replace('-p all ', '-p tcp ')
                if action_base == 'reject': tcp = tcp.replace('-j REJECT' + logging, '-j REJECT' + logging + ' --reject-with tcp-reset')
                variants = [tcp, line.replace('-p all ', '-p udp ')]
            else: variants = [line.replace('-p all ', '')]
        else: variants = [line]
        rendered = []
        for variant in variants:
            if logging:
                logchain = profile.prefix + '-user-logging-' + ('forward' if route else 'output' if direction == 'out' else 'input')
                original_target = target + logging
                before, after = variant.split('-j ' + original_target, 1)
                label = 'ALLOW' if target == 'ACCEPT' else 'LIMIT' if target == 'LIMIT' else 'BLOCK'
                logargs = ('' if logging == '_log-all' else '-m conntrack --ctstate NEW ') + '-m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW ' + label + '] "'
                rendered.append(before.replace('-A ' + chain, '-A ' + logchain, 1) + logargs + '\n')
                rendered.append(before.replace('-A ' + chain, '-A ' + logchain, 1) + '-j RETURN' + after)
                rendered.append(before + '-j ' + logchain + after)
                variant = before + '-j ' + target + after
            if action_base == 'limit':
                if not profile.limit_supported: _fail('unsupported_limit_capability')
                for ending in ('-m conntrack --ctstate NEW -m recent --set',
                               '-m conntrack --ctstate NEW -m recent --update --seconds 30 --hitcount 6 -j ' + profile.prefix + '-user-limit',
                               '-j ' + profile.prefix + '-user-limit-accept'):
                    rendered.append(variant.replace('-j LIMIT', ending))
            else: rendered.append(variant)
        comment = ' comment=' + self.comment_hex if self.comment_hex else ''
        return ('\n### tuple ### ' + ' '.join(fields) + comment + '\n' + ''.join(rendered)).encode('utf-8')


@dataclass(frozen=True)
class ManagedTuple:
    source: str
    port: int
    comment: str

    def block(self, profile):
        if not isinstance(self.source, str):
            _fail('invalid_managed_source')
        try: network = ipaddress.ip_network(self.source, strict=True)
        except ValueError: _fail('invalid_managed_source')
        if network.version != profile.family or network.prefixlen == 0 or type(self.port) is not int or not 1 <= self.port <= 65535:
            _fail('invalid_managed_tuple')
        if not isinstance(self.comment, str) or any(ord(c) < 32 or ord(c) == 127 for c in self.comment):
            _fail('invalid_managed_comment')
        source = _address(str(network), profile.family)
        fields = ('allow', 'tcp', str(self.port), '0.0.0.0/0' if profile.family == 4 else '::/0', 'any', source, 'in')
        return TupleBlock(fields, self.comment.encode().hex())


@dataclass(frozen=True)
class UserRulesDocument:
    profile: UserFileProfile
    blocks: tuple

    @classmethod
    def parse(cls, raw, profile):
        if not isinstance(raw, bytes) or len(raw) > 4_194_304 or not isinstance(profile, UserFileProfile):
            _fail('invalid_user_file')
        header, footer = profile.header(), profile.footer()
        if not raw.startswith(header) or not raw.endswith(footer):
            _fail('noncanonical_user_file_envelope')
        body = raw[len(header):len(raw)-len(footer)]
        try: parts = body.decode('utf-8').split('\n### tuple ### ')
        except UnicodeError: _fail('invalid_user_file_encoding')
        if parts[0] != '': _fail('unknown_user_file_residue')
        blocks = []
        for piece in parts[1:]:
            first, separator, remaining = piece.partition('\n')
            if not separator: _fail('invalid_tuple_block')
            tuple_part, marker, comment = first.partition(' comment=')
            if ' '.join(tuple_part.split()) != tuple_part:
                _fail('noncanonical_tuple_spacing')
            block = TupleBlock(tuple(tuple_part.split(' ')), comment if marker else '')
            if marker and not comment: _fail('invalid_tuple_comment')
            if block.render(profile) != ('\n### tuple ### ' + piece).encode('utf-8'):
                _fail('noncanonical_tuple_body')
            blocks.append(block)
        if len(blocks) > 4096 or len(set(blocks)) != len(blocks):
            _fail('ambiguous_or_excess_tuple_blocks')
        document = cls(profile, tuple(blocks))
        if document.to_bytes() != raw:
            _fail('user_file_roundtrip_failed')
        return document

    def to_bytes(self):
        return self.profile.header() + b''.join(b.render(self.profile) for b in self.blocks) + self.profile.footer()

    def add(self, rule, index=None):
        if not isinstance(rule, ManagedTuple): _fail('managed_tuple_required')
        block = rule.block(self.profile)
        if any(b.identity == block.identity for b in self.blocks):
            _fail('managed_tuple_collision')
        if index is None: index = len(self.blocks)
        if type(index) is not int or not 0 <= index <= len(self.blocks):
            _fail('invalid_tuple_position')
        return UserRulesDocument(self.profile, self.blocks[:index] + (block,) + self.blocks[index:])

    def delete(self, rule):
        if not isinstance(rule, ManagedTuple): _fail('managed_tuple_required')
        block = rule.block(self.profile)
        if self.blocks.count(block) != 1 or sum(b.identity == block.identity for b in self.blocks) != 1:
            _fail('owned_tuple_missing_or_ambiguous')
        index = self.blocks.index(block)
        return UserRulesDocument(self.profile, self.blocks[:index] + self.blocks[index+1:])


def assert_transition(before, actual, operation, rule, *, index=None):
    if not isinstance(before, UserRulesDocument): _fail('canonical_before_required')
    if operation == 'add': expected = before.add(rule, index)
    elif operation == 'delete': expected = before.delete(rule)
    else: _fail('unsupported_tuple_operation')
    if expected.to_bytes() != actual: _fail('unexpected_user_file_bytes')
    return expected

@dataclass(frozen=True)
class UserFileMutation:
    """An exact generation transition, not an arbitrary allowed-after hash."""
    before: UserRulesDocument
    operation: str
    rule: ManagedTuple
    index: object = None

    @property
    def path(self):
        return '/etc/ufw/user.rules' if self.before.profile.family == 4 else '/etc/ufw/user6.rules'

    @property
    def before_bytes(self):
        return self.before.to_bytes()

    @property
    def after_bytes(self):
        if self.operation == 'add': return self.before.add(self.rule, self.index).to_bytes()
        if self.operation == 'delete' and self.index is None: return self.before.delete(self.rule).to_bytes()
        _fail('unsupported_tuple_operation')


def predict_user_file(before, operation, rule, *, index=None):
    if not isinstance(before, UserRulesDocument) or not isinstance(rule, ManagedTuple):
        _fail('canonical_managed_transition_required')
    intent = UserFileMutation(before, operation, rule, index)
    # Eagerly reject collisions/invalid operations before any caller side effect.
    intent.after_bytes
    return intent


def assert_inventory_transition(before, after, changes):
    """Conserve all bytes and metadata except exactly predicted owned blocks.

    A caller cannot provide a new baseline hash to waive an unexpected change.
    No-op is an empty list, which requires full inventory equality.
    """
    if not isinstance(before, UfwInventory) or not isinstance(after, UfwInventory) or not isinstance(changes, (tuple, list)):
        _fail('inventory_transition_required')
    old = {entry['path']: dict(entry) for entry in before.manifest}
    new = {entry['path']: dict(entry) for entry in after.manifest}
    if len(old) != len(before.manifest) or len(new) != len(after.manifest) or set(old) != set(new):
        _fail('unexpected_ufw_path_set')
    expected = {}
    for intent in changes:
        if not isinstance(intent, UserFileMutation) or intent.path in expected:
            _fail('ambiguous_inventory_transition')
        if before.contents.get(intent.path) != intent.before_bytes:
            _fail('inventory_transition_wrong_before')
        expected[intent.path] = intent.after_bytes
    for path, previous in old.items():
        current = new[path]
        content = expected.get(path, before.contents.get(path))
        if content is not None:
            previous.update({'size':len(content), 'sha256':_sha(content)})
            if after.contents.get(path) != content:
                _fail('unexpected_ufw_file_bytes')
        if current != previous:
            _fail('unexpected_ufw_file_metadata')
    if set(before.contents) != set(after.contents):
        _fail('unexpected_ufw_content_set')
