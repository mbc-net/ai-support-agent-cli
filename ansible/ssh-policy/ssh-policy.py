#!/usr/bin/python3
"""Root-only transactional SSH policy helper. Invoked only by the dedicated agent runner.

State and snapshots are fsync'ed before changing SSH/UFW. A persistent boot service
and a per-attempt systemd timer recover without either the API or the agent.
All status/apply/confirm/recover operations share one flock. No shell evaluation.
"""
import base64
import fcntl
import glob
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time

ROOT = Path('/var/lib/ai-support-agent/ssh-policy')
HELPER = '/usr/local/lib/ai-support-agent/ssh-policy.py'
SSH_FILE = Path('/etc/ssh/sshd_config.d/00-ai-support-agent-policy.conf')
UFW_FILES = [Path('/etc/ufw/user.rules'), Path('/etc/ufw/user6.rules')]
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


RUN_DEADLINE = None
APPLY_BUDGET_SECONDS = 180
RECOVERY_BUDGET_SECONDS = 120


def run(*args):
    remaining = 45 if RUN_DEADLINE is None else min(45, RUN_DEADLINE - time.monotonic())
    if remaining <= 0:
        raise TimeoutError('SSH policy operation budget exceeded')
    # UFW spawns iptables children. Kill its whole process group on timeout so
    # no orphan can mutate rules after rollback starts.
    process = subprocess.Popen(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=remaining)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate(timeout=5)
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr)
    return stdout


def atomic(path, data, mode=0o600):
    path = Path(path)
    temp = path.with_name(path.name + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data if isinstance(data, bytes) else data.encode())
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_unlink(path):
    path = Path(path)
    path.unlink(missing_ok=True)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_json(path, value):
    atomic(path, json.dumps(value, sort_keys=True))


def load_json(path):
    return json.loads(path.read_text()) if path.exists() else None


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def uptime():
    return float(Path('/proc/uptime').read_text().split()[0])


def machine_id():
    return Path('/etc/machine-id').read_text().strip()


def validate_sources(cidrs, release, manage=True):
    if not isinstance(cidrs, list) or len(cidrs) > 512 or any(not isinstance(c, str) for c in cidrs):
        raise ValueError('Invalid or excessive CIDR list')
    if not manage or release:
        if cidrs:
            raise ValueError('Unmanaged/release request must not contain CIDRs')
        return []
    if not cidrs:
        raise ValueError('Empty source set cannot remove restrictions')
    networks = [ipaddress.ip_network(c, strict=True) for c in cidrs]
    if any(n.prefixlen == 0 or (n.version == 6 and n.network_address.ipv4_mapped) for n in networks):
        raise ValueError('Universal/mapped network is not a source restriction')
    for version in [4, 6]:
        if any(n.prefixlen == 0 for n in ipaddress.collapse_addresses(n for n in networks if n.version == version)):
            raise ValueError('Combined sources must not allow the entire address family')
    return sorted(set(str(n) for n in networks))


def remove_ssh_rules(raw, port):
    """Only accept unambiguous UFW single-port TCP rules; preserve other tuples byte-for-byte."""
    chunks = re.split(r'(?=^### tuple ### )', raw, flags=re.M)
    output, removed = [], []
    for chunk in chunks:
        ssh_lines = []
        for line in chunk.splitlines():
            if not re.match(r'^-A ufw6?-user-input ', line):
                continue
            words = shlex.split(line)
            # UDP and ICMP cannot open TCP SSH, and are unrelated.
            if '-p' in words and words[words.index('-p') + 1] in ('udp', 'icmp', 'ipv6-icmp'):
                continue
            if '--dport' in words:
                destination = words[words.index('--dport') + 1]
                if destination.isdecimal() and int(destination) != port:
                    continue
            else:
                raise ValueError('Uninterpretable input rule: ' + line)
            allowed = {'-A','-p','--dport','-s','-d','-j'}
            options = words[::2]
            if not all(option in allowed for option in options) or len(words) % 2:
                raise ValueError('Complex SSH rule requires manual review: ' + line)
            fields = dict(zip(words[::2], words[1::2]))
            if fields.get('-p') != 'tcp' or fields.get('--dport') != str(port) or fields.get('-j') != 'ACCEPT':
                raise ValueError('Conflicting SSH rule requires manual review: ' + line)
            for address in ('-s', '-d'):
                if address in fields:
                    ipaddress.ip_network(fields[address], strict=False)
            if '-d' in fields and ipaddress.ip_network(fields['-d'], strict=False).prefixlen != 0:
                raise ValueError('Destination-specific SSH rule requires manual review')
            ssh_lines.append(line)
        if ssh_lines:
            if not chunk.startswith('### tuple ### ') or len(ssh_lines) != 1:
                raise ValueError('SSH rule has no unambiguous UFW tuple')
            # Preserve footer and unrelated chains after the last tuple.
            lines = chunk.splitlines(keepends=True)
            index = next(i for i, line in enumerate(lines) if line.rstrip('\n') == ssh_lines[0])
            if any(re.match(r'^-A ufw6?-user-input ', line) for line in lines[index + 1:]):
                raise ValueError('Mixed tuple rules require manual review')
            output.append(''.join(lines[index + 1:]))
            removed.append(chunk[:sum(len(x) for x in lines[:index + 1])].rstrip())
        else:
            output.append(chunk)
    return ''.join(output), removed


