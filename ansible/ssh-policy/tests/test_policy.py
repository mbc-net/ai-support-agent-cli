import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).parents[1] / 'ssh-policy.py'
spec = importlib.util.spec_from_file_location('policy', path)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class PolicyTest(unittest.TestCase):
    def test_exact_ssh_rule_removed_other_service_preserved(self):
        raw = '*filter\n### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n-A ufw-user-input -p tcp --dport 22 -j ACCEPT\n\n### tuple ### allow tcp 443 0.0.0.0/0 any 0.0.0.0/0 in\n-A ufw-user-input -p tcp --dport 443 -j ACCEPT\nCOMMIT\n'
        clean, removed = policy.remove_ssh_rules(raw, 22)
        self.assertEqual(len(removed), 1)
        self.assertNotIn('--dport 22 ', clean)
        self.assertIn('--dport 443 ', clean)

    def test_ipv6_actual_ufw_chain_is_filtered(self):
        raw = '*filter\n### tuple ### allow tcp 22 ::/0 any ::/0 in\n-A ufw6-user-input -p tcp --dport 22 -j ACCEPT\nCOMMIT\n'
        clean, removed = policy.remove_ssh_rules(raw, 22)
        self.assertEqual(len(removed), 1)
        self.assertNotIn('--dport 22', clean)
        self.assertIn('COMMIT', clean)

    def test_kernel_forwarding_disabled_is_valid_when_live_forward_policy_is_drop(self):
        for routed in ['deny','disabled']:
            self.assertTrue(policy.supported_ufw_defaults('Status: active\nDefault: deny (incoming), allow (outgoing), '+routed+' (routed)'))
        self.assertFalse(policy.supported_ufw_defaults('Status: active\nDefault: allow (incoming), allow (outgoing), disabled (routed)'))

    def test_ambiguous_rules_rejected(self):
        for rule in ['-A ufw-user-input -j ACCEPT', '-A ufw-user-input -p tcp -m multiport --dports 22,443 -j ACCEPT', '-A ufw-user-input -p tcp --dport 22 -i eth0 -j ACCEPT']:
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                policy.remove_ssh_rules('*filter\n' + rule + '\nCOMMIT\n', 22)

    def test_source_validation_does_not_allow_empty_or_universal(self):
        for cidrs in [[], ['0.0.0.0/0'], ['::/0'], ['0.0.0.0/1','128.0.0.0/1'], ['::ffff:192.0.2.1/128']]:
            with self.subTest(cidrs=cidrs), self.assertRaises(ValueError):
                policy.validate_sources(cidrs, False)
        self.assertEqual(policy.validate_sources(['192.0.2.1/32', '2001:db8::/64'], False), ['192.0.2.1/32','2001:db8::/64'])
        self.assertEqual(policy.validate_sources([], True), [])

    def test_confirmation_rejects_stale_late_foreign_and_source_mismatch(self):
        import hashlib
        state = dict(status='pending', deadline=1000, attemptId='a', policyVersion=2, definitionVersion=3, nonceHash=hashlib.sha256(b'secret').hexdigest(), bootId='boot', machineId='machine', port=22, cidrs=['192.0.2.0/24'], release=False)
        request = dict(attemptId='a', policyVersion=2, definitionVersion=3, nonce='secret', machineId='machine')
        policy.validate_confirmation(state, request, '192.0.2.1 20000 192.0.2.2 22', 999, 'boot')
        for changes, conn, now, boot in [({'attemptId':'b'},'192.0.2.1 1 192.0.2.2 22',999,'boot'), ({},'192.0.3.1 1 192.0.2.2 22',999,'boot'), ({},'192.0.2.1 1 192.0.2.2 22',1000,'boot'), ({'nonce':'bad'},'192.0.2.1 1 192.0.2.2 22',999,'boot'), ({},'192.0.2.1 1 192.0.2.2 22',999,'reboot')]:
            with self.assertRaises(ValueError):
                policy.validate_confirmation(state, dict(request, **changes), conn, now, boot)


class DurableStateTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from unittest.mock import patch
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'attempts').mkdir()
        self.patch = patch.object(policy, 'ROOT', self.root)
        self.patch.start()
        self.state = dict(attemptId='attempt', policyId='policy', policyVersion=2,
                          definitionVersion=3, sshHostId='host', status='succeeded',
                          manageSources=True, release=False, machineId='machine',
                          observedSourceIp='192.0.2.1', deadline=1000)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_canonical_commit_survives_crash_before_history_projection(self):
        policy.save_json(self.root / 'attempt.json', self.state)
        policy.save_json(self.root / 'attempts/attempt.json', dict(self.state, status='pending'))
        self.assertEqual(policy.read_attempt('attempt')['status'], 'succeeded')
        policy.repair_terminal(policy.read_attempt('attempt'))
        self.assertEqual(policy.load_json(self.root / 'attempts/attempt.json')['status'], 'succeeded')
        self.assertEqual(policy.load_json(self.root / 'managed.json')['status'], 'succeeded')

    def test_release_commit_repairs_stale_managed_marker(self):
        state = dict(self.state, release=True)
        policy.save_json(self.root / 'managed.json', {'status':'pending'})
        policy.repair_terminal(state)
        self.assertFalse((self.root / 'managed.json').exists())

    def test_key_only_rejects_match_in_included_config_for_other_users(self):
        config = self.root / 'sshd_config'
        included = self.root / 'custom.conf'
        config.write_text('Include '+str(included)+'\nPubkeyAuthentication yes\n')
        included.write_text('Match User another-user\n  PasswordAuthentication yes\n  AuthenticationMethods any\n')
        with self.assertRaisesRegex(ValueError, 'Match'):
            policy.require_unconditional_ssh_auth(config)
        included.write_text('Match=User another-user\nPasswordAuthentication=yes\n')
        with self.assertRaisesRegex(ValueError, 'Match'):
            policy.require_unconditional_ssh_auth(config)
        config.write_text('Include='+str(included)+'\n')
        with self.assertRaisesRegex(ValueError, 'Match'):
            policy.require_unconditional_ssh_auth(config)
        included.write_text('# Match User comment-only\nPasswordAuthentication no\nX11Forwarding yes\n')
        policy.require_unconditional_ssh_auth(config)
        included.write_text('Include '+str(config)+'\n')
        with self.assertRaisesRegex(ValueError, 'Recursive'):
            policy.require_unconditional_ssh_auth(config)

    def test_total_apply_budget_times_out_subprocess_before_recovery_deadline(self):
        import sys
        import time
        from unittest.mock import patch
        with patch.object(policy, 'RUN_DEADLINE', time.monotonic() + 0.05):
            with self.assertRaises(policy.subprocess.TimeoutExpired):
                policy.run(sys.executable, '-c', 'import time; time.sleep(10)')
        with patch.object(policy, 'RUN_DEADLINE', time.monotonic() - 1):
            with self.assertRaises(TimeoutError):
                policy.run(sys.executable, '-c', 'print("must not run")')

    def test_recovery_gets_own_budget_after_apply_timeout(self):
        import time
        from unittest.mock import patch
        def restore(_):
            self.assertGreater(policy.RUN_DEADLINE, time.monotonic())
            self.assertLessEqual(policy.RUN_DEADLINE, time.monotonic() + policy.RECOVERY_BUDGET_SECONDS)
        with patch.object(policy, 'RUN_DEADLINE', 0), patch.object(policy, 'restore', side_effect=restore):
            result = policy.recover(dict(self.state,status='pending'),'apply budget exceeded')
        self.assertEqual(result['status'], 'recovered')
        self.assertLess(policy.APPLY_BUDGET_SECONDS + policy.RECOVERY_BUDGET_SECONDS, 600)

    def test_live_rules_reject_injected_rules_and_changed_default_for_both_families(self):
        from unittest.mock import patch
        for binary, prefix in [('iptables','ufw'),('ip6tables','ufw6')]:
            file = self.root / (prefix + '.rules')
            file.write_text('*filter\n-A '+prefix+'-user-input -p tcp --dport 443 -j ACCEPT\nCOMMIT\n')
            lines = ['-P INPUT DROP','-P OUTPUT ACCEPT','-P FORWARD DROP', '-A '+prefix+'-user-input -p tcp -m tcp --dport 443 -j ACCEPT']
            for direction in ['input','output','forward']:
                lines += ['-A '+prefix+'-before-'+direction+' -j '+prefix+'-user-'+direction,
                          '-A '+prefix+'-skip-to-policy-'+direction+' -j '+('ACCEPT' if direction=='output' else 'DROP')]
            for protocol in ['tcp','udp']:
                lines.append('-A '+prefix+'-track-output -p '+protocol+' -m conntrack --ctstate NEW -j ACCEPT')
            with patch.object(policy, 'run', return_value='\n'.join(lines)):
                policy.verify_live_rules(binary, [file])
            for chain in ['before-input','user-input','after-input']:
                drift = lines + ['-A '+prefix+'-'+chain+' -p tcp --dport 22 -j ACCEPT']
                with patch.object(policy, 'run', return_value='\n'.join(drift)), self.assertRaisesRegex(ValueError, 'Live UFW'):
                    policy.verify_live_rules(binary, [file])
            with patch.object(policy, 'run', return_value='\n'.join(lines).replace('-P INPUT DROP','-P INPUT ACCEPT')), self.assertRaisesRegex(ValueError, 'default policies'):
                policy.verify_live_rules(binary, [file])

    def test_canonical_ufw_aliases_preserve_semantics(self):
        self.assertEqual(policy.canonical_rule('-A ufw6-before-input -p icmpv6 --icmpv6-type neighbor-solicitation -j ACCEPT'),
                         policy.canonical_rule('-A ufw6-before-input -p ipv6-icmp -m icmp6 --icmpv6-type 135 -j ACCEPT'))
        self.assertEqual(policy.canonical_rule('-A ufw-user-limit -j REJECT'),
                         policy.canonical_rule('-A ufw-user-limit -j REJECT --reject-with icmp-port-unreachable'))

    def test_delayed_old_command_cannot_replace_newer_server_version(self):
        from unittest.mock import patch
        policy.save_json(self.root / 'attempt.json', self.state)
        request = dict(attemptId='old-delivery',policyId='policy',policyVersion=1,definitionVersion=2,
                       sshHostId='host',port=22,username='root',cidrs=['192.0.2.1/32'],release=False,
                       keyOnly=True,manageSources=True,nonceHash='a'*64)
        with patch.object(policy, 'preflight') as preflight, self.assertRaisesRegex(ValueError, 'newer SSH policy'):
            policy.apply(request,'192.0.2.1 1000 192.0.2.2 22')
        preflight.assert_not_called()

    def test_custom_sshd_startup_options_cannot_bypass_effective_auth_checks(self):
        from unittest.mock import patch
        proc = self.root / 'proc'
        daemon = proc / '4'
        daemon.mkdir(parents=True)
        (daemon / 'exe').symlink_to('/usr/sbin/sshd')
        (daemon / 'environ').write_bytes(b'SSHD_OPTS=\0')
        (daemon / 'cmdline').write_bytes(b'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups\0')
        defaults = self.root / 'ssh-defaults'
        defaults.write_text('# default distro options\nSSHD_OPTS=\n')
        properties = 'MainPID=4\nExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D $SSHD_OPTS ; }\nExecReload={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -t ; }\nExecReload={ path=/bin/kill ; argv[]=/bin/kill -HUP $MAINPID ; }\nDropInPaths=\nEnvironmentFiles=/etc/default/ssh (ignore_errors=yes)'
        with patch.object(policy, 'run', return_value=properties):
            policy.require_standard_ssh_service(proc, defaults)
            (daemon / 'environ').write_bytes(b'SSHD_OPTS=-o AuthenticationMethods=any -o PasswordAuthentication=yes\0')
            with self.assertRaisesRegex(ValueError, 'SSHD_OPTS'):
                policy.require_standard_ssh_service(proc, defaults)
            (daemon / 'environ').write_bytes(b'SSHD_OPTS=\0')
            (daemon / 'cmdline').write_bytes(b'sshd: /usr/sbin/sshd -D -o PasswordAuthentication=yes [listener] 0 of 10-100 startups\0')
            with self.assertRaisesRegex(ValueError, 'arguments'):
                policy.require_standard_ssh_service(proc, defaults)
            (daemon / 'cmdline').write_bytes(b'/usr/sbin/sshd\0-D\0')
            defaults.write_text('SSHD_OPTS="-f /other.conf"\n')
            with self.assertRaisesRegex(ValueError, 'SSHD_OPTS'):
                policy.require_standard_ssh_service(proc, defaults)
        with patch.object(policy, 'run', return_value=properties.replace('-D $SSHD_OPTS','-D -o PasswordAuthentication=yes')), self.assertRaisesRegex(ValueError, 'command-line'):
            policy.require_standard_ssh_service(proc, defaults)

    def test_noop_reload_and_custom_service_dropins_are_rejected(self):
        from unittest.mock import patch
        for properties, expected in [
            ('DropInPaths=/etc/systemd/system/ssh.service.d/custom.conf', 'drop-ins'),
            ('ExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D ; }\nExecReload={ path=/bin/true ; argv[]=/bin/true ; }', 'ExecReload'),
        ]:
            with patch.object(policy, 'run', return_value=properties), self.assertRaisesRegex(ValueError, expected):
                policy.require_standard_ssh_service()

    def test_auto_sync_only_accepts_exact_own_rules(self):
        state = dict(self.state, port=22, appliedRules=['managed rule'])
        policy.save_json(self.root / 'attempt.json', state)
        policy.save_json(self.root / 'managed.json', state)
        request = dict(policyId='policy',port=22)
        self.assertTrue(policy.managed_rules_match(request, ['managed rule']))
        self.assertFalse(policy.managed_rules_match(request, ['managed rule','foreign allow']))
        with self.assertRaises(ValueError):
            policy.managed_rules_match(dict(request,policyId='other'), ['managed rule'])
        policy.save_json(self.root / 'attempts/attempt.json', state)
        policy.save_json(self.root / 'attempt.json', dict(state,attemptId='failed-new-version',status='recovered',appliedRules=['rolled back']))
        self.assertTrue(policy.managed_rules_match(request, ['managed rule']))

    def test_different_policy_cannot_take_over_source_or_key_only_owner(self):
        policy.save_json(self.root / 'owner.json', dict(self.state, manageSources=False, keyOnly=True))
        policy.ensure_owner({'policyId':'policy'})
        with self.assertRaises(ValueError):
            policy.ensure_owner({'policyId':'other'})

    def test_source_release_retains_key_only_owner_until_all_management_disabled(self):
        state = dict(self.state, release=True, keyOnly=True)
        policy.save_json(self.root / 'managed.json', self.state)
        policy.repair_terminal(state)
        self.assertFalse((self.root / 'managed.json').exists())
        self.assertEqual(policy.load_json(self.root / 'owner.json')['policyId'], 'policy')
        policy.repair_terminal(dict(state, keyOnly=False))
        self.assertFalse((self.root / 'owner.json').exists())

    def test_recover_does_not_revert_committed_attempt(self):
        from unittest.mock import patch
        with patch.object(policy, 'restore') as restore:
            self.assertEqual(policy.recover(self.state, 'timer')['status'], 'succeeded')
            restore.assert_not_called()

    def test_restore_failure_is_attention_not_false_recovered(self):
        from unittest.mock import patch
        with patch.object(policy, 'restore', side_effect=RuntimeError('ufw failed')):
            result = policy.recover(dict(self.state,status='pending'), 'timer')
        self.assertEqual(result['status'], 'attention')
        self.assertIn('ufw failed', result['message'])
        self.assertEqual(policy.read_attempt('attempt')['status'], 'attention')

    def test_rollback_persists_receipt_and_cannot_be_reapplied(self):
        from unittest.mock import patch
        with patch.object(policy, 'restore') as restore:
            result = policy.recover(dict(self.state,status='pending'), 'timer')
        restore.assert_called_once()
        self.assertEqual(result['status'], 'recovered')
        self.assertEqual(policy.read_attempt('attempt')['status'], 'recovered')

if __name__ == '__main__':
    unittest.main()
