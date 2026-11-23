"""Host-free tests for the S0 container verifier (no root, no host commands)."""
import ast
import contextlib
import importlib.util
import io
import json
import os
import re
import runpy
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import yaml

HERE = Path(__file__).resolve().parents[1]
ROLE_FILES = HERE.parents[1] / 'roles/cloudfront_sync/files'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load(HERE / 's0_refusal_verify.py', 's0_refusal_verify_under_test')


class TestCase(unittest.TestCase):
    """Every test starts with fresh SIGTERM state (with_cleanup marks a failing run as unwinding).

    The install targets are read from the real install_targets.json before
    each test, so a test that patches Path.read_text never meets the lazy load.
    """

    def setUp(self):
        verify.install_targets()
        patcher = mock.patch.object(verify, 'TERMINATION', verify.Termination())
        patcher.start()
        self.addCleanup(patcher.stop)


def role_cli_help():
    # main() prints the usage for a sole --help and returns 0 before the root
    # check, the lock, the bundle or the config (argparse never parses it).
    return subprocess.run([sys.executable, '-I', '-B', str(ROLE_FILES / 'cloudfront-sync.py'), '--help'],
                          capture_output=True, text=True, timeout=30, check=True).stdout


class ClassificationTests(TestCase):
    def test_verifier_classification_matches_the_real_parser(self):
        subcommands = verify.parse_subcommands(role_cli_help())
        self.assertEqual(subcommands, verify.READ_ONLY_COMMANDS | frozenset(verify.REFUSED_ARGUMENTS))
        self.assertEqual(verify.classify(subcommands), sorted(verify.REFUSED_ARGUMENTS))

    def test_verifier_classification_matches_the_role_unit_tests(self):
        sys.path.insert(0, str(ROLE_FILES / 'tests'))
        try:
            role_tests = load(ROLE_FILES / 'tests/test_cloudfront_sync.py', 's0_role_cli_tests')
        finally:
            sys.path.remove(str(ROLE_FILES / 'tests'))
        self.assertEqual(verify.READ_ONLY_COMMANDS, role_tests.READ_ONLY_COMMANDS)
        self.assertEqual(set(verify.REFUSED_ARGUMENTS), set(role_tests.REFUSED_COMMANDS))

    def test_unclassified_or_missing_subcommands_fail(self):
        known = verify.READ_ONLY_COMMANDS | frozenset(verify.REFUSED_ARGUMENTS)
        self.assertRaises(verify.VerifyError, verify.classify, known | {'recover'})
        self.assertRaises(verify.VerifyError, verify.classify, known - {'sync'})

    def test_usage_parsing_rejects_ambiguous_help(self):
        for text in ('usage: x [-h]\n', 'usage: x {a,b} {c}\n', 'usage: x {a,a}\n'):
            with self.subTest(text=text):
                self.assertRaises(verify.VerifyError, verify.parse_subcommands, text)
        self.assertEqual(verify.parse_subcommands('usage: x {a,b-c}\n  {a,b-c}\n'), frozenset({'a', 'b-c'}))

    def test_refused_arguments_carry_the_secret_for_echo_detection(self):
        for name, build in verify.REFUSED_ARGUMENTS.items():
            with self.subTest(command=name):
                arguments = build('SECRET')
                self.assertEqual(name in ('apply', 'import', 'import-plan'), any('SECRET' in a for a in arguments))

    def test_refused_invocations_cover_missing_surplus_and_leading_options(self):
        for name in verify.REFUSED_ARGUMENTS:
            with self.subTest(command=name):
                shapes = verify.refused_invocations(name, 'SECRET')
                required = tuple(verify.REFUSED_ARGUMENTS[name]('SECRET'))
                self.assertEqual(len(shapes), len(set(shapes)))
                self.assertEqual(shapes[0], ((), required))
                self.assertIn(((), ()), shapes)  # no option at all (required option missing)
                self.assertIn(((), (*required, '--unexpected=SECRET', 'SECRET')), shapes)
                leading = [prefix for prefix, extra in shapes if prefix]
                self.assertEqual(len(leading), 1)
                self.assertTrue(all('SECRET' in ' '.join(prefix) for prefix in leading))
                self.assertTrue(all(arg.startswith('--') for arg in leading[0][::2]))

    def test_every_refused_invocation_refuses_identically_on_the_real_cli(self):
        # The real CLI refuses from the raw subcommand token, before the root
        # check and any host access, so this runs safely unprivileged.
        for name in sorted(verify.REFUSED_ARGUMENTS):
            for prefix, extra in verify.refused_invocations(name, 'cf-s0-unit-secret'):
                with self.subTest(command=name, prefix=prefix, extra=extra):
                    done = subprocess.run([sys.executable, '-I', '-B', str(ROLE_FILES / 'cloudfront-sync.py'),
                                           *prefix, name, *extra], capture_output=True, text=True, timeout=30)
                    result = {'command': name, 'rc': done.returncode, 'stdout': done.stdout, 'stderr': done.stderr}
                    verify.check_refusal(result)
                    verify.check_argv_secret_not_echoed([result], 'cf-s0-unit-secret')


class ResultCheckTests(TestCase):
    def result(self, rc, stdout='', stderr=''):
        return {'command': 'plan', 'rc': rc, 'stdout': stdout, 'stderr': stderr}

    def test_refusal_requires_exact_code_empty_stdout_and_exit_one(self):
        verify.check_refusal(self.result(1, stderr='{"error":"runtime_actor_not_connected"}\n'))
        for bad in (self.result(0, stderr='{"error":"runtime_actor_not_connected"}\n'),
                    self.result(1, stdout='{}', stderr='{"error":"runtime_actor_not_connected"}\n'),
                    self.result(1, stderr='{"error":"sync_failed"}\n'),
                    self.result(1, stderr='{"error": "runtime_actor_not_connected"}\n')):
            with self.subTest(bad=bad):
                self.assertRaises(verify.VerifyError, verify.check_refusal, bad)

    def test_sanitized_failure_is_exact(self):
        verify.check_sanitized_failure(self.result(1, stderr='{"error":"sync_failed"}\n'))
        self.assertRaises(verify.VerifyError, verify.check_sanitized_failure,
                          self.result(1, stderr='{"error":"runtime_actor_not_connected"}\n'))

    def test_json_expectation_is_exact_including_field_set_and_generation(self):
        expected = {'runtime_ready': False}
        good = json.dumps({'generation_id': 'g', 'runtime_ready': False})
        self.assertEqual(verify.check_json(self.result(0, good), expected, 'g')['generation_id'], 'g')
        for stdout, generation in ((good, 'other'),
                                   (json.dumps({'generation_id': 'g', 'runtime_ready': True}), 'g'),
                                   (json.dumps({'generation_id': 'g', 'runtime_ready': False, 'extra': 1}), 'g'),
                                   ('not json', 'g'), ('[]', 'g')):
            with self.subTest(stdout=stdout):
                self.assertRaises(verify.VerifyError, verify.check_json, self.result(0, stdout), expected, generation)
        self.assertRaises(verify.VerifyError, verify.check_json, self.result(0, good, 'warning'), expected, 'g')

    def test_json_expectation_compares_types_strictly(self):
        # JSON true is not 1, false is not 0 and 1.0 is not 1, also nested.
        cases = (({'cohort_verified': True}, {'cohort_verified': 1}),
                 ({'runtime_ready': False}, {'runtime_ready': 0}),
                 ({'count': 1}, {'count': True}), ({'count': 1}, {'count': 1.0}),
                 ({'firewall': {'status': 'failure', 'ok': False}}, {'firewall': {'status': 'failure', 'ok': 0}}))
        for expected, reported in cases:
            with self.subTest(reported=reported):
                stdout = json.dumps({'generation_id': 'g', **reported})
                with self.assertRaises(verify.VerifyError) as caught:
                    verify.check_json(self.result(0, stdout), expected, 'g')
                self.assertIn('differs from the fixed S0 expectation: ' + next(iter(expected)), str(caught.exception))
                stdout = json.dumps({'generation_id': 'g', **expected})
                self.assertEqual(verify.check_json(self.result(0, stdout), expected, 'g')['generation_id'], 'g')
        self.assertRaises(verify.VerifyError, verify.check_json,
                          self.result(0, json.dumps({'generation_id': 'g', **{k: 1 for k in verify.EXPECTED_INSPECT_STATE}})),
                          {**verify.EXPECTED_INSPECT_STATE, 'runtime_ready': True}, 'g')

    def test_argv_secret_in_any_stream_fails(self):
        verify.check_argv_secret_not_echoed([self.result(1, 'clean', 'clean')], 'SECRET')
        for result in (self.result(1, 'xSECRETx'), self.result(1, stderr='SECRET')):
            self.assertRaises(verify.VerifyError, verify.check_argv_secret_not_echoed, [result], 'SECRET')

    def test_failure_messages_never_include_command_output(self):
        with self.assertRaises(verify.VerifyError) as caught:
            verify.check_refusal(self.result(0, stdout='SECRET-OUTPUT'))
        self.assertNotIn('SECRET-OUTPUT', str(caught.exception))


class CommandAndFirewallTests(TestCase):
    def test_run_failures_name_only_the_subcommand_never_argv(self):
        for error in (subprocess.TimeoutExpired(['cli', '--approve=SECRET'], 60), OSError('exec --approve=SECRET')):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(verify.subprocess, 'run', side_effect=error):
                    with self.assertRaises(verify.VerifyError) as caught:
                        verify.run(['cli', 'apply', '--approve=SECRET'], 'apply')
                self.assertEqual(str(caught.exception), 'command failed: apply')
                self.assertIsNone(caught.exception.__cause__)
                self.assertTrue(caught.exception.__suppress_context__)

    def test_run_takes_a_pending_sigterm_before_starting_a_command(self):
        verify.terminate(signal.SIGTERM, None)
        with mock.patch.object(verify.subprocess, 'run', side_effect=AssertionError('started')):
            with self.assertRaises(SystemExit):
                verify.run(['iptables-save'], 'iptables-save')

    def test_run_unblocks_sigterm_only_while_the_command_runs(self):
        calls = []
        def mask(how, signals):
            calls.append((how, frozenset(signals)))
            return {signal.SIGTERM}
        def started(args, **kwargs):
            calls.append(('run', tuple(args)))
            return subprocess.CompletedProcess(args, 0, 'out', 'err')
        with mock.patch.object(verify.signal, 'pthread_sigmask', side_effect=mask), \
             mock.patch.object(verify.subprocess, 'run', side_effect=started) as run:
            result = verify.run(['nft', 'list', 'ruleset'], 'nft')
        self.assertEqual(calls, [(signal.SIG_UNBLOCK, verify.TERMINATION_SIGNALS), ('run', ('nft', 'list', 'ruleset')),
                                 (signal.SIG_SETMASK, frozenset({signal.SIGTERM}))])
        self.assertNotIn('preexec_fn', run.call_args.kwargs)
        self.assertEqual((result.returncode, result.stdout), (0, 'out'))
        # The previous mask is restored however the command ends.
        for error in (subprocess.TimeoutExpired(['nft'], 60), OSError()):
            calls.clear()
            with self.subTest(error=type(error).__name__), \
                 mock.patch.object(verify.signal, 'pthread_sigmask', side_effect=mask), \
                 mock.patch.object(verify.subprocess, 'run', side_effect=error):
                self.assertRaises(verify.VerifyError, verify.run, ['nft'], 'nft')
            self.assertEqual(calls[-1], (signal.SIG_SETMASK, frozenset({signal.SIGTERM})))

    def test_iptables_chain_counters_and_comments_are_ignored(self):
        first = '# Generated by iptables-save v1.8 on Mon\n*filter\n:INPUT DROP [12:3456]\n:ufw-user-input - [0:0]\n-A INPUT -j ufw-user-input\nCOMMIT\n'
        second = '# Generated by iptables-save v1.8 on Tue\n*filter\n:INPUT DROP [99:1]\n:ufw-user-input - [7:8]\n-A INPUT -j ufw-user-input\nCOMMIT\n'
        self.assertEqual(verify.normalize_iptables_save(first), verify.normalize_iptables_save(second))
        self.assertNotIn('[', verify.normalize_iptables_save(first))
        changed = second.replace(':INPUT DROP', ':INPUT ACCEPT')
        self.assertNotEqual(verify.normalize_iptables_save(first), verify.normalize_iptables_save(changed))
        rule = second.replace('-j ufw-user-input', '-s 192.0.2.0/24 -j ACCEPT')
        self.assertNotEqual(verify.normalize_iptables_save(first), verify.normalize_iptables_save(rule))

    def test_nft_volatile_values_are_ignored_but_rules_are_not(self):
        first = 'table ip filter {\n\tchain INPUT { # handle 1\n\t\ttcp dport 22 counter packets 5 bytes 300 accept # handle 7\n\t}\n}'
        second = first.replace('packets 5 bytes 300', 'packets 9 bytes 900').replace('# handle 7', '# handle 8')
        self.assertEqual(verify.normalize_nft(first), verify.normalize_nft(second))
        self.assertNotEqual(verify.normalize_nft(first), verify.normalize_nft(first.replace('dport 22', 'dport 443')))
        # A counter that starts the rule line (after tabs), as in ufw's
        # "counter packets N bytes M jump ufw-before-input", is volatile too.
        leading = 'table ip filter {\n\tchain INPUT {\n\t\tcounter packets 96 bytes 5220 jump ufw-before-input\n\t}\n}'
        self.assertEqual(verify.normalize_nft(leading),
                         verify.normalize_nft(leading.replace('packets 96 bytes 5220', 'packets 102 bytes 5520')))
        self.assertNotEqual(verify.normalize_nft(leading),
                            verify.normalize_nft(leading.replace('ufw-before-input', 'ufw-after-input')))
        # Only the numbers are dropped: the counter statement itself stays, so
        # adding or removing a counter is a ruleset change.
        self.assertEqual(verify.normalize_nft(leading).splitlines()[2], '\t\tcounter jump ufw-before-input')
        self.assertIn('tcp dport 22 counter accept', verify.normalize_nft(first))
        for text in (first, leading):
            without = text.replace(' counter packets 5 bytes 300', '').replace('counter packets 96 bytes 5220 ', '')
            self.assertNotEqual(without, text)
            self.assertNotEqual(verify.normalize_nft(without), verify.normalize_nft(text))
        added = first.replace('tcp dport 22 counter', 'tcp dport 22 counter packets 1 bytes 2 counter')
        self.assertNotEqual(verify.normalize_nft(added), verify.normalize_nft(first))

    LEGACY = {'iptables-legacy-save': '/usr/sbin/iptables-legacy-save',
              'ip6tables-legacy-save': '/usr/sbin/ip6tables-legacy-save'}

    def test_firewall_snapshot_includes_nft_ruleset(self):
        calls = []
        def fake(args, name, timeout=60):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, 'x\n', '')
        with mock.patch.object(verify, 'run', side_effect=fake), \
             mock.patch.object(verify.shutil, 'which', side_effect=self.LEGACY.get):
            self.assertEqual(set(verify.firewall_rules()), {'iptables-save', 'ip6tables-save', 'nft',
                                                            'iptables-legacy-save', 'ip6tables-legacy-save'})
        self.assertIn(['nft', 'list', 'ruleset'], calls)
        with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'secret')), \
             mock.patch.object(verify.shutil, 'which', side_effect=self.LEGACY.get):
            with self.assertRaisesRegex(verify.VerifyError, '^iptables-save failed$'):
                verify.firewall_rules()

    def test_legacy_rulesets_are_compared_by_resolved_path_and_normalized(self):
        dumps = {'iptables-save': '*filter\n:INPUT ACCEPT [1:2]\nCOMMIT\n',
                 'ip6tables-save': '*filter\nCOMMIT\n', 'nft': 'table inet f {\n}',
                 'iptables-legacy-save': '# Generated by iptables-legacy-save on Mon\n*filter\n:INPUT ACCEPT [5:6]\nCOMMIT\n',
                 'ip6tables-legacy-save': '# Generated on Mon\n*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n'}
        calls = []
        def fake(args, name, timeout=60):
            calls.append((name, list(args)))
            return subprocess.CompletedProcess(args, 0, dumps[name], '')
        def rules():
            calls.clear()
            with mock.patch.object(verify, 'run', side_effect=fake), \
                 mock.patch.object(verify.shutil, 'which', side_effect=self.LEGACY.get):
                return verify.firewall_rules()
        first = rules()
        self.assertIn(('iptables-legacy-save', ['/usr/sbin/iptables-legacy-save']), calls)
        self.assertIn(('ip6tables-legacy-save', ['/usr/sbin/ip6tables-legacy-save']), calls)
        # Comments and counters change by themselves: not a change.
        dumps['iptables-legacy-save'] = dumps['iptables-legacy-save'].replace('Mon', 'Tue').replace('[5:6]', '[9:9]')
        dumps['ip6tables-legacy-save'] = dumps['ip6tables-legacy-save'].replace('[0:0]', '[3:4]')
        self.assertEqual(rules(), first)
        # A legacy rule or policy change is.
        for name, change in (('iptables-legacy-save', ('COMMIT', '-A INPUT -p tcp --dport 443 -j ACCEPT\nCOMMIT')),
                             ('ip6tables-legacy-save', ('INPUT ACCEPT', 'INPUT DROP'))):
            with self.subTest(dump=name):
                original = dumps[name]
                dumps[name] = original.replace(*change)
                changed = rules()
                self.assertEqual(verify.changed_keys(first, changed), [name])
                dumps[name] = original
        # A present legacy command that fails is an error, never 'absent'.
        def failing(args, name, timeout=60):
            return subprocess.CompletedProcess(args, 1 if name == 'ip6tables-legacy-save' else 0, '', 'secret')
        with mock.patch.object(verify, 'run', side_effect=failing), \
             mock.patch.object(verify.shutil, 'which', side_effect=self.LEGACY.get):
            self.assertRaisesRegex(verify.VerifyError, '^ip6tables-legacy-save failed$', verify.firewall_rules)

    def test_an_absent_legacy_command_is_the_distinct_value_absent(self):
        def fake(args, name, timeout=60):
            if 'legacy' in name:
                raise AssertionError('an absent command was run')
            return subprocess.CompletedProcess(args, 0, '*filter\nCOMMIT\n', '')
        installed = dict(self.LEGACY)
        def rules():
            with mock.patch.object(verify, 'run', side_effect=fake if not installed else
                                   lambda args, name, timeout=60: subprocess.CompletedProcess(args, 0, '*filter\nCOMMIT\n', '')), \
                 mock.patch.object(verify.shutil, 'which', side_effect=installed.get):
                return verify.firewall_rules()
        present = rules()
        del installed['ip6tables-legacy-save']
        partial = rules()
        self.assertEqual(partial['ip6tables-legacy-save'], 'absent')
        self.assertNotEqual(present['iptables-legacy-save'], 'absent')
        # Presence must agree before and after: appearing or disappearing is a change.
        self.assertEqual(verify.changed_keys(present, partial), ['ip6tables-legacy-save'])
        installed.clear()
        absent = rules()
        self.assertEqual({absent[name] for name in self.LEGACY}, {'absent'})
        self.assertEqual(verify.changed_keys(absent, absent), [])