def connection_fields(connection):
    fields = connection.split()
    if len(fields) != 4:
        raise ValueError('Missing SSH connection evidence')
    ipaddress.ip_address(fields[0]); ipaddress.ip_address(fields[2])
    if not all(s.isdecimal() and 0 < int(s) < 65536 for s in (fields[1], fields[3])):
        raise ValueError('Invalid SSH connection ports')
    return fields


def validate_confirmation(state, request, connection, now, current_boot):
    if state['status'] != 'pending' or now >= state['deadline'] or state['bootId'] != current_boot:
        raise ValueError('Attempt expired, settled, or crossed a reboot')
    if 'expiresUptime' in state and uptime() >= state['expiresUptime']:
        raise ValueError('Monotonic confirmation deadline expired')
    for key in ('attemptId', 'policyVersion', 'definitionVersion', 'machineId'):
        if request.get(key) != state[key]:
            raise ValueError('Confirmation does not match ' + key)
    if not hmac.compare_digest(state['nonceHash'], hashlib.sha256(request.get('nonce', '').encode()).hexdigest()):
        raise ValueError('Confirmation nonce mismatch')
    source, _, _, port = connection_fields(connection)
    if int(port) != state['port']:
        raise ValueError('SSH target port changed')
    if state.get('manageSources', True) and not state['release'] and not any(ipaddress.ip_address(source) in ipaddress.ip_network(n) for n in state['cidrs']):
        raise ValueError('Fresh SSH source is outside the requested policy')
    return source


def effective_ssh(connection, username):
    source, _, local, port = connection_fields(connection)
    output = run('/usr/sbin/sshd', '-T', '-C', f'user={username},host={source},addr={source},laddr={local},lport={port}')
    settings = {}
    for line in output.splitlines():
        key, _, value = line.partition(' ')
        settings.setdefault(key, []).append(value)
    if settings.get('pubkeyauthentication') != ['yes'] or settings.get('port') != [port]:
        raise ValueError('SSH effective public-key authentication/port is unsupported')
    return settings


def canonical_rule(line):
    words = shlex.split(line)
    pairs, index = [], 2
    while index < len(words):
        negate = words[index] == '!'
        if negate:
            index += 1
        if index + 1 >= len(words):
            raise ValueError('Uninterpretable live firewall rule')
        option, value = words[index:index + 2]
        index += 2
        if option == '-m' and value in ('tcp','udp','icmp','icmp6'):
            continue  # iptables -S prints implicit protocol match modules.
        if option in ('-s','-d'):
            value = str(ipaddress.ip_network(value, strict=False))
        if option == '-p' and value == 'icmpv6':
            value = 'ipv6-icmp'
        if option == '--limit':
            value = value.replace('/minute','/min').replace('/second','/sec').replace('/hour','/hour').replace('/day','/day')
        if option == '--ctstate':
            value = ','.join(sorted(value.split(',')))
        if option in ('--icmp-type','--icmpv6-type'):
            names = {'destination-unreachable':'3','time-exceeded':'11','parameter-problem':'12','echo-request':'8'} if option == '--icmp-type' else {'destination-unreachable':'1','packet-too-big':'2','time-exceeded':'3','parameter-problem':'4','echo-request':'128','echo-reply':'129','router-solicitation':'133','router-advertisement':'134','neighbour-solicitation':'135','neighbour-advertisement':'136','neighbor-solicitation':'135','neighbor-advertisement':'136'}
            value = names.get(value, value)
        pairs.append(('!' + option if negate else option, value))
    if any(key == '--limit' for key, _ in pairs) and not any(key == '--limit-burst' for key, _ in pairs):
        pairs.append(('--limit-burst','5'))
    if ('-j','REJECT') in pairs and not any(key == '--reject-with' for key, _ in pairs):
        pairs.append(('--reject-with','icmp6-port-unreachable' if words[1].startswith('ufw6-') else 'icmp-port-unreachable'))
    return words[1], tuple(sorted(pairs))


