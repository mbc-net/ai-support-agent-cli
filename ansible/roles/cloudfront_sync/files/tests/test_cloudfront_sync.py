"""Unit and transactional fault tests; no host firewall access."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import contextlib
import io
import os
import subprocess

MODULE_PATH = Path(__file__).parents[1] / 'cloudfront-sync.py'
spec = importlib.util.spec_from_file_location('cloudfront_sync', MODULE_PATH)
cf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cf)

V4 = '192.0.2.0/24'
V6 = '2001:db8::/32'


def document(ranges=(V4, V6), token='10'):
    return {'syncToken': token, 'prefixes': [{'ip_prefix': r, 'service': 'CLOUDFRONT_ORIGIN_FACING'} for r in ranges if ':' not in r],
            'ipv6_prefixes': [{'ipv6_prefix': r, 'service': 'CLOUDFRONT_ORIGIN_FACING'} for r in ranges if ':' in r]}


def config():
    return {'host_address': '192.0.2.10', 'firewall': {'backend': 'ufw', 'ports': [443]},
            'nginx': {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []},
            'limits': {'max_changes': 10, 'min_ratio': .8}, 'notify_unit': ''}


class FakeHost:
    def __init__(self):
        self.rules = []
        self.doc = document()
        self.stops = 0
        self.fail_action = None
        self.actions = []
        self.nginx = {}

    def check_target(self, cfg):
        pass

    def preflight(self, cfg):
        self.check_target(cfg)

    def fetch(self):
        return self.doc

    def snapshot(self, cfg):
        runtime = []
        for i, r in enumerate(self.rules):
            port = str(r['port']) + '/tcp' if r['port'] else (r['args'][1] if len(r['args']) == 2 else None)
            policy = r.get('test_policy', {'action': r['args'][0], 'source': r['source'] or 'any', 'port': port})
            runtime.append({'number': i + 1, 'family': cf.ipaddress.ip_network(r['source']).version if r['source'] else 4, 'key': cf.digest(r), 'policy': policy})
        return {'rules': [dict(x) for x in self.rules], 'runtime': runtime, 'nginx': dict(self.nginx), 'bundles': {}}

    def add_rule(self, rule):
        self.actions.append(('add', rule))
        if self.fail_action == 'add':
            self.fail_action = None
            raise cf.SyncError('injected add failure')
        if rule not in self.rules:
            self.rules.append(dict(rule))

    def delete_rule(self, rule):
        self.actions.append(('delete', rule))
        if self.fail_action == 'delete':
            self.fail_action = None
            raise cf.SyncError('injected delete failure')
        self.rules.remove(rule)

    def restore_rule(self, rule, before):
        original = before['rules']
        position = original.index(rule)
        for successor in original[position + 1:]:
            if successor in self.rules:
                self.rules.insert(self.rules.index(successor), dict(rule))
                return
        self.add_rule(rule)

    def write_nginx(self, cfg, files):
        self.nginx = dict(files)

    def check_reload_nginx(self):
        if self.fail_action == 'reload':
            self.fail_action = None
            raise cf.SyncError('injected reload failure')

    def stop_timer(self):
        self.stops += 1


class ValidationTests(unittest.TestCase):
    def test_filter_dualstack_and_dedupe(self):
        d = document((V4, V4, V6))
        d['prefixes'].append({'service': 'CLOUDFRONT', 'ip_prefix': '198.51.100.0/24'})
        self.assertEqual(cf.parse_aws(d)['ranges'], [V4, V6])

    def test_reject_invalid_aws(self):
        for d in [document((V4,)), document(('0.0.0.0/0', V6)), document((V4, V6), 'bad'), {}, document(('invalid', V6))]:
            with self.subTest(d=d), self.assertRaises(cf.SyncError):
                cf.parse_aws(d)

    def test_config_types_and_path_injection(self):
        for mutate in [lambda c: c['firewall'].update(ports=[True]), lambda c: c['firewall'].update(ports=[22]),
                       lambda c: c['limits'].update(max_changes=True), lambda c: c['nginx'].update(enabled='false'),
                       lambda c: c['nginx'].update(shared_dir='/etc/nginx/a;evil'), lambda c: c.update(notify_unit='a\nb.service')]:
            c = config(); mutate(c)
            with self.subTest(c=c), self.assertRaises(cf.SyncError):
                cf.validate_config(c)

    def test_limits_count_and_per_family(self):
        self.assertTrue(cf.within_limits([V4, V6], [V4, V6, '198.51.100.0/24'], {'max_changes': 1, 'min_ratio': .8}))
        self.assertFalse(cf.within_limits([V4, V6], [V4], {'max_changes': 10, 'min_ratio': .8}))
        self.assertFalse(cf.within_limits([], [V4, V6], {'max_changes': 10, 'min_ratio': .8}))

    def test_ufw_parser_preserves_unmanaged(self):
        lines = "Added user rules:\nufw allow 22/tcp\nufw allow from 192.0.2.0/24 to any port 443 proto tcp comment 'cloudfront-sync'\n"
        rules = cf.parse_ufw(lines)
        self.assertEqual(len(rules), 2)
        self.assertEqual(rules[1]['source'], V4)
        self.assertEqual(rules[1]['comment'], 'cloudfront-sync')
        self.assertIsNone(rules[0]['source'])


    def test_ufw_formatting_and_hostmask_normalization(self):
        a = cf.parse_ufw("ufw allow from 192.0.2.1 to any port 443 proto tcp comment 'cloudfront-sync'\n")
        b = cf.parse_ufw("ufw allow in proto tcp from 192.0.2.1/32 to any port 443 comment cloudfront-sync\n")
        self.assertEqual(a, b)
        self.assertEqual(a[0]['args'], cf.make_rule('192.0.2.1/32', 443)['args'])
        with self.assertRaises(cf.SyncError):
            cf.parse_ufw('ufw allow out 443 comment cloudfront-sync\n')

    def test_nginx_tokenization_ignores_commented_includes(self):
        text = '# include /secret;\ngeo $realip_remote_addr $cf { default 0; include /etc/nginx/cf/geo.conf; }'
        blocks = cf.nginx_geo_blocks(cf.nginx_tokens(text))
        self.assertEqual(blocks[0][0], '$realip_remote_addr')
        self.assertIn(['include', '/etc/nginx/cf/geo.conf', ';'], cf.chunks(blocks[0][1]))
        self.assertNotIn('/secret', cf.nginx_tokens(text))
        self.assertRaises(cf.SyncError, cf.nginx_tokens, 'map "unclosed')
        self.assertRaises(cf.SyncError, cf.nginx_geo_blocks, ['geo', '$a', '$b', '{'])

    def test_extra_config_and_invalid_ranges(self):
        for modify in [lambda c: c.update(extra='value'), lambda c: c.update(host_address=1),
                       lambda c: c['nginx'].update(enabled=True), lambda c: c['limits'].update(min_ratio=float('nan')),
                       lambda c: c['firewall'].update(backend='iptables'), lambda c: c['firewall'].update(ports=[443, 443])]:
            c = config(); modify(c)
            self.assertRaises(cf.SyncError, cf.validate_config, c)
        for text in [{'prefixes': [], 'ipv6_prefixes': [], 'syncToken': '10'},
                     {'prefixes': [{'service': 'CLOUDFRONT_ORIGIN_FACING', 'ip_prefix': V6}], 'ipv6_prefixes': [], 'syncToken': '10'}]:
            self.assertRaises(cf.SyncError, cf.parse_aws, text)


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.host = FakeHost()
        self.engine = cf.Engine(config(), Path(self.temp.name), self.host, clock=lambda: 1000)

    def tearDown(self):
        self.temp.cleanup()

    def initial(self):
        p = self.engine.plan()
        self.assertTrue(p['approval_required'])
        return self.engine.apply(p['approve_token'])

    def test_initial_needs_approval_then_commits(self):
        self.assertRaises(cf.ApprovalRequired, self.engine.sync)
        self.initial()
        self.assertEqual(len(self.host.rules), 2)
        self.assertEqual(self.engine.state()['ranges'], [V4, V6])
        self.assertEqual(self.engine.status()['last_success'], 1000)

    def test_wrong_expired_reused_changed_token(self):
        p = self.engine.plan()
        self.assertRaises(cf.SyncError, self.engine.apply, 'wrong')
        self.engine.clock = lambda: 5000
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        self.engine.clock = lambda: 1000
        p = self.engine.plan(); self.host.doc = document(token='11')
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        p = self.engine.plan(); self.engine.apply(p['approve_token'])
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])

    def test_external_change_rejects_before_mutation(self):
        self.initial()
        self.host.rules.append(cf.make_rule('203.0.113.0/24', 443))
        count = len(self.host.actions)
        self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(len(self.host.actions), count)

    def test_rollback_on_partial_add_failure(self):
        self.initial()
        old = list(self.host.rules)
        self.host.doc = document((V4, V6, '198.51.100.0/24'), token='11')
        self.host.fail_action = 'add'
        self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(self.host.rules, old)
        self.assertEqual(self.engine.state()['aws_sync_token'], '10')
        self.assertFalse((self.engine.private / 'journal.json').exists())

    def test_noop_refreshes_success_and_rejects_old_feed(self):
        self.initial()
        self.engine.clock = lambda: 1100
        self.engine.sync()
        self.assertEqual(self.engine.status()['last_success'], 1100)
        self.host.doc = document(token='9')
        self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(self.engine.status()['last_success'], 1100)

    def test_threshold_block_leaves_state_untouched(self):
        self.initial()
        self.engine.config['limits']['max_changes'] = 1
        # Config changes are not silently accepted against existing state.
        self.assertRaises(cf.SyncError, self.engine.sync)

    def test_legacy_import_no_rewrite_and_then_sync(self):
        self.host.rules = [cf.make_rule(r, 443, comment='legacy') for r in (V4, V6)]
        legacy = Path(self.temp.name) / 'legacy.json'
        legacy.write_text(json.dumps({'phase': 'confirmed', 'ranges': [V4, V6]}))
        p = self.engine.import_plan(legacy)
        self.engine.import_state(p['approve_token'])
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.host.rules[0]['comment'], 'legacy')
        self.host.doc = document((V4, V6, '198.51.100.0/24'), '11')
        self.assertRaises(cf.ApprovalRequired, self.engine.sync)
        plan = self.engine.plan()
        self.assertTrue(plan['approval_required'])
        self.engine.apply(plan['approve_token'])
        self.assertEqual(len(self.host.rules), 3)

    def test_import_missing_legacy_rule_and_changed_evidence_reject(self):
        legacy = Path(self.temp.name) / 'legacy.json'
        legacy.write_text(json.dumps({'ranges': [V4, V6]}))
        self.assertRaises(cf.SyncError, self.engine.import_plan, legacy)
        self.host.rules = [cf.make_rule(r, 443, comment='legacy') for r in (V4, V6)]
        p = self.engine.import_plan(legacy)
        legacy.write_text(json.dumps({'ranges': [V4]}))
        self.assertRaises(cf.SyncError, self.engine.import_state, p['approve_token'])


    def test_partial_multiple_adds_are_rolled_back(self):
        self.initial()
        before = self.host.snapshot(self.engine.config)
        self.host.doc = document((V4, V6, '198.51.100.0/24', '203.0.113.0/24'), '11')
        original = self.host.add_rule
        calls = []
        def fail_second(rule):
            calls.append(rule)
            if len(calls) == 2:
                raise cf.SyncError('second addition fails')
            original(rule)
        with mock.patch.object(self.host, 'add_rule', side_effect=fail_second):
            self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(self.host.snapshot(self.engine.config), before)
        self.assertEqual(self.engine.state()['aws_sync_token'], '10')

    def test_recovery_failed_stops_timer_and_keeps_evidence(self):
        self.initial()
        self.host.doc = document((V4, V6, '198.51.100.0/24', '203.0.113.0/24'), '11')
        original = self.host.add_rule
        calls = []
        def fail_second(rule):
            calls.append(rule)
            if len(calls) == 2:
                raise cf.SyncError('add failure')
            original(rule)
        with mock.patch.object(self.host, 'add_rule', side_effect=fail_second), mock.patch.object(self.host, 'delete_rule', side_effect=cf.SyncError('rollback failure')):
            self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(self.host.stops, 1)
        self.assertTrue(self.engine.status()['recovery_failed'])
        self.assertTrue((self.engine.private / 'journal.json').exists())
        self.engine.preflight()
        self.assertEqual(len(self.host.rules), 2)
        self.assertFalse((self.engine.private / 'journal.json').exists())

    def test_crash_between_nginx_files_recovers_before_preflight(self):
        self.engine.config['nginx'].update(enabled=True, bundles=[{'geo_file': '/etc/nginx/a.conf', 'realip_file': '/etc/nginx/b.conf'}])
        self.host.nginx = cf.render_nginx([V4, V6])
        self.initial()
        before = self.host.snapshot(self.engine.config)
        old = self.engine.state()
        target = cf.render_nginx([V4, '198.51.100.0/24', V6])
        journal = {'version': 1, 'config_hash': cf.digest(self.engine.config), 'before': before, 'old_state': old,
                   'target_rules': old['owned_rules'], 'target_nginx': target, 'new_state': None}
        cf.atomic_json(self.engine.private / 'journal.json', journal)
        self.host.nginx['cloudfront-geo.conf'] = target['cloudfront-geo.conf']
        def validate_runtime(cfg):
            cf.parse_nginx_ranges(self.host.nginx)
        with mock.patch.object(self.host, 'preflight', side_effect=validate_runtime):
            self.engine.preflight()
        self.assertEqual(self.host.snapshot(self.engine.config), before)

    def test_committed_crash_recovery_and_no_destructive_foreign_restore(self):
        self.initial()
        state = self.engine.state()
        journal = {'version': 1, 'config_hash': cf.digest(self.engine.config), 'before': state['snapshot'], 'old_state': None,
                   'target_rules': state['owned_rules'], 'target_nginx': {}, 'new_state': state}
        cf.atomic_json(self.engine.private / 'journal.json', journal)
        self.engine.preflight()
        self.assertFalse((self.engine.private / 'journal.json').exists())
        self.assertEqual(len(self.host.rules), 2)
        journal['new_state'] = None
        journal['old_state'] = state
        cf.atomic_json(self.engine.private / 'journal.json', journal)
        foreign = cf.make_rule('198.51.100.0/24', 8443, 'administrator')
        self.host.rules.append(foreign)
        self.assertRaises(cf.SyncError, self.engine.preflight)
        self.assertIn(foreign, self.host.rules)
        self.assertTrue(self.engine.status()['recovery_failed'])

    def test_approved_plan_baseline_change_and_single_use_on_failure(self):
        p = self.engine.plan()
        self.host.rules.append(cf.make_rule('198.51.100.0/24', 8443, 'administrator'))
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        self.host.rules.clear()
        p = self.engine.plan()
        self.host.fail_action = 'add'
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        self.assertIsNone(self.engine.state())

    def test_nginx_reload_failure_restores_shared_files(self):
        self.engine.config['nginx'].update(enabled=True, bundles=[{'geo_file': '/etc/nginx/a.conf', 'realip_file': '/etc/nginx/b.conf'}])
        self.host.nginx = cf.render_nginx([V4, V6])
        self.initial()
        before = self.host.snapshot(self.engine.config)
        self.host.doc = document((V4, V6, '198.51.100.0/24'), '11')
        self.host.fail_action = 'reload'
        self.assertRaises(cf.SyncError, self.engine.sync)
        self.assertEqual(self.host.snapshot(self.engine.config), before)
        self.assertEqual(self.engine.state()['aws_sync_token'], '10')

    def test_legacy_apply_refused_and_import_evidence_bound(self):
        self.host.rules = [cf.make_rule(r, 443, comment='legacy') for r in (V4, V6)]
        p = self.engine.plan()
        self.assertTrue(p['import_required'])
        self.assertRaises(cf.SyncError, self.engine.apply, p['approve_token'])
        self.assertRaises(cf.SyncError, self.engine.import_state, p['approve_token'])

    def test_backend_none_never_calls_ufw(self):
        self.engine.config['firewall']['backend'] = 'none'
        self.initial()
        self.assertEqual(self.host.actions, [])
        self.engine.sync()
        self.assertEqual(self.host.actions, [])



class HostTests(unittest.TestCase):
    def test_subprocess_failures_are_sanitized(self):
        h = cf.Host()
        with mock.patch.object(cf.subprocess, 'run', return_value=subprocess.CompletedProcess(['nginx'], 1, 'ORIGIN_SECRET', 'ORIGIN_SECRET')):
            with self.assertRaises(cf.SyncError) as caught:
                h.command(['nginx', '-T'])
            self.assertNotIn('ORIGIN_SECRET', str(caught.exception))
        with mock.patch.object(cf.subprocess, 'run', side_effect=subprocess.TimeoutExpired('nginx', 1, output='ORIGIN_SECRET')):
            with self.assertRaises(cf.SyncError) as caught:
                h.command(['nginx', '-T'])
            self.assertNotIn('ORIGIN_SECRET', str(caught.exception))
        with mock.patch.object(cf.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'ok', '')) as run:
            self.assertEqual(h.command(['ip', 'address']), 'ok')
            self.assertNotIn('shell', run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')

    def test_fetch_size_errors_and_no_redirect(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(document()).encode()
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(cf.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(cf.Host().fetch(), document())
            opener.open.assert_called_with(cf.AWS_URL, timeout=30)
            response.read.return_value = b'x' * (cf.MAX_DOWNLOAD + 1)
            self.assertRaises(cf.SyncError, cf.Host().fetch)
            response.read.return_value = b'not json'
            self.assertRaises(cf.SyncError, cf.Host().fetch)
            opener.open.side_effect = OSError('sensitive')
            self.assertRaises(cf.SyncError, cf.Host().fetch)
        self.assertRaises(cf.SyncError, cf.NoRedirect().redirect_request, None, None, None, None, None, 'https://evil')

    def fixture(self, n=False):
        cfg = config()
        cfg['nginx'].update(enabled=n, bundles=[{'geo_file': '/etc/nginx/geo.conf', 'realip_file': '/etc/nginx/server.conf'}] if n else [])
        geo = 'geo $realip_remote_addr $cf { default 0; include /etc/nginx/cloudfront/cloudfront-geo.conf; }'
        real = 'include /etc/nginx/cloudfront/cloudfront-realip.conf; real_ip_header X-Forwarded-For; real_ip_recursive off;'
        outputs = {
            ('ip', '-json', 'address', 'show'): json.dumps([{'addr_info': [{'local': cfg['host_address']}]}]),
            ('sshd', '-T'): 'port 22\n'.replace('\\n', '\n'),
            ('ufw', 'status'): 'Status: active\n',
            ('nginx', '-t'): '',
            ('nginx', '-T'): '# configuration file /etc/nginx/geo.conf:\n# configuration file /etc/nginx/server.conf:\n',
        }
        host = cf.Host()
        host.command = mock.Mock(side_effect=lambda cmd: outputs[tuple(cmd)])
        return cfg, host, outputs, geo, real

    def test_host_identity_ssh_and_firewall_preflight(self):
        cfg, host, outputs, _, _ = self.fixture()
        with mock.patch.object(cf.shutil, 'which', return_value='/usr/sbin/command'):
            host.preflight(cfg)
            outputs[('sshd', '-T')] = 'port 443\n'
            self.assertRaises(cf.SyncError, host.preflight, cfg)
            outputs[('sshd', '-T')] = 'port 22\n'
            outputs[('ufw', 'status')] = 'Status: inactive\n'
            self.assertRaises(cf.SyncError, host.preflight, cfg)
            outputs[('ip', '-json', 'address', 'show')] = '[]'
            self.assertRaises(cf.SyncError, host.preflight, cfg)
        with mock.patch.object(cf.shutil, 'which', return_value=None):
            self.assertRaises(cf.SyncError, host.preflight, cfg)

    def test_nginx_preflight_context_and_trust_validation(self):
        cfg, host, outputs, geo, real = self.fixture(True)
        content = {'/etc/nginx/geo.conf': geo, '/etc/nginx/server.conf': real}
        with mock.patch.object(cf.shutil, 'which', return_value='/usr/sbin/command'), mock.patch.object(cf, 'check_path'), mock.patch.object(cf, 'read_text', side_effect=lambda p: content[str(p)]):
            host.preflight(cfg)
            for invalid in [geo.replace('$realip_remote_addr', '$remote_addr'), '# ' + geo,
                            geo.replace('default 0;', 'default 1;'), geo.replace('default 0;', 'default 0; 203.0.113.0/24 1;')]:
                content['/etc/nginx/geo.conf'] = invalid
                self.assertRaises(cf.SyncError, host.preflight, cfg)
            content['/etc/nginx/geo.conf'] = geo
            for invalid in [real.replace('off;', 'on;'), real + ' set_real_ip_from 0.0.0.0/0;',
                            real.replace('X-Forwarded-For', 'X-Real-IP')]:
                content['/etc/nginx/server.conf'] = invalid
                self.assertRaises(cf.SyncError, host.preflight, cfg)
            content['/etc/nginx/server.conf'] = real
            outputs[('nginx', '-T')] = ''
            self.assertRaises(cf.SyncError, host.preflight, cfg)

    def test_snapshot_permits_raw_partial_files_for_recovery(self):
        cfg, host, _, _, _ = self.fixture(True)
        files = cf.render_nginx([V4, V6])
        files['cloudfront-geo.conf'] = cf.render_nginx([V4, V6, '198.51.100.0/24'])['cloudfront-geo.conf']
        def read(path):
            return files.get(Path(path).name, 'bundle source including ORIGIN_SECRET')
        host.command = mock.Mock(return_value='ufw allow 22/tcp\n')
        with mock.patch.object(cf, 'read_text', side_effect=read):
            snapshot = host.snapshot(cfg)
        self.assertNotIn('ORIGIN_SECRET', cf.canonical(snapshot))
        self.assertRaises(cf.SyncError, cf.parse_nginx_ranges, snapshot['nginx'])
        self.assertEqual(len(snapshot['rules']), 1)

    def test_host_mutation_commands_and_stop_disable(self):
        host = cf.Host()
        host.command = mock.Mock(return_value='')
        rule = cf.make_rule(V4, 443)
        host.add_rule(rule); host.delete_rule(rule); host.check_reload_nginx(); host.stop_timer()
        self.assertEqual(host.command.call_args_list[0].args[0], ['ufw'] + rule['args'])
        self.assertEqual(host.command.call_args_list[1].args[0], ['ufw', '--force', 'delete'] + rule['args'])
        self.assertEqual(host.command.call_args_list[-1].args[0], ['systemctl', 'disable', '--now', 'cloudfront-sync.timer'])
        with mock.patch.object(cf, 'check_path'), mock.patch.object(cf, 'atomic_text') as write:
            host.write_nginx(config(), cf.render_nginx([V4, V6]))
            self.assertEqual(write.call_count, 2)
            self.assertRaises(cf.SyncError, host.write_nginx, config(), {'evil': 'x'})



    def test_runtime_ufw_numbers_include_generic_dualstack_rules(self):
        text = """Status: active