class InstallTargetTests(TestCase):
    def test_shared_target_list_covers_runtime_monitor_and_both_unit_pairs(self):
        names = {str(path) for path in verify.install_targets()}
        self.assertTrue({'/usr/local/libexec/cloudfront-sync', '/etc/cloudfront-sync', '/var/lib/cloudfront-sync',
                         '/usr/share/cloudfront-sync', '/etc/systemd/system/cloudfront-sync.service',
                         '/etc/systemd/system/cloudfront-sync.timer',
                         '/etc/systemd/system/cloudfront-integrity-guard.service',
                         '/etc/systemd/system/cloudfront-integrity-guard.timer'} <= names)

    def test_converge_reads_the_same_target_file(self):
        """converge.yml's stat loop is evaluated by ansible-core to the verifier's list.

        ansible-core is installed in the CI static job before these tests
        (.github/workflows/ansible-roles.yml).
        """
        from ansible.parsing.dataloader import DataLoader
        from ansible.plugins.loader import init_plugin_loader
        from ansible.template import Templar, trust_as_template
        init_plugin_loader()
        tasks = [task for play in yaml.safe_load((HERE / 'converge.yml').read_text()) for task in play['tasks']]
        stats = [task for task in tasks if 'ansible.builtin.stat' in task]
        self.assertEqual(len(stats), 1)
        stat_task = stats[0]
        self.assertEqual(stat_task['ansible.builtin.stat'], {'path': '{{ item }}'})
        self.assertNotIn('with_items', stat_task)
        templar = Templar(loader=DataLoader(), variables={'playbook_dir': str(HERE)})
        looped = templar.template(trust_as_template(stat_task['loop']))
        self.assertEqual([Path(item) for item in looped], list(verify.install_targets()))
        # The registered results are what the following assertion requires to be absent.
        register = stat_task['register']
        following = tasks[tasks.index(stat_task) + 1]['ansible.builtin.assert']['that']
        self.assertEqual(following, [register + ".results | selectattr('stat.exists') | list | length == 0"])
        copies = [task for task in verify_tasks() if task.get('loop') == ['s0_refusal_verify.py', 'disposable_marker.py',
                                                                          'install_targets.json']]
        self.assertEqual(len(copies), 1)

    def test_verify_work_directory_is_fresh_and_always_removed(self):
        """verify.yml recreates its work directory and removes it on success and failure."""
        plays = yaml.safe_load((HERE / 'verify.yml').read_text())
        self.assertEqual(len(plays), 1)
        workdir = plays[0]['vars']['cloudfront_sync_s0_workdir']
        self.assertEqual(workdir, '/root/cloudfront-sync-s0-verify')
        self.assertEqual(len(plays[0]['tasks']), 1)
        block = plays[0]['tasks'][0]
        absent = {'path': '{{ cloudfront_sync_s0_workdir }}', 'state': 'absent'}
        # First step removes a leftover of an interrupted run; always removes it.
        self.assertEqual(block['block'][0]['ansible.builtin.file'], absent)
        self.assertEqual([task['ansible.builtin.file'] for task in block['always']], [absent])
        self.assertNotIn('rescue', block)
        # Every step that uses the work directory (all but the report check)
        # runs inside the block, after the fresh start.
        steps = block['block'][1:]
        self.assertTrue(all('cloudfront_sync_s0_workdir' in json.dumps(task) for task in steps[:-1]))
        self.assertIn('ansible.builtin.command', steps[-2])
        self.assertIn('ansible.builtin.assert', steps[-1])

    def test_malformed_target_file_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'targets.json'
            for value in ({}, {'install_targets': []}, {'install_targets': ['relative']},
                          {'install_targets': ['/a', '/a']}, {'install_targets': ['/etc/cloudfront-sync']}):
                with self.subTest(value=value):
                    path.write_text(json.dumps(value))
                    self.assertRaises(verify.VerifyError, verify.load_install_targets, path)
            for raw in ('not json', '[1]', '{"install_targets": ["/a", 1]}'):
                with self.subTest(raw=raw):
                    path.write_text(raw)
                    self.assertRaisesRegex(verify.VerifyError, '^install_targets.json is (unreadable|malformed)$',
                                           verify.load_install_targets, path)
            self.assertRaisesRegex(verify.VerifyError, '^install_targets.json is unreadable$',
                                   verify.load_install_targets, Path(directory) / 'missing.json')

    def verifier_copy(self, directory, targets):
        """The verifier and its marker helper in ``directory``; install_targets.json only if given."""
        for name in ('s0_refusal_verify.py', 'disposable_marker.py'):
            (Path(directory) / name).write_bytes((HERE / name).read_bytes())
        if targets is not None:
            (Path(directory) / 'install_targets.json').write_text(targets)
        return Path(directory) / 's0_refusal_verify.py'

    def test_import_reads_no_target_file(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = load(self.verifier_copy(directory, None), 's0_refusal_verify_without_targets')
            self.assertEqual(copy._INSTALL_TARGETS, [])
            self.assertTrue(callable(copy.parse_subcommands))
            self.assertRaisesRegex(copy.VerifyError, '^install_targets.json is unreadable$', copy.install_targets)
            # Once the file exists, the first use reads it.
            (Path(directory) / 'install_targets.json').write_bytes((HERE / 'install_targets.json').read_bytes())
            self.assertEqual(copy.install_targets(), verify.install_targets())

    def test_targets_are_read_once_on_first_use(self):
        with mock.patch.object(verify, '_INSTALL_TARGETS', []), \
             mock.patch.object(verify, 'load_install_targets', return_value=(verify.BUNDLE_DIR,)) as loaded:
            self.assertEqual(verify.install_targets(), (verify.BUNDLE_DIR,))
            self.assertEqual(verify.staged_roots(), (verify.BUNDLE_DIR, verify.SECRET_DIR, verify.NGINX_FIXTURE_TOP,
                                                     verify.NGINX_INCLUDE))
        loaded.assert_called_once_with()

    def test_main_reads_the_targets_first_and_a_bad_file_is_a_fixed_failure_report(self):
        with mock.patch.object(verify, '_INSTALL_TARGETS', []), \
             mock.patch.object(verify, 'load_install_targets', side_effect=verify.VerifyError('install_targets.json is malformed')), \
             mock.patch.object(verify, 'check_environment', side_effect=AssertionError('environment first')):
            self.assertRaisesRegex(verify.VerifyError, 'malformed', verify.main, ['s0_refusal_verify.py', '/unused'])
        # Run as __main__ (in this process, no child): the fixed failure report, exit 1.
        for name, targets, reason in (('missing', None, 'install_targets.json is unreadable'),
                                      ('malformed', '{"install_targets": []}', 'install_targets.json is malformed')):
            with self.subTest(case=name), tempfile.TemporaryDirectory() as directory:
                script = self.verifier_copy(directory, targets)
                error = io.StringIO()
                with mock.patch.object(sys, 'argv', [str(script), '/unused']), contextlib.redirect_stderr(error), \
                     contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit) as exited:
                    runpy.run_path(str(script), run_name='__main__')
                self.assertEqual(exited.exception.code, 1)
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(json.loads(error.getvalue()), {'s0_checks': 'failed', 'reason': reason})


def verify_tasks():
    """Every task of verify.yml, including those in block/rescue/always sections."""
    pending = [task for play in yaml.safe_load((HERE / 'verify.yml').read_text()) for task in play['tasks']]
    tasks = []
    while pending:
        task = pending.pop(0)
        tasks.append(task)
        for section in ('block', 'rescue', 'always'):
            pending.extend(task.get(section, ()))
    return tasks