def verify_live_rules(binary, files):
    # Match every persisted UFW chain, not just INPUT's jumps: runtime-only
    # ACCEPT rules in before/user/after chains must not disappear unnoticed.
    expected = {}
    for path in files:
        for line in path.read_text().splitlines():
            if line.startswith('*') and line != '*filter':
                raise ValueError('Custom UFW tables require manual review')
            if line.startswith('-A '):
                chain, rule = canonical_rule(line)
                expected.setdefault(chain, []).append(rule)
    prefix = 'ufw6' if binary == 'ip6tables' else 'ufw'
    if expected.get(prefix + '-logging-deny'):
        chain, rule = canonical_rule(f'-A {prefix}-logging-deny -m conntrack --ctstate INVALID -m limit --limit 3/min --limit-burst 10 -j RETURN')
        expected[chain].insert(0, rule)
    for direction in ('input','output','forward'):
        chain, rule = canonical_rule(f'-A {prefix}-before-{direction} -j {prefix}-user-{direction}')
        expected.setdefault(chain, []).append(rule)
        policy = 'ACCEPT' if direction == 'output' else 'DROP'
        chain, rule = canonical_rule(f'-A {prefix}-skip-to-policy-{direction} -j {policy}')
        expected.setdefault(chain, []).append(rule)
    for protocol in ('tcp','udp'):
        chain, rule = canonical_rule(f'-A {prefix}-track-output -p {protocol} -m conntrack --ctstate NEW -j ACCEPT')
        expected.setdefault(chain, []).append(rule)
    actual = {}
    policies = {}
    for line in run(binary, '-S').splitlines():
        if line.startswith('-P '):
            _, chain, target = line.split()
            policies[chain] = target
        if line.startswith('-A '):
            chain, rule = canonical_rule(line)
            if chain.startswith(prefix + '-'):
                actual.setdefault(chain, []).append(rule)
    if policies != {'INPUT':'DROP','OUTPUT':'ACCEPT','FORWARD':'DROP'}:
        raise ValueError('Live firewall default policies differ from supported persisted defaults')
    if actual != expected:
        differing = sorted(chain for chain in set(actual) | set(expected) if actual.get(chain) != expected.get(chain))
        raise ValueError('Live UFW rules differ from persisted configuration: ' + ', '.join(differing))


def require_unconditional_ssh_auth(config=Path('/etc/ssh/sshd_config'), seen=None):
    # sshd -T for the agent's -C tuple alone cannot prove key-only auth for
    # other users/source addresses. Fail closed on ANY active Match (including
    # included files) until all-context auth rewriting is explicitly supported.
    seen = set() if seen is None else seen
    resolved = config.resolve()
    if resolved in seen or len(seen) >= 128:
        raise ValueError('Recursive/excessive SSH includes are unsupported')
    seen.add(resolved)
    for line in config.read_text().splitlines():
        parsed = re.match(r'^\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+|$)(.*)$', line)
        if not parsed:
            if line.strip() and not line.lstrip().startswith('#'):
                raise ValueError('Uninterpretable SSH configuration directive')
            continue
        directive = parsed.group(1).lower()
        words = [directive] + shlex.split(parsed.group(2), comments=True)
        if directive == 'match':
            raise ValueError('Key-only management requires unconditional SSH configuration; active Match blocks need manual review')
        if directive == 'include':
            for pattern in words[1:]:
                pattern = pattern if os.path.isabs(pattern) else '/etc/ssh/' + pattern
                for include in sorted(glob.glob(pattern)):
                    require_unconditional_ssh_auth(Path(include), seen)


