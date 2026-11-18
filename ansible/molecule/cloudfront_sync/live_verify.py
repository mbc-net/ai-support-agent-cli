#!/usr/bin/python3
"""Destructive isolated-container checks, never run on an operational host.

AWS retrieval alone is deterministic fixture injection. UFW rules, nginx syntax,
reloads and systemd are real. A disposable-host sentinel is mandatory.
"""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import urllib.request

if os.geteuid() != 0 or not Path('/run/cloudfront-sync-disposable-test').is_file():
    raise SystemExit('requires root and disposable-host sentinel')
spec = importlib.util.spec_from_file_location('cloudfront_sync', '/usr/local/libexec/cloudfront-sync/cloudfront-sync.py')
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


BASE = [str(ipaddress.ip_network('192.0.2.0/28').network_address + i * 16) + '/28' for i in range(5)]
BASE += ['2001:db8:' + str(i) + '::/48' for i in range(5)]
BASE = cf.sorted_ranges(BASE)
EXTRA = '198.51.100.0/24'
SECOND = '203.0.113.0/25'
THIRD = '203.0.113.128/25'
BLOCKED = '198.18.0.0/24'
FOREIGN = '198.19.0.0/24'


def document(ranges, token):
    return {'syncToken': str(token),
            'prefixes': [{'service': 'CLOUDFRONT_ORIGIN_FACING', 'ip_prefix': p} for p in ranges if ':' not in p],
            'ipv6_prefixes': [{'service': 'CLOUDFRONT_ORIGIN_FACING', 'ipv6_prefix': p} for p in ranges if ':' in p]}


class LiveHost(cf.Host):
    def __init__(self):
        self.doc = document(BASE, 100)
        self.failure = None
        self.adds = 0
        self.deletes = 0

    def fetch(self):
        return self.doc

    def add_rule(self, rule):
        self.adds += 1
        if self.failure == 'ufw' and self.adds == 2:
            self.failure = None
            raise cf.SyncError('injected mid-UFW failure after one real addition')
        super().add_rule(rule)
        if self.failure == 'crash':
            self.failure = None
            raise KeyboardInterrupt('simulated process death after real UFW addition')

    def delete_rule(self, rule):
        self.deletes += 1
        if self.failure == 'delete' and self.deletes == 2:
            self.failure = None
            raise cf.SyncError('injected failure after one actual deletion')
        super().delete_rule(rule)

    def check_reload_nginx(self):
        failure, self.failure = self.failure, None
        if failure == 'syntax':
            error = Path('/etc/nginx/conf.d/cf-sync-injected-error.conf')
            error.write_text('this_directive_does_not_exist;\n')
            try:
                self.command(['nginx', '-t'])
            finally:
                error.unlink()
            raise AssertionError('real nginx syntax failure was not observed')
        if failure == 'reload':
            self.command(['systemctl', 'stop', 'nginx.service'])
            try:
                self.command(['systemctl', 'reload', 'nginx.service'])
            finally:
                self.command(['systemctl', 'start', 'nginx.service'])
            raise AssertionError('real nginx reload failure was not observed')
        # UFW/crash injection must survive the nginx phase.
        self.failure = failure
        super().check_reload_nginx()


config = json.loads(Path('/etc/cloudfront-sync/config.json').read_text())
shared = Path('/etc/nginx/cloudfront-live')
shared.mkdir(mode=0o755, exist_ok=True)
for name, text in cf.render_nginx(BASE).items():
    (shared / name).write_text(text)
bundle = Path('/etc/nginx/conf.d/cf-sync-live.conf')
bundle.write_text('geo $realip_remote_addr $cf_sync_live_source {\n default 0;\n include ' + str(shared / 'cloudfront-geo.conf') + ';\n}\n'
                  'include ' + str(shared / 'cloudfront-realip.conf') + ';\n'
                  'real_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n'
                  'server { listen 18443; location / { return 200 "cf-live-ok"; } }\n')
command(['nginx', '-t'])
command(['systemctl', 'restart', 'nginx.service'])
config['nginx'] = {'enabled': True, 'shared_dir': str(shared), 'bundles': [{'geo_file': str(bundle), 'realip_file': str(bundle)}]}
config['firewall'] = {'backend': 'ufw', 'ports': [443]}
Path('/etc/cloudfront-sync/config.json').write_text(json.dumps(config))
os.chmod('/etc/cloudfront-sync/config.json', 0o640)
for cidr in BASE:
    command(['ufw', 'allow', 'from', cidr, 'to', 'any', 'port', '443', 'proto', 'tcp'])