class StagingTests(TestCase):
    def test_exclusive_creation_modes_and_cleanup_in_reverse(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'keep').write_text('not ours')
            staging = verify.Staging()
            staging.mkdir(root / 'a' / 'b', 0o755)
            staging.write(root / 'a' / 'b' / 'secret', b'value', 0o600)
            staging.write(root / 'a' / 'b' / 'config', b'{}', 0o640)
            self.assertEqual(os.stat(root / 'a').st_mode & 0o777, 0o755)
            self.assertEqual(os.stat(root / 'a' / 'b' / 'secret').st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(root / 'a' / 'b' / 'config').st_mode & 0o777, 0o640)
            self.assertEqual((root / 'a' / 'b' / 'secret').read_bytes(), b'value')
            self.assertEqual(staging.cleanup(), [])
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['keep'])

    def test_existing_paths_and_symlinks_are_errors_not_adopted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'dir').mkdir()
            (root / 'file').write_text('old')
            (root / 'link').symlink_to(root / 'file')
            staging = verify.Staging()
            self.assertRaisesRegex(verify.VerifyError, 'already present', staging.mkdir, root / 'dir', 0o755)
            for name in ('file', 'link'):
                self.assertRaisesRegex(verify.VerifyError, 'already present', staging.write, root / name, b'x', 0o600)
            self.assertEqual((root / 'file').read_text(), 'old')
            self.assertEqual(staging.created, [])

    def test_paths_are_recorded_before_creation_and_withdrawn_when_creation_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging = verify.Staging()
            real_mkdir, real_open = os.mkdir, os.open
            seen = []
            def mkdir(path, mode=0o777):
                seen.append(('create', Path(path), Path(path) in staging.created))
                return real_mkdir(path, mode)
            def opener(path, flags, mode=0o777):
                seen.append(('create', Path(path), Path(path) in staging.created))
                return real_open(path, flags, mode)
            def checkpoint():
                seen.append(('checkpoint',))
            with mock.patch.object(verify.os, 'mkdir', mkdir), mock.patch.object(verify.os, 'open', opener), \
                 mock.patch.object(verify, 'checkpoint', side_effect=checkpoint):
                staging.mkdir(root / 'a' / 'b', 0o755)
                staging.write(root / 'a' / 'b' / 'f', b'x', 0o600)
            # Recorded before each creation; the only safe point follows it.
            self.assertEqual(seen, [('create', root / 'a', True), ('checkpoint',), ('create', root / 'a' / 'b', True),
                                    ('checkpoint',), ('create', root / 'a' / 'b' / 'f', True), ('checkpoint',)])
            for error in (FileExistsError(), PermissionError()):
                with self.subTest(error=type(error).__name__):
                    with mock.patch.object(verify.os, 'mkdir', side_effect=error), \
                         mock.patch.object(verify.os, 'open', side_effect=error):
                        self.assertRaises(verify.VerifyError, staging.mkdir, root / 'c', 0o755)
                        self.assertRaises(verify.VerifyError, staging.write, root / 'd', b'x', 0o600)
                    self.assertEqual(staging.created, [root / 'a', root / 'a' / 'b', root / 'a' / 'b' / 'f'])
            self.assertEqual(staging.cleanup(), [])
            self.assertEqual(list(root.iterdir()), [])

    def test_sigterm_right_after_creation_leaves_the_path_recorded_and_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_mkdir, real_open = os.mkdir, os.open
            targets = {root / 'dir', root / 'file'}
            def mkdir(path, *args, **kwargs):
                real_mkdir(path, *args, **kwargs)
                if Path(path) in targets:
                    verify.terminate(signal.SIGTERM, None)   # arrives right after the syscall
            def opener(path, *args, **kwargs):
                fd = real_open(path, *args, **kwargs)
                if Path(path) in targets:
                    verify.terminate(signal.SIGTERM, None)
                return fd
            for name, call in (('mkdir', lambda s: s.mkdir(root / 'dir', 0o755)),
                               ('write', lambda s: s.write(root / 'file', b'data', 0o600))):
                with self.subTest(step=name):
                    verify.TERMINATION.__init__()
                    staging = verify.Staging()
                    with mock.patch.object(verify.os, 'mkdir', mkdir), mock.patch.object(verify.os, 'open', opener):
                        with self.assertRaises(SystemExit) as caught:
                            verify.with_cleanup(staging, lambda: call(staging))
                    self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
                    self.assertEqual(list(root.iterdir()), [])

    def test_concurrent_mkdir_becomes_verify_error(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = verify.Staging()
            with mock.patch.object(verify.os, 'mkdir', side_effect=FileExistsError()):
                self.assertRaisesRegex(verify.VerifyError, 'concurrently', staging.mkdir, Path(directory) / 'x', 0o755)

    def test_record_created_requires_an_existing_unrecorded_path_and_cleanup_removes_it(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'cloudfront-sync.lock'
            staging = verify.Staging()
            self.assertRaises(verify.VerifyError, staging.record_created, lock)
            lock.write_bytes(b'')
            staging.record_created(lock)
            self.assertRaises(verify.VerifyError, staging.record_created, lock)
            self.assertEqual(staging.cleanup(), [])
            self.assertFalse(lock.exists())

    def test_remove_only_staged_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = verify.Staging()
            self.assertRaises(verify.VerifyError, staging.remove, Path(directory))
            staging.mkdir(Path(directory) / 'state', 0o755)
            staging.remove(Path(directory) / 'state')
            self.assertFalse((Path(directory) / 'state').exists())
            self.assertEqual(staging.created, [])

    def test_failure_still_cleans_up_and_reports_leftovers(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = verify.Staging()
            def body():
                staging.write(Path(directory) / 'secret', b'x', 0o600)
                raise verify.VerifyError('boom')
            with self.assertRaisesRegex(verify.VerifyError, '^boom$'):
                verify.with_cleanup(staging, body)
            self.assertEqual(list(Path(directory).iterdir()), [])
            leftover = mock.Mock(cleanup=mock.Mock(return_value=['/etc/cloudfront-sync']))
            with self.assertRaisesRegex(verify.VerifyError, 'boom; fixture cleanup left: /etc/cloudfront-sync'):
                verify.with_cleanup(leftover, mock.Mock(side_effect=verify.VerifyError('boom')))
            with self.assertRaisesRegex(verify.VerifyError, '^RuntimeError; fixture cleanup left'):
                verify.with_cleanup(leftover, mock.Mock(side_effect=RuntimeError('--approve=SECRET')))
            self.assertEqual(verify.with_cleanup(verify.Staging(), lambda: {'ok': 1}), {'ok': 1})


class FakeStaging:
    """Records staging calls; the state directory toggles the fake host."""

    def __init__(self, host):
        self.host, self.events, self.created = host, host.events, []

    def mkdir(self, path, mode):
        self.events.append(('mkdir', str(path), mode)); self.created.append(Path(path))
        if Path(path) == verify.STATE_DIR:
            self.host.state_dir = True

    def write(self, path, data, mode):
        self.events.append(('write', str(path), mode)); self.created.append(Path(path))
        self.host.written[str(path)] = bytes(data)

    def record_created(self, path):
        self.events.append(('record_created', str(path))); self.created.append(Path(path))

    def remove(self, path):
        self.events.append(('remove', str(path))); self.created.remove(Path(path))
        if Path(path) == verify.STATE_DIR:
            self.host.state_dir = False

    def cleanup(self):
        self.events.append(('cleanup',))
        if Path(verify.LOCK) in self.created:
            self.host.lock = False
        self.host.state_dir = False
        self.created = []
        return []


class FakeHost:
    """Fake CLI and host snapshot that behave like the S0 container."""
    GENERATION = 'a' * 64

    def __init__(self, lock=False, cohort_creates_lock=True, phase_b_stdout=None, cohort_failure=None,
                 after_invoke=None):
        self.events, self.written = [], {}
        self.cohort_failure = cohort_failure
        self.lock, self.state_dir = lock, False
        self.cohort_creates_lock = cohort_creates_lock
        self.phase_b_stdout = phase_b_stdout
        # after_invoke(host, index, subcommand): a hook run after each CLI call.
        self.after_invoke, self.invocations = after_invoke, 0
        self.ufw, self.secret_dir_identity = 'ufw', 'dir'

    def snapshot(self, around_nginx_phase=False):
        self.events.append(('full_snapshot', around_nginx_phase) if around_nginx_phase else ('full_snapshot',))
        return {'/etc/ufw': self.ufw, str(verify.LOCK): 'lock' if self.lock else 'absent',
                str(verify.STATE_DIR): 'dir' if self.state_dir else 'absent'}

    def light(self):
        self.events.append(('light_snapshot',))
        return {str(verify.LOCK): 'lock' if self.lock else 'absent',
                str(verify.STATE_DIR): 'dir' if self.state_dir else 'absent',
                str(verify.SECRET_DIR): self.secret_dir_identity}

    def require_lock(self):
        self.events.append(('require_lock', self.lock))
        if not self.lock:
            raise verify.VerifyError('CLI lock file is absent')

    def run(self, args, name, timeout=60):
        """Stands in for run(), keeping its contract: checkpoint() first."""
        verify.checkpoint()
        if name == '--help':
            self.events.append(('run', name))
            return subprocess.CompletedProcess(args, 0, role_cli_help(), '')
        # The real invoke() calls run([python, CLI, *prefix, subcommand, *extra], subcommand).
        self.assertCli(args, name)
        result = self.cli(name)
        return subprocess.CompletedProcess(args, result['rc'], result['stdout'], result['stderr'])

    @staticmethod
    def assertCli(args, name):
        if args[:2] != ['/usr/bin/python3', str(verify.CLI)] or name not in args[2:]:
            raise AssertionError('unexpected command: %r' % (args,))

    def cli(self, subcommand):
        self.events.append(('invoke', subcommand, self.state_dir))
        self.invocations += 1
        if self.after_invoke:
            self.after_invoke(self, self.invocations, subcommand)
        if subcommand == 'verify-cohort' and self.cohort_failure:
            # The CLI created the lock, then the call timed out / was terminated.
            self.lock = self.lock or self.cohort_creates_lock
            raise self.cohort_failure
        def result(rc, stdout='', stderr=''):
            return {'command': subcommand, 'rc': rc, 'stdout': stdout, 'stderr': stderr}
        if subcommand == 'verify-cohort':
            self.lock = self.lock or self.cohort_creates_lock
            return result(0, json.dumps({'generation_id': self.GENERATION, 'cohort_verified': True,
                                         'runtime_ready': False, 'policy_verified': False}))
        if subcommand not in verify.READ_ONLY_COMMANDS:
            return result(1, stderr=verify.REFUSAL_STDERR)
        if not self.lock or not self.state_dir:
            return result(1, stderr=verify.SANITIZED_FAILURE_STDERR)
        expected = verify.EXPECTED_INSPECT_STATE if subcommand == 'inspect-state' else verify.EXPECTED_INSPECT_RUNTIME
        stdout = self.phase_b_stdout or json.dumps({'generation_id': self.GENERATION, **expected})
        return result(0, stdout)

    def patches(self):
        return (mock.patch.object(verify, 'host_snapshot', side_effect=self.snapshot),
                mock.patch.object(verify, 'light_snapshot', side_effect=self.light),
                mock.patch.object(verify, 'require_lock_file', side_effect=self.require_lock),
                mock.patch.object(verify, 'run', side_effect=self.run),
                mock.patch.object(verify, 'stage_fixture', side_effect=self.stage),
                mock.patch.object(verify.os.path, 'lexists',
                                  side_effect=lambda path: Path(path) == verify.LOCK and self.lock),
                # The S1 nginx phase has its own fakes (NginxPhaseTests).
                mock.patch.object(verify, 'verify_nginx_phase', side_effect=self.nginx_phase),
                mock.patch.object(verify, 'nginx_active', return_value=True),
                mock.patch.object(verify, 'fixture_ports_listening', return_value=[]))

    def nginx_phase(self, source_dir, staging, service):
        self.events.append(('nginx_phase', type(staging).__name__, type(service).__name__))
        return {'nginx_checks': 'passed'}

    def stage(self, source_dir, secret, staging):
        self.events.append(('stage_fixture',)); self.secret = secret
        self.written[str(verify.SECRET_FILE)] = secret
        return self.GENERATION


class AssemblyTests(TestCase):
    """stage_fixture / verify_with_fixture / read_phase / main with fake host effects."""

    def run_verify(self, host):
        staging = FakeStaging(host)
        with contextlib_stack(host.patches()), \
             mock.patch.object(verify.Path, 'read_text', lambda path: host.written[str(path)]):
            return verify.verify_with_fixture('/unused', staging), staging

    def invoked(self, host):
        return [event[1:] for event in host.events if event[0] == 'invoke']

    def test_phases_run_in_order_a_b_a_prime_with_lock_confirmed_first(self):
        host = FakeHost()
        report, staging = self.run_verify(host)
        reads = ('inspect-state', 'inspect-runtime')
        refused = [name for name in sorted(verify.REFUSED_ARGUMENTS)
                   for _ in verify.refused_invocations(name, host.secret)]
        expected = [('verify-cohort', False), *[(name, False) for name in refused],
                    *[(name, False) for name in reads], *[(name, True) for name in reads],
                    *[(name, False) for name in reads]]
        self.assertEqual(self.invoked(host), expected)
        # The lock is confirmed present before each read phase (A, B, A').
        kinds = [event[0] if event[0] != 'invoke' else event[1] for event in host.events
                 if event[0] in ('invoke', 'require_lock', 'mkdir', 'remove')]
        self.assertEqual(kinds[kinds.index('verify-cohort'):], [
            'verify-cohort', 'require_lock', *refused,
            'require_lock', *reads, 'mkdir', 'require_lock', *reads, 'remove', 'require_lock', *reads])
        self.assertIn(('record_created', str(verify.LOCK)), host.events)
        self.assertEqual(report['lock_at_start'], 'absent')
        self.assertEqual(report['state_directory_attribution'], 'absent_fails_present_reads_absent_fails')
        self.assertEqual(staging.created, [verify.LOCK])

    def test_lock_is_recorded_however_verify_cohort_ends(self):
        for failure in (verify.VerifyError('command failed: verify-cohort'), SystemExit(128 + signal.SIGTERM)):
            with self.subTest(failure=type(failure).__name__):
                host = FakeHost(cohort_failure=failure)
                with self.assertRaises(type(failure)):
                    self.run_verify(host)
                self.assertIn(('record_created', str(verify.LOCK)), host.events)
                # A lock that was present at start is never recorded.
                host = FakeHost(lock=True, cohort_failure=failure)
                with self.assertRaises(type(failure)):
                    self.run_verify(host)
                self.assertNotIn(('record_created', str(verify.LOCK)), host.events)
        # verify-cohort failed before creating anything: nothing to record.
        host = FakeHost(cohort_creates_lock=False, cohort_failure=verify.VerifyError('command failed: verify-cohort'))
        with self.assertRaises(verify.VerifyError):
            self.run_verify(host)
        self.assertNotIn(('record_created', str(verify.LOCK)), host.events)

    def test_preexisting_lock_is_never_recorded_for_removal(self):
        host = FakeHost(lock=True)
        report, staging = self.run_verify(host)
        self.assertNotIn(('record_created', str(verify.LOCK)), host.events)
        self.assertEqual(report['lock_at_start'], 'present')
        self.assertEqual(staging.created, [])

    def test_missing_lock_before_phase_a_stops_before_any_read(self):
        host = FakeHost(cohort_creates_lock=False)
        with self.assertRaisesRegex(verify.VerifyError, 'lock'):
            self.run_verify(host)
        self.assertFalse([name for name, _ in self.invoked(host) if name.startswith('inspect-')])

    def test_phase_b_mismatch_fails(self):
        host = FakeHost(phase_b_stdout=json.dumps({'generation_id': FakeHost.GENERATION, 'runtime_ready': True}))
        with self.assertRaisesRegex(verify.VerifyError, 'inspect-state'):
            self.run_verify(host)

    def test_read_phase_checks_each_result_and_host_state(self):
        host = FakeHost(lock=True)
        results = []
        with contextlib_stack(host.patches()):
            verify.read_phase(('inspect-state',), verify.check_sanitized_failure, host.snapshot(), 'A', results)
            self.assertEqual([r['command'] for r in results], ['inspect-state'])
            host.state_dir = True
            with self.assertRaisesRegex(verify.VerifyError, 'sanitized'):
                verify.read_phase(('inspect-state',), verify.check_sanitized_failure, host.snapshot(), 'A', [])
            host.lock = False
            with self.assertRaisesRegex(verify.VerifyError, 'lock'):
                verify.read_phase(('inspect-state',), verify.check_sanitized_failure, host.snapshot(), 'A', [])

    def test_main_cleans_up_after_a_mid_run_failure_and_compares_with_pristine(self):
        host = FakeHost(phase_b_stdout='not json')
        with contextlib_stack(host.patches()), \
             mock.patch.object(verify, 'check_environment'), mock.patch.object(verify, 'require_clean_start'), \
             mock.patch.object(verify, 'Staging', side_effect=lambda: FakeStaging(host)), \
             mock.patch.object(verify, 'install_termination',
                               side_effect=lambda: host.events.append(('install_termination',))) as installed:
            with self.assertRaisesRegex(verify.VerifyError, 'non-JSON'):
                verify.main(['s0_refusal_verify.py', '/unused'])
        installed.assert_called_once_with()
        # SIGTERM is blocked before anything is staged.
        self.assertLess(host.events.index(('install_termination',)), host.events.index(('stage_fixture',)))
        self.assertEqual(host.events[-1], ('cleanup',))
        self.assertFalse(host.lock or host.state_dir)

    def test_main_success_reports_fixture_removed_after_pristine_comparison(self):
        host = FakeHost()
        output = io.StringIO()
        with contextlib_stack(host.patches()), \
             mock.patch.object(verify, 'check_environment'), mock.patch.object(verify, 'require_clean_start'), \
             mock.patch.object(verify, 'Staging', side_effect=lambda: FakeStaging(host)), \
             mock.patch.object(verify, 'install_termination'), \
             mock.patch.object(verify.Path, 'read_text', lambda path: host.written[str(path)]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(verify.main(['s0_refusal_verify.py', '/unused']), 0)
        report = json.loads(output.getvalue())
        self.assertTrue(report['fixture_removed'])
        self.assertEqual(report['lock_at_start'], 'absent')
        self.assertFalse(host.lock)
        # The nginx phase runs in its own staging after the S0 pristine
        # comparison and is compared (nginx restarted) before and after.
        self.assertEqual(report['nginx_phase'], {'nginx_checks': 'passed', 'fixture_removed': True,
                                                 'nginx_restored': True})
        phase = host.events.index(('nginx_phase', 'FakeStaging', 'NginxService'))
        self.assertEqual(host.events[phase - 1], ('full_snapshot', True))
        self.assertEqual(host.events[phase - 2], ('full_snapshot',))
        self.assertEqual(host.events[phase + 1:], [('cleanup',), ('full_snapshot', True)])

    def test_leftover_lock_from_this_run_makes_the_pristine_comparison_fail(self):
        host = FakeHost()
        class KeepLock(FakeStaging):
            def cleanup(self):
                self.created = []; self.host.state_dir = False
                return []
        with contextlib_stack(host.patches()), \
             mock.patch.object(verify, 'check_environment'), mock.patch.object(verify, 'require_clean_start'), \
             mock.patch.object(verify, 'Staging', side_effect=lambda: KeepLock(host)), \
             mock.patch.object(verify, 'install_termination'), \
             mock.patch.object(verify.Path, 'read_text', lambda path: host.written[str(path)]), \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(verify.VerifyError, 'fixture cleanup changed host state: ' + str(verify.LOCK)):
                verify.main(['s0_refusal_verify.py', '/unused'])

    def test_sigterm_unwinds_through_cleanup_at_the_next_checkpoint(self):
        # The handler only records; the checkpoint raises.
        verify.terminate(signal.SIGTERM, None)
        self.assertEqual(verify.TERMINATION.pending, signal.SIGTERM)
        with self.assertRaises(SystemExit) as caught:
            verify.checkpoint()
        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
        verify.TERMINATION.__init__()
        staging = mock.Mock(cleanup=mock.Mock(return_value=[]))
        def body():
            verify.terminate(signal.SIGTERM, None)
            verify.checkpoint()
        with self.assertRaises(SystemExit):
            verify.with_cleanup(staging, body)
        staging.cleanup.assert_called_once_with()

    def test_install_termination_blocks_before_installing_the_handler(self):
        calls = []
        with mock.patch.object(verify.signal, 'pthread_sigmask', side_effect=lambda *a: calls.append(('mask',) + a)), \
             mock.patch.object(verify.signal, 'signal', side_effect=lambda *a: calls.append(('handler',) + a)):
            verify.install_termination()
        self.assertEqual(calls[0], ('mask', signal.SIG_BLOCK, verify.TERMINATION_SIGNALS))
        self.assertEqual(calls[1:], [('handler', signum, verify.terminate) for signum in sorted(verify.TERMINATION_SIGNALS)])
        self.assertEqual(verify.TERMINATION_SIGNALS, frozenset({signal.SIGTERM, signal.SIGINT, signal.SIGHUP}))

    def test_checkpoint_consumes_a_pending_blocked_sigterm(self):
        with mock.patch.object(verify.signal, 'sigpending', side_effect=[{signal.SIGTERM}, set()]), \
             mock.patch.object(verify.signal, 'sigwait', return_value=signal.SIGTERM) as waited:
            with self.assertRaises(SystemExit) as caught:
                verify.checkpoint()
        waited.assert_called_once_with(verify.TERMINATION_SIGNALS)
        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
        with mock.patch.object(verify.signal, 'sigpending', return_value=set()), \
             mock.patch.object(verify.signal, 'sigwait', side_effect=AssertionError('blocks')):
            verify.TERMINATION.__init__()
            verify.checkpoint()   # nothing pending: returns, never waits

    def test_checkpoint_consumes_every_pending_signal_and_records_the_first(self):
        for first, second in ((signal.SIGINT, signal.SIGHUP), (signal.SIGHUP, signal.SIGTERM)):
            with self.subTest(first=first.name, second=second.name):
                verify.TERMINATION.__init__()
                pending = [{first, second}, {second}, set()]
                with mock.patch.object(verify.signal, 'sigpending', side_effect=pending), \
                     mock.patch.object(verify.signal, 'sigwait', side_effect=[first, second]) as waited:
                    with self.assertRaises(SystemExit) as caught:
                        verify.checkpoint()
                self.assertEqual(waited.call_count, 2)
                self.assertEqual(caught.exception.code, 128 + first)
        # A pending signal that is not a termination signal is never waited for.
        verify.TERMINATION.__init__()
        with mock.patch.object(verify.signal, 'sigpending', return_value={signal.SIGUSR1}), \
             mock.patch.object(verify.signal, 'sigwait', side_effect=AssertionError('waited')):
            verify.checkpoint()

    def test_sigint_and_sighup_unwind_like_sigterm(self):
        for signum in (signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum.name):
                verify.TERMINATION.__init__()
                staging = mock.Mock(cleanup=mock.Mock(return_value=[]))
                def body():
                    verify.terminate(signum, None)
                    verify.checkpoint()
                with self.assertRaises(SystemExit) as caught:
                    verify.with_cleanup(staging, body)
                self.assertEqual(caught.exception.code, 128 + signum)
                staging.cleanup.assert_called_once_with()

    def test_checkpoint_is_called_only_at_the_documented_safe_points(self):
        tree = ast.parse((HERE / 's0_refusal_verify.py').read_text())
        callers = set()
        def own_nodes(node):
            """Nodes of ``node``'s body, not descending into nested definitions."""
            for child in ast.iter_child_nodes(node):
                if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                    yield child
                    yield from own_nodes(child)
        def visit(node, owner):
            if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'checkpoint'
                   for n in own_nodes(node)):
                callers.add('.'.join(owner) or '<module>')
            for child in iter_direct_definitions(node):
                visit(child, owner + [child.name])
        def iter_direct_definitions(node):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    yield child
                else:
                    yield from iter_direct_definitions(child)
        visit(tree, [])
        self.assertEqual(callers, {'run', 'Staging.mkdir', 'Staging.write', 'with_cleanup'})
        doc = verify.checkpoint.__doc__
        for name in ('run()', 'Staging.mkdir()', 'Staging.write()', 'with_cleanup()'):
            self.assertIn(name, doc)

    def test_sigterm_during_the_refusal_loop_stops_at_the_next_iteration(self):
        def term_at_third(host, index, subcommand):
            if index == 3:
                verify.terminate(signal.SIGTERM, None)
        host = FakeHost(after_invoke=term_at_third)
        with self.assertRaises(SystemExit):
            self.run_verify(host)
        self.assertEqual(host.invocations, 3)
        self.assertIn(('record_created', str(verify.LOCK)), host.events)

    def test_sigterm_while_verify_cohort_runs_still_records_the_lock(self):
        # Arrives during the call (the CLI created the lock); the finally block
        # records it before the next checkpoint raises.
        def term_in_cohort(host, index, subcommand):
            if subcommand == 'verify-cohort':
                verify.terminate(signal.SIGTERM, None)
        host = FakeHost(after_invoke=term_in_cohort)
        with self.assertRaises(SystemExit):
            self.run_verify(host)
        self.assertIn(('record_created', str(verify.LOCK)), host.events)
        self.assertEqual(host.invocations, 1)

    def test_refused_invocations_use_light_checks_and_one_full_snapshot_per_subcommand(self):
        host = FakeHost()
        self.run_verify(host)
        refused = sorted(verify.REFUSED_ARGUMENTS)
        shapes = sum(len(verify.refused_invocations(name, host.secret)) for name in refused)
        start = host.events.index(('invoke', refused[0], False))
        end = host.events.index(('invoke', 'inspect-state', False))
        loop = [event[0] for event in host.events[start:end]]
        self.assertEqual(loop.count('light_snapshot'), shapes)
        self.assertEqual(loop.count('full_snapshot'), len(refused))
        # The full snapshot follows the last argv shape of each subcommand.
        for name in refused:
            last = max(i for i, event in enumerate(host.events) if event[:2] == ('invoke', name))
            self.assertEqual([e[0] for e in host.events[last + 1:last + 3]], ['light_snapshot', 'full_snapshot'])

    def test_light_and_full_changes_name_the_subcommand(self):
        refused = sorted(verify.REFUSED_ARGUMENTS)
        def touch_secret_dir(host, index, subcommand):
            if subcommand == 'apply' and host.events.count(('invoke', 'apply', False)) == 2:
                host.secret_dir_identity = 'replaced'
        with self.assertRaisesRegex(verify.VerifyError, r'^apply \(argv shape 1\) changed host state: '
                                    + str(verify.SECRET_DIR) + '$'):
            self.run_verify(FakeHost(after_invoke=touch_secret_dir))
        def change_ufw(host, index, subcommand):
            if subcommand == refused[-1]:
                host.ufw = 'changed'
        with self.assertRaisesRegex(verify.VerifyError, '^' + refused[-1] + ' changed host state: /etc/ufw$'):
            self.run_verify(FakeHost(after_invoke=change_ufw))

    def sigterm_child(self, body, cleanup, signum=signal.SIGTERM):
        # A child process with only the verifier's termination setup and
        # with_cleanup. It stages nothing on the host and signals only its
        # own pid (the real kernel SIGTERM, blocked by install_termination).
        code = (
            'import importlib.util,os,signal,sys\n'
            'spec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\n'
            'def term():os.kill(os.getpid(),%d)\n' % signum +
            'class S:\n'
            '    def cleanup(self):\n'
            '        print("cleanup start",flush=True)\n'
            + ''.join('        ' + line + '\n' for line in cleanup) +
            '        print("cleanup done",flush=True);return []\n'
            'v.install_termination()\n'
            'def body():\n'
            + ''.join('    ' + line + '\n' for line in body) +
            'print(v.with_cleanup(S(),body),flush=True)\n')
        return subprocess.run([sys.executable, '-I', '-B', '-c', code, str(HERE / 's0_refusal_verify.py')],
                              capture_output=True, text=True, timeout=30)

    def test_real_sigterm_in_a_child_runs_cleanup(self):
        # Blocked: the body runs on to the next checkpoint, never interrupted
        # at an arbitrary point, and unwinds there.
        done = self.sigterm_child(['term()', 'print("until checkpoint",flush=True)', 'v.checkpoint()',
                                   'return "not reached"'], [])
        self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
        self.assertEqual(done.stdout, 'until checkpoint\ncleanup start\ncleanup done\n')

    def test_real_sigint_and_sighup_in_a_child_run_cleanup(self):
        for signum in (signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum.name):
                done = self.sigterm_child(['term()', 'print("until checkpoint",flush=True)', 'v.checkpoint()',
                                           'return "not reached"'], ['term()'], signum)
                self.assertEqual(done.returncode, 128 + signum, done.stderr)
                self.assertEqual(done.stdout, 'until checkpoint\ncleanup start\ncleanup done\n')

    def test_children_start_with_every_termination_signal_unblocked(self):
        probe = ('import signal;b={int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK,[])};'
                 'print(sorted(b & {%s}))' % ','.join(str(int(s)) for s in verify.TERMINATION_SIGNALS))
        code = ('import importlib.util,signal,sys\n'
                'spec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\n'
                'v.install_termination()\n'
                'print(v.run([sys.executable,"-I","-c",sys.argv[2]],"probe").stdout.strip(),'
                'sorted(int(s) for s in v.TERMINATION_SIGNALS if s in signal.pthread_sigmask(signal.SIG_BLOCK,[])))\n')
        done = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(HERE / 's0_refusal_verify.py'), probe],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, '[] %s\n' % sorted(int(s) for s in verify.TERMINATION_SIGNALS))

    def test_real_sigterm_stops_a_long_loop_at_the_next_checkpoint(self):
        done = self.sigterm_child(['for i in range(1000):', '    v.checkpoint()', '    print(i,flush=True)',
                                   '    if i == 2: term()'], [])
        self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
        self.assertEqual(done.stdout, '0\n1\n2\ncleanup start\ncleanup done\n')

    def test_second_sigterm_never_interrupts_cleanup(self):
        done = self.sigterm_child(['term()', 'v.checkpoint()'], ['term()', 'term()'])
        self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
        self.assertEqual(done.stdout, 'cleanup start\ncleanup done\n')

    def test_real_sigterm_before_a_failure_keeps_the_error_and_cleans_up(self):
        # Formerly a window: SIGTERM between the failure and marking the run as
        # unwinding. Blocked, it can only be consumed after cleanup.
        done = self.sigterm_child(['term()', 'raise v.VerifyError("boom")'], ['term()'])
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn('VerifyError: boom', done.stderr)
        self.assertEqual(done.stdout, 'cleanup start\ncleanup done\n')

    def test_children_start_with_sigterm_unblocked(self):
        # The verifier's own commands (CLI, iptables-save, nft) must stay
        # terminable although the verifier blocks SIGTERM.
        probe = ('import os,signal;print(int(signal.SIGTERM) in {int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK,[])},'
                 'flush=True);os.kill(os.getpid(),signal.SIGTERM);print("survived",flush=True)')
        code = ('import importlib.util,signal,sys\n'
                'spec=importlib.util.spec_from_file_location("v",sys.argv[1]);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\n'
                'v.install_termination()\n'
                'done=v.run([sys.executable,"-I","-c",sys.argv[2]],"probe")\n'
                'print(done.returncode,repr(done.stdout),done.args[0]==sys.executable,'
                'int(signal.SIGTERM) in {int(s) for s in signal.pthread_sigmask(signal.SIG_BLOCK,[])})\n')
        done = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(HERE / 's0_refusal_verify.py'), probe],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        # Grandchild: not blocked, killed by its SIGTERM; the verifier is blocked again.
        self.assertEqual(done.stdout, '%d %r True True\n' % (-signal.SIGTERM, 'False\n'))

    def test_real_sigterm_while_a_command_runs_is_taken_at_the_next_checkpoint(self):
        # The command signals its parent (the verifier child) and finishes; the
        # verifier records it while unblocked and unwinds at the next checkpoint.
        probe = 'import os,signal;os.kill(os.getppid(),signal.SIGTERM);print("command done",flush=True)'
        done = self.sigterm_child(['print(v.run([sys.executable,"-I","-c",%r],"probe").stdout,end="",flush=True)' % probe,
                                   'print("until checkpoint",flush=True)', 'v.checkpoint()', 'return "not reached"'], [])
        self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
        self.assertEqual(done.stdout, 'command done\nuntil checkpoint\ncleanup start\ncleanup done\n')

    def test_first_sigterm_during_cleanup_after_success_is_raised_after_cleanup(self):
        done = self.sigterm_child(['return "report"'], ['term()'])
        self.assertEqual(done.returncode, 128 + signal.SIGTERM, done.stderr)
        self.assertEqual(done.stdout, 'cleanup start\ncleanup done\n')

    def test_sigterm_during_a_failing_run_keeps_the_original_error(self):
        done = self.sigterm_child(['raise v.VerifyError("boom")'], ['term()'])
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn('VerifyError: boom', done.stderr)
        self.assertEqual(done.stdout, 'cleanup start\ncleanup done\n')

    def test_sigterm_after_cleanup_of_a_failing_run_keeps_the_leftover_report(self):
        class Leftovers(list):
            def __iter__(self):
                # SIGTERM arrives after cleanup, while the leftover report is built.
                verify.terminate(signal.SIGTERM, None)
                return super().__iter__()
        staging = mock.Mock(cleanup=mock.Mock(return_value=Leftovers(['/etc/cloudfront-sync'])))
        with self.assertRaisesRegex(verify.VerifyError, '^boom; fixture cleanup left: /etc/cloudfront-sync$'):
            verify.with_cleanup(staging, mock.Mock(side_effect=verify.VerifyError('boom')))
        self.assertEqual(verify.TERMINATION.pending, signal.SIGTERM)

    def test_terminate_only_records_and_a_checkpoint_raises_once(self):
        verify.terminate(signal.SIGTERM, None)
        self.assertEqual(verify.TERMINATION.pending, signal.SIGTERM)
        with self.assertRaises(SystemExit) as caught:
            verify.checkpoint()
        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
        # Unwinding: neither the handler nor a checkpoint raises again.
        verify.terminate(signal.SIGTERM, None)
        verify.checkpoint()

    def test_cleanup_contains_no_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = verify.Staging()
            staging.mkdir(Path(directory) / 'd', 0o755)
            staging.write(Path(directory) / 'd' / 'f', b'x', 0o600)
            with mock.patch.object(verify, 'checkpoint', side_effect=AssertionError('checkpoint in cleanup')):
                self.assertEqual(staging.cleanup(), [])

    def test_stage_fixture_writes_the_verified_bundle_config_and_secret(self):
        host = FakeHost()
        staging = FakeStaging(host)
        generation = verify.stage_fixture(ROLE_FILES, 'SECRET-VALUE', staging)
        manifest = verify.load_manifest_module(ROLE_FILES)
        paths = [event[1] for event in host.events if event[0] in ('mkdir', 'write')]
        self.assertEqual(paths[0], str(verify.BUNDLE_DIR))
        self.assertEqual(set(paths[1:1 + len(manifest.ASSET_NAMES) + 1]),
                         {str(verify.BUNDLE_DIR / name) for name in (*manifest.ASSET_NAMES, 'bundle-manifest.json')})
        self.assertEqual(paths[-4:], [str(verify.SECRET_DIR), str(verify.SECRET_FILE), str(verify.CONFIG_DIR), str(verify.CONFIG)])
        modes = {event[1]: event[2] for event in host.events if event[0] in ('mkdir', 'write')}
        for name in manifest.ENTRY_NAMES:
            self.assertEqual(modes[str(verify.BUNDLE_DIR / name)], 0o755)
        self.assertEqual(modes[str(verify.SECRET_FILE)], 0o600)
        self.assertEqual(modes[str(verify.CONFIG)], 0o640)
        written_manifest = json.loads(host.written[str(verify.BUNDLE_DIR / 'bundle-manifest.json')])
        self.assertEqual(written_manifest['generation_id'], generation)
        self.assertEqual(host.written[str(verify.SECRET_FILE)].count(b'SECRET-VALUE'), 1)
        config = json.loads(host.written[str(verify.CONFIG)])
        # The S0 config mirrors converge: nginx disabled, role default shared_dir, no bundles.
        self.assertEqual(config['nginx'], {'enabled': False, 'shared_dir': '/etc/nginx/cloudfront', 'bundles': []})