def require_standard_ssh_service(proc=Path('/proc'), defaults=Path('/etc/default/ssh')):
    # sshd -T without the daemon's command-line -o/-f options is not its
    # effective configuration. Accept only the known distro launch path.
    lines = run('systemctl','show','ssh.service','--property=ExecStart','--property=ExecReload','--property=DropInPaths','--property=MainPID','--property=EnvironmentFiles').splitlines()
    properties = dict(line.partition('=')[::2] for line in lines if '=' in line)
    if properties.get('DropInPaths','').strip():
        raise ValueError('Custom SSH service drop-ins require manual review')
    start_text = '\n'.join(line.partition('=')[2] for line in lines if line.startswith('ExecStart='))
    starts = re.findall(r'argv\[\]=(.*?)\s*;', start_text)
    reload_text = '\n'.join(line.partition('=')[2] for line in lines if line.startswith('ExecReload='))
    reloads = [value.strip() for value in re.findall(r'argv\[\]=(.*?)\s*;', reload_text)]
    reload_paths = re.findall(r'path=(.*?)\s*;', reload_text)
    if reloads not in (['/usr/sbin/sshd -t','/bin/kill -HUP $MAINPID'], ['/usr/sbin/sshd -t','/usr/bin/kill -HUP $MAINPID']) or reload_paths not in (['/usr/sbin/sshd','/bin/kill'], ['/usr/sbin/sshd','/usr/bin/kill']):
        raise ValueError('Custom SSH ExecReload cannot guarantee the effective authentication configuration')
    if len(starts) != 1 or starts[0].strip() not in ('/usr/sbin/sshd -D', '/usr/sbin/sshd -D $SSHD_OPTS'):
        raise ValueError('Custom SSH daemon command-line options require manual review')
    if not re.search(r'path=/usr/sbin/sshd\s*;', properties.get('ExecStart','')):
        raise ValueError('Custom SSH daemon executable is unsupported')
    environment_files = properties.get('EnvironmentFiles','')
    if environment_files not in ('', '/etc/default/ssh (ignore_errors=yes)'):
        raise ValueError('Custom SSH service environment files are unsupported')
    if environment_files and defaults.exists():
        for line in defaults.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and not re.fullmatch(r"\s*SSHD_OPTS\s*=\s*(?:\"\"|'')?\s*(?:#.*)?", line):
                raise ValueError('Nonempty or custom SSHD_OPTS requires manual review')
    pid = properties.get('MainPID','')
    if not pid.isdecimal() or int(pid) <= 0:
        raise ValueError('Cannot verify the running SSH daemon')
    directory = proc / pid
    if os.readlink(directory / 'exe') != '/usr/sbin/sshd':
        raise ValueError('Running SSH executable is not the supported daemon')
    environment = dict(item.partition(b'=')[::2] for item in (directory / 'environ').read_bytes().split(b'\0') if b'=' in item)
    if environment.get(b'SSHD_OPTS', b'').strip():
        raise ValueError('Running SSH daemon has custom SSHD_OPTS')
    arguments = (directory / 'cmdline').read_bytes().rstrip(b'\0')
    direct = arguments in (b'/usr/sbin/sshd\0-D', b'sshd\0-D')
    title = arguments.decode('utf-8', errors='strict')
    listener = bool(re.fullmatch(r'sshd: /usr/sbin/sshd -D \[listener\](?: [0-9]+ of [0-9]+-[0-9]+ startups)?', title))
    if not direct and not listener:
        raise ValueError('Running SSH daemon arguments cannot be verified')


def supported_ufw_defaults(status):
    # UFW reports routed=disabled when kernel forwarding is off. The live
    # FORWARD chain is still separately required to be DROP for both families.
    return 'Status: active' in status and bool(re.search(r'Default: deny \(incoming\), allow \(outgoing\), (?:deny|disabled) \(routed\)', status))


