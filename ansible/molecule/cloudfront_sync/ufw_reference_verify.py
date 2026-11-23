#!/usr/bin/python3
"""Generate real-UFW reference bytes ONLY inside an explicitly disposable container.

This is a test harness, never a target-host helper. It mutates the disposable
container's isolated firewall and writes public documentation-address fixtures.
No engine/installer is imported. Run with --network=none, NET_ADMIN/NET_RAW,
and a read-only bind mount of the host's /proc/1/ns/net at HOST_NETNS.
"""
import argparse
import hashlib
import inspect
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MARKER = Path('/run/cloudfront-sync-ufw-reference-fixture')
MARKER_TEXT = b'CloudFront pure UFW reference fixture only\n'
HOST_NETNS = Path('/run/cloudfront-sync-host-netns')
CURRENT_NETNS = Path('/proc/self/ns/net')
DOCUMENTATION_RULES = {
    'old4': ['allow', 'proto', 'tcp', 'from', '192.0.2.0/28', 'to', 'any', 'port', '443', 'comment', 'cloudfront-sync'],
    'old6': ['allow', 'proto', 'tcp', 'from', '2001:db8:cf::/64', 'to', 'any', 'port', '443', 'comment', 'cloudfront-sync'],
    'new4': ['allow', 'proto', 'tcp', 'from', '198.18.0.0/28', 'to', 'any', 'port', '443', 'comment', 'cloudfront-sync'],
    'new6': ['allow', 'proto', 'tcp', 'from', '2001:db8:cf:1::/64', 'to', 'any', 'port', '443', 'comment', 'cloudfront-sync'],
}


def load_path(path, module_name):
    """Execute the Python file at ``path`` as a new module (never via sys.path).

    The single by-path loader of the disposable verifiers. s0_refusal_verify,
    vm_network_verify and ufw_reference_verify carry this function verbatim
    (tests/test_disposable_marker.py enforces it): it cannot live in
    disposable_marker.py, which is the first module it loads. Loading by path
    works unchanged under ``python -I``, which drops the script directory from
    sys.path.
    """
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


marker = load_path(Path(__file__).resolve().with_name('disposable_marker.py'), 'cloudfront_sync_disposable_marker')


def require_disposable():
    if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
        raise RuntimeError('requires disposable Docker fixture')
    if marker.marker_state(MARKER, MARKER_TEXT, exact_mode=0o600, single_link=True) != marker.VALID:
        raise RuntimeError('requires exact root-only disposable marker')
    if not os.path.ismount(HOST_NETNS) or not host_namespace_mount_is_readonly():
        raise RuntimeError('requires read-only host network namespace reference mount')
    try:
        host_ns = HOST_NETNS.stat()
        current_ns = CURRENT_NETNS.stat()
    except OSError:
        raise RuntimeError('requires readable host network namespace reference') from None
    if (not stat.S_ISREG(host_ns.st_mode) or stat.S_IMODE(host_ns.st_mode) & 0o222
            or host_ns.st_ino < 1 or current_ns.st_ino < 1):
        raise RuntimeError('requires read-only host network namespace reference')
    if (host_ns.st_dev, host_ns.st_ino) == (current_ns.st_dev, current_ns.st_ino):
        raise RuntimeError('container shares host network namespace')


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=45, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    if result.returncode:
        raise RuntimeError('fixture command failed: ' + args[0])
    return result.stdout