def contextlib_stack(managers):
    stack = contextlib.ExitStack()
    for manager in managers:
        stack.enter_context(manager)
    return stack


class HostSafetyTests(TestCase):
    def test_root_and_exact_sentinel_required_before_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / 'sentinel'
            with mock.patch.object(verify.os, 'geteuid', return_value=1000):
                self.assertRaises(verify.VerifyError, verify.check_environment, sentinel)
            with mock.patch.object(verify.os, 'geteuid', return_value=0):
                self.assertRaises(verify.VerifyError, verify.check_environment, sentinel)
                sentinel.write_text('wrong\n')
                sentinel.chmod(0o600)
                self.assertRaises(verify.VerifyError, verify.check_environment, sentinel)

    def test_main_stops_before_staging_without_the_environment(self):
        with (mock.patch.object(verify.os, 'geteuid', return_value=1000),
              mock.patch.object(verify, 'stage_fixture', side_effect=AssertionError('staged')),
              mock.patch.object(verify, 'run', side_effect=AssertionError('command'))):
            self.assertRaises(verify.VerifyError, verify.main, ['s0_refusal_verify.py', str(ROLE_FILES)])

    def test_leftover_or_installed_target_is_a_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            present = Path(directory) / 'installed'
            verify.require_clean_start((present,))
            present.mkdir()
            with self.assertRaisesRegex(verify.VerifyError, 'earlier verifier run'):
                verify.require_clean_start((present,))
        self.assertIn(verify.SECRET_DIR, verify.staged_roots())
        self.assertTrue(set(verify.install_targets()) <= set(verify.staged_roots()))

    def test_main_checks_leftovers_before_snapshot_or_staging(self):
        with (mock.patch.object(verify, 'check_environment'),
              mock.patch.object(verify, 'require_clean_start', side_effect=verify.VerifyError('leftover')),
              mock.patch.object(verify, 'host_snapshot', side_effect=AssertionError('snapshot')),
              mock.patch.object(verify, 'stage_fixture', side_effect=AssertionError('staged'))):
            self.assertRaisesRegex(verify.VerifyError, 'leftover', verify.main, ['s0_refusal_verify.py', str(ROLE_FILES)])

    def test_tree_digest_detects_absence_content_mode_and_new_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tree'
            self.assertEqual(verify.tree_digest(root), 'absent')
            root.mkdir()
            (root / 'a').write_text('one')
            first = verify.tree_digest(root)
            self.assertEqual(verify.tree_digest(root), first)
            (root / 'a').write_text('two')
            second = verify.tree_digest(root)
            self.assertNotEqual(second, first)
            os.chmod(root / 'a', 0o600)
            third = verify.tree_digest(root)
            self.assertNotEqual(third, second)
            (root / 'b').symlink_to('a')
            self.assertNotEqual(verify.tree_digest(root), third)

    def test_tree_digest_reports_an_entry_vanishing_while_read_as_verify_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tree'
            root.mkdir()
            for name in ('a', 'b', 'link'):
                (root / name).symlink_to('a') if name == 'link' else (root / name).write_text(name)
            real_lstat = Path.lstat
            for victim in ('a', 'b', 'link'):
                with self.subTest(vanishes=victim):
                    def lstat(path, victim=victim):
                        # The entry was listed by rglob, then removed before its lstat.
                        if path == root / victim:
                            raise FileNotFoundError(2, 'gone', str(path))
                        return real_lstat(path)
                    with mock.patch.object(verify.Path, 'lstat', lstat):
                        with self.assertRaises(verify.VerifyError) as caught:
                            verify.tree_digest(root)
                    self.assertEqual(str(caught.exception),
                                     'tree changed while it was read: %s (vanished: %s)' % (root, root / victim))
                    self.assertIsNone(caught.exception.__cause__)
            # Listed and lstat-ed, then removed before its content or link is read.
            for patched in ('read_bytes', 'readlink'):
                with self.subTest(read=patched):
                    target = verify.Path if patched == 'read_bytes' else verify.os
                    with mock.patch.object(target, patched, side_effect=FileNotFoundError(2, 'gone')):
                        self.assertRaisesRegex(verify.VerifyError, '^tree changed while it was read: ',
                                               verify.tree_digest, root)
            # The root itself vanishing after the presence check.
            with mock.patch.object(verify.Path, 'lstat', side_effect=FileNotFoundError(2, 'gone')):
                self.assertRaisesRegex(verify.VerifyError, '^tree changed while it was read: ',
                                       verify.tree_digest, root)
            # Any other error of an entry is not masked as a vanished entry.
            def denied(path):
                if path == root / 'a':
                    raise PermissionError(13, 'denied', str(path))
                return real_lstat(path)
            with mock.patch.object(verify.Path, 'lstat', denied):
                self.assertRaises(PermissionError, verify.tree_digest, root)

    def test_tree_digest_walk_reports_a_directory_vanishing_while_listed(self):
        """The walk itself (not only the per-entry reads) never skips or leaks a vanished directory."""
        import shutil
        real_scandir = os.scandir
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tree'
            for victim, error in (('sub', FileNotFoundError), ('sub/deeper', FileNotFoundError),
                                  ('sub', NotADirectoryError)):
                with self.subTest(victim=victim, error=error.__name__):
                    shutil.rmtree(root, ignore_errors=True)
                    (root / 'sub' / 'deeper').mkdir(parents=True)
                    (root / 'sub' / 'deeper' / 'leaf').write_text('x')
                    (root / 'top').write_text('y')
                    gone = root / victim
                    def scandir(path='.', gone=gone, error=error):
                        # The directory was listed by its parent, then removed
                        # (or replaced by a file) before it is listed itself.
                        if not isinstance(path, int) and Path(path) == gone:  # rmtree lists by fd
                            shutil.rmtree(gone)
                            if error is NotADirectoryError:
                                gone.write_text('now a file')
                        return real_scandir(path)
                    with mock.patch.object(verify.os, 'scandir', scandir):
                        with self.assertRaises(verify.VerifyError) as caught:
                            verify.tree_digest(root)
                    self.assertEqual(str(caught.exception),
                                     'tree changed while it was read: %s (vanished: %s)' % (root, gone))
                    self.assertIsNone(caught.exception.__cause__)
            # Any other error of the walk is not masked as a vanished entry.
            shutil.rmtree(root, ignore_errors=True)
            (root / 'sub').mkdir(parents=True)
            def denied(path='.'):
                if not isinstance(path, int) and Path(path) == root / 'sub':
                    raise PermissionError(13, 'denied', str(path))
                return real_scandir(path)
            with mock.patch.object(verify.os, 'scandir', denied):
                self.assertRaises(PermissionError, verify.tree_digest, root)
            # The digest still covers every nested entry, without following symlinks.
            (root / 'sub' / 'f').write_text('1')
            (root / 'link').symlink_to(root / 'sub', target_is_directory=True)
            self.assertEqual(verify._tree_entries(root), [root / 'link', root / 'sub', root / 'sub' / 'f'])
            first = verify.tree_digest(root)
            (root / 'sub' / 'f').write_text('2')
            self.assertNotEqual(verify.tree_digest(root), first)
            (root / 'sub' / '.hidden').write_text('h')
            second = verify.tree_digest(root)
            self.assertNotEqual(second, first)
            with mock.patch.object(verify.Path, 'rglob', side_effect=AssertionError('rglob')):
                self.assertEqual(verify.tree_digest(root), second)

    def test_host_snapshot_covers_lock_policy_trees_and_install_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            ufw = Path(directory)
            for name in ('user.rules', 'user6.rules'):
                (ufw / name).write_text(name)
            with (mock.patch.object(verify, 'UFW_DIR', ufw),
                  mock.patch.object(verify, 'tree_digest',
                                    side_effect=lambda path, own_times=True, times_exempt=(): 'digest:' + str(path)),
                  mock.patch.object(verify, 'path_identity', side_effect=lambda path: 'id:' + str(path)),
                  mock.patch.object(verify, 'run_snapshot', return_value='run-view'),
                  mock.patch.object(verify, 'firewall_rules', return_value={'nft': 'n'})):
                snapshot = verify.host_snapshot()
        # The lock by its lstat identity (inode included) and its content.
        self.assertEqual(snapshot[str(verify.LOCK)], ('id:' + str(verify.LOCK), 'digest:' + str(verify.LOCK)))
        self.assertEqual(verify.LOCK, Path('/run/lock/cloudfront-sync.lock'))
        for path in (verify.NGINX_DIR, *verify.install_targets()):
            self.assertIn(str(path), snapshot)
        # Every tree an inspect-runtime collector may read, as a full tree digest.
        for path in ('/etc/ufw', '/etc/default', '/var/lib/ufw', '/etc/nginx', '/etc/ssh', '/etc/systemd/system'):
            self.assertEqual(snapshot[path], 'digest:' + path)
        self.assertEqual(snapshot['/run'], 'run-view')
        self.assertEqual(snapshot['nft'], 'n')
        self.assertEqual(set(snapshot), {*(str(p) for p in (*verify.POLICY_TREES, *verify.install_targets(), verify.LOCK)),
                                         '/run', 'nft'})

    def test_host_snapshot_requires_both_ufw_rule_files_and_hashes_them_once(self):
        with tempfile.TemporaryDirectory() as directory:
            ufw = Path(directory)
            (ufw / 'user.rules').write_text('4')
            with (mock.patch.object(verify, 'UFW_DIR', ufw),
                  mock.patch.object(verify, 'tree_digest', side_effect=AssertionError('digest before check')),
                  mock.patch.object(verify, 'firewall_rules', side_effect=AssertionError('rules before check'))):
                self.assertRaisesRegex(verify.VerifyError, '^UFW user6.rules is missing$', verify.host_snapshot)
            (ufw / 'user6.rules').write_text('6')
            with (mock.patch.object(verify, 'UFW_DIR', ufw), mock.patch.object(verify, 'POLICY_TREES', (ufw,)),
                  mock.patch.object(verify, 'run_snapshot', return_value='run-view'),
                  mock.patch.object(verify, 'firewall_rules', return_value={'nft': 'n'})):
                snapshot = verify.host_snapshot()
                (ufw / 'user6.rules').write_text('changed')
                self.assertNotEqual(verify.host_snapshot()[str(ufw)], snapshot[str(ufw)])
        self.assertFalse([key for key in snapshot if key.startswith('ufw:')])

    def test_run_snapshot_compares_watched_top_level_entries_only(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            for name in ('systemd', 'ufw.lock', 'nginx.pid', 'sshd', 'cloudfront-sync-disposable-test', 'xtables.lock'):
                (run / name).mkdir() if name in ('systemd', 'sshd') else (run / name).write_text('x')
            (run / 'systemd' / 'volatile').write_text('1')
            # An old mtime, so the change below is visible with a coarse clock.
            os.utime(run / 'sshd', ns=(10**9, 10**9))
            first = verify.run_snapshot(run)
            self.assertEqual(verify.run_snapshot(run), first)
            # Below an unwatched entry: deliberately not compared (changes by itself).
            (run / 'systemd' / 'volatile').write_text('2')
            (run / 'systemd' / 'new').write_text('3')
            self.assertEqual(verify.run_snapshot(run), first)
            # Unwatched top-level entries: created, changed or removed, never compared.
            (run / 'new-top-level').write_text('')
            os.utime(run / 'systemd', ns=(1, 1))
            self.assertEqual(verify.run_snapshot(run), first)
            (run / 'new-top-level').unlink()
            self.assertEqual(verify.run_snapshot(run), first)
            changes = (lambda: (run / 'ufw-new').write_text(''),                          # watched created
                       lambda: (run / 'ufw-new').unlink(),                                # watched removed
                       lambda: (run / 'nginx.pid').rename(run / 'nginx-other.pid'),       # watched renamed
                       lambda: (run / 'nginx-other.pid').rename(run / 'nginx.pid'),
                       lambda: os.chmod(run / 'ufw.lock', 0o600),                         # watched metadata
                       lambda: (run / 'nginx.pid').write_text('other pid'),               # watched size/mtime
                       lambda: (run / 'sshd' / 'x').write_text(''),                       # watched dir mtime
                       lambda: os.utime(run / 'cloudfront-sync-disposable-test', ns=(1, 1)),
                       lambda: os.utime(run / 'xtables.lock', ns=(1, 1)))
            previous = first
            for index, change in enumerate(changes):
                with self.subTest(change=index):
                    change()
                    current = verify.run_snapshot(run)
                    self.assertNotEqual(current, previous)
                    previous = current
            # The watched names themselves are compared, not only identities:
            # the same identity under another watched name is a change.
            with mock.patch.object(verify, 'path_identity', return_value='same'):
                named = verify.run_snapshot(run)
                (run / 'ufw.lock').rename(run / 'ufw-renamed.lock')
                self.assertNotEqual(verify.run_snapshot(run), named)
        self.assertEqual(verify.RUN_DIR, Path('/run'))

    def test_lock_file_check_requires_root_0600_regular_single_link(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'lock'
            self.assertRaisesRegex(verify.VerifyError, 'absent', verify.require_lock_file, lock)
            lock.write_bytes(b''); lock.chmod(0o600)
            info = os.lstat(lock)
            def fake(uid=0, mode=info.st_mode, nlink=1):
                return mock.Mock(st_uid=uid, st_mode=mode, st_nlink=nlink)
            with mock.patch.object(verify.Path, 'lstat', return_value=fake()):
                verify.require_lock_file(lock)
            for bad in (fake(uid=1000), fake(mode=(info.st_mode & ~0o777) | 0o644), fake(nlink=2), fake(mode=0o040600)):
                with self.subTest(bad=bad), mock.patch.object(verify.Path, 'lstat', return_value=bad):
                    self.assertRaises(verify.VerifyError, verify.require_lock_file, lock)

    def test_light_snapshot_covers_lock_install_targets_and_secret_directory(self):
        with mock.patch.object(verify, 'path_identity', side_effect=lambda path: 'id:' + str(path)):
            light = verify.light_snapshot()
        self.assertEqual(set(light), {str(path) for path in (verify.LOCK, *verify.install_targets(), verify.SECRET_DIR)})
        self.assertIn(str(verify.STATE_DIR), light)

    def test_path_identity_detects_absence_replacement_and_metadata_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'lock'
            self.assertEqual(verify.path_identity(path), 'absent')
            path.write_bytes(b'')
            first = verify.path_identity(path)
            self.assertEqual(verify.path_identity(path), first)
            # A real mode change (the creation mode depends on the umask).
            os.chmod(path, 0o640 if stat.S_IMODE(os.lstat(path).st_mode) != 0o640 else 0o600)
            second = verify.path_identity(path)
            self.assertNotEqual(second, first)
            # Same inode, mode and size: only the timestamps differ (a rewrite).
            os.utime(path, ns=(10**9, 10**9))
            third = verify.path_identity(path)
            self.assertNotEqual(third, second)
            self.assertEqual(third[:7], second[:7])
            path.unlink(); path.write_bytes(b'x')
            self.assertNotEqual(verify.path_identity(path), third)
            path.unlink(); path.symlink_to(directory)
            self.assertTrue(stat.S_ISLNK(verify.path_identity(path)[2]))

    def test_require_unchanged_reports_changed_keys_only(self):
        with mock.patch.object(verify, 'host_snapshot', return_value={'a': '1', 'b': '3'}):
            with self.assertRaisesRegex(verify.VerifyError, 'b'):
                verify.require_unchanged({'a': '1', 'b': '2'}, 'plan')
            verify.require_unchanged({'a': '1', 'b': '3'}, 'plan')



class IdentityComparisonTests(TestCase):
    """Review 10: same-content replacement, hard links and touch are changes.

    tree_digest rows carry each entry's inode, link count, mtime and ctime,
    and host_snapshot compares the lock by its lstat identity (path_identity,
    inode included) in addition to its content, so recreating the lock with
    the same (empty) content and mode is a change even if tree_digest did not
    see it.
    """

    def test_tree_digest_detects_same_content_replacement_hard_links_and_touch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tree'
            (root / 'sub').mkdir(parents=True)
            entry = root / 'sub' / 'file'
            entry.write_bytes(b'same'); entry.chmod(0o640)
            os.utime(entry, ns=(10**9, 10**9))
            first = verify.tree_digest(root)
            self.assertEqual(verify.tree_digest(root), first)
            # Another inode with identical content, mode, owner and mtime.
            replacement = Path(directory) / 'replacement'
            replacement.write_bytes(b'same'); replacement.chmod(0o640)
            os.utime(replacement, ns=(10**9, 10**9))
            os.replace(replacement, entry)
            second = verify.tree_digest(root)
            self.assertNotEqual(second, first, 'same-content inode replacement not detected')
            # A hard link from outside the tree adds no entry, only a link.
            os.link(entry, Path(directory) / 'outside-link')
            third = verify.tree_digest(root)
            self.assertNotEqual(third, second, 'hard link not detected')
            # touch: content, mode and links unchanged, only the times differ.
            os.utime(entry, ns=(2 * 10**9, 2 * 10**9))
            fourth = verify.tree_digest(root)
            self.assertNotEqual(fourth, third, 'mtime change not detected')
            # A directory replaced by an empty one with the same mode.
            os.rename(root / 'sub', Path(directory) / 'old-sub')
            (root / 'sub').mkdir(); os.chmod(root / 'sub', stat.S_IMODE(os.lstat(Path(directory) / 'old-sub').st_mode))
            os.rename(Path(directory) / 'old-sub' / 'file', root / 'sub' / 'file')
            self.assertNotEqual(verify.tree_digest(root), fourth, 'directory inode replacement not detected')

    def test_tree_digest_compares_each_identity_field_on_its_own(self):
        """Each of inode, link count, mtime and ctime alone changes the digest
        (a real replacement changes several at once); atime never does."""
        import types
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'tree'
            root.mkdir()
            (root / 'file').write_bytes(b'x')
            real_lstat = Path.lstat
            def digest(target, field=None, own_times=True):
                def lstat(path):
                    info = real_lstat(path)
                    if path != target or field is None:
                        return info
                    names = [name for name in dir(info) if name.startswith('st_')]
                    values = {name: getattr(info, name) for name in names}
                    values[field] += 7
                    return types.SimpleNamespace(**values)
                with mock.patch.object(verify.Path, 'lstat', lstat):
                    return verify.tree_digest(root, own_times=own_times)
            for target in (root / 'file', root):
                base = digest(target)
                for field in ('st_ino', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns'):
                    with self.subTest(target=target.name, field=field):
                        self.assertNotEqual(digest(target, field), base)
                with self.subTest(target=target.name, field='st_atime_ns'):
                    self.assertEqual(digest(target, 'st_atime_ns'), base)
            # Without own times only the root's mtime and ctime are left out.
            base = digest(root, own_times=False)
            for field in ('st_mtime_ns', 'st_ctime_ns'):
                self.assertEqual(digest(root, field, own_times=False), base)
                self.assertNotEqual(digest(root / 'file', field, own_times=False), digest(root / 'file', own_times=False))
            for field in ('st_ino', 'st_nlink'):
                self.assertNotEqual(digest(root, field, own_times=False), base)

    def test_tree_digest_without_own_times_ignores_only_the_root_times(self):
        """The staging parent's own mtime/ctime are excluded (the verifier
        itself creates and removes the secret directory in it); its inode,
        links and mode and every entry below it stay compared."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'nginx'
            root.mkdir()
            (root / 'conf').write_bytes(b'x')
            first = verify.tree_digest(root, own_times=False)
            (root / 'staged').mkdir(); (root / 'staged').rmdir()
            os.utime(root, ns=(10**9, 10**9))
            self.assertEqual(verify.tree_digest(root, own_times=False), first)
            self.assertNotEqual(verify.tree_digest(root), verify.tree_digest(root, own_times=False))
            os.utime(root / 'conf', ns=(10**9, 10**9))
            self.assertNotEqual(verify.tree_digest(root, own_times=False), first)
            second = verify.tree_digest(root, own_times=False)
            (root / 'staged').mkdir()
            self.assertNotEqual(verify.tree_digest(root, own_times=False), second)
            (root / 'staged').rmdir()
            os.rename(root, Path(directory) / 'old'); root.mkdir()
            os.chmod(root, stat.S_IMODE(os.lstat(Path(directory) / 'old').st_mode))
            os.rename(Path(directory) / 'old' / 'conf', root / 'conf')
            self.assertNotEqual(verify.tree_digest(root, own_times=False), second)

    def host(self, directory):
        """host_snapshot against a temporary UFW dir and lock only."""
        ufw = Path(directory) / 'ufw'
        ufw.mkdir()
        for name in ('user.rules', 'user6.rules'):
            (ufw / name).write_text(name)
        lock = Path(directory) / 'lock'
        stack = contextlib.ExitStack()
        for name, value in (('UFW_DIR', ufw), ('POLICY_TREES', ()), ('LOCK', lock),
                            ('install_targets', lambda: ()), ('run_snapshot', lambda reduced=(): 'run-view'),
                            ('firewall_rules', lambda: {'nft': 'n'})):
            stack.enter_context(mock.patch.object(verify, name, value))
        return lock, stack

    def recreate(self, lock):
        replacement = lock.with_name('replacement')
        replacement.write_bytes(lock.read_bytes()); replacement.chmod(stat.S_IMODE(os.lstat(lock).st_mode))
        info = os.lstat(lock)
        os.utime(replacement, ns=(info.st_atime_ns, info.st_mtime_ns))
        os.replace(replacement, lock)

    def test_lock_recreated_with_same_content_and_mode_fails_require_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            lock, stack = self.host(directory)
            with stack:
                lock.write_bytes(b''); lock.chmod(0o600)
                before = verify.host_snapshot()
                self.assertNotEqual(before[str(lock)], 'absent')
                verify.require_unchanged(before, 'nothing')
                self.recreate(lock)
                with self.assertRaisesRegex(verify.VerifyError, '^lock swap changed host state: ' + str(lock) + '$'):
                    verify.require_unchanged(before, 'lock swap')
                # Detected by the lock's identity itself, not only by tree_digest.
                with mock.patch.object(verify, 'tree_digest', return_value='digest'):
                    same = verify.host_snapshot()
                    self.recreate(lock)
                    self.assertRaises(verify.VerifyError, verify.require_unchanged, same, 'lock swap')
                    linked = verify.host_snapshot()
                    os.link(lock, Path(directory) / 'lock-link')
                    self.assertRaises(verify.VerifyError, verify.require_unchanged, linked, 'lock link')
                    os.unlink(Path(directory) / 'lock-link')
                    touched = verify.host_snapshot()
                    os.utime(lock, ns=(10**9, 10**9))
                    self.assertRaises(verify.VerifyError, verify.require_unchanged, touched, 'lock touch')
                    lock.unlink()
                    self.assertEqual(verify.host_snapshot()[str(lock)], 'absent')

    def test_host_snapshot_excludes_own_times_of_the_staging_parent_only(self):
        calls = []
        def digest(path, own_times=True, times_exempt=()):
            calls.append((str(path), own_times))
            exempt.append((str(path), tuple(times_exempt)))
            return 'digest'
        exempt = []
        with tempfile.TemporaryDirectory() as directory:
            ufw = Path(directory)
            for name in ('user.rules', 'user6.rules'):
                (ufw / name).write_text(name)
            with (mock.patch.object(verify, 'UFW_DIR', ufw),
                  mock.patch.object(verify, 'tree_digest', side_effect=digest),
                  mock.patch.object(verify, 'path_identity', return_value=(1,)),
                  mock.patch.object(verify, 'run_snapshot', return_value='run-view'),
                  mock.patch.object(verify, 'firewall_rules', return_value={'nft': 'n'})):
                verify.host_snapshot()
                # S0 (pristine, baseline, per command) and the nginx phase's
                # per-command comparisons: no exemption below NGINX_DIR.
                self.assertFalse([item for item in exempt if item[1]])
                exempt.clear()
                verify.host_snapshot(around_nginx_phase=True)
        self.assertEqual(verify.SECRET_DIR.parent, verify.NGINX_DIR)
        self.assertEqual([path for path, own in calls if not own], [str(verify.NGINX_DIR)] * 2)
        self.assertIn((str(verify.LOCK), True), calls)
        # Only around the whole nginx phase: NGINX_CONF_D (its include directory) below NGINX_DIR.
        self.assertEqual([item for item in exempt if item[1]], [(str(verify.NGINX_DIR), (verify.NGINX_CONF_D,))])
        self.assertEqual(verify.NGINX_INCLUDE.parent, verify.NGINX_CONF_D)


def load_nginx_observation():
    """The role's nginx_observation (it imports ufw_observation by name)."""
    with mock.patch.object(sys, 'path', [str(ROLE_FILES), *sys.path]), \
         mock.patch.dict(sys.modules):
        return load(ROLE_FILES / 'nginx_observation.py', 's0_test_nginx_observation')


class FakeNginxStaging:
    """Staging calls of the nginx phase against FakeNginxHost's file view."""

    def __init__(self, host):
        self.host, self.events, self.created = host, host.events, []

    def mkdir(self, path, mode):
        self.events.append(('mkdir', str(path), mode)); self.created.append(Path(path))
        if Path(path) == verify.STATE_DIR:
            self.host.state_dir = True

    def write(self, path, data, mode):
        self.events.append(('write', str(path), mode)); self.created.append(Path(path))
        self.host.files[Path(path)] = bytes(data); self.host.symlinks.discard(Path(path))

    def replace(self, path, data=None, mode=0o644, symlink_to=None):
        self.events.append(('replace', str(path), 'symlink' if symlink_to else 'file'))
        if symlink_to is not None:
            self.host.symlinks.add(Path(path))
        else:
            self.host.files[Path(path)] = bytes(data); self.host.symlinks.discard(Path(path))

    def record_created(self, path):
        self.events.append(('record_created', str(path))); self.created.append(Path(path))

    def cleanup(self):
        self.events.append(('cleanup',))
        return []


class FakeNginxHost:
    """A fake disposable host for verify_nginx_phase: CLI, nginx service, host views, journal.

    ``hook(host, name, ordinal)`` runs after each CLI invocation (``ordinal``
    counts the calls of that subcommand, from 0), so a test can change the
    host, nginx or the loaded units right after one command.
    """
    GENERATION = 'b' * 64
    LABELS = ('fixture', 'real_ip_recursive on', 'real_ip_recursive restored', 'bundle symlink',
              'bundle symlink restored', 'nginx stopped')

    def __init__(self, wrong_at=None, echo_secret_in=None, journal_secret=False, journal_live=True,
                 failing=None, active=True, hook=None, busy_ports=(), no_sandbox_at=None, secret_files=()):
        self.events, self.files, self.symlinks = [], {}, set()
        self.active, self.lock, self.state_dir = active, False, False
        self.wrong_at, self.echo_secret_in, self.failing = wrong_at, echo_secret_in, failing
        self.journal_secret, self.journal_live = journal_secret, journal_live
        self.hook, self.busy_ports, self.no_sandbox_at = hook, list(busy_ports), no_sandbox_at
        self.secret_files, self.searched = list(secret_files), None
        self.inspections, self.calls = 0, {}
        self.host = {str(verify.BUNDLE_DIR): 'bundle', str(verify.CONFIG_DIR): 'config'}
        self.stopped = {'/tmp': 'tmp'}
        self.master, self.workers = 1, 1
        self.units = {'run-pre.service'}
        self.journal = []

    def secrets(self):
        return [line.split('"')[1] for path, data in self.files.items() if path.name == 'http.conf'
                for line in data.decode().splitlines() if line.strip().startswith('"')]

    def nginx_component(self):
        geo, realip = verify.nginx_bundle_paths(verify.NGINX_BUNDLE_NAMES[0])
        if not self.active:
            return verify.NGINX_POLICY_UNSUPPORTED
        if b'real_ip_recursive on' in self.files[realip]:
            return verify.NGINX_POLICY_UNSUPPORTED
        if geo in self.symlinks:
            return verify.NGINX_OBSERVATION_FAILED
        return verify.NGINX_VERIFIED

    def run(self, args, name, timeout=60, text=True):
        verify.checkpoint()
        args = list(args)
        self.events.append(('run', name))
        def done(rc=0, stdout='', stderr=''):
            return subprocess.CompletedProcess(args, rc, stdout, stderr)
        if name == self.failing:
            return done(1)
        if args[:2] == ['/usr/bin/python3', str(verify.CLI)]:
            return self.cli(args, name, timeout, done)
        if self.echo_secret_in == name:
            return done(0, self.secrets()[-1])
        if args == [verify.NGINX, '-t', '-q']:
            return done()
        if args[0] == verify.SYSTEMCTL:
            if args[1] in ('stop', 'start'):
                self.active, self.master = args[1] == 'start', self.master + 1
                if args[1] == 'stop' and self.journal_live:
                    self.journal.append(b'UNIT=nginx.service\nJOB_TYPE=stop\nMESSAGE=Stopped nginx')
                return done()
            if args[1] == 'reload':
                self.workers += 1
                return done()
            if args[1] == 'is-active':
                return done(0 if self.active else 3)
            if args[1] == 'list-units':
                self.assertEqual(tuple(args), verify.TRANSIENT_UNITS_COMMAND)
                return done(0, ''.join(unit + ' loaded active running x\n' for unit in sorted(self.units)))
        if args[0] == verify.JOURNALCTL:
            if '--show-cursor' in args:
                return done(0, '-- cursor: s=abc;i=%d\n' % len(self.journal))
            if args[1:] == ['--sync']:
                return done()
            after = [arg for arg in args if arg.startswith('--after-cursor=s=abc;i=')]
            entries = self.journal[int(after[0].rsplit('=', 1)[1]):] if after else list(self.journal)
            if self.journal_secret and not after:
                entries.append(b'MESSAGE=x' + self.secrets()[1].encode())
            return done(0, b'\n\n'.join(entries) + b'\n\n', b'')
        raise AssertionError('unexpected command: %r' % (args,))

    def cli(self, args, name, timeout, done):
        ordinal = self.calls.get(name, 0)
        self.calls[name] = ordinal + 1
        if name == '--help':
            result = done(0, role_cli_help())
        elif name == 'verify-cohort':
            self.lock = True
            result = done(0, json.dumps({'generation_id': self.GENERATION, 'cohort_verified': True,
                                         'runtime_ready': False, 'policy_verified': False}))
        elif name == 'inspect-runtime':
            self.assertEqual(timeout, verify.NGINX_INSPECT_TIMEOUT)
            if not (self.lock and self.state_dir):
                return done(1, stderr=verify.SANITIZED_FAILURE_STDERR)
            nginx = self.nginx_component()
            if self.inspections == self.wrong_at:
                nginx = {'status': 'failure', 'code': 'other'} if nginx == verify.NGINX_VERIFIED else verify.NGINX_VERIFIED
            self.events.append(('inspect', self.inspections, nginx['code'])); self.inspections += 1
            if self.no_sandbox_at != ordinal:
                self.journal.append(b'UNIT=run-u%d.service\nMESSAGE=Started run-u%d.service - %s -T -q.'
                                    % (ordinal, ordinal, verify.NGINX.encode()))
            stdout = json.dumps({'generation_id': self.GENERATION, **verify.EXPECTED_INSPECT_RUNTIME, 'nginx': nginx})
            result = done(0, stdout, self.secrets()[0] if self.echo_secret_in == 'inspect-runtime' else '')
        else:
            self.assertEqual(name in verify.REFUSED_ARGUMENTS, True)
            self.events.append(('refused', name, tuple(args[2:])))
            result = done(1, self.secrets()[0] if self.echo_secret_in == 'refused' else '', verify.REFUSAL_STDERR)
        if self.hook:
            self.hook(self, name, ordinal)
        return result

    @staticmethod
    def assertEqual(first, second):
        if first != second:
            raise AssertionError('%r != %r' % (first, second))

    def phase_snapshot(self):
        self.events.append(('phase_snapshot',))
        fixture = repr((sorted((str(path), data) for path, data in self.files.items()), sorted(map(str, self.symlinks))))
        return {**self.host, str(verify.LOCK): 'lock' if self.lock else 'absent',
                str(verify.STATE_DIR): 'dir' if self.state_dir else 'absent', str(verify.NGINX_FIXTURE_TOP): fixture}

    def stopped_snapshot(self):
        self.events.append(('stopped_snapshot',))
        return dict(self.stopped)

    def light(self):
        return {str(verify.LOCK): 'lock' if self.lock else 'absent', 'host': repr(sorted(self.host.items()))}

    def identity(self):
        self.events.append(('identity',))
        if not self.active:
            raise verify.VerifyError('nginx pid file is absent while nginx runs')
        return {'master_start': self.master, 'children': [self.workers]}

    def ports(self):
        if self.busy_ports:
            return list(self.busy_ports)
        return list(verify.NGINX_FIXTURE_PORTS) if self.active and self.files else []

    def search(self, roots, secrets_, exclude=()):
        self.events.append(('search',))
        self.searched = (roots, tuple(secrets_), [Path(path) for path in exclude])
        return list(self.secret_files)

    def patches(self):
        return (mock.patch.object(verify, 'run', side_effect=self.run),
                mock.patch.object(verify, 'stage_bundle', side_effect=lambda source, staging: (
                    self.events.append(('stage_bundle',)), self.GENERATION)[1]),
                mock.patch.object(verify, 'phase_snapshot', side_effect=self.phase_snapshot),
                mock.patch.object(verify, 'stopped_snapshot', side_effect=self.stopped_snapshot),
                mock.patch.object(verify, 'light_snapshot', side_effect=self.light),
                mock.patch.object(verify, 'nginx_process_identity', side_effect=self.identity),
                mock.patch.object(verify, 'files_holding_secret', side_effect=self.search),
                mock.patch.object(verify, 'secret_search_roots', return_value=('roots',)),
                mock.patch.object(verify.time, 'sleep'),
                mock.patch.object(verify, 'require_lock_file', side_effect=lambda: None if self.lock else (
                    _ for _ in ()).throw(verify.VerifyError('CLI lock file is absent'))),
                mock.patch.object(verify, 'fixture_ports_listening', side_effect=self.ports),
                mock.patch.object(verify.os.path, 'lexists', side_effect=lambda path: (
                    self.lock if Path(path) == verify.LOCK else self.active if Path(path) == verify.NGINX_PID
                    else False)))


def at(target, change):
    """A FakeNginxHost hook that applies ``change(host)`` right after the CLI call ``target`` = (name, ordinal)."""
    def hook(host, name, ordinal):
        if (name, ordinal) == target:
            change(host)
    return hook


class NginxPhaseTests(TestCase):
    """verify_nginx_phase assembled against FakeNginxHost (no root, no host commands)."""

    def run_phase(self, host):
        staging, service = FakeNginxStaging(host), verify.NginxService()
        with contextlib_stack(host.patches()):
            return verify.verify_nginx_phase('/unused', staging, service), staging, service

    def test_phase_order_expectations_and_report(self):
        host = FakeNginxHost()
        report, staging, service = self.run_phase(host)
        refused = sorted(verify.REFUSED_ARGUMENTS)
        self.assertEqual(report, {
            'nginx_checks': 'passed', 'bundles': 3, 'policy_verified': 'nginx_policy_verified',
            'recursive_on': 'nginx_policy_unsupported', 'bundle_symlink': 'nginx_observation_failed',
            'nginx_stopped': 'nginx_policy_unsupported', 'stopped_host_unchanged': True,
            'stopped_sandbox_ran': True, 'host_unchanged_per_command': True,
            'nginx_not_reloaded_by_commands': True, 'refused_commands': refused,
            'refused_secret_not_echoed': True, 'transient_units_left': 0,
            'secrets_not_echoed': True, 'secret_files_absent': True, 'journal_secret_free': True})
        self.assertEqual([event[1:] for event in host.events if event[0] == 'inspect'], [
            (0, 'nginx_policy_verified'), (1, 'nginx_policy_unsupported'), (2, 'nginx_policy_verified'),
            (3, 'nginx_observation_failed'), (4, 'nginx_policy_verified'), (5, 'nginx_policy_unsupported')])
        names = [event[1] for event in host.events if event[0] == 'run']
        # Units before the phase are listed before anything is staged.
        self.assertEqual(names[:6], ['systemctl is-active', 'systemctl list-units', 'journalctl cursor',
                                     'verify-cohort', 'nginx -t', 'systemctl reload'])
        self.assertEqual(service.units_before, ['run-pre.service'])
        # Every refused subcommand in every argv shape, with the nginx-enabled config.
        calls = [event[1:] for event in host.events if event[0] == 'refused']
        argv_secret = calls[0][1][-1].split('=', 1)[1]
        self.assertRegex(argv_secret, '^cf-s1-argv-secret-[0-9a-f]{32}$')
        self.assertEqual(calls, [(name, (*prefix, name, *extra)) for name in refused
                                 for prefix, extra in verify.refused_invocations(name, argv_secret)])
        self.assertLess(names.index('inspect-runtime'), names.index('--help'))
        # Each running inspect: baseline and nginx identity right before, both
        # compared right after, then the unit check.
        for index in range(5):
            position = [event[:2] for event in host.events].index(('inspect', index))
            self.assertEqual(host.events[position - 3:position + 4], [
                ('phase_snapshot',), ('identity',), ('run', 'inspect-runtime'), host.events[position],
                ('phase_snapshot',), ('identity',), ('run', 'systemctl list-units')])
        # The stopped check: stop, snapshots, cursor, inspect, snapshots, units, journal, start.
        stop = host.events.index(('run', 'systemctl stop'))
        sequence = [event for event in host.events[stop:] if event[0] != 'inspect']
        self.assertEqual(sequence[:14], [
            ('run', 'systemctl stop'), ('run', 'systemctl is-active'), ('phase_snapshot',), ('stopped_snapshot',),
            ('run', 'journalctl cursor'), ('run', 'inspect-runtime'), ('phase_snapshot',), ('stopped_snapshot',),
            ('run', 'systemctl is-active'), ('run', 'systemctl list-units'), ('run', 'journalctl sync'),
            ('run', 'journalctl phase'), ('run', 'systemctl start'), ('run', 'systemctl is-active')])
        # journalctl --sync precedes every journal read; the file search and the
        # journal check are the last steps (before cleanup, which is with_cleanup's).
        tail = [event for event in host.events if event[0] in ('run', 'search')][-5:]
        self.assertEqual(tail, [('search',), ('run', 'journalctl sync'), ('run', 'journalctl'),
                                ('run', 'journalctl sync'), ('run', 'journalctl phase')])
        # Staging: bundle, config (nginx enabled for every bundle), fixture, state directory, then the lock.
        kinds = [event for event in host.events if event[0] in ('stage_bundle', 'mkdir', 'write', 'record_created')]
        self.assertEqual(kinds[0], ('stage_bundle',))
        self.assertEqual(kinds[1:3], [('mkdir', str(verify.CONFIG_DIR), 0o755), ('write', str(verify.CONFIG), 0o640)])
        config = json.loads(host.files[verify.CONFIG])
        self.assertEqual(config['nginx'], verify.nginx_phase_config())
        self.assertEqual(config['firewall'], {'backend': 'ufw', 'ports': [443]})
        self.assertIn(('mkdir', str(verify.STATE_DIR), 0o755), kinds)
        self.assertIn(('record_created', str(verify.LOCK)), kinds)
        # Negative cases replace only the first bundle and restore it.
        geo, realip = verify.nginx_bundle_paths('cf01')
        self.assertEqual([event[1:] for event in host.events if event[0] == 'replace'], [
            (str(realip), 'file'), (str(realip), 'file'), (str(geo), 'symlink'), (str(geo), 'file')])
        self.assertIn(('write', str(verify.NGINX_SYMLINK_TARGET), 0o644), host.events)
        self.assertEqual(host.files[verify.NGINX_SYMLINK_TARGET], host.files[geo])
        self.assertTrue(service.reloaded)
        self.assertFalse(service.stopped)
        self.assertTrue(host.active)
        # The file search covers every secret (bundle and argv) and excludes
        # only the staged fixture files that hold them by design.
        roots, searched, exclude = host.searched
        self.assertEqual(roots, ('roots',))
        self.assertEqual(sorted(searched), sorted([*host.secrets(), argv_secret]))
        self.assertTrue(exclude and all(verify.nginx_reads(path) for path in exclude))
        self.assertIn(geo, exclude)
        self.assertNotIn(verify.CONFIG, exclude)

    def test_any_unexpected_nginx_component_fails_with_its_step(self):
        for index, label in enumerate(FakeNginxHost.LABELS):
            with self.subTest(step=label):
                host = FakeNginxHost(wrong_at=index)
                with self.assertRaisesRegex(verify.VerifyError, '^' + label + ': inspect-runtime differs'):
                    self.run_phase(host)

    def test_service_actions_are_recorded_before_they_run(self):
        for failing, attribute in (('systemctl reload', 'reloaded'), ('systemctl stop', 'stopped')):
            with self.subTest(command=failing):
                host = FakeNginxHost(failing=failing)
                staging, service = FakeNginxStaging(host), verify.NginxService()
                with contextlib_stack(host.patches()):
                    with self.assertRaisesRegex(verify.VerifyError, '^' + failing + r' failed \(rc=1\)$'):
                        verify.verify_nginx_phase('/unused', staging, service)
                self.assertTrue(getattr(service, attribute))

    def test_inactive_nginx_or_a_busy_fixture_port_stops_before_staging(self):
        for host, message in ((FakeNginxHost(active=False), '^nginx is not active before the nginx phase$'),
                              (FakeNginxHost(busy_ports=(8102,)), '^a fixture port is already in use: 8102$')):
            with self.subTest(message=message):
                with self.assertRaisesRegex(verify.VerifyError, message):
                    self.run_phase(host)
                self.assertFalse([event for event in host.events if event[0] in ('stage_bundle', 'mkdir', 'write')])
        self.assertEqual(verify.NGINX_FIXTURE_PORTS, (8101, 8102, 8103))

    def test_a_host_change_right_after_any_command_fails(self):
        def change(host):
            host.host[str(verify.BUNDLE_DIR)] = 'modified'
        cases = [(('verify-cohort', 0), r'^verify-cohort \(nginx phase\) changed host state other than creating'),
                 *((('inspect-runtime', index), r'^inspect-runtime \(' + re.escape(label) + r'\) changed host state: '
                    + re.escape(str(verify.BUNDLE_DIR)) + '$')
                   for index, label in enumerate(FakeNginxHost.LABELS[:5])),
                 (('inspect-runtime', 5), '^inspect-runtime with nginx stopped changed host state: host:'
                  + re.escape(str(verify.BUNDLE_DIR)) + '$'),
                 (('apply', 0), r'^apply \(nginx enabled, argv shape 0\) changed host state: host$')]
        for target, message in cases:
            with self.subTest(target=target):
                with self.assertRaisesRegex(verify.VerifyError, message):
                    self.run_phase(FakeNginxHost(hook=at(target, change)))
        # A change of the fixture, the lock or the state directory counts too.
        def fixture(host):
            host.files[verify.nginx_bundle_paths('cf02')[0]] += b'#'
        with self.assertRaisesRegex(verify.VerifyError, r'^inspect-runtime \(fixture\) changed host state: /etc/common-sv$'):
            self.run_phase(FakeNginxHost(hook=at(('inspect-runtime', 0), fixture)))
        with self.assertRaisesRegex(verify.VerifyError, 'nginx stopped changed host state: stopped:/tmp$'):
            self.run_phase(FakeNginxHost(hook=at(('inspect-runtime', 5), lambda host: host.stopped.update({'/tmp': 'x'}))))
        # The lock created by verify-cohort is not a change (baseline after it).
        self.run_phase(FakeNginxHost())

    def test_a_reload_restart_or_signal_during_a_running_command_fails(self):
        def reload(host):
            host.workers += 1
        def restart(host):
            host.master += 1
        for index, label in enumerate(FakeNginxHost.LABELS[:5]):
            for change, key in ((reload, 'children'), (restart, 'master_start')):
                with self.subTest(step=label, key=key):
                    with self.assertRaisesRegex(verify.VerifyError, r'^inspect-runtime \(' + re.escape(label)
                                                + r'\) reloaded, restarted or signalled nginx: ' + key + '$'):
                        self.run_phase(FakeNginxHost(hook=at(('inspect-runtime', index), change)))
        with self.assertRaisesRegex(verify.VerifyError, r'^plan \(nginx enabled\) reloaded, restarted or signalled'):
            self.run_phase(FakeNginxHost(hook=at(('plan', 1), reload)))

    def test_a_refused_subcommand_with_nginx_must_refuse_without_echo(self):
        with self.assertRaisesRegex(verify.VerifyError, '^apply did not refuse') as caught:
            self.run_phase(FakeNginxHost(echo_secret_in='refused'))
        self.assertNotRegex(str(caught.exception), '[0-9a-f]{32}')
        # The secrets of the refused calls are checked with every result again.
        results = [{'command': 'apply', 'stdout': '', 'stderr': 'cf-s1-argv-secret-x'}]
        with self.assertRaisesRegex(verify.VerifyError, '^apply echoed a fixture secret$'):
            verify.check_secrets_not_echoed(results, ('cf-s1-argv-secret-x',))

    def test_a_transient_unit_left_after_any_inspect_fails(self):
        for index, label in enumerate(FakeNginxHost.LABELS):
            with self.subTest(step=label):
                hook = at(('inspect-runtime', index), lambda host: host.units.add('run-u99.service'))
                with self.assertRaisesRegex(verify.VerifyError, r'^inspect-runtime \(' + re.escape(label)
                                            + r'\) left a transient unit behind: run-u99.service$'):
                    self.run_phase(FakeNginxHost(hook=hook))
        # A unit loaded before the phase is not this run's.
        host = FakeNginxHost()
        host.units.add('run-u1.service')
        self.run_phase(host)

    def test_the_stopped_inspect_must_run_the_sandbox_and_leave_nginx_stopped(self):
        with self.assertRaisesRegex(verify.VerifyError, '^inspect-runtime with nginx stopped did not run the nginx sandbox$'):
            self.run_phase(FakeNginxHost(no_sandbox_at=5))
        with self.assertRaisesRegex(verify.VerifyError, '^inspect-runtime with nginx stopped started nginx$'):
            self.run_phase(FakeNginxHost(hook=at(('inspect-runtime', 5), lambda host: setattr(host, 'active', True))))

    def test_a_secret_in_any_output_a_file_or_the_journal_fails(self):
        # A secret on inspect-runtime's stderr already fails the exact JSON
        # check; check_secrets_not_echoed covers stdout and stderr again.
        for where, message in (('inspect-runtime', r'fixture: inspect-runtime failed \(rc=0\)'),
                               ('nginx -t', 'nginx -t printed a fixture secret'),
                               ('systemctl reload', 'systemctl reload printed a fixture secret')):
            with self.subTest(where=where):
                with self.assertRaisesRegex(verify.VerifyError, '^' + message + '$') as caught:
                    self.run_phase(FakeNginxHost(echo_secret_in=where))
                self.assertNotRegex(str(caught.exception), '[0-9a-f]{32}')
        echoed = {'command': 'inspect-runtime', 'stdout': '{"x":"S1"}', 'stderr': ''}
        with self.assertRaisesRegex(verify.VerifyError, '^inspect-runtime echoed a fixture secret$'):
            verify.check_secrets_not_echoed([echoed], ['S0', 'S1'])
        verify.check_secrets_not_echoed([echoed], ['S2'])
        with self.assertRaisesRegex(verify.VerifyError, '^a fixture secret is in a file: /var/log/nginx/error.log$'):
            self.run_phase(FakeNginxHost(secret_files=['/var/log/nginx/error.log']))
        with self.assertRaisesRegex(verify.VerifyError, '^a fixture secret is in the journal$'):
            self.run_phase(FakeNginxHost(journal_secret=True))
        with self.assertRaisesRegex(verify.VerifyError, '^the journal did not record the nginx phase$'):
            self.run_phase(FakeNginxHost(journal_live=False))

    def test_secrets_are_random_per_run_and_distinct_per_bundle(self):
        first, second = FakeNginxHost(), FakeNginxHost()
        self.run_phase(first); self.run_phase(second)
        self.assertEqual(len(set(first.secrets())), len(verify.NGINX_BUNDLE_NAMES))
        self.assertFalse(set(first.secrets()) & set(second.secrets()))
        self.assertTrue(all(re.fullmatch('[0-9a-f]{32}', secret) for secret in first.secrets()))


class NginxFixtureTests(TestCase):
    def test_fixture_matches_the_observer_constants_and_shared_format(self):
        observation = load_nginx_observation()
        self.assertEqual((verify.NGINX_GEO_NAME, verify.NGINX_REALIP_NAME),
                         (observation.GEO_NAME, observation.REALIP_NAME))
        self.assertEqual(verify.NGINX, observation.NGINX)
        self.assertEqual(verify.SYSTEMCTL, observation.SYSTEMCTL)
        files = dict(verify.nginx_fixture_files({name: 'S-' + name for name in verify.NGINX_BUNDLE_NAMES}))
        shared = verify.NGINX_SHARED_DIR
        self.assertEqual(observation.parse_shared(files[shared / verify.NGINX_GEO_NAME],
                                                  files[shared / verify.NGINX_REALIP_NAME]),
                         verify.NGINX_RANGES)

    def test_each_bundle_binds_the_shared_files_and_carries_only_its_secret(self):
        secrets_ = {name: 'S-' + name for name in verify.NGINX_BUNDLE_NAMES}
        items = verify.nginx_fixture_files(secrets_)
        files = dict(items)
        self.assertEqual(len(items), len(files))
        self.assertEqual(items[-1][0], verify.NGINX_INCLUDE)
        include = files[verify.NGINX_INCLUDE].decode()
        self.assertGreaterEqual(len(verify.NGINX_BUNDLE_NAMES), 2)
        for name in verify.NGINX_BUNDLE_NAMES:
            geo, realip = verify.nginx_bundle_paths(name)
            text = files[geo].decode()
            self.assertIn('geo $realip_remote_addr $cloudfront_origin_%s {' % name, text)
            self.assertEqual(text.count('include %s;' % (verify.NGINX_SHARED_DIR / verify.NGINX_GEO_NAME)), 1)
            self.assertEqual(text.count('default 0;'), 2)
            self.assertEqual([secret for secret in secrets_.values() if secret in text], [secrets_[name]])
            self.assertEqual(files[realip], ('include %s;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n'
                                             % (verify.NGINX_SHARED_DIR / verify.NGINX_REALIP_NAME)).encode())
            self.assertIn('include %s;\n' % geo, include)
            self.assertIn('include %s;' % realip, files[verify.NGINX_FIXTURE_ROOT / 'vhosts.conf'].decode())
        self.assertEqual(verify.nginx_realip_bundle('on').count(b'real_ip_recursive on;'), 1)
        for port in verify.NGINX_FIXTURE_PORTS:
            self.assertIn('listen 127.0.0.1:%d;' % port, files[verify.NGINX_FIXTURE_ROOT / 'vhosts.conf'].decode())
        # The config names every bundle in order, inside the CLI's permitted prefixes.
        config = verify.nginx_phase_config()
        self.assertEqual(config['shared_dir'], '/etc/common-sv/nginx/cloudfront')
        self.assertEqual([(item['geo_file'], item['realip_file']) for item in config['bundles']],
                         [tuple(map(str, verify.nginx_bundle_paths(name))) for name in verify.NGINX_BUNDLE_NAMES])
        self.assertTrue(config['enabled'])

    def test_stage_nginx_fixture_creates_directories_then_files_root_0644(self):
        host = FakeNginxHost()
        staging = FakeNginxStaging(host)
        verify.stage_nginx_fixture(staging, {name: 'S' for name in verify.NGINX_BUNDLE_NAMES})
        mkdirs = [event[1:] for event in host.events if event[0] == 'mkdir']
        self.assertEqual(mkdirs[0], (str(verify.NGINX_SHARED_DIR), 0o755))
        self.assertEqual(mkdirs[1:], [(str(verify.nginx_bundle_paths(name)[0].parent), 0o755)
                                      for name in verify.NGINX_BUNDLE_NAMES])
        writes = [event[1:] for event in host.events if event[0] == 'write']
        self.assertEqual(writes, [(str(path), 0o644) for path, _ in verify.nginx_fixture_files(
            {name: 'S' for name in verify.NGINX_BUNDLE_NAMES})])
        self.assertIn(verify.NGINX_FIXTURE_TOP, verify.staged_roots())
        self.assertIn(verify.NGINX_INCLUDE, verify.staged_roots())


class NginxHostViewTests(TestCase):
    def test_staging_replace_swaps_content_or_symlink_and_cleanup_removes_all(self):
        with tempfile.TemporaryDirectory() as directory:
            staging = verify.Staging()
            root = Path(directory) / 'fixture'
            staging.mkdir(root, 0o755)
            target, other = root / 'file', root / 'other'
            staging.write(target, b'one', 0o644)
            staging.write(other, b'two', 0o644)
            first = target.lstat().st_ino
            staging.replace(target, b'three', 0o644)
            self.assertEqual((target.read_bytes(), stat.S_IMODE(target.lstat().st_mode)), (b'three', 0o644))
            self.assertNotEqual(target.lstat().st_ino, first)
            staging.replace(target, symlink_to=other)
            self.assertTrue(target.is_symlink())
            self.assertEqual(os.readlink(target), str(other))
            staging.replace(target, b'four', 0o600)
            self.assertFalse(target.is_symlink())
            self.assertEqual(sorted(os.listdir(root)), ['file', 'other'])
            with self.assertRaisesRegex(verify.VerifyError, '^not staged by this run: '):
                staging.replace(Path(directory) / 'foreign', b'x')
            self.assertEqual(staging.cleanup(), [])
            self.assertFalse(root.exists())

    def test_tree_digest_times_exempt_drops_only_that_directory_s_times(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'nginx'
            exempt = root / 'conf.d'
            exempt.mkdir(parents=True)
            (root / 'nginx.conf').write_text('x')
            before = verify.tree_digest(root, times_exempt=(exempt,))
            (exempt / 'staged.conf').write_text('y'); (exempt / 'staged.conf').unlink()
            self.assertEqual(verify.tree_digest(root, times_exempt=(exempt,)), before)
            self.assertNotEqual(verify.tree_digest(root), verify.tree_digest(root, times_exempt=(exempt,)))
            (exempt / 'left.conf').write_text('y')
            self.assertNotEqual(verify.tree_digest(root, times_exempt=(exempt,)), before)
            (exempt / 'left.conf').unlink()
            os.utime(root / 'nginx.conf', ns=(10**9, 10**9))
            self.assertNotEqual(verify.tree_digest(root, times_exempt=(exempt,)), before)

    def test_run_snapshot_reduced_keeps_presence_type_mode_and_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            (run / 'nginx.pid').write_text('1\n'); (run / 'nginx.pid').chmod(0o644)
            reduced = verify.run_snapshot(run, reduced=('nginx.pid',))
            full = verify.run_snapshot(run)
            (run / 'nginx.pid').unlink(); (run / 'nginx.pid').write_text('22\n'); (run / 'nginx.pid').chmod(0o644)
            self.assertEqual(verify.run_snapshot(run, reduced=('nginx.pid',)), reduced)
            self.assertNotEqual(verify.run_snapshot(run), full)
            (run / 'nginx.pid').chmod(0o600)
            self.assertNotEqual(verify.run_snapshot(run, reduced=('nginx.pid',)), reduced)
            (run / 'nginx.pid').unlink()
            self.assertNotEqual(verify.run_snapshot(run, reduced=('nginx.pid',)), reduced)
            # Other watched names stay fully compared.
            (run / 'nginx.pid').write_text('1\n'); (run / 'nginx.pid').chmod(0o644)
            (run / 'ufw.lock').write_text('')
            base = verify.run_snapshot(run, reduced=('nginx.pid',))
            os.utime(run / 'ufw.lock', ns=(10**9, 10**9))
            self.assertNotEqual(verify.run_snapshot(run, reduced=('nginx.pid',)), base)

    def test_host_snapshot_reduces_nginx_pid_only_around_the_nginx_phase(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            ufw = Path(directory)
            for name in ('user.rules', 'user6.rules'):
                (ufw / name).write_text(name)
            with (mock.patch.object(verify, 'UFW_DIR', ufw), mock.patch.object(verify, 'POLICY_TREES', ()),
                  mock.patch.object(verify, 'install_targets', return_value=()),
                  mock.patch.object(verify, 'path_identity', return_value='absent'),
                  mock.patch.object(verify, 'run_snapshot', side_effect=lambda reduced=(): calls.append(reduced)),
                  mock.patch.object(verify, 'firewall_rules', return_value={})):
                verify.host_snapshot()
                verify.host_snapshot(around_nginx_phase=True)
                verify.require_unchanged({'/run/lock/cloudfront-sync.lock': 'absent', '/run': None}, 'x',
                                         around_nginx_phase=True)
        self.assertEqual(calls, [(), ('nginx.pid',), ('nginx.pid',)])
        self.assertEqual(verify.NGINX_PID, Path('/run/nginx.pid'))

    def test_stopped_snapshot_covers_pid_trees_and_run_view(self):
        calls = []
        with mock.patch.object(verify, 'tree_digest', side_effect=lambda path, own_times=True: calls.append(
                (str(path), own_times)) or 'd'), \
             mock.patch.object(verify, 'path_identity', return_value='absent'), \
             mock.patch.object(verify, 'run_snapshot', return_value='run-view'):
            snapshot = verify.stopped_snapshot()
        self.assertEqual(calls, [('/var/log/nginx', True), ('/var/lib/nginx', True), ('/var/cache/nginx', True),
                                 ('/dev/shm', True), ('/tmp', False), ('/var/tmp', False)])
        self.assertEqual(snapshot['/run/nginx.pid'], 'absent')
        self.assertEqual(snapshot['/run'], 'run-view')

    def test_transient_units_and_journal_cursor_parsing(self):
        listing = ('run-u3.service loaded active running x\nrun-a.mount not-found inactive dead y\n'
                   '\u25cf run-u4.service loaded failed failed z\nnginx.service loaded active running n\n\n')
        calls = []
        def fake(args, name, timeout=60):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, 0, listing, '')
        with mock.patch.object(verify, 'run', side_effect=fake):
            self.assertEqual(verify.transient_units(), ['run-u3.service', 'run-u4.service'])
        # Only .service units are listed and kept (a run-*.mount is no sandbox).
        self.assertEqual(calls, [[verify.SYSTEMCTL, 'list-units', '--all', '--no-legend', '--plain', 'run-*.service']])
        self.assertEqual(verify.parse_transient_units(listing), ['run-u3.service', 'run-u4.service'])
        with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 1, '', '')):
            self.assertRaisesRegex(verify.VerifyError, 'list-units failed', verify.transient_units)
        with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 0, '-- cursor: s=1;i=2\n', '')):
            self.assertEqual(verify.journal_cursor(), 's=1;i=2')
        for rc, stdout in ((0, ''), (1, '-- cursor: s=1\n'), (0, '-- cursor: s=1\nextra\n')):
            with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], rc, stdout, '')):
                self.assertRaisesRegex(verify.VerifyError, 'cursor unavailable', verify.journal_cursor)

    def test_journal_is_read_whole_in_export_format_as_bytes(self):
        calls = []
        live = (b'UNIT=nginx.service\nJOB_TYPE=stop\n\nUNIT=run-u1.service\nMESSAGE=Started run-u1.service - '
                + verify.NGINX.encode() + b' -T -q.\n\n')
        def fake(args, name, timeout=60, text=True):
            calls.append((list(args), timeout, text))
            return subprocess.CompletedProcess(args, 0, live, b'')
        with mock.patch.object(verify, 'run', side_effect=fake):
            verify.check_journal('s=1', ['secret'])
        # journalctl --sync before each read, so nothing logged so far is missed.
        sync = ([verify.JOURNALCTL, '--sync'], 60, True)
        self.assertEqual(calls, [sync, ([verify.JOURNALCTL, '--no-pager', '-o', 'export'], 120, False),
                                 sync, ([verify.JOURNALCTL, '--no-pager', '-o', 'export', '--after-cursor=s=1'], 120, False)])
        with mock.patch.object(verify, 'run', side_effect=lambda args, name, timeout=60, text=True:
                               subprocess.CompletedProcess(args, 1 if args[1:] == ['--sync'] else 0, live, b'')):
            self.assertRaisesRegex(verify.VerifyError, r'^journalctl --sync failed$', verify.check_journal, 's=1', [])
        self.assertTrue(verify.sandbox_ran(live.split(b'\n\n')))
        self.assertFalse(verify.sandbox_ran([b'UNIT=nginx.service\nMESSAGE=' + verify.NGINX.encode() + b' -T -q']))
        # The stop job and the sandbox unit must be journaled after the cursor (each field on its own line).
        for broken in (live.replace(b'JOB_TYPE=stop', b'JOB_TYPE=start'), live.replace(b'-T -q', b'-t'),
                       live.replace(b'UNIT=run-u1', b'X_UNIT=run-u1'), b'', live.replace(b'\nJOB_TYPE', b'\n\nJOB_TYPE')):
            with self.subTest(journal=broken[:40]):
                with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 0, broken or b'x', b'')):
                    self.assertRaisesRegex(verify.VerifyError, 'did not record', verify.check_journal, 's=1', [])
        for failing in (['--no-pager', '-o', 'export'], ['--no-pager', '-o', 'export', '--after-cursor=s=1']):
            with mock.patch.object(verify, 'run', side_effect=lambda args, name, timeout=60, text=True:
                                   subprocess.CompletedProcess(args, 1 if args[1:] == failing else 0, live, b'')):
                self.assertRaisesRegex(verify.VerifyError, '^journalctl failed$', verify.check_journal, 's=1', [])
        with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 0, live + b'Xsecret', b'')):
            self.assertRaisesRegex(verify.VerifyError, '^a fixture secret is in the journal$',
                                   verify.check_journal, 's=1', ['secret'])

    def test_sandbox_ran_accepts_both_transient_unit_name_forms(self):
        """systemd-run names its unit run-u<N>.service (systemd 249/255) or run-p<PID>-i<N>.service (259, 26.04)."""
        command = verify.NGINX.encode() + b' -T -q'
        def entry(unit):
            return b'_PID=1\nUNIT=' + unit + b'\nMESSAGE=Started ' + unit + b' - ' + command + b'.'
        for unit in (b'run-u1.service', b'run-u4711.service', b'run-p17074-i17099.service', b'run-p1-i2.service'):
            with self.subTest(unit=unit):
                self.assertTrue(verify.sandbox_ran([b'UNIT=nginx.service\nJOB_TYPE=stop', entry(unit)]))
                live = b'UNIT=nginx.service\nJOB_TYPE=stop\n\n' + entry(unit) + b'\n\n'
                with mock.patch.object(verify, 'run', return_value=subprocess.CompletedProcess([], 0, live, b'')):
                    verify.check_journal('s=1', [])
        # Not a systemd-run transient service unit, or not the sandbox's command.
        for unit in (b'nginx.service', b'run-x1.service', b'run-p17074.service', b'run-i1.service', b'run-p1-i.service',
                     b'run-pX-i1.service', b'run-p1-i2.scope', b'run-u1.service.d', b'xrun-u1.service', b'run-p1-i2-x.service'):
            with self.subTest(unit=unit):
                self.assertFalse(verify.sandbox_ran([entry(unit)]))
        self.assertFalse(verify.sandbox_ran([entry(b'run-p1-i2.service').replace(b' -T -q', b' -t')]))
        self.assertFalse(verify.sandbox_ran([entry(b'run-p1-i2.service').replace(b'\nUNIT=', b'\nX_UNIT=')]))

    def test_fixture_ports_listening_connects_to_localhost(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0)); server.listen()
            port = server.getsockname()[1]
            with socket.socket() as closed:
                closed.bind(('127.0.0.1', 0))
                free = closed.getsockname()[1]
            with mock.patch.object(verify, 'NGINX_FIXTURE_PORTS', (port, free)):
                self.assertEqual(verify.fixture_ports_listening(), [port])