def preflight(request, connection):
    if 'ID=ubuntu' not in Path('/etc/os-release').read_text().splitlines():
        raise ValueError('SSH policy requires Ubuntu')
    if not Path('/run/systemd/system').is_dir():
        raise ValueError('SSH policy requires systemd')
    if subprocess.run(['systemctl','is-active','--quiet','ssh.socket']).returncode == 0:
        raise ValueError('Socket-activated SSH is not supported')
    run('systemctl', 'is-active', 'ssh.service')
    require_standard_ssh_service()
    if request['keyOnly']:
        require_unconditional_ssh_auth()
    settings = effective_ssh(connection, request['username'])
    cleaned, removed = {}, []
    if request['manageSources']:
        status = run('ufw', 'status', 'verbose')
        if not supported_ufw_defaults(status):
            raise ValueError('UFW requires active default deny incoming/routed and allow outgoing')
        if not re.search(r'^IPV6=yes\s*$', Path('/etc/default/ufw').read_text(), re.M):
            raise ValueError('IPv6 UFW enforcement must be enabled')
        for name in ['before.rules','before6.rules','after.rules','after6.rules']:
            original = Path('/usr/share/ufw/iptables') / name
            if not original.exists() or original.read_bytes() != (Path('/etc/ufw') / name).read_bytes():
                raise ValueError('Custom/unknown UFW base rules require manual review: ' + name)
        for binary in ['iptables','ip6tables']:
            prefix = 'ufw6' if binary == 'ip6tables' else 'ufw'
            input_jumps = {f'-A INPUT -j {prefix}-{suffix}' for suffix in ('before-logging-input','before-input','after-input','after-logging-input','reject-input','track-input')}
            for line in run(binary, '-S', 'INPUT').splitlines():
                if line in ('-P INPUT DROP', '-P INPUT REJECT') or line in input_jumps:
                    continue
                raise ValueError('Non-UFW input rule requires manual review')
        verify_live_rules('iptables', [Path('/etc/ufw') / name for name in ('before.rules','after.rules','user.rules')])
        verify_live_rules('ip6tables', [Path('/etc/ufw') / name for name in ('before6.rules','after6.rules','user6.rules')])
        for path in UFW_FILES:
            cleaned[str(path)], entries = remove_ssh_rules(path.read_text(), request['port'])
            removed.extend(entries)
    return cleaned, removed, settings


def receipt(state):
    return {k: state.get(k) for k in ('attemptId','policyId','policyVersion','definitionVersion','sshHostId','status','deadline','machineId','observedSourceIp','message','removedRules')}


def persist(state):
    save_json(ROOT / 'attempt.json', state)
    save_json(ROOT / 'attempts' / (state['attemptId'] + '.json'), state)


def read_attempt(attempt):
    # attempt.json is canonical. The history projection may lag after a crash.
    current = load_json(ROOT / 'attempt.json')
    if current and current['attemptId'] == attempt:
        return current
    return load_json(ROOT / 'attempts' / (attempt + '.json'))


def repair_terminal(state):
    if state['status'] == 'pending':
        return
    save_json(ROOT / 'attempts' / (state['attemptId'] + '.json'), state)
    if state['status'] == 'succeeded' and state['manageSources']:
        if state['release']:
            durable_unlink(ROOT / 'managed.json')
        else:
            save_json(ROOT / 'managed.json', receipt(state))
    if state['status'] == 'succeeded':
        if state.get('keyOnly') or (ROOT / 'managed.json').exists():
            save_json(ROOT / 'owner.json', receipt(state))
        else:
            durable_unlink(ROOT / 'owner.json')


def snapshot(paths):
    return {str(p): base64.b64encode(p.read_bytes()).decode() if p.exists() else None for p in paths}


def restore(state):
    for name, data in state['snapshot'].items():
        path = Path(name)
        if data is None:
            durable_unlink(path)
        else:
            atomic(path, base64.b64decode(data), 0o600 if path.parent == ROOT else 0o644)
    run('/usr/sbin/sshd', '-t')
    run('systemctl', 'reload', 'ssh.service')
    if state['manageSources']:
        run('ufw', 'reload')


def recover(state, message):
    global RUN_DEADLINE
    if state['status'] != 'pending':
        return receipt(state)
    previous_deadline = RUN_DEADLINE
    RUN_DEADLINE = time.monotonic() + RECOVERY_BUDGET_SECONDS
    try:
        restore(state)
        state['status'] = 'recovered'
        state['message'] = message
    except Exception as error:
        state['status'] = 'attention'
        state['message'] = 'Recovery failed: ' + str(error)
    finally:
        RUN_DEADLINE = previous_deadline
    persist(state)
    return receipt(state)


