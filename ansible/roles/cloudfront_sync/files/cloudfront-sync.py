#!/usr/bin/env python3
"""Synchronize CloudFront origin-facing ranges without owning other host policy.

The CLI is intentionally root-only and uses fixed state/lock paths. Tests inject a
host adapter and temporary storage; production has no alternate URL or command
configuration. Neither subprocess output nor nginx configuration is logged.
"""
import argparse
import contextlib
import copy
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

AWS_URL = 'https://ip-ranges.amazonaws.com/ip-ranges.json'
STATE_DIR = Path('/var/lib/cloudfront-sync')
CONFIG = Path('/etc/cloudfront-sync/config.json')
LOCK = Path('/run/lock/cloudfront-sync.lock')
MARKER = 'cloudfront-sync'
MAX_DOWNLOAD = 8 * 1024 * 1024
TOKEN_TTL = 1800
MAX_FILE = 16 * 1024 * 1024


class SyncError(Exception):
    """A sanitized operational failure; never include subprocess/config content."""


class ApprovalRequired(SyncError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def network(value):
    try:
        if not isinstance(value, str):
            raise ValueError()
        result = ipaddress.ip_network(value, strict=False)
        if result.prefixlen == 0:
            raise ValueError()
        return str(result)
    except ValueError as exc:
        raise SyncError('invalid or all-addresses CIDR') from exc


def sorted_ranges(values, dual=True):
    if not isinstance(values, list) or not values:
        raise SyncError('empty or invalid ranges')
    result = sorted(set(network(v) for v in values), key=lambda v: (ipaddress.ip_network(v).version, int(ipaddress.ip_network(v).network_address), ipaddress.ip_network(v).prefixlen))
    if dual and {ipaddress.ip_network(v).version for v in result} != {4, 6}:
        raise SyncError('both IPv4 and IPv6 ranges are required')
    return result


def parse_aws(value):
    if not isinstance(value, dict) or not isinstance(value.get('syncToken'), str) or not re.fullmatch(r'[0-9]{1,20}', value['syncToken']):
        raise SyncError('invalid AWS publication token')
    ranges = []
    for key, prefix, family in [('prefixes', 'ip_prefix', 4), ('ipv6_prefixes', 'ipv6_prefix', 6)]:
        if not isinstance(value.get(key), list):
            raise SyncError('missing AWS prefix family')
        for entry in value[key]:
            if not isinstance(entry, dict):
                raise SyncError('invalid AWS prefix entry')
            if entry.get('service') != 'CLOUDFRONT_ORIGIN_FACING':
                continue
            cidr = network(entry.get(prefix))
            if ipaddress.ip_network(cidr).version != family:
                raise SyncError('AWS prefix family mismatch')
            ranges.append(cidr)
    return {'aws_sync_token': value['syncToken'], 'ranges': sorted_ranges(ranges)}


def safe_path(value, prefixes):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in value.split('/') or '//' in value:
        raise SyncError('unsafe filesystem path')
    p = Path(value)
    if not any(p != Path(base) and p.is_relative_to(base) for base in prefixes):
        raise SyncError('path outside permitted directory')
    return p


def validate_config(c):
    if not isinstance(c, dict) or set(c) != {'host_address', 'firewall', 'nginx', 'limits', 'notify_unit'}:
        raise SyncError('invalid config keys')
    try:
        if not isinstance(c['host_address'], str):
            raise ValueError()
        ipaddress.ip_address(c['host_address'])
    except (ValueError, TypeError) as exc:
        raise SyncError('host_address must be an IP address') from exc
    f, n, limits = c['firewall'], c['nginx'], c['limits']
    if not isinstance(f, dict) or set(f) != {'backend', 'ports'} or f['backend'] not in ('ufw', 'none'):
        raise SyncError('invalid firewall config')
    ports = f['ports']
    if not isinstance(ports, list) or not ports or any(type(p) is not int or not 1 <= p <= 65535 or p == 22 for p in ports) or len(set(ports)) != len(ports):
        raise SyncError('invalid or SSH firewall port')
    if not isinstance(n, dict) or set(n) != {'enabled', 'shared_dir', 'bundles'} or type(n['enabled']) is not bool or not isinstance(n['bundles'], list):
        raise SyncError('invalid nginx config')
    safe_path(n['shared_dir'], ['/etc/nginx', '/etc/common-sv/nginx'])
    if n['enabled'] and not n['bundles']:
        raise SyncError('nginx bundles must not be empty')
    seen = set()
    for bundle in n['bundles']:
        if not isinstance(bundle, dict) or set(bundle) != {'geo_file', 'realip_file'}:
            raise SyncError('invalid nginx bundle')
        for path in bundle.values():
            safe_path(path, ['/etc/nginx', '/etc/common-sv/nginx'])
        key = (bundle['geo_file'], bundle['realip_file'])
        if key in seen:
            raise SyncError('duplicate nginx bundle')
        seen.add(key)
    if not isinstance(limits, dict) or set(limits) != {'max_changes', 'min_ratio'}:
        raise SyncError('invalid limits config')
    if type(limits['max_changes']) is not int or not 1 <= limits['max_changes'] <= 1000:
        raise SyncError('invalid max_changes')
    ratio = limits['min_ratio']
    if type(ratio) not in (int, float) or not math.isfinite(ratio) or not 0 < ratio <= 1:
        raise SyncError('invalid min_ratio')
    if not isinstance(c['notify_unit'], str) or (c['notify_unit'] and not re.fullmatch(r'[A-Za-z0-9_@.-]+\.service', c['notify_unit'])):
        raise SyncError('invalid notify unit')
    return c


def within_limits(old, new, limits):
    if not old or len(set(old) ^ set(new)) > limits['max_changes']:
        return False
    for version in (4, 6):
        previous = sum(ipaddress.ip_network(x).version == version for x in old)
        current = sum(ipaddress.ip_network(x).version == version for x in new)
        if not previous or current / previous < limits['min_ratio']:
            return False
    return True


def check_path(path, *, directory=False, writable=False):
    """Reject symlinks and writable-by-other ancestors, including target itself."""
    p = Path(path)
    for current in [*reversed(p.parents), p]:
        try:
            info = current.lstat()
        except FileNotFoundError:
            if current == p:
                raise SyncError('required path is missing')
            raise SyncError('required parent directory is missing')
        if stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            # /tmp is not used by production paths; tests use Engine directly.
            raise SyncError('unsafe ownership, mode, or symlink')
        if current != p and not stat.S_ISDIR(info.st_mode):
            raise SyncError('non-directory path ancestor')
    if directory and not stat.S_ISDIR(info.st_mode):
        raise SyncError('expected directory')
    if not directory and not stat.S_ISREG(info.st_mode):
        raise SyncError('expected regular file')
    if writable and info.st_mode & 0o077:
        raise SyncError('private file is accessible by other users')


def read_text(path, private=False, secure=True):
    if secure:
        check_path(path, writable=private)
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            result = handle.read(MAX_FILE + 1)
        if len(result) > MAX_FILE:
            raise SyncError('file exceeds size limit')
        return result
    except (OSError, UnicodeError) as exc:
        raise SyncError('unable to read required file') from exc


def json_read(path, secure=False):
    try:
        return json.loads(read_text(path, private=secure, secure=secure))
    except (ValueError, OSError) as exc:
        raise SyncError('invalid JSON file') from exc


def atomic_text(path, content, mode=0o600):
    path = Path(path)
    if path.is_symlink():
        raise SyncError('refusing symlink destination')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def unlink_durable(path):
    path = Path(path)
    path.unlink()
    dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def atomic_json(path, value, mode=0o600):
    atomic_text(path, canonical(value) + '\n', mode)


def make_rule(source, port, comment=MARKER):
    source = network(source)
    args = ['allow', 'proto', 'tcp', 'from', source, 'to', 'any', 'port', str(port)]
    if comment:
        args += ['comment', comment]
    return {'args': args, 'source': source, 'port': port, 'comment': comment,
            'proto': 'tcp', 'direction': 'in', 'destination': 'any'}


def parse_ufw(text):
    """Read ufw's replayable rules, preserving commands for exact ownership.

    Rules outside the narrow allow/in/tcp/source/any/one-port shape are opaque
    and never touched. A malformed rule carrying our marker is an error.
    """
    rules = []
    for line in text.splitlines():
        if not line.startswith('ufw '):
            continue
        try:
            args = shlex.split(line)[1:]
        except ValueError as exc:
            raise SyncError('invalid UFW rule output') from exc
        rule = {'args': args, 'source': None, 'port': None, 'comment': '', 'proto': None, 'direction': None, 'destination': None}
        tokens = list(args)
        if 'comment' in tokens:
            i = tokens.index('comment')
            if i == len(tokens) - 2:
                rule['comment'] = tokens[i + 1]
                tokens = tokens[:i]
        # Match token semantics rather than ufw's formatting/order.
        parsed = {'action': None, 'proto': None, 'source': None, 'destination': None, 'port': None, 'direction': 'in'}
        try:
            if tokens and tokens[0] == 'allow':
                parsed['action'] = tokens.pop(0)
                while tokens:
                    key = tokens.pop(0)
                    if key in ('in', 'out'):
                        parsed['direction'] = key
                    elif key in ('proto', 'from', 'to', 'port'):
                        val = tokens.pop(0)
                        parsed[{'from': 'source', 'to': 'destination'}.get(key, key)] = val
                    else:
                        raise ValueError()
                if parsed['source'] and parsed['destination'] == 'any' and parsed['proto'] == 'tcp' and parsed['direction'] == 'in' and parsed['port'] and re.fullmatch(r'[0-9]+', parsed['port']):
                    rule = make_rule(parsed['source'], int(parsed['port']), rule['comment'])
                    if not 1 <= rule['port'] <= 65535:
                        raise ValueError()
        except (ValueError, IndexError, SyncError):
            pass
        if rule['comment'] == MARKER and (rule['source'] is None or rule['port'] is None):
            raise SyncError('unrecognized owned UFW rule')
        rules.append(rule)
    return rules




def port_may_match(spec, port):
    """Unknown/application port expressions are deliberately fail-closed."""
    if spec is None:
        return True
    if not isinstance(spec, str):
        return True
    if '/' in spec:
        spec, proto = spec.rsplit('/', 1)
        if proto == 'udp':
            return False
        if proto != 'tcp':
            return True
    for item in spec.split(','):
        if re.fullmatch('[0-9]+', item):
            if int(item) == port:
                return True
        elif re.fullmatch('[0-9]+:[0-9]+', item):
            low, high = map(int, item.split(':'))
            if low <= port <= high:
                return True
        else:
            return True
    return False


def policy_from_status(tokens):
    action_index = next((i for i, t in enumerate(tokens) if t in ('ALLOW', 'DENY', 'REJECT', 'LIMIT')), None)
    if action_index is None:
        return {'action': 'unknown', 'source': None, 'port': None}
    action = tokens[action_index].lower()
    after = tokens[action_index + 1:]
    if after and after[0] in ('OUT', 'FWD'):
        return None
    if after and after[0] == 'IN':
        after = after[1:]
    source = None
    if after:
        if after[0] == 'Anywhere':
            source = 'any'
        else:
            try:
                source = network(after[0])
            except SyncError:
                pass
    destination = tokens[:action_index]
    if 'on' in destination:
        destination = destination[:destination.index('on')]
    port = destination[-1] if destination else None
    if port == 'Anywhere':
        port = None
    return {'action': action, 'source': source, 'port': port}


def policy_may_match(policy, cidr, port):
    if policy is None or not port_may_match(policy['port'], port):
        return False
    source = policy['source']
    if source not in (None, 'any') and not ipaddress.ip_network(source).overlaps(ipaddress.ip_network(cidr)):
        return False
    return True


def rule_identity(rule):
    return {key: rule[key] for key in ('source', 'port', 'proto', 'direction', 'destination')}


def parse_ufw_numbered(text):
    """Capture actual kernel-order indices, including both generic rule families.

    `ufw show added` collapses generic dual-stack rules into one command, so
    its line numbers must NEVER be used with `ufw insert`.
    """
    result = []
    for line in text.splitlines():
        match = re.match(r'^\[\s*([0-9]+)\]\s+(.+)$', line.strip())
        if not match:
            continue
        body, _, comment = match.group(2).partition('#')
        tokens = body.split()
        family = 6 if '(v6)' in tokens else 4
        tokens = [x for x in tokens if x != '(v6)']
        key = digest({'family': family, 'opaque': ' '.join(tokens), 'comment': comment.strip()})
        try:
            if len(tokens) == 4 and tokens[1:3] == ['ALLOW', 'IN'] and re.fullmatch(r'[0-9]+/tcp', tokens[0]):
                rule = make_rule(tokens[3], int(tokens[0].split('/')[0]), comment.strip())
                key = digest(rule)
        except SyncError:
            pass
        result.append({'number': int(match.group(1)), 'family': family, 'key': key, 'policy': policy_from_status(tokens)})
    if any(x['number'] != i + 1 for i, x in enumerate(result)) or len({x['key'] for x in result}) != len(result):
        raise SyncError('ambiguous UFW runtime rule order')
    return result


def render_nginx(ranges):
    return {'cloudfront-geo.conf': ''.join(f'{r} 1;\n' for r in ranges),
            'cloudfront-realip.conf': ''.join(f'set_real_ip_from {r};\n' for r in ranges)}


def parse_nginx_ranges(files):
    values = []
    for name, prefix, suffix in [('cloudfront-geo.conf', '', ' 1;'), ('cloudfront-realip.conf', 'set_real_ip_from ', ';')]:
        found = []
        for line in files[name].splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if not line.startswith(prefix) or not line.endswith(suffix):
                raise SyncError('unexpected shared nginx directive')
            cidr = line[len(prefix):len(line) - len(suffix)].strip()
            found.append(network(cidr))
        values.append(sorted_ranges(found))
    if values[0] != values[1]:
        raise SyncError('nginx geo/realip ranges differ')
    return values[0]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError('AWS redirect refused')


class Host:
    def command(self, args):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=120,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SyncError('host command unavailable or timed out') from exc
        if result.returncode:
            raise SyncError('host command failed')
        return result.stdout

    def fetch(self):
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(AWS_URL, timeout=30) as response:
                body = response.read(MAX_DOWNLOAD + 1)
            if len(body) > MAX_DOWNLOAD:
                raise SyncError('AWS response exceeds size limit')
            return json.loads(body)
        except (OSError, ValueError) as exc:
            raise SyncError('AWS fetch failed') from exc

    def check_target(self, config):
        """Identity and SSH guards must run before even recovery mutations."""
        for command in ['ip', 'systemctl', 'sshd']:
            if not shutil.which(command):
                raise SyncError('required host command missing')
        addresses = json.loads(self.command(['ip', '-json', 'address', 'show']))
        expected = str(ipaddress.ip_address(config['host_address']))
        if not any(str(ipaddress.ip_address(a['local'])) == expected for item in addresses for a in item.get('addr_info', []) if 'local' in a):
            raise SyncError('host address does not identify this host')
        ssh_config = self.command(['sshd', '-T'])
        ssh_ports = {int(m.group(1)) for m in re.finditer(r'^port ([0-9]+)$', ssh_config, re.M)}
        if not ssh_ports or ssh_ports.intersection(config['firewall']['ports']):
            raise SyncError('SSH port is protected from synchronization')
        if config['firewall']['backend'] == 'ufw':
            if not shutil.which('ufw') or not self.command(['ufw', 'status']).startswith('Status: active'):
                raise SyncError('UFW must already be active')

    def preflight(self, config):
        self.check_target(config)
        n = config['nginx']
        if n['enabled']:
            if not shutil.which('nginx'):
                raise SyncError('nginx missing')
            check_path(n['shared_dir'], directory=True)
            self.command(['nginx', '-t'])
            effective = self.command(['nginx', '-T'])
            for bundle in n['bundles']:
                for file in bundle.values():
                    check_path(file)
                    if f'# configuration file {file}:' not in effective:
                        raise SyncError('configured nginx bundle is not active')
                geo = read_text(bundle['geo_file'])
                realip = read_text(bundle['realip_file'])
                # Strip comments, then require includes to be live directives.
                # nginx -t validates syntax; no text from these files is emitted.
                geo_tokens = nginx_tokens(geo)
                real_tokens = nginx_tokens(realip)
                geo_include = str(Path(n['shared_dir']) / 'cloudfront-geo.conf')
                real_include = str(Path(n['shared_dir']) / 'cloudfront-realip.conf')
                blocks = nginx_geo_blocks(geo_tokens)
                selected = [(source, chunks(body)) for source, body in blocks if ['include', geo_include, ';'] in chunks(body)]
                if len(selected) != 1 or selected[0][0] != '$realip_remote_addr':
                    raise SyncError('nginx geo include is not bound to original peer address')
                body = selected[0][1]
                if body.count(['include', geo_include, ';']) != 1 or body.count(['default', '0', ';']) != 1 or any(d not in (['include', geo_include, ';'], ['default', '0', ';']) for d in body):
                    raise SyncError('nginx geo contains unmanaged address policy')
                if chunks(real_tokens).count(['include', real_include, ';']) != 1:
                    raise SyncError('nginx realip include missing or duplicated')
                combined = chunks(geo_tokens) + chunks(real_tokens)
                if ['real_ip_header', 'X-Forwarded-For', ';'] not in combined or ['real_ip_recursive', 'off', ';'] not in combined:
                    raise SyncError('nginx realip behavior differs from required policy')
                if any(d[0] == 'set_real_ip_from' or (d[0] == 'real_ip_header' and d != ['real_ip_header', 'X-Forwarded-For', ';']) or (d[0] == 'real_ip_recursive' and d != ['real_ip_recursive', 'off', ';']) for d in combined):
                    raise SyncError('nginx contains unmanaged realip trust policy')

    def snapshot(self, config):
        n = config['nginx']
        files, bundles = {}, {}
        if n['enabled']:
            for name in render_nginx([]):
                files[name] = read_text(Path(n['shared_dir']) / name)
            for bundle in n['bundles']:
                for path in bundle.values():
                    bundles[path] = hashlib.sha256(read_text(path).encode()).hexdigest()
        rules, runtime = [], []
        if config['firewall']['backend'] == 'ufw':
            rules = parse_ufw(self.command(['ufw', 'show', 'added']))
            runtime = parse_ufw_numbered(self.command(['ufw', 'status', 'numbered']))
            for rule in rules:
                if rule['source'] and sum(r['key'] == digest(rule) for r in runtime) != 1:
                    raise SyncError('configured UFW rule not found exactly once in live policy')
        return {'rules': rules, 'runtime': runtime, 'nginx': files, 'bundles': bundles}

    def add_rule(self, rule):
        self.command(['ufw'] + rule['args'])

    def delete_rule(self, rule):
        self.command(['ufw', '--force', 'delete'] + rule['args'])

    def restore_rule(self, rule, before):
        key = digest(rule)
        original = before['runtime']
        matches = [i for i, r in enumerate(original) if r['key'] == key]
        if len(matches) != 1:
            raise SyncError('missing original runtime position for recovery')
        position = matches[0]
        current = parse_ufw_numbered(self.command(['ufw', 'status', 'numbered']))
        # Insert before the nearest surviving original successor of this IP
        # family, rather than guessing indices from collapsed show-added lines.
        # New transaction rules may shift global v6 indices; the successor's
        # CURRENT numbered index accounts for that without touching its rule.
        for anchor in original[position + 1:]:
            if anchor['family'] != original[position]['family']:
                continue
            successor = [r for r in current if r['key'] == anchor['key']]
            if successor:
                self.command(['ufw', 'insert', str(successor[0]['number'])] + rule['args'])
                return
        self.add_rule(rule)

    def write_nginx(self, config, files):
        for name, content in files.items():
            if name not in ('cloudfront-geo.conf', 'cloudfront-realip.conf'):
                raise SyncError('invalid nginx destination')
            path = Path(config['nginx']['shared_dir']) / name
            check_path(path)
            atomic_text(path, content, 0o644)

    def check_reload_nginx(self):
        self.command(['nginx', '-t'])
        self.command(['systemctl', 'reload', 'nginx.service'])
        self.command(['systemctl', 'is-active', '--quiet', 'nginx.service'])

    def stop_timer(self):
        self.command(['systemctl', 'disable', '--now', 'cloudfront-sync.timer'])


def nginx_tokens(text):
    """Tokenize just enough nginx syntax to inspect includes without logging it."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars='{};')
    lexer.whitespace_split = True
    lexer.commenters = '#'
    tokens = []
    try:
        for token in lexer:
            if token and set(token) <= set('{};'):
                tokens.extend(token)
            else:
                tokens.append(token)
    except ValueError as exc:
        raise SyncError('invalid nginx bundle syntax') from exc
    return tokens


def chunks(tokens):
    result, current = [], []
    for token in tokens:
        if token in ('{', '}'):
            current = []
        else:
            current.append(token)
            if token == ';':
                result.append(current)
                current = []
    return result


def nginx_geo_blocks(tokens):
    result = []
    for i in range(len(tokens) - 3):
        if tokens[i] == 'geo' and tokens[i + 3] == '{':
            depth, j = 1, i + 4
            while j < len(tokens) and depth:
                depth += (tokens[j] == '{') - (tokens[j] == '}')
                j += 1
            if depth:
                raise SyncError('unbalanced nginx geo block')
            result.append((tokens[i + 1], tokens[i + 4:j - 1]))
    return result


class Engine:
    def __init__(self, config, state_dir=None, host=None, clock=time.time):
        self.config = copy.deepcopy(validate_config(config))
        self.root = Path(state_dir) if state_dir is not None else STATE_DIR
        self.private = self.root / 'private'
        self.host = host or Host()
        self.clock = clock
        self.root.mkdir(mode=0o755, parents=True, exist_ok=True)
        self.private.mkdir(mode=0o700, exist_ok=True)
        if self.root.is_symlink() or self.private.is_symlink():
            raise SyncError('state directory symlink refused')
        for path in (self.private / 'state.json', self.private / 'pending.json', self.private / 'journal.json'):
            if path.is_symlink():
                raise SyncError('state file symlink refused')

    def state(self):
        path = self.private / 'state.json'
        if not path.exists():
            return None
        state = json_read(path)
        if not isinstance(state, dict) or state.get('version') != 1 or state.get('initialized') is not True or not isinstance(state.get('owned_rules'), list) or not isinstance(state.get('snapshot'), dict):
            raise SyncError('invalid persisted state')
        if sorted_ranges(state.get('ranges')) != state['ranges']:
            raise SyncError('noncanonical state ranges')
        if not re.fullmatch('[0-9]{1,20}', state.get('aws_sync_token', '')):
            raise SyncError('invalid persisted AWS token')
        return state

    def status(self):
        path = self.root / 'status.json'
        return json_read(path) if path.exists() else {}

    def publish(self, *, approval=False, recovery=False, error=None):
        state = self.state()
        status = {'version': 1, 'initialized': bool(state), 'last_success': state.get('last_success') if state else None,
                  'approval_required': approval, 'recovery_failed': recovery, 'error_code': error, 'updated_at': int(self.clock())}
        atomic_json(self.root / 'status.json', status, 0o644)

    def preflight(self):
        # Recovery reads only securely owned files and transaction evidence;
        # a crash may have left nginx syntactically invalid, so recover before
        # requiring a healthy live daemon configuration.
        self.recover()
        self.host.preflight(self.config)
        state = self.state()
        snapshot = self.host.snapshot(self.config)
        if self.config['nginx']['enabled']:
            parse_nginx_ranges(snapshot['nginx'])
        if state and (state['config_hash'] != digest(self.config) or digest(snapshot) != digest(state['snapshot'])):
            raise SyncError('config or live state differs from confirmed baseline')
        if not state and any(r['comment'] == MARKER for r in snapshot['rules']):
            raise SyncError('owned rules exist without confirmed state; import required')
        return snapshot

    def fetch(self):
        candidate = parse_aws(self.host.fetch())
        state = self.state()
        if state and int(candidate['aws_sync_token']) < int(state['aws_sync_token']):
            raise SyncError('AWS publication is older than confirmed state')
        return candidate

    def _pending(self, operation, candidate, snapshot, extra=None):
        plan = {'version': 1, 'operation': operation, 'host_address': self.config['host_address'], 'config_hash': digest(self.config),
                'baseline_hash': digest(snapshot), 'candidate': candidate, 'candidate_hash': digest(candidate),
                'created_at': int(self.clock()), 'expires_at': int(self.clock()) + TOKEN_TTL,
                'approve_token': secrets.token_urlsafe(32)}
        if extra:
            plan.update(extra)
        atomic_json(self.private / 'pending.json', plan)
        state = self.state()
        old = state['ranges'] if state else []
        public = {'operation': operation, 'add': [r for r in candidate['ranges'] if r not in old],
                  'delete': [r for r in old if r not in candidate['ranges']], 'aws_sync_token': candidate['aws_sync_token'],
                  'approval_required': operation == 'import' or not state or state.get('last_success') is None or not within_limits(old, candidate['ranges'], self.config['limits']),
                  'approve_token': plan['approve_token'], 'expires_at': plan['expires_at']}
        return public

    def plan(self):
        snapshot = self.preflight()
        candidate = self.fetch()
        state = self.state()
        needs_import = not state and any(r['port'] in self.config['firewall']['ports'] for r in snapshot['rules'])
        if not needs_import:
            self._check_policy(snapshot, self._desired_rules(candidate['ranges']))
        result = self._pending('apply', candidate, snapshot)
        # Never claim existing non-owned web rules through an initial apply.
        result['import_required'] = needs_import
        self.publish(approval=result['approval_required'])
        return result

    def _approved(self, token, operation):
        path = self.private / 'pending.json'
        if not path.exists():
            raise SyncError('no pending approval')
        plan = json_read(path)
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token) or not secrets.compare_digest(token, plan.get('approve_token', '')):
            raise SyncError('approval token does not match pending plan')
        if plan.get('operation') != operation or int(self.clock()) >= plan.get('expires_at', 0) or int(self.clock()) < plan.get('created_at', 0):
            raise SyncError('approval token expired or wrong operation')
        snapshot = self.preflight()
        if plan['host_address'] != self.config['host_address'] or plan['config_hash'] != digest(self.config) or plan['baseline_hash'] != digest(snapshot):
            raise SyncError('approval is not bound to current host/config/state')
        if digest(plan['candidate']) != plan['candidate_hash']:
            raise SyncError('pending candidate was modified')
        if operation == 'apply' and self.fetch() != plan['candidate']:
            raise SyncError('AWS publication changed; obtain a new plan')
        return plan, snapshot

    def apply(self, token):
        plan, snapshot = self._approved(token, 'apply')
        if not self.state() and any(r['port'] in self.config['firewall']['ports'] for r in snapshot['rules']):
            raise SyncError('legacy web rules require explicit import')
        # Consume before the first side effect; failures require a new approval.
        unlink_durable(self.private / 'pending.json')
        return self._transaction(plan['candidate'], snapshot)

    def sync(self):
        snapshot = self.preflight()
        candidate = self.fetch()
        state = self.state()
        if not state or state.get('last_success') is None or not within_limits(state['ranges'], candidate['ranges'], self.config['limits']):
            self._pending('apply', candidate, snapshot)
            self.publish(approval=True, error='approval_required')
            raise ApprovalRequired('change requires approval; inspect plan')
        return self._transaction(candidate, snapshot)

    def _desired_rules(self, ranges):
        state = self.state()
        old = state['owned_rules'] if state else []
        desired = []
        if self.config['firewall']['backend'] == 'ufw':
            for cidr in ranges:
                for port in self.config['firewall']['ports']:
                    matches = [r for r in old if r['source'] == cidr and r['port'] == port]
                    desired.append(matches[0] if matches else make_rule(cidr, port))
        return desired

    def _check_policy(self, before, target_rules, importing=False):
        """Prove appended rules are effective and cannot claim an admin tuple.

        UFW is first-match and adding the same tuple with a different comment
        updates the existing rule. Neither case can be inferred from command
        success, so reject them before touching nginx or UFW.
        """
        state = self.state()
        old_owned = state['owned_rules'] if state else (target_rules if importing else [])
        old_keys = {digest(rule) for rule in old_owned}
        for target in target_rules:
            key = digest(target)
            family = ipaddress.ip_network(target['source']).version
            existing = [r for r in before['runtime'] if r['key'] == key]
            position = existing[0]['number'] if existing else math.inf
            for entry in before['runtime']:
                if entry['family'] != family:
                    continue
                policy = entry.get('policy')
                if not policy_may_match(policy, target['source'], target['port']):
                    continue
                if entry['number'] < position and policy['action'] != 'allow':
                    raise SyncError('unmanaged policy may shadow a CloudFront allow; operator review required')
                if target not in old_owned and entry['key'] not in old_keys and policy['action'] == 'allow' and policy['source'] in (None, target['source']):
                    raise SyncError('new CloudFront tuple collides with an unowned allow')
            if target not in old_owned and any(rule not in old_owned and rule_identity(rule) == rule_identity(target) for rule in before['rules']):
                raise SyncError('new CloudFront tuple already belongs to another operator')

    def _transaction(self, candidate, before):
        self.host.check_target(self.config)
        if self.host.snapshot(self.config) != before:
            raise SyncError('live state changed while obtaining candidate; no changes applied')
        old_state = self.state()
        old_rules = old_state['owned_rules'] if old_state else []
        target_rules = self._desired_rules(candidate['ranges'])
        self._check_policy(before, target_rules)
        files = render_nginx(candidate['ranges']) if self.config['nginx']['enabled'] else {}
        journal = {'version': 1, 'config_hash': digest(self.config), 'before': before,
                   'old_state': old_state, 'target_rules': target_rules, 'target_nginx': files, 'new_state': None,
                   'addition_attempts': [], 'deletion_attempts': []}
        if files != before['nginx'] or target_rules != old_rules:
            # Keep the most recent pre-change evidence after commit, while the
            # active journal is removed only when that transaction is durable.
            # No-op heartbeats must not replace the useful change backup.
            atomic_json(self.private / 'backup.json', {'created_at': int(self.clock()), **journal})
        atomic_json(self.private / 'journal.json', journal)
        try:
            if files != before['nginx']:
                self.host.write_nginx(self.config, files)
                self.host.check_reload_nginx()
            for rule in target_rules:
                if rule not in old_rules:
                    journal['addition_attempts'].append(rule)
                    atomic_json(self.private / 'journal.json', journal)
                    self.host.add_rule(rule)
            for rule in old_rules:
                if rule not in target_rules:
                    journal['deletion_attempts'].append(rule)
                    atomic_json(self.private / 'journal.json', journal)
                    self.host.delete_rule(rule)
            after = self.host.snapshot(self.config)
            self._verify_after(before, after, old_rules, target_rules, files)
            state = {'version': 1, 'initialized': True, 'ranges': candidate['ranges'],
                     'aws_sync_token': candidate['aws_sync_token'], 'config_hash': digest(self.config),
                     'owned_rules': target_rules, 'snapshot': after, 'last_success': int(self.clock())}
            journal['new_state'] = state
            atomic_json(self.private / 'journal.json', journal)
            atomic_json(self.private / 'state.json', state)
            unlink_durable(self.private / 'journal.json')
        except Exception as exc:
            try:
                self._rollback(journal)
            except Exception as rollback_exc:
                self._recovery_failed()
                raise SyncError('transaction and recovery failed; timer stopped') from rollback_exc
            self.publish(error='transaction_failed')
            raise SyncError('transaction failed and was rolled back') from exc
        # The transaction is committed once its durable journal is removed.
        # A later monitoring-output failure must not roll back committed policy.
        self.publish()
        return {'changed': before != after, 'initialized': True, 'last_success': state['last_success']}

    def _verify_after(self, before, after, old_owned, target_owned, files):
        def remaining(rules, owned):
            result = list(rules)
            for rule in owned:
                if rule not in result:
                    raise SyncError('expected owned UFW rule missing')
                result.remove(rule)
            return result
        if remaining(before['rules'], old_owned) != remaining(after['rules'], target_owned):
            raise SyncError('unmanaged UFW rules changed during transaction')
        old_keys, new_keys = {digest(r) for r in old_owned}, {digest(r) for r in target_owned}
        if [r['key'] for r in before['runtime'] if r['key'] not in old_keys] != [r['key'] for r in after['runtime'] if r['key'] not in new_keys]:
            raise SyncError('unmanaged live UFW order changed during transaction')
        if after['nginx'] != files or after['bundles'] != before['bundles']:
            raise SyncError('nginx effective file state differs after update')
        # Same rule cannot be owned twice, even if ufw duplicated it externally.
        if any(after['rules'].count(rule) != 1 for rule in target_owned):
            raise SyncError('duplicate owned UFW rule')

    def _rollback(self, journal):
        if journal['config_hash'] != digest(self.config):
            raise SyncError('recovery config differs from journal')
        current = self.host.snapshot(self.config)
        before = journal['before']
        if current['bundles'] != before['bundles']:
            raise SyncError('bundle changed; refusing destructive recovery')
        for name, content in current['nginx'].items():
            if content not in (before['nginx'][name], journal['target_nginx'][name]):
                raise SyncError('shared nginx file externally changed during recovery')
        old_owned = journal['old_state']['owned_rules'] if journal['old_state'] else []
        allowed = old_owned + journal['target_rules']
        if any(r['comment'] == MARKER and r not in allowed for r in current['rules']):
            raise SyncError('unexpected owned UFW rule during recovery')
        # A missing unchanged rule is an external revocation, not a script
        # deletion. Never reinstate it merely to make the old snapshot match.
        # Durable per-operation intent also prevents undoing steps never run.
        deletion_attempts = journal.get('deletion_attempts', [])
        addition_attempts = journal.get('addition_attempts', [])
        if any(rule not in current['rules'] and (rule in journal['target_rules'] or rule not in deletion_attempts) for rule in old_owned):
            raise SyncError('owned rule externally revoked; refusing to reinstate it')
        # Restore old permissions before removing this transaction's additions.
        for rule in before['rules']:
            if rule in old_owned and rule not in current['rules'] and rule in deletion_attempts:
                self.host.restore_rule(rule, before)
        for rule in journal['target_rules']:
            if rule not in old_owned and rule in current['rules'] and rule in addition_attempts:
                # Never delete a permission that existed outside our ownership
                # before the transaction, even if ufw replaced its comment.
                if any(old not in old_owned and rule_identity(old) == rule_identity(rule) for old in before['rules']):
                    raise SyncError('unowned rule collision requires operator recovery')
                self.host.delete_rule(rule)
        if current['nginx'] != before['nginx']:
            self.host.write_nginx(self.config, before['nginx'])
            self.host.check_reload_nginx()
        after = self.host.snapshot(self.config)
        if after != before:
            # Leave journal for an operator; never erase unrelated concurrent edits.
            raise SyncError('restored state cannot be confirmed')
        state_path = self.private / 'state.json'
        if journal['old_state']:
            atomic_json(state_path, journal['old_state'])
        elif state_path.exists():
            unlink_durable(state_path)
        unlink_durable(self.private / 'journal.json')

    def _recovery_failed(self):
        try:
            self.host.stop_timer()
        finally:
            self.publish(recovery=True, error='recovery_failed')

    def recover(self):
        path = self.private / 'journal.json'
        if not path.exists():
            return
        # A transplanted journal or a changed SSH port must never authorize
        # recovery on the wrong target. nginx health is deliberately checked
        # later, because recoverable partial include writes can break it.
        self.host.check_target(self.config)
        try:
            journal = json_read(path)
            if not isinstance(journal, dict) or journal.get('version') != 1 or journal.get('config_hash') != digest(self.config):
                raise SyncError('invalid recovery journal')
            new_state = journal.get('new_state')
            if new_state and self.state() == new_state and self.host.snapshot(self.config) == new_state['snapshot']:
                unlink_durable(path)
                self.publish()
                return
            self._rollback(journal)
        except Exception as exc:
            self._recovery_failed()
            raise SyncError('recovery incomplete; timer stopped') from exc

    def import_plan(self, legacy_path):
        if self.state():
            raise SyncError('import requires an uninitialized host')
        snapshot = self.preflight()
        legacy = json_read(legacy_path)
        raw = legacy.get('ranges') if isinstance(legacy, dict) else None
        if isinstance(raw, dict) and set(raw) in ({'ipv4', 'ipv6'}, {'v4', 'v6'}):
            raw = raw.get('ipv4', raw.get('v4')) + raw.get('ipv6', raw.get('v6'))
        ranges = sorted_ranges(raw)
        if self.config['nginx']['enabled'] and parse_nginx_ranges(snapshot['nginx']) != ranges:
            raise SyncError('legacy ranges do not match both shared nginx files')
        owned = []
        if self.config['firewall']['backend'] == 'ufw':
            for cidr in ranges:
                for port in self.config['firewall']['ports']:
                    matching = [r for r in snapshot['rules'] if r['source'] == cidr and r['port'] == port]
                    if len(matching) != 1:
                        raise SyncError('legacy UFW rule missing or ambiguous')
                    owned.append(matching[0])
        self._check_policy(snapshot, owned, importing=True)
        # Fetch establishes publication freshness, not which rules we import.
        candidate = self.fetch()
        baseline = {'aws_sync_token': candidate['aws_sync_token'], 'ranges': ranges}
        return self._pending('import', baseline, snapshot,
                             {'legacy_path': str(legacy_path), 'legacy_hash': digest(legacy), 'owned_rules': owned})

    def import_state(self, token):
        if self.state():
            raise SyncError('import requires an uninitialized host')
        plan, snapshot = self._approved(token, 'import')
        if digest(json_read(plan['legacy_path'])) != plan['legacy_hash']:
            raise SyncError('legacy evidence changed')
        state = {'version': 1, 'initialized': True, 'ranges': plan['candidate']['ranges'],
                 'aws_sync_token': plan['candidate']['aws_sync_token'], 'config_hash': digest(self.config),
                 'owned_rules': plan['owned_rules'], 'snapshot': snapshot, 'last_success': None}
        # Import is ownership transfer, not successful AWS synchronization.
        atomic_json(self.private / 'state.json', state)
        unlink_durable(self.private / 'pending.json')
        self.publish()
        return {'imported': True, 'initialized': True, 'last_success': None}


@contextlib.contextmanager
def exclusive_lock(inherited=None):
    # Ubuntu uses a root-owned sticky /run/lock (1777). Its sticky bit
    # protects the root-owned lock from replacement by other users. Other
    # writable parents remain forbidden.
    parent = LOCK.parent.lstat()
    if LOCK.parent == Path('/run/lock') and parent.st_uid == 0 and stat.S_ISDIR(parent.st_mode) and parent.st_mode & stat.S_ISVTX:
        check_path(LOCK.parent.parent, directory=True)
    else:
        check_path(LOCK.parent, directory=True)
    if inherited is None:
        fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    else:
        fd = inherited
    try:
        st = os.fstat(fd)
        lst = LOCK.lstat()
        if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(lst.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or (st.st_dev, st.st_ino) != (lst.st_dev, lst.st_ino):
            raise SyncError('invalid lock descriptor')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SyncError('another sync or deployment holds the lock') from exc
        yield
    finally:
        if inherited is None:
            os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(CONFIG))
    parser.add_argument('--lock-fd', type=int)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['preflight', 'plan', 'sync']:
        sub.add_parser(name)
    for name in ['apply', 'import']:
        p = sub.add_parser(name)
        p.add_argument('--approve', required=True)
    p = sub.add_parser('import-plan')
    p.add_argument('--legacy-state', required=True)
    args = parser.parse_args(argv)
    engine = None
    try:
        if os.geteuid() != 0:
            raise SyncError('root is required')
        if Path(args.config) != CONFIG:
            raise SyncError('only the fixed config path is permitted')
        check_path(CONFIG)
        config = validate_config(json_read(CONFIG, secure=False))
        with exclusive_lock(args.lock_fd):
            STATE_DIR.mkdir(mode=0o755, exist_ok=True)
            check_path(STATE_DIR, directory=True)
            private = STATE_DIR / 'private'
            private.mkdir(mode=0o700, exist_ok=True)
            check_path(private, directory=True)
            if private.stat().st_mode & 0o077:
                raise SyncError('state directory must be private')
            for file in private.iterdir():
                check_path(file, writable=True)
            engine = Engine(config)
            if args.command == 'preflight':
                engine.preflight()
                result = {'preflight': 'ok', 'initialized': bool(engine.state())}
            elif args.command == 'plan':
                result = engine.plan()
            elif args.command == 'sync':
                result = engine.sync()
            elif args.command == 'apply':
                result = engine.apply(args.approve)
            elif args.command == 'import-plan':
                legacy = Path(args.legacy_state)
                if not legacy.is_absolute():
                    raise SyncError('legacy evidence requires absolute path')
                check_path(legacy)
                result = engine.import_plan(legacy)
            else:
                result = engine.import_state(args.approve)
            print(canonical(result))
        return 0
    except ApprovalRequired:
        print(canonical({'error': 'approval_required'}))
        return 2
    except Exception:
        # Exception chains can include headers, configuration, and subprocess
        # output. Only a fixed code reaches stdout/stderr or service logs.
        if engine:
            try:
                status = engine.status()
                engine.publish(approval=status.get('approval_required', False), recovery=status.get('recovery_failed', False), error=status.get('error_code') or 'sync_failed')
            except Exception:
                pass
        print(canonical({'error': 'sync_failed'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