[ 1] 22/tcp                     ALLOW IN    Anywhere
[ 2] 443/tcp                    ALLOW IN    192.0.2.0/24 # legacy
[ 3] Anywhere                   DENY IN     203.0.113.0/24 # administrator
[ 4] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
[ 5] 443/tcp (v6)               ALLOW IN    2001:db8::/32 # legacy
"""
        parsed = cf.parse_ufw_numbered(text)
        self.assertEqual(len(parsed), 5)
        self.assertEqual(parsed[1]['key'], cf.digest(cf.make_rule(V4, 443, 'legacy')))
        self.assertEqual(parsed[-1]['key'], cf.digest(cf.make_rule(V6, 443, 'legacy')))
        self.assertEqual([r['family'] for r in parsed], [4, 4, 4, 6, 6])
        # Restoring a v4 allow must use runtime deny index3, not show-added index.
        current = text.replace('[ 2] 443/tcp                    ALLOW IN    192.0.2.0/24 # legacy\n', '').replace('[ 3]', '[ 2]').replace('[ 4]', '[ 3]').replace('[ 5]', '[ 4]')
        host = cf.Host(); host.command = mock.Mock(return_value=current)
        host.restore_rule(cf.make_rule(V4, 443, 'legacy'), {'runtime': parsed})
        self.assertEqual(host.command.call_args.args[0][:3], ['ufw', 'insert', '2'])
        # No surviving successor in same family means append, which does not
        # disturb the order of rules in the other family.
        host.command = mock.Mock(return_value=text.replace('[ 5] 443/tcp (v6)               ALLOW IN    2001:db8::/32 # legacy\n', ''))
        host.restore_rule(cf.make_rule(V6, 443, 'legacy'), {'runtime': parsed})
        self.assertEqual(host.command.call_args.args[0], ['ufw'] + cf.make_rule(V6, 443, 'legacy')['args'])
        self.assertRaises(cf.SyncError, cf.parse_ufw_numbered, text.replace('[ 5]', '[ 6]'))
        self.assertRaises(cf.SyncError, host.restore_rule, cf.make_rule('203.0.113.0/24', 443), {'runtime': parsed})


    def test_runtime_duplicate_positions_and_cross_family_restore(self):
        duplicate = '[ 1] 443/tcp ALLOW IN 192.0.2.0/24 # legacy\n[ 2] 443/tcp ALLOW IN 192.0.2.0/24 # legacy\n'
        self.assertRaises(cf.SyncError, cf.parse_ufw_numbered, duplicate)
        original = cf.parse_ufw_numbered('[ 1] 443/tcp ALLOW IN 192.0.2.0/24 # legacy\n[ 2] 22/tcp (v6) ALLOW IN Anywhere (v6)\n')
        host = cf.Host(); host.command = mock.Mock(return_value='[ 1] 22/tcp (v6) ALLOW IN Anywhere (v6)\n')
        host.restore_rule(cf.make_rule(V4, 443, 'legacy'), {'runtime': original})
        self.assertEqual(host.command.call_args.args[0], ['ufw'] + cf.make_rule(V4, 443, 'legacy')['args'])


class FilesystemTests(unittest.TestCase):
    def test_atomic_modes_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'file'
            cf.atomic_text(path, 'content', 0o640)
            self.assertEqual(path.read_text(), 'content')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            link = Path(tmp) / 'link'
            link.symlink_to(path)
            self.assertRaises(cf.SyncError, cf.atomic_text, link, 'changed')
            self.assertEqual(path.read_text(), 'content')
            self.assertRaises(cf.SyncError, cf.check_path, link)
            self.assertRaises(cf.SyncError, cf.json_read, path)

    def test_lock_exclusion_and_inherited_descriptor(self):
        # Exercise the real flock behavior without relying on production paths.
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'lock'
            with mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf, 'check_path'), mock.patch.object(cf.os, 'geteuid', return_value=0):
                # On macOS tests run as a non-root user; mock only fstat/lstat uid.
                real_fstat, real_lstat = cf.os.fstat, cf.Path.lstat
                def fstat(fd):
                    st = real_fstat(fd)
                    return mock.Mock(st_mode=st.st_mode, st_uid=0, st_dev=st.st_dev, st_ino=st.st_ino)
                def lstat(p):
                    st = real_lstat(p)
                    return mock.Mock(st_mode=st.st_mode, st_uid=0, st_dev=st.st_dev, st_ino=st.st_ino)
                with mock.patch.object(cf.os, 'fstat', side_effect=fstat), mock.patch.object(cf.Path, 'lstat', lstat):
                    with cf.exclusive_lock():
                        self.assertRaises(cf.SyncError, cf.exclusive_lock().__enter__)
                    fd = os.open(lock, os.O_RDWR)
                    try:
                        with cf.exclusive_lock(fd):
                            os.fstat(fd)
                    finally:
                        os.close(fd)


    def test_secure_paths_reject_symlink_ownership_modes_and_shapes(self):
        def info(mode, uid=0):
            return mock.Mock(st_mode=mode, st_uid=uid)
        paths = {'/': info(0o040755), '/safe': info(0o040755), '/safe/file': info(0o100600)}
        def lstat(path):
            if str(path) not in paths:
                raise FileNotFoundError()
            return paths[str(path)]
        with mock.patch.object(cf.os, 'geteuid', return_value=0), mock.patch.object(cf.Path, 'lstat', lstat):
            cf.check_path('/safe/file', writable=True)
            cf.check_path('/safe', directory=True)
            for mode, uid in [(0o120777, 0), (0o100600, 1000), (0o100622, 0), (0o040700, 0)]:
                paths['/safe/file'] = info(mode, uid)
                self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', writable=True)
            paths['/safe/file'] = info(0o100644)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', writable=True)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file', directory=True)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/missing')
            del paths['/safe']
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file')
            paths['/safe'] = info(0o100600)
            self.assertRaises(cf.SyncError, cf.check_path, '/safe/file')

    def test_sticky_root_lock_directory_and_invalid_descriptor(self):
        lock = Path('/run/lock/cloudfront-sync.lock')
        parent = mock.Mock(st_mode=0o041777, st_uid=0, st_dev=1, st_ino=1)
        file = mock.Mock(st_mode=0o100600, st_uid=0, st_dev=1, st_ino=2)
        def lstat(path):
            return parent if path == lock.parent else file
        with mock.patch.object(cf, 'LOCK', lock), mock.patch.object(cf.Path, 'lstat', lstat), mock.patch.object(cf, 'check_path') as check, mock.patch.object(cf.os, 'fstat', return_value=file), mock.patch.object(cf.fcntl, 'flock'):
            with cf.exclusive_lock(7):
                pass
            check.assert_called_with(Path('/run'), directory=True)
            file.st_mode = 0o100644
            self.assertRaises(cf.SyncError, cf.exclusive_lock(7).__enter__)
            file.st_mode = 0o100600; file.st_uid = 1000
            self.assertRaises(cf.SyncError, cf.exclusive_lock(7).__enter__)

    def test_read_errors_size_and_atomic_failure_preserve_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'file'
            path.write_text('oversize')
            with mock.patch.object(cf, 'MAX_FILE', 1):
                self.assertRaises(cf.SyncError, cf.read_text, path, secure=False)
            path.write_bytes(b'\xff')
            self.assertRaises(cf.SyncError, cf.read_text, path, secure=False)
            path.write_text('old')
            with mock.patch.object(cf.os, 'replace', side_effect=OSError('injected')):
                self.assertRaises(OSError, cf.atomic_text, path, 'new')
            self.assertEqual(path.read_text(), 'old')
            self.assertEqual(list(Path(tmp).iterdir()), [path])


class CliTests(unittest.TestCase):
    def test_root_only_and_sanitized_cli_errors(self):
        err = io.StringIO()
        with mock.patch.object(cf.os, 'geteuid', return_value=501), contextlib.redirect_stderr(err):
            self.assertEqual(cf.main(['preflight']), 1)
        self.assertEqual(json.loads(err.getvalue()), {'error': 'sync_failed'})

    def test_cli_plan_apply_sync_and_import_without_host_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / 'config.json'; cfg.write_text(json.dumps(config()))
            root = Path(tmp) / 'state'
            host = FakeHost()
            def run(args):
                out = io.StringIO(); err = io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = cf.main(['--config', str(cfg)] + args)
                return code, json.loads(out.getvalue() or err.getvalue())
            with mock.patch.object(cf, 'CONFIG', cfg), mock.patch.object(cf, 'STATE_DIR', root), mock.patch.object(cf, 'Host', return_value=host), mock.patch.object(cf.os, 'geteuid', return_value=0), mock.patch.object(cf, 'check_path'), mock.patch.object(cf, 'exclusive_lock', return_value=contextlib.nullcontext()):
                self.assertEqual(run(['preflight'])[0], 0)
                self.assertEqual(run(['sync']), (2, {'error': 'approval_required'}))
                code, plan = run(['plan']); self.assertEqual(code, 0)
                self.assertEqual(run(['apply', '--approve=' + plan['approve_token']])[0], 0)
                self.assertEqual(run(['sync'])[0], 0)
                self.assertEqual(run(['apply', '--approve=' + plan['approve_token']])[0], 1)
                # A fresh host imports the previously created legacy permissions.
                state = root / 'private' / 'state.json'; state.unlink()
                host.rules = [cf.make_rule(r, 443, comment='legacy') for r in (V4, V6)]
                legacy = Path(tmp) / 'legacy.json'; legacy.write_text(json.dumps({'ranges': [V4, V6]}))
                code, plan = run(['import-plan', '--legacy-state', str(legacy)]); self.assertEqual(code, 0)
                self.assertEqual(run(['import', '--approve=' + plan['approve_token']])[0], 0)


class SafetyBoundaryTests(unittest.TestCase):
    def test_limits_exact_10_11_and_family_80_percent(self):
        old4 = [f'198.51.{i}.0/24' for i in range(5)]
        old6 = [f'2001:db8:{i}::/48' for i in range(5)]
        limits = {'max_changes': 10, 'min_ratio': .8}
        self.assertTrue(cf.within_limits(old4 + old6, old4[:4] + old6[:4], limits))
        self.assertFalse(cf.within_limits(old4 + old6, old4[:3] + old6, limits))
        additions = [f'203.0.{i}.0/24' for i in range(11)]
        self.assertTrue(cf.within_limits(old4 + old6, old4 + old6 + additions[:10], limits))
        self.assertFalse(cf.within_limits(old4 + old6, old4 + old6 + additions, limits))

    def fixture(self, folder):
        return cf.Engine(config(), Path(folder), FakeHost(), clock=lambda: 1000)

    def journal(self, engine):
        before = engine.host.snapshot(engine.config)
        return {'version': 1, 'config_hash': cf.digest(engine.config), 'before': before, 'old_state': engine.state(),
                'target_rules': engine.state()['owned_rules'], 'target_nginx': before['nginx'], 'new_state': None}

    def test_wrong_host_or_ssh_guard_blocks_recovery_before_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            cf.atomic_json(engine.private / 'journal.json', self.journal(engine))
            before = engine.host.snapshot(engine.config)
            previous = len(engine.host.actions)
            with mock.patch.object(engine.host, 'check_target', side_effect=cf.SyncError('wrong host or SSH conflict')):
                self.assertRaises(cf.SyncError, engine.preflight)
            self.assertEqual(engine.host.snapshot(engine.config), before)
            self.assertEqual(len(engine.host.actions), previous)
            self.assertEqual(engine.host.stops, 0)

    def test_corrupt_journal_disables_timer_without_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            before = engine.host.snapshot(engine.config)
            (engine.private / 'journal.json').write_text('not json')
            self.assertRaises(cf.SyncError, engine.preflight)
            self.assertEqual(engine.host.stops, 1)
            self.assertTrue(engine.status()['recovery_failed'])
            self.assertEqual(engine.host.snapshot(engine.config), before)
            self.assertEqual((engine.private / 'journal.json').read_text(), 'not json')

    def test_verify_after_refuses_missing_duplicate_foreign_rules_or_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            state = engine.state(); before = state['snapshot']; owned = state['owned_rules']
            missing = cf.copy.deepcopy(before); missing['rules'].pop()
            self.assertRaises(cf.SyncError, engine._verify_after, before, missing, owned, owned, {})
            duplicate = cf.copy.deepcopy(before); duplicate['rules'].append(owned[0])
            self.assertRaises(cf.SyncError, engine._verify_after, before, duplicate, owned, owned, {})
            foreign = cf.copy.deepcopy(before); foreign['rules'].append(cf.make_rule('203.0.113.0/24', 8443, 'admin'))
            self.assertRaises(cf.SyncError, engine._verify_after, before, foreign, owned, owned, {})
            changed = cf.copy.deepcopy(before); changed['bundles']['/etc/nginx/server.conf'] = 'changed'
            self.assertRaises(cf.SyncError, engine._verify_after, before, changed, owned, owned, {})

    def test_rollback_refuses_foreign_nginx_and_unknown_owned_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            j = self.journal(engine)
            engine.host.nginx = {'cloudfront-geo.conf': 'unknown config'}
            j['before']['nginx'] = {'cloudfront-geo.conf': 'old config'}
            j['target_nginx'] = {'cloudfront-geo.conf': 'new config'}
            self.assertRaises(cf.SyncError, engine._rollback, j)
            engine.host.nginx.clear()
            j = self.journal(engine)
            engine.host.rules.append(cf.make_rule('203.0.113.0/24', 443))
            self.assertRaises(cf.SyncError, engine._rollback, j)
            self.assertEqual(engine.host.nginx, {})
            j['config_hash'] = 'changed'
            self.assertRaises(cf.SyncError, engine._rollback, j)

    def test_partial_delete_and_crash_before_state_commit_restore_old_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            host = engine.host
            host.doc = document(tuple([f'198.51.{i}.0/24' for i in range(5)] + [V6]))
            deny = {'args': ['deny', '443/tcp'], 'source': None, 'port': None, 'comment': 'administrator', 'proto': None, 'direction': None, 'destination': None}
            host.rules = [cf.make_rule(f'198.51.{i}.0/24', 443, 'legacy') for i in range(5)] + [deny, cf.make_rule(V6, 443, 'legacy')]
            legacy = Path(tmp) / 'legacy.json'
            legacy.write_text(json.dumps({'ranges': [f'198.51.{i}.0/24' for i in range(5)] + [V6]}))
            engine.import_state(engine.import_plan(legacy)['approve_token'])
            engine.apply(engine.plan()['approve_token'])
            # The interleaved deny must remain AFTER the restored v4 allows.
            before = host.snapshot(engine.config)
            host.doc = document(tuple([f'198.51.{i}.0/24' for i in range(4)] + [V6]), '11')
            original = host.delete_rule
            def fail_after_delete(rule):
                original(rule)
                raise cf.SyncError('delete changed kernel then failed')
            with mock.patch.object(host, 'delete_rule', side_effect=fail_after_delete):
                self.assertRaises(cf.SyncError, engine.sync)
            self.assertEqual(host.snapshot(engine.config), before)
            # Restore can re-add deleted owned rules; order is meaningful for
            # general rules but these homogeneous exact allow tuples commute.

    def test_exact_expiry_corrupt_plan_and_legacy_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            p = engine.plan()
            engine.clock = lambda: p['expires_at']
            self.assertRaises(cf.SyncError, engine.apply, p['approve_token'])
            engine.clock = lambda: 1000
            p = engine.plan()
            pending = cf.json_read(engine.private / 'pending.json'); pending['candidate_hash'] = 'bad'
            cf.atomic_json(engine.private / 'pending.json', pending)
            self.assertRaises(cf.SyncError, engine.apply, p['approve_token'])
            legacy = Path(tmp) / 'legacy.json'
            legacy.write_text(json.dumps({'ranges': {'ipv4': [V4], 'ipv6': [V6]}}))
            engine.host.rules = [cf.make_rule(r, 443, comment='legacy') for r in (V4, V6)]
            plan = engine.import_plan(legacy)
            engine.import_state(plan['approve_token'])
            self.assertIsNone(engine.status()['last_success'])
            self.assertRaises(cf.SyncError, engine.import_plan, legacy)
            self.assertRaises(cf.SyncError, engine.import_state, plan['approve_token'])


    def test_noncanonical_or_corrupt_persisted_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            good = engine.state()
            for change in [{'initialized': False}, {'ranges': [V6, V4]}, {'aws_sync_token': 'not-a-token'}]:
                broken = {**good, **change}
                cf.atomic_json(engine.private / 'state.json', broken)
                self.assertRaises(cf.SyncError, engine.preflight)
                self.assertEqual(len(engine.host.rules), 2)
            cf.atomic_json(engine.private / 'state.json', good)
            journal = self.journal(engine); journal['version'] = 99
            cf.atomic_json(engine.private / 'journal.json', journal)
            self.assertRaises(cf.SyncError, engine.preflight)
            self.assertTrue(engine.status()['recovery_failed'])

    def test_runtime_only_change_and_bundle_change_are_not_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = self.fixture(tmp)
            engine.apply(engine.plan()['approve_token'])
            good = engine.state(); before = good['snapshot']; owned = good['owned_rules']
            after = cf.copy.deepcopy(before)
            after['runtime'].append({'number': 99, 'family': 4, 'key': 'new-kernel-only-rule', 'policy': None})
            self.assertRaises(cf.SyncError, engine._verify_after, before, after, owned, owned, {})
            journal = self.journal(engine)
            after = cf.copy.deepcopy(before); after['bundles']['/etc/nginx/bundle'] = 'foreign-change'
            with mock.patch.object(engine.host, 'snapshot', return_value=after):
                self.assertRaises(cf.SyncError, engine._rollback, journal)
            self.assertEqual(engine.host.snapshot(engine.config), before)

    def test_duplicate_bundles_and_malformed_aws_family_rejected(self):
        cfg = config()
        bundle = {'geo_file': '/etc/nginx/geo.conf', 'realip_file': '/etc/nginx/server.conf'}
        cfg['nginx'].update(enabled=True, bundles=[bundle, bundle])
        self.assertRaises(cf.SyncError, cf.validate_config, cfg)
        cfg['nginx']['bundles'] = [{'geo_file': '/etc/nginx/geo.conf'}]
        self.assertRaises(cf.SyncError, cf.validate_config, cfg)
        for wrong in [42, None, 'not-a-dict']:
            d = document(); d['prefixes'].append(wrong)
            self.assertRaises(cf.SyncError, cf.parse_aws, d)
        d = document(); d['ipv6_prefixes'] = None
        self.assertRaises(cf.SyncError, cf.parse_aws, d)


class PolicySafetyTests(unittest.TestCase):
    def opaque(self, action, port, source='any'):
        return {'args': [action, port], 'source': None, 'port': None, 'comment': 'administrator', 'proto': None,
                'direction': None, 'destination': None, 'test_policy': {'action': action, 'source': source, 'port': port}}

    def test_initial_shadowed_allow_fails_before_any_changes(self):
        for action, expression in [('deny', '443/tcp'), ('reject', '440:450/tcp'), ('limit', '443'), ('deny', 'Nginx Full')]:
            with self.subTest(action=action, expression=expression), tempfile.TemporaryDirectory() as tmp:
                host = FakeHost(); host.rules = [self.opaque(action, expression)]
                engine = cf.Engine(config(), tmp, host)
                before = host.snapshot(engine.config)
                self.assertRaises(cf.SyncError, engine.plan)
                self.assertEqual(host.snapshot(engine.config), before)
                self.assertEqual(host.actions, [])
                self.assertIsNone(engine.state())

    def test_nonmatching_port_udp_and_source_policy_preserved(self):
        for action, expression, source in [('deny', '18444/tcp', 'any'), ('limit', '22/tcp', 'any'),
                                           ('deny', '443/udp', 'any'), ('deny', '443/tcp', '203.0.113.0/24')]:
            with self.subTest(action=action, expression=expression, source=source), tempfile.TemporaryDirectory() as tmp:
                host = FakeHost(); admin = self.opaque(action, expression, source); host.rules = [admin]
                engine = cf.Engine(config(), tmp, host)
                engine.apply(engine.plan()['approve_token'])
                self.assertIn(admin, host.rules)
                self.assertEqual(len(host.rules), 3)

    def test_future_source_shadow_and_unowned_collision_block_before_nginx(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FakeHost()
            cfg = config(); cfg['nginx'].update(enabled=True, bundles=[{'geo_file': '/etc/nginx/a', 'realip_file': '/etc/nginx/b'}])
            host.nginx = cf.render_nginx([V4, V6])
            host.rules = [cf.make_rule(r, 443, 'legacy') for r in (V4, V6)]
            future = '198.51.100.0/24'
            deny = self.opaque('deny', '443/tcp', future)
            host.rules.append(deny)
            engine = cf.Engine(cfg, tmp, host)
            legacy = Path(tmp) / 'legacy.json'; legacy.write_text(json.dumps({'ranges': [V4, V6]}))
            # Initial preview must leave the role installed for explicit import.
            self.assertTrue(engine.plan()['import_required'])
            engine.import_state(engine.import_plan(legacy)['approve_token'])
            engine.apply(engine.plan()['approve_token'])
            before = host.snapshot(engine.config)
            host.doc = document((V4, V6, future), '11')
            self.assertRaises(cf.SyncError, engine.sync)
            self.assertEqual(host.snapshot(engine.config), before)
            self.assertEqual(host.actions, [])
            self.assertEqual(engine.state()['aws_sync_token'], '10')

        with tempfile.TemporaryDirectory() as tmp:
            class UfwCommentHost(FakeHost):
                def add_rule(self, rule):
                    for current in self.rules:
                        if cf.rule_identity(current) == cf.rule_identity(rule):
                            self.rules[self.rules.index(current)] = dict(rule)
                            self.actions.append(('overwrite-comment', rule))
                            return
                    super().add_rule(rule)
            host = UfwCommentHost()
            admin = cf.make_rule(future, 443, 'administrator-owned')
            host.rules = [cf.make_rule(r, 443, 'legacy') for r in (V4, V6)] + [admin]
            engine = cf.Engine(config(), tmp, host)
            legacy = Path(tmp) / 'legacy.json'; legacy.write_text(json.dumps({'ranges': [V4, V6]}))
            engine.import_state(engine.import_plan(legacy)['approve_token'])
            engine.apply(engine.plan()['approve_token'])
            before = host.snapshot(engine.config)
            host.doc = document((V4, V6, future), '11')
            self.assertRaises(cf.SyncError, engine.sync)
            self.assertEqual(host.snapshot(engine.config), before)
            self.assertIn(admin, host.rules)
            self.assertEqual(host.actions, [])

    def test_rollback_never_deletes_collided_admin_permission(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FakeHost(); engine = cf.Engine(config(), tmp, host)
            admin = cf.make_rule(V4, 443, 'administrator')
            target = cf.make_rule(V4, 443)
            host.rules = [admin]
            before = host.snapshot(engine.config)
            journal = {'version': 1, 'config_hash': cf.digest(engine.config), 'before': before, 'old_state': None,
                       'target_rules': [target], 'target_nginx': {}, 'new_state': None, 'addition_attempts': [target], 'deletion_attempts': []}
            host.rules = [target]  # Simulate ufw's documented comment replacement.
            self.assertRaises(cf.SyncError, engine._rollback, journal)
            self.assertEqual(host.rules, [target])
            self.assertEqual(host.actions, [])


    def test_external_revocation_during_fetch_is_not_reinstated(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FakeHost(); engine = cf.Engine(config(), tmp, host)
            engine.apply(engine.plan()['approve_token'])
            revoked = host.rules[0]
            before_action_count = len(host.actions)
            original_fetch = host.fetch
            def revoke_during_fetch():
                host.rules.remove(revoked)
                return original_fetch()
            with mock.patch.object(host, 'fetch', side_effect=revoke_during_fetch):
                self.assertRaises(cf.SyncError, engine.sync)
            self.assertNotIn(revoked, host.rules)
            self.assertEqual(len(host.actions), before_action_count)
            self.assertFalse((engine.private / 'journal.json').exists())

    def test_rollback_refuses_to_restore_unchanged_externally_revoked_allow(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = FakeHost(); engine = cf.Engine(config(), tmp, host)
            engine.apply(engine.plan()['approve_token'])
            state = engine.state(); revoked = host.rules[0]
            journal = {'version': 1, 'config_hash': cf.digest(engine.config), 'before': state['snapshot'], 'old_state': state,
                       'target_rules': state['owned_rules'], 'target_nginx': {}, 'new_state': None,
                       'addition_attempts': [], 'deletion_attempts': []}
            host.rules.remove(revoked)
            before_action_count = len(host.actions)
            self.assertRaises(cf.SyncError, engine._rollback, journal)
            self.assertNotIn(revoked, host.rules)
            self.assertEqual(len(host.actions), before_action_count)

    def test_status_policy_formats_are_conservative(self):
        for text, expected in [('18444/tcp DENY IN Anywhere', False), ('443/udp DENY IN Anywhere', False),
                               ('440:450/tcp REJECT IN Anywhere', True), ('Nginx Full DENY IN Anywhere', True),
                               ('Anywhere DENY OUT 192.0.2.1', False), ('Anywhere DENY FWD 192.0.2.1', False),
                               ('Anywhere SOMETHING 192.0.2.1', True)]:
            policy = cf.policy_from_status(text.split())
            self.assertEqual(cf.policy_may_match(policy, V4, 443), expected)
        self.assertTrue(cf.port_may_match('80,443/tcp', 443))
        self.assertFalse(cf.port_may_match('80,8443/tcp', 443))


if __name__ == '__main__':
    unittest.main()