def arm_recovery(attempt):
    unit = 'ai-support-agent-ssh-policy-recover'
    atomic('/etc/systemd/system/' + unit + '.service', '[Unit]\nDescription=Recover unfinished SSH policy at boot\nAfter=local-fs.target ssh.service ufw.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + HELPER + ' recover-boot\n[Install]\nWantedBy=multi-user.target\n', 0o644)
    timer_unit = 'ai-support-agent-ssh-policy-' + attempt
    atomic('/etc/systemd/system/' + timer_unit + '.service', '[Unit]\nDescription=Recover expired SSH policy\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 ' + HELPER + ' recover ' + attempt + '\n', 0o644)
    atomic('/etc/systemd/system/' + timer_unit + '.timer', '[Unit]\nDescription=SSH policy recovery deadline\n[Timer]\nOnActiveSec=600\nAccuracySec=1s\nUnit=' + timer_unit + '.service\n[Install]\nWantedBy=timers.target\n', 0o644)
    run('systemctl','daemon-reload')
    run('systemctl','enable',unit + '.service')
    run('systemctl','enable','--now',timer_unit + '.timer')


def validate_request(request, inspect_only=False):
    for key in ['attemptId','policyId','sshHostId']:
        if not isinstance(request.get(key), str) or not IDENTIFIER.fullmatch(request[key]):
            raise ValueError('Invalid ' + key)
    for key in ['policyVersion','definitionVersion','port']:
        if type(request.get(key)) is not int or request[key] < 1:
            raise ValueError('Invalid ' + key)
    if request['port'] > 65535 or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', request.get('username','')):
        raise ValueError('Invalid SSH port/user')
    for key in ['manageSources','release','keyOnly']:
        if type(request.get(key)) is not bool:
            raise ValueError('Invalid ' + key)
    if request['release'] and not request['manageSources']:
        raise ValueError('Release requires source management')
    if not re.fullmatch(r'[a-f0-9]{64}', request.get('nonceHash','')):
        raise ValueError('Invalid confirmation proof')
    request['cidrs'] = [] if inspect_only and request.get('cidrs') == [] else validate_sources(request.get('cidrs'), request['release'], request['manageSources'])
    return request


def ensure_owner(request):
    owner = load_json(ROOT / 'owner.json') or load_json(ROOT / 'managed.json')
    if owner and (owner.get('policyId') != request['policyId'] or ('sshHostId' in request and owner.get('sshHostId') != request['sshHostId'])):
        raise ValueError('This server is owned by a different SSH policy; release it through the owning policy first')


def managed_baseline(request):
    marker = load_json(ROOT / 'managed.json')
    if not marker:
        return None
    baseline = read_attempt(marker.get('attemptId', ''))
    if not baseline or baseline['status'] != 'succeeded' or marker.get('policyId') != request['policyId'] or baseline.get('policyId') != request['policyId'] or baseline.get('port') != request['port'] or baseline.get('release') or not isinstance(baseline.get('appliedRules'), list):
        raise ValueError('Managed SSH baseline cannot be verified')
    if 'sshHostId' in request and baseline.get('sshHostId') != request['sshHostId']:
        raise ValueError('Managed SSH host identity changed')
    return baseline


def managed_rules_match(request, removed):
    baseline = managed_baseline(request)
    return bool(baseline and baseline['appliedRules'] == removed)


def apply(request, connection):
    global RUN_DEADLINE
    request = validate_request(request)
    previous = load_json(ROOT / 'attempt.json')
    replay = read_attempt(request['attemptId'])
    if replay:
        for key in ('policyId','policyVersion','definitionVersion','sshHostId','cidrs','manageSources','release','keyOnly'):
            if replay.get(key) != request.get(key):
                raise ValueError('Attempt reused for a different request')
        return receipt(replay)
    if previous and previous.get('policyId') == request['policyId'] and (request['policyVersion'] < previous['policyVersion'] or request['definitionVersion'] < previous['definitionVersion']):
        raise ValueError('A newer SSH policy version has already reached this server')
    if previous and previous['status'] in ('pending','attention'):
        raise ValueError('Previous SSH transaction is pending or needs attention')
    ensure_owner(request)
    cleaned, removed, _ = preflight(request, connection)
    baseline = managed_baseline(request)
    approved_rules = baseline['appliedRules'] if baseline else request.get('expectedRemovedRules')
    if request['manageSources'] and approved_rules != removed:
        raise ValueError('UFW rules changed since the approved preview or last managed apply')
    if request.get('machineId') != machine_id():
        raise ValueError('Target identity changed since preflight')
    paths = [SSH_FILE, ROOT / 'managed.json', ROOT / 'owner.json'] + (UFW_FILES if request['manageSources'] else [])
    state = dict(request, status='pending', deadline=time.time() + 600, expiresUptime=uptime() + 600, bootId=boot_id(), snapshot=snapshot(paths), removedRules=removed)
    # Install the boot service BEFORE durable pending intent. Timer is armed
    # before any mutable firewall/SSH configuration; failure leaves originals.
    arm_recovery(state['attemptId'])
    persist(state)
    RUN_DEADLINE = time.monotonic() + APPLY_BUDGET_SECONDS
    try:
        save_json(ROOT / 'owner.json', receipt(state))
        if request['manageSources']:
            save_json(ROOT / 'managed.json', receipt(state))
        if request['keyOnly']:
            atomic(SSH_FILE, 'PubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthenticationMethods publickey\n', 0o644)
        elif SSH_FILE.exists():
            durable_unlink(SSH_FILE)
        run('/usr/sbin/sshd', '-t')
        settings = effective_ssh(connection, request['username'])
        if request['keyOnly'] and (settings.get('passwordauthentication') != ['no'] or settings.get('kbdinteractiveauthentication') != ['no'] or settings.get('authenticationmethods') != ['publickey']):
            raise ValueError('Effective SSH configuration does not enforce key-only authentication')
        run('systemctl', 'reload', 'ssh.service')
        if request['manageSources']:
            for name, content in cleaned.items():
                atomic(name, content, 0o640)
            run('ufw','reload')
            if request['release']:
                run('ufw','allow',str(request['port']) + '/tcp')
            else:
                for cidr in request['cidrs']:
                    run('ufw','allow','from',cidr,'to','any','port',str(request['port']),'proto','tcp')
            state['appliedRules'] = []
            for path in UFW_FILES:
                state['appliedRules'].extend(remove_ssh_rules(path.read_text(), request['port'])[1])
            persist(state)
        return receipt(state)
    except Exception:
        recover(state, 'Apply failed; restored previous configuration')
        raise
    finally:
        RUN_DEADLINE = None


def main():
    if os.geteuid() != 0:
        raise ValueError('Root required')
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    (ROOT / 'attempts').mkdir(exist_ok=True, mode=0o700)
    with (ROOT / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load_json(ROOT / 'attempt.json')
        if current:
            repair_terminal(current)
        action = sys.argv[1]
        if action in ('recover','recover-boot'):
            state = load_json(ROOT / 'attempt.json')
            if not state or state['status'] != 'pending':
                return {}
            if action == 'recover' and (state['attemptId'] != sys.argv[2]):
                return {}
            return recover(state, 'Deadline expired or server restarted')
        request = json.load(sys.stdin)
        connection = sys.argv[2] if len(sys.argv) > 2 else ''
        if action == 'inspect':
            if current and current['status'] in ('pending', 'attention'):
                raise ValueError('Cannot inspect while an SSH transaction is pending or needs attention')
            global RUN_DEADLINE
            RUN_DEADLINE = time.monotonic() + 120
            request = validate_request(request, inspect_only=True)
            ensure_owner(request)
            _, removed, _ = preflight(request, connection)
            return dict(machineId=machine_id(), removedRules=removed, observedSourceIp=connection_fields(connection)[0], port=request['port'], managedRules=managed_rules_match(request, removed))
        if action == 'apply':
            return apply(request, connection)
        attempt = request.get('attemptId','')
        if not IDENTIFIER.fullmatch(attempt):
            raise ValueError('Invalid attempt ID')
        state = read_attempt(attempt)
        if action == 'status':
            if state:
                current = load_json(ROOT / 'attempt.json')
                if current and current['attemptId'] == attempt:
                    repair_terminal(state)
            return receipt(state) if state else {'status':'absent'}
        if action == 'confirm':
            current = load_json(ROOT / 'attempt.json')
            if not state or not current or current['attemptId'] != attempt:
                raise ValueError('Stale confirmation')
            source = validate_confirmation(state, request, connection, time.time(), boot_id())
            if machine_id() != state['machineId']:
                raise ValueError('Server identity changed')
            state.update(status='succeeded', observedSourceIp=source)
            # Persist the decision first. Recovery uses the same lock and
            # never restores an already committed attempt.
            persist(state)
            repair_terminal(state)
            return receipt(state)
        raise ValueError('Unknown operation')


if __name__ == '__main__':
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