def host_namespace_mount_is_readonly():
    """Require the host namespace handle itself to be mounted read-only."""
    try:
        with open('/proc/self/mountinfo', 'rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
    except OSError:
        return False
    if len(raw) > 1024 * 1024:
        return False
    return host_namespace_mount_is_readonly_from(raw)


def host_namespace_mount_is_readonly_from(raw):
    if type(raw) is not bytes or len(raw) > 1024 * 1024:
        return False
    target = os.fsencode(HOST_NETNS).replace(b'\\', b'\\134').replace(b' ', b'\\040')
    matches = []
    for line in raw.splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[4] == target:
            matches.append(b'ro' in fields[5].split(b','))
    return bool(matches) and all(matches)


def fingerprint():
    values = {}
    for path in sorted([Path('/etc/default/ufw'), *Path('/etc/ufw').rglob('*')]):
        if path.is_symlink():
            raise RuntimeError('fixture symlink')
        info = path.stat()
        if path.is_file():
            values[str(path)] = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                                 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    return values


def clear_stock_fixture():
    command(['ufw', '--force', 'reset'])
    for path in Path('/etc/ufw').iterdir():
        if re.fullmatch(r'(?:before6?|after6?|user6?)\.rules\.\d{8}_\d{6}', path.name):
            if not path.is_file() or path.is_symlink():
                raise RuntimeError('unexpected fixture backup type')
            path.unlink()


def writer_source_hashes():
    import ufw.backend_iptables
    import ufw.common
    return {
        'write_rules': hashlib.sha256(inspect.getsource(ufw.backend_iptables.UFWBackendIptables._write_rules).encode()).hexdigest(),
        'format_rule': hashlib.sha256(inspect.getsource(ufw.common.UFWRule.format_rule).encode()).hexdigest(),
    }


def matrix_reference(output, adapter, adapter_source, adapter_path):
    """Calibrate stock logging/default/rule grammar independently of the engine."""
    cases = [
        ('off', 'off', 'deny', 'allow', 'deny'),
        ('low', 'low', 'deny', 'allow', 'deny'),
        ('medium', 'medium', 'deny', 'allow', 'deny'),
        ('high', 'high', 'deny', 'allow', 'deny'),
        ('full', 'full', 'deny', 'allow', 'deny'),
        ('mixed-defaults', 'low', 'allow', 'deny', 'reject'),
        ('allow-defaults', 'medium', 'allow', 'allow', 'allow'),
        ('reject-defaults', 'high', 'reject', 'reject', 'reject'),
        ('off-allow-defaults', 'off', 'allow', 'allow', 'allow'),
    ]
    rules = [
        ['allow', 'from', '203.0.113.70', 'comment', 'fixture-any-noport'],
        ['allow', 'from', '203.0.113.71', 'to', 'any', 'port', '9080', 'comment', 'fixture-any-port'],
        ['reject', 'proto', 'tcp', 'from', '203.0.113.72', 'to', 'any', 'port', '9081', 'comment', 'fixture-reject-tcp'],
        ['allow', 'log-all', 'proto', 'tcp', 'from', '203.0.113.73', 'to', 'any', 'port', '9082', 'comment', 'fixture-logall'],
        ['limit', 'log', 'proto', 'tcp', 'from', '203.0.113.74', 'to', 'any', 'port', '9083', 'comment', 'fixture-limit-log'],
        ['allow', 'proto', 'tcp', 'from', '203.0.113.75', 'port', '1100,1101', 'to', 'any', 'port', '9084,9085', 'comment', 'fixture-both-multi'],
        ['allow', 'proto', 'tcp', 'from', '203.0.113.76/32', 'port', '1102', 'to', 'any', 'port', '9086', 'comment', 'fixture-host32'],
        ['allow', 'proto', 'udp', 'from', '2001:db8:12::1/128', 'to', 'any', 'port', '9087', 'comment', 'fixture-host128'],
        ['allow', 'CloudFront Multi App'],
        ['limit', '22/tcp', 'comment', 'fixture-ssh-limit'],
    ]
    manifest = {'schema': 1, 'fixture_only': True, 'kind': 'profile-matrix',
                'os': re.search(r'^VERSION_ID="([^"]+)"$', Path('/etc/os-release').read_text(), re.M).group(1),
                'ufw_version': command(['dpkg-query', '-W', '-f=${Version}', 'ufw']).decode(),
                'rule_commands': rules, 'cases': [], 'source_hashes': writer_source_hashes()}
    roundtrips = 0
    for name, loglevel, incoming, outgoing, routed in cases:
        clear_stock_fixture()
        for value, direction in ((incoming, 'incoming'), (outgoing, 'outgoing'), (routed, 'routed')):
            command(['ufw', 'default', value, direction])
        command(['ufw', 'logging', loglevel])
        app = Path('/etc/ufw/applications.d/cloudfront-reference-multi')
        app.write_text('[CloudFront Multi App]\ntitle=Public multiport fixture\ndescription=No production data\nports=8086,8087/tcp|5354/udp\n')
        app.chmod(0o644)
        for index, rule in enumerate(rules):
            try:
                command(['ufw', *rule])
            except RuntimeError:
                raise RuntimeError('matrix command failed: case=' + name + ' rule_index=' + str(index)) from None
        command(['ufw', '--force', 'enable'])
        record = {'name': name, 'profile': {'loglevel': loglevel, 'default_input': incoming,
                  'default_output': outgoing, 'default_forward': routed, 'limit_supported': True}, 'files': {}}
        for family, leaf in ((4, 'user.rules'), (6, 'user6.rules')):
            data = Path('/etc/ufw', leaf).read_bytes()
            file = name + '.' + leaf
            (output / file).write_bytes(data)
            record['files'][leaf] = {'file': file, 'sha256': hashlib.sha256(data).hexdigest()}
            if adapter is not None:
                profile = adapter.UserFileProfile(family=family, **record['profile'])
                document = adapter.UserRulesDocument.parse(data, profile)
                if document.to_bytes() != data:
                    raise RuntimeError('matrix canonical roundtrip mismatch: ' + name)
                roundtrips += 1
        manifest['cases'].append(record)
    if adapter is not None:
        if adapter_path.read_bytes() != adapter_source:
            raise RuntimeError('adapter source changed during matrix calibration')
        manifest['adapter_sha256'] = hashlib.sha256(adapter_source).hexdigest()
        manifest['roundtrips'] = roundtrips
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'ufw_matrix_reference': 'passed', 'os': manifest['os'], 'cases': len(cases),
                      'adapter_sha256': manifest.get('adapter_sha256'), 'roundtrips': roundtrips}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--adapter', type=Path, help='Read-only pure adapter file to calibrate against actual UFW bytes')
    parser.add_argument('--matrix', action='store_true', help='Generate logging/default-policy and broad tuple grammar profiles')
    args = parser.parse_args()
    require_disposable()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError('refusing to overwrite nonempty reference output')
    adapter = None
    adapter_source = None
    if args.adapter is not None:
        adapter_source = args.adapter.read_bytes()
        spec = importlib.util.spec_from_loader('ufw_reference_adapter', loader=None)
        adapter = importlib.util.module_from_spec(spec)
        adapter.__file__ = str(args.adapter)
        sys.modules[spec.name] = adapter
        exec(compile(adapter_source, str(args.adapter), 'exec'), adapter.__dict__)
    if args.matrix:
        matrix_reference(output, adapter, adapter_source, args.adapter)
        return
    clear_stock_fixture()
    command(['ufw', 'default', 'deny', 'incoming'])
    command(['ufw', 'default', 'allow', 'outgoing'])
    command(['ufw', 'logging', 'low'])
    fixture_app = Path('/etc/ufw/applications.d/cloudfront-reference')
    fixture_app.write_text('[CloudFront Fixture App]\ntitle=Public test fixture\ndescription=No production data\nports=8081/tcp\n')
    fixture_app.chmod(0o644)
    initial = [
        ['limit', '22/tcp', 'comment', 'fixture-ssh-limit'],
        ['allow', 'proto', 'tcp', 'from', '203.0.113.8', 'to', 'any', 'port', '22', 'comment', 'fixture-admin'],
        ['deny', 'proto', 'tcp', 'from', '198.51.100.0/24', 'to', 'any', 'port', '8443', 'comment', 'fixture-deny'],
        ['reject', 'proto', 'udp', 'from', '198.51.100.0/24', 'to', 'any', 'port', '9443', 'comment', 'fixture-reject'],
        ['allow', 'log', 'proto', 'tcp', 'from', '203.0.113.0/24', 'to', 'any', 'port', '80,443', 'comment', 'fixture-multi-log'],
        ['route', 'allow', 'in', 'on', 'eth0', 'out', 'on', 'eth1', 'proto', 'tcp', 'from', '198.51.100.0/24', 'to', '203.0.113.0/24', 'port', '8080', 'comment', 'fixture-route'],
        ['allow', 'in', 'on', 'lo', 'proto', 'udp', 'from', 'any', 'to', 'any', 'port', '5353', 'comment', 'fixture-interface'],
        ['allow', 'CloudFront Fixture App'],
        ['allow', 'out', 'on', 'eth0', 'proto', 'udp', 'from', 'any', 'to', 'any', 'port', '53', 'comment', 'fixture-outbound'],
        ['allow', 'proto', 'tcp', 'from', '2001:db8:1::/64', 'to', 'any', 'port', '8443', 'comment', 'fixture-ipv6'],
        DOCUMENTATION_RULES['old4'], DOCUMENTATION_RULES['old6'],
        ['allow', 'proto', 'tcp', 'from', '203.0.113.99', 'to', 'any', 'port', '9000', 'comment', 'fixture-tail'],
    ]
    for rule in initial:
        command(['ufw', *rule])
    command(['ufw', '--force', 'enable'])
    if not command(['ufw', 'status']).startswith(b'Status: active\n'):
        raise RuntimeError('real fixture firewall not active')
    baseline = fingerprint()
    manifest = {'schema': 1, 'fixture_only': True, 'os': re.search(r'^VERSION_ID="([^"]+)"$', Path('/etc/os-release').read_text(), re.M).group(1),
                'ufw_version': command(['dpkg-query', '-W', '-f=${Version}', 'ufw']).decode(),
                'initial_commands': initial, 'states': [], 'operations': []}
    manifest['source_hashes'] = writer_source_hashes()
    original = {}
    documents = {}
    adapter_checks = {'roundtrips': 0, 'transitions': 0, 'unchanged_family': 0, 'noop': 0}

    def snapshot(name):
        inventory = fingerprint()
        for path, record in baseline.items():
            if path not in ('/etc/ufw/user.rules', '/etc/ufw/user6.rules') and inventory.get(path) != record:
                raise RuntimeError('UFW command changed protected fixture settings')
            if path in ('/etc/ufw/user.rules', '/etc/ufw/user6.rules') and any(
                    inventory.get(path, {}).get(field) != record[field] for field in ('mode', 'uid', 'gid')):
                raise RuntimeError('UFW command changed user file ownership or mode')
        if set(inventory) != set(baseline):
            raise RuntimeError('UFW command changed fixture path inventory')
        files = {}
        for leaf in ('user.rules', 'user6.rules'):
            data = Path('/etc/ufw', leaf).read_bytes()
            destination = name + '.' + leaf
            (output / destination).write_bytes(data)
            files[leaf] = {'file': destination, 'sha256': hashlib.sha256(data).hexdigest(),
                           **{key: inventory['/etc/ufw/' + leaf][key] for key in ('mode', 'uid', 'gid')}}
            if name == 'before':
                original[leaf] = data
            if adapter is not None:
                family = 4 if leaf == 'user.rules' else 6
                profile = adapter.UserFileProfile(family=family, loglevel='low', limit_supported=True,
                                                   default_input='deny', default_output='allow', default_forward='deny')
                parsed = adapter.UserRulesDocument.parse(data, profile)
                if parsed.to_bytes() != data:
                    raise RuntimeError('adapter canonical roundtrip differs from actual UFW bytes')
                adapter_checks['roundtrips'] += 1
                if name == 'before':
                    documents[family] = parsed
        manifest['states'].append({'name': name, 'files': files})

    snapshot('before')
    tuples = [line for line in original['user.rules'].decode().splitlines() if line.startswith('### tuple ### ')]
    old4_position = next(i + 1 for i, line in enumerate(tuples) if '192.0.2.0/28' in line)
    operations = [
        ('after_add4', ['ufw', *DOCUMENTATION_RULES['new4']]),
        ('after_add6', ['ufw', *DOCUMENTATION_RULES['new6']]),
        ('after_delete4', ['ufw', '--force', 'delete', *DOCUMENTATION_RULES['old4']]),
        ('after_restore4', ['ufw', 'insert', str(old4_position), *DOCUMENTATION_RULES['old4']]),
        ('after_delete6', ['ufw', '--force', 'delete', *DOCUMENTATION_RULES['new6']]),
        ('after_rollback', ['ufw', '--force', 'delete', *DOCUMENTATION_RULES['new4']]),
        ('after_noop', ['ufw', *DOCUMENTATION_RULES['old4']]),
    ]
    for name, argv in operations:
        predicted = None
        if adapter is not None and name != 'after_noop':
            family = 6 if name in ('after_add6', 'after_delete6') else 4
            rule = DOCUMENTATION_RULES[{'after_add4': 'new4', 'after_add6': 'new6',
                'after_delete4': 'old4', 'after_restore4': 'old4',
                'after_delete6': 'new6', 'after_rollback': 'new4'}[name]]
            managed = adapter.ManagedTuple(rule[rule.index('from') + 1], int(rule[rule.index('port') + 1]),
                                           rule[rule.index('comment') + 1])
            operation = 'add' if name in ('after_add4', 'after_add6', 'after_restore4') else 'delete'
            index = old4_position - 1 if name == 'after_restore4' else None
            # Prediction must exist before the real command, not be learned
            # from the observed after file or an after-the-fact baseline.
            predicted = (documents[family].add(managed, index) if operation == 'add'
                         else documents[family].delete(managed)).to_bytes()
        command(argv)
        if adapter is not None:
            family = 6 if name in ('after_add6', 'after_delete6') else 4
            if name == 'after_noop':
                if any(documents[f].to_bytes() != Path('/etc/ufw', leaf).read_bytes()
                       for f, leaf in ((4, 'user.rules'), (6, 'user6.rules'))):
                    raise RuntimeError('adapter no-op prediction differs from actual UFW bytes')
                adapter_checks['noop'] += 1
            else:
                actual = Path('/etc/ufw', 'user.rules' if family == 4 else 'user6.rules').read_bytes()
                if predicted != actual:
                    raise RuntimeError('pre-command expected bytes differ from actual UFW output')
                documents[family] = adapter.assert_transition(documents[family], actual, operation, managed, index=index)
                adapter_checks['transitions'] += 1
                other = 6 if family == 4 else 4
                if documents[other].to_bytes() != Path('/etc/ufw', 'user6.rules' if other == 6 else 'user.rules').read_bytes():
                    raise RuntimeError('actual UFW changed the non-target family bytes')
                adapter_checks['unchanged_family'] += 1
        manifest['operations'].append({'after_state': name, 'argv': argv})
        snapshot(name)
    for leaf, before in original.items():
        if Path('/etc/ufw', leaf).read_bytes() != before:
            raise RuntimeError('real UFW rollback/no-op did not restore exact bytes')
    manifest['protected_file_count'] = len(baseline) - 2
    manifest['real_enabled_ufw'] = True
    manifest['rollback_exact_bytes'] = True
    manifest['noop_exact_bytes'] = True
    if adapter is not None:
        if args.adapter.read_bytes() != adapter_source:
            raise RuntimeError('adapter source changed during calibration; rerun the fixed source')
        manifest['adapter_checks'] = adapter_checks
        manifest['adapter_sha256'] = hashlib.sha256(adapter_source).hexdigest()
        manifest['prediction_before_cli'] = True
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'ufw_reference': 'passed', 'os': manifest['os'], 'ufw': manifest['ufw_version'],
                      'states': len(manifest['states']), 'operations': len(operations), 'protected_files': len(baseline) - 2,
                      'rollback_exact_bytes': True, 'noop_exact_bytes': True}))
    if adapter is not None:
        print(json.dumps({'adapter_reference': 'passed', 'os': manifest['os'],
                          'adapter_sha256': manifest['adapter_sha256'], **adapter_checks}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': type(exc).__name__, 'detail': str(exc)}), file=sys.stderr)
        raise SystemExit(1)