# This deny must remain after the more-specific CloudFront allows on rollback.
command(['ufw', 'deny', 'from', '192.0.2.0/24', 'to', 'any', 'port', '443', 'proto', 'tcp', 'comment', 'unmanaged-order-decoy'])
command(['ufw', 'allow', 'from', '192.0.2.222', 'to', 'any', 'port', '44999', 'proto', 'tcp', 'comment', 'unmanaged-decoy'])
# Future-range conflicts belong to the confirmed unmanaged baseline.
command(['ufw', 'deny', 'from', BLOCKED, 'to', 'any', 'port', '443', 'proto', 'tcp', 'comment', 'unmanaged-future-deny'])
command(['ufw', 'allow', 'from', FOREIGN, 'to', 'any', 'port', '443', 'proto', 'tcp', 'comment', 'unmanaged-future-allow'])
command(['ufw', 'deny', '18444/tcp', 'comment', 'unmanaged-other-port-deny'])
command(['ufw', 'limit', 'from', '192.0.2.0/24', 'to', 'any', 'port', '22', 'proto', 'tcp', 'comment', 'unmanaged-ssh-limit'])
legacy = Path('/var/lib/cloudfront-sync/private/live-legacy.json')
legacy.write_text(json.dumps({'ranges': BASE}))
os.chmod(legacy, 0o600)
host = LiveHost()
engine = cf.Engine(config, host=host)
initial = host.snapshot(config)
import_plan = engine.import_plan(legacy)
engine.import_state(import_plan['approve_token'])
assert engine.state()['last_success'] is None
assert host.snapshot(config) == initial, 'import must not mutate the live policy'
try:
    engine.sync()
except cf.ApprovalRequired:
    pass
else:
    raise AssertionError('import must not bypass explicit first-apply approval')
assert engine.state()['last_success'] is None
assert host.snapshot(config) == initial
engine.apply(engine.plan()['approve_token'])
assert engine.state()['last_success'] is not None
host.doc = document(BASE + [EXTRA], 101)
assert engine.sync()['changed']
assert cf.parse_nginx_ranges(host.snapshot(config)['nginx']) == cf.sorted_ranges(BASE + [EXTRA])
host.doc = document(BASE, 102)
assert engine.sync()['changed'], 'within-limit deletion must converge'
assert host.snapshot(config)['rules'] == initial['rules'], 'legacy and unmanaged rules must survive'

for failure, candidate in [('syntax', BASE + [EXTRA]), ('reload', BASE + [EXTRA]), ('ufw', BASE + [EXTRA, SECOND])]:
    baseline = host.snapshot(config)
    before_state = engine.state()
    host.doc = document(candidate, 103)
    host.failure, host.adds = failure, 0
    try:
        engine.apply(engine.plan()['approve_token'])
    except cf.SyncError:
        pass
    else:
        raise AssertionError('fault did not fail: ' + failure)
    assert host.snapshot(config) == baseline, failure + ' failed to restore real UFW/nginx'
    assert engine.state() == before_state, failure + ' changed success state'
    assert not (engine.private / 'journal.json').exists(), failure + ' left incomplete recovery'

# A partial deletion must restore each allow before the existing broad deny.
baseline = host.snapshot(config)
before_state = engine.state()
host.doc = document(BASE[2:], 104)
host.failure, host.deletes = 'delete', 0
try:
    engine.apply(engine.plan()['approve_token'])
except cf.SyncError:
    pass
else:
    raise AssertionError('partial deletion failure was not observed')
assert host.snapshot(config) == baseline, 'partial delete changed rule ordering or unmanaged deny'
assert engine.state() == before_state
assert not (engine.private / 'journal.json').exists()

# A process death escapes regular exception rollback. Re-entry must restore it.
host.doc = document(BASE + [EXTRA], 104)
baseline = host.snapshot(config)
host.failure = 'crash'
try:
    engine.apply(engine.plan()['approve_token'])
except KeyboardInterrupt:
    pass
else:
    raise AssertionError('simulated death did not interrupt')
assert (engine.private / 'journal.json').exists()
engine.preflight()
assert host.snapshot(config) == baseline, 'crash recovery failed'
assert not (engine.private / 'journal.json').exists()

# Never claim success for a future range blocked by a confirmed unmanaged deny,
# nor retag an equivalent administrator-owned allow (UFW can update its comment).
for candidate, label in [(BLOCKED, 'future-deny'), (FOREIGN, 'foreign-semantic-allow')]:
    baseline = host.snapshot(config)
    before_state = engine.state()
    host.doc = document(BASE + [candidate], 105)
    try:
        engine.sync()
    except cf.SyncError:
        pass
    else:
        raise AssertionError(label + ' incorrectly reported success')
    assert host.snapshot(config) == baseline, label + ' mutated an unmanaged rule or nginx'
    assert engine.state() == before_state, label + ' advanced success state'
    assert not (engine.private / 'journal.json').exists(), label + ' must reject before a transaction'

# Actual config safety and service state are checked after all rollback cases.
command(['nginx', '-t'])
assert command(['systemctl', 'is-active', 'nginx.service']).strip() == 'active'
assert urllib.request.urlopen('http://127.0.0.1:18443', timeout=5).read() == b'cf-live-ok'
assert not subprocess.run(['systemctl', 'is-enabled', '--quiet', 'cloudfront-sync.timer'], check=False).returncode == 0
print(json.dumps({'live_checks': 'passed', 'cases': ['import', 'first-post-import-approval-gate', 'approved-initial-apply', 'automatic-add', 'automatic-delete',
                                                      'nginx-syntax-rollback', 'nginx-reload-rollback', 'mid-ufw-rollback', 'partial-delete-order-rollback',
                                                      'crash-recovery', 'unmanaged-preservation', 'http-response', 'future-deny-fail-closed', 'foreign-allow-comment-preservation'],
                  'uses_fixture_aws': True, 'real_ufw_nginx_systemd': True}))