class NginxHostCheckTests(TestCase):
    """The nginx phase's host checks against temporary trees and a fake /proc."""

    def proc(self, directory, processes):
        """A fake /proc: {pid: (comm, ppid, starttime)}."""
        proc = Path(directory) / 'proc'
        proc.mkdir()
        (proc / 'self').mkdir()
        for pid, (comm, ppid, start) in processes.items():
            (proc / str(pid)).mkdir()
            fields = ['S', str(ppid)] + ['0'] * 17 + [str(start), '0']
            (proc / str(pid) / 'stat').write_text('%d (%s) %s\n' % (pid, comm, ' '.join(fields)))
        return proc

    def identity(self, directory, processes, show='MainPID=10\nExecMainStartTimestampMonotonic=5\nNRestarts=0\n',
                 pid_text='10\n', rc=0):
        pid = Path(directory) / 'nginx.pid'
        if pid_text is None:
            pid.unlink(missing_ok=True)
        elif not pid.exists() or pid.read_text() != pid_text:
            pid.write_text(pid_text)
        calls = []
        def fake(args, name, timeout=60):
            calls.append(list(args))
            return subprocess.CompletedProcess(args, rc, show, '')
        try:
            with mock.patch.object(verify, 'run', side_effect=fake), mock.patch.object(verify, 'NGINX_PID', pid):
                value = verify.nginx_process_identity(self.proc(directory, processes))
        finally:
            shutil.rmtree(Path(directory) / 'proc')
        self.assertEqual(calls, [[verify.SYSTEMCTL, 'show', '--property=MainPID',
                                  '--property=ExecMainStartTimestampMonotonic', '--property=NRestarts',
                                  'nginx.service']])
        return value

    def test_nginx_process_identity_detects_reload_restart_and_pid_file_changes(self):
        master = {10: ('nginx', 1, 100), 11: ('nginx', 10, 101), 12: ('nginx', 10, 102), 13: ('bash (x)', 1, 1)}
        with tempfile.TemporaryDirectory() as directory:
            base = self.identity(directory, master)
            self.assertEqual(base['children'], [(11, 101), (12, 102)])
            self.assertEqual(base['master_start'], 100)
            self.assertEqual(self.identity(directory, master), base)
            # Reload: new workers (and the old ones gone).
            reloaded = {10: master[10], 14: ('nginx', 10, 200), 15: ('nginx', 10, 201)}
            self.assertEqual(verify.changed_keys(base, self.identity(directory, reloaded)), ['children'])
            # Restart with the same pid number: another start time and timestamp.
            restarted = {**master, 10: ('nginx', 1, 300)}
            self.assertEqual(verify.changed_keys(base, self.identity(
                directory, restarted, show='MainPID=10\nExecMainStartTimestampMonotonic=9\nNRestarts=0\n')),
                ['master_start', 'service'])
            # The pid file rewritten with the same content (another inode/mtime).
            os.replace(Path(directory) / 'nginx.pid', Path(directory) / 'old')
            (Path(directory) / 'nginx.pid').write_text('10\n')
            self.assertEqual(verify.changed_keys(base, self.identity(directory, master)), ['pid_file'])
            for kwargs, message in (({'rc': 1}, 'systemctl show nginx.service failed'),
                                    ({'show': 'MainPID=10\n'}, 'systemctl show nginx.service failed'),
                                    ({'show': 'MainPID=0\nExecMainStartTimestampMonotonic=0\nNRestarts=0\n'},
                                     'no main process'),
                                    ({'pid_text': None}, 'pid file is absent'),
                                    ({'pid_text': '11\n'}, 'does not name the main process')):
                with self.subTest(kwargs=kwargs):
                    with self.assertRaisesRegex(verify.VerifyError, message):
                        self.identity(directory, master, **kwargs)
            with self.assertRaisesRegex(verify.VerifyError, 'main process is gone'):
                self.identity(directory, {11: master[11]})

    def test_settled_identity_waits_for_two_equal_reads_with_every_port_listening(self):
        reads = iter([{'children': [1]}, {'children': [2]}, {'children': [2]}, {'children': [2]}])
        ports = iter([[8101], list(verify.NGINX_FIXTURE_PORTS)])
        with mock.patch.object(verify, 'nginx_process_identity', side_effect=lambda: next(reads)), \
             mock.patch.object(verify, 'fixture_ports_listening', side_effect=lambda: next(ports)), \
             mock.patch.object(verify.time, 'sleep') as slept:
            self.assertEqual(verify.settled_nginx_identity(), {'children': [2]})
        self.assertEqual(slept.call_count, 3)
        with mock.patch.object(verify, 'nginx_process_identity', side_effect=lambda: {'children': [object()]}), \
             mock.patch.object(verify, 'fixture_ports_listening', return_value=list(verify.NGINX_FIXTURE_PORTS)), \
             mock.patch.object(verify.time, 'sleep'):
            self.assertRaisesRegex(verify.VerifyError, 'did not settle', verify.settled_nginx_identity, attempts=3)

    def test_phase_snapshot_is_the_unrelaxed_host_snapshot_plus_the_fixture(self):
        calls = []
        with mock.patch.object(verify, 'host_snapshot', side_effect=lambda *args, **kwargs: calls.append(
                (args, kwargs)) or {'/etc/nginx': 'n'}), \
             mock.patch.object(verify, 'tree_digest', side_effect=lambda path, **kwargs: 'tree:' + str(path)):
            self.assertEqual(verify.phase_snapshot(), {'/etc/nginx': 'n', '/etc/common-sv': 'tree:/etc/common-sv'})
        self.assertEqual(calls, [((), {})])
        with mock.patch.object(verify, 'phase_snapshot', side_effect=[{'a': 1}, {'a': 2}]):
            verify.require_phase_unchanged({'a': 1}, 'x')
            self.assertRaisesRegex(verify.VerifyError, '^y changed host state: a$', verify.require_phase_unchanged,
                                   {'a': 1}, 'y')

    def test_phase_snapshot_detects_bundle_private_config_and_lock_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ufw, bundle, config, state = root / 'ufw', root / 'bundle', root / 'config', root / 'state'
            for path in (ufw, bundle, config, state, root / 'run'):
                path.mkdir()
            for name in ('user.rules', 'user6.rules'):
                (ufw / name).write_text(name)
            (bundle / 'cloudfront-sync.py').write_text('code'); (config / 'config.json').write_text('{}')
            lock = root / 'lock'; lock.write_text(''); lock.chmod(0o600)
            with (mock.patch.object(verify, 'UFW_DIR', ufw), mock.patch.object(verify, 'POLICY_TREES', ()),
                  mock.patch.object(verify, 'LOCK', lock), mock.patch.object(verify, 'run_snapshot', return_value='run'),
                  mock.patch.object(verify, 'NGINX_FIXTURE_TOP', root / 'common-sv'),
                  mock.patch.object(verify, 'install_targets', return_value=(bundle, config, state)),
                  mock.patch.object(verify, 'firewall_rules', return_value={'nft': 'n'})):
                for change in (lambda: (bundle / 'cloudfront-sync.py').write_text('evil'),
                               lambda: (state / 'private').mkdir(),
                               lambda: (config / 'config.json').write_text('{"x":1}'),
                               lambda: lock.chmod(0o644),
                               lambda: (root / 'common-sv').mkdir()):
                    before = verify.phase_snapshot()
                    verify.require_phase_unchanged(before, 'nothing')
                    change()
                    self.assertRaises(verify.VerifyError, verify.require_phase_unchanged, before, 'change')

    def test_files_holding_secret_searches_contents_without_following_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'log' / 'nested').mkdir(parents=True)
            (root / 'log' / 'clean.log').write_bytes(b'nothing')
            (root / 'log' / 'nested' / 'leak.log').write_bytes(b'\x00prefix-SECRET-suffix')
            (root / 'fixture.conf').write_bytes(b'SECRET')
            (root / 'outside').mkdir(); (root / 'outside' / 'x').write_bytes(b'SECRET')
            (root / 'log' / 'link').symlink_to(root / 'outside')
            (root / 'single').write_bytes(b'OTHER')
            found = verify.files_holding_secret([root / 'log', root / 'single', root / 'absent'], ['SECRET', 'OTHER'])
            self.assertEqual(found, sorted([str(root / 'log' / 'nested' / 'leak.log'), str(root / 'single')]))
            self.assertEqual(verify.files_holding_secret([root], ['SECRET'], exclude=[root / 'fixture.conf']),
                             sorted([str(root / 'log' / 'nested' / 'leak.log'), str(root / 'outside' / 'x')]))
            self.assertEqual(verify.files_holding_secret([root / 'log'], ['NONE']), [])
            with mock.patch.object(verify, 'secret_search_roots', return_value=(root / 'log',)):
                with self.assertRaisesRegex(verify.VerifyError, '^a fixture secret is in a file: .*leak.log$'):
                    verify.require_no_secret_in_files(['SECRET'], [])
                verify.require_no_secret_in_files(['NONE'], [])

    def test_secret_search_roots_cover_state_logs_tmp_targets_lock_and_watched_run(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            for name in ('nginx.pid', 'ufw.lock', 'systemd', 'user'):
                (run / name).mkdir() if name in ('systemd', 'user') else (run / name).write_text('')
            roots = verify.secret_search_roots(run)
        for path in ('/var/lib/cloudfront-sync', '/var/log/nginx', '/tmp', '/var/tmp', str(verify.LOCK),
                     str(run / 'nginx.pid'), str(run / 'ufw.lock'), *map(str, verify.install_targets())):
            self.assertIn(Path(path), roots)
        self.assertNotIn(run / 'systemd', roots)
        self.assertEqual(len(roots), len(set(roots)))


class NginxRestoreTests(TestCase):
    def test_restore_restarts_only_after_a_service_change_and_reports_failure(self):
        calls = []
        def fake(args, name, timeout=60):
            calls.append(list(args))
            return True
        with mock.patch.object(verify, 'run_in_cleanup', side_effect=fake), \
             mock.patch.object(verify, 'output_in_cleanup', side_effect=AssertionError('units without a baseline')), \
             mock.patch.object(verify, 'checkpoint', side_effect=AssertionError('checkpoint in restore')):
            self.assertEqual(verify.NginxService().restore(), [])
            self.assertEqual(calls, [])
            for reloaded, stopped in ((True, False), (False, True), (True, True)):
                service = verify.NginxService()
                service.reloaded, service.stopped = reloaded, stopped
                calls.clear()
                self.assertEqual(service.restore(['/etc/cloudfront-sync']), [])
                self.assertEqual(calls, [[verify.SYSTEMCTL, 'restart', 'nginx.service'],
                                         [verify.SYSTEMCTL, 'is-active', '--quiet', 'nginx.service']])
                self.assertFalse(service.reloaded or service.stopped)
        for results in ((False,), (True, False)):
            with self.subTest(results=results):
                service = verify.NginxService(); service.stopped = True
                with mock.patch.object(verify, 'run_in_cleanup', side_effect=list(results)):
                    self.assertEqual(service.restore(), ['nginx.service (restart)'])
                self.assertTrue(service.stopped)

    def test_restore_never_restarts_onto_a_partly_removed_fixture(self):
        for remaining in ([str(verify.NGINX_INCLUDE)], [str(verify.NGINX_FIXTURE_TOP)],
                          [str(verify.nginx_bundle_paths('cf02')[0])], [str(verify.NGINX_SYMLINK_TARGET)]):
            with self.subTest(remaining=remaining):
                service = verify.NginxService(); service.reloaded = True
                with mock.patch.object(verify, 'run_in_cleanup', side_effect=AssertionError('restarted')):
                    self.assertEqual(service.restore(remaining),
                                     ['nginx.service (not restarted: the nginx fixture could not be removed)'])
                self.assertTrue(service.reloaded)
        for path in (verify.CONFIG_DIR, verify.STATE_DIR, verify.LOCK, verify.NGINX_DIR, verify.NGINX_CONF_D):
            self.assertFalse(verify.nginx_reads(path))

    def test_restore_reports_transient_units_left_since_the_phase_started(self):
        listing = 'run-pre.service loaded active running x\nrun-u5.service loaded failed failed y\n'
        for output, expected in ((listing, ['transient unit left: run-u5.service']),
                                 ('run-pre.service loaded active running x\n', []),
                                 (None, ['transient units (systemctl list-units failed)'])):
            with self.subTest(output=output):
                service = verify.NginxService(); service.units_before = ['run-pre.service']
                with mock.patch.object(verify, 'output_in_cleanup', return_value=output) as listed, \
                     mock.patch.object(verify, 'checkpoint', side_effect=AssertionError('checkpoint')):
                    self.assertEqual(service.restore(), expected)
                listed.assert_called_once_with(verify.TRANSIENT_UNITS_COMMAND)
        # Reported, never stopped: the only cleanup command is the listing.
        service = verify.NginxService(); service.units_before = []; service.stopped = True
        with mock.patch.object(verify, 'run_in_cleanup', return_value=True) as ran, \
             mock.patch.object(verify, 'output_in_cleanup', return_value=listing):
            self.assertEqual(service.restore(), ['transient unit left: run-pre.service',
                                                 'transient unit left: run-u5.service'])
        self.assertEqual([call.args[0][1] for call in ran.call_args_list], ['restart', 'is-active'])

    def test_output_in_cleanup_takes_no_checkpoint(self):
        with mock.patch.object(verify, 'checkpoint', side_effect=AssertionError('checkpoint')), \
             mock.patch.object(verify.signal, 'pthread_sigmask', side_effect=AssertionError('mask')):
            self.assertEqual(verify.output_in_cleanup([sys.executable, '-I', '-c', 'print("a")']), 'a\n')
            self.assertIsNone(verify.output_in_cleanup([sys.executable, '-I', '-c', 'raise SystemExit(3)']))
            self.assertIsNone(verify.output_in_cleanup(['/nonexistent/command']))
            self.assertIsNone(verify.output_in_cleanup([sys.executable, '-I', '-c', 'import time;time.sleep(5)'],
                                                       timeout=0.2))

    def test_run_in_cleanup_takes_no_checkpoint_and_keeps_the_mask(self):
        with mock.patch.object(verify, 'checkpoint', side_effect=AssertionError('checkpoint')), \
             mock.patch.object(verify.signal, 'pthread_sigmask', side_effect=AssertionError('mask')):
            self.assertTrue(verify.run_in_cleanup([sys.executable, '-I', '-c', 'pass'], 'ok'))
            self.assertFalse(verify.run_in_cleanup([sys.executable, '-I', '-c', 'raise SystemExit(3)'], 'rc'))
            self.assertFalse(verify.run_in_cleanup(['/nonexistent/command'], 'missing'))
            self.assertFalse(verify.run_in_cleanup([sys.executable, '-I', '-c', 'import time;time.sleep(5)'],
                                                   'slow', timeout=0.2))

    def test_with_cleanup_restores_after_staging_cleanup_and_reports_leftovers(self):
        order = []
        staging = mock.Mock(cleanup=mock.Mock(side_effect=lambda: order.append('files') or []))
        restore = mock.Mock(side_effect=lambda remaining: order.append(('service', remaining)) or [])
        self.assertEqual(verify.with_cleanup(staging, lambda: {'ok': 1}, restore), {'ok': 1})
        self.assertEqual(order, ['files', ('service', [])])
        # restore gets the paths cleanup could not remove.
        order.clear()
        with self.assertRaisesRegex(verify.VerifyError, '^fixture cleanup left: /etc/common-sv$'):
            verify.with_cleanup(mock.Mock(cleanup=mock.Mock(return_value=['/etc/common-sv'])), lambda: {}, restore)
        self.assertEqual(order, [('service', ['/etc/common-sv'])])
        restore = mock.Mock(return_value=['nginx.service (restart)'])
        with self.assertRaisesRegex(verify.VerifyError, r'^fixture cleanup left: nginx.service \(restart\)$'):
            verify.with_cleanup(mock.Mock(cleanup=mock.Mock(return_value=[])), lambda: {}, restore)
        verify.TERMINATION.__init__()
        with self.assertRaisesRegex(verify.VerifyError, r'^boom; fixture cleanup left: /etc/common-sv, '
                                    r'nginx.service \(restart\)$'):
            verify.with_cleanup(mock.Mock(cleanup=mock.Mock(return_value=['/etc/common-sv'])),
                                mock.Mock(side_effect=verify.VerifyError('boom')), restore)

    def test_main_requires_the_original_nginx_configuration_after_the_phase(self):
        for active, listening in ((True, [8101]), (False, [])):
            with self.subTest(active=active, listening=listening):
                host = FakeHost()
                with contextlib_stack(host.patches()), \
                     mock.patch.object(verify, 'check_environment'), mock.patch.object(verify, 'require_clean_start'), \
                     mock.patch.object(verify, 'Staging', side_effect=lambda: FakeStaging(host)), \
                     mock.patch.object(verify, 'install_termination'), \
                     mock.patch.object(verify.Path, 'read_text', lambda path: host.written[str(path)]), \
                     mock.patch.object(verify, 'nginx_active', return_value=active), \
                     mock.patch.object(verify, 'fixture_ports_listening', return_value=listening), \
                     contextlib.redirect_stdout(io.StringIO()) as output:
                    with self.assertRaisesRegex(verify.VerifyError, 'original configuration again'):
                        verify.main(['s0_refusal_verify.py', '/unused'])
                self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
